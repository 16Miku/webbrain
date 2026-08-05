# DeepSeek Vision

An experimental, routing-aware visual adapter for DeepSeek V4 Flash:

```text
image -> frozen 1152-d vision tower -> trainable 2x2 PatchMerger (40,119,040 params)
      -> mixed text/image embeddings -> frozen DeepSeek V4 Flash -> token loss
                                      \-> original text routing IDs preserved
```

The first arm uses MoonViT from Kimi K2.6. The comparison arm swaps only the frozen
tower for Qwen3.6-27B's 1152-d vision tower and takes its pre-merger hidden state.
Both arms use the same 2x2 merger, 4096-d output, data order, route palette, optimizer,
token budget, and evaluation harness.

## What is implemented

- Exact 40.119M PatchMerger: `LN(1152) -> Linear(4608,4608) -> GELU -> Linear(4608,4096)`.
- Separate `inputs_embeds` and `routing_ids` through DeepSeek V4's hash-routed layers.
- Text routing IDs are copied unchanged. Image positions deterministically cycle through
  a fixed route palette selected from DeepSeek's `tid2eid` tables.
- Component-only extraction so MoonViT/Qwen towers can be downloaded without their LLMs.
- A checked-in 64-ID palette derived from all three routing tables at DeepSeek revision
  `60d8d707`, covering 734 layer-qualified experts with a maximum load of three.
- Deterministic stratified builder for a 100,000-example pilot manifest.
- MoonViT and Qwen3.6 A/B configs plus local unit tests and cloud preflight checks.
- An idempotent SGLang source patch that stops `input_embeds` from being discarded while
  retaining `input_ids` for hash routing.

The real 100k training run is not started from this Mac. It needs the normalized image
datasets and a validated multi-GPU backward kernel path; see [docs/TRAINING.md](docs/TRAINING.md).
Measured H200 bring-up results and the FP8-autograd finding are recorded in
[docs/BRINGUP-2026-08-02.md](docs/BRINGUP-2026-08-02.md).

## Local setup

The lightweight commands have no third-party dependencies:

```bash
cd ~/Documents/deepseek-vision
PYTHONPATH=src python3 -m deepseek_vision.cli validate-config configs/model/moonvit.json
python3 -m unittest discover -s tests -v
```

Build the deterministic pilot manifest after placing normalized JSONL sources at the paths
in `configs/data/pilot100k.example.json`:

```bash
PYTHONPATH=src python3 -m deepseek_vision.cli build-manifest \
  configs/data/pilot100k.example.json data/pilot100k.jsonl
```

Each normalized row is:

```json
{"id":"unique-id","image":"/absolute/or/dataset-relative.jpg","question":"...","answer":"..."}
```

## Cloud setup

Recommended first node: one NVSwitch-connected **8x H200 141 GB** host, at least 1 TB RAM,
and at least 1 TB persistent storage. A full-NVLink **5x H200** node is now validated through
the 1,267-token backward and 1k timed-training gates and is the measured pilot topology. The
released FP4/FP8 checkpoint and the SGLang FP8
repack are inference formats: their current kernels do not implement the input backward
needed to train our projector through a frozen DeepSeek. The checked-in workflow therefore
stream-converts `sgl-project/DeepSeek-V4-Flash-FP8` to a roughly 542 GiB BF16 checkpoint.

```bash
git clone <this-repository> deepseek-vision
cd deepseek-vision
./scripts/preflight_cloud.sh
mkdir -p artifacts
./scripts/bootstrap_cloud.sh
./scripts/bootstrap_moonvit_env.sh
```

Two Python environments are intentional. `.venv-moonvit` pins Transformers 4.57.x for
Kimi K2.6's remote MoonViT code; `.venv` uses the pinned Transformers 5 development commit
needed by DeepSeek V4 and Qwen3.6, plus PyTorch 2.11/Triton 3.6 from the CUDA 12.8 channel.
The towers meet at cached pre-merger 1152-d features.
The pinned Kimi tower dispatches through its own attention registry, which supports
FlashAttention 2 but not generic PyTorch SDPA. The MoonViT bootstrap therefore builds the
validated `flash-attn==2.8.3.post1` package and the loader uses it by default.

Download and convert DeepSeek before the synthetic backward gate:

```bash
.venv/bin/hf download sgl-project/DeepSeek-V4-Flash-FP8 \
  --revision ae01d80c06cdfe30581edfd0e1c5449dc7ed7f17

.venv/bin/deepseek-vision dequantize-checkpoint \
  /path/printed/by/hf-download artifacts/models/deepseek-v4-flash-bf16 --resume
```

Extract only the frozen towers (pin revisions before the measured run):

```bash
.venv/bin/deepseek-vision extract-component moonshotai/Kimi-K2.6 \
  'vision_tower.' artifacts/towers/moonvit-k2.6.safetensors \
  --revision 7eb5002f6aadc958aed6a9177b7ed26bb94011bb

.venv/bin/deepseek-vision extract-component Qwen/Qwen3.6-27B \
  'model.visual.' artifacts/towers/qwen3.6-27b-vision.safetensors \
  --revision 6a9e13bd6fc8f0983b9b99948120bc37f49c13e9
```

