#!/usr/bin/env python3
"""Range-fetch DeepSeek tid2eid tensors and build a deterministic palette.

This transfers only the three routing tensors (about 18.6 MB), not their multi-GB shards.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from array import array
from pathlib import Path
from urllib.request import Request, urlopen

from deepseek_vision.routing import greedy_routing_palette


def read_range(url: str, start: int, end: int) -> bytes:
    request = Request(
        url,
        headers={"Range": f"bytes={start}-{end}", "Accept-Encoding": "identity"},
    )
    with urlopen(request, timeout=120) as response:
        if response.status != 206:
            raise RuntimeError(f"server ignored byte range for {url}")
        return response.read()


def fetch_tensor(url: str, key: str) -> list[list[int]]:
    header_length = struct.unpack("<Q", read_range(url, 0, 7))[0]
    header = json.loads(read_range(url, 8, 7 + header_length))
    metadata = header[key]
    if metadata["dtype"] != "I64" or len(metadata["shape"]) != 2:
        raise ValueError(f"unexpected routing tensor metadata: {metadata}")
    start, end = metadata["data_offsets"]
    raw = read_range(url, 8 + header_length + start, 8 + header_length + end - 1)
    values = array("q")
    values.frombytes(raw)
    width = metadata["shape"][1]
    return [list(values[index : index + width]) for index in range(0, len(values), width)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    parser.add_argument("--model-id", default="deepseek-ai/DeepSeek-V4-Flash")
    parser.add_argument("--revision", default="60d8d70770c6776ff598c94bb586a859a38244f1")
    parser.add_argument("--size", type=int, default=64)
    args = parser.parse_args()
    base = f"https://huggingface.co/{args.model_id}/resolve/{args.revision}/"
    with urlopen(base + "model.safetensors.index.json", timeout=60) as response:
        index = json.load(response)
    keys = sorted(name for name in index["weight_map"] if name.endswith("tid2eid"))
    if not keys:
        raise ValueError("model index has no tid2eid tensors")
    tables = [fetch_tensor(base + index["weight_map"][key], key) for key in keys]
    if len({len(table) for table in tables}) != 1:
        raise ValueError("routing tables have different vocabulary sizes")
    offsets, offset = [], 0
    for table in tables:
        offsets.append(offset)
        offset += max(max(row) for row in table) + 1
    combined = [
        [expert + offsets[layer] for layer, table in enumerate(tables) for expert in table[token]]
        for token in range(len(tables[0]))
    ]
    palette = greedy_routing_palette(combined, args.size)
    Path(args.output).write_text(json.dumps(palette, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(palette)} IDs from {len(tables)} routing layers to {args.output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2)
