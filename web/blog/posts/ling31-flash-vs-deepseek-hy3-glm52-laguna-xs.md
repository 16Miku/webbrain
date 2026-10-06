---
title: Ling 3.1 Flash vs DeepSeek, HY3, GLM-5.2, and Laguna XS: free inference, costly retries
slug: ling31-flash-vs-deepseek-hy3-glm52-laguna-xs
sortOrder: -330
date: 2026-10-06
readTime: 7 min read
description: Ling 3.1 Flash completes 100 pinned planner cases with 80.7% tool-family consensus, 32.8% exact consensus, 92 valid calls, and zero reported cost, after extensive Novita rate-limit recovery.
excerpt: Ling leads tool-family agreement and beats the four text-only references on ideal-tool count, but trails on exact-action consensus. Its free Novita route required 298 rate-limit responses across the benchmark and diagnostic campaign.
titleTag: Ling 3.1 Flash planner benchmark vs DeepSeek, HY3, GLM, and Laguna XS - WebBrain Blog
ogTitle: Ling 3.1 Flash in WebBrain's text-only planner benchmark
ogDescription: A pinned full-tier tool-calling test against DeepSeek V4 Flash, Tencent HY3, GLM-5.2, and Laguna XS 2.1, with measured coverage, latency, and cost.
twitterTitle: Ling 3.1 Flash vs four text-only browser planners
twitterDescription: Same pinned planner inputs, historical peers, and raw OpenRouter evidence. First-action agreement and argument validity are measured separately.
keywords:
  - Ling 3.1 Flash
  - inclusionAI
  - DeepSeek V4 Flash
  - Tencent HY3
  - GLM-5.2
  - Poolside Laguna XS 2.1
  - OpenRouter
  - browser agent benchmark
  - tool calling
author: Emre Sokullu
authorUrl: https://emresokullu.com
---

**Ling 3.1 Flash completed all 100 planner cases with zero reported inference cost, but getting those responses was difficult.** It leads the expanded fourteen-model pool on **tool-family consensus at 80.7%**, produces **92 schema-valid calls**, and chooses **42 ideal tools**. Its **32.8% exact-action consensus** trails all four text-only references, and its successful requests have a **3.19-second median**. The first pass returned only 15 responses; extensive retries were needed to finish. This is a useful text planner result with a serious serving limitation on the tested free route.

## A new text-only route

