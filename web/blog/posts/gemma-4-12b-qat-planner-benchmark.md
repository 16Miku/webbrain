---
title: >
  Gemma 4 12B QAT is fast enough for WebBrain, but Qwen 3.5 9B still routes a little better
slug: gemma-4-12b-qat-planner-benchmark
sortOrder: -5
date: 2026-06-20
readTime: 6 min read
description: >
  We tested google/gemma-4-12B-it-qat-w4a16-ct through vLLM against WebBrain's frozen first-tool-call browser-agent harness at concurrency 8, then ran the same vision probe used in earlier local-model posts.
excerpt: >
  Gemma 4 12B QAT lands as a very fast local WebBrain planner: 92/100 parsed calls, 14% exact, 33% tool-name match, 0.43s median per request, and a working but imperfect vision probe.
titleTag: >
  Gemma 4 12B QAT WebBrain planner benchmark - WebBrain Blog
ogTitle: >
  Gemma 4 12B QAT is a fast local WebBrain planner
ogDescription: >
  The 12B QAT Gemma run beats the older Gemma 4 12B Coder Fable5 Composer 2.5 result, but Qwen 3.5 9B still has a small routing-quality lead.
twitterTitle: >
  Gemma 4 12B QAT WebBrain planner benchmark
twitterDescription: >
  92 parsed calls, 14 exact first-actions, 0.43s median, and a mixed vision probe for Gemma 4 12B QAT on vLLM.
keywords:
  - WebBrain
  - Gemma 4
  - Gemma 4 12B
  - QAT
  - vLLM
  - local LLM
  - browser agent
  - tool calling
  - Qwen 3.5 9B
lede: >
  We ran **google/gemma-4-12B-it-qat-w4a16-ct** through WebBrain's frozen first-tool-call planner harness on the currently running local vLLM server at port 8000. The result is a useful middle tier: much faster than the older Gemma 4 12B Coder Fable5 Composer 2.5 run and stronger on routing, but still a small step behind Qwen 3.5 9B on strict first-action quality.
---

## What we ran

The live vLLM server reported:

```text
model id: gemma-4-12b
root: google/gemma-4-12B-it-qat-w4a16-ct
max context reported by vLLM: 65536
```

The planner command was the same frozen legacy harness used in the recent Gemma 4 31B QAT post, with one important operational difference: this run used concurrency 8 because this vLLM instance is currently configured to allow eight parallel requests.

```bash
node test/llm/run-llamacpp.mjs \
  --base http://127.0.0.1:8000 \
  --model gemma-4-12b \
  --tag 2026-06-20-vllm-12b-qat \
  --concurrency 8 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json \
  --chat-template-compat alternating
```

That means 100 single-turn browser-agent prompts, the May 23 Claude Sonnet 4.6 WebBrain system prompt and 41-tool schema, legacy text-call compatibility, no native OpenAI `tools` field, and up to eight active requests at a time.

The clean rerun completed all 100 cases without transport errors in 7.7 seconds of wall time. The latency numbers below are still per-case response latencies, not wall time divided by 100.

Result files:

```text
test/llm/results/2026-06-20-vllm-12b-qat_chrome_gemma-4-12b_frozen
```

## The result

| Metric | Gemma 4 12B QAT w4a16 |
| --- | ---: |
| Completed cases | 100/100 |
| Transport errors | 0 |
| Parsed calls | 92/100 |
| Exact first-call match | 14/100 |
| Tool-name match | 33/100 |
| Average latency | 0.52s |
| Median latency | 0.43s |
| p95 latency | 0.73s |
| Slowest case | 2.70s |
| Benchmark wall time | 7.7s at concurrency 8 |

The model is decisive: only eight no-tool answers, and no request failures in the final run. It still has the familiar local-planner habit of over-reading the page before acting: `get_accessibility_tree` was the first tool in 43 cases.

## The nearby local-model table

This is the most useful comparison tier for the 12B QAT run. The table uses the same strict `idealFirstToolCall` scoring as the previous QAT benchmark, plus the Sonnet-reference tool-name alignment used by the older local leaderboard.

