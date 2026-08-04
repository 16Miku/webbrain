#!/usr/bin/env python3
"""Cache one MoonViT feature tensor per image and lightweight per-turn examples."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

BOS = "<｜begin▁of▁sentence｜>"
USER = "<｜User｜>"
ASSISTANT = "<｜Assistant｜>"
EOS = "<｜end▁of▁sentence｜>"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    parser.add_argument("output_dir")
    parser.add_argument("--model-config", default="configs/model/moonvit.json")
    parser.add_argument("--max-sequence-length", type=int, default=2048)
    parser.add_argument("--max-image-tokens", type=int, default=512)
    parser.add_argument("--rank", type=int, default=0)
    parser.add_argument("--world-size", type=int, default=1)
    parser.add_argument("--device", default="cuda:0")
    return parser


def resolve_project_path(config_path: Path, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return config_path.resolve().parents[2] / path


def read_manifest(path: Path) -> list[dict[str, str]]:
    examples = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            example = json.loads(line)
            for key in ("id", "image", "question", "answer"):
                if not isinstance(example.get(key), str) or not example[key].strip():
                    raise ValueError(f"{path}:{line_number}: invalid {key}")
            examples.append(example)
    return examples


def token_id(tokenizer: Any, token: str) -> int:
    encoded = tokenizer.encode(token, add_special_tokens=False)
    if len(encoded) != 1:
        raise RuntimeError(f"expected one token for {token!r}, got {encoded}")
    return int(encoded[0])


def build_training_tensors(
    *,
    tokenizer: Any,
    question: str,
    answer: str,
    image_tokens: int,
    max_sequence_length: int,
):
    import torch

    bos_id = token_id(tokenizer, BOS)
    user_id = token_id(tokenizer, USER)
    assistant_id = token_id(tokenizer, ASSISTANT)
    eos_id = token_id(tokenizer, EOS)
    question_ids = tokenizer.encode(question.strip(), add_special_tokens=False)
    answer_ids = tokenizer.encode(answer.strip(), add_special_tokens=False)
    close_think_ids = tokenizer.encode("</think>", add_special_tokens=False)
    prefix = [bos_id, user_id]
    assistant_prefix = [assistant_id, *close_think_ids]
    fixed = len(prefix) + image_tokens + len(assistant_prefix) + len(answer_ids) + 1
    if fixed > max_sequence_length:
        answer_budget = max_sequence_length - len(prefix) - image_tokens - len(assistant_prefix) - 1
        if answer_budget < 1:
            raise ValueError("image tokens and protocol tokens leave no answer capacity")
        answer_ids = answer_ids[:answer_budget]
    question_budget = (
        max_sequence_length
        - len(prefix)
        - image_tokens
        - len(assistant_prefix)
        - len(answer_ids)
        - 1
    )
    question_ids = question_ids[: max(0, question_budget)]
    input_ids = [
        *prefix,
        *([0] * image_tokens),
        *question_ids,
        *assistant_prefix,
        *answer_ids,
        eos_id,
    ]
    image_start = len(prefix)
    supervised_start = len(prefix) + image_tokens + len(question_ids) + len(assistant_prefix)
    labels = [-100] * supervised_start + answer_ids + [eos_id]
    image_mask = [False] * len(input_ids)
    image_mask[image_start : image_start + image_tokens] = [True] * image_tokens
    return {
        "input_ids": torch.tensor(input_ids, dtype=torch.long),
        "image_mask": torch.tensor(image_mask, dtype=torch.bool),
        "attention_mask": torch.ones(len(input_ids), dtype=torch.long),
        "labels": torch.tensor(labels, dtype=torch.long),
    }


def atomic_torch_save(payload: Any, path: Path) -> None:
    import torch

    if path.exists():
        return
    temporary = path.with_name(f".{path.name}.{os.getpid()}.partial")
    torch.save(payload, temporary)
    temporary.replace(path)


def fit_image_to_token_budget(image_processor: Any, image: Any, max_image_tokens: int) -> int:
    """Choose a raw-patch limit whose padded MoonViT output fits the token budget."""
    merge_size = int(image_processor.media_proc_cfg["merge_kernel_size"])
    media = {"type": "image", "image": image}
    lower = 1
    upper = max_image_tokens * merge_size**2
    best: tuple[int, int] | None = None
    while lower <= upper:
        patch_limit = (lower + upper) // 2
        image_processor.media_proc_cfg["in_patch_limit"] = patch_limit
        output_tokens = int(image_processor.get_resize_config(media)["num_tokens"])
        if output_tokens <= max_image_tokens:
            best = (patch_limit, output_tokens)
            lower = patch_limit + 1
        else:
            upper = patch_limit - 1
    if best is None:
        raise RuntimeError(f"could not fit image into {max_image_tokens} MoonViT tokens")
    image_processor.media_proc_cfg["in_patch_limit"] = best[0]
    return best[1]


def main() -> int:
    args = build_parser().parse_args()
    if not 0 <= args.rank < args.world_size:
        raise ValueError("rank must be in [0, world_size)")

    import torch
    from PIL import Image
    from transformers import AutoProcessor, AutoTokenizer

    from deepseek_vision.config import load_project_config
    from deepseek_vision.towers import load_moonvit

    config_path = Path(args.model_config)
    config = load_project_config(config_path)
    if config.tower.kind != "moonvit":
        raise ValueError("this cache worker only supports MoonViT")
    manifest_path = Path(args.manifest).resolve()
    output = Path(args.output_dir).resolve()
    feature_dir = output / "features"
    example_dir = output / "examples"
    feature_dir.mkdir(parents=True, exist_ok=True)
    example_dir.mkdir(parents=True, exist_ok=True)
    examples = read_manifest(manifest_path)
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for example in examples:
        grouped[example["image"]].append(example)
    selected = [
        item
        for index, item in enumerate(sorted(grouped.items()))
        if index % args.world_size == args.rank
    ]

    processor = AutoProcessor.from_pretrained(
        config.tower.model_id,
        revision=config.tower.revision,
        trust_remote_code=True,
    )
    tokenizer = AutoTokenizer.from_pretrained(
        resolve_project_path(config_path, config.text.model_id), trust_remote_code=True
    )
    tower = load_moonvit(
        config.tower.model_id,
        config.tower.revision,
        resolve_project_path(config_path, config.tower.component_path),
    ).to(device=args.device, dtype=torch.bfloat16)

    started = time.monotonic()
    images_completed = 0
    examples_completed = 0
    with torch.inference_mode():
        for image_name, image_examples in selected:
            image_path = Path(image_name)
            if not image_path.is_absolute():
                image_path = manifest_path.parent / image_path
            feature_key = hashlib.sha256(
                f"{image_path.resolve()}:{config.tower.revision}:{args.max_image_tokens}".encode()
            ).hexdigest()
            feature_path = feature_dir / f"{feature_key}.pt"
            if feature_path.exists():
                feature_payload = torch.load(feature_path, map_location="cpu", weights_only=True)
                features = feature_payload["vision_features"]
            else:
                with Image.open(image_path) as source_image:
                    image = source_image.convert("RGB")
                expected_image_tokens = fit_image_to_token_budget(
                    processor.image_processor, image, args.max_image_tokens
                )
                batch = processor.image_processor(
                    [{"type": "image", "image": image}], return_tensors="pt"
                )
                inputs = {
                    key: value.to(args.device, dtype=torch.bfloat16)
                    if value.is_floating_point()
                    else value.to(args.device)
                    for key, value in batch.items()
                }
                result = tower(**inputs)
                if not isinstance(result, list) or len(result) != 1:
                    raise RuntimeError("MoonViT did not return one feature group")
                features = result[0].detach().to(device="cpu", dtype=torch.bfloat16)
                if features.ndim != 3 or features.shape[1:] != (4, config.tower.hidden_size):
                    raise RuntimeError(f"unexpected MoonViT feature shape {tuple(features.shape)}")
                if features.shape[0] != expected_image_tokens:
                    raise RuntimeError(
                        f"{image_path}: expected {expected_image_tokens} MoonViT tokens, "
                        f"got feature shape {tuple(features.shape)}"
                    )
                if not torch.isfinite(features).all():
                    raise RuntimeError(f"{image_path}: MoonViT produced non-finite features")
                atomic_torch_save({"vision_features": features}, feature_path)
            relative_feature = os.path.relpath(feature_path, example_dir)
            for example in image_examples:
                tensors = build_training_tensors(
                    tokenizer=tokenizer,
                    question=example["question"],
                    answer=example["answer"],
                    image_tokens=features.shape[0],
                    max_sequence_length=args.max_sequence_length,
                )
                tensors["vision_feature_path"] = relative_feature
                tensors["example_id"] = example["id"]
                example_name = hashlib.sha256(example["id"].encode()).hexdigest()
                atomic_torch_save(tensors, example_dir / f"{example_name}.pt")
                examples_completed += 1
            images_completed += 1
            if images_completed % 25 == 0:
                elapsed = time.monotonic() - started
                print(
                    json.dumps(
                        {
                            "rank": args.rank,
                            "images": images_completed,
                            "examples": examples_completed,
                            "images_per_hour": images_completed / elapsed * 3600,
                        }
                    ),
                    flush=True,
                )
    elapsed = time.monotonic() - started
    summary = {
        "rank": args.rank,
        "world_size": args.world_size,
        "images": images_completed,
        "examples": examples_completed,
        "elapsed_seconds": elapsed,
    }
    summary_path = output / f"cache-summary-rank-{args.rank:02d}.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
