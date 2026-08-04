from __future__ import annotations

from pathlib import Path
from typing import Any


def _load_state(path: str | Path) -> dict[str, Any]:
    try:
        from safetensors.torch import load_file
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("tower loading requires the 'train' dependency group") from exc
    return load_file(str(path), device="cpu")


def load_moonvit(
    model_id: str,
    revision: str,
    component_path: str | Path,
    *,
    attn_implementation: str = "flash_attention_2",
):
    """Instantiate official Kimi K2.6 MoonViT without instantiating the 1T LLM.

    Kimi's pinned remote implementation dispatches through its own vision-attention
    registry.  At this revision that registry implements FlashAttention 2, but not
    Transformers' generic ``sdpa`` backend.
    """
    from transformers import AutoConfig
    from transformers.dynamic_module_utils import get_class_from_dynamic_module

    config = AutoConfig.from_pretrained(model_id, revision=revision, trust_remote_code=True)
    config.vision_config._attn_implementation = attn_implementation
    tower_config_class = get_class_from_dynamic_module(
        "modeling_kimi_k25.VisionTowerConfig", model_id, revision=revision
    )
    tower_class = get_class_from_dynamic_module(
        "modeling_kimi_k25.MoonViT3dPretrainedModel", model_id, revision=revision
    )
    tower = tower_class(tower_config_class(config.vision_config))
    missing, unexpected = tower.load_state_dict(_load_state(component_path), strict=False)
    if missing or unexpected:
        raise RuntimeError(f"MoonViT state mismatch: missing={missing}, unexpected={unexpected}")
    return tower.eval()


def load_qwen36_tower(model_id: str, revision: str, component_path: str | Path):
    """Load Qwen3.6's 1152-d tower; use last_hidden_state before its native merger."""
    from transformers import AutoConfig
    from transformers.models.qwen3_5.modeling_qwen3_5 import Qwen3_5VisionModel

    config = AutoConfig.from_pretrained(model_id, revision=revision).vision_config
    tower = Qwen3_5VisionModel(config)
    missing, unexpected = tower.load_state_dict(_load_state(component_path), strict=False)
    if missing or unexpected:
        raise RuntimeError(f"Qwen tower state mismatch: missing={missing}, unexpected={unexpected}")
    return tower.eval()


def pre_merger_features(tower_kind: str, tower_output: Any) -> Any:
    if tower_kind == "moonvit":
        return tower_output
    if tower_kind == "qwen36":
        return tower_output.last_hidden_state
    raise ValueError(f"unsupported tower kind {tower_kind!r}")
