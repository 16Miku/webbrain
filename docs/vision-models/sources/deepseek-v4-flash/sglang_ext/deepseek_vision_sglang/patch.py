from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

from . import SGLANG_SOURCE_COMMIT


OLD = "hidden_states = self.embed_tokens(input_ids)"
NEW = "hidden_states = input_embeds if input_embeds is not None else self.embed_tokens(input_ids)"
FORWARD_ANCHOR = "class DeepseekV4Model(nn.Module):"
BACKEND_FORWARD_ANCHOR = "class DeepseekV4AttnBackend"
BACKEND_OLD = """            if _is_sm120:
                from sglang.kernels.ops.attention.flash_mla_sm120 import (
                    flash_mla_with_kvcache_sm120,
                )
"""
BACKEND_NEW = """            portable_sparse_decode = os.environ.get(
                "DEEPSEEK_VISION_PORTABLE_SPARSE_DECODE", "0"
            ).lower() in {"1", "true", "yes"}
            if _is_sm120 or portable_sparse_decode:
                from sglang.kernels.ops.attention.flash_mla_sm120 import (
                    flash_mla_with_kvcache_sm120,
                )
"""


def resolve_sglang_deepseek_v4_source() -> Path:
    spec = importlib.util.find_spec("sglang.srt.models.deepseek_v4")
    if spec is None or spec.origin is None:
        raise RuntimeError("could not locate sglang.srt.models.deepseek_v4")
    return Path(spec.origin).resolve()


def resolve_sglang_deepseek_v4_backend_source(model_source: str | Path) -> Path:
    source = Path(model_source).resolve()
    backend = source.parent.parent / "layers" / "attention" / "deepseek_v4_backend.py"
    if not backend.is_file():
        raise RuntimeError(f"could not locate SGLang DeepSeek V4 attention backend: {backend}")
    return backend


def patch_deepseek_v4_source(path: str | Path, *, check_only: bool = False) -> bool:
    """Apply the one-line routing-aware embedding patch.

    Returns ``True`` when the source needed a patch and ``False`` when it was already
    patched.  ``check_only`` validates the exact source anchor without writing.
    """
    source = Path(path)
    text = source.read_text(encoding="utf-8")
    if FORWARD_ANCHOR not in text:
        raise RuntimeError("not a recognized SGLang DeepSeek V4 model source")
    if text.count(NEW) == 1:
        return False
    count = text.count(OLD)
    if count != 1:
        raise RuntimeError(
            "expected exactly one SGLang DeepSeek V4 embedding site; "
            f"found {count}. The extension is pinned to {SGLANG_SOURCE_COMMIT}."
        )
    if not check_only:
        source.write_text(text.replace(OLD, NEW), encoding="utf-8")
    return True


def patch_deepseek_v4_backend_source(
    path: str | Path, *, check_only: bool = False
) -> bool:
    """Add an opt-in portable sparse-decode path for pre-Hopper smoke tests."""
    source = Path(path)
    text = source.read_text(encoding="utf-8")
    if BACKEND_FORWARD_ANCHOR not in text:
        raise RuntimeError("not a recognized SGLang DeepSeek V4 attention backend")
    if text.count(BACKEND_NEW) == 1:
        return False
    count = text.count(BACKEND_OLD)
    if count != 1:
        raise RuntimeError(
            "expected exactly one SGLang DeepSeek V4 FlashMLA dispatch site; "
            f"found {count}. The extension is pinned to {SGLANG_SOURCE_COMMIT}."
        )
    patched = text.replace(BACKEND_OLD, BACKEND_NEW)
    if "import os\n" not in patched:
        patched = patched.replace("import enum\n", "import enum\nimport os\n", 1)
    if not check_only:
        source.write_text(patched, encoding="utf-8")
    return True


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Patch the pinned SGLang DeepSeek V4 loader")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("source", nargs="?", help="deepseek_v4.py; auto-detected when omitted")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    source = Path(args.source).resolve() if args.source else resolve_sglang_deepseek_v4_source()
    needed = patch_deepseek_v4_source(source, check_only=args.check)
    state = "patchable" if needed and args.check else "patched" if needed else "already-patched"
    print(f"{source}: {state}; pinned SGLang commit {SGLANG_SOURCE_COMMIT}")
    if args.source is None:
        backend_source = resolve_sglang_deepseek_v4_backend_source(source)
        backend_needed = patch_deepseek_v4_backend_source(
            backend_source, check_only=args.check
        )
        backend_state = (
            "patchable"
            if backend_needed and args.check
            else "patched"
            if backend_needed
            else "already-patched"
        )
        print(
            f"{backend_source}: {backend_state}; pinned SGLang commit "
            f"{SGLANG_SOURCE_COMMIT}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
