# Vendored Transformers.js WebGPU runtime

This directory packages the JavaScript and WASM runtime used by the optional
**Settings -> Multimodal -> Vision -> LFM2.5-VL local fallback**. The fallback
runs `LiquidAI/LFM2.5-VL-450M-ONNX` in a dedicated Web Worker and is never
offered as WebBrain's general planning or tool-calling provider.

Model weights are not bundled. Transformers.js downloads the recommended
WebGPU variants on first use and stores them in the browser cache:

- `embed_tokens`: FP16
- `vision_encoder`: FP16
- `decoder_model_merged`: Q4

The initial download is approximately 770 MB. Screenshots are processed on the
user's device; only the resulting text description enters the main provider's
conversation.

## Packaged files

| File / directory | Source | Purpose |
| --- | --- | --- |
| `transformers.web.js` | `@huggingface/transformers` 4.2.0 | Browser ESM model/processor APIs |
| `ort.webgpu.mjs` | `onnxruntime-web` 1.26.0-dev.20260416-b7804b056c | WebGPU execution provider |
| `onnxruntime-common/` | matching `onnxruntime-common` dependency | Tensor and session types |
| `ort-wasm-simd-threaded.asyncify.*` | `onnxruntime-web` 1.26.0-dev.20260416-b7804b056c | WASM bridge used by the worker |
| `ort-wasm-simd-threaded.jsep.*` | `onnxruntime-web` 1.26.0-dev.20260416-b7804b056c | Packaged WebGPU/JSEP runtime |
| `LICENSE.transformers.txt` | `@huggingface/transformers` 4.2.0 | Apache-2.0 license |
| `LICENSE.onnxruntime.txt` | ONNX Runtime commit `b7804b056c30aa35c1748f8e4e239d0e2ff25d6d` | MIT license |
| `ThirdPartyNotices.onnxruntime.txt` | same ONNX Runtime commit | Notices for incorporated third-party software |

The readable, unminified browser builds are committed so a fresh checkout is a
complete, Chrome Web Store-reviewable extension. Remote executable code is not
allowed by Manifest V3 CSP; only model/config/tokenizer data is fetched from
Hugging Face.

## Browser-specifier patches

The upstream browser bundle contains two bare module specifiers that an
unbundled extension cannot resolve. After copying a new release, rewrite them:

```bash
sed -i 's|"onnxruntime-web/webgpu"|"./ort.webgpu.mjs"|' \
  src/chrome/vendor/transformers/transformers.web.js
sed -i 's|"onnxruntime-common"|"./onnxruntime-common/index.js"|' \
  src/chrome/vendor/transformers/transformers.web.js
```

Verify that no executable bare imports remain:

```bash
grep -E '(import|export)[^"]*from\s+"[a-zA-Z@]' \
  src/chrome/vendor/transformers/transformers.web.js \
  | grep -v '^\s*//' | grep -v '^\s*\*'
```

## Updating

Use a temporary dependency install; WebBrain does not need a runtime npm
dependency because the reviewed browser assets are committed directly:

```bash
npm install --no-save @huggingface/transformers@latest
cp node_modules/@huggingface/transformers/dist/transformers.web.js \
  src/chrome/vendor/transformers/
cp node_modules/onnxruntime-web/dist/ort.webgpu.mjs \
  src/chrome/vendor/transformers/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{asyncify,jsep}.{mjs,wasm} \
  src/chrome/vendor/transformers/
rm -rf src/chrome/vendor/transformers/onnxruntime-common
mkdir src/chrome/vendor/transformers/onnxruntime-common
cp node_modules/onnxruntime-common/dist/esm/*.js \
  src/chrome/vendor/transformers/onnxruntime-common/
```

Copy the Transformers.js license and the ONNX Runtime license plus
`ThirdPartyNotices.txt` into this directory whenever the runtime is updated.
Reapply the two specifier patches, update the version table above, then verify:

1. `node --check` passes for the provider, host, and worker.
2. **Use local fallback** enables the option without downloading weights.
3. **Test Connection** reads `WB7` from the packaged vision probe image.
4. The second test reuses browser-cached model files.

## Runtime architecture

```text
ProviderManager.getVisionProvider()
  -> WebGPUVisionProvider.chat()
  -> MV3 offscreen document
  -> dedicated module Worker
  -> AutoProcessor + AutoModelForImageTextToText
  -> LiquidAI/LFM2.5-VL-450M-ONNX over WebGPU
```

Keep inference in the Worker. The MV3 service worker has no WebGPU, while the
offscreen document's main thread has shown tighter WASM allocation limits for
large ONNX runs. Do not set `preferredOutputLocation: 'gpu-buffer'` on this
generation path: Transformers.js decodes the generated tensor on the CPU and
must be allowed to download that output normally.

LFM2.5-VL expects the image placeholder before the user's text in its chat
template. The Worker normalizes incoming OpenAI-style multimodal messages to
that order. For the connection test, it replaces the packaged generic OCR image
with three large, unlabeled color panels. This proves the local model received
pixels without relying on fine OCR, which is brittle for a 450M model. Normal
screenshots are never replaced by this probe-only path.
