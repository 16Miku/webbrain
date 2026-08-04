import unittest

from deepseek_vision.components import component_shards


class ComponentTests(unittest.TestCase):
    def test_selects_only_matching_shards(self):
        index = {"weight_map": {"vision.a": "one", "vision.b": "two", "text.a": "three"}}
        self.assertEqual(component_shards(index, "vision."), ["one", "two"])


if __name__ == "__main__":
    unittest.main()
