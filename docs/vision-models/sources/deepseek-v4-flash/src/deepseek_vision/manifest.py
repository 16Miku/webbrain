from __future__ import annotations

import hashlib
import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO


@dataclass(frozen=True)
class SourceSpec:
    name: str
    path: Path
    quota: int


REQUIRED_FIELDS = {"id", "image", "question", "answer"}


def validate_example(example: dict[str, Any], source: str, line_number: int) -> None:
    missing = REQUIRED_FIELDS - example.keys()
    if missing:
        raise ValueError(f"{source}:{line_number}: missing {sorted(missing)}")
    for key in REQUIRED_FIELDS:
        if not isinstance(example[key], str) or not example[key].strip():
            raise ValueError(f"{source}:{line_number}: {key} must be a non-empty string")


def _stable_rank(seed: int, source: str, example_id: str) -> bytes:
    return hashlib.sha256(f"{seed}\0{source}\0{example_id}".encode()).digest()


def sample_source(spec: SourceSpec, seed: int) -> list[dict[str, Any]]:
    ranked: list[tuple[bytes, dict[str, Any]]] = []
    seen: set[str] = set()
    with spec.path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            example = json.loads(line)
            validate_example(example, str(spec.path), line_number)
            if example["id"] in seen:
                raise ValueError(f"{spec.path}:{line_number}: duplicate id {example['id']!r}")
            seen.add(example["id"])
            ranked.append((_stable_rank(seed, spec.name, example["id"]), example))
    if len(ranked) < spec.quota:
        raise ValueError(f"source {spec.name!r} has {len(ranked)} rows, needs {spec.quota}")
    ranked.sort(key=lambda item: item[0])
    result = []
    for _, example in ranked[: spec.quota]:
        record = dict(example)
        record["source"] = spec.name
        result.append(record)
    return result


def build_manifest(config_path: str | Path, output: TextIO) -> int:
    config_file = Path(config_path)
    raw = json.loads(config_file.read_text(encoding="utf-8"))
    seed = int(raw.get("seed", 20260802))
    specs = [
        SourceSpec(
            name=item["name"],
            path=(config_file.parent / item["path"]).resolve(),
            quota=int(item["quota"]),
        )
        for item in raw["sources"]
    ]
    target = int(raw["target_examples"])
    if sum(spec.quota for spec in specs) != target:
        raise ValueError("source quotas do not sum to target_examples")
    records = [record for spec in specs for record in sample_source(spec, seed)]
    random.Random(seed).shuffle(records)
    output.writelines(json.dumps(record, ensure_ascii=False) + "\n" for record in records)
    return len(records)
