from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .config import load_project_config
from .inference import resolve_project_path


def fit_image_to_token_budget(image_processor: Any, image: Any, max_image_tokens: int) -> int:
    if max_image_tokens < 1:
        raise ValueError("max_image_tokens must be positive")
    merge_size = int(image_processor.media_proc_cfg["merge_kernel_size"])
    media = {"type": "image", "image": image}
    lower = 1
    upper = max_image_tokens * merge_size**2
    best: tuple[int, int] | None = None
    while lower <= upper:
        patch_limit = (lower + upper) // 2
        image_processor.media_proc_cfg["in_patch_limit"] = patch_limit
        output_tokens = int(image_processor.get_resize_config(media)["num_tokens"])
        if output_tokens <= max_image_tokens:
            best = (patch_limit, output_tokens)
            lower = patch_limit + 1
        else:
            upper = patch_limit - 1
    if best is None:
        raise RuntimeError(f"could not fit image into {max_image_tokens} MoonViT tokens")
    image_processor.media_proc_cfg["in_patch_limit"] = best[0]
    return best[1]


class MoonViTImageEncoder:
    def __init__(self, *, model_config_path: str | Path, device: str = "cuda:0") -> None:
        try:
            import torch
            from transformers import AutoProcessor
        except ImportError as exc:  # pragma: no cover - exercised on the GPU host
            raise RuntimeError("MoonViT encoding requires the moonvit environment") from exc
        from .towers import load_moonvit

        self.torch = torch
        self.config_path = Path(model_config_path).resolve()
        self.config = load_project_config(self.config_path)
        if self.config.tower.kind != "moonvit":
            raise ValueError("encode-image currently supports only MoonViT")
        if not self.config.tower.component_path:
            raise ValueError("tower.component_path is required")
        self.device = device
        self.processor = AutoProcessor.from_pretrained(
            self.config.tower.model_id,
            revision=self.config.tower.revision,
            trust_remote_code=True,
        )
        self.tower = load_moonvit(
            self.config.tower.model_id,
            self.config.tower.revision,
            resolve_project_path(self.config_path, self.config.tower.component_path),
        ).to(device=device, dtype=torch.bfloat16)

    def encode(self, image_path: str | Path, output_path: str | Path, max_image_tokens: int):
        from PIL import Image

        torch = self.torch
        with Image.open(image_path) as source:
            image = source.convert("RGB")
        expected_tokens = fit_image_to_token_budget(
            self.processor.image_processor, image, max_image_tokens
        )
        batch = self.processor.image_processor(
            [{"type": "image", "image": image}], return_tensors="pt"
        )
        inputs = {
            key: value.to(self.device, dtype=torch.bfloat16)
            if value.is_floating_point()
            else value.to(self.device)
            for key, value in batch.items()
        }
        with torch.inference_mode():
            result = self.tower(**inputs)
        if not isinstance(result, list) or len(result) != 1:
            raise RuntimeError("MoonViT did not return one feature group")
        features = result[0].detach().to(device="cpu", dtype=torch.bfloat16)
        expected_tail = (self.config.tower.merge_size**2, self.config.tower.hidden_size)
        if features.ndim != 3 or tuple(features.shape[1:]) != expected_tail:
            raise RuntimeError(f"unexpected MoonViT feature shape {tuple(features.shape)}")
        if features.shape[0] != expected_tokens:
            raise RuntimeError(
                f"expected {expected_tokens} MoonViT tokens, got {features.shape[0]}"
            )
        if not torch.isfinite(features).all():
            raise RuntimeError("MoonViT produced non-finite features")

        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_name(f".{output.name}.{os.getpid()}.partial")
        torch.save({"vision_features": features}, temporary)
        temporary.replace(output)
        return features


def encode_image(
    *,
    model_config_path: str | Path,
    image_path: str | Path,
    output_path: str | Path,
    device: str = "cuda:0",
    max_image_tokens: int = 512,
):
    encoder = MoonViTImageEncoder(model_config_path=model_config_path, device=device)
    return encoder.encode(image_path, output_path, max_image_tokens)
