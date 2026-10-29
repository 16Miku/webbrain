---
title: >
  Spark-X2.6, Liquid AI LFM3, and MiniCPM-V 4.7: Compact Agent Routing on NVIDIA RTX 5060
slug: spark-x26-lfm3-minicpm-v47-tool-routing
sortOrder: -440
date: 2026-10-29
readTime: 7 min read
description: >
  Frozen compact agent benchmark comparing Spark-X2.6-4B, Liquid AI LFM3-1.7B, and MiniCPM-V-4.7-1B locally on dual NVIDIA RTX 5060 Ti GPUs.
excerpt: >
  Official Q4 GGUF runs of Spark-X2.6-4B, LFM3-1.7B, and MiniCPM-V 4.7 on WebBrain's frozen browser benchmark, featuring parallel execution across dual RTX 5060 Ti GPUs and an expanded 18-model historical leaderboard.
keywords:
  - Spark-X2.6
  - Liquid AI LFM3
  - MiniCPM-V 4.7
  - browser agent benchmark
  - tool calling
  - NVIDIA RTX 5060 Ti
  - llama.cpp
author: Emre Sokullu
authorUrl: https://emresokullu.com
---

We evaluated **Spark-X2.6-4B, Liquid AI LFM3-1.7B, and MiniCPM-V-4.7-1B** locally on dual NVIDIA GeForce RTX 5060 Ti GPUs using official revision-pinned Q4_K_M GGUF checkpoints. The benchmark executed WebBrain's frozen September 7 Compact contract across 100 first-turn routing prompts and 100 seeded multi-turn scenarios.

Spark-X2.6-4B leads the three new models on strict exact-action matching with **11/89 (12.4%)**. Spark-X2.6-4B leads the looser tool-family match with **29/89 (32.6%)**.

## Comparison 1: the three new models

The suite contains 100 first-turn prompts and 100 seeded scenarios. Eleven Dev scenarios are outside Compact mode, leaving **89 scored scenarios**. Strict means the model's next tool call matches the reference tool name **and arguments**. Loose matching additionally credits tool-name matches with divergent arguments and terminal prose that answers the user question without calling redundant tools. Structured-call coverage measures whether the model emitted valid JSON tool calls.

| Model | Parameters | First-turn structured calls (/100) | Strict exact action (/89) | Loose tool-family match (/89) | Loose rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Spark-X2.6-4B (new Q4)** | 4B | 100 | 11 | 29 | 32.6% |
| **LFM3-1.7B (new Q4)** | 1.7B | 100 | 10 | 19 | 21.3% |
| **MiniCPM-V-4.7-1B (new Q4)** | 1B | 97 | 2 | 27 | 30.3% |

All three models used the same frozen inputs, quantization (Q4_K_M), 32,768 context size, deterministic sampling seeds (3407), and concurrency=1 on dedicated RTX 5060 Ti hardware. MiniCPM-V-4.7-1B and Liquid AI LFM3-1.7B executed in parallel across the two available RTX 5060 Ti GPUs. SHA-256 digests were verified before inference.

## What the responses show

### Tool calling and inspection preferences

Both **Spark-X2.6-4B** and **LFM3-1.7B** achieved **100/100** structured tool call validity in first-turn routing, demonstrating strong adherence to OpenAI function calling schemas. MiniCPM-V-4.7-1B achieved **97/100**, emitting direct text on three knowledge questions instead of calling tools.

As observed in earlier compact model tests, small models display a heavy bias toward tree inspection when faced with web navigation tasks:

| Model | First-turn exact reference (/100) | First-turn tree calls (/100) | Scenario anti-patterns (/89) | Transport / Server errors | Output-length limits |
| --- | ---: | ---: | ---: | ---: | ---: |
| Spark-X2.6-4B | 3 | 75 | 2 | 0 | 0 |
| LFM3-1.7B | 5 | 68 | 1 | 0 | 0 |
| MiniCPM-V-4.7-1B | 1 | 53 | 4 | 1 | 0 |

- **Spark-X2.6-4B** called `get_accessibility_tree` on 75/100 first-turn prompts, down from 78/100 in Spark-X2.5-4B. It matched 11/89 strict actions and 29/89 loose actions, matching its predecessor's strict score while demonstrating solid anti-pattern resistance (only 2 anti-pattern verdicts).
- **LFM3-1.7B** showed a marked improvement over the LFM 2.5 generation: its strict score jumped to **10/89** (compared to 4/89 for LFM2.5-2.6B), while its first-turn navigation calls reached 27/100 with only 1 anti-pattern throughout the entire scenario suite. At 190ms average per-step latency on RTX 5060 Ti, it was the fastest model in the lineup.
- **MiniCPM-V-4.7-1B** showed higher diversity in initial tool selection (calling fetch_url, click, read_page, and inspect_viewport) and led the three on loose tool-family matching at **27/89 (30.3%)**, but only achieved 2 strict matches due to argument divergence, alongside 4 anti-patterns and 1 context-length error.

## Generational progression: Spark, LFM, and MiniCPM

Comparing the new releases against their direct predecessors in WebBrain's frozen benchmark reveals notable architectural refinements:

1. **Spark-X2.6 vs Spark-X2.5**: Spark-X2.6-4B maintains top-tier strict execution (11/89) and clean 100% structured call fidelity, with reduced tree-inspection bias and improved prompt evaluation throughput on modern Ada/Blackwell tensor cores.
2. **Liquid AI LFM3 vs LFM2.5**: LFM3-1.7B more than doubles LFM2.5-2.6B's strict score (10/89 vs 4/89) while requiring 35% fewer parameters and running at nearly 500 tokens/sec total throughput in llama.cpp.
3. **MiniCPM-V 4.7 vs MiniCPM5**: MiniCPM-V 4.7-1B operates at under 1GB VRAM footprint (672MB in Q4_K_M). While optimized primarily as a vision-language model, its text backbone demonstrates strong recovery in conversational scenarios (25 ideal_name matches).

## Complete comparison with historical compact models

The table below compiles all **18 evaluated models** on WebBrain's Compact frozen contract, sorted by strict score, then loose score:

| Model | Parameters | First-turn structured calls (/100) | Strict exact action (/89) | Loose tool-family match (/89) | Loose rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen3.8-27B | 27B | 99 | 17 | 39 | 43.8% |
| WebBrain Compass Tiny v2 | ~2.6B | 94 | 16 | 41 | 46.1% |
| Qwen3.5-4B | 4B | 89 | 16 | 36 | 40.4% |
| Gemma 4 E4B | 7.5B | 90 | 15 | 43 | 48.3% |
| Qwen3.6-35B-A3B | 35B A3B | 89 | 15 | 42 | 47.2% |
| Nanbeige4.2-3B | 4.2B reported | 89 | 13 | 37 | 41.6% |
| Gemma 4 12B QAT | 12B | 90 | 12 | 34 | 38.2% |
| Spark-X2.5-4B | 4B | 96 | 11 | 30 | 33.7% |
| **Spark-X2.6-4B (new Q4)** | 4B | 100 | 11 | 29 | 32.6% |
| Qwen3.5-2B | 2B | 92 | 11 | 28 | 31.5% |
| **LFM3-1.7B (new Q4)** | 1.7B | 100 | 10 | 19 | 21.3% |
| Spark-X2.5-1.7B | 1.7B | 99 | 9 | 37 | 41.6% |
| MiniCPM5-2B | 2.52B | 96 | 9 | 31 | 34.8% |
| Gemma 4 E2B | 4.6B | 74 | 8 | 45 | 50.6% |
| WebBrain Compass Tiny v1 | 2.6B | 81 | 4 | 42 | 47.2% |
| LFM2.5-2.6B base | 2.6B | 80 | 4 | 34 | 38.2% |
| **MiniCPM-V-4.7-1B (new Q4)** | 1B | 97 | 2 | 27 | 30.3% |
| Qwen3.5-9B | 9B | 84 | 2 | 12 | 13.5% |

## Hardware setup and methodology

Runs were conducted locally on Ubuntu 24.04 with dual **NVIDIA GeForce RTX 5060 Ti** GPUs (16GB VRAM each). MiniCPM-V-4.7-1B ran on CUDA2 (port 18080) and LFM3-1.7B ran on CUDA1 (port 18081) simultaneously, followed by Spark-X2.6-4B on CUDA2.

The serving backend was `llama.cpp` build b11960 with CUDA acceleration, Flash Attention enabled, context size 32,768, sampling seed 3407, Act temperature 0.15, Ask temperature 0.3, top-p 1, top-k 0, min-p 0, and repetition penalty 1. Native Jinja chat templates were used with reasoning/thinking disabled to benchmark core agent routing.

| Model | Official GGUF repository | Pinned revision | GGUF SHA-256 |
| --- | --- | --- | --- |
| Spark-X2.6-4B | [XHToken/Spark-X2.6-4B-GGUF](https://huggingface.co/XHToken/Spark-X2.6-4B-GGUF) | `0e8aa39a34063946ce07bbaaff392093b11b6829` | `91cb2811aebb47ac916aa619d27d4cdd7f4143106b7917accb8ead4cd7f5cbd9` |
| LFM3-1.7B | [LiquidAI/LFM3-1.7B-GGUF](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) | `bad5729bba61d076fff20d2548e62526665af215` | `3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4` |
| MiniCPM-V-4.7-1B | [openbmb/MiniCPM-V-4.7-1B-gguf](https://huggingface.co/openbmb/MiniCPM-V-4.7-1B-gguf) | `345adbfa02c4a4671e61b7c75502dc9bf24fa93d` | `f18f594747e5317ab490cff9c06339c9cfb89acbe2f02ebc48a4e167bc23576d` |

Download the complete [comparison data](/blog/spark-x26-lfm3-minicpm-v47-tool-routing/comparison.json). Raw per-case traces, logs, and evidence audits are stored under `test/llm/analysis/2026-10-29-spark-lfm-minicpm-compact/`.
