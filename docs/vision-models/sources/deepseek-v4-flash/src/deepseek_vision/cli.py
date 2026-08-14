from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from .components import extract_component
from .config import load_project_config
from .manifest import build_manifest
from .projector import projector_parameter_count
from .routing import greedy_routing_palette


def _config_command(args: argparse.Namespace) -> int:
    config = load_project_config(args.path)
    count = projector_parameter_count(
        config.projector.vision_hidden_size,
        config.projector.text_hidden_size,
        config.projector.merge_size,
    )
    print(json.dumps({"name": config.name, "projector_parameters": count}, indent=2))
    return 0


def _manifest_command(args: argparse.Namespace) -> int:
    with Path(args.output).open("w", encoding="utf-8") as output:
        count = build_manifest(args.config, output)
    print(f"wrote {count} examples to {args.output}")
    return 0


def _palette_command(args: argparse.Namespace) -> int:
    try:
        from safetensors import safe_open
    except ImportError as exc:
        raise RuntimeError("palette extraction requires safetensors") from exc
    tables = []
    for checkpoint in args.checkpoints:
        with safe_open(checkpoint, framework="pt", device="cpu") as handle:
            candidates = [name for name in handle if name.endswith("tid2eid")]
            if not candidates:
                raise ValueError(f"no tid2eid tensor in {checkpoint}")
            tables.extend(handle.get_tensor(name).tolist() for name in candidates)
    vocab_sizes = {len(table) for table in tables}
    if len(vocab_sizes) != 1:
        raise ValueError(f"routing tables have different vocabulary sizes: {vocab_sizes}")
    offsets = []
    offset = 0
    for table in tables:
        offsets.append(offset)
        offset += max(max(row) for row in table) + 1
    combined = [
        [expert + offsets[layer] for layer, table in enumerate(tables) for expert in table[token]]
        for token in range(len(tables[0]))
    ]
    palette = greedy_routing_palette(combined, args.size)
    Path(args.output).write_text(json.dumps(palette, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(palette)} routing IDs to {args.output}")
    return 0


def _extract_command(args: argparse.Namespace) -> int:
    path = extract_component(args.model_id, args.revision, args.prefix, args.output)
    print(path)
    return 0


def _train_command(args: argparse.Namespace) -> int:
    from .training import train_cached_pilot

    summary = train_cached_pilot(
        model_config_path=args.model_config,
        train_config_path=args.train_config,
        cache_dir=args.cache_dir,
        output_dir=args.output_dir,
        max_examples=args.max_examples,
        resume_checkpoint=args.resume_checkpoint,
    )
    print(json.dumps(summary, indent=2))
    return 0


def _dequantize_command(args: argparse.Namespace) -> int:
    from .dequantize import dequantize_checkpoint

    summary = dequantize_checkpoint(args.source, args.output, resume=args.resume)
    print(json.dumps(summary, indent=2))
    return 0


def _encode_image_command(args: argparse.Namespace) -> int:
    from .vision_encoding import encode_image

    features = encode_image(
        model_config_path=args.model_config,
        image_path=args.image,
        output_path=args.output,
        device=args.device,
        max_image_tokens=args.max_image_tokens,
    )
    print(json.dumps({"output": args.output, "image_tokens": int(features.shape[0])}, indent=2))
    return 0


def _generation_kwargs(args: argparse.Namespace) -> dict:
    return {
        "prompt": args.prompt,
        "max_new_tokens": args.max_tokens,
        "max_sequence_length": args.max_sequence_length,
        "temperature": args.temperature,
        "top_p": args.top_p,
        "seed": args.seed,
    }


def _inference_engine(args: argparse.Namespace):
    from .inference import DeepSeekVisionInference

    return DeepSeekVisionInference(
        model_config_path=args.model_config,
        projector_checkpoint=args.projector_checkpoint,
        max_memory_per_gpu=args.max_memory_per_gpu,
    )


def _infer_feature_command(args: argparse.Namespace) -> int:
    engine = _inference_engine(args)
    result = engine.generate_from_feature_file(args.feature, **_generation_kwargs(args))
    print(json.dumps(result, indent=2))
    return 0


def _infer_image_command(args: argparse.Namespace) -> int:
    from .inference import encode_image_subprocess, project_root

    moonvit_python = args.moonvit_python
    if moonvit_python is None:
        moonvit_python = project_root(args.model_config) / ".venv-moonvit/bin/python"
    with tempfile.TemporaryDirectory(prefix="deepseek-vision-") as directory:
        feature_path = Path(directory) / "vision-features.pt"
        encode_image_subprocess(
            moonvit_python=moonvit_python,
            model_config_path=args.model_config,
            image_path=args.image,
            output_path=feature_path,
            device=args.moonvit_device,
            max_image_tokens=args.max_image_tokens,
        )
        engine = _inference_engine(args)
        result = engine.generate_from_feature_file(feature_path, **_generation_kwargs(args))
    print(json.dumps(result, indent=2))
    return 0


def _serve_command(args: argparse.Namespace) -> int:
    from .api import MoonViTWorkerClient, serve
    from .inference import project_root

    moonvit_python = args.moonvit_python
    if moonvit_python is None:
        moonvit_python = project_root(args.model_config) / ".venv-moonvit/bin/python"
    encoder = MoonViTWorkerClient(
        python=moonvit_python,
        model_config=args.model_config,
        device=args.moonvit_device,
    )
    try:
        engine = _inference_engine(args)
    except Exception:
        encoder.close()
        raise
    serve(
        engine=engine,
        encoder=encoder,
        host=args.host,
        port=args.port,
        max_image_tokens=args.max_image_tokens,
    )
    return 0


def _add_inference_model_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("model_config")
    parser.add_argument("projector_checkpoint")
    parser.add_argument("--max-memory-per-gpu")


def _add_generation_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--max-tokens", type=int, default=128)
    parser.add_argument("--max-sequence-length", type=int, default=2048)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--top-p", type=float, default=0.95)
    parser.add_argument("--seed", type=int, default=20260802)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deepseek-vision")
    commands = parser.add_subparsers(required=True)

    validate = commands.add_parser("validate-config")
    validate.add_argument("path")
    validate.set_defaults(func=_config_command)

    manifest = commands.add_parser("build-manifest")
    manifest.add_argument("config")
    manifest.add_argument("output")
    manifest.set_defaults(func=_manifest_command)

    palette = commands.add_parser("select-routing-palette")
    palette.add_argument("output")
    palette.add_argument("checkpoints", nargs="+")
    palette.add_argument("--size", type=int, default=64)
    palette.set_defaults(func=_palette_command)

    extract = commands.add_parser("extract-component")
    extract.add_argument("model_id")
    extract.add_argument("prefix")
    extract.add_argument("output")
    extract.add_argument("--revision", default="main")
    extract.set_defaults(func=_extract_command)

    train = commands.add_parser("train-cache")
    train.add_argument("model_config")
    train.add_argument("train_config")
    train.add_argument("cache_dir")
    train.add_argument("output_dir")
    train.add_argument("--max-examples", type=int)
    train.add_argument("--resume-checkpoint")
    train.set_defaults(func=_train_command)

    dequantize = commands.add_parser("dequantize-checkpoint")
    dequantize.add_argument("source")
    dequantize.add_argument("output")
    dequantize.add_argument("--resume", action="store_true")
    dequantize.set_defaults(func=_dequantize_command)

    encode_image = commands.add_parser("encode-image")
    encode_image.add_argument("model_config")
    encode_image.add_argument("image")
    encode_image.add_argument("output")
    encode_image.add_argument("--device", default="cuda:0")
    encode_image.add_argument("--max-image-tokens", type=int, default=512)
    encode_image.set_defaults(func=_encode_image_command)

    infer_feature = commands.add_parser("infer-feature")
    _add_inference_model_arguments(infer_feature)
    infer_feature.add_argument("feature")
    _add_generation_arguments(infer_feature)
    infer_feature.set_defaults(func=_infer_feature_command)

    infer_image = commands.add_parser("infer-image")
    _add_inference_model_arguments(infer_image)
    infer_image.add_argument("image")
    infer_image.add_argument("--moonvit-python")
    infer_image.add_argument("--moonvit-device", default="cuda:0")
    infer_image.add_argument("--max-image-tokens", type=int, default=512)
    _add_generation_arguments(infer_image)
    infer_image.set_defaults(func=_infer_image_command)

    serve_parser = commands.add_parser("serve")
    _add_inference_model_arguments(serve_parser)
    serve_parser.add_argument("--moonvit-python")
    serve_parser.add_argument("--moonvit-device", default="cuda:0")
    serve_parser.add_argument("--max-image-tokens", type=int, default=512)
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8000)
    serve_parser.set_defaults(func=_serve_command)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (ValueError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
