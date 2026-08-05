import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sglang_ext"))

from deepseek_vision_sglang.routing import build_sglang_routing_ids


class CloneableIds(list):
    def clone(self):
        return type(self)(self)


class SGLangRoutingTests(unittest.TestCase):
    def test_decode_clones_ids_when_mm_inputs_outlive_extend_metadata(self):
        input_ids = CloneableIds([31, 32])
        batch = SimpleNamespace(
            forward_mode=SimpleNamespace(is_extend=lambda: False),
            mm_inputs=[
                SimpleNamespace(
                    mm_items=[SimpleNamespace(modality="IMAGE", offsets=[(1, 2)])]
                )
            ],
        )

        routed = build_sglang_routing_ids(input_ids, batch, [7, 8])

        self.assertEqual(routed, [31, 32])
        self.assertIsNot(routed, input_ids)


if __name__ == "__main__":
    unittest.main()
