---
title: >
  Six budget Qwen vision models, compared: 600 requests, 54 cents on OpenRouter
slug: qwen-budget-vision-openrouter
sortOrder: -250
date: 2026-08-22
readTime: 7 min read
description: >
  We ran every current sub-dollar Qwen vision model on OpenRouter through WebBrain's 100-case browser-vision benchmark. Qwen3-VL-32B Instruct won on quality, the MoE 30B-A3B matched it at twice the speed, and the thinking variants billed four to five times the output tokens for little or no gain.
excerpt: >
  Dense 32B Instruct takes the quality crown at 69 strict passes. The MoE 30B-A3B lands one pass behind at half the latency. Both thinking variants cost 4-5x more output tokens and didn't beat their instruct siblings — except at 8B, where thinking was worth 13 passes.
titleTag: >
  Six Budget Qwen Vision Models Compared on OpenRouter - WebBrain Blog
ogTitle: >
  Six budget Qwen vision models compared on OpenRouter
ogDescription: >
  600 image requests, zero errors, 54 cents total. Where Qwen's cheap vision models actually differ: latency, output-token burn, and a hard cliff below 30B.
twitterTitle: >
  Six budget Qwen vision models compared on OpenRouter
twitterDescription: >
  Qwen3-VL-32B Instruct wins our 100-case browser benchmark at $0.02 per full run. Thinking variants bill 4-5x the tokens. Full tables inside.
keywords:
  - Qwen3-VL
  - OpenRouter
  - vision model benchmark
  - browser agent
  - qwen3.5-35b-a3b
  - Qwen3-VL-32B Instruct
  - Qwen3-VL-30B-A3B
  - reasoning models
  - vision language model
  - WebBrain
