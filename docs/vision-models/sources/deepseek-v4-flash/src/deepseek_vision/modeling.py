from __future__ import annotations

from typing import Any


def install_routing_aware_core(language_model: Any) -> Any:
    """Promote a loaded DeepSeek V4 core to the routing-aware subclass in place."""
    try:
        from transformers.models.deepseek_v4.modeling_deepseek_v4 import (
            DeepseekV4Model,
            DeepseekV4RMSNorm,
        )
    except ImportError as exc:  # pragma: no cover - requires remote training environment
        raise RuntimeError("A Transformers build containing DeepSeek V4 is required") from exc
    core = language_model.model
    if not isinstance(core, DeepseekV4Model):
        raise TypeError(f"expected DeepseekV4Model, got {type(core).__name__}")
    if not isinstance(core, RoutingAwareDeepseekV4Model):
        core.__class__ = RoutingAwareDeepseekV4Model
    for module in core.modules():
        if isinstance(module, DeepseekV4RMSNorm) and not getattr(
            module, "_deepseek_vision_dtype_hook", False
        ):
            module.register_forward_hook(_preserve_rmsnorm_input_dtype)
            module._deepseek_vision_dtype_hook = True
    return language_model


def _preserve_rmsnorm_input_dtype(_module: Any, inputs: tuple[Any, ...], output: Any) -> Any:
    """Keep strict-FP32 norm weights from promoting BF16 activations to FP32.

    The pinned Transformers V4 implementation intentionally retains RMSNorm weights in
    FP32, but multiplies them after casting the normalized activations back to their input
    dtype. PyTorch promotes that product to FP32. The next BF16 projection then fails its
    dtype check. Preserve the stable FP32 norm math while restoring the activation dtype
    at the module boundary.
    """
    if not inputs or not hasattr(inputs[0], "dtype") or not hasattr(output, "to"):
        return output
    return output.to(inputs[0].dtype)


try:
    import torch
    from torch import nn
    from transformers.cache_utils import DynamicCache
    from transformers.models.deepseek_v4.modeling_deepseek_v4 import (
        DeepseekV4Model,
        MoeModelOutputWithPast,
        create_sliding_window_causal_mask,
    )
except ImportError:  # Keep lightweight CLI commands importable without the training stack.
    torch = None
    nn = None
    DeepseekV4Model = object


if torch is not None:

    class RoutingAwareDeepseekV4Model(DeepseekV4Model):
        """DeepSeek V4 core with embeddings and hash-router IDs as separate inputs.

        This deliberately mirrors the upstream top-level forward. The only semantic
        change is that `routing_ids` reach each decoder layer while `inputs_embeds`
        carry the mixed text/image representation.
        """

        def forward(
            self,
            input_ids=None,
            attention_mask=None,
            position_ids=None,
            past_key_values=None,
            inputs_embeds=None,
            use_cache=None,
            routing_ids=None,
            **kwargs,
        ):
            if input_ids is None and inputs_embeds is None:
                raise ValueError("input_ids or inputs_embeds is required")
            if routing_ids is None:
                routing_ids = input_ids
            if routing_ids is None:
                raise ValueError("routing_ids is required when only inputs_embeds is supplied")
            if inputs_embeds is None:
                inputs_embeds = self.embed_tokens(input_ids)
            if routing_ids.shape != inputs_embeds.shape[:2]:
                raise ValueError("routing_ids shape must match the first two embedding dimensions")
            if use_cache and past_key_values is None:
                past_key_values = DynamicCache(config=self.config)
            if position_ids is None:
                past_seen = past_key_values.get_seq_length() if past_key_values is not None else 0
                position_ids = (
                    torch.arange(inputs_embeds.shape[1], device=inputs_embeds.device) + past_seen
                )
                position_ids = position_ids.unsqueeze(0)
            if isinstance(attention_mask, dict):
                causal_mask = next(iter(attention_mask.values()))
            else:
                causal_mask = create_sliding_window_causal_mask(
                    config=self.config,
                    inputs_embeds=inputs_embeds,
                    attention_mask=attention_mask,
                    past_key_values=past_key_values,
                    position_ids=position_ids,
                )
            hidden_states = (
                inputs_embeds.unsqueeze(2).expand(-1, -1, self.config.hc_mult, -1).contiguous()
            )
            position_embeddings = {
                "main": self.rotary_emb(
                    inputs_embeds, position_ids=position_ids, layer_type="main"
                ),
                "compress": self.rotary_emb(
                    inputs_embeds, position_ids=position_ids, layer_type="compress"
                ),
            }
            for layer in self.layers:
                hidden_states = layer(
                    hidden_states,
                    position_embeddings=position_embeddings,
                    position_ids=position_ids,
                    attention_mask=causal_mask,
                    input_ids=routing_ids,
                    past_key_values=past_key_values,
                    **kwargs,
                )
            hidden_states = self.norm(self.hc_head(hidden_states))
            return MoeModelOutputWithPast(
                last_hidden_state=hidden_states,
                past_key_values=past_key_values,
            )

    class DeepSeekVisionForProjectorTraining(nn.Module):
        """Frozen tower + trainable projector + frozen routing-aware DeepSeek."""

        def __init__(self, vision_tower, projector, language_model, route_palette) -> None:
            super().__init__()
            from .routing import build_routing_ids

            self._build_routing_ids = build_routing_ids
            self.vision_tower = vision_tower
            self.projector = projector
            self.language_model = install_routing_aware_core(language_model)
            self.route_palette = tuple(int(value) for value in route_palette)
            if self.vision_tower is not None:
                self.vision_tower.requires_grad_(False).eval()
            self.language_model.requires_grad_(False).eval()

        def train(self, mode: bool = True):
            super().train(mode)
            if self.vision_tower is not None:
                self.vision_tower.eval()
            self.language_model.eval()
            self.projector.train(mode)
            return self

        def forward(
            self,
            *,
            input_ids,
            image_mask,
            vision_features,
            attention_mask=None,
            labels=None,
        ):
            text_embeddings = self.language_model.get_input_embeddings()(input_ids)
            projected = self.projector(vision_features)
            if isinstance(projected, (list, tuple)):
                projected = torch.cat(projected, dim=0)
            if int(image_mask.sum().item()) != projected.shape[0]:
                raise ValueError("image-mask slots and projected patch count differ")
            mixed = text_embeddings.clone()
            mixed[image_mask.bool()] = projected.to(mixed.dtype)
            routing_ids = self._build_routing_ids(
                input_ids,
                image_mask,
                self.route_palette,
                vocab_size=self.language_model.config.vocab_size,
            )
            return self.language_model(
                input_ids=routing_ids,
                inputs_embeds=mixed,
                attention_mask=attention_mask,
                labels=labels,
                use_cache=False,
            )

else:

    class RoutingAwareDeepseekV4Model:  # pragma: no cover
        pass

    class DeepSeekVisionForProjectorTraining:  # pragma: no cover
        def __init__(self, *_: Any, **__: Any) -> None:
            raise RuntimeError("model training requires the 'train' dependency group")
