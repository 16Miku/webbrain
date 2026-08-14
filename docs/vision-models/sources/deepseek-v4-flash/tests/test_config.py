import unittest
from pathlib import Path

from deepseek_vision.config import load_project_config

ROOT = Path(__file__).resolve().parents[1]


class ConfigTests(unittest.TestCase):
    def test_both_arms_share_adapter_geometry(self):
        moon = load_project_config(ROOT / "configs/model/moonvit.json")
        qwen = load_project_config(ROOT / "configs/model/qwen36.json")
        self.assertEqual(moon.projector, qwen.projector)
        self.assertEqual(moon.text, qwen.text)
        self.assertEqual(moon.routing, qwen.routing)


if __name__ == "__main__":
    unittest.main()
