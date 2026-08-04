#!/usr/bin/env python3
"""Send one local image to the DeepSeek Vision OpenAI-compatible endpoint."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import urllib.error
import urllib.request
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--prompt", default="Describe this image in one short sentence.")
    parser.add_argument("--url", default="http://127.0.0.1:8000/v1/chat/completions")
    parser.add_argument("--model", default="deepseek-v4-flash-moonvit-pilot")
    parser.add_argument("--max-tokens", type=int, default=64)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--cache-mode", choices=("kv", "recompute"), default="kv")
    parser.add_argument("--return-token-ids", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    image_path = Path(args.image)
    if not image_path.is_file():
        raise ValueError(f"image does not exist: {image_path}")
    media_type = mimetypes.guess_type(image_path.name)[0]
    if media_type not in {"image/jpeg", "image/png", "image/webp", "image/gif"}:
        raise ValueError("image must be JPEG, PNG, WebP, or GIF")
    image_data = base64.b64encode(image_path.read_bytes()).decode("ascii")
    payload = {
        "model": args.model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": args.prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{media_type};base64,{image_data}",
                        },
                    },
                ],
            }
        ],
        "max_tokens": args.max_tokens,
        "temperature": args.temperature,
        "deepseek_vision": {
            "cache_mode": args.cache_mode,
            "return_token_ids": args.return_token_ids,
        },
    }
    request = urllib.request.Request(
        args.url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"API returned HTTP {exc.code}: {body}") from exc
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
