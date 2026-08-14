from __future__ import annotations

from typing import Any


def projector_parameter_count(
    vision_hidden_size: int = 1152,
    text_hidden_size: int = 4096,
    merge_size: int = 2,
) -> int:
    """Count trainable LayerNorm + two biased linear layers."""
    merged = vision_hidden_size * merge_size * merge_size
    layer_norm = 2 * vision_hidden_size
    first_linear = merged * merged + merged
    second_linear = merged * text_hidden_size + text_hidden_size
    return layer_norm + first_linear + second_linear


try:
    import torch
    from torch import nn
except ImportError:  # Keep manifest/config tools usable on the Mac without PyTorch.
    torch = None
    nn = None


if nn is not None:

    class PatchMergerProjector(nn.Module):
        """MoonViT/Qwen 2x2 patch merger projected into DeepSeek's 4096-d space."""

        def __init__(
            self,
            vision_hidden_size: int = 1152,
            text_hidden_size: int = 4096,
            merge_size: int = 2,
            layer_norm_eps: float = 1e-5,
        ) -> None:
            super().__init__()
            self.vision_hidden_size = vision_hidden_size
            self.merge_size = merge_size
            self.merged_hidden_size = vision_hidden_size * merge_size * merge_size
            self.pre_norm = nn.LayerNorm(vision_hidden_size, eps=layer_norm_eps)
            self.proj = nn.Sequential(
                nn.Linear(self.merged_hidden_size, self.merged_hidden_size),
                nn.GELU(),
                nn.Linear(self.merged_hidden_size, text_hidden_size),
            )

        def forward(self, features: Any) -> Any:
            if isinstance(features, (list, tuple)):
                return [self._merge(item) for item in features]
            return self._merge(features)

        def _merge(self, features: Any) -> Any:
            if features.shape[-1] != self.vision_hidden_size:
                raise ValueError(
                    f"expected final dimension {self.vision_hidden_size}, got {features.shape[-1]}"
                )
            merge_unit = self.merge_size * self.merge_size
            if features.ndim == 2:
                if features.shape[0] % merge_unit:
                    raise ValueError("flat patch count must be divisible by merge_size squared")
                features = features.reshape(-1, merge_unit, self.vision_hidden_size)
            elif features.ndim != 3 or features.shape[-2] != merge_unit:
                raise ValueError("features must be [patches,C] or [merged_tokens,merge_unit,C]")
            normalized = self.pre_norm(features)
            return self.proj(normalized.reshape(normalized.shape[0], self.merged_hidden_size))

else:

    class PatchMergerProjector:  # pragma: no cover - explanatory fallback
        def __init__(self, *_: Any, **__: Any) -> None:
            raise RuntimeError("PatchMergerProjector requires the 'train' dependency group")
