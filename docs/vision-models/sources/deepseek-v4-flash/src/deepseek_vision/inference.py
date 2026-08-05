from __future__ import annotations

import json
import math
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import load_project_config

BOS = "<｜begin▁of▁sentence｜>"
USER = "<｜User｜>"
ASSISTANT = "<｜Assistant｜>"
EOS = "<｜end▁of▁sentence｜>"


def project_root(config_path: str | Path) -> Path:
    return Path(config_path).resolve().parents[2]


def resolve_project_path(config_path: str | Path, value: str | Path) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return project_root(config_path) / path


def resolve_model_reference(config_path: str | Path, value: str) -> str:
    """Resolve checked-in local model paths without rewriting Hugging Face model IDs."""
    path = Path(value)
    if path.is_absolute():
        return str(path)
    candidate = project_root(config_path) / path
    return str(candidate) if candidate.exists() else value


def token_id(tokenizer: Any, token: str) -> int:
    encoded = tokenizer.encode(token, add_special_tokens=False)
    if len(encoded) != 1:
        raise RuntimeError(f"expected one token for {token!r}, got {encoded}")
    return int(encoded[0])


@dataclass(frozen=True)
class VisionPrompt:
    input_ids: list[int]
    image_mask: list[bool]
    eos_token_ids: tuple[int, ...]


def build_vision_prompt(
    *,
    tokenizer: Any,
    question: str,
    image_tokens: int,
    max_sequence_length: int,
    max_new_tokens: int,
) -> VisionPrompt:
    """Build the exact prefix used to train the projector, without answer tokens."""
    if not question.strip():
        raise ValueError("prompt cannot be empty")
    if image_tokens < 1:
        raise ValueError("image_tokens must be positive")
    if max_new_tokens < 1:
        raise ValueError("max_new_tokens must be positive")

    prefix = [token_id(tokenizer, BOS), token_id(tokenizer, USER)]
    assistant_prefix = [
        token_id(tokenizer, ASSISTANT),
        *tokenizer.encode("</think>", add_special_tokens=False),
    ]
    fixed_prompt_tokens = len(prefix) + image_tokens + len(assistant_prefix)
    question_budget = max_sequence_length - max_new_tokens - fixed_prompt_tokens
    if question_budget < 1:
        raise ValueError(
            "image and reserved response tokens leave no prompt capacity; "
            "lower max_image_tokens or max_new_tokens"
        )
    question_ids = tokenizer.encode(question.strip(), add_special_tokens=False)[:question_budget]
    input_ids = [*prefix, *([0] * image_tokens), *question_ids, *assistant_prefix]
    image_mask = [False] * len(input_ids)
    image_mask[len(prefix) : len(prefix) + image_tokens] = [True] * image_tokens

    eos_ids = {token_id(tokenizer, EOS)}
    tokenizer_eos = getattr(tokenizer, "eos_token_id", None)
    if tokenizer_eos is not None:
        eos_ids.add(int(tokenizer_eos))
    return VisionPrompt(input_ids, image_mask, tuple(sorted(eos_ids)))


def _require_inference_stack():
    try:
        import torch
        from safetensors.torch import load_file
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError as exc:  # pragma: no cover - exercised on the GPU host
        raise RuntimeError("inference requires: pip install -e '.[train]'") from exc
    return torch, load_file, AutoModelForCausalLM, AutoTokenizer


def _sample_token(torch, logits, *, temperature: float, top_p: float, generator):
    if temperature <= 0:
        return logits.argmax(dim=-1)
    probabilities = torch.softmax(logits.float() / temperature, dim=-1)
    if top_p < 1:
        sorted_probabilities, sorted_indices = torch.sort(
            probabilities, descending=True, dim=-1
        )
        cumulative = torch.cumsum(sorted_probabilities, dim=-1)
        remove = cumulative - sorted_probabilities > top_p
        sorted_probabilities = sorted_probabilities.masked_fill(remove, 0)
        sorted_probabilities /= sorted_probabilities.sum(dim=-1, keepdim=True)
        sampled = torch.multinomial(sorted_probabilities, num_samples=1, generator=generator)
        return sorted_indices.gather(-1, sampled).squeeze(-1)
    return torch.multinomial(probabilities, num_samples=1, generator=generator).squeeze(-1)


