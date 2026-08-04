import importlib.util
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load_processor_module():
    class DummyTensor:
        def new_tensor(self, value):
            return value

    class DummyKimiWrapper:
        def _gpu_call(self, text, images):
            return {"input_ids": DummyTensor()}

        def _cpu_call(self, text, images, **kwargs):
            return {"input_ids": DummyTensor()}

    class DummyMixin:
        pass

    class DummyBase:
        pass

    stubs = {
        "transformers": types.ModuleType("transformers"),
        "sglang": types.ModuleType("sglang"),
        "sglang.srt": types.ModuleType("sglang.srt"),
        "sglang.srt.managers": types.ModuleType("sglang.srt.managers"),
        "sglang.srt.managers.schedule_batch": types.ModuleType(
            "sglang.srt.managers.schedule_batch"
        ),
        "sglang.srt.multimodal": types.ModuleType("sglang.srt.multimodal"),
        "sglang.srt.multimodal.processors": types.ModuleType(
            "sglang.srt.multimodal.processors"
        ),
        "sglang.srt.multimodal.processors.base_processor": types.ModuleType(
            "sglang.srt.multimodal.processors.base_processor"
        ),
        "sglang.srt.multimodal.processors.kimi_common": types.ModuleType(
            "sglang.srt.multimodal.processors.kimi_common"
        ),
        "sglang.srt.multimodal.processors.kimi_k25": types.ModuleType(
            "sglang.srt.multimodal.processors.kimi_k25"
        ),
        "deepseek_vision_sglang.models.deepseek_v4_moonvit": types.ModuleType(
            "deepseek_vision_sglang.models.deepseek_v4_moonvit"
        ),
    }
    stubs["transformers"].AutoProcessor = object
    stubs["sglang.srt.managers.schedule_batch"].MultimodalProcessorOutput = object
    base = stubs["sglang.srt.multimodal.processors.base_processor"]
    base.BaseMultimodalProcessor = DummyBase
    base.MultimodalSpecialTokens = object
    stubs["sglang.srt.multimodal.processors.kimi_common"].KimiGridMMDataMixin = (
        DummyMixin
    )
    kimi = stubs["sglang.srt.multimodal.processors.kimi_k25"]
    kimi.KimiGPUProcessorWrapper = DummyKimiWrapper
    kimi.navit_resize_config = lambda *args: {"num_tokens": 0}
    model = stubs["deepseek_vision_sglang.models.deepseek_v4_moonvit"]
    model.DeepseekV4ForCausalLM = object

    path = (
        ROOT
        / "sglang_ext"
        / "deepseek_vision_sglang"
        / "processors"
        / "moonvit.py"
    )
    spec = importlib.util.spec_from_file_location("moonvit_processor_under_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    with patch.dict(sys.modules, stubs):
        spec.loader.exec_module(module)
    return module


class MoonViTProcessorTests(unittest.TestCase):
    def test_wrapper_counts_images_and_emits_sentinel_ids(self):
        module = load_processor_module()
        calls = []

        def fake_resize(*args):
            calls.append(args)
            return {"num_tokens": 2}

        module.navit_resize_config = fake_resize
        wrapper = object.__new__(module.DeepseekMoonViTGPUProcessorWrapper)
        wrapper._deepseek_image_token_id = 129280
        wrapper._image_token = "<image>"
        wrapper._patch_size = 14
        wrapper._merge_kernel_size = 2
        wrapper._in_patch_limit = 2048
        wrapper._patch_limit_on_one_side = 64
        wrapper._fixed_output_tokens = None
        wrapper._hf_processor = SimpleNamespace(
            tokenizer=SimpleNamespace(
                encode=lambda text, add_special_tokens=False: [9] if text else []
            )
        )
        tensor_image = SimpleNamespace(shape=(3, 240, 320))
        pil_image = SimpleNamespace(size=(640, 480))

        counts = wrapper._token_counts([tensor_image, pil_image])
        gpu_output = wrapper._gpu_call("left<image>right", [tensor_image])

        self.assertEqual(counts, [2, 2])
        self.assertEqual(calls[0][:2], (320, 240))
        self.assertEqual(calls[1][:2], (640, 480))
        self.assertEqual(calls[0][2:], (14, 2, 2048, 64, None))
        self.assertEqual(gpu_output["input_ids"], [[9, 129280, 129280, 9]])


if __name__ == "__main__":
    unittest.main()
