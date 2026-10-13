---
draft: true
title: HY4 Preview vs MiMo V2.6 Pro and Flash vs Liquid LFM2.5: a browser-agent benchmark
slug: hy4-mimo-v26-lfm25-browser-agent-benchmark
sortOrder: -350
date: 2026-10-14
readTime: 8 min read
description: A matching WebBrain benchmark of Tencent HY4 Preview, Xiaomi MiMo V2.6 Pro and Flash, and Liquid LFM2.5-24B-A2B, with pinned planner inputs and separate MiMo screenshot tests.
excerpt: Four new planners span a 24B local-agent model and trillion-parameter multimodal systems. The planned comparison uses 400 first-action cases and 200 screenshots, with dated historical references.
titleTag: HY4 Preview, MiMo V2.6, and Liquid LFM2.5 browser benchmark - WebBrain Blog
ogTitle: HY4 Preview vs MiMo V2.6 vs Liquid LFM2.5
ogDescription: Pinned first-action planning and production screenshot description, with native-call validity, measured latency, usage cost, and committed raw evidence.
twitterTitle: HY4 Preview vs MiMo V2.6 vs Liquid LFM2.5
twitterDescription: Four planners, two vision-capable routes, and matching historical references in WebBrain's browser-agent benchmark.
keywords:
  - Tencent HY4 Preview
  - MiMo V2.6 Pro
  - MiMo V2.6 Flash
  - Liquid LFM2.5-24B-A2B
  - OpenRouter
  - browser agent benchmark
  - tool calling
  - vision model
  - open weights
author: Emre Sokullu
authorUrl: https://emresokullu.com
---

**Draft: the live benchmark is pending a fresh OpenRouter credential.** This post is excluded from the published blog build. Model descriptions and methodology are prepared; there are no new measured results or winner claims yet.

## Four very different models

This comparison extends the [American and Chinese frontier planner benchmark](/blog/american-chinese-open-model-frontier-gap-benchmark) and the [Qwen3.8 Flash vs GLM-5.3 Flash comparison](/blog/qwen38-flash-vs-glm53-flash). All four requested routes support native tools. Two can also read screenshots.

| Model | Disclosed total / active parameters | Inputs on the requested OpenRouter route | Advertised context |
| --- | --- | --- | ---: |
| Tencent HY4 Preview | 770B / 49B backbone | Text | 1,048,576 |
| MiMo-V2.6-Pro | 1.02T / 42B | Text, image, video, audio | Up to 1,050,000 |
| MiMo-V2.6-Flash | 309B / 15B | Text, image, video, audio | Up to 1,050,000 |
| Liquid LFM2.5-24B-A2B | 24B / about 2B | Text | 128,000 on this route |

[Tencent's HY4 card](https://huggingface.co/tencent/Hy4-preview) describes a 78-layer MoE with Gated DeepSeek Sparse Attention, cross-layer index reuse, and identity Hyper-Connections. Its backbone figures exclude the separate 10B multi-token-prediction layer. Tencent also flags excess reasoning and over-verification as known preview limitations. Our single-response test can measure the opening dispatch, but not sustained productivity across a long task.

The [MiMo Pro](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL) and [MiMo Flash](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL) releases have native visual and audio components alongside their sparse language backbones. Their model cards describe reinforcement learning across multiple agent domains and harnesses. Those training claims motivate this test; they are not WebBrain results.

[Liquid's October 13 release](https://www.liquid.ai/blog/lfm2-5-24b-a2b) is a smaller open-weight model intended for local agents. It combines gated short convolutions with grouped-query attention and a sparse expert network. The release is reasoning-only, unlike its predecessor. Liquid advertises 131,072 context for the checkpoint, while the captured OpenRouter endpoint lists 128,000. The hosted benchmark does not measure local-device speed or memory requirements.

Active parameter counts describe work per token; they do not describe the size of the checkpoint to download or load. The full model sizes remain very different.

## Matching the planner inputs

The planner comparison uses the August full-tier source checkout **`7182c21f`**, reconstructed into our existing replay snapshot. Every model receives the same 100 Chrome Act cases, **48 native tool definitions**, temperature **0.15**, and **4,096-token** output budget. We apply no reasoning-effort override, system-prompt folding, or compatibility tool syntax. Only the model ID changes.

The report first reproduces the original thirteen-model consensus and the schema-valid and ideal-action counts from all 1,300 historical case files. It then adds the four complete new models and rescores every model against its other sixteen peers: **1,600 comparisons per model**. The old thirteen-model percentages are not copied into that expanded ranking.

Exact-action consensus compares the entire first tool and arguments after recursively sorting object keys. Tool-name consensus ignores the arguments. Native calls, content fallback, malformed argument JSON, schema-valid calls, canonical ideal tool names, and exact ideal actions are recorded separately. No-tool responses agree with other no-tool responses; rejected API requests are availability evidence and never model answers.

Only the four new routes receive new planner inference. August peer results retain their historical serving conditions and bills. Historical requests were omitted, so source reconstruction establishes matching intended inputs without proving full historical request-byte equality. No browser tool is executed: this is an opening-action test, not browser-task success.

## Separate screenshot tests for MiMo

Both MiMo routes receive the same 100 actual 1280×720 screenshots used in the production vision suite. HY4 and Liquid's text-only routes remain unscored for vision. The comparison references are the saved August 27 Qwen3.8 Flash and GLM-5.3 Flash runs.

The vision prompt asks for page purpose, exact visible text, input states, state signals, blockers, and unknowns. Requests use temperature **0**, **800-token** maximum, the original thinking-disabling chat-template kwargs, and fixed production user text without benchmark focus questions. Provider auto-routing is retained.

The unchanged deterministic grader combines weighted substring checks with a section-structure score, the case threshold, and critical-check gating. Six complete numbered sections are tracked separately rather than being a separate hard pass condition. Literal matching may reject a recognized synonym, and numbered analysis can resemble sections. Reported reasoning tokens, clipping, empty outputs, and raw streams are therefore part of the evidence.

The offline audit already reproduces all 200 historical Qwen/GLM vision grades and verifies prompt, image, question, rubric, and scorer parity. New screenshot scores, latency, and bills will be inserted only after actual inference.

## Results pending

The completed post will include the planner comparison, MiMo screenshot comparison and difficulty bands, serving coverage, provider/cache/token context, and conclusions supported by the saved responses. No scores, costs, or ranking are estimated from the model cards.

## Evidence and reproduction

Preparation, captured public endpoint metadata, archived ideal actions, and historical regressions are under `test/llm/analysis/2026-10-14-hy4-mimo26-lfm25/`. The configuration records all planned raw result directories. Each preflight has a separate tag; it will not enter a 100-case quality row.

After setting `OPENROUTER_API_KEY` in the process environment:

```powershell
node test/llm/run-hy4-mimo26-lfm25.mjs --preflight
node test/llm/run-hy4-mimo26-lfm25.mjs
node test/llm/report-hy4-mimo26-lfm25.mjs
node scripts/build-blog.mjs
```

The runner refuses to overwrite existing evidence. Raw requests/responses, failed attempts, preflights, usage, timing, and analysis accompany the completed post. API credentials and authorization headers are not stored.
