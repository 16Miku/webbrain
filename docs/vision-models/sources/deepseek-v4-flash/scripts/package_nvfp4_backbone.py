#!/usr/bin/env python3
"""Copy the pinned NVIDIA DeepSeek V4 NVFP4 backbone into a model repo.

The copy is resumable at file granularity. Each source file is downloaded, uploaded,
verified against Hub metadata, and removed locally before the next file starts.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

SOURCE_REPO = "nvidia/DeepSeek-V4-Flash-NVFP4"
SOURCE_REVISION = "e3cd60e7de98e9867116860d522499a728de1cf9"
TARGET_REPO = "webbrain-one/DeepSeek-V4-Flash-Vision-NVFP4"

BACKBONE_FILES = [
    ".gitattributes",
    "LICENSE",
    "config.json",
    "generation_config.json",
    "hf_quant_config.json",
    "model.safetensors.index.json",
    "tokenizer.json",
    "tokenizer_config.json",
    *[f"model-{index:05d}-of-00046.safetensors" for index in range(1, 47)],
]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-repo", default=SOURCE_REPO)
    parser.add_argument("--source-revision", default=SOURCE_REVISION)
    parser.add_argument("--target-repo", default=TARGET_REPO)
    parser.add_argument(
        "--stage-dir",
        default="artifacts/package/deepseek-v4-nvfp4",
        help="Temporary download directory; completed files are removed by default.",
    )
    parser.add_argument("--keep-downloads", action="store_true")
    return parser


def fingerprint(sibling: Any) -> tuple[str, str, int]:
    if sibling.lfs is not None:
        return ("lfs", sibling.lfs.sha256, int(sibling.size))
    if sibling.blob_id is None:
        raise RuntimeError(f"missing blob id for {sibling.rfilename}")
    return ("git", sibling.blob_id, int(sibling.size))


def sibling_map(api: Any, repo_id: str, revision: str | None = None) -> dict[str, Any]:
    info = api.model_info(
        repo_id,
        revision=revision,
        files_metadata=True,
        token=False if revision is not None else None,
    )
    return {sibling.rfilename: sibling for sibling in info.siblings}


def emit(event: str, **values: object) -> None:
    print(json.dumps({"event": event, **values}, sort_keys=True), flush=True)


def remove_download(path: Path, stage_dir: Path) -> None:
    path.unlink(missing_ok=True)
    parent = path.parent
    while parent != stage_dir and parent != parent.parent:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


def main() -> int:
    args = build_parser().parse_args()
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise RuntimeError("HF_TOKEN is required for the private target repository")

    from huggingface_hub import HfApi, hf_hub_download

    stage_dir = Path(args.stage_dir).resolve()
    stage_dir.mkdir(parents=True, exist_ok=True)
    source_api = HfApi()
    target_api = HfApi(token=token)

    source_files = sibling_map(source_api, args.source_repo, args.source_revision)
    missing_source = [name for name in BACKBONE_FILES if name not in source_files]
    if missing_source:
        raise RuntimeError(f"source revision is missing files: {missing_source}")

    target_files = sibling_map(target_api, args.target_repo)
    copied = 0
    skipped = 0
    for position, name in enumerate(BACKBONE_FILES, 1):
        expected = fingerprint(source_files[name])
        existing = target_files.get(name)
        if existing is not None and fingerprint(existing) == expected:
            skipped += 1
            emit(
                "skip",
                file=name,
                position=position,
                total=len(BACKBONE_FILES),
                fingerprint=expected[1],
            )
            continue

        emit(
            "download_start",
            file=name,
            position=position,
            total=len(BACKBONE_FILES),
            size=expected[2],
        )
        local_path = Path(
            hf_hub_download(
                repo_id=args.source_repo,
                filename=name,
                revision=args.source_revision,
                local_dir=stage_dir,
                token=False,
            )
        )
        if local_path.stat().st_size != expected[2]:
            raise RuntimeError(
                f"downloaded size mismatch for {name}: "
                f"{local_path.stat().st_size} != {expected[2]}"
            )

        emit("upload_start", file=name, size=expected[2])
        target_api.upload_file(
            path_or_fileobj=local_path,
            path_in_repo=name,
            repo_id=args.target_repo,
            repo_type="model",
            commit_message=(
                f"Copy {name} from pinned NVIDIA NVFP4 backbone "
                f"({args.source_revision[:8]})"
            ),
        )
        target_files = sibling_map(target_api, args.target_repo)
        uploaded = target_files.get(name)
        if uploaded is None or fingerprint(uploaded) != expected:
            actual = None if uploaded is None else fingerprint(uploaded)
            raise RuntimeError(f"uploaded fingerprint mismatch for {name}: {actual} != {expected}")

        copied += 1
        emit(
            "verified",
            file=name,
            position=position,
            total=len(BACKBONE_FILES),
            fingerprint=expected[1],
        )
        if not args.keep_downloads:
            remove_download(local_path, stage_dir)

    emit("complete", copied=copied, skipped=skipped, total=len(BACKBONE_FILES))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
