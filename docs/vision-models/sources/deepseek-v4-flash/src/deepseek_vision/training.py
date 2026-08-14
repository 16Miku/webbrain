from __future__ import annotations

import json
import math
import random
import re
import time
from pathlib import Path


def _require_training_stack():
    try:
        import torch
        from safetensors.torch import load_file, save_file
        from transformers import AutoConfig, AutoModelForCausalLM
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("training requires: pip install -e '.[train]'") from exc
    return torch, load_file, save_file, AutoConfig, AutoModelForCausalLM


def resume_step_from_checkpoint(path: str | Path) -> int:
    match = re.fullmatch(r"projector-step-(\d+)\.safetensors", Path(path).name)
    if match is None:
        raise ValueError(
            "resume checkpoint must be named projector-step-NNNNNN.safetensors"
        )
    return int(match.group(1))


def cached_example_paths(cache_dir: str | Path, seed: int, limit: int | None = None) -> list[Path]:
    root = Path(cache_dir)
    paths = sorted(root.glob("*.pt"))
    if not paths:
        paths = sorted((root / "examples").glob("*.pt"))
    if not paths:
        raise ValueError(f"no .pt feature-cache examples found in {cache_dir}")
    random.Random(seed).shuffle(paths)
    return paths[:limit]


def _validate_cached_example(example, path: Path) -> None:
    required = {"input_ids", "image_mask", "labels"}
    missing = required - example.keys()
    if missing:
        raise ValueError(f"{path}: missing cached fields {sorted(missing)}")
    if example["input_ids"].ndim != 1:
        raise ValueError(f"{path}: input_ids must be one-dimensional")
    if example["image_mask"].shape != example["input_ids"].shape:
        raise ValueError(f"{path}: image_mask and input_ids shapes differ")
    if "vision_features" not in example and "vision_feature_path" not in example:
        raise ValueError(f"{path}: no embedded or referenced vision features")


def _load_vision_features(torch, example, path: Path):
    if "vision_features" in example:
        return example["vision_features"]
    feature_path = (path.parent / example["vision_feature_path"]).resolve()
    payload = torch.load(feature_path, map_location="cpu", weights_only=True)
    if "vision_features" not in payload:
        raise ValueError(f"{feature_path}: missing vision_features")
    return payload["vision_features"]