author: Emre Sokullu
authorUrl: https://emresokullu.com
lede: >
  **You don't need an expensive API to give a browser agent eyes.** We pushed all six of Qwen's current sub-dollar vision-capable models on OpenRouter through our [100-case browser-vision benchmark](https://github.com/esokullu/webbrain/tree/main/test/vision) — same screenshots, same production six-section prompt, same strict rubric we use to evaluate WebBrain's own vision subsystem. All 600 requests completed without a single error, and the entire sweep cost **$0.53**. The dense Qwen3-VL-32B Instruct won on quality. Its MoE sibling matched it at twice the speed. And the two "thinking" variants billed four to five times the output tokens for a gain you can count on one hand.
---

## The lineup

Six model IDs, all served through the same OpenRouter account on August 22, 2026. Prices are OpenRouter list price per million tokens:

| Model | Architecture | In / 1M tok | Out / 1M tok |
| --- | --- | ---: | ---: |
| `qwen/qwen3-vl-8b-instruct` | dense VL, 8B | $0.117 | $0.455 |
| `qwen/qwen3-vl-8b-thinking` | dense VL, 8B + reasoning | $0.18 | $2.10 |
| `qwen/qwen3-vl-30b-a3b-instruct` | MoE VL, ~3B active | $0.13 | $0.52 |
| `qwen/qwen3-vl-30b-a3b-thinking` | MoE VL, ~3B active + reasoning | $0.20 | $2.40 |
| `qwen/qwen3-vl-32b-instruct` | dense VL, 32B | $0.104 | $0.416 |
| `qwen/qwen3.5-35b-a3b` | MoE generalist (text+image+video) | $0.25 | $1.25 |

Note what's missing from that table: any expensive model. The priciest row costs a quarter of a cent per 1K input tokens. This is the budget tier, and the question is how much capability survives down here.

## Results

Every model saw all 100 cases with WebBrain's production screenshot contract: temperature 0, max 800 tokens, six required sections, strict rubric scoring against expected facts. A strict pass means the complete contract plus the case's weighted facts recovered without critical contradiction.

| Model | Strict passes | Mean rubric | Mean latency | Output tokens | Cost / 100-case run |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Qwen3-VL-32B Instruct** | **69** | **91.9%** | 4.6 s | 22.2K | **$0.022** |
| Qwen3-VL-30B-A3B Instruct | 68 | 91.3% | **2.2 s** | 17.1K | $0.024 |
| Qwen3.5-35B-A3B | 67 | 90.8% | 5.2 s | 55.4K | $0.099 |
| Qwen3-VL-30B-A3B Thinking | 62 | 88.9% | 6.3 s | 68.5K | $0.188 |
| Qwen3-VL-8B Thinking | 61 | 86.7% | 6.4 s | 75.5K | $0.180 |
| Qwen3-VL-8B Instruct | 48 | 84.0% | 2.1 s | 14.9K | $0.021 |

Three things jump out.

**First place is a tie in disguise.** The dense 32B scores one strict pass and half a point of rubric above the MoE 30B-A3B. But the MoE answers in 2.2 seconds where the dense model needs 4.6. For an interactive browser agent watching its own screenshots, latency compounds across every step of a task; we'd pick the MoE for production loops and the dense model when you want maximum accuracy per request.

**The generalist doesn't beat the specialists.** Qwen3.5-35B-A3B is the flagship-shaped option — bigger context class, video input, newest generation. On browser screens it finished third, behind both dedicated VL siblings, while burning 2-4x their output tokens. If your workload is screenshots, the VL-tuned rows are simply better and cheaper.

**The 8B instruct is a different product.** At 48 strict passes it trails the leaders by twenty points, and the shape of its failure curve matters more than the average, which we'll get to below.

## What the extra money buys

Strict-pass rate by difficulty band (20 cases each):

| Band | 8B Inst | 8B Think | 30B MoE Inst | 30B MoE Think | 32B Inst | 35B A3B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Easy | 60% | 65% | 70% | 65% | 70% | 80% |
| Basic | 65% | 70% | 80% | 80% | 75% | 70% |
| Intermediate | 50% | 65% | 70% | 65% | 80% | 60% |
| Advanced | 35% | 55% | 60% | 50% | 65% | 70% |
| Challenging | 30% | 50% | 60% | 50% | 55% | 55% |

The 8B instruct falls off a cliff exactly where a browser agent needs help most: hard overlays, occluded controls, ambiguous states. Every model at 30B-plus holds a rough 55-70% floor across all five bands. Below 30B, only the thinking variant keeps that shape.

## Thinking: worth it at 8B, not at 30B

This is the cleanest experiment in the set, because both sizes ship paired instruct/thinking checkpoints:

- **At 8B:** thinking adds **+13 strict passes** (61 vs 48). If you're stuck with small models, the reasoning checkpoint genuinely rescues hard cases — advanced band jumps from 35% to 55%.
- **At 30B:** thinking *loses* six passes (62 vs 68). Whatever the extra tokens buy, they also buy overthinking easy screens.

Either way you pay for it: the thinking variants emitted **4-5x the completion tokens** of their instruct siblings (75.5K vs 14.9K at 8B; 68.5K vs 17.1K at 30B), ran about three times slower, and cost roughly eight times more per run at list prices.

One measurement caveat for anyone replicating this: our harness records OpenAI-style `reasoning_content`, while OpenRouter streams reasoning under its own `reasoning` field, so our captured reasoning text is empty even though the token usage makes clear the reasoning happened and was billed. Scores were computed on final content only, which is fair — but treat our "reasoning chars" fields in the committed results as zero by convention, not by observation.

## Where they all break

Category-level strict-pass rates expose shared blind spots that no amount of parameters in this tier fixed:

| Category | Best of six | Worst of six |
| --- | ---: | ---: |
| form-validation | 20% (two models) | 0% (four models) |
| modal-overlay | 20% (two models) | 0% (four models) |
| multilingual-OCR | 40% (35B generalist) | 0% (three models) |
| calendar | 100% | 20% (8B instruct) |
| checkout | 80% | 20% (8B instruct) |
| consent-banner | 100% | 0% (8B instruct) |

Form validation and modal overlays are brutal across the board — these are precisely the states where an automation agent most needs reliable vision, and the whole budget tier mostly misses them. Meanwhile toast notifications, data tables, and chart reading are free wins at 100% nearly everywhere.

Eighteen of the 100 cases failed for **all six models**. That's the honest floor of this price bracket today, and it's a useful target list for fine-tunes like [our 450M browser-specific model](/blog/tiny-vision-models-compared-ii).

One for the road: on case 001 — an ordinary login screen — the *only* model to earn a perfect score was the 8B instruct, the worst performer overall. Every larger sibling dropped details. Small models are unreliable; so are rankings.

## Which one should you call

- **Production browser agent:** Qwen3-VL-30B-A3B Instruct — 90th-percentile accuracy at 2.2 s median and ~$0.24 per thousand screenshots.
- **Maximum accuracy per request:** Qwen3-VL-32B Instruct, one pass better, twice as slow.
- **Stuck under 10B:** take the thinking variant without guilt — it's the only small model here that doesn't collapse on hard pages.
- **Skip for vision workloads:** Qwen3.5-35B-A3B (good model, wrong tool) and both thinking variants at 30B-plus (paying more to score less).

The complete harness — screenshots, expected facts, scoring code, and all six committed result directories — lives in [`test/vision`](https://github.com/esokullu/webbrain/tree/main/test/vision) on GitHub.
