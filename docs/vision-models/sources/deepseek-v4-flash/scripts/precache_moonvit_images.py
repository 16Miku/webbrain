#!/usr/bin/env python3
"""Precompute MoonViT features for an image-directory snapshot before a manifest is ready."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

from cache_moonvit_features import (
    atomic_torch_save,
    fit_image_to_token_budget,
    resolve_project_path,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("images_dir")
    parser.add_argument("output_dir")
    parser.add_argument("--model-config", default="configs/model/moonvit.json")
    parser.add_argument("--max-image-tokens", type=int, default=512)
    parser.add_argument("--rank", type=int, default=0)
    parser.add_argument("--world-size", type=int, default=1)
    parser.add_argument("--device", default="cuda:0")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not 0 <= args.rank < args.world_size:
        raise ValueError("rank must be in [0, world_size)")

    import torch
    from PIL import Image
    from transformers import AutoProcessor

    from deepseek_vision.config import load_project_config
    from deepseek_vision.towers import load_moonvit

    config_path = Path(args.model_config)
    config = load_project_config(config_path)
    if config.tower.kind != "moonvit":
        raise ValueError("this precache worker only supports MoonViT")

    images_dir = Path(args.images_dir).resolve()
    output = Path(args.output_dir).resolve()
    feature_dir = output / "features"
    feature_dir.mkdir(parents=True, exist_ok=True)
    supported = {".jpg", ".jpeg", ".png", ".webp"}
    images = sorted(path for path in images_dir.iterdir() if path.suffix.lower() in supported)
    selected = [path for index, path in enumerate(images) if index % args.world_size == args.rank]

    processor = AutoProcessor.from_pretrained(
        config.tower.model_id,
        revision=config.tower.revision,
        trust_remote_code=True,
    )
    tower = load_moonvit(
        config.tower.model_id,
        config.tower.revision,
        resolve_project_path(config_path, config.tower.component_path),
    ).to(device=args.device, dtype=torch.bfloat16)

    started = time.monotonic()
    computed = 0
    reused = 0
    with torch.inference_mode():
        for image_path in selected:
            feature_key = hashlib.sha256(
                f"{image_path.resolve()}:{config.tower.revision}:{args.max_image_tokens}".encode()
            ).hexdigest()
            feature_path = feature_dir / f"{feature_key}.pt"
            if feature_path.exists():
                reused += 1
                continue
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
            computed += 1
            if computed % 100 == 0:
                elapsed = time.monotonic() - started
                print(
                    json.dumps(
                        {
                            "rank": args.rank,
                            "computed": computed,
                            "reused": reused,
                            "images_per_hour": computed / elapsed * 3600,
                        }
                    ),
                    flush=True,
                )

    summary = {
        "rank": args.rank,
        "world_size": args.world_size,
        "snapshot_images": len(images),
        "selected_images": len(selected),
        "computed": computed,
        "reused": reused,
        "elapsed_seconds": time.monotonic() - started,
    }
    summary_path = output / f"precache-summary-rank-{args.rank:02d}.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
