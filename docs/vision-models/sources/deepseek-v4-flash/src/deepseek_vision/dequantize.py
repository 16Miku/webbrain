from __future__ import annotations

import gc
import json
import os
import shutil
from pathlib import Path
from typing import Any


def _require_stack():
    try:
        import torch
        from safetensors import safe_open
        from safetensors.torch import load_file, save_file
    except ImportError as exc:  # pragma: no cover - exercised on the training host
        raise RuntimeError("checkpoint conversion requires the 'train' dependency group") from exc
    return torch, safe_open, load_file, save_file


def dequantize_block_weight(weight: Any, scale: Any, block_size: tuple[int, int] = (128, 128)):
    """Expand a 2D block-scaled FP8 tensor to BF16 without a full FP32 scale matrix."""
    torch, _, _, _ = _require_stack()
    if weight.ndim != 2 or scale.ndim != 2:
        raise ValueError("block dequantization expects 2D weight and scale tensors")
    block_rows, block_cols = block_size
    rows, cols = weight.shape
    expected = (
        (rows + block_rows - 1) // block_rows,
        (cols + block_cols - 1) // block_cols,
    )
    if tuple(scale.shape) != expected:
        raise ValueError(f"scale shape {tuple(scale.shape)} does not match expected {expected}")

    output = torch.empty(weight.shape, dtype=torch.bfloat16, device=weight.device)
    for block_row, row_start in enumerate(range(0, rows, block_rows)):
        row_end = min(row_start + block_rows, rows)
        row_scale = scale[block_row].float().repeat_interleave(block_cols)[:cols]
        output[row_start:row_end] = (
            weight[row_start:row_end].float() * row_scale.unsqueeze(0)
        ).to(torch.bfloat16)
    return output


def _expected_output_keys(input_keys: set[str]) -> set[str]:
    paired_scales = {
        name for name in input_keys if name.endswith(".scale") and name[:-6] + ".weight" in input_keys
    }
    return input_keys - paired_scales


def _inspect_shard(path: Path, safe_open) -> tuple[set[str], int]:
    keys: set[str] = set()
    total_size = 0
    with safe_open(path, framework="pt", device="cpu") as handle:
        for name in handle.keys():  # noqa: SIM118 - safe_open is not directly iterable
            tensor = handle.get_slice(name)
            shape = tensor.get_shape()
            dtype = tensor.get_dtype()
            bytes_per_element = {
                "BOOL": 1,
                "I8": 1,
                "U8": 1,
                "F8_E4M3": 1,
                "F8_E5M2": 1,
                "I16": 2,
                "U16": 2,
                "F16": 2,
                "BF16": 2,
                "I32": 4,
                "U32": 4,
                "F32": 4,
                "I64": 8,
                "U64": 8,
                "F64": 8,
            }.get(dtype)
            if bytes_per_element is None:
                raise ValueError(f"unsupported safetensors dtype {dtype!r} in {path}")
            elements = 1
            for dimension in shape:
                elements *= dimension
            total_size += elements * bytes_per_element
            keys.add(name)
    return keys, total_size


def _copy_metadata_files(source: Path, destination: Path) -> None:
    for path in source.iterdir():
        if not path.is_file() or path.name.endswith(".safetensors"):
            continue
        if path.name == "model.safetensors.index.json":
            continue
        shutil.copy2(path, destination / path.name)

    config_path = destination / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config.pop("quantization_config", None)
    config["torch_dtype"] = "bfloat16"
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


