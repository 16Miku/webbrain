import io
import json
import tempfile
import unittest
from pathlib import Path

from deepseek_vision.manifest import build_manifest


class ManifestTests(unittest.TestCase):
    def test_quota_and_determinism(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("a", "b"):
                with (root / f"{name}.jsonl").open("w", encoding="utf-8") as handle:
                    for index in range(5):
                        json.dump(
                            {
                                "id": f"{name}-{index}",
                                "image": f"{name}-{index}.jpg",
                                "question": "question",
                                "answer": "answer",
                            },
                            handle,
                        )
                        handle.write("\n")
            config = {
                "seed": 7,
                "target_examples": 5,
                "sources": [
                    {"name": "a", "path": "a.jsonl", "quota": 2},
                    {"name": "b", "path": "b.jsonl", "quota": 3},
                ],
            }
            (root / "config.json").write_text(json.dumps(config), encoding="utf-8")
            first, second = io.StringIO(), io.StringIO()
            self.assertEqual(build_manifest(root / "config.json", first), 5)
            self.assertEqual(build_manifest(root / "config.json", second), 5)
            self.assertEqual(first.getvalue(), second.getvalue())


if __name__ == "__main__":
    unittest.main()
