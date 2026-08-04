#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import struct
import tempfile
from pathlib import Path
from typing import Iterable


SGLANG_SOURCE_COMMIT = "fdebc938f7f4d16fe6b9f55dcd9a767cf0899ea1"
TOWER_MODEL_ID = "moonshotai/Kimi-K2.6"
TOWER_REVISION = "7eb5002f6aadc958aed6a9177b7ed26bb94011bb"


def deepseek_vision_config(*, routing_palette: Iterable[int], vocab_size: int) -> dict:
    palette = [int(value) for value in routing_palette]
    if not palette:
        raise ValueError("routing palette cannot be empty")
    if min(palette) < 0 or max(palette) >= vocab_size:
        raise ValueError("routing palette contains an ID outside the model vocabulary")
    return {
        "schema_version": 1,
        "tower_model_id": TOWER_MODEL_ID,
        "tower_revision": TOWER_REVISION,
        "image_placeholder": "<image>",
        "image_placeholder_token_id": vocab_size,
        "max_image_tokens": 512,
        "routing_policy": "palette_cycle",
        "routing_palette": palette,
        "sglang_source_commit": SGLANG_SOURCE_COMMIT,
        "requires_sglang_source_patch": True,
    }


def vision_config(*, text_hidden_size: int) -> dict:
    return {
        "model_type": "kimi_k25",
        "patch_size": 14,
        "init_pos_emb_height": 64,
        "init_pos_emb_width": 64,
        "init_pos_emb_time": 4,
        "pos_emb_type": "divided_fixed",
        "num_attention_heads": 16,
        "num_hidden_layers": 27,
        "hidden_size": 1152,
        "intermediate_size": 4304,
        # Current SGLang's K2 projector reads the legacy vt_* aliases while
        # MoonViT itself reads the canonical names above.  Keep both explicit.
        "vt_num_attention_heads": 16,
        "vt_num_hidden_layers": 27,
        "vt_hidden_size": 1152,
        "vt_intermediate_size": 4304,
        "merge_kernel_size": [2, 2],
        "video_attn_type": "spatial_temporal",
        "merge_type": "sd2_tpool",
        "mm_projector_type": "patchmerger",
        "mm_hidden_size": 1152,
        "projector_hidden_act": "gelu",
        "projector_ln_eps": 1e-5,
        "text_hidden_size": int(text_hidden_size),
    }


def augment_config(config: dict, routing_palette: Iterable[int]) -> dict:
    architectures = config.get("architectures") or []
    if "DeepseekV4ForCausalLM" not in architectures:
        raise ValueError("model architecture must remain DeepseekV4ForCausalLM")
    vocab_size = int(config["vocab_size"])
    hidden_size = int(config["hidden_size"])
    updated = dict(config)
    updated["vision_config"] = vision_config(text_hidden_size=hidden_size)
    updated["image_token_id"] = vocab_size
    updated["media_placeholder_token_id"] = vocab_size
    updated["deepseek_vision"] = deepseek_vision_config(
        routing_palette=routing_palette,
        vocab_size=vocab_size,
    )
    return updated


def augment_weight_map(
    index: dict,
    *,
    tower_keys: Iterable[str],
    projector_keys: Iterable[str],
    tower_size: int = 0,
    projector_size: int = 0,
) -> dict:
    updated = json.loads(json.dumps(index))
    weight_map = updated.setdefault("weight_map", {})
    existing_files = set(weight_map.values())
    additions = {
        **{str(name): "vision_tower.safetensors" for name in tower_keys},
        **{str(name): "mm_projector.safetensors" for name in projector_keys},
    }
    collisions = sorted(
        name
        for name, filename in additions.items()
        if name in weight_map and weight_map[name] != filename
    )
    if collisions:
        raise ValueError(f"component tensor names collide with backbone keys: {collisions[:8]}")
    weight_map.update(additions)
    added_size = sum(
        size
        for filename, size in (
            ("vision_tower.safetensors", int(tower_size)),
            ("mm_projector.safetensors", int(projector_size)),
        )
        if filename not in existing_files
    )
    if added_size:
        metadata = updated.setdefault("metadata", {})
        metadata["total_size"] = int(metadata.get("total_size", 0)) + added_size
    return updated


def safetensor_keys(path: Path) -> list[str]:
    with path.open("rb") as handle:
        prefix = handle.read(8)
        if len(prefix) != 8:
            raise ValueError(f"invalid safetensors header prefix: {path}")
        header_size = struct.unpack("<Q", prefix)[0]
        if header_size <= 0 or header_size > 100 * 1024 * 1024:
            raise ValueError(f"invalid safetensors header size {header_size}: {path}")
        header = json.loads(handle.read(header_size))
    return [str(name) for name in header if name != "__metadata__"]


def write_json_atomic(path: Path, payload: dict) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def stage_extension(model_dir: Path, source_root: Path) -> None:
    source = source_root / "sglang_ext" / "deepseek_vision_sglang"
    if not source.is_dir():
        raise ValueError(f"SGLang extension source is missing: {source}")
    target_root = model_dir / "sglang_ext"
    target_root.mkdir(exist_ok=True)
    target = target_root / source.name
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))


def prepare(model_dir: Path, palette_path: Path, source_root: Path) -> None:
    required = [
        model_dir / "config.json",
        model_dir / "model.safetensors.index.json",
        model_dir / "vision_tower.safetensors",
        model_dir / "mm_projector.safetensors",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise ValueError(f"model directory is incomplete: {missing}")
    palette = json.loads(palette_path.read_text(encoding="utf-8"))
    config = json.loads(required[0].read_text(encoding="utf-8"))
    index = json.loads(required[1].read_text(encoding="utf-8"))
    write_json_atomic(required[0], augment_config(config, palette))
    write_json_atomic(
        required[1],
        augment_weight_map(
            index,
            tower_keys=safetensor_keys(required[2]),
            projector_keys=safetensor_keys(required[3]),
            tower_size=required[2].stat().st_size,
            projector_size=required[3].stat().st_size,
        ),
    )
    stage_extension(model_dir, source_root)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Stage a DeepSeek V4 + MoonViT model directory for the pinned SGLang fork"
    )
    parser.add_argument("model_dir", type=Path)
    parser.add_argument(
        "--palette",
        type=Path,
        default=Path("configs/routing/deepseek-v4-flash-60d8d707-palette64.json"),
    )
    parser.add_argument(
        "--source-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    prepare(args.model_dir.resolve(), args.palette.resolve(), args.source_root.resolve())
    print(f"prepared {args.model_dir.resolve()} for pinned SGLang {SGLANG_SOURCE_COMMIT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
