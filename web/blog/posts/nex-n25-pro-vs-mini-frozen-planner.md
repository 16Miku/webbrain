---
title: Nex-N2.5 Pro vs mini: low prices meet the frozen planner test
slug: nex-n25-pro-vs-mini-frozen-planner
sortOrder: -310
date: 2026-10-03
readTime: 8 min read
description: Nex-N2.5-Pro costs about $0.15 for WebBrain's frozen 100-case planner test, but trails MiniMax M3 on Sonnet alignment. Mini's OpenRouter tool route rejects the test; Qwen 3.8 27B provides separate compact context.
excerpt: Pro completes 100 cases with 95 structured tool calls and 67% Sonnet alignment at a very low run cost. Mini's hosted route blocks tool requests, so its planner score remains unknown.
titleTag: Nex-N2.5 Pro vs mini frozen planner benchmark - WebBrain Blog
ogTitle: Nex-N2.5 Pro vs mini: inexpensive APIs, uneven planner results
ogDescription: Pro reports $0.15 for 100 calls, 67% Sonnet alignment, and a 7.23s median. Mini encounters an OpenRouter tool-routing block. Historical MiniMax M3 and Qwen 3.8 27B results add context.
twitterTitle: Nex-N2.5 Pro vs mini in WebBrain's frozen planner test
twitterDescription: Pro is cheap but trails MiniMax M3 on planner alignment. Mini's OpenRouter route rejects structured tools. Raw requests, responses, and a reproducible report are included.
keywords:
  - Nex-N2.5-Pro
  - Nex-N2.5-mini
  - Nex AGI
  - OpenRouter
  - MiniMax M3
  - Qwen 3.8 27B
  - browser agent benchmark
  - tool calling
author: Emre Sokullu
authorUrl: https://emresokullu.com
---

**Nex-N2.5's prices make it an attractive browser-agent candidate.** We tested Pro and mini through OpenRouter using WebBrain's frozen 100-case first-tool suite. Pro completed the suite for about **$0.15**, emitted **95 structured tool calls**, and reached **67% Sonnet tool-name alignment**. Mini's route rejected every native tool request before inference, leaving its planner quality unmeasured. The cost advantage is real for Pro; the results do not establish a new default planner.

## Two models, two very different deployment sizes

