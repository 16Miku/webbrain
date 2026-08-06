from __future__ import annotations

import argparse
import json
import sys

from .vision_encoding import MoonViTImageEncoder


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deepseek-vision-moonvit-worker")
    parser.add_argument("model_config")
    parser.add_argument("--device", default="cuda:0")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    encoder = MoonViTImageEncoder(model_config_path=args.model_config, device=args.device)
    print(json.dumps({"status": "ready"}), flush=True)
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            features = encoder.encode(
                request["image"],
                request["output"],
                int(request.get("max_image_tokens", 512)),
            )
            response = {
                "id": request_id,
                "status": "ok",
                "image_tokens": int(features.shape[0]),
            }
        except Exception as exc:  # Keep the worker alive after a malformed image.
            response = {
                "id": request_id,
                "status": "error",
                "error": f"{type(exc).__name__}: {exc}",
            }
        print(json.dumps(response), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