Do not launch the full pilot first. Run the gates in order: synthetic forward/backward,
256-example overfit, 1k-example timed calibration, then the 100k arm. Repeat with the Qwen
tower only after the MoonViT arm completes cleanly.

On RunPod, arm a hard stop during bring-up so an idle or failed pod cannot bill indefinitely:

```bash
./scripts/arm_runpod_watchdog.sh 30m
```

For a long local-orchestrated run, use the macOS guard instead. Its deadline is an absolute
budget cap. Every 30 minutes it checks the exact pod over SSH and continues only while an
approved fetch, cache, smoke-backward, or projector-training process is active. A transient
API or SSH failure is retried before the pod is stopped.

```bash
cap_deadline_epoch="$(( $(date +%s) + 12 * 3600 ))"
./scripts/arm_local_runpod_guard.sh POD_ID "$cap_deadline_epoch"
```

## Hardware and cost envelope

This Mac is an M4 Max with 64 GB unified memory. It is useful for code/data work, but the
DeepSeek source is roughly 274 GB and the trainable BF16 reconstruction is about 542 GiB.

Current public on-demand list prices used for budgeting are approximately ([Runpod GPU
pricing](https://www.runpod.io/pricing), [Lambda instances](https://lambda.ai/instances)):

| Node | Raw node price | Use here |
|---|---:|---|
| 5x H200 141 GB | about $21.95/hour | Validated and measured projector pilot |
| 6x H200 141 GB | about $26.34/hour | Validated lower-cost projector pilot |
| 8x H200 141 GB | about $35.12/hour | Recommended FP8 calibration and pilot |
| 8x B200 180 GB | about $47.12-$53.52/hour | Faster candidate after backward validation |

The measured five-H200 1k calibration sustained 4,947 examples/hour on the production data
mix. That projects one 100k arm to 20.21 training hours and $443.68 of GPU time, plus about
$1.18 for the one-time model load. Budget approximately **$445 per arm** or **$890 for both
MoonViT and Qwen**, before feature caching, evaluation, packaging, and contingency. The
general conversion remains:

```text
arm_hours = 100000 / measured_examples_per_hour
arm_cost  = arm_hours * node_hourly_price
```

The timed runner writes `run-summary.json`; convert it directly into an A/B estimate:

```bash
python scripts/estimate_pilot_cost.py checkpoints/moonvit-1k/run-summary.json \
  --node-dollars-per-hour 21.95
```

## Image inference and local API

Run a single-image smoke test with the trained projector. The command first encodes the
image in the pinned MoonViT environment, releases that process, and then loads DeepSeek in
the main environment:

```bash
.venv/bin/deepseek-vision infer-image \
  configs/model/moonvit.json \
  artifacts/runs/moonvit-pilot100k/projector-step-000782.safetensors \
  /path/to/image.jpg \
  --prompt "Describe this image in one sentence." \
  --max-tokens 64
```

For a cached-feature diagnostic that skips MoonViT, replace `infer-image` with
`infer-feature` and pass one `features/*.pt` file as the third positional argument.

The built-in server keeps both MoonViT and DeepSeek loaded and exposes an OpenAI-compatible
non-streaming endpoint. It binds to loopback by default; use SSH port forwarding instead of
exposing the unauthenticated prototype publicly:

```bash
.venv/bin/deepseek-vision serve \
  configs/model/moonvit.json \
  artifacts/runs/moonvit-pilot100k/projector-step-000782.safetensors

# On the client machine:
ssh -N -L 8000:127.0.0.1:8000 -p RUNPOD_SSH_PORT \
  -i ~/.ssh/id_ed25519-runbod root@RUNPOD_SSH_HOST
curl http://127.0.0.1:8000/health
```

Send a local image without manually building the base64 request:

```bash
python3 scripts/test_vision_api.py ~/Desktop/test.jpg \
  --prompt "Bu görüntüde ne var?"
```

`POST /v1/chat/completions` accepts exactly one base64 `data:image/...` URL:

```json
{
  "model": "deepseek-v4-flash-moonvit-pilot",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "What is shown in this image?"},
      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
    ]
  }],
  "max_tokens": 64,
  "temperature": 0
}
```

The prototype serializes generation requests, rejects remote image URLs, and limits decoded
images to 20 MiB. Requests with `stream: true` are accepted but returned as one buffered JSON
completion rather than SSE chunks.

If the backward path falls back to unoptimized kernels, stop the run; cost can exceed this
range by several times.

## Non-negotiable A/B controls

- Same exact 100k manifest hash and shuffled order.
- Same DeepSeek checkpoint revision and routing palette.
- Same post-merge image-token cap and sequence-length distribution.
- Same projector initialization seed, optimizer, schedule, and effective batch size.
- Evaluate both the final checkpoint and matched-token intermediate checkpoints.
- Report quality, examples/sec, peak memory, and dollars—not quality alone.
