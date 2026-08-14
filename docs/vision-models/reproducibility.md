# Reproducibility runbook

This runbook reconstructs the data, training, verification, packaging, and inference state
for the DeepSeek V4 Flash Vision and Laguna XS 2.1 Vision experiments. Commands are examples
with explicit placeholders; adapt storage paths but do not change pinned revisions, seeds,
token budgets, or hashes when reproducing the reported run.

## 1. Scope and evidence classes

Treat evidence in this order:

1. A downloaded file whose SHA-256 matches `sources/ARTIFACTS.json`.
2. An immutable Hugging Face commit URL.
3. The private Laguna run archive at its pinned commit.
4. The copied local source snapshot and historical notes.
5. A mutable Hugging Face model page or current local working tree.

The local DeepSeek source snapshot is base commit
`285a35a1c5cbff3251418013a0671b25ef78488a` plus working-tree changes. Its published
SGLang runtime subset is synchronized to the reviewed public package revisions below,
but the larger snapshot is not represented as one clean source release. See
[`sources/SOURCE_SNAPSHOT.json`](sources/SOURCE_SNAPSHOT.json).

## 2. Immutable revision ledger

| Resource | Revision |
|---|---|
| `deepseek-ai/DeepSeek-V4-Flash` routing reference | `60d8d70770c6776ff598c94bb586a859a38244f1` |
| `sgl-project/DeepSeek-V4-Flash-FP8` training reconstruction source | `ae01d80c06cdfe30581edfd0e1c5449dc7ed7f17` |
| `nvidia/DeepSeek-V4-Flash-NVFP4` package source | `e3cd60e7de98e9867116860d522499a728de1cf9` |
| SGLang source used by DeepSeek package | `fdebc938f7f4d16fe6b9f55dcd9a767cf0899ea1` |
| `poolside/Laguna-XS-2.1` BF16 source | `e9df9a59996d790b94b70f3fef343fe1d9e34bdf` |
| `poolside/Laguna-XS-2.1-NVFP4` source | `d32afde8b09af1539b49ff96ff5551c674485f8e` |
| `moonshotai/Kimi-K2.6` MoonViT source | `7eb5002f6aadc958aed6a9177b7ed26bb94011bb` |
| `HuggingFaceM4/the_cauldron` data source | `847a98a779b1652d65111daf20c972dfcd333605` |
| DeepSeek public NVFP4 final | `12b653e63329ac3c20395f9aeeb1bb8264d2db8b` |
| DeepSeek public BF16 overlay final | `60c441aa1c7386387c89ddaff703136395ad8d8b` |
| Laguna public NVFP4 final | `ce108f0f3764a18a1f5f7d14ecefa90485ea6e52` |
| Laguna public BF16 final | `b06063d00b73f7713ef1c28f8247eed488c73faf` |
| Laguna NVFP4 SGLang integration candidate | `sglang-integration` at `740a6ccc05441a7ea0426c1d2536d5cd031adb86` |
| Laguna private 100K archive | `4f5d6359867fa55315a2bec4b568901bfdeca5e5` |

## 3. Security and storage prerequisites

- Keep Hugging Face and RunPod tokens in the host's credential store. Do not write them to
  source files, shell history, plist files, pod volumes, logs, or process arguments.
- Use a persistent volume. DeepSeek conversion needs roughly 274 GiB of FP8 source plus
  542 GiB of BF16 output; 1 TiB is a practical minimum.
- Keep the MoonViT environment separate from the DeepSeek environment. The recorded stack
  used Transformers 4.57.6, PyTorch 2.8, and FlashAttention 2.8.3.post1 for Kimi's remote
  MoonViT code, and PyTorch 2.11, Triton 3.6, CUDA 12.8, and a pinned Transformers 5
  development build for DeepSeek.
- Use a fixed absolute budget deadline and a verified-work liveness guard. Never convert it
  into a blind rolling timer that silently extends the budget.
- Preserve stopped-pod storage until all final artifacts have been copied and hashed.

## 4. Source setup

The curated source is in [`sources/deepseek-v4-flash`](sources/deepseek-v4-flash). To run it
outside the documentation tree, copy it into a clean work directory and create both pinned
environments using the included scripts:

```bash
rsync -a sources/deepseek-v4-flash/ /workspace/deepseek-vision/
cd /workspace/deepseek-vision
./scripts/preflight_cloud.sh
./scripts/bootstrap_cloud.sh
./scripts/bootstrap_moonvit_env.sh
PYTHONPATH=src python3 -m deepseek_vision.cli validate-config configs/model/moonvit.json
python3 -m unittest discover -s tests -v
```

