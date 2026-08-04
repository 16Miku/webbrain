---
license: other
license_name: deepseek-mit-and-kimi-modified-mit
library_name: custom
inference: false
pipeline_tag: image-text-to-text
tags:
- multimodal
- vision-language
- deepseek-v4
- moonvit
- bf16
- adapter
- sglang
base_model:
- deepseek-ai/DeepSeek-V4-Flash
- moonshotai/Kimi-K2.6
---

# DeepSeek V4 Flash Vision (BF16 source overlay)

![deepseek-v4-vision](deepseek-vision-improved.gif)

**DeepSeek V4 Flash with sight.** This source overlay connects DeepSeek's
reasoning and agentic model to the MoonViT vision encoder from
[Kimi-K2.6](https://huggingface.co/moonshotai/Kimi-K2.6) through WebBrain's
trained, routing-aware PatchMerger projector.

The text backbone and vision tower remain frozen. The only newly trained
parameters are the **40,119,040-parameter projector** that merges each 2x2 group
of MoonViT patches and maps the resulting 4608-dimensional representation into
DeepSeek's 4096-dimensional token space. Original text routing IDs are
preserved; image positions receive deterministic routing IDs from a fixed
64-ID palette.

## Why vision at WebBrain

At [WebBrain](https://www.webbrain.one), we build browser agents that need to
understand the visual state of the web—not just extracted text. Screenshots,
charts, dashboards, rich editors, and the location and appearance of controls
are part of real browser work, so vision is a practical product requirement.

In our
[American–Chinese open-model frontier benchmark](https://www.webbrain.one/blog/american-chinese-open-model-frontier-gap-benchmark),
DeepSeek V4 Flash stood out as a very strong and cost-efficient model, but the
upstream checkpoint is text-only. This project adds a MoonViT vision bridge
while keeping both the language backbone and vision tower frozen.

> [!IMPORTANT]
> This repository is a BF16 vision source overlay, not a complete 291B BF16
> checkpoint. It contains the genuine BF16 MoonViT tower, trained BF16
> projector, processor, routing bridge, and SGLang integration source. It does
> not contain or claim a full-BF16 conversion of the DeepSeek text backbone.

| Component | Detail |
|---|---|
| Text backbone | DeepSeek V4 Flash, 284B total / 13B active MoE, 4096 hidden size — **referenced, not duplicated** |
| Text reference | [`deepseek-ai/DeepSeek-V4-Flash`](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash) at an immutable revision; upstream tensors use mixed formats |
| Vision tower | MoonViT-3d from [Kimi-K2.6](https://huggingface.co/moonshotai/Kimi-K2.6), 416,866,032 parameters, 1152-dimensional patch features — **included in BF16 and frozen** |
| Projector | `LayerNorm -> 2x2 merge -> Linear(4608, 4608) -> GELU -> Linear(4608, 4096)` — **included and trained in BF16** |
| Projector size | 40,119,040 trainable parameters |
| Routing bridge | Text routing IDs preserved; image positions cycle through a deterministic 64-ID expert palette |
| Training envelope | Up to 512 merged image tokens inside 2,048-token training sequences |
| Backbone context | 1,048,576 tokens, inherited from DeepSeek V4 Flash |
| Serving integration | Custom, version-pinned SGLang external model and processor; stock support is not available |

## Build status

- [x] Pin the official DeepSeek V4 Flash text reference.
- [x] Extract and fingerprint-verify the frozen BF16 MoonViT tower.
- [x] Pass real BF16 H200 forward/backward, overfit, and calibration gates.
- [x] Materialize and cache the 100,000-example MoonViT training set.
- [x] Finish the 100,000-example MoonViT projector run.
- [x] Package the BF16 tower, final projector, routing bridge, and serving glue.
- [x] Pass reference BF16 image inference and KV-cache/full-prefix token parity.
- [ ] Run a fresh full-model GPU loader and smoke test for each chosen text
  checkpoint and SGLang build.

## Included BF16 artifacts

| File | Contents | Size | SHA-256 |
|---|---|---:|---|
| `vision_tower.safetensors` | Frozen MoonViT-3d tower, 329 tensors, all BF16 | 833,765,768 bytes | `1382c41f1a4afc91791ade630e2b1e1cef68cc5a1e09668a45970a5d5e1b8f15` |
| `mm_projector.safetensors` | Trained 40,119,040-parameter PatchMerger projector, 6 tensors, all BF16 | 80,238,568 bytes | `7024d9d5c9714c7abbc09abda015f083b7d7b107745eb78879f019bf4721577a` |

Machine-readable provenance is in
[`VISION_ADAPTER_MANIFEST.json`](VISION_ADAPTER_MANIFEST.json).

## Provenance

- Text reference: [`deepseek-ai/DeepSeek-V4-Flash`](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)
  at immutable revision
  [`60d8d70770c6776ff598c94bb586a859a38244f1`](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/commit/60d8d70770c6776ff598c94bb586a859a38244f1).
- Vision source: [`moonshotai/Kimi-K2.6`](https://huggingface.co/moonshotai/Kimi-K2.6)
  at revision
  [`7eb5002f6aadc958aed6a9177b7ed26bb94011bb`](https://huggingface.co/moonshotai/Kimi-K2.6/commit/7eb5002f6aadc958aed6a9177b7ed26bb94011bb),
  extracted from the frozen `vision_tower.` namespace without changing tensor
  dtype.
- Projector: the final WebBrain MoonViT projector trained in BF16 on the frozen
  tower and a frozen BF16 reconstruction used for gradient-compatible reference
  training.
- Packaging source: verified vision artifacts and serving glue from
  [`webbrain-one/DeepSeek-V4-Flash-Vision-NVFP4`](https://huggingface.co/webbrain-one/DeepSeek-V4-Flash-Vision-NVFP4).
  No NVFP4 text shard is included here.

## Usage

The repository includes a staging script rather than pretending to be a
standalone Transformers checkpoint:

```bash
# MODEL_DIR must already contain a compatible DeepSeek V4 text checkpoint,
# including config.json and model.safetensors.index.json.
cp vision_tower.safetensors mm_projector.safetensors "$MODEL_DIR/"
python scripts/prepare_sglang_model_repo.py "$MODEL_DIR" --source-root "$PWD"
```

Then use the custom SGLang launch wrapper documented in
[`docs/SGLANG_DEPLOYMENT.md`](docs/SGLANG_DEPLOYMENT.md). Stock SGLang does not
know how to inject MoonViT embeddings into DeepSeek V4 routing. The integration
requires the checked-in external model/processor package and a narrow,
version-pinned SGLang source patch.

The first supported correctness endpoint is native `/generate` with one literal
`<image>` marker. OpenAI `/v1/chat/completions` image parts are not yet supported
by this source package.

## Status and limitations

- The two published component files are genuine BF16 tensors and have been
  hash-checked.
- Reference BF16 multimodal inference and KV-cache/full-prefix parity passed
  during the original training run.
- The complete DeepSeek text backbone is not included and is not represented as
  BF16.
- The custom SGLang package is a deployment integration, not upstream stock
  support.
- A fresh full-model GPU loader/smoke test is still required for each chosen
  text checkpoint and SGLang build.

## Method credit

The overall construction and model-card approach was inspired by
[Baseten's GLM-5.2-Vision-NVFP4](https://huggingface.co/baseten/GLM-5.2-Vision-NVFP4):
keep the text backbone and MoonViT tower frozen, train a compact PatchMerger
projector between them, and publish provenance and hardware constraints
explicitly. Credit to the Baseten team for demonstrating this practical recipe.

This project adds a DeepSeek-specific routing bridge so mixed text/image
embeddings preserve hash-routed text behavior. It does not reuse Baseten model
weights, benchmark results, or deployment artifacts.

## Licenses

The DeepSeek text reference is covered by
[`LICENSE_DEEPSEEK_V4_FLASH`](LICENSE_DEEPSEEK_V4_FLASH). The extracted MoonViT
tower is covered by [`LICENSE_KIMI_K2.6`](LICENSE_KIMI_K2.6). The newly trained
projector and integration source are provided under [`LICENSE`](LICENSE);
downstream users remain responsible for complying with both upstream licenses.

## Acknowledgements

Built on
[DeepSeek AI's DeepSeek V4 Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)
and [Moonshot AI's Kimi-K2.6](https://huggingface.co/moonshotai/Kimi-K2.6), with
the vision-attachment method inspired by
[Baseten's GLM-5.2-Vision-NVFP4](https://huggingface.co/baseten/GLM-5.2-Vision-NVFP4).
These teams were not involved in this development checkpoint; please do not
direct issues with this repository to them.

## Want this model on your inference provider?

Ask your inference provider—such as OpenRouter or another managed inference
service—to deploy this overlay together with a compatible DeepSeek V4 Flash
text checkpoint and the included multimodal serving plugin. Deploying only the
upstream text model will not enable image input.
