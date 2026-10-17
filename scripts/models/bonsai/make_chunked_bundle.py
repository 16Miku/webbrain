"""Derive a parallel-prefill bundle from a sealed Bonsai 2 vision bundle.

Only the language decoder graph changes (see chunk_gdn_prefill.py). Large
unchanged files are hardlinked. Browser evidence recorded against the previous
graph is not carried over: rerun scripts/check-bonsai-webgpu.mjs on the new
bundle and record it with record_browser_validation.py.

  python scripts/models/bonsai/make_chunked_bundle.py \
      --source .build/bonsai/exports/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision \
      --output .build/bonsai/exports-chunked/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision \
      --evidence .build/bonsai/chunked-cpu-2B.json --evidence .build/bonsai/chunked-webgpu-2B.json
"""

import argparse
import json
import shutil
from pathlib import Path

from build_vision import digest, link_or_copy, read_json, seal_manifest, write_json
from chunk_gdn_prefill import MODEL_CARD_SECTION as CARD_SECTION, rewrite_file

GRAPH = "onnx/decoder_model_merged_q2f16.onnx"
# Upstream danyalmalik language graphs this rewrite was validated against.
SOURCE_GRAPH_SHA256 = {
    "2B": "a4b3e8a9633cfffa35104ccbf2bd748c26f36cd8b1281c8443d47b82ecd0268f",
    "4B": "e7975db212de3464d54f086cc4652e2d56a9f16632ee428601be47e7dc33a542",
}
STALE_EVIDENCE = {"browser-validation.json", "offline-browser-validation.json"}
CARD_LANGUAGE_OLD = "The ternary language graphs and Hadamard transforms come unchanged from"
CARD_LANGUAGE_NEW = "The ternary language weights and Hadamard transforms come unchanged from"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, required=True, help="sealed bundle with the original graph")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--graph", type=Path, help="already rewritten graph to use (checked against --source)")
    parser.add_argument("--chunk", type=int, default=128)
    parser.add_argument("--evidence", type=Path, action="append", default=[], help="JSON reports to embed")
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    size = "2B" if "-2B-" in source.name else "4B"

    manifest = read_json(source / "manifest.json")
    for entry in manifest["files"]:
        if digest(source / entry["path"]) != entry["sha256"]:
            raise ValueError(f"Source bundle changed after sealing: {entry['path']}")
    if digest(source / GRAPH) != SOURCE_GRAPH_SHA256[size]:
        raise ValueError("Source decoder graph is not the validated upstream graph")

    output.mkdir(parents=True, exist_ok=True)
    (output / "onnx").mkdir(exist_ok=True)
    for entry in manifest["files"]:
        path = entry["path"]
        if path == GRAPH or path in STALE_EVIDENCE:
            continue
        target = output / path
        target.parent.mkdir(parents=True, exist_ok=True)
        if entry["size"] > 16 * 1024 * 1024:
            link_or_copy(source / path, target)
        else:
            if target.exists():
                target.unlink()
            shutil.copy2(source / path, target)
    for stale in STALE_EVIDENCE:
        (output / stale).unlink(missing_ok=True)

    scratch = output / "onnx" / ".rewrite.onnx"
    report = rewrite_file(source / GRAPH, scratch, chunk=args.chunk)
    if args.graph:
        if digest(args.graph) != report["output_sha256"]:
            # Protobuf serializers may order bytes differently; require identical graphs.
            import onnx
            a = onnx.load(args.graph, load_external_data=False)
            b = onnx.load(scratch, load_external_data=False)
            a.ClearField("producer_version"); b.ClearField("producer_version")
            if a.SerializeToString(deterministic=True) != b.SerializeToString(deterministic=True):
                raise ValueError("--graph differs from a fresh rewrite of the source graph")
        scratch.unlink()
        (output / GRAPH).unlink(missing_ok=True)
        shutil.copy2(args.graph, output / GRAPH)
        report["output_sha256"] = digest(output / GRAPH)
        report["output_bytes"] = (output / GRAPH).stat().st_size
    else:
        (output / GRAPH).unlink(missing_ok=True)
        scratch.rename(output / GRAPH)

    write_json(output / "chunked-prefill-validation.json", {
        "rewrite": report,
        "external_data_unchanged": "onnx/decoder_model_merged_q2f16.onnx_data",
        "evidence": [read_json(path) for path in args.evidence],
    })
    validation = read_json(output / "export-validation.json")
    validation["language_graph"] = {
        "change": "GatedDeltaNet Scan prefill replaced by chunked delta rule; last-position logits",
        "evidence": "chunked-prefill-validation.json",
        **{key: report[key] for key in ("source_sha256", "output_sha256", "chunk_tokens", "max_prompt_tokens", "logits")},
    }
    validation["browser_image_inference"] = "Run scripts/check-bonsai-webgpu.mjs; this build check does not verify browser answers."
    write_json(output / "export-validation.json", validation)

    card = (output / "README.md").read_text(encoding="utf-8")
    card = card.replace(CARD_LANGUAGE_OLD, CARD_LANGUAGE_NEW)
    head, sep, tail = card.partition("\n## Hardware validation")
    card = head.rstrip() + "\n" + CARD_SECTION
    if sep:
        # Keep OCR limitation notes; hardware evidence is re-recorded for this graph.
        ocr = tail.partition("\n### Observed OCR limitation")
        if ocr[1]:
            card += "\n## Observed OCR limitation" + ocr[2].rstrip() + (
                "\n\nOCR reports in this repository were recorded with the previous (Scan) graph.\n")
    (output / "README.md").write_text(card, encoding="utf-8")
    total = seal_manifest(output)
    print(json.dumps({"output": str(output), "graph_sha256": report["output_sha256"], "total_bytes": total}, indent=2))


if __name__ == "__main__":
    main()