For a strict rerun, first convert this working-tree snapshot into a reviewed source commit
and record that commit. The copied snapshot itself is sufficient for audit, but not an ideal
long-term release boundary.

## 5. Build the deterministic 100K data manifest

The shared fetcher writes per-configuration checkpoints, so a retry reuses completed source
configs instead of downloading them again.

```bash
cd /workspace/deepseek-vision
.venv-moonvit/bin/python scripts/fetch_cauldron.py \
  artifacts/data/pilot100k \
  --preset pilot100k \
  --revision 847a98a779b1652d65111daf20c972dfcd333605 \
  --seed 20260802 \
  --shuffle-buffer 512

shasum -a 256 artifacts/data/pilot100k/manifest.jsonl
```

For the archived Laguna run, expect:

```text
1d1961eee90cb3bad1ee3fb75f79e38d636ef406bb2a2539581c442a3c0ae4bb  manifest.jsonl
```

Also verify `provenance.json` reports exactly 100,000 examples, the eleven quotas in the
research report, the train split, and `evaluation_splits_included: false`. A hash mismatch
means the input bytes, data library behavior, seed, shuffle buffer, or fetch code changed;
do not label the rerun equivalent.

## 6. Extract and cache MoonViT

Extract only the vision component:

```bash
.venv/bin/deepseek-vision extract-component moonshotai/Kimi-K2.6 \
  'vision_tower.' artifacts/towers/moonvit-k2.6.safetensors \
  --revision 7eb5002f6aadc958aed6a9177b7ed26bb94011bb
```

Run one cache worker per GPU. Each process receives a disjoint rank, uses its local GPU as
`cuda:0`, and atomically reuses existing features/examples:

```bash
WORLD_SIZE=4
for RANK in 0 1 2 3; do
  CUDA_VISIBLE_DEVICES="$RANK" .venv-moonvit/bin/python scripts/cache_moonvit_features.py \
    artifacts/data/pilot100k/manifest.jsonl \
    artifacts/cache/deepseek-moonvit \
    --model-config configs/model/moonvit.json \
    --max-sequence-length 2048 \
    --max-image-tokens 512 \
    --rank "$RANK" --world-size "$WORLD_SIZE" --device cuda:0 &
done
wait
```

Laguna uses its archived
[`cache_moonvit_features.py`](sources/laguna-xs-2.1/private-training-archive/code/cache_moonvit_features.py)
because its chat template and token IDs differ:

```bash
WORLD_SIZE=4
for RANK in 0 1 2 3; do
  CUDA_VISIBLE_DEVICES="$RANK" python \
    sources/laguna-xs-2.1/private-training-archive/code/cache_moonvit_features.py \
    artifacts/data/pilot100k/manifest.jsonl \
    artifacts/cache/laguna-moonvit \
    artifacts/towers/moonvit-k2.6.safetensors \
    --max-sequence-length 2048 \
    --max-image-tokens 512 \
    --rank "$RANK" --world-size "$WORLD_SIZE" --device cuda:0 &
done
wait
```

Before training, load every cached file with `torch.load(..., weights_only=True)` and verify:

- all vision features are finite BF16 and shaped `[tokens, 4, 1152]`;
- the image mask contains exactly one entry per merged feature group;
- input IDs, image mask, attention mask, and labels have equal sequence length;
- supervised labels form the intended answer suffix;
- no sequence exceeds 2048 and no image exceeds 512 merged tokens.

## 7. DeepSeek training path

### 7.1 Reconstruct a gradient-compatible backbone

```bash
.venv/bin/hf download sgl-project/DeepSeek-V4-Flash-FP8 \
  --revision ae01d80c06cdfe30581edfd0e1c5449dc7ed7f17

.venv/bin/deepseek-vision dequantize-checkpoint \
  /path/returned/by/hf-download \
  artifacts/models/deepseek-v4-flash-bf16 \
  --resume
```

Required post-conversion invariants:

```text
46 shards
34,123 scaled weights converted
581,975,531,080 output bytes
35,020 indexed tensors
34,600 BF16 weight tensors
0 FP8 tensors
0 scale tensors
0 partial files
```

Do not delete the FP8 source until a real forward/backward gate has loaded the BF16 output.

### 7.2 Validate routing and backward

The model config must retain:

```text
DeepSeek routing reference: 60d8d70770c6776ff598c94bb586a859a38244f1
routing policy: palette_cycle
palette size: 64
projector output width: 4096
projector parameter count: 40,119,040
```