| Model | Serving path | Parsed calls | Exact | Name | Sonnet match | Sonnet tooled | Median | p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Gemma 4 31B QAT w4a16 | vLLM QAT | 95/100 | 19% | 37% | 77.0% | 78.3% | 0.55s | 1.07s |
| Qwen 3.5 9B | vLLM int4 AutoRound | 90/100 | 15% | 35% | 70.0% | 69.6% | 0.91s | 1.65s |
| Gemma 4 12B QAT w4a16 | vLLM QAT, c=8 | 92/100 | 14% | 33% | 67.0% | 67.4% | 0.43s | 0.73s |
| Gemma 4 12B Coder Fable5 Composer 2.5 | `llama.cpp Q4_K_M` | 94/100 | 9% | 26% | 61.0% | 62.0% | 1.91s | 2.81s |

The clean read:

- Against **Qwen 3.5 9B**, Gemma 4 12B QAT is faster and has two more parsed calls, but Qwen still wins strict action quality by a small margin: +1 exact match, +2 tool-name matches, and +3 Sonnet-reference points.
- Against **Gemma 4 12B Coder Fable5 Composer 2.5**, the QAT model is the better browser-agent planner: +5 exact matches, +7 tool-name matches, +6 Sonnet-reference points, and about 4.4x lower median latency.
- Against **Gemma 4 31B QAT**, the 12B model is clearly the smaller tier. It is faster in this concurrency-8 run, but the 31B model still has a real quality lead: +5 exact matches, +4 tool-name matches, and +10 Sonnet-reference points.

So the 12B QAT checkpoint is not the new local routing leader. It is the better small Gemma planner.

## What concurrency 8 changes

The run was intentionally saturated. With `--concurrency 8`, the harness keeps up to eight chat-completion requests in flight, which is why the whole 100-case replay finished in 7.7 seconds and why GPU utilization looks higher than a normal WebBrain browser loop.

That is useful for throughput testing, but it is not how one interactive extension tab usually behaves. For product feel, the median per-case latency matters more: 0.43s here is comfortably interactive. For server sizing, the wall time matters: vLLM can chew through the frozen replay very quickly when batching parallel prompts.

## Vision probe

The same fixed Google password-verification screenshot was sent through `test/vision-probe.mjs`:

```bash
node test/vision-probe.mjs \
  test/fixtures/google-signin-password-error.jpg \
  http://127.0.0.1:8000 \
  gemma-4-12b
```

Timing:

| Vision probe metric | Value |
| --- | ---: |
| TTFT | 1.90s |
| Total time | 3.49s |
| Prompt tokens | 595 |
| Completion tokens | 176 |

What it got right:

- the Google account password verification page,
- the password field and empty value,
- the "Show password" checkbox,
- the "Try another way" and "Next" actions,
- the red password error state and text "Enter a password".

What it missed:

- It misread `esokullu@gmail.com` as `ewakullu@gmail.com`.
- It still wrote `Blockers: None`, even though an empty password field on a verification screen is obviously blocking progress.

That makes the vision result usable for page-state awareness, but not clean enough for identifier-sensitive routing. Compared with Qwen 3.5 9B's earlier vision run, the Gemma 12B QAT endpoint is much cheaper on image tokens and faster end-to-end, but Qwen's UI OCR and account-chip classification remain stronger. Compared with Gemma 4 31B QAT, the total time is almost identical, but the 12B model loses the account string.

## What this changes

Gemma 4 12B QAT is now the local Gemma result I would use when the 31B model is too large and the older 12B Coder build is the alternative. It is materially better than that Coder run for first-action routing and fast enough that the browser loop should feel immediate.

It does not displace Qwen 3.5 9B as the small local planner with the cleaner routing profile. Qwen still makes slightly better first-tool choices in this saved replay. The reason to pick Gemma 4 12B QAT is speed, Gemma-family consistency, and a working low-token vision path. The reason to pick Qwen 3.5 9B is better affordance/OCR behavior and a small but real edge in first-action quality.