def dequantize_checkpoint(
    source_dir: str | Path,
    output_dir: str | Path,
    *,
    resume: bool = False,
    block_size: tuple[int, int] = (128, 128),
) -> dict[str, Any]:
    """Stream an SGLang block-FP8 DeepSeek checkpoint into a BF16 checkpoint.

    Each source shard is converted independently and written atomically. Paired
    ``*.scale`` tensors are folded into their ``*.weight`` tensor and omitted from
    the output. This keeps peak host memory bounded by one source/output shard.
    """
    _, safe_open, load_file, save_file = _require_stack()
    source = Path(source_dir).resolve()
    destination = Path(output_dir).resolve()
    if source == destination:
        raise ValueError("source and output checkpoint directories must differ")
    index_path = source / "model.safetensors.index.json"
    if not index_path.is_file():
        raise ValueError(f"missing {index_path}")
    source_index = json.loads(index_path.read_text(encoding="utf-8"))
    shards = sorted(set(source_index["weight_map"].values()))
    if destination.exists() and any(destination.iterdir()) and not resume:
        raise ValueError(f"output directory is not empty: {destination}; pass resume=True")
    destination.mkdir(parents=True, exist_ok=True)
    _copy_metadata_files(source, destination)

    weight_map: dict[str, str] = {}
    total_size = 0
    converted_weights = 0
    skipped_shards = 0
    for shard_number, shard_name in enumerate(shards, 1):
        source_path = source / shard_name
        output_path = destination / shard_name
        input_keys, _ = _inspect_shard(source_path, safe_open)
        expected_keys = _expected_output_keys(input_keys)
        if resume and output_path.is_file():
            try:
                output_keys, output_size = _inspect_shard(output_path, safe_open)
            except (OSError, RuntimeError, ValueError):
                output_path.unlink()
            else:
                if output_keys == expected_keys:
                    weight_map.update({name: shard_name for name in output_keys})
                    total_size += output_size
                    skipped_shards += 1
                    print(
                        json.dumps(
                            {"shard": shard_number, "total_shards": len(shards), "status": "cached"}
                        ),
                        flush=True,
                    )
                    continue
                output_path.unlink()

        state = load_file(str(source_path), device="cpu")
        output_state: dict[str, Any] = {}
        paired_scale_names: set[str] = set()
        for name, tensor in state.items():
            scale_name = name[:-7] + ".scale" if name.endswith(".weight") else ""
            if scale_name and scale_name in state:
                output_state[name] = dequantize_block_weight(tensor, state[scale_name], block_size)
                paired_scale_names.add(scale_name)
                converted_weights += 1
            elif name not in paired_scale_names and not (
                name.endswith(".scale") and name[:-6] + ".weight" in state
            ):
                output_state[name] = tensor
        if set(output_state) != expected_keys:
            missing = sorted(expected_keys - output_state.keys())
            extra = sorted(output_state.keys() - expected_keys)
            raise RuntimeError(f"{shard_name}: converted keys differ; missing={missing}, extra={extra}")

        temporary = output_path.with_name(output_path.name + ".partial")
        if temporary.exists():
            temporary.unlink()
        save_file(
            {name: tensor.contiguous() for name, tensor in output_state.items()},
            str(temporary),
            metadata={"format": "pt", "source": str(source), "conversion": "block-fp8-to-bf16"},
        )
        os.replace(temporary, output_path)
        output_keys, output_size = _inspect_shard(output_path, safe_open)
        weight_map.update({name: shard_name for name in output_keys})
        total_size += output_size
        print(
            json.dumps(
                {
                    "shard": shard_number,
                    "total_shards": len(shards),
                    "status": "converted",
                    "output_gib": round(output_size / 2**30, 3),
                }
            ),
            flush=True,
        )
        del state, output_state
        gc.collect()

    output_index = {
        "metadata": {"total_size": total_size},
        "weight_map": dict(sorted(weight_map.items())),
    }
    (destination / "model.safetensors.index.json").write_text(
        json.dumps(output_index, indent=2) + "\n", encoding="utf-8"
    )
    summary = {
        "source": str(source),
        "output": str(destination),
        "shards": len(shards),
        "skipped_shards": skipped_shards,
        "converted_weights": converted_weights,
        "output_bytes": total_size,
    }
    (destination / "dequantization-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    return summary
