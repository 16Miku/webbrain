---
title: Ling 3.0 Flash VL vs Nex-N2.5 and MiniMax M3: a cheaper frozen planner
slug: ling30-flash-vl-vs-nex-n25-minimax-m3
sortOrder: -320
date: 2026-10-05
readTime: 7 min read
description: Ling 3.0 Flash VL completes WebBrain's frozen 100-case planner test with 72% Sonnet alignment, 22 exact actions, a 1.73s median, and $0.00977 observed cost. Compare Nex-N2.5 Pro, mini, and MiniMax M3, with cache and pricing context.
excerpt: Ling doubles Nex Pro's exact-action count and runs much faster. MiniMax M3 keeps the stronger Sonnet alignment. Ling's sub-cent replay cost benefits from a promotional route and 94.7% cached prompt tokens.
titleTag: Ling 3.0 Flash VL vs Nex-N2.5 and MiniMax M3 - WebBrain Blog
ogTitle: Ling 3.0 Flash VL: 72% planner alignment for a sub-cent cached replay
ogDescription: 100 completed cases, 22 exact actions, and a 1.73s median. Compare Nex-N2.5 Pro, mini, and MiniMax M3, including Ling's uncached pricing estimate.
twitterTitle: Ling 3.0 Flash VL in WebBrain's frozen planner benchmark
twitterDescription: Faster and cheaper than saved Nex Pro and MiniMax M3 runs. 72% Sonnet alignment, 22 exact actions; 94.7% prompt caching helps the $0.00977 observed cost.
keywords:
  - Ling 3.0 Flash VL
  - inclusionAI
  - Nex-N2.5-Pro
  - Nex-N2.5-mini
  - MiniMax M3
  - OpenRouter
  - browser agent benchmark
  - tool calling
author: Emre Sokullu
authorUrl: https://emresokullu.com
---

**Ling 3.0 Flash VL is a strong budget-planner candidate in this test.** It completed WebBrain's frozen 100-case suite with **72% Sonnet tool-name alignment**, **22 exact ideal actions**, and a **1.73-second median**. The observed replay cost was **$0.00977**, helped by a promotional provider route and **94.7% cached prompt tokens**. It beats our saved Nex-N2.5-Pro run on first-action scores, speed, and reported cost. MiniMax M3 retains higher Sonnet alignment, while Nex-N2.5-mini's hosted tool route remains blocked.

## What Ling brings to the comparison

