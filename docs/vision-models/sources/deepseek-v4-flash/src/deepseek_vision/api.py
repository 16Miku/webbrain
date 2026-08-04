from __future__ import annotations

import base64
import binascii
import json
import subprocess
import tempfile
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .inference import DeepSeekVisionInference

MAX_REQUEST_BYTES = 24 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024


def decode_image_data_url(value: str, *, max_bytes: int = MAX_IMAGE_BYTES) -> tuple[bytes, str]:
    if not isinstance(value, str) or not value.startswith("data:image/"):
        raise ValueError("image_url must be a base64 data:image URL")
    try:
        header, encoded = value.split(",", 1)
    except ValueError as exc:
        raise ValueError("malformed image data URL") from exc
    if not header.endswith(";base64"):
        raise ValueError("image data URL must use base64 encoding")
    media_type = header[5:-7].lower()
    extensions = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }
    if media_type not in extensions:
        raise ValueError(f"unsupported image media type: {media_type}")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("image_url contains invalid base64") from exc
    if not data:
        raise ValueError("image cannot be empty")
    if len(data) > max_bytes:
        raise ValueError(f"image exceeds {max_bytes} bytes")
    return data, extensions[media_type]


def extract_multimodal_message(payload: dict[str, Any]) -> tuple[str, bytes, str]:
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages must be a non-empty list")
    if any(not isinstance(item, dict) for item in messages):
        raise ValueError("message entries must be objects")
    user_messages = [item for item in messages if item.get("role") == "user"]
    if not user_messages:
        raise ValueError("messages must contain a user message")
    system_parts: list[str] = []
    for message in messages:
        if message.get("role") != "system":
            continue
        system_content = message.get("content")
        if isinstance(system_content, str) and system_content.strip():
            system_parts.append(system_content.strip())
        elif isinstance(system_content, list):
            system_parts.extend(
                str(part.get("text", "")).strip()
                for part in system_content
                if isinstance(part, dict)
                and part.get("type") == "text"
                and str(part.get("text", "")).strip()
            )
    content = user_messages[-1].get("content")
    if not isinstance(content, list):
        raise ValueError("the last user content must be a multimodal content list")

    text_parts: list[str] = []
    image_values: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            raise ValueError("message content entries must be objects")
        if part.get("type") == "text":
            text_parts.append(str(part.get("text", "")))
        elif part.get("type") == "image_url":
            image_url = part.get("image_url")
            if isinstance(image_url, dict):
                image_url = image_url.get("url")
            if not isinstance(image_url, str):
                raise ValueError("image_url.url must be a string")
            image_values.append(image_url)
    user_prompt = "\n".join(item.strip() for item in text_parts if item.strip())
    if not user_prompt:
        raise ValueError("the last user message must contain text")
    prompt = "\n\n".join([*system_parts, user_prompt])
    if len(image_values) != 1:
        raise ValueError("exactly one image_url is required")
    image, suffix = decode_image_data_url(image_values[0])
    return prompt, image, suffix