class DeepSeekVisionInference:
    """One loaded DeepSeek backbone plus the trained MoonViT projector."""

    def __init__(
        self,
        *,
        model_config_path: str | Path,
        projector_checkpoint: str | Path,
        max_memory_per_gpu: str | None = None,
    ) -> None:
        torch, load_file, AutoModelForCausalLM, AutoTokenizer = _require_inference_stack()
        from .modeling import install_routing_aware_core
        from .projector import PatchMergerProjector

        self.torch = torch
        self.config_path = Path(model_config_path).resolve()
        self.config = load_project_config(self.config_path)
        self.model_reference = resolve_model_reference(
            self.config_path, self.config.text.model_id
        )
        palette_path = resolve_project_path(
            self.config_path, self.config.routing.palette_path
        )
        self.palette = tuple(json.loads(palette_path.read_text(encoding="utf-8")))
        if len(self.palette) != self.config.routing.palette_size:
            raise RuntimeError("routing palette length differs from model config")

        max_memory = None
        if max_memory_per_gpu:
            if not torch.cuda.is_available():
                raise RuntimeError("max_memory_per_gpu requires CUDA")
            max_memory = {
                index: max_memory_per_gpu for index in range(torch.cuda.device_count())
            }
        self.tokenizer = AutoTokenizer.from_pretrained(
            self.model_reference,
            trust_remote_code=True,
        )
        self.language_model = AutoModelForCausalLM.from_pretrained(
            self.model_reference,
            device_map="balanced",
            dtype="auto",
            low_cpu_mem_usage=True,
            max_memory=max_memory,
        ).eval()
        self.language_model.config.use_cache = True
        install_routing_aware_core(self.language_model)
        self.language_model.requires_grad_(False)

        self.embedding_device = self.language_model.get_input_embeddings().weight.device
        self.projector = PatchMergerProjector(
            self.config.projector.vision_hidden_size,
            self.config.projector.text_hidden_size,
            self.config.projector.merge_size,
            self.config.projector.layer_norm_eps,
        )
        checkpoint = Path(projector_checkpoint).resolve()
        if not checkpoint.is_file():
            raise ValueError(f"projector checkpoint does not exist: {checkpoint}")
        self.projector.load_state_dict(load_file(str(checkpoint), device="cpu"))
        self.projector.to(device=self.embedding_device, dtype=torch.bfloat16).eval()
        self.projector.requires_grad_(False)
        self.projector_checkpoint = checkpoint

    def load_features(self, path: str | Path):
        payload = self.torch.load(path, map_location="cpu", weights_only=True)
        if not isinstance(payload, dict) or "vision_features" not in payload:
            raise ValueError(f"{path}: missing vision_features")
        features = payload["vision_features"]
        expected_tail = (
            self.config.projector.merge_size**2,
            self.config.projector.vision_hidden_size,
        )
        if features.ndim != 3 or tuple(features.shape[1:]) != expected_tail:
            raise ValueError(
                f"{path}: expected vision features [tokens,{expected_tail[0]},"
                f"{expected_tail[1]}], got {tuple(features.shape)}"
            )
        if not self.torch.isfinite(features).all():
            raise ValueError(f"{path}: vision features contain non-finite values")
        return features

    def generate_from_feature_file(self, feature_path: str | Path, **kwargs) -> dict[str, Any]:
        return self.generate(self.load_features(feature_path), **kwargs)

    def generate(
        self,
        vision_features,
        *,
        prompt: str,
        max_new_tokens: int = 128,
        max_sequence_length: int = 2048,
        temperature: float = 0.0,
        top_p: float = 0.95,
        seed: int = 20260802,
        cache_mode: str = "kv",
    ) -> dict[str, Any]:
        if not 0 <= top_p <= 1:
            raise ValueError("top_p must be in [0, 1]")
        if temperature < 0:
            raise ValueError("temperature cannot be negative")
        if cache_mode not in {"kv", "recompute"}:
            raise ValueError("cache_mode must be 'kv' or 'recompute'")
        torch = self.torch
        vision_features = vision_features.to(
            device=self.embedding_device, dtype=torch.bfloat16
        )
        prompt_data = build_vision_prompt(
            tokenizer=self.tokenizer,
            question=prompt,
            image_tokens=int(vision_features.shape[0]),
            max_sequence_length=max_sequence_length,
            max_new_tokens=max_new_tokens,
        )
        input_ids = torch.tensor(
            [prompt_data.input_ids], dtype=torch.long, device=self.embedding_device
        )
        image_mask = torch.tensor(
            [prompt_data.image_mask], dtype=torch.bool, device=self.embedding_device
        )
        attention_mask = torch.ones_like(input_ids)

        from .routing import build_routing_ids

        started = time.monotonic()
        generated: list[int] = []
        with torch.inference_mode():
            projected = self.projector(vision_features)
            if int(image_mask.sum().item()) != projected.shape[0]:
                raise ValueError("image-mask slots and projected patch count differ")

            def forward_full(current_ids, current_image_mask, *, use_cache: bool):
                text_embeddings = self.language_model.get_input_embeddings()(current_ids)
                mixed = text_embeddings.clone()
                mixed[current_image_mask] = projected.to(mixed.dtype)
                routing_ids = build_routing_ids(
                    current_ids,
                    current_image_mask,
                    self.palette,
                    vocab_size=self.language_model.config.vocab_size,
                )
                return self.language_model(
                    input_ids=routing_ids,
                    inputs_embeds=mixed,
                    attention_mask=torch.ones_like(current_ids),
                    use_cache=use_cache,
                    logits_to_keep=1,
                    return_dict=True,
                )

            result = forward_full(
                input_ids,
                image_mask,
                use_cache=cache_mode == "kv",
            )
            full_input_ids = input_ids
            full_image_mask = image_mask
            generator = torch.Generator(device=result.logits.device)
            generator.manual_seed(seed)
            for _ in range(max_new_tokens):
                next_token = _sample_token(
                    torch,
                    result.logits[:, -1, :],
                    temperature=temperature,
                    top_p=top_p,
                    generator=generator,
                )
                token_id_value = int(next_token.item())
                if token_id_value in prompt_data.eos_token_ids:
                    break
                generated.append(token_id_value)
                next_input = next_token.to(self.embedding_device).reshape(1, 1)
                if cache_mode == "kv":
                    attention_mask = torch.cat(
                        [
                            attention_mask,
                            torch.ones(
                                (1, 1),
                                dtype=attention_mask.dtype,
                                device=self.embedding_device,
                            ),
                        ],
                        dim=1,
                    )
                    result = self.language_model(
                        input_ids=next_input,
                        attention_mask=attention_mask,
                        past_key_values=result.past_key_values,
                        use_cache=True,
                        logits_to_keep=1,
                        return_dict=True,
                    )
                else:
                    full_input_ids = torch.cat([full_input_ids, next_input], dim=1)
                    full_image_mask = torch.cat(
                        [
                            full_image_mask,
                            torch.zeros(
                                (1, 1),
                                dtype=full_image_mask.dtype,
                                device=self.embedding_device,
                            ),
                        ],
                        dim=1,
                    )
                    result = forward_full(
                        full_input_ids,
                        full_image_mask,
                        use_cache=False,
                    )
        elapsed = time.monotonic() - started
        text = self.tokenizer.decode(generated, skip_special_tokens=True).strip()
        return {
            "text": text,
            "prompt_tokens": len(prompt_data.input_ids),
            "completion_tokens": len(generated),
            "elapsed_seconds": elapsed,
            "tokens_per_second": len(generated) / elapsed if elapsed else math.inf,
            "cache_mode": cache_mode,
            "token_ids": generated,
        }


def encode_image_subprocess(
    *,
    moonvit_python: str | Path,
    model_config_path: str | Path,
    image_path: str | Path,
    output_path: str | Path,
    device: str,
    max_image_tokens: int,
) -> None:
    command = [
        str(moonvit_python),
        "-m",
        "deepseek_vision.cli",
        "encode-image",
        str(model_config_path),
        str(image_path),
        str(output_path),
        "--device",
        device,
        "--max-image-tokens",
        str(max_image_tokens),
    ]
    subprocess.run(command, check=True)
