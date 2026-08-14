import ast
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class MoonViTModelSourceTests(unittest.TestCase):
    def test_image_features_are_packed_for_sglang_embedding_cache(self):
        path = (
            ROOT
            / "sglang_ext"
            / "deepseek_vision_sglang"
            / "models"
            / "deepseek_v4_moonvit.py"
        )
        module = ast.parse(path.read_text(encoding="utf-8"))
        model = next(
            node
            for node in module.body
            if isinstance(node, ast.ClassDef) and node.name == "DeepseekV4ForCausalLM"
        )
        method = next(
            node
            for node in model.body
            if isinstance(node, ast.FunctionDef) and node.name == "get_image_feature"
        )
        returned = next(node for node in method.body if isinstance(node, ast.Return))

        self.assertEqual(ast.unparse(returned.value.func), "torch.cat")
        self.assertEqual(
            ast.unparse(returned.value.args[0]),
            "mm_projection_auto(self.mm_projector, image_features)",
        )
        self.assertEqual(
            [(keyword.arg, ast.literal_eval(keyword.value)) for keyword in returned.value.keywords],
            [("dim", 0)],
        )


if __name__ == "__main__":
    unittest.main()
