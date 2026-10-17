"""Build WebBrain's Bonsai vision ONNX bundles from revision-pinned sources.

The language graphs are already lossless ternary exports. Re-exporting them
through dense weights would lose that property. The official vision weights
are plain FP16, so insert every original tower tensor into the compatible
Qwen3.5 ONNX topology, accounting for MLX's Conv3D layout.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from huggingface_hub import snapshot_download

from chunk_gdn_prefill import MODEL_CARD_SECTION, rewrite_file
from onnx import numpy_helper
from safetensors import safe_open


SOURCES = {
    "2B": {
        "prism": ("prism-ml/Ternary-Bonsai-2-2B-mlx-2bit", "1c6cbae21f8c38830ce337972b46fdae7b18eaaa"),
        "text": ("danyalmalik/Ternary-Bonsai-2-2B-ONNX-WebGPU", "a3c26c4d363186f744b20e08d585ce43e2ce7e8d"),
        "vision": ("onnx-community/Qwen3.5-2B-ONNX", "315216e893038beefcc6eba41ac168913dd0d879"),
    },
    "4B": {
        "prism": ("prism-ml/Ternary-Bonsai-2-4B-mlx-2bit", "dff2caaa23fa8706164c44c10f1b58feb405f76a"),
        "text": ("danyalmalik/Ternary-Bonsai-2-4B-ONNX-WebGPU", "3e0b805e22baf98858057b80cfa637c2b6c77521"),
        "vision": ("onnx-community/Qwen3.5-4B-ONNX", "23ac3352f288351eddcdf141b32f4f66587f7e2d"),
    },
}
PATTERNS = {
    "prism": ["model.safetensors", "config.json", "LICENSE", "NOTICE.txt"],
    "text": ["onnx/*", "config.json", "tokenizer.json", "LICENSE", "NOTICE.txt"],
    "vision": ["onnx/vision_encoder_fp16.onnx", "tokenizer_config.json", "preprocessor_config.json",
               "processor_config.json", "generation_config.json", "chat_template.jinja"],
}
VISION_PACK_SHA256 = {
    "2B": "da5095b9f34d7f0d5094090afeeadf124eef821c75136dc28957ce586ae7ac0c",
    "4B": "432f48d0edcb8da2e6a4e0c96078588362397e2603e7fdea99957babfe968259",
}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def link_or_copy(source, target):
    """Keep immutable large source graphs shared with the distributable bundle."""
    if target.exists():
        if os.path.samefile(source, target):
            return
        target.unlink()
    try:
        target.hardlink_to(source)
    except OSError:
        shutil.copy2(source, target)


def seal_manifest(output):
    files = [{"path": str(path.relative_to(output)).replace("\\", "/"), "size": path.stat().st_size,
              "sha256": digest(path)} for path in sorted(output.rglob("*"))
             if path.is_file() and path.name != "manifest.json" and ".cache" not in path.parts]
    total = sum(file["size"] for file in files)
    write_json(output / "manifest.json", {"format": "webbrain-bonsai-vision-v1", "files": files,
                                        "total_bytes": total})
    return total


def source_tensor_name(name):
    """Map pinned ONNX names to the original Prism MLX namespace, fail closed."""
    if name == "model.embeddings.patch_embed.weight":
        return "vision_tower.patch_embed.proj.weight", "mlx-conv3d"
    if name == "model.embeddings.patch_embed.Add.bias":
        return "vision_tower.patch_embed.proj.bias", "identity"
    if name == "model.pos_embed.weight":
        return "vision_tower.pos_embed.weight", "identity"
    name = name.replace("model.layers.merger.merger_norm_layernorm.", "vision_tower.merger.norm.")
    name = name.replace("model.merger.linear1.", "vision_tower.merger.linear_fc1.")
    name = name.replace("model.merger.linear2.", "vision_tower.merger.linear_fc2.")
    name = re.sub(r"^model\.layers\.(\d+)\.", r"vision_tower.blocks.\1.", name)
    name = name.replace("norm1_layernorm", "norm1").replace("norm2_layernorm", "norm2")
    transpose = ".MatMul.weight" in name
    name = name.replace(".MatMul.weight", ".weight").replace(".Add.bias", ".bias")
    if not name.startswith("vision_tower."):
        raise ValueError(f"Unmapped learned ONNX tensor: {name}")
    return name, "transpose" if transpose else "identity"


def export_vision(prism, template, output):
    # All nonlearned constants are inline in this pinned topology. Loading its
    # large external weights would waste bandwidth: every one is replaced below.
    graph = onnx.load(template, load_external_data=False)
    records = []
    seen = set()
    with safe_open(prism / "model.safetensors", framework="np") as weights:
        source_names = {name for name in weights.keys() if name.startswith("vision_tower.")}
        for initializer in graph.graph.initializer:
            if initializer.name.startswith("/") or initializer.name == "model.vision.inv_freq":
                continue  # Positional frequencies and graph shape constants are not learned.
            source_name, transform = source_tensor_name(initializer.name)
            if source_name in seen:
                raise ValueError(f"Source tensor mapped twice: {source_name}")
            seen.add(source_name)
            original = weights.get_tensor(source_name)
            if transform == "mlx-conv3d":
                # MLX stores [out, time, height, width, channels]. The graph's
                # patch rows use [channels, time, height, width].
                original = original.transpose(0, 4, 1, 2, 3).reshape(original.shape[0], -1).T
            elif transform == "transpose":
                original = original.T
            target_dtype = onnx.helper.tensor_dtype_to_np_dtype(initializer.data_type)
            converted = np.ascontiguousarray(original.astype(target_dtype))
            if converted.shape != tuple(initializer.dims) or not np.isfinite(converted).all():
                raise ValueError(f"Invalid tensor shape/value: {source_name}")
            records.append({
                "source": source_name,
                "target": initializer.name,
                "transform": transform,
                "shape": list(converted.shape),
                "dtype": str(converted.dtype),
                "sha256": hashlib.sha256(converted.tobytes()).hexdigest(),
            })
            initializer.CopyFrom(numpy_helper.from_array(converted, name=initializer.name))
        if seen != source_names:
            raise ValueError(f"Incomplete vision export: missing={source_names - seen}, extra={seen - source_names}")
    graph.doc_string = (
        "Modified by WebBrain: all learned vision tensors restored from the original "
        "Prism ML Ternary Bonsai 2 MLX pack. MLX Conv3D axes and linear kernels were "
        "transposed for this ONNX topology. Created using Bonsai by Prism ML. "
        "See export-validation.json for pinned source revisions and tensor hashes."
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    # ONNX appends to existing external data files. Only these exact build
    # outputs are replaced, never source files or arbitrary directories.
    output.with_name(output.name + "_data").unlink(missing_ok=True)
    onnx.save_model(graph, output, save_as_external_data=True, all_tensors_to_one_file=True,
                    location=output.name + "_data", size_threshold=1024)
    onnx.checker.check_model(str(output))
    saved = onnx.load(output)
    expected = {record["target"]: record for record in records}
    for tensor in saved.graph.initializer:
        if tensor.name in expected:
            actual = hashlib.sha256(numpy_helper.to_array(tensor).tobytes()).hexdigest()
            if actual != expected[tensor.name]["sha256"]:
                raise ValueError(f"Serialized tensor mismatch: {tensor.name}")
    return records


def validate_vision(output, hidden_size):
    """Exercise dynamic rectangular grids and ensure pixels affect embeddings.

    This validates the vision graph only. Meaningful image answers are checked
    separately through the packaged browser worker before publication.
    """
    options = ort.SessionOptions()
    options.intra_op_num_threads = 8
    session = ort.InferenceSession(str(output), sess_options=options, providers=["CPUExecutionProvider"])
    results = []
    features = []
    pixel_inputs = []
    for rows, columns, channel in [(4, 4, 0), (4, 4, 2), (4, 6, 1)]:
        pixels = np.full((rows * columns, 3, 2, 16, 16), -1, dtype=np.float32)
        pixels[:, channel] = 1
        value = session.run(None, {
            "pixel_values": pixels.reshape(rows * columns, -1),
            "image_grid_thw": np.array([[1, rows, columns]], dtype=np.int64),
        })[0]
        expected = (rows * columns // 4, hidden_size)
        if value.shape != expected or not np.isfinite(value).all():
            raise ValueError(f"Vision inference failed for grid {rows}x{columns}")
        features.append(value)
        pixel_inputs.append(pixels.reshape(rows * columns, -1))
        results.append({"grid": [1, rows, columns], "output_shape": list(value.shape), "finite": True})
    difference = float(np.max(np.abs(features[0] - features[1])))
    if difference <= 0.001:
        raise ValueError("Vision output does not respond to different pixel inputs")
    # Conversation history can contain differently sized screenshots. Their
    # patches share one call but must not attend across the image boundary.
    multiple = session.run(None, {
        "pixel_values": np.concatenate([pixel_inputs[0], pixel_inputs[2]]),
        "image_grid_thw": np.array([[1, 4, 4], [1, 4, 6]], dtype=np.int64),
    })[0]
    separate = np.concatenate([features[0], features[2]])
    if not np.allclose(multiple, separate, rtol=0.02, atol=0.003):
        raise ValueError("Batched image features differ from independent image encoding")
    return {"provider": "CPUExecutionProvider", "fixtures": results,
            "red_blue_max_absolute_difference": difference,
            "multiple_image_max_absolute_difference": float(np.max(np.abs(multiple - separate)))}


def build(size, workspace, offline=False, skip_inference=False):
    roots = {}
    for kind, (repo, revision) in SOURCES[size].items():
        roots[kind] = workspace / "sources" / size / kind
        if not offline:
            snapshot_download(repo, revision=revision, local_dir=roots[kind], allow_patterns=PATTERNS[kind],
                              max_workers=3, token=False)
    prism, text, vision = (roots[name] for name in ("prism", "text", "vision"))
    source_pack_hash = digest(prism / "model.safetensors")
    if source_pack_hash != VISION_PACK_SHA256[size]:
        raise ValueError("Original vision pack SHA-256 differs from the pinned Hugging Face LFS object")
    print(f"{size}: original Prism vision pack SHA-256 verified", flush=True)
    output = workspace / "exports" / f"Ternary-Bonsai-2-{size}-ONNX-WebGPU-Vision"
    (output / "onnx").mkdir(parents=True, exist_ok=True)
    # A rebuilt package needs fresh external validation. Keep the original
    # reports outside this directory, but never seal a stale success report
    # into newly generated model artifacts.
    for filename in ("browser-validation.json", "native-vision-validation.json"):
        (output / filename).unlink(missing_ok=True)
    original_config = read_json(prism / "config.json")
    config = read_json(text / "config.json")
    if config["vision_config"] != original_config["vision_config"]:
        raise ValueError("Vision graph and original model architectures differ")
    if config["text_config"]["hidden_size"] != config["vision_config"]["out_hidden_size"]:
        raise ValueError("Vision and language embedding dimensions differ")
    for filename in ("decoder_model_merged_q2f16.onnx_data", "embed_tokens_q2f16.onnx", "embed_tokens_q2f16.onnx_data"):
        source = text / "onnx" / filename
        link_or_copy(source, output / "onnx" / filename)
    # Replace the token-sequential GatedDeltaNet Scan with the chunked prefill
    # graph. Only the small graph file changes; the weights stay hardlinked.
    language_graph = rewrite_file(text / "onnx" / "decoder_model_merged_q2f16.onnx",
                                  output / "onnx" / "decoder_model_merged_q2f16.onnx")
    print(f"{size}: rewrote {language_graph['gdn_layers_rewritten']} GatedDeltaNet prefill scans", flush=True)
    shutil.copy2(text / "tokenizer.json", output / "tokenizer.json")
    for filename in ("tokenizer_config.json", "preprocessor_config.json", "processor_config.json",
                     "generation_config.json", "chat_template.jinja"):
        shutil.copy2(vision / filename, output / filename)
    tokenizer_config = read_json(output / "tokenizer_config.json")
    tokenizer_config["tokenizer_class"] = "Qwen2Tokenizer"
    write_json(output / "tokenizer_config.json", tokenizer_config)
    # The upstream 16-megapixel ceiling is unsuitable for an interactive browser
    # worker. This is a processor default, not a change to the vision weights.
    preprocessor_config = read_json(output / "preprocessor_config.json")
    preprocessor_config["size"]["longest_edge"] = 1048576
    write_json(output / "preprocessor_config.json", preprocessor_config)
    processor_config = read_json(output / "processor_config.json")
    processor_config["image_processor"]["size"]["longest_edge"] = 1048576
    write_json(output / "processor_config.json", processor_config)
    config["transformers.js_config"] = {
        "use_external_data_format": {"vision_encoder_fp16.onnx": 1, "embed_tokens_q2f16.onnx": 1,
                                     "decoder_model_merged_q2f16.onnx": 1},
        "kv_cache_dtype": {"q2f16": "float16", "fp16": "float16"},
    }
    write_json(output / "config.json", config)
    shutil.copy2(prism / "LICENSE", output / "LICENSE")
    (output / "NOTICE.txt").write_text(
        (prism / "NOTICE.txt").read_text(encoding="utf-8") + "\n\n"
        + (text / "NOTICE.txt").read_text(encoding="utf-8") + "\n\n"
        + "Modified by WebBrain: restored the original Prism ML vision tower to the ONNX package; "
        + "adapted processor/runtime configuration. Created using Bonsai by Prism ML.\n",
        encoding="utf-8",
    )
    vision_output = output / "onnx" / "vision_encoder_fp16.onnx"
    records = export_vision(prism, vision / "onnx" / "vision_encoder_fp16.onnx", vision_output)
    print(f"{size}: exported and checked all {len(records)} vision tensors", flush=True)
    validation = None if skip_inference else validate_vision(vision_output, config["vision_config"]["out_hidden_size"])
    report = {
        "size": size,
        "sources": {kind: {"repo_id": repo, "revision": revision} for kind, (repo, revision) in SOURCES[size].items()},
        "source_vision_pack_sha256": source_pack_hash,
        "vision_tensor_count": len(records),
        "onnx_checker": "passed",
        "language_graph": language_graph,
        "vision_inference": validation,
        "browser_image_inference": "Run scripts/check-bonsai-webgpu.mjs; this build check does not verify browser answers.",
        "tensor_mapping": records,
    }
    write_json(output / "export-validation.json", report)
    write_json(output / "chunked-prefill-validation.json", {
        "rewrite": language_graph,
        "external_data_unchanged": "onnx/decoder_model_merged_q2f16.onnx_data",
        "evidence": [],
        "pending": "Compare with validate_chunked_gdn.py, time WebGPU prefill, and attach both reports "
                   "(make_chunked_bundle.py --evidence) before publishing.",
    })
    ocr_limit = (
        f"The {size} model omitted or confused characters in four-character OCR fixtures, "
        "including at a 1,024-visual-token budget. Failed OCR reports are retained "
        "alongside successful pipeline checks when publishing validation evidence."
    )
    (output / "README.md").write_text(f"""---
