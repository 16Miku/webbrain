---
title: >
  Gemma 4 31B QAT quietly becomes the best local Gemma planner we have tested
slug: gemma-4-31b-qat-planner-benchmark
sortOrder: 0
date: 2026-06-20
readTime: 7 min read
description: >
  We tested google/gemma-4-31B-it-qat-w4a16-ct through vLLM against WebBrain's frozen first-tool-call browser-agent harness. It improves over the older Gemma 4 31B int4 run and narrowly edges Qwen 3.6 27B on strict first-action quality while running much faster.
excerpt: >
  Gemma 4 31B QAT is not branded like a new generation, but in WebBrain's local planner bench it behaves like a meaningful upgrade: 95/100 parsed calls, 19% exact, 37% tool-name match, and 0.55s median latency.
titleTag: >
  Gemma 4 31B QAT WebBrain planner benchmark - WebBrain Blog
ogTitle: >
  Gemma 4 31B QAT becomes the best local Gemma planner we have tested
ogDescription: >
  The QAT w4a16 Gemma 4 31B run improves over the older Gemma 31B int4 result and narrowly beats Qwen 3.6 27B on strict first-action quality.
twitterTitle: >
  Gemma 4 31B QAT WebBrain planner benchmark
twitterDescription: >
  QAT turns Gemma 4 31B into a stronger and faster local browser-agent planner.
keywords:
  - WebBrain
  - Gemma 4
  - Gemma 4 31B
  - QAT
  - vLLM
  - local LLM
  - browser agent
  - tool calling
  - Qwen 3.6 27B
lede: >
  We ran **google/gemma-4-31B-it-qat-w4a16-ct** through the same frozen WebBrain first-tool-call harness we use for local planner comparisons. The result is small on branding and big in practice: the QAT build improves over the older Gemma 4 31B int4 result, narrowly edges Qwen 3.6 27B on strict first-action quality, and does it with sub-second median latency.
---

## What we ran

The endpoint was a local vLLM server exposing:

```text
model id: gemma-4-31b
root: google/gemma-4-31B-it-qat-w4a16-ct
max context reported by vLLM: 65536
```

We used the same frozen legacy planner harness as the latest local-model post:

```bash
node test/llm/run-llamacpp.mjs \
  --base http://127.0.0.1:8000 \
  --model gemma-4-31b \
  --tag 2026-06-20-vllm-legacy \
  --concurrency 1 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json \
  --chat-template-compat alternating
```

That means 100 single-turn browser-agent prompts, the May 23 Claude Sonnet 4.6 WebBrain system prompt and 41-tool schema, legacy text-call compatibility, no native OpenAI `tools` field, and one active request at a time.

The result files are in:

```text
test/llm/results/2026-06-20-vllm-legacy_chrome_gemma-4-31b_frozen
```

## The result

| Metric | Gemma 4 31B QAT w4a16 |
| --- | ---: |
| Completed cases | 100/100 |
| Transport errors | 0 |
| Parsed calls | 95/100 |
| Exact first-call match | 19/100 |
| Tool-name match | 37/100 |
| Average latency | 0.67s |
| Median latency | 0.55s |
| p95 latency | 1.07s |
| Slowest case | 5.01s |
| Observed GPU memory | ~30.1 GB used on RTX 5090 |

This is the best Gemma-family local planner result we have saved so far.

The older Gemma 4 31B int4 AutoRound run was already useful, but the QAT build improves every first-action metric that matters here:

| Model | Parsed calls | Exact | Name | Median | p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Intel Gemma 4 31B int4 AutoRound | 88/100 | 14% | 34% | 0.63s | 1.46s |
| Gemma 4 31B QAT w4a16 | 95/100 | 19% | 37% | 0.55s | 1.07s |

The improvement is not just a formatting cleanup. The QAT model reduced no-tool answers from 12 to 5, raised exact first-call matches by 5 points, and slightly reduced the over-cautious `get_accessibility_tree` habit from 45 calls to 41. It still inspects pages often, but it is less likely to stall out before making a usable first move.

## The Qwen 3.6 27B comparison

This is the part that makes the run interesting beyond the Gemma family.

| Model | Parsed calls | Exact | Name | Median latency |
| --- | ---: | ---: | ---: | ---: |
| Qwen 3.6 27B | 92/100 | 18% | 37% | 10.2s |
| Gemma 4 31B QAT w4a16 | 95/100 | 19% | 37% | 0.55s |

So yes: in this strict first-action replay, Gemma 4 31B QAT narrowly beats Qwen 3.6 27B on quality. It is not a blowout. It is +3 parsed calls, +1 exact point, and a tied tool-name score. But the latency difference is not narrow at all: 0.55s median versus 10.2s.

That gives it a very different profile from the usual "larger local model is smarter but slower" tradeoff. Here, the QAT Gemma run is both slightly better and dramatically faster in this vLLM setup.

The naming is also refreshingly literal. This feels like the kind of improvement people might have called "Gemma 4.1 31B" if it had shipped as a conventional checkpoint refresh. Google named the mechanism instead: QAT. That is probably more honest. The model is not claiming to be a new generation; it is a quantization-aware serving-oriented variant that behaves like a real planner upgrade.