Pass gates in order: source/component validation, synthetic backward, 256-example overfit,
1,000-example timed calibration, then 100K. A gate passes only if loss is finite, all six
projector tensors receive finite gradients, no language/tower parameter receives a gradient,
frozen hashes remain unchanged, text routing IDs remain exact, and image slots match features.

### 7.3 Run the 100K projector

```bash
.venv/bin/deepseek-vision train-cache \
  configs/model/moonvit.json \
  configs/train/pilot100k.json \
  artifacts/cache/deepseek-moonvit/examples \
  artifacts/runs/moonvit-pilot100k \
  --max-examples 100000
```

The checked-in config specifies one epoch, batch/accumulation 128, AdamW, LR `1e-3`, no
weight decay, 3% warm-up, cosine decay, BF16, clip norm 1.0, and checkpoints every 100 steps.

DeepSeek's local `--resume-checkpoint` restores projector weights and schedule position but
**does not restore AdamW optimizer state**. Its log explicitly reports
`optimizer_state_restored: false`. A strict reproduction should either avoid interruption or
extend the runner to atomically archive optimizer/scheduler/RNG state before claiming exact
resume equivalence.

## 8. Laguna training path

Use the archived trainer, which pins Laguna BF16 revision
`e9df9a59996d790b94b70f3fef343fe1d9e34bdf` and validates the 30,679,808-parameter
projector:

```bash
torchrun --standalone --nproc_per_node=4 \
  sources/laguna-xs-2.1/private-training-archive/code/train_projector_ddp.py \
  artifacts/cache/laguna-moonvit \
  artifacts/runs/laguna-projector-100k \
  --max-examples 100000 \
  --epochs 1 \
  --global-gradient-accumulation 128 \
  --learning-rate 0.001 \
  --weight-decay 0 \
  --warmup-ratio 0.03 \
  --gradient-clip 1.0 \
  --save-every 10 \
  --seed 20260802 \
  --resume
```

The first launch prints a harmless `resume found: false` event. Later launches restore the
projector, full optimizer state, scheduler state, example count, and step from
`training-state.json`. The world size must remain four. Checkpoint writes are atomic and the
state file points only to complete projector/optimizer files.

The historical run reached step 384, restarted from durable step 380, replayed steps 381-384,
and finished at step 782. Therefore:

- use the line for step 1 as the true first loss (`4.908374495338649`);
- use the final line as the final loss (`0.7318046561413212`);
- the logged minimum is step 476 (`0.6835096142294574`);
- interpret the final `elapsed_seconds` and throughput as resumed-segment metrics;
- do not divide cumulative 100K examples by resumed-segment time.

The private archive should contain 170 files totaling 14,543,120,986 bytes, including
`training.log`, `run-summary.json`, `training-state.json`, `SHA256SUMS`, checkpoint pairs,
and code snapshots. Verify its own `SHA256SUMS` after download.

## 9. Component verification

| File | Size | SHA-256 |
|---|---:|---|
| DeepSeek `vision_tower.safetensors` | 833,765,768 | `1382c41f1a4afc91791ade630e2b1e1cef68cc5a1e09668a45970a5d5e1b8f15` |
| DeepSeek `mm_projector.safetensors` | 80,238,568 | `7024d9d5c9714c7abbc09abda015f083b7d7b107745eb78879f019bf4721577a` |
| Laguna `vision_tower.safetensors` | 833,765,768 | `befe801bd7dfe8bf5630fef56a7f53c2235065599ca9eea4d995040e2e6fd183` |
| Laguna `mm_projector.safetensors` | 61,360,104 | `7837384f18be69a4f875ca44a8ed69ec186501d70896daf4b305fa77547974de` |
| Laguna final optimizer step 782 | 122,726,045 | `c5879b03b6f86b5ddabc3eb05380915b1b1aa4c0058592ae6a73f6220624c9f7` |

Example verification:

```bash
shasum -a 256 /external/model/mm_projector.safetensors
```

Tensor-level checks should assert six BF16 projector tensors, the exact parameter count,
finite values, and expected input/output dimensions. Do not treat equal byte size as equal
content; the two tower files have different hashes.

## 10. Publication and package identity

Published packages must include their source model ID/revision, component SHA-256 and size,
licenses, model card, and an explicit serving-status declaration. Copying text weights and
adding a projector does not by itself create a runnable vision-language endpoint.

DeepSeek package rules:

- NVFP4 is a complete pinned quantized text package with custom SGLang source.
- BF16 is a source overlay and must say `complete_text_checkpoint: false`.
- Stock SGLang is unsupported; the integration requires the pinned source patch.
- The packaged native target is SGLang `/generate`, not OpenAI multimodal chat.
- The pinned B200 profile passed loader/startup and two live image requests; text-only
  parity, broad evaluation, and production validation are still required.