[OpenRouter lists Ling 3.1 Flash](https://openrouter.ai/inclusionai/ling-3.1-flash) as inclusionAI's **560B-total / 25B-active hybrid reasoning MoE**, released October 2. The route accepts text and returns text, with **262,144 tokens of context** and native function calling. Its captured October 6 Novita endpoint lists **zero input and output token prices**. It supports `tools` and `tool_choice`, but not `response_format`.

That makes it an interesting candidate for a browser planner working from accessibility trees and extracted text. This route cannot accept screenshots. The 25B active count describes per-token compute; the full 560B model still needs substantial storage and memory.

Our comparison focuses on the four text-only routes in the [American and Chinese open-model benchmark](/blog/american-chinese-open-model-frontier-gap-benchmark): **DeepSeek V4 Flash 0731, Tencent HY3, GLM-5.2, and Poolside Laguna XS 2.1**. MiniMax M3 remains a useful additional reference for a broader agent, although its tested route also accepts visual input. Every request in this planner suite contains text; no model receives a screenshot or video.

## Reconstructing the matching test

This post uses the **August full-tier checkout `7182c21f`**, rather than the May frozen interface from our [Ling 3.0 Flash VL comparison](/blog/ling30-flash-vl-vs-nex-n25-minimax-m3). The older Ling, Nex, and May-frozen MiniMax percentages belong to a different test and cannot be inserted here.

The August runs omitted request bodies. We reconstructed all 100 messages and their tool schemas from the exact pinned payload builder, site adapters, tool definitions, and questions, then saved a replay snapshot. We also archived the ideal-action rubrics from that checkout. Ling's new raw case files preserve both its request and the API response. The historical requests' full byte equality cannot be proven because those bodies were never stored.

**Only Ling is a new October 6 run.** The comparison models retain their August 2 results. These are matching reconstructed inputs across different serving dates, with potentially different infrastructure, cache state, and prices.

The source audit found **48 Act tools**, correcting the older article's count of 41. All 100 questions are Act-mode cases, so every new request uses **temperature 0.15** and a **4,096-token output budget**. We send native structured tools through OpenRouter Chat Completions, without a reasoning-effort override or a compatibility prompt. The per-request timeout is 180 seconds.

The test captures one response and executes no tools. A model can choose a sensible observation before acting and still miss the rubric's canonical first step. This is a first-action planner comparison, not a measure of completed browser tasks, visual reasoning, or recovery over a long session.

## What each score means

**Exact-action consensus** compares the first tool name and arguments with the other models on the same case. Normalization sorts object keys recursively; it preserves argument values, array order, extra arguments, and explicit defaults. Two no-tool responses agree with one another. A request failure supplies no model action.

**Tool-name consensus** drops the arguments and compares only the opening tool family. **Ideal tool** and **exact ideal** use the archived deterministic rubric, independently of the peer pool. Prose responses receive no ideal-tool credit. **Schema-valid / emitted** checks whether the tool exists and its arguments satisfy the archived JSON Schema; dispatching a call alone does not establish validity.

Before introducing Ling, we reproduced all thirteen original models' exact-action and tool-name consensus percentages and their emitted, valid, ideal-name, and exact-ideal counts from the 1,300 saved case files. Consensus measures agreement rather than correctness: a widely shared habit can still be a weak first step.

## The comparison: strong tool selection, weaker exact agreement

We added Ling to the original thirteen-model peer pool and recomputed every row. Each model now has **thirteen other peers and 1,300 comparisons**, rather than the original twelve peers and 1,200. All fourteen models remain peers, including those outside the text-only table. These updated consensus percentages therefore differ from the older post. Medians are also recalculated consistently as the average of the two middle observations; p95 uses the nearest-rank method.

| Model | Exact consensus | Tool consensus | Valid / emitted | Ideal tool | Exact ideal | Median | p95 | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Ling 3.1 Flash, new** | 32.8% | **80.7%** | **92 / 93** | **42** | 15 | 3.19s | 10.18s | **$0.000** |
| DeepSeek V4 Flash 0731 | **50.9%** | 80.5% | 90 / 90 | 39 | 18 | 1.58s | 5.24s | $0.050 |
| Tencent HY3 | 47.2% | 78.7% | 90 / 90 | 41 | 18 | 5.12s | 8.98s | $0.246 |
| GLM-5.2 | 43.2% | 77.0% | 86 / 89 | 39 | **20** | 1.73s | 4.44s | $0.545 |
| Poolside Laguna XS 2.1 | 40.6% | 74.0% | 88 / 89 | 31 | 5 | **1.15s** | **2.15s** | $0.073 |
| MiniMax M3, multimodal reference | 40.9% | 75.2% | 86 / 89 | 33 | 17 | 2.86s | 7.34s | $0.504 |

Each row has 100 inference responses. Ling's 93 emitted calls are all native; seven responses contain no parsed tool call. None reaches the output-token limit. Cost sums the saved response-level `usage.cost` fields; Ling has a cost record for every response. MiniMax is shown as an additional reference, rather than one of the four text-only routes.

**Ling ranks twelfth of fourteen by exact consensus, while leading tool-family consensus.** Those results can coexist. It usually chooses the action family its peers choose, then supplies different arguments. It also has the highest ideal-tool count among these five text-only routes, although a one-case lead over HY3 is too small to support a broad capability claim. GLM retains the stronger exact-ideal result at 20 versus Ling's 15.

The pairwise results make the distinction easier to see:

| Ling compared with | Same tool family, /100 | Same exact action, /100 |
| --- | ---: | ---: |
| DeepSeek V4 Flash | **88** | 41 |
| Tencent HY3 | 83 | 33 |
| GLM-5.2 | 86 | 41 |
| Poolside Laguna XS 2.1 | 80 | 33 |
| MiniMax M3 | 80 | 33 |

An important source of disagreement is accessibility-tree depth. Ling opens with `get_accessibility_tree` on 43 cases. It uses only `filter: "visible"` on eight of those calls, while nineteen also specify `maxDepth: 10` and others choose different depths or filters. Extra valid arguments can reduce exact agreement without making a call unsafe. The score measures the entire proposed action, including these choices.

There is one actual schema defect: **case 092 emits `press_keys({key: "m"})`**, but `m` is outside the key enum in the sent tool definition. We retain the raw response and mark that call invalid. The other 92 emitted calls satisfy the archived schema. This supports argument validation in an agent even when native dispatch coverage is high.

## Availability: 100 responses took 398 recorded requests

The new key authenticated successfully. OpenRouter's errors identified Novita's **upstream shared pool** as temporarily rate-limited. A minimal text probe and a fresh-connection check also returned HTTP 429, so the problem extended beyond a particular browser question.

The first suite pass used concurrency three and the runner's nominal 10-second post-case delay option. We archived all 100 results, then resumed failed cases with **30-second backoffs and up to ten retries per case**. The first recovery round brought coverage to 91 cases. A final pass recovered the remaining nine. Each case keeps its first successful inference; retries target rejected requests.

| Campaign stage | HTTP requests | Inference responses | HTTP 429 responses |
| --- | ---: | ---: | ---: |
| First suite pass | 100 | **15** | **85** |
| Entire benchmark plus availability diagnostics | **398** | **100** | **298** |

Of the 398 recorded requests, **390 belong to the benchmark passes and eight to availability diagnostics**. The three timed benchmark passes total **41.2 minutes**, including runner delays and retry backoffs, but excluding setup, diagnostics, and gaps between processes. The table's 3.19-second median measures successful final HTTP attempts only, including network and generation time. It does not describe how long a caller waits through repeated failures.

This is the largest practical limitation in the result. A free token price helps a batch experiment, but a browser agent still needs timely responses. The historical comparison runs completed without API errors or retries on their test date. That is an observation across different dates and infrastructure, rather than a permanent reliability ranking of the models.

## Zero cost still needs serving and cache context

Ling's 100 responses report **2,444,290 prompt tokens**, **19,095 completion tokens**, and **14,888 reasoning tokens** within completion usage. The API reports **2,308,288 cached prompt tokens**, or **94.4%** of the prompt total. All responses identify Novita as the provider, and their summed `usage.cost` is **$0**.

The captured route lists zero prompt and completion rates on October 6. The free-price result therefore comes from the offered endpoint rates, while the large reported cache share remains relevant to latency. It does not establish an uncached speed measurement or a future price guarantee. Historical bills in the comparison also reflect their own cache conditions and August prices.

Among the references, DeepSeek remains inexpensive at five cents for its saved 100-response replay and has stronger exact consensus with a lower median. Laguna XS is the fastest at 1.15 seconds and costs seven cents in its saved run. Ling chooses more ideal tools and emits more schema-valid calls than either, but its exact-action agreement is lower and its tested route requires substantial retry recovery. HY3 is slower at the median, while GLM produces more exact ideal actions.

The result gives Ling a clear reason to be tested further: **good tool-family selection and broad native dispatch at a zero observed token bill**. It also gives a clear deployment question: whether a route with steadier capacity preserves that behavior. This free shared-pool run supplies encouraging planner evidence, but its first-pass availability is too weak to recommend it as the sole synchronous browser-agent endpoint.

## Evidence and reproduction

The [raw Ling cases](https://github.com/webbrain-one/webbrain/tree/main/test/llm/results/2026-10-06-openrouter-ling31-flash-full-7182_chrome_inclusionai_ling-3.1-flash) and [analysis artifacts](https://github.com/webbrain-one/webbrain/tree/main/test/llm/analysis/2026-10-06-ling31-flash) accompany this post. The complete inputs are saved in `test/llm/freeze/full-replay-7182c21f.json`. The preparation script reconstructs them from the pinned Git revision and records SHA-256 hashes for the source files, questions, and rubrics.

```powershell
node test/llm/prepare-frontier-replay.mjs
node test/llm/report-ling31-comparison.mjs --historical-only
```

After setting `OPENROUTER_API_KEY` in the process environment, the runner can replay those inputs. The analysis README records the live run's pacing and retry configuration. API credentials are absent from saved requests and reports.

```text
Raw Ling cases and summary:
test/llm/results/2026-10-06-openrouter-ling31-flash-full-7182_chrome_inclusionai_ling-3.1-flash/

Comparison, provenance, rubrics, endpoint metadata, and availability evidence:
test/llm/analysis/2026-10-06-ling31-flash/

Offline report generator:
test/llm/report-ling31-comparison.mjs
```

```powershell
node test/llm/report-ling31-comparison.mjs
node scripts/build-blog.mjs
```

Tags: #Ling31Flash #inclusionAI #DeepSeekV4 #TencentHY3 #GLM52 #Poolside #LagunaXS #MiniMaxM3 #OpenRouter #ToolCalling #BrowserAgent #WebBrain
