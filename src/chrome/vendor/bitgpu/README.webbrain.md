# Vendored bitgpu WebGPU runtime

This directory packages the JavaScript runtime used by Chrome's optional
**Bonsai 27B** Apocalypse text model. LFM2.5 2.6B still runs through the
Transformers.js / ONNX worker. Bonsai cannot share that path: the 27B
checkpoint is a 1-bit GGUF hybrid (Qwen 3.5/3.6) that needs custom WGSL
kernels.

- **Apocalypse Mode -> Bonsai 27B local chat** is an opt-in alternative to
  LFM2.5 2.6B. Enabling Apocalypse Mode still starts the 1.55 GB LFM download.
  Bonsai is never auto-downloaded.
- Model **weights are not bundled**. The worker streams
  `prism-ml/Bonsai-27B-gguf` / `Bonsai-27B-Q1_0.gguf` (~3.8 GB) from Hugging
  Face and caches it in the `bitgpu-models-v1` Cache Storage bucket.
- Tokenizer JSON is fetched from `prism-ml/Bonsai-27B-unpacked`.
- The committed `models/bonsai-27b-gguf/manifest.json` and
  `Bonsai-27B-Q1_0.aux.bin` are the tiny sidecar files bitgpu needs so it does
  not reconstruct the GGUF header in the browser.

Firefox does not package this directory. There is no Firefox WebGPU LLM
runtime.

## Packaged files

| File / directory | Source | Purpose |
| --- | --- | --- |
| `index.js` | `bitgpu` 0.19.1 | `createEngine` + inlined WGSL kernels |
| `chat.js` | `bitgpu` 0.19.1 | `createChat` (bundles `@huggingface/tokenizers` and `@huggingface/jinja`) |
| `models/bonsai-27b-gguf/manifest.json` | bitgpu `v0.19.1` models tree | Tensor map for the 27B GGUF |
| `models/bonsai-27b-gguf/Bonsai-27B-Q1_0.aux.bin` | bitgpu `v0.19.1` models tree | Lookup tables (1.5 KB) |
| `LICENSE` | bitgpu 0.19.1 | MIT |
| `THIRD_PARTY_LICENSES.md` | bitgpu 0.19.1 | Apache-2.0 notices for bundled tokenizer/jinja |
| `package.json` | bitgpu 0.19.1 | Pinned version metadata |

Remote executable code is not allowed by Manifest V3 CSP. Only model, tokenizer,
and config bytes are fetched from Hugging Face.

Do not import bitgpu from a CDN at runtime. Bump this directory as a unit when
the engine or 27B sidecar files change.

## Runtime contract

The dedicated worker loads Bonsai with:

- `kvCache: 'q8'`
- `activation: 'f16'` (falls back to f32 without `shader-f16`)
- `maxSeqLen: 4096` (not the model's 262K window)
- `think: true` and `thinkBudget: 128`

GPU-resident LFM and Bonsai sessions are never live at the same time. Disk
caches may coexist.
