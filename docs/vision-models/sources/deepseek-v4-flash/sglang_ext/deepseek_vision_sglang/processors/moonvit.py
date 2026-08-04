from __future__ import annotations

import inspect
import re
from typing import Dict, List, Union

from transformers import AutoProcessor

from sglang.srt.managers.schedule_batch import MultimodalProcessorOutput
from sglang.srt.multimodal.processors.base_processor import (
    BaseMultimodalProcessor,
    MultimodalSpecialTokens,
)
from sglang.srt.multimodal.processors.kimi_common import KimiGridMMDataMixin
from sglang.srt.multimodal.processors.kimi_k25 import KimiGPUProcessorWrapper

from deepseek_vision_sglang.models.deepseek_v4_moonvit import DeepseekV4ForCausalLM


def _adapter_config(hf_config) -> dict:
    value = getattr(hf_config, "deepseek_vision", None)
    if isinstance(value, dict):
        return value
    if hasattr(value, "to_dict"):
        return value.to_dict()
    raise ValueError("config.json is missing deepseek_vision")


def _spatial_pair(value) -> tuple[int, int]:
    """Normalize Kimi processor configs across scalar and pair encodings."""
    if isinstance(value, int):
        return value, value
    if isinstance(value, (list, tuple)) and len(value) == 2:
        return int(value[0]), int(value[1])
    raise ValueError(f"expected a scalar or two-element spatial size, got {value!r}")


class DeepseekV4MoonViTProcessor(KimiGridMMDataMixin, BaseMultimodalProcessor):
    models = [DeepseekV4ForCausalLM]
    prefer_tokenized_input = False
    gpu_image_decode = True
    precompute_hash_before_cpu_transfer = True
    preserve_processor_input_ids = True
    supports_mm_processor_concurrency = False

    def __init__(self, hf_config, server_args, text_processor, *args, **kwargs):
        adapter = _adapter_config(hf_config)
        text_tokenizer = getattr(text_processor, "tokenizer", text_processor)
        tower_processor = AutoProcessor.from_pretrained(
            adapter["tower_model_id"],
            revision=adapter["tower_revision"],
            trust_remote_code=True,
            use_fast=True,
        )
        tower_processor.tokenizer = text_tokenizer
        media_cfg = tower_processor.media_processor.media_proc_cfg
        image_token = adapter.get("image_placeholder", "<image>")
        image_token_id = int(adapter.get("image_placeholder_token_id", hf_config.vocab_size))
        mm_tokens = MultimodalSpecialTokens(
            image_token=image_token,
            image_token_id=image_token_id,
            image_token_regex=re.compile(re.escape(image_token)),
        ).build(tower_processor)
        max_image_tokens = int(adapter.get("max_image_tokens", 512))
        merge_h, merge_w = _spatial_pair(media_cfg["merge_kernel_size"])
        wrapper_supports_token_id = (
            "image_token_id" in inspect.signature(KimiGPUProcessorWrapper).parameters
        )
        wrapper_kwargs = dict(
            image_token=mm_tokens.image_token,
            patch_size=media_cfg["patch_size"],
            # v0.5.16's wrapper multiplies this value directly and therefore
            # requires a scalar. Newer SGLang accepts the explicit H/W pair.
            merge_kernel_size=(merge_h, merge_w)
            if wrapper_supports_token_id
            else merge_h,
            in_patch_limit=max_image_tokens * int(merge_h) * int(merge_w),
            patch_limit_on_one_side=media_cfg["patch_limit_on_one_side"],
            fixed_output_tokens=media_cfg.get("fixed_output_tokens"),
            image_mean=media_cfg["image_mean"],
            image_std=media_cfg["image_std"],
        )
        # image_token_id was added to KimiGPUProcessorWrapper after the
        # v0.5.16 release container.  Supply it when supported, but retain the
        # older constructor used by the immutable HF Endpoint image.
        if wrapper_supports_token_id:
            wrapper_kwargs["image_token_id"] = mm_tokens.image_token_id
        processor = KimiGPUProcessorWrapper(tower_processor, **wrapper_kwargs)
        super().__init__(hf_config, server_args, processor, *args, **kwargs)
        self.mm_tokens = mm_tokens

    def _encode_prompt(self, prompt: str, image_count: int) -> list[int]:
        if not isinstance(prompt, str):
            raise ValueError("MoonViT SGLang processor requires a string prompt")
        parts = prompt.split(self.mm_tokens.image_token)
        if len(parts) - 1 != image_count:
            raise ValueError(
                f"prompt contains {len(parts) - 1} image placeholder(s), "
                f"but request contains {image_count} image(s)"
            )
        input_ids: list[int] = []
        for index, part in enumerate(parts):
            input_ids.extend(self._tokenizer.encode(part, add_special_tokens=False))
            if index < image_count:
                input_ids.append(int(self.mm_tokens.image_token_id))
        return input_ids

    async def process_mm_data_async(
        self,
        image_data: List[Union[str, bytes, Dict]],
        input_text,
        request_obj,
        *args,
        **kwargs,
    ):
        images = image_data or []
        if len(images) != 1:
            raise ValueError("DeepSeek V4 + MoonViT currently accepts exactly one image")
        input_ids = self._encode_prompt(input_text, len(images))
        base_output = await self.fast_load_mm_data(
            prompt=input_text,
            image_data=images,
            multimodal_tokens=self.mm_tokens,
            input_ids=input_ids,
        )
        combine_async = getattr(self, "process_and_combine_mm_data_async", None)
        if combine_async is not None:
            mm_items, expanded_ids, _ = await combine_async(
                base_output,
                self.mm_tokens,
                sglang_original_input_ids=input_ids,
            )
        else:
            # SGLang v0.5.16 exposes only the synchronous combiner.  Image I/O
            # and decode have already completed in fast_load_mm_data(), so this
            # fallback does not reintroduce blocking network work.
            mm_items, expanded_ids, _ = self.process_and_combine_mm_data(
                base_output,
                self.mm_tokens,
                sglang_original_input_ids=input_ids,
            )
        return MultimodalProcessorOutput(
            input_ids=expanded_ids.tolist(),
            mm_items=mm_items,
            im_token_id=self.mm_tokens.image_token_id,
        )


__all__ = ["DeepseekV4MoonViTProcessor"]
