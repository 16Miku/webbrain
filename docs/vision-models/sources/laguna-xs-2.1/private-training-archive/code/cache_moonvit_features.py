#!/usr/bin/env python3
"""Cache Kimi K2.6 MoonViT features and Laguna-formatted training examples."""

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import time
from typing import Any


MOONVIT_ID = "moonshotai/Kimi-K2.6"
MOONVIT_REVISION = "7eb5002f6aadc958aed6a9177b7ed26bb94011bb"
LAGUNA_ID = "poolside/Laguna-XS-2.1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    parser.add_argument("output_dir")
    parser.add_argument("component")
    parser.add_argument("--max-sequence-length", type=int, default=2048)
    parser.add_argument("--max-image-tokens", type=int, default=512)
    parser.add_argument("--rank", type=int, default=0)
    parser.add_argument("--world-size", type=int, default=1)
    parser.add_argument("--device", default="cuda:0")
    return parser.parse_args()


def read_manifest(path: Path) -> list[dict[str, str]]:
    examples = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        example = json.loads(line)
        for key in ("id", "image", "question", "answer"):
            if not isinstance(example.get(key), str) or not example[key].strip():
                raise ValueError(f"{path}:{line_number}: invalid {key}")
        examples.append(example)
    return examples


def atomic_torch_save(torch: Any, payload: Any, path: Path) -> None:
    if path.exists():
        return
    temporary = path.with_name(f".{path.name}.{os.getpid()}.partial")
    torch.save(payload, temporary)
    temporary.replace(path)


def fit_image_to_token_budget(image_processor: Any, image: Any, maximum: int) -> int:
    merge_size = int(image_processor.media_proc_cfg["merge_kernel_size"])
    media = {"type": "image", "image": image}
    lower = 1
    upper = maximum * merge_size**2
    best: tuple[int, int] | None = None
    while lower <= upper:
        patch_limit = (lower + upper) // 2
        image_processor.media_proc_cfg["in_patch_limit"] = patch_limit
        output_tokens = int(image_processor.get_resize_config(media)["num_tokens"])
        if output_tokens <= maximum:
            best = (patch_limit, output_tokens)
            lower = patch_limit + 1
        else:
            upper = patch_limit - 1
    if best is None:
        raise RuntimeError(f"could not fit image into {maximum} MoonViT tokens")
    image_processor.media_proc_cfg["in_patch_limit"] = best[0]
    return best[1]


def build_training_tensors(
    torch: Any,
    tokenizer: Any,
    *,
    question: str,
    answer: str,
    image_tokens: int,
    max_sequence_length: int,
) -> dict[str, Any]:
    prefix = tokenizer.encode("〈|EOS|〉<user>", add_special_tokens=False)
    question_ids = tokenizer.encode(question.strip(), add_special_tokens=False)
    assistant_prefix = tokenizer.encode(
        "</user>\n<assistant></think>", add_special_tokens=False
    )
    answer_ids = tokenizer.encode(answer.strip(), add_special_tokens=False)
    suffix = tokenizer.encode("</assistant>\n", add_special_tokens=False)
    fixed_without_question = (
        len(prefix) + image_tokens + len(assistant_prefix) + len(answer_ids) + len(suffix)
    )
    if fixed_without_question > max_sequence_length:
        answer_budget = (
            max_sequence_length
            - len(prefix)
            - image_tokens
            - len(assistant_prefix)
            - len(suffix)
        )
        if answer_budget < 1:
            raise ValueError("image and protocol tokens leave no answer capacity")
        answer_ids = answer_ids[:answer_budget]
    question_budget = (
        max_sequence_length
        - len(prefix)
        - image_tokens
        - len(assistant_prefix)
        - len(answer_ids)
        - len(suffix)
    )
    question_ids = question_ids[: max(0, question_budget)]
    input_ids = [
        *prefix,
        *([0] * image_tokens),
        *question_ids,
        *assistant_prefix,
        *answer_ids,
        *suffix,
    ]
    supervised_start = (
        len(prefix) + image_tokens + len(question_ids) + len(assistant_prefix)
    )
    labels = [-100] * supervised_start + answer_ids + suffix
    image_mask = [False] * len(input_ids)
    image_mask[len(prefix) : len(prefix) + image_tokens] = [True] * image_tokens
    return {
        "input_ids": torch.tensor(input_ids, dtype=torch.long),
        "image_mask": torch.tensor(image_mask, dtype=torch.bool),
        "attention_mask": torch.ones(len(input_ids), dtype=torch.long),
        "labels": torch.tensor(labels, dtype=torch.long),
    }


def load_tower(torch: Any, component: Path, device: str):
    from safetensors.torch import load_file
    from transformers import AutoConfig
    from transformers.dynamic_module_utils import get_class_from_dynamic_module

    config = AutoConfig.from_pretrained(
        MOONVIT_ID, revision=MOONVIT_REVISION, trust_remote_code=True
    )
    config.vision_config._attn_implementation = "eager"
    tower_config_class = get_class_from_dynamic_module(
        "modeling_kimi_k25.VisionTowerConfig", MOONVIT_ID, revision=MOONVIT_REVISION
    )
    tower_class = get_class_from_dynamic_module(
        "modeling_kimi_k25.MoonViT3dPretrainedModel",
        MOONVIT_ID,
        revision=MOONVIT_REVISION,
    )
    tower = tower_class(tower_config_class(config.vision_config))
    missing, unexpected = tower.load_state_dict(load_file(str(component), device="cpu"), strict=False)
    if missing or unexpected:
        raise RuntimeError(f"MoonViT state mismatch: missing={missing}, unexpected={unexpected}")
    tower.requires_grad_(False).eval()
    return tower.to(device=device, dtype=torch.bfloat16)


