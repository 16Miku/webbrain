import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
EXTENSION_ROOT = ROOT / "sglang_ext"
sys.path.insert(0, str(EXTENSION_ROOT))

from deepseek_vision_sglang.patch import (
    BACKEND_NEW,
    BACKEND_OLD,
    NEW,
    OLD,
    patch_deepseek_v4_backend_source,
    patch_deepseek_v4_source,
)
from deepseek_vision_sglang.routing import build_sglang_routing_ids, routing_replacements


def load_prepare_module():
    path = ROOT / "scripts" / "prepare_sglang_model_repo.py"
    spec = importlib.util.spec_from_file_location("prepare_sglang_model_repo", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_smoke_module():
    path = ROOT / "scripts" / "smoke_sglang_moonvit.py"
    spec = importlib.util.spec_from_file_location("smoke_sglang_moonvit", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class SGLangExtensionTests(unittest.TestCase):
    def test_source_patch_is_exact_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "deepseek_v4.py"
            source.write_text(
                "class DeepseekV4Model(nn.Module):\n"
                "    def forward(self, input_ids, input_embeds=None):\n"
                f"        {OLD}\n",
                encoding="utf-8",
            )
            self.assertTrue(patch_deepseek_v4_source(source, check_only=True))
            self.assertNotIn(NEW, source.read_text(encoding="utf-8"))
            self.assertTrue(patch_deepseek_v4_source(source))
            self.assertFalse(patch_deepseek_v4_source(source))
            self.assertIn(NEW, source.read_text(encoding="utf-8"))

    def test_backend_patch_adds_opt_in_portable_decode(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "deepseek_v4_backend.py"
            source.write_text(
                "import enum\n"
                "class DeepseekV4AttnBackend:\n"
                "    def forward(self):\n"
                f"{BACKEND_OLD}",
                encoding="utf-8",
            )
            self.assertTrue(patch_deepseek_v4_backend_source(source))
            patched = source.read_text(encoding="utf-8")
            self.assertIn("import os\n", patched)
            self.assertIn(BACKEND_NEW, patched)
            self.assertFalse(patch_deepseek_v4_backend_source(source))

    def test_chunked_routing_keeps_absolute_palette_phase(self):
        item = SimpleNamespace(modality="IMAGE", offsets=[(2, 7)])
        mm_input = SimpleNamespace(mm_items=[item])
        replacements = routing_replacements(
            extend_prefix_lens=[5],
            extend_seq_lens=[4],
            mm_inputs=[mm_input],
            palette=[101, 202, 303],
        )
        self.assertEqual(replacements, [(0, 101), (1, 202), (2, 303)])

    def test_text_ids_are_unchanged_across_flattened_requests(self):
        first = SimpleNamespace(
            mm_items=[SimpleNamespace(modality="IMAGE", offsets=[(1, 2)])]
        )
        batch = SimpleNamespace(
            extend_prefix_lens_cpu=[0, 0],
            extend_seq_lens_cpu=[4, 3],
            mm_inputs=[first, None],
        )
        routed = build_sglang_routing_ids([10, 0, 0, 11, 20, 21, 22], batch, [7, 8])
        self.assertEqual(routed, [10, 7, 8, 11, 20, 21, 22])

    def test_packaging_metadata_keeps_deepseek_architecture(self):
        prepare = load_prepare_module()
        config = {
            "architectures": ["DeepseekV4ForCausalLM"],
            "vocab_size": 129280,
            "hidden_size": 4096,
        }
        updated = prepare.augment_config(config, [1, 2, 3])
        self.assertEqual(updated["architectures"], ["DeepseekV4ForCausalLM"])
        self.assertEqual(updated["vision_config"]["text_hidden_size"], 4096)
        self.assertEqual(updated["vision_config"]["hidden_size"], 1152)
        self.assertEqual(updated["vision_config"]["vt_hidden_size"], 1152)
        self.assertEqual(updated["deepseek_vision"]["routing_palette"], [1, 2, 3])
        self.assertTrue(updated["deepseek_vision"]["requires_sglang_source_patch"])

    def test_component_files_are_added_to_existing_index(self):
        prepare = load_prepare_module()
        updated = prepare.augment_weight_map(
            {"metadata": {"total_size": 5}, "weight_map": {"model.x": "model-1.safetensors"}},
            tower_keys=["patch_embed.proj.weight"],
            projector_keys=["pre_norm.weight", "proj.0.weight"],
            tower_size=11,
            projector_size=13,
        )
        self.assertEqual(
            updated["weight_map"]["patch_embed.proj.weight"],
            "vision_tower.safetensors",
        )
        self.assertEqual(updated["weight_map"]["proj.0.weight"], "mm_projector.safetensors")
        self.assertEqual(updated["metadata"]["total_size"], 29)

        rerun = prepare.augment_weight_map(
            updated,
            tower_keys=["patch_embed.proj.weight"],
            projector_keys=["pre_norm.weight", "proj.0.weight"],
            tower_size=11,
            projector_size=13,
        )
        self.assertEqual(rerun, updated)

    def test_component_index_rejects_a_backbone_collision(self):
        prepare = load_prepare_module()
        with self.assertRaisesRegex(ValueError, "collide"):
            prepare.augment_weight_map(
                {"weight_map": {"pre_norm.weight": "model-1.safetensors"}},
                tower_keys=[],
                projector_keys=["pre_norm.weight"],
            )

    def test_smoke_payload_uses_native_generate_image_field(self):
        smoke = load_smoke_module()
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "probe.png"
            image.write_bytes(b"not-decoded-by-this-test")
            payload = smoke.build_payload(image, smoke.DEFAULT_PROMPT, 12)
        self.assertTrue(payload["image_data"].startswith("data:image/png;base64,"))
        self.assertEqual(payload["text"].count("<image>"), 1)
        self.assertEqual(payload["sampling_params"]["max_new_tokens"], 12)

    def test_external_modules_have_registry_entry_classes(self):
        model_source = (
            EXTENSION_ROOT
            / "deepseek_vision_sglang"
            / "models"
            / "deepseek_v4_moonvit.py"
        ).read_text(encoding="utf-8")
        processor_source = (
            EXTENSION_ROOT
            / "deepseek_vision_sglang"
            / "processors"
            / "moonvit.py"
        ).read_text(encoding="utf-8")
        self.assertIn("EntryClass = [DeepseekV4ForCausalLM]", model_source)
        self.assertIn("models = [DeepseekV4ForCausalLM]", processor_source)

    def test_launch_wrapper_uses_pinned_server_argument_names(self):
        source = (ROOT / "scripts" / "launch_sglang_moonvit.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("--tp-size", source)
        self.assertIn("--revision", source)
        self.assertIn("DEEPSEEK_VISION_REVISION", source)
        self.assertIn("--enable-multimodal", source)
        self.assertNotIn("  --tp ", source)


if __name__ == "__main__":
    unittest.main()
