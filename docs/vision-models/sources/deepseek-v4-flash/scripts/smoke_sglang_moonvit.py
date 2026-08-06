#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import urllib.request
from pathlib import Path


DEFAULT_PROMPT = (
    "<｜begin▁of▁sentence｜><｜User｜><image>"
    "Describe this image.<｜Assistant｜></think>"
)


def image_data_url(path: Path) -> str:
    mime_type, _ = mimetypes.guess_type(path.name)
    if mime_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise ValueError("smoke image must be JPEG, PNG, or WebP")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def build_payload(path: Path, prompt: str, max_new_tokens: int) -> dict:
    if prompt.count("<image>") != 1:
        raise ValueError("prompt must contain exactly one literal <image> marker")
    return {
        "text": prompt,
        "image_data": image_data_url(path),
        "sampling_params": {
            "temperature": 0,
            "max_new_tokens": int(max_new_tokens),
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Smoke-test the custom SGLang /generate path")
    parser.add_argument("image", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:30000/generate")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--max-new-tokens", type=int, default=64)
    parser.add_argument("--timeout", type=float, default=180.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    payload = build_payload(args.image.resolve(), args.prompt, args.max_new_tokens)
    request = urllib.request.Request(
        args.url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=args.timeout) as response:
        result = json.loads(response.read().decode("utf-8"))
    generated = result.get("text")
    if not isinstance(generated, str) or not generated.strip():
        raise RuntimeError(f"SGLang returned no generated text: {result}")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
