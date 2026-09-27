---
title: >
  EXL3 is the best quantization format for local AI right now — especially on Blackwell lite
slug: exl3-sparkinfer-blackwell-lite
sortOrder: 10
date: 2026-08-11
readTime: 6 min read
description: >
  EXL3 (turboderp's QTIP-derived trellis format) is the best low-bit quantization for local AI on Blackwell lite hardware. Now it runs ~3x faster through SparkInfer, the vLLM fork — including on odd GPU counts and DGX Spark.
excerpt: >
  EXL3 keeps more quality per bit than GGUF or EXL2, converts cheaply, and its trellis GEMMs pair perfectly with Blackwell sm_120/sm_121 hardware. SparkInfer (vLLM fork) integrated it natively and we're getting ~3x the throughput of ExLlamaV3 — with sane tensor/expert parallelism even on odd card counts.
cardTitle: >
  EXL3 is the best quantization schema for local AI right now
titleTag: >
  EXL3: Best Quantization for Local AI on Blackwell Lite — WebBrain Blog
ogTitle: >
  EXL3 is the best quantization schema for local AI right now
ogDescription: >
  QTIP-derived trellis quant, native in the SparkInfer vLLM fork: ~3x ExLlamaV3 throughput, fractional bpw, odd-card TP, DGX Spark support. Plus turboderp's EXL3 model cards.
twitterTitle: >
  EXL3 is the best quantization schema for local AI right now
twitterDescription: >
  SparkInfer + EXL3 = ~3x ExLlamaV3 speeds on Blackwell lite (DGX Spark / 5090 / PRO 4000 / 5000 / 6000). Works with odd card counts. trellis > everything at low bpw.
keywords:
  - EXL3
  - quantization
  - SparkInfer
  - vLLM
  - ExLlamaV3
  - Blackwell
  - DGX Spark
  - RTX 5090
  - trellis
  - QTIP
  - local LLM
  - MoE
  - tensor parallel
author: Emre Sokullu
authorUrl: https://emresokullu.com
html: true
lede: >
  We've spent the last few months running local models every way you can — GGUF, EXL2, NVFP4, IQ quants, you name it — and the verdict is getting clear: EXL3 from turboderp is the best quantization schema for local AI right now, and the gap is widest on Blackwell lite hardware (DGX Spark, RTX 5090, RTX PRO 4000/5000/6000). What changed recently is that it's no longer stuck in one engine: SparkInfer, the vLLM fork, integrated it natively and now renders EXL3 checkpoints at roughly 3x the throughput we were getting on ExLlamaV3.
---

## Why EXL3 beats everything else at low bitrates

EXL3 is a streamlined variant of **QTIP** from Cornell RelaxML. Where GGUF i-quants and EXL2 use per-block rounding tricks, EXL3 encodes high-dimensional weight vectors into *optimal tail-biting trellis structures* using procedural codebooks and a fused Viterbi kernel. Practically that means two things:

1. **More quality per bit.** At 3–4 bpw, EXL3 keeps models coherent where older formats start falling apart. Turboderp's repo has Llama-3.1-70B-EXL3 coherent at **1.6 bpw** — with a 3 bpw head and a 4096-token cache that's the whole 70B under 16 GB of VRAM.
2. **Fractional bitrates.** `convert.py -b 4.25` — you target a bitrate that fills your cards exactly. No more "4-bit is 2 GB short, 5-bit doesn't fit."

The conversion economics are a big part of the story too. The README compares against **AQLM**: quantizing a 70B with AQLM takes ~720 GPU-hours on an A100 (about $850 at the time). EXL3 computes Hessians on the fly with the fused Viterbi kernel and does the whole conversion in a **single step** — a couple of minutes for small models, a few hours for 70B+, on a single RTX 4090. That's why the format actually has a library of pre-quantized models instead of a couple of showcase repos.

Unlike EXL2 (which renamed tensors to fit a Llama-shaped world), EXL3 keeps the original HF file structure, which is exactly what made it possible to drop into a real serving engine.

## SparkInfer: EXL3 escaped ExLlama's single-user sandbox

ExLlamaV3 itself got a massive speedup this year — the v1.0.0 kernels roughly doubled throughput (Qwen3.6-27B: 29 → 50 tok/s, Qwen3.5-0.8B: 268 → 444 tok/s). With DFlash draft support it hits 140+ tok/s on a single RTX PRO 6000 on agentic/coding traces.

But ExLlama is a single-process library — bad concurrency, awkward for serving. That's why the SparkInfer integration matters. **SparkInfer is a Blackwell-native fork of vLLM** (from the Local Inference Lab / Bittensor crowd) with its own CUDA kernel set ("B12X"). It targets exactly the consumer/edge Blackwell family — `sm_120` (RTX 50-series) and `sm_121` (DGX Spark), explicitly *not* datacenter. And its EXL3 Trellis backend ([vLLM PR #139](https://github.com/local-inference-lab/vllm/pull/139) + [SparkInfer PR #49](https://github.com/local-inference-lab/b12x/pull/49)) loads native EXL3 checkpoints — rank-sliced GLM/DeepSeek MoE payloads included — with **no repacking or requantization**. You just launch with `--quantization exl3`.

The result, from our rig (4x RTX PRO 6000, TP4, CUDA 13.2, MTP speculative decoding):

<div class="callout">
<ul>
        <li><strong>GLM-5.2 EXL3 at 3.0–3.5 bpw</strong> — ~48.9 tok/s single stream on the first integrations, <strong>121 tok/s single stream with MTP3</strong> on the current SparkInfer release, 297 tok/s at C4, 436 tok/s aggregate at C8</li>
        <li>8K prefill: ~3,200–3,700 tok/s</li>
        <li>251K-token context with fp8/NVFP4 KV on four cards, KV staying far smaller than a GGUF build of the same model</li>
</ul>
</div>

That's roughly **3x** the sustained throughput we were getting from the same EXL3 checkpoints under ExLlamaV3. The wins come from the Blackwell-native kernels themselves — SparkInfer claims +86% decode over llama.cpp on an RTX 5090 (512 tok/s at 128 context on Qwen3.6-35B-A3B) — plus vLLM-grade batching on top of a format that was previously single-stream-only.

## Blackwell lite is the natural home for EXL3

"Blackwell lite" is the sm_120/sm_121 family — the GPUs that sit on your desk rather than in a rack:

- **RTX 5090** (32 GB) — the 128-context decode king; SparkInfer measured 512 tok/s there
- **RTX PRO 4000 / 5000 / 6000 Blackwell** — 40/96 GB workstations; the PRO 6000 is the sweet spot for DGX-class models at home without the DGX noise
- **DGX Spark (GB10)** — 128 GB unified memory, sm_121. EXL3 is what makes DeepSeek-grade MoE models actually fit on one: the DeepSeek V4 Flash EXL3 build fuels a 262K-token, fully resident 284B MoE on a *single* Spark (~38–49 tok/s, ~1,055 tok/s prefill)

Beefy datacenter GPUs barely matter here — these are exactly the machines where the format's quality-per-bit shows up as fitting vs. not fitting.

## Odd card counts finally work

Stock vLLM tensor parallel requires the model's head counts to divide evenly by the GPU count, and `--tensor-parallel-size 3` is unsupported on many models. ExLlamaV3's flexible tensor- and expert-parallel splits handled odd setups from day one (per-layer, per-expert placement with per-layer parallelism limits), and SparkInfer inherits that flexibility with vLLM's scheduler on top.

Our 3-GPU box (5090 + two PRO 4000s — yes, really) runs smoothly. There are public logs of **GLM-5.2 (753B) served TP=3 across three DGX Sparks** at 15–16 tok/s decode with 215K context — a model size that is simply out of reach on any even-count config you could afford. Mixed card sizes work too, since EXL3's rank-sliced checkpoints don't care about uniform VRAM; you parallelize experts and channels, not memory pools.

## turboderp's model cards are worth a click

Turboderp's [Hugging Face account](https://huggingface.co/turboderp) now hosts **148 models**, with a maintained [EXL3 models collection](https://hf.co/collections/turboderp/exl3-models). The cards there are unusually good: each one documents bpw variants, KV-cache options, and which runtime actually tested them. Current standouts:

| Model | Why it's interesting |
|---|---|
| [Qwen3.6-27B-exl3](https://huggingface.co/turboderp/Qwen3.6-27B-exl3) | The community workhorse (~574 downloads). At 4.15 bpw it's turbocharged by DFlash speculative decoding — 177+ tok/s on coding traces, single PRO 6000. |
| [DeepSeek-V4-Flash-0731-exl3](https://huggingface.co/turboderp/DeepSeek-V4-Flash-0731-exl3) | 284B / 216 experts at ~3 bpw. Fits a DGX Spark; the card includes the Spark profiles. |
| [Laguna-XS-2.1-exl3](https://huggingface.co/turboderp/Laguna-XS-2.1-exl3) | The small thinking model done right — what we run on WebBrain's local path for cheap agentic tasks. |
| [Laguna-S-2.1-exl3](https://huggingface.co/turboderp/Laguna-S-2.1-exl3) | Sibling of the above, more capacity per VRAM. |
| [gpt-oss-120b-exl3](https://huggingface.co/turboderp/gpt-oss-120b-exl3) | OpenAI's open MoE, ~3 bpw; 120B in the double-digit GB range. |
| [Mistral-Small-4-119B-2603-exl3](https://huggingface.co/turboderp/Mistral-Small-4-119B-2603-exl3) | Same weight class, different trade-offs; good for 3×24GB rigs. |
| [Muse-Glimmer-30B-exl3](https://huggingface.co/turboderp/Muse-Glimmer-30B-exl3) / assistant variant | Brand new (hours old) — the 30B creative model in native EXL3. |
| [IQuest-Coder-V1-40B-Instruct-exl3](https://huggingface.co/turboderp/IQuest-Coder-V1-40B-Instruct-exl3) | Coder-specialized; excellent ~2.5–3 bpw coding quality per GB. |

## How to actually run it

- **Single user, one GPU:** stick with ExLlamaV3 + [TabbyAPI](https://github.com/theroyallab/tabbyAPI/) — install, point at a model dir, done.
- **Serving / multi-user / multi-GPU:** use the SparkInfer vLLM fork. Expect a source build (CUDA 13.x for Blackwell), then `--quantization exl3`, set `--tensor-parallel-size` to your card count (odd is fine), add `--kv-cache-dtype fp8` on workstations or NVFP4 on GB10.
- **DGX Spark:** follow a pinned recipe (e.g. the [DeepSeek V4 Flash + SparkInfer one](https://github.com/0xSero/deepseek-v4-flash-0731-spark-sparkinfer)) — the sm_121 attention path and EXL3 loading come pre-wired, and the KV-cache settings matter more than on x86.

## Bottom line

GGUF is still the safe default if you need CPU/Apple/AMD portability, and NVFP4 has its place on datacenter Blackwell. But if you own the machine, the cards are NVIDIA, and you care about **quality per bit per dollar**, EXL3 is the format and Blackwell lite + SparkInfer is the stack right now. ~3x over ExLlamaV3 on the same files, real serving concurrency, odd card counts welcome, and a first-party library of already-converted models. That's the best local-AI setup I know of today.