class MoonViTWorkerClient:
    def __init__(
        self,
        *,
        python: str | Path,
        model_config: str | Path,
        device: str,
    ) -> None:
        self._lock = threading.Lock()
        self._process = subprocess.Popen(
            [
                str(python),
                "-u",
                "-m",
                "deepseek_vision.vision_worker",
                str(model_config),
                "--device",
                device,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        ready = self._read_json()
        if ready.get("status") != "ready":
            self.close()
            raise RuntimeError(f"MoonViT worker did not become ready: {ready}")

    def _read_json(self) -> dict[str, Any]:
        if self._process.stdout is None:
            raise RuntimeError("MoonViT worker stdout is unavailable")
        while True:
            line = self._process.stdout.readline()
            if not line:
                code = self._process.poll()
                raise RuntimeError(f"MoonViT worker exited unexpectedly with code {code}")
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                return value

    def encode(
        self,
        image_path: str | Path,
        output_path: str | Path,
        max_image_tokens: int,
    ) -> int:
        request_id = uuid.uuid4().hex
        request = {
            "id": request_id,
            "image": str(image_path),
            "output": str(output_path),
            "max_image_tokens": max_image_tokens,
        }
        with self._lock:
            if self._process.stdin is None:
                raise RuntimeError("MoonViT worker stdin is unavailable")
            self._process.stdin.write(json.dumps(request) + "\n")
            self._process.stdin.flush()
            response = self._read_json()
        if response.get("id") != request_id:
            raise RuntimeError("MoonViT worker response ID mismatch")
        if response.get("status") != "ok":
            raise RuntimeError(response.get("error", "MoonViT worker failed"))
        return int(response["image_tokens"])

    def close(self) -> None:
        if self._process.poll() is not None:
            return
        if self._process.stdin is not None:
            self._process.stdin.close()
        try:
            self._process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._process.terminate()
            self._process.wait(timeout=10)


class VisionService:
    def __init__(
        self,
        *,
        engine: DeepSeekVisionInference,
        encoder: MoonViTWorkerClient,
        max_image_tokens: int,
    ) -> None:
        self.engine = engine
        self.encoder = encoder
        self.max_image_tokens = max_image_tokens
        self._generation_lock = threading.Lock()

    def complete(self, payload: dict[str, Any]) -> dict[str, Any]:
        prompt, image, suffix = extract_multimodal_message(payload)
        max_tokens = int(payload.get("max_tokens", payload.get("max_completion_tokens", 128)))
        temperature = float(payload.get("temperature", 0.0))
        top_p = float(payload.get("top_p", 0.95))
        diagnostics = payload.get("deepseek_vision", {})
        if not isinstance(diagnostics, dict):
            raise ValueError("deepseek_vision must be an object")
        cache_mode = str(diagnostics.get("cache_mode", "kv"))
        return_token_ids = bool(diagnostics.get("return_token_ids", False))
        with tempfile.TemporaryDirectory(prefix="deepseek-vision-api-") as directory:
            image_path = Path(directory) / f"image{suffix}"
            feature_path = Path(directory) / "vision-features.pt"
            image_path.write_bytes(image)
            self.encoder.encode(image_path, feature_path, self.max_image_tokens)
            with self._generation_lock:
                result = self.engine.generate_from_feature_file(
                    feature_path,
                    prompt=prompt,
                    max_new_tokens=max_tokens,
                    temperature=temperature,
                    top_p=top_p,
                    cache_mode=cache_mode,
                )
        metadata = {
            "elapsed_seconds": result["elapsed_seconds"],
            "tokens_per_second": result["tokens_per_second"],
            "cache_mode": result["cache_mode"],
        }
        if return_token_ids:
            metadata["token_ids"] = result["token_ids"]
        return {
            "id": f"chatcmpl-{uuid.uuid4().hex}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": self.engine.config.name,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": result["text"]},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": result["prompt_tokens"],
                "completion_tokens": result["completion_tokens"],
                "total_tokens": result["prompt_tokens"] + result["completion_tokens"],
            },
            "deepseek_vision": metadata,
        }


def make_handler(service: VisionService):
    class Handler(BaseHTTPRequestHandler):
        server_version = "DeepSeekVision/0.1"

        def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status.value)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path != "/health":
                self._send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "not found"}})
                return
            self._send_json(
                HTTPStatus.OK,
                {"status": "ok", "model": service.engine.config.name},
            )

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path != "/v1/chat/completions":
                self._send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "not found"}})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > MAX_REQUEST_BYTES:
                    raise ValueError(f"request size must be between 1 and {MAX_REQUEST_BYTES}")
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("request body must be a JSON object")
                response = service.complete(payload)
            except (ValueError, json.JSONDecodeError) as exc:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": {"message": str(exc), "type": "invalid_request_error"}},
                )
                return
            except Exception as exc:
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": {"message": str(exc), "type": "server_error"}},
                )
                return
            self._send_json(HTTPStatus.OK, response)

        def log_message(self, format: str, *args: Any) -> None:
            print(f"api {self.address_string()} {format % args}", flush=True)

    return Handler


def serve(
    *,
    engine: DeepSeekVisionInference,
    encoder: MoonViTWorkerClient,
    host: str,
    port: int,
    max_image_tokens: int,
) -> None:
    service = VisionService(
        engine=engine,
        encoder=encoder,
        max_image_tokens=max_image_tokens,
    )
    server = ThreadingHTTPServer((host, port), make_handler(service))
    try:
        print(json.dumps({"status": "ready", "host": host, "port": port}), flush=True)
        server.serve_forever()
    finally:
        server.server_close()
        encoder.close()
