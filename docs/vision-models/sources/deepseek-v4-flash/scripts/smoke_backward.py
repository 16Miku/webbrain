#!/usr/bin/env python3
"""Load the BF16 DeepSeek checkpoint and run one routing-aware projector backward pass."""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-config", default="configs/model/moonvit.json")
    parser.add_argument("--sequence-length", type=int, default=16)
    parser.add_argument("--max-memory-per-gpu", default="132GiB")
    parser.add_argument("--summary", default="artifacts/smoke-backward-summary.json")
    return parser


def resolve_project_path(config_path: Path, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return config_path.resolve().parents[2] / path


def main() -> int:
    args = build_parser().parse_args()
    if args.sequence_length < 8:
        raise ValueError("sequence length must be at least 8")

    import torch
    from transformers import AutoModelForCausalLM

    from deepseek_vision.config import load_project_config
    from deepseek_vision.modeling import DeepSeekVisionForProjectorTraining
    from deepseek_vision.projector import PatchMergerProjector
    from deepseek_vision.routing import build_routing_ids

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required")
    gpu_count = torch.cuda.device_count()
    if gpu_count < 2:
        raise RuntimeError("the real checkpoint smoke gate requires multiple GPUs")

    config_path = Path(args.model_config)
    project_config = load_project_config(config_path)
    checkpoint = resolve_project_path(config_path, project_config.text.model_id)
    palette_path = resolve_project_path(config_path, project_config.routing.palette_path)
    palette = json.loads(palette_path.read_text(encoding="utf-8"))
    if len(palette) != project_config.routing.palette_size:
        raise RuntimeError("routing palette length differs from model config")

    torch.manual_seed(project_config.seed)
    max_memory = {index: args.max_memory_per_gpu for index in range(gpu_count)}
    for index in range(gpu_count):
        with torch.cuda.device(index):
            torch.cuda.reset_peak_memory_stats()

    load_started = time.monotonic()
    language_model = AutoModelForCausalLM.from_pretrained(
        checkpoint,
        device_map="balanced",
        dtype="auto",
        low_cpu_mem_usage=True,
        max_memory=max_memory,
    )
    load_seconds = time.monotonic() - load_started
    language_model.config.use_cache = False
    language_model.gradient_checkpointing_enable(
        gradient_checkpointing_kwargs={"use_reentrant": False}
    )

    embedding_device = language_model.get_input_embeddings().weight.device
    label_device = language_model.get_output_embeddings().weight.device
    projector = PatchMergerProjector(
        project_config.projector.vision_hidden_size,
        project_config.projector.text_hidden_size,
        project_config.projector.merge_size,
        project_config.projector.layer_norm_eps,
    ).to(device=embedding_device, dtype=torch.bfloat16)
    model = DeepSeekVisionForProjectorTraining(None, projector, language_model, palette)
    model.train()

    vocab_size = int(language_model.config.vocab_size)
    input_ids = (
        torch.arange(100, 100 + args.sequence_length, dtype=torch.long)
        .remainder(vocab_size)
        .unsqueeze(0)
        .to(embedding_device)
    )
    image_mask = torch.zeros_like(input_ids, dtype=torch.bool)
    image_mask[:, args.sequence_length // 3] = True
    vision_features = torch.randn(
        1,
        project_config.projector.merge_size**2,
        project_config.projector.vision_hidden_size,
        device=embedding_device,
        dtype=torch.bfloat16,
    )
    labels = torch.full(
        input_ids.shape,
        -100,
        dtype=torch.long,
        device=label_device,
    )
    labels[:, -1] = input_ids[:, -1].to(label_device)

    routing_ids = build_routing_ids(input_ids, image_mask, palette, vocab_size=vocab_size)
    if not torch.equal(routing_ids[~image_mask], input_ids[~image_mask]):
        raise RuntimeError("text routing IDs changed")

    backward_started = time.monotonic()
    result = model(
        input_ids=input_ids,
        image_mask=image_mask,
        vision_features=vision_features,
        labels=labels,
    )
    if result.loss is None or not torch.isfinite(result.loss):
        raise RuntimeError(f"non-finite smoke loss: {result.loss}")
    result.loss.backward()
    backward_seconds = time.monotonic() - backward_started

    gradient_tensors = 0
    gradient_norm_squared = 0.0
    for parameter in projector.parameters():
        if parameter.grad is None:
            continue
        if not torch.isfinite(parameter.grad).all():
            raise RuntimeError("projector has a non-finite gradient")
        gradient_tensors += 1
        gradient_norm_squared += float(parameter.grad.float().square().sum().item())
    if gradient_tensors == 0:
        raise RuntimeError("projector did not receive gradients")
    if any(parameter.grad is not None for parameter in language_model.parameters()):
        raise RuntimeError("a frozen DeepSeek parameter received a gradient")

    memory = []
    for index in range(gpu_count):
        with torch.cuda.device(index):
            torch.cuda.synchronize()
        memory.append(
            {
                "gpu": index,
                "allocated_gib": round(torch.cuda.memory_allocated(index) / 1024**3, 3),
                "reserved_gib": round(torch.cuda.memory_reserved(index) / 1024**3, 3),
                "peak_allocated_gib": round(torch.cuda.max_memory_allocated(index) / 1024**3, 3),
            }
        )

    summary = {
        "status": "pass",
        "checkpoint": str(checkpoint),
        "gpu_count": gpu_count,
        "sequence_length": args.sequence_length,
        "image_tokens": int(image_mask.sum().item()),
        "load_seconds": round(load_seconds, 3),
        "forward_backward_seconds": round(backward_seconds, 3),
        "loss": float(result.loss.detach().item()),
        "projector_gradient_tensors": gradient_tensors,
        "projector_gradient_norm": math.sqrt(gradient_norm_squared),
        "text_routing_ids_preserved": True,
        "language_model_gradients": 0,
        "memory": memory,
    }
    output = Path(args.summary)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
