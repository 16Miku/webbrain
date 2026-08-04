# Training runbook

## Why this is not ordinary projector tuning

DeepSeek V4 uses token-ID hash routing in its first hash-routed MoE layers. Upstream code
accepts custom embeddings, but the routers still require discrete IDs. The project carries
two parallel representations:

1. `inputs_embeds`: text embeddings with projected image patches scattered into image slots.
2. `routing_ids`: original text IDs plus a deterministic, versioned palette for image slots.

The language model parameters stay frozen, but it must remain inside autograd: gradients
must travel from the token loss, through DeepSeek, into the projector. Wrapping DeepSeek in
`torch.no_grad()` would silently prevent learning.

The released DeepSeek V4 Flash checkpoint is FP4 experts plus FP8 elsewhere. The SGLang
repack expands it to block-FP8, but the current DeepGEMM/Triton inference operators do not
register input-gradient formulas. They can run the frozen backbone forward, but cannot pass
the token-loss gradient back to the projector. Convert the repack to BF16 once before any
training gate. The checked-in converter folds each 128x128 scale block shard-by-shard, writes
atomically, and supports `--resume`:

```bash
.venv/bin/hf download sgl-project/DeepSeek-V4-Flash-FP8 \
  --revision ae01d80c06cdfe30581edfd0e1c5449dc7ed7f17

.venv/bin/deepseek-vision dequantize-checkpoint \
  /path/printed/by/hf-download \
  artifacts/models/deepseek-v4-flash-bf16 \
  --resume
```

Plan for about 274 GB of source weights plus 542 GiB of BF16 output while converting. A
1 TB volume is the minimum practical conversion workspace; delete the FP8 cache only after
the BF16 checkpoint has loaded and passed a forward/backward checksum gate.

## Data gates

Normalize data into four required string fields: `id`, `image`, `question`, and `answer`.
The example mix is deliberately broad rather than 100k generic captions:

| Slice | Examples |
|---|---:|
| General VQA | 25,000 |
| Captioning and grounding | 20,000 |
| OCR and documents | 20,000 |
| Charts and diagrams | 15,000 |
| Science and spatial reasoning | 10,000 |
| UI screenshots | 10,000 |

Before training, record dataset licenses, remove evaluation-set contamination, deduplicate
by image hash and normalized question, verify image decoding, then record the final JSONL
SHA-256. The manifest builder is deterministic but does not replace contamination checks.

## Experiment gates

MoonViT feature caching runs in `.venv-moonvit` with Transformers 4.57.x. DeepSeek training
and the Qwen3.6 comparison run in `.venv` with the pinned Transformers 5 development build.
Do not collapse these environments: Kimi K2.6's remote model code imports APIs removed in v5.

### Gate 0: component and routing validation

- Pin every model revision to a commit SHA.
- Extract MoonViT/Qwen component weights and verify zero missing/unexpected tensors.
- Extract all three DeepSeek `tid2eid` tables and generate one shared 64-ID palette.
- Assert text routing IDs are byte-for-byte unchanged before every forward.

### Gate 1: synthetic backward

On the target 8-GPU node, run a single synthetic image batch. Verify that only projector
parameters have gradients, loss is finite, and the language/tower parameter hashes do not
change. Record peak HBM and kernel versions.

### Gate 2: 256-example overfit

Train until the batch loss clearly falls. Evaluate memorized answers and inspect generations.
A flat loss usually means broken embedding scatter, detached gradients, label masking, or
incompatible quantized backward kernels.

### Gate 3: 1,000-example timed calibration

Use production sequence and image-token distributions. Discard warm-up, then record:

- examples/hour and input tokens/second;
- HBM per GPU and host RAM;
- checkpoint and dataset I/O time;
- exact node price and projected 100k-arm cost.

Measured five-H200 result on the pinned Cauldron calibration manifest: 4,947 examples/hour,
665 input tokens/second, 125.065 GiB peak allocated HBM, and 20.213 projected training hours
per 100k arm. At $21.95/hour this is $443.68 of training compute plus approximately $1.18
for one model load. Recalibrate if the manifest, sequence budget, topology, kernels, or
checkpoint changes.

### Gate 4: 100k MoonViT arm

Use one epoch, global batch 128, AdamW, projector LR 1e-3, 3% warm-up, cosine decay, bf16
activations, and gradient norm 1.0. Save every 100 optimizer steps. These are pilot defaults,
not settled hyperparameters.

### Gate 5: Qwen3.6 A/B arm

Reset the projector to the same seeded initialization and replay the exact manifest. Take
`Qwen3_5VisionModel.last_hidden_state` before Qwen's native merger, then apply this project's
identical 2x2 merger. Do not use Qwen's native 5120-d merger output; that would change two
variables at once.

## Evaluation

At minimum use MMMU, TextVQA, DocVQA, ChartQA, AI2D, OCRBench, MathVista, and a held-out UI
slice. Add a text-only regression suite: the routing-aware wrapper must match the unmodified
DeepSeek logits when no image slots are present.

The selection rule should be fixed before results arrive: primary mean normalized vision
score, with text regression, training stability, latency, and dollars as guardrails.

## Stop conditions

Stop immediately for NaNs, changed frozen-weight hashes, text routing-ID mutation, any image
slot/feature-count mismatch, missing component weights, or an examples/hour rate that implies
more than the approved budget.
