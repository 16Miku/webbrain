import base64
import json
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from deepseek_vision.api import (
    VisionService,
    decode_image_data_url,
    extract_multimodal_message,
    make_handler,
)


class ApiPayloadTests(unittest.TestCase):
    def test_openai_multimodal_message_is_extracted(self):
        image = b"fake-png"
        encoded = base64.b64encode(image).decode()
        prompt, decoded, suffix = extract_multimodal_message(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "What is this?"},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/png;base64,{encoded}"},
                            },
                        ],
                    }
                ]
            }
        )

        self.assertEqual(prompt, "What is this?")
        self.assertEqual(decoded, image)
        self.assertEqual(suffix, ".png")

    def test_remote_image_urls_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "base64 data:image URL"):
            decode_image_data_url("https://example.com/image.png")

    def test_exactly_one_image_is_required(self):
        with self.assertRaisesRegex(ValueError, "exactly one image_url"):
            extract_multimodal_message(
                {
                    "messages": [
                        {
                            "role": "user",
                            "content": [{"type": "text", "text": "What is this?"}],
                        }
                    ]
                }
            )

    def test_http_endpoint_returns_openai_compatible_response(self):
        class FakeConfig:
            name = "test-vision-model"

        class FakeEngine:
            config = FakeConfig()

            def generate_from_feature_file(self, feature_path, **kwargs):
                self.feature_path = Path(feature_path)
                self.kwargs = kwargs
                return {
                    "text": "a test image",
                    "prompt_tokens": 10,
                    "completion_tokens": 3,
                    "elapsed_seconds": 0.25,
                    "tokens_per_second": 12.0,
                    "cache_mode": kwargs["cache_mode"],
                    "token_ids": [101, 102, 103],
                }

        class FakeEncoder:
            def encode(self, image_path, output_path, max_image_tokens):
                Path(output_path).write_bytes(b"features")
                return 2

        engine = FakeEngine()
        service = VisionService(engine=engine, encoder=FakeEncoder(), max_image_tokens=8)
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(service))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            image = base64.b64encode(b"fake-png").decode()
            payload = {
                "messages": [
                    {"role": "system", "content": "Return only a short answer."},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "What is this?"},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/png;base64,{image}"},
                            },
                        ],
                    }
                ],
                "max_tokens": 4,
                "stream": True,
                "deepseek_vision": {
                    "cache_mode": "recompute",
                    "return_token_ids": True,
                },
            }
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request) as response:
                result = json.load(response)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(result["model"], "test-vision-model")
        self.assertEqual(result["choices"][0]["message"]["content"], "a test image")
        self.assertEqual(result["usage"]["total_tokens"], 13)
        self.assertEqual(
            engine.kwargs["prompt"],
            "Return only a short answer.\n\nWhat is this?",
        )
        self.assertEqual(engine.kwargs["max_new_tokens"], 4)
        self.assertEqual(engine.kwargs["cache_mode"], "recompute")
        self.assertEqual(result["deepseek_vision"]["cache_mode"], "recompute")
        self.assertEqual(result["deepseek_vision"]["token_ids"], [101, 102, 103])


if __name__ == "__main__":
    unittest.main()
