"""Attach successful text/tool and image color/shape evidence to a vision bundle."""

import argparse

from build_vision import digest, read_json, seal_manifest, write_json


def record(bundle, evidence):
    result = read_json(evidence)
    if result.get("passed") is not True or result.get("vision") is not True:
        raise ValueError("Only a successful vision run can be recorded as browser validation")
    if result.get("model") != f"webbrain-one/{bundle.name}":
        raise ValueError("Browser evidence belongs to a different model")
    probe = result.get("probe", {})
    if not probe.get("hasWebGPU") or probe.get("isFallbackAdapter") is not False:
        raise ValueError("Hardware WebGPU evidence is required")
    checks = {check["name"]: check for check in result.get("checks", [])}
    required = {"text", "tool-call", "tool-result", "image-red", "image-blue"}
    if not required.issubset(checks) or not all(checks[name].get("ok") is True for name in required):
        raise ValueError("Evidence must include successful text, tool, and both image checks")
    # Refuse to attach evidence after model artifacts changed since the testable
    # build was sealed. The browser test uses this exact export directory.
    manifest = read_json(bundle / "manifest.json")
    for entry in manifest["files"]:
        if digest(bundle / entry["path"]) != entry["sha256"]:
            raise ValueError(f"Bundle changed after build: {entry['path']}")
    write_json(bundle / "browser-validation.json", result)
    validation = read_json(bundle / "export-validation.json")
    validation["browser_image_inference"] = {
        "status": "passed",
        "evidence": "browser-validation.json",
        "finished_at": result.get("finishedAt"),
        "adapter": result.get("adapter"),
        "checks": sorted(checks),
        "limitations": "Synthetic fixtures on this recorded browser/GPU; not a general model-quality benchmark.",
    }
    write_json(bundle / "export-validation.json", validation)
    total = seal_manifest(bundle)
    print(f"Recorded verified browser evidence; distributable files total {total} bytes")


if __name__ == "__main__":
    from pathlib import Path
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    record(args.bundle.resolve(), args.evidence.resolve())
