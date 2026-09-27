---
title: Muse Glimmer
slug: muse-glimmer
sortOrder: -260
date: 2026-08-25
readTime: 12 min read
description: >
  Meta's open 30B Muse Glimmer beats every budget Qwen model in WebBrain's browser-vision benchmark, then lands above GPT-5.6 Luna on comparable first-action planner metrics—at the cost of much slower hosted inference.
excerpt: >
  Muse Glimmer reaches 73 strict vision passes and a 93.3% mean rubric score, ahead of the budget Qwen field. In text planning it emits 95 schema-valid tool calls, chooses 34 ideal tools, and sits above GPT-5.6 Luna on the common deterministic measures—but its 8.67-second median leaves a lot of speed on the table.
titleTag: >
  Muse Glimmer 30B vision and browser-agent benchmark - WebBrain Blog
ogTitle: >
  Muse Glimmer: Meta's 30B model tested on browser vision and tool use
ogDescription: >
  300 WebBrain cases across screenshots, first actions, and multi-turn recovery. Muse beats budget Qwen vision and lands above GPT-5.6 Luna on common planner metrics.
twitterTitle: >
  Muse Glimmer: 73/100 browser vision, above Luna on planner dispatch
twitterDescription: >
  Meta's open 30B VLM beats our budget Qwen vision field, emits 95 valid tool calls, and shows excellent stale-state recovery—but hosted latency is the catch.
keywords:
  - Muse Glimmer
  - Meta Muse Glimmer 30B
  - OpenRouter
  - vision model benchmark
  - browser agent
  - GPT-5.6 Luna
  - Qwen3-VL
  - tool calling
  - open-weight AI
  - local multimodal model
  - WebBrain
author: Emre Sokullu
authorUrl: https://emresokullu.com
lede: >
  **Meta's Muse Glimmer is the first model in this price and hardware class that looks genuinely strong in both halves of WebBrain's job.** On our 100-case browser-vision suite, the open 30B model scored 73 strict passes and a 93.3% mean rubric score—better than every model in our recent budget Qwen sweep. On the 100-case text planner, it returned 95 schema-valid tool calls and beat GPT-5.6 Luna on both ideal-tool and exact-ideal counts. The tradeoff is speed: OpenRouter took 16.1 seconds per screenshot on average and 8.67 seconds at the median for first actions. Muse Glimmer is capable, inexpensive, open-weight, and unusually complete. It is not fast on the route we tested.
---

## The short verdict

We sent **300 benchmark cases** to `meta/muse-glimmer-30b` through OpenRouter on August 25, 2026:

| Suite | Cases | Core result | Latency | Observed cost |
| --- | ---: | --- | ---: | ---: |
| Browser vision | 100 | **73 strict passes**, 93.3% mean rubric | 16.15s mean | $0.098 |
| First-action text planner | 100 | **95 valid tool calls**, 34 ideal tools, 11 exact ideals | 8.67s median | $0.240 |
| Multi-turn scenarios | 100 | **41 ideal / ideal-name**, 57 other, 2 anti-pattern | — | — |

Our practical read is straightforward:

- **Vision quality is excellent for the budget tier.** Muse clears the best Qwen result by four strict passes and 1.4 rubric points.
- **Text planning is above GPT-5.6 Luna on the shared deterministic measures.** Muse has more valid calls, more ideal tool names, and nearly four times as many exact ideals.
- **Recovery is uneven but real.** Muse scored 9/10 on stale-reference recovery and 5/8 on the protected prompt-injection set after retry substitution, but only 2/10 on CSP-blocked evaluation and 0/10 on counter-polarity.
- **Latency is the main weakness.** Muse was 3.5 times slower than Qwen3-VL-32B Instruct on vision and slower than Luna on text first actions.

This is a much better result than “one model that can technically accept both text and images.” Muse is competitive in both modalities. The serving profile, not the capability surface, is what prevents an automatic recommendation.

