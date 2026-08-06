from __future__ import annotations

import json
from pathlib import Path


def component_shards(index: dict, prefix: str) -> list[str]:
    shards = {shard for name, shard in index["weight_map"].items() if name.startswith(prefix)}
    if not shards:
        raise ValueError(f"no tensors found with prefix {prefix!r}")
    return sorted(shards)


def extract_component(
    model_id: str,
    revision: str,
    prefix: str,
    output: str | Path,
) -> Path:
    """Download only component-containing shards and strip their key prefix."""
    try:
        from huggingface_hub import hf_hub_download
        from safetensors.torch import load_file, save_file
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("component extraction requires the 'train' dependency group") from exc

    index_path = hf_hub_download(model_id, "model.safetensors.index.json", revision=revision)
    index = json.loads(Path(index_path).read_text(encoding="utf-8"))
    shards = component_shards(index, prefix)
    tensors = {}
    expected = {name for name in index["weight_map"] if name.startswith(prefix)}
    for shard in shards:
        shard_path = hf_hub_download(model_id, shard, revision=revision)
        state = load_file(shard_path, device="cpu")
        for name, tensor in state.items():
            if name.startswith(prefix):
                tensors[name.removeprefix(prefix)] = tensor
    missing = sorted({name.removeprefix(prefix) for name in expected} - tensors.keys())
    if missing:
        raise RuntimeError(f"component extraction missed {len(missing)} tensors")
    destination = Path(output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    save_file(
        tensors,
        str(destination),
        metadata={"source_model": model_id, "source_revision": revision, "prefix": prefix},
    )
    return destination
