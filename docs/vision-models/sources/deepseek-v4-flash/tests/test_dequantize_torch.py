import unittest

try:
    import torch
except ImportError:  # pragma: no cover - local lightweight environment
    torch = None


@unittest.skipUnless(torch is not None, "requires torch")
class DequantizeTests(unittest.TestCase):
    def test_block_scales_are_folded_into_bfloat16_weight(self):
        from deepseek_vision.dequantize import dequantize_block_weight

        weight = torch.ones((3, 5), dtype=torch.float8_e4m3fn)
        scale = torch.tensor([[2.0, 4.0], [8.0, 16.0]])
        result = dequantize_block_weight(weight, scale, block_size=(2, 3))

        expected = torch.tensor(
            [
                [2, 2, 2, 4, 4],
                [2, 2, 2, 4, 4],
                [8, 8, 8, 16, 16],
            ],
            dtype=torch.bfloat16,
        )
        self.assertEqual(result.dtype, torch.bfloat16)
        self.assertTrue(torch.equal(result, expected))


if __name__ == "__main__":
    unittest.main()