license: apache-2.0
library_name: transformers.js
pipeline_tag: image-text-to-text
base_model:
- prism-ml/Ternary-Bonsai-2-{size}-mlx-2bit
tags: [onnx, webgpu, ternary, bonsai, vision, qwen3_5]
---

# Ternary Bonsai 2 {size} — WebGPU with images

Created using Bonsai by Prism ML. This is a modified ONNX packaging of Prism's
Ternary Bonsai 2 {size}, for local text and image inference in WebBrain.

The ternary language weights and Hadamard transforms come unchanged from
`danyalmalik/Ternary-Bonsai-2-{size}-ONNX-WebGPU`. The original Prism FP16 vision
tower is exported into the compatible `onnx-community/Qwen3.5-{size}-ONNX`
topology. All original vision tensors are mapped and checked after serialization;
the MLX patch projection is transposed from its channel-last layout. Normalization
and position tensors are widened to FP32 as required by the ONNX graph.
No training or additional language quantization is performed.
Processor sidecars select the compatible Qwen2 tokenizer class and a 1,048,576
pixel image ceiling for browser memory use.

Use Transformers.js `AutoProcessor` and `AutoModelForImageTextToText`, with
`device: 'webgpu'` and
`dtype: {{embed_tokens: 'q2f16', decoder_model_merged: 'q2f16', vision_encoder: 'fp16'}}`.
The runtime must support Qwen3.5 hybrid linear/full attention, `MatMulNBits` with
2-bit weights, `GatherBlockQuantized`, and FP16 WebGPU shaders. Vision pixels and
image embeddings enter the graph as FP32. KV and recurrent states are FP16.

