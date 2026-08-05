import tempfile
import unittest
from pathlib import Path

from deepseek_vision.serving.patch_sglang import NEW, OLD, patch_deepseek_v4_source


class SGLangPatchTests(unittest.TestCase):
    def test_patch_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "deepseek_v4.py"
            source.write_text(f"before\n{OLD}\nafter\n", encoding="utf-8")
            self.assertTrue(patch_deepseek_v4_source(source))
            self.assertFalse(patch_deepseek_v4_source(source))
            self.assertIn(NEW, source.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