def train_cached_pilot(
    *,
    model_config_path: str | Path,
    train_config_path: str | Path,
    cache_dir: str | Path,
    output_dir: str | Path,
    max_examples: int | None = None,
    resume_checkpoint: str | Path | None = None,
) -> dict:
    """Experimental one-process model-parallel projector trainer.

    The DeepSeek model is dispatched across all visible GPUs. Only the projector is
    optimized. Run the 1k calibration gate before allowing `max_examples=100000`.
    """
    torch, load_file, save_file, AutoConfig, AutoModelForCausalLM = _require_training_stack()
    from .config import load_project_config
    from .modeling import DeepSeekVisionForProjectorTraining
    from .projector import PatchMergerProjector

    model_config = load_project_config(model_config_path)
    train_config = json.loads(Path(train_config_path).read_text(encoding="utf-8"))
    torch.manual_seed(model_config.seed)
    paths = cached_example_paths(cache_dir, model_config.seed, max_examples)
    epochs = int(train_config.get("epochs", 1))
    if epochs < 1:
        raise ValueError("epochs must be at least one")
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    palette_path = Path(model_config.routing.palette_path)
    if not palette_path.is_absolute():
        palette_path = Path(model_config_path).resolve().parents[2] / palette_path
    palette = json.loads(palette_path.read_text(encoding="utf-8"))
    if len(palette) != model_config.routing.palette_size:
        raise ValueError("routing palette length differs from model config")

    language_config = AutoConfig.from_pretrained(
        model_config.text.model_id,
        revision=model_config.text.revision,
    )
    if getattr(language_config, "quantization_config", None):
        raise RuntimeError(
            "projector training requires a dequantized BF16 DeepSeek checkpoint; "
            "the released FP4/FP8 inference kernels do not implement input autograd"
        )
    model_load_started = time.monotonic()
    language_model = AutoModelForCausalLM.from_pretrained(
        model_config.text.model_id,
        revision=model_config.text.revision,
        device_map="balanced",
        dtype="auto",
        low_cpu_mem_usage=True,
    )
    if train_config.get("gradient_checkpointing", True):
        language_model.gradient_checkpointing_enable(
            gradient_checkpointing_kwargs={"use_reentrant": False}
        )
    embedding_device = language_model.get_input_embeddings().weight.device
    label_device = language_model.get_output_embeddings().weight.device
    projector = PatchMergerProjector(
        model_config.projector.vision_hidden_size,
        model_config.projector.text_hidden_size,
        model_config.projector.merge_size,
        model_config.projector.layer_norm_eps,
    ).to(device=embedding_device, dtype=torch.bfloat16)
    resumed_optimizer_step = 0
    if resume_checkpoint is not None:
        resume_checkpoint = Path(resume_checkpoint)
        if not resume_checkpoint.is_file():
            raise ValueError(f"resume checkpoint does not exist: {resume_checkpoint}")
        resumed_optimizer_step = resume_step_from_checkpoint(resume_checkpoint)
        projector.load_state_dict(load_file(str(resume_checkpoint), device="cpu"))
    model = DeepSeekVisionForProjectorTraining(None, projector, language_model, palette)
    model_load_seconds = time.monotonic() - model_load_started
    optimizer = torch.optim.AdamW(
        projector.parameters(),
        lr=float(train_config["learning_rate"]),
        weight_decay=float(train_config["weight_decay"]),
    )
    accumulation = int(train_config["gradient_accumulation_steps"])
    if accumulation < 1:
        raise ValueError("gradient_accumulation_steps must be at least one")
    total_examples = len(paths) * epochs
    optimizer_steps = math.ceil(total_examples / accumulation)
    resumed_examples = resumed_optimizer_step * accumulation
    if resumed_optimizer_step > optimizer_steps or resumed_examples > total_examples:
        raise ValueError(
            f"resume checkpoint step {resumed_optimizer_step} exceeds this run's "
            f"{optimizer_steps} optimizer steps"
        )
    warmup_steps = max(1, int(optimizer_steps * float(train_config["warmup_ratio"])))

    def lr_factor(step: int) -> float:
        if step < warmup_steps:
            return (step + 1) / warmup_steps
        progress = (step - warmup_steps) / max(1, optimizer_steps - warmup_steps)
        return 0.5 * (1.0 + math.cos(math.pi * progress))

    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lr_factor)
    if resumed_optimizer_step:
        resumed_lrs = [
            base_lr * lr_factor(resumed_optimizer_step) for base_lr in scheduler.base_lrs
        ]
        for parameter_group, resumed_lr in zip(optimizer.param_groups, resumed_lrs):
            parameter_group["lr"] = resumed_lr
        scheduler.last_epoch = resumed_optimizer_step
        scheduler._step_count = resumed_optimizer_step + 1
        scheduler._last_lr = resumed_lrs
        print(
            json.dumps(
                {
                    "event": "resume",
                    "checkpoint": str(resume_checkpoint),
                    "optimizer_step": resumed_optimizer_step,
                    "examples": resumed_examples,
                    "optimizer_state_restored": False,
                }
            ),
            flush=True,
        )
    if torch.cuda.is_available():
        for device_index in range(torch.cuda.device_count()):
            torch.cuda.reset_peak_memory_stats(device_index)
    started = time.monotonic()
    optimizer.zero_grad(set_to_none=True)
    seen = resumed_examples
    processed_this_run = 0
    tokens_seen = 0
    completed_steps = resumed_optimizer_step
    microbatches_in_step = 0
    loss_in_step = 0.0
    step_losses: list[float] = []
    for epoch_index in range(epochs):
        epoch_paths = paths.copy()
        random.Random(model_config.seed + epoch_index).shuffle(epoch_paths)
        epoch_start = epoch_index * len(epoch_paths)
        for example_index, path in enumerate(epoch_paths):
            if epoch_start + example_index < resumed_examples:
                continue
            example = torch.load(path, map_location="cpu", weights_only=True)
            _validate_cached_example(example, path)
            vision_features = _load_vision_features(torch, example, path)
            if int(example["image_mask"].sum()) != vision_features.shape[0]:
                raise ValueError(f"{path}: image slots and merged vision-token groups differ")
            kwargs = {}
            for name in ("input_ids", "image_mask", "attention_mask"):
                if name in example:
                    kwargs[name] = example[name].unsqueeze(0).to(embedding_device)
            if "labels" in example:
                kwargs["labels"] = example["labels"].unsqueeze(0).to(label_device)
            kwargs["vision_features"] = vision_features.to(embedding_device, dtype=torch.bfloat16)
            result = model(**kwargs)
            loss = result.loss
            if not torch.isfinite(loss):
                raise RuntimeError(f"non-finite loss at example {seen + 1}: {loss.item()}")
            loss.backward()
            seen += 1
            processed_this_run += 1
            tokens_seen += int(example["input_ids"].numel())
            microbatches_in_step += 1
            loss_in_step += float(loss.item())
            if microbatches_in_step < accumulation and seen < total_examples:
                continue
            for parameter in projector.parameters():
                if parameter.grad is not None:
                    parameter.grad.div_(microbatches_in_step)
            torch.nn.utils.clip_grad_norm_(
                projector.parameters(), float(train_config["gradient_clip_norm"])
            )
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad(set_to_none=True)
            completed_steps += 1
            elapsed = time.monotonic() - started
            examples_per_hour = processed_this_run / elapsed * 3600
            average_loss = loss_in_step / microbatches_in_step
            step_losses.append(average_loss)
            metric = {
                "optimizer_step": completed_steps,
                "epoch": epoch_index + 1,
                "examples": seen,
                "loss": average_loss,
                "examples_per_hour": examples_per_hour,
                "tokens_per_second": tokens_seen / elapsed,
                "projected_100k_hours": 100_000 / examples_per_hour,
            }
            print(json.dumps(metric), flush=True)
            save_every = int(train_config["save_every_optimizer_steps"])
            if completed_steps % save_every == 0 or seen == total_examples:
                state = {
                    name: tensor.detach().cpu() for name, tensor in projector.state_dict().items()
                }
                save_file(state, str(output / f"projector-step-{completed_steps:06d}.safetensors"))
            microbatches_in_step = 0
            loss_in_step = 0.0

    elapsed = time.monotonic() - started
    examples_per_hour = seen / elapsed * 3600
    peak_allocated_gib = []
    peak_reserved_gib = []
    if torch.cuda.is_available():
        peak_allocated_gib = [
            torch.cuda.max_memory_allocated(index) / 1024**3
            for index in range(torch.cuda.device_count())
        ]
        peak_reserved_gib = [
            torch.cuda.max_memory_reserved(index) / 1024**3
            for index in range(torch.cuda.device_count())
        ]
    summary = {
        "unique_examples": len(paths),
        "epochs": epochs,
        "examples": seen,
        "examples_this_run": processed_this_run,
        "tokens": tokens_seen,
        "optimizer_steps": completed_steps,
        "resume_checkpoint": str(resume_checkpoint) if resume_checkpoint else None,
        "resumed_optimizer_step": resumed_optimizer_step,
        "resumed_examples": resumed_examples,
        "optimizer_state_restored": False if resume_checkpoint else None,
        "model_load_seconds": model_load_seconds,
        "elapsed_seconds": elapsed,
        "examples_per_hour": processed_this_run / elapsed * 3600,
        "tokens_per_second": tokens_seen / elapsed,
        "projected_100k_hours": 100_000 / (processed_this_run / elapsed * 3600),
        "first_step_loss": step_losses[0],
        "final_step_loss": step_losses[-1],
        "minimum_step_loss": min(step_losses),
        "peak_allocated_gib": peak_allocated_gib,
        "peak_reserved_gib": peak_reserved_gib,
    }
    (output / "run-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary
