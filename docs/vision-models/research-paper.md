# Routing-Aware MoonViT Adapters for Frozen Mixture-of-Experts Code Models

## A technical report on DeepSeek V4 Flash Vision and Laguna XS 2.1 Vision

**Version:** 2026-08-04

**Status:** reproducibility-oriented technical report; not peer reviewed

## Abstract

This report describes two experiments that retrofit image understanding onto frozen
mixture-of-experts language models: DeepSeek V4 Flash and Laguna XS 2.1. Both systems use a
frozen 416.9M-parameter MoonViT-3d tower extracted from Kimi K2.6 and a small trainable
patch-merger projector. The projector merges each 2x2 group of 1152-dimensional vision
features and maps the result into the target language model's embedding width. Language
model and vision tower parameters remain frozen; only six projector tensors are optimized.

DeepSeek V4 adds a non-standard systems constraint: early mixture-of-experts layers use
token-ID hash routing even when callers provide embeddings. We therefore preserve original
text token IDs in a parallel routing stream and assign image slots a deterministic 64-ID
palette derived from the model's routing tables. Training also required reconstructing a
542 GiB BF16 DeepSeek checkpoint because the released FP4/FP8 inference kernels could not
propagate gradients to their inputs. Laguna's conventional embedding path removed both
requirements and enabled a four-GPU data-parallel run.

Both 100,000-example, one-epoch projectors reached step 782 and were published with the
same frozen tower. Laguna's complete private archive records an initial step loss of 4.9084,
a final step loss of 0.7318, and a minimum step loss of 0.6835. DeepSeek's full final-run
telemetry was not retained with equal completeness, so this report makes no final-loss or
cross-model quality comparison. The main contribution is a reproducible systems recipe,
artifact provenance, a bounded DeepSeek NVFP4-on-B200 serving smoke, and an explicit
account of what remains unvalidated.

## 1. Motivation and research questions

The practical question was whether an existing, text-specialized code model could acquire a
useful image input path without updating its very large language backbone. A frozen-tower,
frozen-language-model design reduces the trainable state to tens of millions of parameters,
but it still requires gradients to traverse the complete language model and return to the
projector.

The experiments addressed four questions:

1. Can MoonViT pre-merger features be projected into two different frozen text embedding
   spaces with the same basic architecture and data pipeline?
2. Can DeepSeek V4's token-ID hash routing be preserved while image embeddings replace
   placeholder token embeddings?
3. What compute, memory, and recovery behavior does projector-only tuning exhibit on H200
   and Blackwell-class multi-GPU hosts?
4. Can the resulting components be packaged with immutable upstream provenance and
   independently verifiable hashes?

The experiments did **not** establish benchmark superiority, equivalence between BF16 and
NVFP4 inference, or production serving readiness. A later B200 smoke establishes only that
the pinned DeepSeek package can complete basic end-to-end image requests.

## 2. Method

### 2.1 Shared visual path