Reproduce with `scripts/models/bonsai/build_vision.py` in the WebBrain repository.
`export-validation.json` records pinned upstream revisions, complete vision
tensor mappings, serialization hashes, and CPU graph checks. `manifest.json`
records distributable file sizes and SHA-256 hashes. Browser and model-answer
validation must be run separately; graph checks alone do not establish answer
quality or support on every browser/GPU.

Color/shape fixtures check independent visual facts. Exact OCR is a separate
optional check. {ocr_limit}

Apache 2.0; see LICENSE and NOTICE.txt. Original context capacity is 262,144 tokens;
WebBrain applies a smaller browser context budget. Model weights and processor
files are downloaded once; inference runs locally.
""" + MODEL_CARD_SECTION, encoding="utf-8")
    total = seal_manifest(output)
    print(json.dumps({"output": str(output.resolve()), "vision_tensors": len(records),
                      "total_bytes": total, "vision_inference": validation}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", choices=["2B", "4B", "all"], default="all")
    parser.add_argument("--workspace", type=Path, default=Path(".build/bonsai"))
    parser.add_argument("--offline", action="store_true", help="Use already downloaded, revision-pinned sources")
    parser.add_argument("--skip-inference", action="store_true", help="Only serialize/check weights; report inference as unverified")
    args = parser.parse_args()
    for model_size in (["2B", "4B"] if args.size == "all" else [args.size]):
        build(model_size, args.workspace.resolve(), args.offline, args.skip_inference)
