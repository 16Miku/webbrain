# SGLang deployment status

## Short answer

The current Hugging Face model directory is **not** a stock-SGLang multimodal model.
SGLang natively implements the DeepSeek V4 text runtime and Kimi's MoonViT, but it does
not know that this particular checkpoint combines them.  The integration in
`sglang_ext/deepseek_vision_sglang` is an external SGLang model/processor package and
requires one narrow source patch.  Do not describe it as upstream or zero-code support.

The package is pinned to SGLang commit
`fdebc938f7f4d16fe6b9f55dcd9a767cf0899ea1` (the SGLang v0.5.16 endpoint image):

- SGLang's [external model registry](https://github.com/sgl-project/sglang/blob/fdebc938f7f4d16fe6b9f55dcd9a767cf0899ea1/python/sglang/srt/models/registry.py)
  supports `SGLANG_EXTERNAL_MODEL_PACKAGE`.
- Its [tokenizer manager](https://github.com/sgl-project/sglang/blob/fdebc938f7f4d16fe6b9f55dcd9a767cf0899ea1/python/sglang/srt/managers/tokenizer_manager.py#L459-L468)
  loads `SGLANG_EXTERNAL_MM_PROCESSOR_PACKAGE` through the multimodal processor
  registry.
- The native [Kimi K2.5 model](https://github.com/sgl-project/sglang/blob/fdebc938f7f4d16fe6b9f55dcd9a767cf0899ea1/python/sglang/srt/models/kimi_k25.py)
  supplies MoonViT and PatchMerger kernels.
- The native [DeepSeek V4 model](https://github.com/sgl-project/sglang/blob/fdebc938f7f4d16fe6b9f55dcd9a767cf0899ea1/python/sglang/srt/models/deepseek_v4.py)
  currently accepts `input_embeds` but ignores it at the embedding site.  The checked-in
  patch changes that one assignment while keeping `input_ids` for hash routing.

## What the extension does

1. The external processor recognizes one literal `<image>` marker and uses the official,
   revision-pinned Kimi K2.6 processor for NaViT resize/normalization/patchification.
2. A DeepSeek-specific `KimiGPUProcessorWrapper` subclass counts decoded tensor images
   with the same `navit_resize_config` and private sizing parameters as Kimi, then
   overwrites both GPU and CPU processor `input_ids` with one DeepSeek out-of-vocabulary
   sentinel per image token. Literal `<image>` is never retokenized as ordinary text.
3. SGLang's native MoonViT implementation loads `vision_tower.safetensors`.
4. The native Kimi PatchMerger shape loads the trained `mm_projector.safetensors` and
   emits 4096-d DeepSeek embeddings.
5. Image positions are replaced in `inputs_embeds`.  A separate tensor preserves every
   text token ID and cycles the checked-in 64-ID route palette over image positions.
6. The routing phase uses absolute image offsets, so chunked-prefill boundaries do not
   restart the palette.
7. Route substitution runs only in SGLang extend/prefill mode. SGLang retains
   `mm_inputs` on decode batches after removing the extend-only offset metadata; decode
   therefore returns a clone of the generated token IDs without reapplying image routes.

Keeping the architecture string `DeepseekV4ForCausalLM` is intentional.  SGLang selects
its V4 attention, memory-pool, and FP4 expert behavior from that exact name; the external
registry overwrites only the instantiated model class.

## Stage a model directory

Download the private model repository to a local directory that contains the backbone
shards, `vision_tower.safetensors`, and `mm_projector.safetensors`.  Then run:

```bash
python scripts/prepare_sglang_model_repo.py /models/deepseek-v4-flash-vision
```

This makes three reviewable packaging changes:

- adds `vision_config` and `deepseek_vision` metadata to `config.json`;
- adds both standalone component files to `model.safetensors.index.json` (SGLang ignores
  safetensor files that are absent from an existing index);
- copies the standalone extension to `MODEL_DIR/sglang_ext`.

Upload that staged directory to the private deployment repository only after reviewing
the diff.  The script does not contact Hugging Face.

## Install and launch

Use the exact SGLang commit documented above.  Set the model snapshot's extension path,
then launch through the checked-in wrapper:

### Pinned B200 startup profile

The following matrix has passed dependency import, full NVFP4 shard loading, model
initialization, server startup, and two live image-response smoke tests on B200. Treat
this as a pinned, bounded smoke profile rather than a production-readiness claim.

| Component | Verified value |
|---|---|
| Base image | `lmsysorg/sglang:deepseek-v4-blackwell` |
| SGLang source | `fdebc938f7f4d16fe6b9f55dcd9a767cf0899ea1` installed with `pip install -e python` |
| Python / CUDA | Python 3.12, CUDA 13 runtime paths from the base image |
| PyTorch | `2.11.0+cu130` |
| SGLang package | `0.0.0.dev1+gfdebc938f.d20260804` |
| FlashInfer Python | `0.6.14` |
| FlashInfer JIT cache | `0.6.14+cu130` |
| FlashInfer cubin | `0.6.13` |
| SGL DeepGEMM | `0.1.4.post1` |

Inside that image, pin the source and replace the older bundled FlashInfer cubin before
launching:

```bash
cd /workspace/sglang
git fetch origin fdebc938f7f4d16fe6b9f55dcd9a767cf0899ea1
git checkout fdebc938f7f4d16fe6b9f55dcd9a767cf0899ea1
python3 -m pip install -e python
python3 -m pip uninstall -y flashinfer-cubin
python3 -m pip install \
  --extra-index-url https://flashinfer.ai/whl/cu130 \
  'flashinfer-jit-cache==0.6.14+cu130' \
  'flashinfer-cubin==0.6.13'
```

The currently available Python and cubin wheels differ by one patch version. The launch
wrapper sets `FLASHINFER_DISABLE_VERSION_CHECK=1` only for the explicit
`blackwell-native` profile and prepends the CUDA 13, PyTorch, TVM-FFI, CUDA, and NVIDIA
library paths used by the verified image. It selects the native Blackwell backends:

```text
--fp4-gemm-backend flashinfer_trtllm
--moe-runner-backend flashinfer_trtllm_routed
```

Startup logs must identify the hybrid FP8+NVFP4 checkpoint, `DeepseekV4AttnBackend`, and
the FlashInfer TRTLLM routed MoE backend. A Marlin log indicates that this native profile
was not selected.

### Wrapper launch

```bash
export DEEPSEEK_VISION_MODEL_PATH=/models/deepseek-v4-flash-vision
export DEEPSEEK_VISION_PYTHONPATH="$DEEPSEEK_VISION_MODEL_PATH/sglang_ext"
export DEEPSEEK_VISION_KERNEL_PROFILE=blackwell-native
export DEEPSEEK_VISION_TP=4
export DEEPSEEK_VISION_CONTEXT_LENGTH=4096
export DEEPSEEK_VISION_MEM_FRACTION_STATIC=0.85
export DEEPSEEK_VISION_HOST=0.0.0.0
scripts/launch_sglang_moonvit.sh
```

For a Hugging Face integration branch, download that revision into the local model
directory and also set `DEEPSEEK_VISION_REVISION` if `DEEPSEEK_VISION_MODEL_PATH` is a
Hub model ID.  For example, the pre-merge smoke branch uses:

```bash
export DEEPSEEK_VISION_REVISION=sglang-integration
```

The wrapper verifies/applies the checked-in narrow SGLang patch set before startup and exports all
three official external-registration variables.  It disables CUDA graphs for the first
correctness gate.  Re-enable performance features only after text-only parity and image
parity pass on the pinned build.

The decode-lifecycle regression is CPU-only and should pass before a GPU launch:

```bash
python3 -m unittest tests/test_sglang_routing.py
```

## First request

The first gate uses SGLang's native `/generate` endpoint.  It avoids an upstream OpenAI
chat-rendering limitation: the current DeepSeek V4 chat encoder explicitly flattens
parts-list content as text-only before multimodal processing.  Calling the OpenAI
`/v1/chat/completions` route with `image_url` is therefore **not yet supported by this
extension**.

Use the exact prompt shape used for projector training:

```bash
curl http://127.0.0.1:30000/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "text":"<｜begin▁of▁sentence｜><｜User｜><image>Describe this image.<｜Assistant｜></think>",
    "image_data":"data:image/jpeg;base64,...",
    "sampling_params":{"temperature":0,"max_new_tokens":64}
  }'
```

Or use the checked-in smoke client, which builds the data URL and rejects an empty
generation response:

```bash
python scripts/smoke_sglang_moonvit.py /path/to/probe.jpg
```

## Verified live image smoke

On 2026-08-04, the pinned B200 profile above remained healthy across two consecutive
image requests using the current processor, routing bridge, and packed projector output:

| Probe | Image tokens | Total prompt tokens | Observed answer content | Elapsed |
|---|---:|---:|---|---:|
| Street/taxi scene | 294 | 308 | A man, yellow vest, and taxi were identified | 6.95 s |
| Cat/person scene | 532 | — | A cat sitting on a person's shoulder was identified | 2.52 s |

These are functional smoke results, not an accuracy benchmark or a production SLA.

## Required GPU validation

CPU-only checks can validate packaging, routing math, source anchors, and Python syntax,
but cannot instantiate the 168 GB NVFP4 checkpoint or CUDA kernels. The pinned profile
has completed loader/startup and the two image requests above. Before making a broader
production-readiness claim, complete the remaining parity and coverage gates on suitable
NVIDIA hardware:

1. `python -m deepseek_vision_sglang.patch --check` against the pinned SGLang install.
2. Loader startup with the staged private model directory.
3. A text-only prompt compared token-for-token with unmodified SGLang DeepSeek V4.
4. One cached training image compared against the existing Transformers/BF16 endpoint.
5. A fresh scene and GUI screenshot, checking image-token count, route-ID count, and
   projector output shape before judging answer quality.

## Deliberate limitations

- Custom SGLang package plus a one-line source patch; no upstream support claim.
- Exactly one image per request. Projector training targeted up to 512 merged image
  tokens; the live serving smoke exercised a 532-image-token request.
- CUDA image preprocessing only; CPU-only serving is not supported.
- Tensor parallelism is intended; pipeline parallelism and encoder data parallelism are
  blocked/unvalidated.
- CUDA graphs, speculative decoding, OpenAI multimodal chat rendering, streaming parity,
  and production concurrency are not validated.
- This serving integration can fix or expose runtime integration errors.  It cannot make
  a weakly trained projector better; quality still needs the same image benchmark.
