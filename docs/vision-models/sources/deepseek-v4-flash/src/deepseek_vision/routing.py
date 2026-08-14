from __future__ import annotations

import random
from collections import Counter
from collections.abc import Sequence
from typing import Any


def build_routing_ids(
    input_ids: Any,
    image_mask: Any,
    palette: Sequence[int],
    *,
    vocab_size: int = 129_280,
) -> Any:
    """Preserve every text token ID; fill image positions from a stable route palette.

    Supports Python lists for tests and torch tensors during training. Palette cycling
    restarts for each batch row, making routes independent of padding/batch packing.
    """
    if not palette:
        raise ValueError("routing palette cannot be empty")
    if min(palette) < 0 or max(palette) >= vocab_size:
        raise ValueError("routing palette contains an ID outside the DeepSeek vocabulary")

    try:
        import torch
    except ImportError:
        torch = None

    if torch is not None and isinstance(input_ids, torch.Tensor):
        if input_ids.shape != image_mask.shape:
            raise ValueError("input_ids and image_mask shapes differ")
        result = input_ids.clone()
        mask = image_mask.bool()
        rows = result.reshape(-1, result.shape[-1])
        masks = mask.reshape(-1, mask.shape[-1])
        palette_tensor = torch.as_tensor(palette, device=result.device, dtype=result.dtype)
        for row, row_mask in zip(rows, masks, strict=True):
            count = int(row_mask.sum().item())
            if count:
                row[row_mask] = palette_tensor[
                    torch.arange(count, device=result.device) % len(palette)
                ]
        return result

    if len(input_ids) != len(image_mask):
        raise ValueError("input_ids and image_mask lengths differ")
    if input_ids and isinstance(input_ids[0], list):
        return [
            build_routing_ids(ids, mask, palette, vocab_size=vocab_size)
            for ids, mask in zip(input_ids, image_mask, strict=True)
        ]
    result = list(input_ids)
    image_index = 0
    for index, is_image in enumerate(image_mask):
        if is_image:
            result[index] = palette[image_index % len(palette)]
            image_index += 1
    return result


def greedy_routing_palette(
    routes: Sequence[Sequence[int]],
    size: int = 64,
    *,
    max_candidates: int = 8192,
    seed: int = 20260802,
) -> list[int]:
    """Choose token IDs whose hash routes spread image patches across experts.

    `routes[token_id]` is one row of DeepSeek's tid2eid table. The greedy score
    minimizes the most-used expert first, then total squared load.
    """
    if size < 1:
        raise ValueError("palette size must be positive")
    if not routes:
        raise ValueError("route table is empty")
    selected: list[int] = []
    loads: Counter[int] = Counter()
    if len(routes) <= max_candidates:
        candidates = set(range(len(routes)))
    else:
        rng = random.Random(seed)
        anchors = set(range(min(256, len(routes))))
        candidates = anchors | set(rng.sample(range(len(routes)), max_candidates - len(anchors)))
    squared_load = 0
    max_load = 0
    for _ in range(min(size, len(candidates))):

        def score(
            token_id: int,
            current_max: int = max_load,
            current_squared: int = squared_load,
        ) -> tuple[int, int, int]:
            increments = Counter(routes[token_id])
            proposed_max = max(
                current_max,
                max((loads[expert] + count for expert, count in increments.items()), default=0),
            )
            proposed_squared = current_squared + sum(
                (loads[expert] + count) ** 2 - loads[expert] ** 2
                for expert, count in increments.items()
            )
            return proposed_max, proposed_squared, token_id

        best = min(candidates, key=score)
        selected.append(best)
        increments = Counter(routes[best])
        squared_load += sum(
            (loads[expert] + count) ** 2 - loads[expert] ** 2
            for expert, count in increments.items()
        )
        loads.update(increments)
        max_load = max(loads.values())
        candidates.remove(best)
    return selected
