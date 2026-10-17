"""Compare exported vision features with native Qwen3.5 eager PyTorch.

This optional check needs PyTorch and Transformers in addition to the build
requirements. --torch-site-packages can reuse an existing compatible Python
environment without changing its packages. It never executes repository code.
"""

import argparse
import json
import sys
from pathlib import Path


def validate(args):
    if args.grid_size < 0 or args.grid_size % 2:
        raise ValueError("The extra image grid must be zero or a positive even number")
    if args.torch_site_packages:
        # Import only the native runtime and its ordinary dependencies. Leaving
        # the other environment on sys.path would expose unrelated old SciPy /
        # scikit-learn wheels to this environment's NumPy ABI.
        runtime_path = str(args.torch_site_packages.resolve())
        sys.path.append(runtime_path)
        try:
            import torch, torchvision, sympy, networkx, jinja2  # noqa: F401
        finally:
            sys.path.remove(runtime_path)
    import numpy as np
    import onnxruntime as ort
    import torch
    import transformers
    from safetensors import safe_open
    from transformers.initialization import no_init_weights
    from transformers.models.qwen3_5.configuration_qwen3_5 import Qwen3_5VisionConfig
    from transformers.models.qwen3_5.modeling_qwen3_5 import Qwen3_5VisionModel
    from build_vision import VISION_PACK_SHA256, digest, read_json, write_json

    source = args.workspace / "sources" / args.size / "prism"
    bundle = args.workspace / "exports" / f"Ternary-Bonsai-2-{args.size}-ONNX-WebGPU-Vision"
    if digest(source / "model.safetensors") != VISION_PACK_SHA256[args.size]:
        raise ValueError("Native reference source hash mismatch")
    config = Qwen3_5VisionConfig(**read_json(source / "config.json")["vision_config"])
    config._attn_implementation = "eager"
    torch.set_num_threads(8)
    torch.set_float32_matmul_precision("highest")
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    with no_init_weights():
        model = Qwen3_5VisionModel(config)
    state = {}
    with safe_open(source / "model.safetensors", framework="np") as weights:
        for key in weights.keys():
            if not key.startswith("vision_tower."):
                continue
            array = weights.get_tensor(key)
            name = key.removeprefix("vision_tower.")
            if name == "patch_embed.proj.weight":
                # Native Conv3D takes [out,channels,time,height,width]. This
                # reference does not use the ONNX MatMul reshape/transposition.
                array = array.transpose(0, 4, 1, 2, 3)
            state[name] = torch.from_numpy(array.copy()).float()
    model.load_state_dict(state, strict=True)
    del state
    model = model.to(args.device).eval()
    print(f"Native {args.size} Qwen3.5 vision loaded on {args.device}", flush=True)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 8
    graph = bundle / "onnx" / "vision_encoder_fp16.onnx"
    session = ort.InferenceSession(str(graph), sess_options=options, providers=["CPUExecutionProvider"])
    random = np.random.default_rng(1987)
    records = []
    fixtures = [[[1, 4, 4]], [[1, 4, 6]], [[1, 4, 4], [1, 4, 6]]]
    if args.grid_size:
        fixtures.append([[1, args.grid_size, args.grid_size]])
    for grids in fixtures:
        grid = np.array(grids, dtype=np.int64)
        patches = int(np.prod(grid, axis=1).sum())
        pixels = random.uniform(-1, 1, size=(patches, 1536)).astype(np.float32)
        exported = session.run(None, {"pixel_values": pixels, "image_grid_thw": grid})[0]
        with torch.inference_mode():
            eager = model(torch.from_numpy(pixels).to(args.device),
                          grid_thw=torch.from_numpy(grid).to(args.device)).pooler_output.float().cpu().numpy()
        if exported.shape != eager.shape or not np.isfinite(exported).all() or not np.isfinite(eager).all():
            raise ValueError("Reference and exported features must have matching shapes and finite values")
        difference = exported.astype(np.float64) - eager.astype(np.float64)
        relative_l2 = float(np.linalg.norm(difference) / max(np.linalg.norm(eager), 1e-12))
        cosine = float(np.dot(exported.ravel(), eager.ravel()) /
                       (np.linalg.norm(exported) * np.linalg.norm(eager)))
        record = {"image_grid_thw": grids, "shape": list(eager.shape),
                  "cosine_similarity": cosine, "relative_l2_error": relative_l2,
                  "max_absolute_error": float(np.max(np.abs(difference)))}
        records.append(record)
        print(json.dumps(record), flush=True)
        if not np.isfinite(cosine) or not np.isfinite(relative_l2) or cosine < 0.9999 or relative_l2 > 0.02:
            raise ValueError(f"Native eager vision parity failed: {record}")
    report = {"passed": True, "size": args.size, "reference": "Native Qwen3.5 eager FP32 with original Prism weights",
              "device": args.device, "torch": torch.__version__, "transformers": transformers.__version__,
              "onnxruntime": ort.__version__, "exported_graph_sha256": digest(graph),
              "exported_weights_sha256": digest(graph.with_name(graph.name + "_data")), "fixtures": records}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_json(args.output, report)
    print(f"Native vision parity evidence: {args.output}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", choices=["2B", "4B"], default="2B")
    parser.add_argument("--workspace", type=Path, default=Path(".build/bonsai"))
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--grid-size", type=int, default=28,
                        help="Also check this square grid (28 matches a 448-pixel image); 0 skips it")
    parser.add_argument("--torch-site-packages", type=Path)
    parser.add_argument("--output", type=Path, default=Path(".build/bonsai/vision-native-parity.json"))
    validate(parser.parse_args())
