import inspect
import unittest

from deepseek_vision.towers import load_moonvit


class TowerLoaderTests(unittest.TestCase):
    def test_moonvit_uses_supported_attention_backend_by_default(self):
        default = inspect.signature(load_moonvit).parameters["attn_implementation"].default
        self.assertEqual(default, "flash_attention_2")


if __name__ == "__main__":
    unittest.main()