Laguna package rules:

- BF16 and NVFP4 repositories each contain their complete pinned text backbone plus tower
  and projector.
- Both public main revisions must say that the multimodal processor/serving integration is
  absent from main.
- BF16 image inference, NVFP4 equivalence, and end-to-end image serving remain unvalidated.
- A processor/server candidate exists only on the NVFP4 `sglang-integration` branch at
  `740a6ccc05441a7ea0426c1d2536d5cd031adb86`; it has no recorded full-model or image smoke.

The public model cards and adapter manifests copied into
[`sources/published-artifacts`](sources/published-artifacts) are the templates for these
statements.

## 11. DeepSeek image smoke test

The local prototype can test the BF16 reference path with a single image:

```bash
.venv/bin/deepseek-vision infer-image \
  configs/model/moonvit.json \
  artifacts/runs/moonvit-pilot100k/projector-step-000782.safetensors \
  /path/to/image.jpg \
  --prompt 'Describe this image in one sentence.' \
  --max-tokens 64
```

The local non-streaming test server binds to loopback by default:

```bash
.venv/bin/deepseek-vision serve \
  configs/model/moonvit.json \
  artifacts/runs/moonvit-pilot100k/projector-step-000782.safetensors \
  --host 127.0.0.1 --port 8000
```

Forward it without exposing the unauthenticated prototype:

```bash
ssh -N -L 8010:127.0.0.1:8000 \
  -p REMOTE_SSH_PORT -i ~/.ssh/id_ed25519-runbod root@REMOTE_SSH_HOST

curl http://127.0.0.1:8010/health
python3 scripts/test_vision_api.py /path/to/image.jpg \
  --url http://127.0.0.1:8010/v1/chat/completions \
  --prompt 'Bu goruntude ne var?'
```

The left side of `-L` is the local port. If local port 8000 is occupied, changing only the
remote side does not help; use `-L 8010:127.0.0.1:8000` as above.

The prototype accepts one base64 `data:image/...` URL, rejects remote image URLs, limits
decoded images to 20 MiB, serializes generation, and buffers responses even when `stream`
is requested. These local API semantics are separate from the public custom SGLang package.

### Pinned B200 SGLang package smoke

On 2026-08-04, the public DeepSeek integration was exercised on NVIDIA B200 with four-way
tensor parallelism using SGLang source
`fdebc938f7f4d16fe6b9f55dcd9a767cf0899ea1`. The server remained healthy across two
consecutive requests to its native endpoint, `http://127.0.0.1:30000/generate`:

| Probe | Image tokens | Total prompt tokens | Observed answer content | Elapsed |
|---|---:|---:|---|---:|
| Street/taxi scene | 294 | 308 | A man, yellow vest, and taxi were identified | 6.95 s |
| Cat/person scene | 532 | — | A cat sitting on a person's shoulder was identified | 2.52 s |

This is bounded evidence of end-to-end image serving, not a broad quality benchmark or a
production-readiness claim. The extension accepts one image per request, requires CUDA
image preprocessing, targets tensor parallelism, and does not support stock SGLang or the
OpenAI `/v1/chat/completions` `image_url` path. Pipeline parallelism and encoder data
parallelism remain blocked or unvalidated, and text-only parity remains a separate gate.

Laguna has no validated equivalent endpoint in the recorded artifact. The NVFP4
`sglang-integration` candidate is packaging evidence only until its tokenizer/image
placeholder contract, processor, embedding scatter, loader, and generation path pass a
real smoke test. Do not point a generic text server at the projector and call that an image
test.

## 12. Completion checklist

- [x] Published source, model, tower, and serving revisions are immutable.
- [ ] Dataset manifest and component SHA-256 values match this record.
- [ ] All feature-cache invariants pass.
- [ ] Synthetic backward changes only projector gradients.
- [ ] Text-only DeepSeek parity and routing-ID preservation pass.
- [ ] Overfit loss falls and timed calibration remains within the approved budget.
- [ ] Final checkpoint, optimizer state where applicable, state file, log, and hashes are
  copied before the pod is stopped.
- [x] Public cards distinguish full checkpoints, overlays, and serving limitations.
- [x] BF16 reference image inference passes.
- [x] A bounded quantized DeepSeek B200 end-to-end image smoke passes.
- [ ] Text-only parity, held-out evaluation, and broader regression gates pass before
  declaring either NVFP4 package production ready.
- [ ] The Laguna NVFP4 integration candidate passes a full-model loader and image smoke
  before any serving change is promoted to a public main revision.