def main() -> int:
    args = parse_args()
    if not 0 <= args.rank < args.world_size:
        raise ValueError("rank must be in [0, world_size)")
    import torch
    from PIL import Image
    from transformers import AutoProcessor, AutoTokenizer

    manifest = Path(args.manifest).resolve()
    output = Path(args.output_dir).resolve()
    component = Path(args.component).resolve()
    if not component.is_file():
        raise FileNotFoundError(component)
    feature_dir = output / "features"
    example_dir = output / "examples"
    feature_dir.mkdir(parents=True, exist_ok=True)
    example_dir.mkdir(parents=True, exist_ok=True)
    examples = read_manifest(manifest)
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for example in examples:
        grouped[example["image"]].append(example)

    processor = AutoProcessor.from_pretrained(
        MOONVIT_ID, revision=MOONVIT_REVISION, trust_remote_code=True
    )
    tokenizer = AutoTokenizer.from_pretrained(LAGUNA_ID, trust_remote_code=True)
    tower = load_tower(torch, component, args.device)
    started = time.monotonic()
    computed = 0
    reused = 0
    examples_completed = 0
    all_image_items = sorted(grouped.items())
    image_items = [
        item
        for index, item in enumerate(all_image_items)
        if index % args.world_size == args.rank
    ]
    with torch.inference_mode():
        for image_index, (image_name, image_examples) in enumerate(image_items, 1):
            image_path = Path(image_name)
            if not image_path.is_absolute():
                image_path = manifest.parent / image_path
            feature_key = hashlib.sha256(
                f"{image_path.resolve()}:{MOONVIT_REVISION}:{args.max_image_tokens}".encode()
            ).hexdigest()
            feature_path = feature_dir / f"{feature_key}.pt"
            if feature_path.exists():
                payload = torch.load(feature_path, map_location="cpu", weights_only=True)
                features = payload["vision_features"]
                reused += 1
            else:
                with Image.open(image_path) as source:
                    image = source.convert("RGB")
                expected_tokens = fit_image_to_token_budget(
                    processor.image_processor, image, args.max_image_tokens
                )
                batch = processor.image_processor(
                    [{"type": "image", "image": image}], return_tensors="pt"
                )
                inputs = {
                    name: tensor.to(args.device, dtype=torch.bfloat16)
                    if tensor.is_floating_point()
                    else tensor.to(args.device)
                    for name, tensor in batch.items()
                }
                result = tower(**inputs)
                if not isinstance(result, list) or len(result) != 1:
                    raise RuntimeError("MoonViT did not return one feature group")
                features = result[0].detach().to(device="cpu", dtype=torch.bfloat16)
                if features.ndim != 3 or features.shape[1:] != (4, 1152):
                    raise RuntimeError(f"unexpected MoonViT feature shape {tuple(features.shape)}")
                if features.shape[0] != expected_tokens:
                    raise RuntimeError(
                        f"expected {expected_tokens} MoonViT tokens, got {features.shape[0]}"
                    )
                if not torch.isfinite(features).all():
                    raise RuntimeError(f"{image_path}: non-finite MoonViT features")
                atomic_torch_save(torch, {"vision_features": features}, feature_path)
                computed += 1
            relative_feature = os.path.relpath(feature_path, example_dir)
            for example in image_examples:
                tensors = build_training_tensors(
                    torch,
                    tokenizer,
                    question=example["question"],
                    answer=example["answer"],
                    image_tokens=int(features.shape[0]),
                    max_sequence_length=args.max_sequence_length,
                )
                tensors["vision_feature_path"] = relative_feature
                tensors["example_id"] = example["id"]
                name = hashlib.sha256(example["id"].encode()).hexdigest()
                atomic_torch_save(torch, tensors, example_dir / f"{name}.pt")
                examples_completed += 1
            if image_index % 25 == 0 or image_index == len(image_items):
                elapsed = time.monotonic() - started
                print(
                    json.dumps(
                        {
                            "rank": args.rank,
                            "world_size": args.world_size,
                            "images": image_index,
                            "computed": computed,
                            "reused": reused,
                            "examples": examples_completed,
                            "images_per_hour": image_index / elapsed * 3600,
                        }
                    ),
                    flush=True,
                )
    summary = {
        "rank": args.rank,
        "world_size": args.world_size,
        "manifest_images": len(all_image_items),
        "images": len(image_items),
        "computed": computed,
        "reused": reused,
        "examples": examples_completed,
        "elapsed_seconds": time.monotonic() - started,
    }
    summary_name = (
        "cache-summary.json"
        if args.world_size == 1
        else f"cache-summary-rank-{args.rank:02d}.json"
    )
    (output / summary_name).write_text(json.dumps(summary, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