Both models use MoonViT-3d from
[`moonshotai/Kimi-K2.6`](https://huggingface.co/moonshotai/Kimi-K2.6) revision
`7eb5002f6aadc958aed6a9177b7ed26bb94011bb`. The extracted tower contains 329 BF16 tensors
and 416,866,032 parameters. It returns grouped features shaped as
`[image_tokens, 4, 1152]`; the four patch vectors are flattened to 4608 dimensions.

The projector is:

```text
LayerNorm(1152)
  -> flatten each 2x2 patch group to 4608
  -> Linear(4608, 4608)
  -> GELU
  -> Linear(4608, text_hidden_size)
```

Only the target width differs:

| Property | DeepSeek V4 Flash | Laguna XS 2.1 |
|---|---:|---:|
| Text embedding width | 4096 | 2048 |
| Trainable parameters | 40,119,040 | 30,679,808 |
| Trainable tensors | 6 | 6 |
| Final projector size | 80,238,568 bytes | 61,360,104 bytes |
| Projector dtype | BF16 | BF16 |

The image is resized to fit at most 512 merged MoonViT tokens. Projected features replace
zero-valued image placeholder positions inside `inputs_embeds`. The supervised objective is
the ordinary next-token loss over the answer suffix. The tower and language model remain
frozen, but the language model is not wrapped in `no_grad`: input gradients must flow through
it to the projector.

### 2.2 DeepSeek routing bridge

DeepSeek V4's first hash-routed expert layers require discrete token IDs independently of
the continuous embeddings. Supplying only `inputs_embeds` would either lose routing state or
route image positions through meaningless placeholder IDs.

The adapter carries two synchronized representations:

- `inputs_embeds`: normal text embeddings with projected MoonViT vectors scattered into
  image positions;
- `routing_ids`: the original, byte-for-byte text IDs plus a deterministic palette-cycle ID
  for every image position.

The checked-in 64-ID palette was derived from all three `tid2eid` tables at
`deepseek-ai/DeepSeek-V4-Flash` revision
`60d8d70770c6776ff598c94bb586a859a38244f1`. The palette covers 734 layer-qualified experts
with a maximum load of three. Tests assert text-only logit parity, unchanged text routing
IDs, finite projector gradients, and zero language-model gradients.

### 2.3 Why DeepSeek training used BF16 reconstruction

The released DeepSeek FP4/FP8 checkpoints are suitable for inference but their tested
DeepGEMM/Triton paths did not register the input-gradient formula needed here. A frozen model
still needs that formula: the derivative of token loss with respect to input embeddings is
the projector's learning signal.

The source workflow therefore streamed
[`sgl-project/DeepSeek-V4-Flash-FP8`](https://huggingface.co/sgl-project/DeepSeek-V4-Flash-FP8)
revision `ae01d80c06cdfe30581edfd0e1c5449dc7ed7f17` into a BF16 reconstruction. The completed
conversion contained 46 shards, 35,020 indexed tensors, and 581,975,531,080 output bytes
(542.007 GiB). It converted 34,123 scaled weights, left all 34,600 weight tensors in BF16,
and retained no FP8 scale tensors or partial output files.

### 2.4 Data

The final Laguna run materialized 100,000 train-only examples from
[`HuggingFaceM4/the_cauldron`](https://huggingface.co/datasets/HuggingFaceM4/the_cauldron)
revision `847a98a779b1652d65111daf20c972dfcd333605`, seed `20260802`, and shuffle buffer 512.
The manifest SHA-256 is
`1d1961eee90cb3bad1ee3fb75f79e38d636ef406bb2a2539581c442a3c0ae4bb`. It contains no
evaluation split.

| Cauldron configuration | Examples |
|---|---:|
| VQAv2 | 25,000 |
| TextCaps | 7,500 |
| DocVQA | 10,000 |
| TextVQA | 7,500 |
| ChartQA | 10,000 |
| PlotQA | 10,000 |
| AI2D | 5,000 |
| ScienceQA | 5,000 |
| CLEVR | 10,000 |
| Screen2Words | 5,000 |
| WebSight | 5,000 |

Images and normalized question-answer pairs were checkpointed per source configuration so
fetching could resume without replaying completed configurations. Vision features were then
deduplicated by image and cached once. Each cached example stores token IDs, an image mask,
attention mask, labels, and a relative reference to the shared BF16 vision feature.

The DeepSeek 1,000-example calibration slice used the same dataset revision and produced a
manifest SHA-256 of
`88f107ff93266e94f683f91eff548378ff3625e32468ef24339a2eae085e2d3b`. Its 481 unique images
had realistic sequence-length and image-token distributions. The final DeepSeek private
archive does not retain a comparably authoritative final 100K manifest record, so the Laguna
100K hash above must not be silently attributed to DeepSeek.

### 2.5 Optimization

Both 100K configurations used one epoch, effective/global batch 128, AdamW, learning rate
`1e-3`, zero weight decay, 3% linear warm-up, cosine decay to zero, BF16 activations, and
gradient-norm clipping at 1.0. The deterministic seed was `20260802`. Laguna used four DDP
processes, one example per microbatch and 32 local accumulation steps. DeepSeek used one
model-parallel process across the H200 node with 128-example gradient accumulation.

## 3. Systems validation

### 3.1 DeepSeek H200 gates

The DeepSeek path was gated progressively before a full run:

- A six-H200 real backward gate loaded the 542 GiB model in 188.057 seconds and completed
  forward plus backward in 1.842 seconds with finite loss 4.029584884643555.
- All six projector tensors received finite gradients; no DeepSeek parameter received a
  gradient; original text routing IDs were preserved.
- Peak allocated HBM ranged from 58.079 to 106.189 GiB across the six GPUs.
- A five-H200 production-length gate handled sequences up to 1,267 tokens with 125.065 GiB
  peak allocated HBM on the busiest H200.
- A 256-example, four-epoch overfit gate reduced step loss from 3.566793 to 1.133697, with a
  minimum of 0.648905.
- The 1,000-example production-mix calibration sustained 4,947 examples/hour and 665 input
  tokens/second. It projected 20.213 hours per 100K arm and $443.68 of training compute at
  $21.95/hour, plus approximately $1.18 for a single model load.

The cost figure is a calibration projection, not a reconstructed invoice for the final run.

### 3.2 Laguna Blackwell run

Laguna was trained with four RTX PRO 6000 Blackwell Server Edition GPUs and a frozen BF16
Laguna backbone pinned to `poolside/Laguna-XS-2.1` revision
`e9df9a59996d790b94b70f3fef343fe1d9e34bdf`. The cache stage completed on four GPUs before
the DDP trainer started.

The run was interrupted after step 384 and resumed from the last durable step-380 checkpoint.
Steps 381 through 384 therefore appear twice in `training.log`. The final archive contains
782 optimizer steps and 100,000 cumulative examples.

| Laguna metric | Observed value | Interpretation |
|---|---:|---|
| First logged step loss | 4.9083744953 | Step 1 of the initial segment |
| Final step loss | 0.7318046561 | Step 782 |
| Minimum logged step loss | 0.6835096142 | Step 476 |
| Final learning rate | 0 | End of cosine schedule |
| Peak allocated HBM | 65.626 GiB | Maximum across DDP ranks during resumed segment |
| Peak reserved HBM | 67.508 GiB | Maximum across DDP ranks during resumed segment |
| Resumed-segment elapsed time | 44,432.623 s | Excludes work before the step-380 resume |
| Resumed-segment throughput | 4,161.267 examples/hour | Uses only examples replayed/processed after resume |
| Projected uninterrupted time | 24.031 h/100K | Projection from the resumed segment, not measured end-to-end wall time |

At the recorded $7.96/hour node price, the resumed training segment corresponds to roughly
$98.25 of GPU time. This is not the full experiment cost: the initial training segment,
dataset fetch, cache construction, packaging, and any interruption interval require separate
billing records. The log timestamps imply roughly another 11.8 hours between initial launch
and the restart, but that value is diagnostic rather than invoice-grade.

## 4. Published artifacts

| Component | DeepSeek V4 Flash | Laguna XS 2.1 |
|---|---|---|
| Public NVFP4 package | 74 files, 169,215,268,442 bytes | 22 files, 22,491,749,196 bytes |
| Public BF16 package | 25 files, 915,678,201 bytes; vision overlay only | 34 files, 67,794,842,815 bytes; complete text package |
| Tower SHA-256 | `1382c41f1a4afc91791ade630e2b1e1cef68cc5a1e09668a45970a5d5e1b8f15` | `befe801bd7dfe8bf5630fef56a7f53c2235065599ca9eea4d995040e2e6fd183` |
| Projector SHA-256 | `7024d9d5c9714c7abbc09abda015f083b7d7b107745eb78879f019bf4721577a` | `7837384f18be69a4f875ca44a8ed69ec186501d70896daf4b305fa77547974de` |
| Private run archive | Partial bring-up/calibration archive | Full 170-file, 14,543,120,986-byte training archive |

The tower hashes differ even though both originate from the same Kimi revision. Reproducers
must use the component hash associated with each package rather than assume byte identity.
The exact final repository revisions and URLs are listed in the [index](README.md) and
machine-readable [artifact manifest](sources/ARTIFACTS.json).

### 4.1 DeepSeek B200 serving smoke

On 2026-08-04, the pinned DeepSeek SGLang integration completed full NVFP4 loading and two
consecutive image requests on NVIDIA B200 with four-way tensor parallelism. The native
SGLang `/generate` endpoint produced a taxi-scene answer from 294 image tokens in 6.95
seconds and a cat/person answer from 532 image tokens in 2.52 seconds; the server remained
healthy. This demonstrates a working package path through MoonViT, the trained projector,
DeepSeek embeddings, and routing IDs. It is not a benchmark, text-only parity result,
production SLA, or validation of the OpenAI multimodal chat route.

## 5. Interpretation

The experiments show that projector-only tuning is mechanically feasible for both targets:
the training signal reaches a six-tensor adapter through a frozen model, final finite
projectors can be packaged with immutable provenance, and recovery from an interrupted DDP
run can preserve optimizer and scheduler state.

The more important result is architectural. A generic “replace token embeddings with image
features” adapter is insufficient for DeepSeek V4 because embeddings and expert-routing IDs
have different semantics. Preserving both streams makes the adapter compatible with the
hash-routed model without changing text routing. Laguna, by contrast, accepts the ordinary
embedding-scatter design and can use straightforward DDP.

The results do not support a quality ranking between the two models. Their embedding widths,
language backbones, hardware, process topologies, telemetry completeness, and serving stacks
differ. The Laguna loss curve proves optimization occurred, not that the model generalizes.
The DeepSeek gates prove the routing-aware gradient path, reference inference behavior, and
a bounded NVFP4-on-B200 image-serving path, not final benchmark quality.

## 6. Reproducibility and failure recovery

Three practices materially improved reproducibility:

1. Every upstream model and dataset was pinned to an immutable revision, and every published
   tower/projector has a recorded SHA-256.
2. Dataset fetching, weight conversion, feature caching, and checkpoints were written
   atomically and made resumable. Laguna's archive demonstrates recovery from step 380 with
   optimizer and scheduler state intact.
3. Cloud guards separated a fixed budget deadline from verified-work liveness. Credentials
   remained in macOS Keychain rather than pod files, process lists, launch agents, or logs.

The companion [reproducibility runbook](reproducibility.md) turns these principles into an
executable sequence. The [source appendix](sources/README.md) preserves the relevant code
without duplicating large or licensed model weights in this repository.

## 7. Limitations and threats to validity

- **No final benchmark suite.** MMMU, TextVQA, DocVQA, ChartQA, AI2D, OCRBench, MathVista,
  and the held-out UI slice were planned but no complete final result table is archived.
- **Incomplete DeepSeek run telemetry.** The final projector exists and the public card
  records 100K completion, but the private archive predates the run and does not provide the
  full checkpoint/optimizer/loss history available for Laguna.
- **Resume-sensitive Laguna metrics.** The final summary combines a cumulative completion
  counter with resumed-session timing. It must not be read as a single uninterrupted run.
- **Serving gaps.** Laguna's main packages have no validated multimodal processor/server;
  an NVFP4 `sglang-integration` candidate exists at
  `740a6ccc05441a7ea0426c1d2536d5cd031adb86` but has no loader or image smoke. DeepSeek's
  pinned B200 image smoke passed, but it still requires a custom SGLang source patch;
  stock SGLang, OpenAI multimodal chat, text-only parity, and broader production validation
  remain unsupported or incomplete.
- **No completed tower ablation.** The Qwen3.6 comparison arm remains a source-level plan.
- **Quantization equivalence not shown.** BF16 training success does not establish identical
  behavior for the packaged NVFP4 backbones.
- **Data mixture bias.** Several quotas oversample relatively small source configurations;
  the resulting training distribution is intentional but not a natural population sample.
- **Single seed.** Both experiments use seed `20260802`; variance across initializations was
  not measured.

## 8. Licensing and responsible use

The packages combine components with different licenses. Reproduction and redistribution
must follow the license files shipped with each pinned text backbone and Kimi K2.6. The
private archives should remain access controlled because they contain operational training
history, even though this appendix excludes credentials and model weights.

The models should not be represented as production-ready visual agents until held-out
evaluation, prompt-injection testing, image-content safety testing, and end-to-end serving
validation are complete.

## 9. Conclusion

A frozen MoonViT tower plus a small patch-merger projector can provide a practical image
input path for two distinct mixture-of-experts code models. Laguna demonstrates the simpler
DDP case and preserves a strong recovery archive. DeepSeek demonstrates the harder systems
case: routing IDs must remain separate from image embeddings, and training requires a
gradient-compatible BF16 backbone even when deployment targets a quantized checkpoint.

The current artifacts are best viewed as reproducible research checkpoints. Their component
integrity, training mechanics, and DeepSeek's bounded B200 image-serving path are
documented; comparative visual quality and production-serving behavior remain open
experimental questions.