## What Muse Glimmer is

[Meta's model card](https://huggingface.co/meta-models/Muse-Glimmer-30B) describes Muse Glimmer as a dense, 30-billion-parameter causal model with a dedicated perception encoder, distilled from Muse Spark and designed for autonomous agents on consumer hardware. The weights are released under Apache 2.0, with official BF16, [GGUF](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF), and ExecuTorch variants.

That positioning is unusually aligned with WebBrain's workload: multimodal understanding, structured tool use, multi-step reasoning, and failure recovery in one locally deployable model. The OpenRouter route exposes a 131,072-token context. At test time its lowest listed route price was **$0.30 per million input tokens and $1.10 per million output tokens**; provider-specific prices can be higher.

The model is dense, so “30B” means something different from Qwen's 30B-A3B MoE. Muse executes its language backbone rather than activating roughly 3B routed parameters per token. That helps explain why a Qwen MoE can be dramatically faster even when the names imply similar scale. It also means Muse's official quantized local path is central to the product story: the hosted route is convenient, but not necessarily the deployment that shows the model at its best.

## What we ran

The vision run used WebBrain's production screenshot contract: the same 100 browser screenshots, fixed six-section system prompt, temperature 0, 800-token maximum, deterministic weighted checks, and critical-fact gating used in our [budget Qwen comparison](/blog/qwen-budget-vision-openrouter).

The text run used the current WebBrain Chrome planner payload at full tier: 100 first-action cases, native structured tools, Act temperature 0.15, and no reasoning-effort override. One request failed in transport on the original pass; its isolated retry returned a valid tool call. We substitute that retry in the measurements below.

The scenario run used 100 seeded multi-turn histories covering bad-URL loops, tool errors, CSP failures, truncation, counter polarity, stale references, mode boundaries, cross-lingual interaction, and prompt injection. Three transport failures and one empty response all returned valid results on isolated retry. The consolidated figures substitute those four retry results while preserving the original run directories.

No API key was stored in the result files.

## Vision: 73 strict passes, with a strong hard-case floor

Muse scored every case and returned no API error:

| Difficulty band | Strict passes | Mean rubric | Mean latency |
| --- | ---: | ---: | ---: |
| Easy | 15 / 20 | 94.2% | 11.9s |
| Basic | **16 / 20** | **96.3%** | 13.9s |
| Intermediate | 14 / 20 | 90.6% | 11.8s |
| Advanced | 15 / 20 | 92.1% | 30.1s |
| Challenging | 13 / 20 | 93.2% | 13.1s |
| **Overall** | **73 / 100** | **93.3%** | **16.15s** |

The shape matters as much as the total. Muse never falls below 65% strict success in any band, and its challenging-band mean rubric remains above 93%. It often recovered most facts even when one critical check prevented a strict pass.

Four categories were perfect: toast notifications, consent banners, chart reading, and data tables. Authentication, search, dashboards, email composition, kanban, calendars, maps, photos, security challenges, and uncertainty calibration all landed at 80% strict success.

The weaknesses are familiar:

| Category | Strict success | Mean rubric |
| --- | ---: | ---: |
| Form validation | **20%** | 76.0% |
| Modal overlays | **20%** | 85.5% |
| Occlusion and contrast | 40% | 88.0% |
| Checkout | 60% | 92.0% |
| Loading state | 60% | 88.7% |
| Multilingual OCR | 60% | 92.7% |

Form validation and modal overlays were also the budget Qwen field's shared blind spots. Muse improves the overall score without removing the failure modes that matter most when a browser agent is blocked by a dialog or must associate a field with a small inline error.

## Vision comparison: Muse beats the budget Qwen field

The earlier [six-model Qwen sweep](/blog/qwen-budget-vision-openrouter) used the same 100-case corpus and production screenshot contract. Adding Muse produces a clear quality winner:

| Model | Strict passes | Mean rubric | Mean latency | Output tokens | Cost / 100 cases |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Muse Glimmer 30B** | **73** | **93.3%** | 16.1s | 55.9K | $0.098 |
| Qwen3-VL-32B Instruct | 69 | 91.9% | 4.6s | 22.2K | **$0.022** |
| Qwen3-VL-30B-A3B Instruct | 68 | 91.3% | **2.2s** | 17.1K | $0.024 |
| Qwen3.5-35B-A3B | 67 | 90.8% | 5.2s | 55.4K | $0.099 |
| Qwen3-VL-30B-A3B Thinking | 62 | 88.9% | 6.3s | 68.5K | $0.188 |
| Qwen3-VL-8B Thinking | 61 | 86.7% | 6.4s | 75.5K | $0.180 |
| Qwen3-VL-8B Instruct | 48 | 84.0% | 2.1s | 14.9K | $0.021 |

Muse buys four passes over dense Qwen3-VL-32B Instruct and five over Qwen's 30B-A3B Instruct. It also produces the best mean rubric score. This is not a rounding artifact: Muse sits above both Qwen leaders on both quality columns.

The price is time and tokens. Muse emits 2.5 times as many output tokens as Qwen3-VL-32B Instruct, costs about 4.4 times as much for the replay, and takes 3.5 times as long per screenshot. Against the MoE 30B-A3B, Muse is more than seven times slower.

So the deployment choice is not “Muse wins.” It is:

- **Maximum budget-tier screenshot quality:** Muse Glimmer.
- **Best interactive speed/quality balance:** Qwen3-VL-30B-A3B Instruct.
- **Near-Muse quality at one-quarter of the cost:** Qwen3-VL-32B Instruct.
- **One open model for vision plus serious agentic text behavior:** Muse Glimmer has the strongest evidence here.

## Text planning: capable, cautious, and slow

The first-action run looks much like the vision run: strong output discipline, high reasoning-token use, and a long latency tail.

| Measure | Muse Glimmer |
| --- | ---: |
| Completed responses after retry | 100 / 100 |
| Structured tool calls | 95 |
| Schema-valid tool calls | **95 / 95** |
| Ideal tool-name matches | **34** |
| Exact ideal actions | **11** |
| `get_accessibility_tree` first | 51 |
| Direct-action cases | 49 |
| Median / p95 latency | 8.67s / 26.63s |
| Prompt / completion tokens | 2.54M / 22.0K |
| Reasoning tokens | 16.6K |
| Prompt tokens reported cached | 97.6% |
| Observed 100-case cost | $0.240 |

The 95-for-95 schema row is important. Muse did not merely choose recognizable tools; every emitted call validated against the exact tool definition saved with its request. That is operationally cleaner than a model that makes the right conceptual choice but supplies an invalid enum or malformed key.

Muse is also cautious. It requests a fresh accessibility tree on 51 cases even though the benchmark expects an immediate action from the state already present in the prompt. This is almost exactly GPT-5.6 Luna's behavior: Luna requested the tree 54 times. A first-action harness penalizes both models for a read-before-act policy that could work well in a real two-turn loop.

## Text comparison: Muse is above Luna

Our [thirteen-model American-Chinese frontier benchmark](/blog/american-chinese-open-model-frontier-gap-benchmark) ranked models primarily by leave-one-out peer consensus. Muse was run later, after WebBrain's prompt and tool schema had grown, so inserting it into that exact consensus ranking would pretend the payloads were identical. We do not do that.

The 100 questions and deterministic expected actions did not change between the pinned `7182c21f` comparison checkout and the Muse run. That lets us compare the common ideal-tool and exact-ideal measures honestly. The table below is sorted by ideal tool-name count, not by the earlier article's consensus rank:

| Ideal-tool position | Model | Ideal tool | Exact ideal | Schema-valid / emitted | Tree first | Median | Replay cost |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Claude Sonnet 5 | **47** | 17 | 98 / 98 | 42 | 4.06s | $7.222 |
| 2 | Kimi K3 | 44 | 18 | 97 / 97 | 45 | 7.54s | $1.563 |
| 3 | Tencent HY3 | 41 | 18 | 90 / 90 | 42 | 5.12s | $0.246 |
| 4= | DeepSeek V4 Flash 0731 | 39 | 18 | 90 / 90 | 44 | 1.56s | $0.050 |
| 4= | GLM-5.2 | 39 | **20** | 86 / 89 | 40 | 1.73s | $0.545 |
| 6= | Gemini 3.6 Flash | 36 | 14 | **100 / 100** | 59 | 1.96s | $1.209 |
| 6= | Qwen 3.6 27B | 36 | 17 | 83 / 92 | 44 | 2.23s | $0.670 |
| 6= | xAI Grok 4.5 | 36 | 17 | 94 / 94 | 49 | 2.61s | $2.274 |
| **9** | **Muse Glimmer 30B** | **34** | **11** | **95 / 95** | **51** | **8.67s** | **$0.240** |
| 10 | MiniMax M3 | 33 | 17 | 86 / 89 | 45 | 2.85s | $0.504 |
| 11= | **GPT-5.6 Luna Pro** | **32** | **3** | 89 / 89 | 54 | 5.12s | $0.228 |
| 11= | Inkling Small | 32 | 15 | 84 / 84 | 45 | 1.05s | $0.243 |
| 13 | Poolside Laguna XS 2.1 | 31 | 5 | 88 / 89 | 45 | 1.15s | $0.073 |
| 14 | GPT-5.6 Terra Pro | 12 | 2 | 94 / 94 | 80 | 4.91s | $2.238 |

**Muse is above Luna.** It selects two more ideal tool names, produces eight more exact ideal actions, emits six more valid calls, and asks for the tree slightly less often. The exact-ideal gap—11 versus 3—is the clearest evidence that Muse is not merely matching Luna's cautious policy with more verbosity.

Luna still wins on speed by a wide margin: 5.12 seconds versus 8.67 seconds at the median. Their observed replay costs are effectively in the same band, $0.228 for Luna and $0.240 for Muse, although cache behavior and the larger current Muse payload make billing comparisons route-specific.

Muse does not reach the top planner group on deterministic dispatch. Sonnet, Kimi, HY3, DeepSeek, GLM, Gemini, Qwen, and Grok all choose more ideal first tools. Muse's position is better described as **upper-middle quality with top-tier schema discipline, full multimodality, and bottom-tier hosted latency**.

## Multi-turn recovery: one exceptional category, several weak pivots

The scenario grader labels the next move as `ideal`, `ideal_name`, `anti`, `other`, or `empty`. `Other` is not a conventional test failure—it means the action matched neither the specified ideal nor a known anti-pattern—but it does show that Muse often chose a generic re-observation instead of the rubric's preferred pivot.

After replacing the three transport failures and one empty original response with their isolated retries:

| Scenario category | Ideal / ideal-name | Anti-pattern | Other |
| --- | ---: | ---: | ---: |
| Bad-URL loop | 2 / 10 | 0 | 8 |
| Tool-error pivot | 4 / 10 | 0 | 6 |
| CSP-blocked evaluation | 2 / 10 | 0 | 8 |
| Truncation cascade | 3 / 10 | 1 | 6 |
| Counter polarity | 0 / 10 | 1 | 9 |
| **Stale reference ID** | **9 / 10** | **0** | **1** |
| Mode boundary | 3 / 10 | 0 | 7 |
| Cross-lingual | 4 / 10 | 0 | 6 |
| Protected prompt injection | 5 / 8 | 0 | 3 |
| Protected injection control | **2 / 2** | 0 | 0 |
| Unprotected prompt injection | 6 / 8 | 0 | 2 |
| Unprotected injection control | 1 / 2 | 0 | 1 |

Stale-state recovery is the standout. When a ref ID has disappeared or a page mutation invalidates the previous tree, Muse almost always refreshes or pivots correctly. That is exactly the kind of failure recovery Meta emphasizes in the model card, and this category supports the claim.

The broader scenario result is less convincing. Muse repeatedly falls back to `get_accessibility_tree` when the rubric expects a more targeted alternative. Counter-polarity is the sharpest miss: zero ideal outcomes and one known anti-pattern. The protected injection set is respectable—five of eight ideal-name outcomes, no anti-pattern, and both controls handled correctly—but the unprotected mirror did not become worse. This sample does not show a measurable benefit from the deterministic wrapper for Muse.

## Where Muse fits

Muse Glimmer occupies a useful space that did not have a clean representative in our earlier tables:

- It is **open-weight and realistically quantizable**, unlike frontier-scale MoEs.
- It is **natively multimodal**, unlike the cheap text-planner leaders.
- It is **better at browser screenshots than every budget Qwen route we tested**.
- It is **cleaner at structured tool emission than Qwen 3.6 27B** in the compared runs.
- It is **above GPT-5.6 Luna on common deterministic first-action quality**, with nearly the same observed replay cost.
- It is **too slow on the tested OpenRouter route** to displace Qwen3-VL-30B-A3B for a latency-sensitive screenshot loop.

For a hosted WebBrain deployment today, we would still choose Qwen's 30B-A3B Instruct when every screenshot sits on the critical path. We would choose Muse when one open model must cover screenshot understanding, structured browser planning, and local/private deployment without splitting the job between a VLM and a text specialist.

The most interesting next test is local. Meta ships official GGUF quantizations, a perception projector, and a DFlash drafter. A single-GPU Muse run would remove OpenRouter scheduling and network time, reveal whether speculative decoding fixes the latency problem, and compare the dense 30B model with Qwen's dense 32B and 3B-active MoE on the hardware the model was built to target.

## Bottom line

Muse Glimmer is the new quality leader in our budget browser-vision table: **73 strict passes versus Qwen's 69**, with the best mean rubric score in the group. It is not the efficiency leader. The best Qwen rows return three to seven times faster and cost roughly one-quarter as much.

On text planning, the answer to the question we cared about is unambiguous: **Muse Glimmer sits above GPT-5.6 Luna on the common deterministic dispatch measures.** Muse reaches 34 ideal tool choices and 11 exact ideals; Luna reaches 32 and 3. Muse also emits more calls with perfect saved-schema validity. Luna remains faster.

The combined result makes Muse more interesting than either table alone. It is not the best text planner and not the fastest VLM. It is a 30B open model that can plausibly do both jobs well, recover stale state unusually reliably, and run on hardware an individual can own. That is a strong foundation. Now it needs a local WebBrain run to show whether Meta's consumer-hardware story can turn a 16-second hosted screenshot response into an interactive agent loop.

## Raw results

```text
test/vision/results/openrouter-muse-glimmer-30b-full-20260825_meta_muse-glimmer-30b_production
test/llm/results/openrouter-muse-glimmer-30b-full-20260825_chrome_meta_muse-glimmer-30b
test/llm/results/openrouter-muse-glimmer-30b-retry-routing-20260825_chrome_meta_muse-glimmer-30b
test/llm/results-scenarios/openrouter-muse-glimmer-30b-scenarios-20260825_chrome_meta_muse-glimmer-30b
test/llm/results-scenarios/openrouter-muse-glimmer-30b-retry-scenarios-20260825_chrome_meta_muse-glimmer-30b
```

Tags: #MuseGlimmer #MetaAI #OpenWeights #OpenRouter #Qwen3VL #GPT56 #Luna #VisionLanguageModel #ToolCalling #BrowserAgent #LocalAI #WebBrain
