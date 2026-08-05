#!/usr/bin/env python3
"""Fetch deterministic train-only Cauldron slices into a portable normalized manifest."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import random
import sys
import traceback
from pathlib import Path
from typing import Any

CALIBRATION_1K = {
    "vqav2": 170,
    "textcaps": 80,
    "docvqa": 90,
    "textvqa": 80,
    "chartqa": 100,
    "plotqa": 50,
    "ai2d": 80,
    "scienceqa": 80,
    "clevr": 90,
    "screen2words": 90,
    "websight": 90,
}

PILOT_100K = {
    # These sources all passed the pinned-revision calibration fetch. Some other
    # Cauldron configs contain absolute paths into the publisher's internal FSX
    # mount rather than portable image bytes, so they are intentionally excluded.
    "vqav2": 25_000,
    "textcaps": 7_500,
    "docvqa": 10_000,
    "textvqa": 7_500,
    "chartqa": 10_000,
    "plotqa": 10_000,
    "ai2d": 5_000,
    "scienceqa": 5_000,
    "clevr": 10_000,
    "screen2words": 5_000,
    "websight": 5_000,
}

PRESETS = {"calibration1k": CALIBRATION_1K, "pilot100k": PILOT_100K}
LOSSLESS_CONFIGS = {
    "ai2d",
    "chartqa",
    "diagram_image_to_text",
    "docvqa",
    "dvqa",
    "figureqa",
    "infographic_vqa",
    "ocrvqa",
    "plotqa",
    "screen2words",
    "textvqa",
    "websight",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir")
    parser.add_argument("--preset", choices=sorted(PRESETS), default="calibration1k")
    parser.add_argument("--dataset-id", default="HuggingFaceM4/the_cauldron")
    parser.add_argument("--revision")
    parser.add_argument("--seed", type=int, default=20260802)
    parser.add_argument("--shuffle-buffer", type=int, default=512)
    return parser


def example_fingerprint(image_digest: str, question: str, answer: str) -> str:
    """Return a stable key for exact semantic duplicates after whitespace cleanup."""
    normalized_question = " ".join(question.split())
    normalized_answer = " ".join(answer.split())
    payload = f"{image_digest}\0{normalized_question}\0{normalized_answer}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def raw_image_bytes(image: Any) -> tuple[bytes, str] | None:
    stream = getattr(image, "fp", None)
    getvalue = getattr(stream, "getvalue", None)
    image_format = str(getattr(image, "format", "")).lower()
    if getvalue is None or image_format not in {"jpeg", "jpg", "png", "webp"}:
        return None
    data = getvalue()
    if not data:
        return None
    extension = "jpg" if image_format in {"jpeg", "jpg"} else image_format
    return data, extension


def encode_image(image: Any, *, lossless: bool) -> tuple[bytes, str]:
    original = raw_image_bytes(image)
    if original is not None:
        return original
    buffer = io.BytesIO()
    image = image.convert("RGB")
    if lossless:
        image.save(buffer, format="PNG", optimize=True)
        return buffer.getvalue(), "png"
    image.save(buffer, format="JPEG", quality=95, subsampling=0, optimize=True)
    return buffer.getvalue(), "jpg"


def atomic_write(path: Path, data: bytes) -> None:
    if path.exists():
        return
    temporary = path.with_name(f".{path.name}.{os.getpid()}.partial")
    temporary.write_bytes(data)
    temporary.replace(path)


def atomic_replace_text(path: Path, text: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.partial")
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def checkpoint_paths(checkpoint_dir: Path, config_index: int, config_name: str) -> tuple[Path, Path]:
    stem = f"{config_index:02d}-{config_name}"
    return checkpoint_dir / f"{stem}.jsonl", checkpoint_dir / f"{stem}.json"


def load_config_checkpoint(
    *,
    checkpoint_dir: Path,
    config_index: int,
    config_name: str,
    quota: int,
    dataset_id: str,
    dataset_revision: str,
    seed: int,
    shuffle_buffer: int,
    output_dir: Path,
    seen_example_keys: set[str],
) -> tuple[list[dict[str, str]], dict[str, int]] | None:
    examples_path, metadata_path = checkpoint_paths(checkpoint_dir, config_index, config_name)
    if not metadata_path.exists():
        return None
    if not examples_path.exists():
        raise RuntimeError(f"checkpoint metadata exists without examples: {metadata_path}")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    expected = {
        "dataset_id": dataset_id,
        "dataset_revision": dataset_revision,
        "config_name": config_name,
        "quota": quota,
        "seed": seed,
        "shuffle_buffer": shuffle_buffer,
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise RuntimeError(
                f"checkpoint {metadata_path} has {key}={metadata.get(key)!r}, expected {value!r}"
            )
    examples = [json.loads(line) for line in examples_path.read_text(encoding="utf-8").splitlines()]
    if len(examples) != quota or metadata.get("examples") != quota:
        raise RuntimeError(f"checkpoint {examples_path} has {len(examples)}/{quota} examples")
    checkpoint_keys: set[str] = set()
    for example in examples:
        if example.get("cauldron_config") != config_name or example.get("split") != "train":
            raise RuntimeError(f"invalid example provenance in {examples_path}")
        image_path = output_dir / str(example.get("image", ""))
        if not image_path.is_file():
            raise RuntimeError(f"checkpoint image is missing: {image_path}")
        fingerprint = str(example.get("fingerprint", ""))
        if not fingerprint or fingerprint in checkpoint_keys or fingerprint in seen_example_keys:
            raise RuntimeError(f"duplicate or missing fingerprint in {examples_path}: {fingerprint}")
        checkpoint_keys.add(fingerprint)
    seen_example_keys.update(checkpoint_keys)
    stats = metadata.get("stats")
    if not isinstance(stats, dict):
        raise RuntimeError(f"checkpoint stats are missing: {metadata_path}")
    return examples, {str(key): int(value) for key, value in stats.items()}


def save_config_checkpoint(
    *,
    checkpoint_dir: Path,
    config_index: int,
    config_name: str,
    quota: int,
    dataset_id: str,
    dataset_revision: str,
    seed: int,
    shuffle_buffer: int,
    examples: list[dict[str, str]],
    stats: dict[str, int],
) -> None:
    examples_path, metadata_path = checkpoint_paths(checkpoint_dir, config_index, config_name)
    examples_text = "".join(json.dumps(example, ensure_ascii=False) + "\n" for example in examples)
    atomic_replace_text(examples_path, examples_text)
    metadata = {
        "dataset_id": dataset_id,
        "dataset_revision": dataset_revision,
        "config_name": config_name,
        "quota": quota,
        "seed": seed,
        "shuffle_buffer": shuffle_buffer,
        "examples": len(examples),
        "stats": stats,
    }
    atomic_replace_text(metadata_path, json.dumps(metadata, indent=2) + "\n")


def fetch_config(
    *,
    dataset_id: str,
    dataset_revision: str,
    config_name: str,
    quota: int,
    seed: int,
    shuffle_buffer: int,
    image_dir: Path,
    seen_example_keys: set[str],
) -> tuple[list[dict[str, str]], dict[str, int]]:
    from datasets import load_dataset

    dataset = load_dataset(
        dataset_id,
        config_name,
        split="train",
        streaming=True,
        revision=dataset_revision,
    )
    if shuffle_buffer > 1:
        dataset = dataset.shuffle(seed=seed, buffer_size=shuffle_buffer)
    examples: list[dict[str, str]] = []
    rows_seen = 0
    skipped_rows = 0
    duplicate_examples = 0
    unique_images: set[str] = set()
    for row in dataset:
        rows_seen += 1
        images = row.get("images") or []
        turns = row.get("texts") or []
        if len(images) != 1 or not turns:
            skipped_rows += 1
            continue
        image_bytes, extension = encode_image(images[0], lossless=config_name in LOSSLESS_CONFIGS)
        digest = hashlib.sha256(image_bytes).hexdigest()
        image_path = image_dir / f"{digest}.{extension}"
        atomic_write(image_path, image_bytes)
        unique_images.add(digest)
        for turn_index, turn in enumerate(turns):
            question = str(turn.get("user", "")).strip()
            answer = str(turn.get("assistant", "")).strip()
            if not question or not answer:
                continue
            fingerprint = example_fingerprint(digest, question, answer)
            if fingerprint in seen_example_keys:
                duplicate_examples += 1
                continue
            seen_example_keys.add(fingerprint)
            examples.append(
                {
                    "id": f"{config_name}-{rows_seen - 1:08d}-{turn_index:03d}",
                    "image": f"images/{image_path.name}",
                    "question": question,
                    "answer": answer,
                    "source": str(turn.get("source") or config_name),
                    "cauldron_config": config_name,
                    "split": "train",
                    "fingerprint": fingerprint,
                }
            )
            if len(examples) >= quota:
                return examples, {
                    "rows_seen": rows_seen,
                    "skipped_rows": skipped_rows,
                    "duplicate_examples": duplicate_examples,
                    "examples": len(examples),
                    "unique_images": len(unique_images),
                }
    raise RuntimeError(f"{config_name}: exhausted stream at {len(examples)}/{quota} examples")


def main() -> int:
    args = build_parser().parse_args()
    from huggingface_hub import HfApi

    output = Path(args.output_dir).resolve()
    image_dir = output / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_dir = output / "config-checkpoints"
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    quotas = PRESETS[args.preset]
    dataset_revision = HfApi().dataset_info(args.dataset_id, revision=args.revision).sha
    all_examples: list[dict[str, str]] = []
    seen_example_keys: set[str] = set()
    stats: dict[str, dict[str, int]] = {}
    for config_index, (config_name, quota) in enumerate(quotas.items()):
        config_seed = args.seed + config_index
        checkpoint = load_config_checkpoint(
            checkpoint_dir=checkpoint_dir,
            config_index=config_index,
            config_name=config_name,
            quota=quota,
            dataset_id=args.dataset_id,
            dataset_revision=dataset_revision,
            seed=config_seed,
            shuffle_buffer=args.shuffle_buffer,
            output_dir=output,
            seen_example_keys=seen_example_keys,
        )
        if checkpoint is None:
            examples, config_stats = fetch_config(
                dataset_id=args.dataset_id,
                dataset_revision=dataset_revision,
                config_name=config_name,
                quota=quota,
                seed=config_seed,
                shuffle_buffer=args.shuffle_buffer,
                image_dir=image_dir,
                seen_example_keys=seen_example_keys,
            )
            save_config_checkpoint(
                checkpoint_dir=checkpoint_dir,
                config_index=config_index,
                config_name=config_name,
                quota=quota,
                dataset_id=args.dataset_id,
                dataset_revision=dataset_revision,
                seed=config_seed,
                shuffle_buffer=args.shuffle_buffer,
                examples=examples,
                stats=config_stats,
            )
            checkpoint_reused = False
        else:
            examples, config_stats = checkpoint
            checkpoint_reused = True
        all_examples.extend(examples)
        stats[config_name] = config_stats
        print(
            json.dumps({"config": config_name, "checkpoint_reused": checkpoint_reused, **config_stats}),
            flush=True,
        )

    random.Random(args.seed).shuffle(all_examples)
    manifest = output / "manifest.jsonl"
    temporary = output / f".manifest.jsonl.{os.getpid()}.partial"
    with temporary.open("w", encoding="utf-8") as handle:
        for example in all_examples:
            handle.write(json.dumps(example, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(manifest)
    manifest_sha256 = hashlib.sha256(manifest.read_bytes()).hexdigest()
    provenance = {
        "dataset_id": args.dataset_id,
        "dataset_revision": dataset_revision,
        "split": "train",
        "preset": args.preset,
        "seed": args.seed,
        "shuffle_buffer": args.shuffle_buffer,
        "target_examples": sum(quotas.values()),
        "manifest_examples": len(all_examples),
        "manifest_sha256": manifest_sha256,
        "quotas": quotas,
        "stats": stats,
        "evaluation_splits_included": False,
    }
    provenance_path = output / "provenance.json"
    provenance_path.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(provenance, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    # datasets/hf-xet can crash in PyGILState_Release during interpreter teardown after
    # successful streaming. Flush every artifact above, then bypass that faulty finalizer.
    try:
        exit_code = main()
    except BaseException:  # noqa: BLE001
        traceback.print_exc()
        exit_code = 1
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(exit_code)
