#!/usr/bin/env python3
"""Four-GPU data-parallel MoonViT-to-Laguna projector trainer."""

from __future__ import annotations

import argparse
from contextlib import nullcontext
import json
import math
import os
from pathlib import Path
import random
import time


MODEL_ID = "poolside/Laguna-XS-2.1"
MODEL_REVISION = "e9df9a59996d790b94b70f3fef343fe1d9e34bdf"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("cache_dir")
    parser.add_argument("output_dir")
    parser.add_argument("--max-examples", type=int)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--global-gradient-accumulation", type=int, default=128)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=0.0)
    parser.add_argument("--warmup-ratio", type=float, default=0.03)
    parser.add_argument("--gradient-clip", type=float, default=1.0)
    parser.add_argument("--save-every", type=int, default=10)
    parser.add_argument("--seed", type=int, default=20260802)
    parser.add_argument("--resume", action="store_true")
    return parser.parse_args()


def atomic_json(payload: dict, path: Path) -> None:
    temporary = path.with_name(f".{path.name}.partial")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def atomic_torch_save(torch, payload, path: Path) -> None:
    temporary = path.with_name(f".{path.name}.partial")
    torch.save(payload, temporary)
    temporary.replace(path)


def main() -> int:
    args = parse_args()
    import torch
    import torch.distributed as dist
    from torch import nn
    from torch.nn.parallel import DistributedDataParallel
    from safetensors.torch import load_file, save_file
    from transformers import AutoModelForCausalLM

    if not dist.is_available():
        raise RuntimeError("torch.distributed is unavailable")
    dist.init_process_group(backend="nccl")
    rank = dist.get_rank()
    world_size = dist.get_world_size()
    local_rank = int(os.environ["LOCAL_RANK"])
    torch.cuda.set_device(local_rank)
    device = torch.device("cuda", local_rank)
    if world_size < 2:
        raise RuntimeError("DDP trainer requires at least two processes")
    if args.global_gradient_accumulation % world_size:
        raise ValueError("global gradient accumulation must be divisible by world size")
    local_accumulation = args.global_gradient_accumulation // world_size

    class PatchMergerProjector(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.pre_norm = nn.LayerNorm(1152, eps=1e-5)
            self.proj = nn.Sequential(
                nn.Linear(4608, 4608),
                nn.GELU(),
                nn.Linear(4608, 2048),
            )

        def forward(self, features):
            normalized = self.pre_norm(features)
            return self.proj(normalized.reshape(-1, 4608))

    cache = Path(args.cache_dir).resolve()
    output = Path(args.output_dir).resolve()
    if rank == 0:
        output.mkdir(parents=True, exist_ok=True)
    dist.barrier()
    global_paths = sorted((cache / "examples").glob("*.pt"))
    if not global_paths:
        raise ValueError(f"no cached examples in {cache / 'examples'}")
    random.Random(args.seed).shuffle(global_paths)
    if args.max_examples is not None:
        global_paths = global_paths[: args.max_examples]
    if len(global_paths) % world_size:
        raise ValueError("example count must be divisible by DDP world size")
    local_paths = global_paths[rank::world_size]
    total_global_examples = len(global_paths) * args.epochs
    total_local_examples = len(local_paths) * args.epochs
    optimizer_steps = math.ceil(
        total_global_examples / args.global_gradient_accumulation
    )
    warmup_steps = max(1, int(optimizer_steps * args.warmup_ratio))

    load_started = time.monotonic()
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        dtype=torch.bfloat16,
        device_map={"": local_rank},
        low_cpu_mem_usage=True,
        trust_remote_code=True,
        attn_implementation="sdpa",
    )
    model.requires_grad_(False)
    model.config.use_cache = False
    model.config._experts_implementation = "eager"
    model.gradient_checkpointing_enable(
        gradient_checkpointing_kwargs={"use_reentrant": False}
    )
    model.train()
    projector = PatchMergerProjector().to(device=device, dtype=torch.bfloat16)
    parameter_count = sum(parameter.numel() for parameter in projector.parameters())
    if parameter_count != 30_679_808:
        raise RuntimeError(f"unexpected projector parameter count {parameter_count}")
    projector = DistributedDataParallel(
        projector,
        device_ids=[local_rank],
        output_device=local_rank,
        broadcast_buffers=False,
        find_unused_parameters=False,
    )
    optimizer = torch.optim.AdamW(
        projector.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )

    def lr_factor(step: int) -> float:
        if step < warmup_steps:
            return (step + 1) / warmup_steps
        progress = (step - warmup_steps) / max(1, optimizer_steps - warmup_steps)
        return 0.5 * (1.0 + math.cos(math.pi * progress))

    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lr_factor)
    completed_local_examples = 0
    completed_steps = 0
    state_path = output / "training-state.json"
    if args.resume and state_path.exists():
        state = json.loads(state_path.read_text())
        if int(state.get("world_size", 0)) != world_size:
            raise RuntimeError("checkpoint world size differs from current DDP world size")
        completed_local_examples = int(state["local_examples"])
        completed_steps = int(state["optimizer_step"])
        projector.module.load_state_dict(
            load_file(str(output / state["projector"]), device=str(device))
        )
        optimizer.load_state_dict(
            torch.load(output / state["optimizer"], map_location=device, weights_only=True)
        )
        scheduler.load_state_dict(state["scheduler"])
    elif args.resume and rank == 0:
        print(json.dumps({"event": "resume", "found": False}), flush=True)

    flat_local_paths: list[Path] = []
    for epoch in range(args.epochs):
        epoch_paths = local_paths.copy()
        random.Random(args.seed + epoch).shuffle(epoch_paths)
        flat_local_paths.extend(epoch_paths)
    load_seconds = time.monotonic() - load_started
    torch.cuda.reset_peak_memory_stats(device)
    optimizer.zero_grad(set_to_none=True)
    dist.barrier()
    started = time.monotonic()
    run_local_examples = 0
    local_tokens = 0
    microbatches = 0
    local_loss_sum = 0.0
    step_losses: list[float] = []

    def save_checkpoint(final: bool = False) -> None:
        if rank == 0:
            projector_name = f"projector-step-{completed_steps:06d}.safetensors"
            optimizer_name = f"optimizer-step-{completed_steps:06d}.pt"
            save_file(
                {
                    name: tensor.detach().cpu()
                    for name, tensor in projector.module.state_dict().items()
                },
                str(output / projector_name),
            )
            atomic_torch_save(torch, optimizer.state_dict(), output / optimizer_name)
            atomic_json(
                {
                    "model_id": MODEL_ID,
                    "model_revision": MODEL_REVISION,
                    "world_size": world_size,
                    "projector": projector_name,
                    "optimizer": optimizer_name,
                    "scheduler": scheduler.state_dict(),
                    "local_examples": completed_local_examples,
                    "examples": completed_local_examples * world_size,
                    "optimizer_step": completed_steps,
                    "total_examples": total_global_examples,
                    "final": final,
                },
                state_path,
            )
        dist.barrier()

    for local_index, path in enumerate(flat_local_paths):
        if local_index < completed_local_examples:
            continue
        example = torch.load(path, map_location="cpu", weights_only=True)
        vision_path = (path.parent / example["vision_feature_path"]).resolve()
        vision = torch.load(vision_path, map_location="cpu", weights_only=True)[
            "vision_features"
        ].to(device=device, dtype=torch.bfloat16)
        input_ids = example["input_ids"].unsqueeze(0).to(device)
        image_mask = example["image_mask"].unsqueeze(0).to(device)
        attention_mask = example["attention_mask"].unsqueeze(0).to(device)
        labels = example["labels"].unsqueeze(0).to(device)
        if int(image_mask.sum()) != int(vision.shape[0]):
            raise ValueError(f"{path}: image slots and vision features differ")
        is_last_local = completed_local_examples + 1 == total_local_examples
        should_sync = microbatches + 1 >= local_accumulation or is_last_local
        sync_context = nullcontext() if should_sync else projector.no_sync()
        with sync_context:
            with torch.no_grad():
                text_embeddings = model.get_input_embeddings()(input_ids)
            projected = projector(vision)
            mixed = text_embeddings.clone()
            mixed[image_mask] = projected.to(mixed.dtype)
            result = model(
                inputs_embeds=mixed,
                attention_mask=attention_mask,
                labels=labels,
                use_cache=False,
            )
            loss = result.loss
            if not torch.isfinite(loss):
                raise RuntimeError(f"rank {rank}: non-finite loss")
            loss.backward()
        completed_local_examples += 1
        run_local_examples += 1
        local_tokens += int(input_ids.numel())
        microbatches += 1
        local_loss_sum += float(loss.item())
        if not should_sync:
            continue
        for parameter in projector.parameters():
            if parameter.grad is not None:
                parameter.grad.div_(microbatches)
        gradient_norm = torch.nn.utils.clip_grad_norm_(
            projector.parameters(), args.gradient_clip
        )
        if not torch.isfinite(gradient_norm):
            raise RuntimeError(f"rank {rank}: non-finite gradient")
        optimizer.step()
        scheduler.step()
        optimizer.zero_grad(set_to_none=True)
        completed_steps += 1

        metric_values = torch.tensor(
            [local_loss_sum, float(microbatches), float(local_tokens)],
            device=device,
            dtype=torch.float64,
        )
        dist.all_reduce(metric_values, op=dist.ReduceOp.SUM)
        elapsed = time.monotonic() - started
        global_run_examples = run_local_examples * world_size
        examples_per_hour = global_run_examples / elapsed * 3600
        average_loss = float(metric_values[0] / metric_values[1])
        step_losses.append(average_loss)
        if rank == 0:
            print(
                json.dumps(
                    {
                        "optimizer_step": completed_steps,
                        "examples": completed_local_examples * world_size,
                        "loss": average_loss,
                        "gradient_norm": float(gradient_norm),
                        "learning_rate": scheduler.get_last_lr()[0],
                        "examples_per_hour": examples_per_hour,
                        "tokens_per_second": float(metric_values[2]) / elapsed,
                        "projected_100k_hours": 100_000 / examples_per_hour,
                        "world_size": world_size,
                    }
                ),
                flush=True,
            )
        if completed_steps % args.save_every == 0 or is_last_local:
            save_checkpoint(final=is_last_local)
        microbatches = 0
        local_loss_sum = 0.0

    torch.cuda.synchronize(device)
    elapsed = time.monotonic() - started
    peak = torch.tensor(
        [
            torch.cuda.max_memory_allocated(device) / 1024**3,
            torch.cuda.max_memory_reserved(device) / 1024**3,
        ],
        device=device,
        dtype=torch.float64,
    )
    dist.all_reduce(peak, op=dist.ReduceOp.MAX)
    global_run_examples = run_local_examples * world_size
    examples_per_hour = global_run_examples / elapsed * 3600
    if rank == 0:
        summary = {
            "model_id": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "world_size": world_size,
            "projector_parameters": parameter_count,
            "unique_examples": len(global_paths),
            "epochs": args.epochs,
            "examples": completed_local_examples * world_size,
            "optimizer_steps": completed_steps,
            "load_seconds": load_seconds,
            "elapsed_seconds": elapsed,
            "examples_per_hour": examples_per_hour,
            "projected_100k_hours": 100_000 / examples_per_hour,
            "peak_allocated_gib": float(peak[0]),
            "peak_reserved_gib": float(peak[1]),
            "first_step_loss": step_losses[0] if step_losses else None,
            "final_step_loss": step_losses[-1] if step_losses else None,
            "minimum_step_loss": min(step_losses) if step_losses else None,
        }
        atomic_json(summary, output / "run-summary.json")
        print(json.dumps(summary, indent=2), flush=True)
    dist.barrier()
    dist.destroy_process_group()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
