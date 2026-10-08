# Isolated d1 Runtime Dependencies

Only the experimental finite-decision d1 provider uses this directory. Existing
chat Transformers 4.2.0 / patched ONNX Runtime 1.27 remain unchanged.

- onnxruntime-web 1.31.0-dev.20260914-8d85527a0, commit
  8d85527a010e294a26b274749f74294b2a32cec5: three runtime files copied byte-exact.
- @huggingface/transformers 4.3.1: tokenizer API. Exactly two bare module imports
  are relinked to ./ort.webgpu.bundle.min.mjs; all remaining bytes are unchanged.
  This reproduces the previously verified browser import map, including Tensor.
- ORT MIT and Transformers Apache-2.0 licenses are retained separately. They do
  not replace the model's LFM Open License v1.0.

All executable modules/WASM are bundled in the extension, not downloaded remote
code. Model graph/tokenizer bytes are separately checksum-pinned data assets.
Runtime and graph precision is FP32 regardless of legacy config.dtype.
vendor-manifest.json records upstream/copied SHA-256 and the exact linkage edits.