[Nex-N2.5-Pro](https://huggingface.co/nex-agi/Nex-N2.5-Pro) and [Nex-N2.5-mini](https://huggingface.co/nex-agi/Nex-N2.5-mini) belong to Nex AGI's family of models for coding, computer use, browsing, and workflows that use visual feedback. Their released configurations share the Qwen3.5 MoE architecture, but the larger model stores substantially more parameters.

| Property | Nex-N2.5-mini | Nex-N2.5-Pro |
| --- | --- | --- |
| Total parameters listed on Hugging Face | 35B | 397B |
| Text layers | 40 | 60 |
| Text hidden size | 2,048 | 4,096 |
| Routed experts / selected per token | 256 / 8 | 512 / 10 |
| Attention pattern | Three linear-attention layers, then one full-attention layer | Three linear-attention layers, then one full-attention layer |
| Configured context | 262,144 tokens | 262,144 tokens |
| Advertised input surface | Text and images | Text and images |
| Captured OpenRouter route quantization | BF16 | FP8 |

The architecture details come from the released [mini configuration](https://huggingface.co/nex-agi/Nex-N2.5-mini/blob/main/config.json) and [Pro configuration](https://huggingface.co/nex-agi/Nex-N2.5-Pro/blob/main/config.json). Route quantization comes from the provider endpoint metadata captured with our test, rather than from a local deployment.

MoE reduces the computation used for each token by selecting a subset of experts. It does not remove the need to store the full model. Mini and Pro therefore belong to very different local hardware conversations, even though both are cheap hosted APIs. We did not load either checkpoint locally or benchmark their GPU throughput.

Both advertise multimodal capabilities, but this test sends **text only**. No screenshots, image tokens, or vision grader enter the planner score.

## The price advantage

On October 3, 2026, the [mini OpenRouter page](https://openrouter.ai/nex-agi/nex-n2.5-mini) listed **$0.025 input / $0.10 output per million tokens**. The [Pro page](https://openrouter.ai/nex-agi/nex-n2.5-pro) listed **$0.075 / $0.25**. We saved the corresponding endpoint metadata and retrieval timestamps alongside the results.

| Listed rate, per million tokens | mini | Pro |
| --- | ---: | ---: |
| Input | $0.025 | $0.075 |
| Output | $0.10 | $0.25 |
| Cache read | $0.0025 | $0.015 |

Pro's actual 100-request run reported **$0.14999** in aggregate `usage.cost`. Our saved frozen MiniMax M3 run reported **$1.05621**, roughly seven times as much. That is a useful difference when a browser session needs many planning turns.

These are observed totals from different dates and provider routes. Caching, tokenization, output length, and provider billing affect them; they are not a controlled price-per-token experiment. Mini never returned an inference response in our tests, so its measured inference cost is **N/A**, despite its attractive advertised rates.

## What the frozen test measures

The native runs use `test/llm/freeze/baseline-2026-05-23.json`: Sonnet 4.6's saved system prompt, **41 tools**, and system hash beginning `5c4fac1387025050`. We retained OpenAI structured tools, used concurrency 2, and set a 180-second request timeout. The runner sends temperature 0.15 for action modes or 0.3 for Ask, with a 4,096-token output limit. We sent no reasoning-effort override, seed, `top_p`, or `top_k`.

We also archived the **May 23 ideal-action rubrics** from the original comparison commit, `0bbaf627ec2637898b587d5a7e5895f318f25bab`. The current repository goldens changed in September when tab tools and screenshot behavior changed. Using the older rubrics for every frozen row preserves the historical comparison and reproduces MiniMax M3's published 17 exact actions and 32 ideal tool names.

The columns answer different questions:

- **Structured calls:** did the first response contain a native tool call?
- **Exact ideal action:** did both the tool name and all arguments exactly match the archived reference?
- **Ideal tool name:** did the model choose the reference tool, ignoring arguments?
- **Sonnet alignment:** did it choose the same tool name as saved Sonnet 4.6, including agreement on no call?

Sonnet alignment is reference agreement, not an independent correctness judgment. Strict ideal scoring also penalizes benign extra arguments and alternative first steps. Plain-text answers receive no ideal-tool credit here, even when the answer is useful.

Only the **first model response** is captured. Tools are never executed; this suite does not measure task completion, recovery, or screenshot understanding. The frozen prompt is a historical interface, rather than the full current WebBrain agent. User context and site guidance are still assembled by the runner; older runs did not save complete requests, so historical per-case byte equality cannot be verified.

## Pro completes the suite, but does not lead it

| Metric | Nex-N2.5-Pro |
| --- | ---: |
| API responses | 100/100 |
| Transport errors | 0 |
| Native structured tool calls | 95/100 |
| Calls with a name in the frozen tool list | 95/95 |
| Exact ideal actions | 11/100 |
| Ideal tool-name matches | 27/100 |
| Sonnet tool-name alignment, all cases | 67.0% |
| Alignment on Sonnet's 92 tooled cases | 68.5% |
| Average latency | 9.42s |
| Median latency | 7.23s |
| p95 latency | 20.87s |
| Run wall time at concurrency 2 | 474s |
| Reported cost | $0.14999 |

Pro is operationally usable on this route: all requests completed, all parsed calls used a known tool name, and none hit the output limit. Known names do not establish valid arguments or successful execution; we are not claiming full schema compliance.

Its planner choices are less impressive. The saved frozen MiniMax M3 run reached **75% Sonnet alignment**, **17 exact actions**, and **32 ideal tool names**. Pro reached **67%**, **11**, and **27**. It emitted more native calls than M3, but more calls did not turn into better first-action precision.

Compared with our [earlier Nex-N2-mini test](/blog/nex-n2-mini-openrouter-planner-benchmark), Pro gains two points of Sonnet alignment and two parsed calls. It loses five exact ideal actions, one ideal tool-name match, and has a slower observed median. The models and routes differ, and a single 100-case run cannot establish whether a two-point alignment difference is meaningful. This result gives us little reason to prefer the larger Pro model on planner quality alone.

## What Pro's responses show

Pro chose `get_accessibility_tree` **59 times**. That inspection-first habit often agrees with Sonnet, but it can also postpone a direct navigation or clarification.

| Case | User request | Pro's first choice | Archived ideal |
| --- | --- | --- | --- |
| 001 | Go to Firefox extensions management | `navigate` to `about:addons` | Same tool and arguments |
| 021 | Search Wikipedia for WW2 | `get_accessibility_tree` | Direct Wikipedia navigation |
| 026 | Summarize this page | `read_page` with `includeChrome:false` | `read_page` with no arguments |
| 042 | Create release tagged v2.0.0 | `get_accessibility_tree` | Navigate to GitHub's new-release page |
| 068 | Click that | `get_accessibility_tree` | `clarify` which element |
| 073 | Buy it | Clarifying prose, without a tool call | `clarify` |

Case 026 shows why exact action matching is demanding: Pro chose the expected tool and a reasonable option, but the extra argument prevents an exact match. Case 073 is useful clarification in prose, yet does not satisfy the structured-call contract. Those are different failure modes from choosing an unrelated action.

The category scores underline the same distinction. Pro agrees with Sonnet on **8/8 form cases**, while matching the archived ideal tool on **0/8**. Both models often inspect first where the rubric expects a more direct action. On ambiguity cases, Pro matches Sonnet on only **1/8** and the ideal tool on **2/8**. Its weakest signal is knowing when to stop and ask before taking another inspection step.

## Mini's hosted route blocks the native test

Every one of mini's 100 native requests returned **HTTP 404** before model inference. The response identified OpenRouter's **Filter by Tool Compatibility** routing step and reported that no endpoint supported tool use.

The captured [mini endpoint metadata](https://openrouter.ai/api/v1/models/nex-agi/nex-n2.5-mini/endpoints) omitted `tools` and `tool_choice` from `supported_parameters`. We checked again after Pro completed; they were still absent. That differs from the public model page's advertised function-calling support. The observation concerns this hosted route at this time, not whether the released model weights can call functions.

We tried two additional checks. A native request with `provider.require_parameters:false` still returned 404. An ordinary short chat request timed out after 15 seconds. We then used the harness's existing text-tool compatibility mode on cases 001, 026, and 082; all three timed out after 20 seconds each.

That fallback folds system instructions into user text and lists tool names without sending structured schemas. It is a diagnostic experiment, not the same native frozen test. An initial broader fallback attempt produced no saved responses and was stopped in favor of the bounded smoke test.

**Mini's planner score remains unknown.** We preserve the 100 native rejection records, three fallback timeout records, and diagnostic probes. Reporting these as 0% planner accuracy would confuse a routing failure with a model decision.

## Final comparison, with historical references

The first four rows below use the frozen May system prompt, tools, and archived ideal rubrics. Qwen 3.8 27B is the saved September 5 **compact** first-turn run. It uses a newer prompt/tool surface and a separate compact rubric snapshot, so it is context rather than a directly comparable leaderboard entry. No vision or scenario score is mixed into this table.

| Model | Protocol | Parsed calls | Exact ideal | Ideal name | Sonnet alignment | Median | Reported run cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **Nex-N2.5-Pro, new** | Frozen native | 95/100 | 11/100 | 27/100 | 67.0% | 7.23s | $0.14999 |
| **Nex-N2.5-mini, new** | Frozen native, blocked | 0/100 | N/A | N/A | N/A | N/A | N/A |
| MiniMax M3, historical | Frozen native | 85/100 | 17/100 | 32/100 | 75.0% | 3.10s | $1.05621 |
| Nex-N2-mini, historical | Frozen native | 93/100 | 16/100 | 28/100 | 65.0% | 2.23s | $0.04550 |
| Qwen 3.8 27B, historical context | Compact native | 99/100 | 15/100 | 38/100 | N/A | 2.07s | $0.20945 |

All rows contain 100 attempted first-turn cases. Mini's zero parsed calls come from rejection before inference, not a preference for prose. The median and cost columns describe the measured endpoint paths on their respective dates; they do not isolate model architecture. The new native runs and historical M3 run used concurrency 2; the older Nex-N2-mini run used 3. Qwen's concurrency was not recorded in its saved summary.

For this frozen interface, **Pro offers a clear cost tradeoff against MiniMax M3**: roughly seven times lower reported run cost, with lower first-action scores and slower measured responses. That can be interesting when cost dominates, but these results do not justify replacing the stronger saved M3 planner by default. Mini needs a working hosted tool route before the same decision can be assessed.

## Evidence and reproduction

The [comparison artifacts](https://github.com/webbrain-one/webbrain/tree/main/test/llm/analysis/2026-10-03-nex-n25) include source endpoint snapshots, model configurations, archived rubrics, a machine-readable report, and a hash audit of **503 case records** across the new tests and historical references. The [README](https://github.com/webbrain-one/webbrain/blob/main/test/llm/analysis/2026-10-03-nex-n25/README.md) documents the native runs and diagnostics. Complete new request bodies and successful raw API responses are under `test/llm/results/`.

With `OPENROUTER_API_KEY` set in your environment, use a new tag to preserve the original evidence:

```powershell
node test/llm/run-llamacpp.mjs --base https://openrouter.ai/api/v1 --model nex-agi/nex-n2.5-pro --tag YOUR-NEW-PRO-TAG --concurrency 2 --timeout 180000 --freeze test/llm/freeze/baseline-2026-05-23.json
node test/llm/run-llamacpp.mjs --base https://openrouter.ai/api/v1 --model nex-agi/nex-n2.5-mini --tag YOUR-NEW-MINI-TAG --concurrency 2 --timeout 180000 --freeze test/llm/freeze/baseline-2026-05-23.json
```

To verify and regenerate the original report without API calls:

```powershell
node test/llm/report-nex-n25-comparison.mjs
node scripts/build-blog.mjs
```

The report checks every new saved request against the frozen payload builder, validates response and error accounting, and reproduces the historical frozen scores. Credentials are excluded from saved artifacts.