The analogy to the Qwen 3.5 to Qwen 3.6 jump is useful, but with one caveat: we do not have a saved Qwen 3.5 27B run in this WebBrain result set. So this is not a measured Qwen-style before/after. It is a behavioral analogy: the same base family suddenly feels more useful for agent routing because the deployed variant changed the practical quality-speed frontier.

## Sonnet 4.6 as the reference

The strict ideal-first-call replay is useful, but the older WebBrain benchmark used a different reference: treat Claude Sonnet 4.6 as the truth and ask how often each model picked the same first tool.

Here is that view updated with the newer runs. The original May rows come from the published Sonnet export. The newer rows were scored against the same 100 Sonnet tool-name picks from that export, so this table is about first-tool alignment, not argument equality.

| # | Model | Match all | Match when Sonnet tooled | Tool-call rate | Valid-name rate | Median |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| ref | Claude Sonnet 4.6 | 100% | 100% | 92% | 92% | 2.8s |
| 1 | Gemma 4 31B QAT w4a16 | 77.0% | 78.3% | 95% | 95% | 0.55s |
| 2 | Qwen 3.6 27B | 77.0% | 77.2% | 92% | 92% | 10.2s |
| 3 | MiniMax M2.7 | 77.0% | 76.1% | 88% | 88% | 3.1s |
| 4 | Intel Gemma 4 31B int4 AutoRound | 74.0% | 72.8% | 88% | 87% | 0.63s |
| 5 | Qwen 3.5 4B | 73.0% | 71.7% | 82% | 82% | 5.5s |
| 6 | Gemma 4 26B-A4B | 71.0% | 70.7% | 87% | 87% | 1.4s |
| 7 | Qwen 3.6 35B-A3B | 70.0% | 70.7% | 90% | 90% | 10.3s |
| 8 | Qwen 3.5 9B | 70.0% | 69.6% | 90% | 89% | 0.91s |
| 9 | Gemma 4 E4B | 68.0% | 68.5% | 87% | 87% | 4.5s |
| 10 | Nemotron Omni 30B | 67.0% | 68.5% | 93% | 93% | 2.6s |
| 11 | DiffusionGemma 26B-A4B | 67.0% | 64.1% | 79% | 79% | 0.35s |
| 12 | Gemma 4 E2B | 63.0% | 60.9% | 76% | 75% | 4.0s |
| 13 | Gemma 4 12B Coder Fable5 Composer 2.5 | 61.0% | 62.0% | 94% | 94% | 1.9s |
| 14 | Cohere North-Mini-Code 1.0 | 59.0% | 58.7% | 93% | 93% | 3.2s |
| 15 | Browser-Use Qwen 30B-A3B Q4 | 43.0% | 45.7% | 93% | 93% | 0.48s |
| 16 | LFM 2.5 | 40.0% | 38.0% | 83% | 83% | 5.9s |
| 17 | Qwen 3.5 0.8B | 37.0% | 34.8% | 90% | 90% | 0.45s |
| 18 | Qwen 3.5 2B | 36.0% | 34.8% | 89% | 89% | 0.78s |
| 19 | VibeThinker 3B BF16 | 33.0% | 32.6% | 84% | 81% | 5.0s |
| 20 | Molmo2 8B | 8.0% | 0.0% | 2% | 1% | 1.7s |

This is the strongest version of the QAT result. In the Sonnet-reference table, Gemma 4 31B QAT ties the best all-case score from the earlier benchmark and takes the tiebreaker on the 92 prompts where Sonnet actually called a tool. It is only a small quality lead, but it comes with a huge latency gap: 0.55s median for QAT versus 10.2s for Qwen 3.6 27B.

The newer small and specialty runs also make more sense in this lens. DiffusionGemma remains a speed story, not a top Sonnet-alignment story. Gemma 4 12B Coder and North are highly parseable but less Sonnet-like in first-tool choice. VibeThinker stays near the bottom, which matches its own model-card warning about tool-calling and autonomous-agent use. Molmo2 8B is effectively not a text tool-calling planner in this harness.

## Vision probe

The vision probe also passed.

Against the Google password verification screenshot, Gemma 4 31B QAT correctly identified:

- the Google account password verification page,
- the visible account text,
- the password field and empty value,
- the "Show password" checkbox,
- the "Enter a password" error state.

Timing was also solid:

| Vision probe metric | Value |
| --- | ---: |
| TTFT | 1.31s |
| Total time | 3.50s |
| Prompt tokens | 595 |
| Completion tokens | 152 |

One small miss: the model listed "Blockers: None" even though an authentication prompt is obviously a blocker for continuing. For WebBrain, that is the kind of detail a follow-up prompt tweak can usually tighten. The important part is that the endpoint accepted image input and produced a structured caption usable by the planner.

## What this changes

For the current WebBrain local planner table, Gemma 4 31B QAT now belongs above the older Gemma 31B int4 run and just above Qwen 3.6 27B on strict first-action quality.

The broader leaderboard still has stronger action routers. MiniMax M2.7, Sonnet 4.6, and Qwen 3.6 35B-A3B still beat it on exact or name-only matching in the saved runs. But Gemma 4 31B QAT has the best balance we have seen from a local Gemma: high parseability, competitive first-action selection, working vision, and latency that keeps the browser loop feeling interactive.

The clean takeaway: this is not just a smaller file or a faster serving trick. In this harness, QAT made Gemma 4 31B a better browser-agent planner.