[Ling 3.0 Flash VL](https://huggingface.co/inclusionAI/Ling-3.0-flash-VL) is inclusionAI's native image-and-video model, built on a **124B-total / 5.5B-active MoE**. Its model card describes a 42-layer hybrid backbone with KDA and Gated MLA layers in a 5:1 ratio, a visual encoder, and an MLP projector. The release supports a context window up to 256K tokens and carries an MIT license.

Those properties make it interesting for browser agents: a large stored model, relatively small active compute, and native visual input. A 5.5B-active model still needs to store its full weights, however. This post tests a hosted API; it does not establish a local hardware or throughput result.

The [OpenRouter route](https://openrouter.ai/inclusionai/ling-3.0-flash-vl) offers native tools and reasoning, with Novita and DeepInfra endpoints. Our captured metadata lists 262,144 tokens of context on Novita and 131,072 on DeepInfra. We used automatic routing, and **all 100 measured responses came from Novita**.

Despite the VL name, this is a **text-only planner test**. We send browser context, instructions, and tool schemas, without screenshots or video. Ling's vision quality is outside this comparison.

## The same frozen interface and scoring

We reused the May 23, 2026 snapshot at `test/llm/freeze/baseline-2026-05-23.json`: the saved Sonnet 4.6 system prompt, **41 structured tools**, and system hash beginning `5c4fac1387025050`. Ling ran with concurrency 2, a 180-second timeout, and a 4,096-token output budget. No provider or reasoning effort was pinned. The runner uses temperature 0.15 for action modes and 0.3 for Ask.

The ideal actions come from the original May 23 goldens, already archived for our [Nex-N2.5 comparison](/blog/nex-n25-pro-vs-mini-frozen-planner). We did not mix September's updated tab-tool and screenshot rubrics into this older interface.

We reran Ling and performed an authenticated mini route check on October 5. The comparison carries forward Nex Pro's October 3 run, mini's October 3 rejection records, and [MiniMax M3's June 21 run](/blog/minimax-m3-webbrain-cloud-tool-calling). These are historical references, not four models served simultaneously on identical infrastructure.

Each score has a specific meaning:

- **Native calls** counts first responses containing an OpenAI tool call, even if its arguments have a defect.
- **Exact ideal** requires the expected tool name and deep-equal arguments.
- **Ideal name** requires the expected tool name, ignoring arguments.
- **Sonnet alignment** compares the chosen tool name with saved Sonnet 4.6, including agreement on no tool.

Sonnet agreement is not a correctness judge. Exact matching can also penalize harmless extra arguments or alternative first steps. Terminal prose receives no ideal-tool credit. The runner captures one response and executes no tools, so these are first-action scores rather than completed browser tasks.

The system prompt and tools are pinned. Per-turn context and site guidance are assembled by the runner; historical MiniMax requests were not saved, so complete payload byte equality with that run cannot be verified.

## Headline comparison: Ling, Nex Pro, Nex mini, and M3

| Model | Native calls | Exact ideal | Ideal name | Sonnet alignment | Median | p95 | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Ling 3.0 Flash VL, new** | 90/100 | **22/100** | **35/100** | 72.0% | **1.73s** | **2.91s** | **$0.00977** |
| Nex-N2.5-Pro | **95/100** | 11/100 | 27/100 | 67.0% | 7.23s | 20.87s | $0.14999 |
| Nex-N2.5-mini, route blocked | 0/100 | N/A | N/A | N/A | N/A | N/A | N/A |
| MiniMax M3 | 85/100 | 17/100 | 32/100 | **75.0%** | 3.10s | 8.20s | $1.05621 |

Ling, Pro, and M3 each returned 100 API responses with no transport errors. Mini's zero calls come from rejection before inference; they are not a zero accuracy result. The historical runs and new Ling run used concurrency 2.

**Against Nex Pro, Ling wins the measured tradeoff.** It doubles the exact-action count, chooses the ideal tool eight more times, and gains five points of Sonnet alignment. Its median is about 4.2 times lower, with a much tighter p95. Pro emits five more native calls, but that extra coverage does not produce stronger first-action scores.

**Against MiniMax M3, the quality result is split.** Ling produces five more exact actions and three more ideal tool names. M3 agrees with Sonnet three more times. Neither model wins every quality measure, and a three-case alignment difference in one 100-case run should not be treated as a settled capability ranking.

The latency and cost advantages belong to these measured endpoint paths and dates. They do not isolate model architecture from provider infrastructure, caching, or pricing.

## Why the sub-cent cost needs context

Novita's captured promotional pricing was **$0.021/M input**, **$0.0616/M output**, and **$0.0042/M cache read**, with an advertised **72% discount**. DeepInfra's listed input/output rates were $0.06/$0.18. Automatic routing does not promise that a future call will use the lowest advertised route.

Our Ling run recorded **1,810,646 prompt tokens**, of which **1,715,520 were cached**, plus **9,197 completion tokens**. Summing the 100 saved `usage.cost` fields gives **$0.0097693652**. This is an observed provider-reported total, not a price inferred from the model page.

| Cost view for Ling's 100 calls | Amount | Meaning |
| --- | ---: | --- |
| Observed reported cost | **$0.00977** | Includes the recorded cache hits and promotional route |
| Uncached pricing estimate | **$0.03859** | Same recorded token counts, all prompt tokens billed at Novita's captured input rate |

The uncached figure is a calculation, **not another benchmark run**. It holds the observed token counts fixed and removes cache-read discounts. It still uses the promotional rates; it is not a forecast of future list-price billing.

The large shared system prompt and tool schema make prefix caching especially useful in this suite. A real browser session has changing history and page state, so it may not reproduce a 94.7% cached share. Even the uncached estimate is inexpensive here, but the sub-cent headline should travel with its cache and promotion context.

The observed Ling total is roughly 15 times below the saved Pro total and 108 times below the saved M3 total. Those ratios include differences in dates, token counts, caching, and provider pricing; they are not controlled cost-per-task comparisons.

## Where the first-action gains come from

Ling chose `navigate` **24 times**, compared with Pro's 14, and `get_accessibility_tree` **38 times**, compared with Pro's 59. It more often took the direct route where the archived rubric expected navigation or page reading.

| Case | User request | Ling's first response | Nex Pro's first response |
| --- | --- | --- | --- |
| 021 | Wikipedia lookup for WW2 | Direct navigation to the World War II article | Accessibility-tree inspection |
| 026 | Summarize this page | `read_page` with no arguments: exact ideal | `read_page` with an extra option: ideal name only |
| 042 | Create release tagged v2.0.0 | Navigate to GitHub's new-release page: exact ideal | Accessibility-tree inspection |
| 069 | Open it | Clarifying prose, without a tool | Structured `clarify` |
| 075 | Finish what we were doing | Malformed `scratchpad_write` arguments | Accessibility-tree inspection |

Ling matched the ideal tool on **7/10 search cases** and the exact action on **6/8 page-reading cases**. These are small category samples, but they fit the direct-action pattern in the saved responses.

The weaknesses are also concrete. On the eight ambiguity cases, Ling produced **zero ideal tool-name matches**. Six responses were clarifying prose; that can be useful to a person, but it misses the benchmark's structured `clarify` contract. Another ambiguity response, case 075, contained `"replace": ,` inside its tool arguments: invalid JSON. The runner caught the parse error and recorded empty parsed arguments, while the raw response preserves the defect.

All 90 native calls used names from the frozen tool list, but only **89/90 had parseable argument JSON**. Parseable JSON is not full schema validity or evidence that an action would execute successfully. Case 092, for example, answered “mute this tab” with an Enter keypress, which does not meet the requested first-action contract.

Ling's useful average does not make every action dependable. This result supports further testing as a budget planner; it does not establish end-to-end reliability or recovery behavior.

## Mini still has no comparable quality score

With a working API key on October 5, mini's native case 001 again returned **HTTP 404**: OpenRouter found no endpoint supporting tool use. Its current metadata still omitted `tools` and `tool_choice` from `supported_parameters`.

We preserve that authenticated recheck alongside the original October 3 100-case rejection. There is no new mini inference response to score, and no reason to invent a quality result from a routing error. The hosted route's availability is separate from the capabilities of the released model weights.

## Which model does this test favor?

For this frozen interface, **Ling is the strongest budget tradeoff among the completed runs**. It improves on Nex Pro across the measured first-action scores and endpoint efficiency. It also produces more exact actions and ideal tool choices than M3, while M3 keeps the higher Sonnet alignment.

If Sonnet agreement is the primary selection rule, M3 remains ahead in the saved table. If low cost, latency, and direct ideal actions matter together, Ling deserves the next trial. Pro's higher native-call coverage does not outweigh its weaker scores and slower measured path here. Mini remains a pending comparison until its hosted tool route works.

The next useful validation is a multi-turn browser run with actual tool execution, plus a separate screenshot benchmark for Ling's VL capabilities. Neither result is claimed by this first-response suite.

## Evidence and reproduction

The [comparison artifacts](https://github.com/webbrain-one/webbrain/tree/main/test/llm/analysis/2026-10-05-ling30-flash-vl) include provider snapshots, the released Ling configuration, a machine-readable comparison, cache accounting, desktop/mobile verification, and a hash audit of **401 saved records**. Complete new requests and raw API responses are under `test/llm/results/`. The [README](https://github.com/webbrain-one/webbrain/blob/main/test/llm/analysis/2026-10-05-ling30-flash-vl/README.md) documents the exact settings and historical sources.

Set `OPENROUTER_API_KEY` in your environment and choose a new tag:

```powershell
node test/llm/run-llamacpp.mjs --base https://openrouter.ai/api/v1 --model inclusionai/ling-3.0-flash-vl --tag YOUR-NEW-LING-TAG --concurrency 2 --timeout 180000 --freeze test/llm/freeze/baseline-2026-05-23.json
```

Regenerate the original report without API calls, then build the blog:

```powershell
node test/llm/report-ling30-comparison.mjs
node scripts/build-blog.mjs
```

The report checks fresh requests against the frozen payload builder, verifies raw calls and usage accounting, and reproduces the historical Pro/M3 scores. Expired-key attempts are excluded, and credentials are absent from saved artifacts.
