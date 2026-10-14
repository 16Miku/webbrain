---
title: HY4, MiMo V2.6, and Liquid LFM2.5: 600 browser-agent tests
slug: hy4-mimo-v26-lfm25-browser-agent-benchmark
sortOrder: -350
date: 2026-10-14
readTime: 9 min read
description: Four new OpenRouter planners and two screenshot runs: HY4 Preview, MiMo V2.6 Pro and Flash, and Liquid LFM2.5. Pinned inputs, seventeen-model consensus, measured latency and cost, and committed raw results.
excerpt: MiMo Pro leads the four new planners on consensus and ideal-tool choices. Flash reaches 81 screenshot passes with a 1.20-second planner median and a one-cent planner bill. HY4 and Liquid trail on exact-action agreement.
titleTag: HY4, MiMo V2.6, and Liquid LFM2.5 browser benchmark - WebBrain Blog
ogTitle: HY4, MiMo V2.6, and Liquid LFM2.5: 600 browser-agent tests
ogDescription: 400 planner cases and 200 screenshots, zero API errors. Same archived inputs, dated historical references, actual usage bills, and full raw evidence.
twitterTitle: HY4 vs MiMo V2.6 vs Liquid LFM2.5 in WebBrain
twitterDescription: Seventeen-model planner consensus plus MiMo screenshot results against Qwen3.8 and GLM-5.3 Flash. First-action quality, vision, latency, and cost measured separately.
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

**MiMo-V2.6-Flash is the clearest budget result in this new batch:** 81 strict screenshot passes, a **1.20s planner median**, and a **$0.0110 bill for 100 planner requests**. We tested it alongside Tencent HY4 Preview, MiMo-V2.6-Pro, and Liquid LFM2.5-24B-A2B: **400 new first-action planner cases and 200 new screenshots**, all completed without an API error or retry. Their different strengths make more sense when planning, vision, serving latency, and cost stay in separate columns.

**Pro leads the new planners on consensus and ideal-tool count; Flash wins the measured budget and screenshot tradeoff.** HY4 emits the most schema-valid first calls in the new group, while Liquid dispatches quickly from a much smaller model. Both trail the MiMo pair on exact-action agreement, so neither becomes an automatic replacement for the stronger historical planners in this test.

## Four very different models

This post extends our [American and Chinese frontier planner benchmark](/blog/american-chinese-open-model-frontier-gap-benchmark) and [Qwen3.8 Flash vs GLM-5.3 Flash comparison](/blog/qwen38-flash-vs-glm53-flash). All four new OpenRouter routes support native tools; only the MiMo pair accepts screenshots.

| Model | Disclosed total / active parameters | Inputs on the requested route | Advertised context |
| --- | --- | --- | ---: |
| Tencent HY4 Preview | 770B / 49B backbone | Text | 1,048,576 |
| MiMo-V2.6-Pro | 1.02T / 42B | Text, image, video, audio | Up to 1,050,000 |
| MiMo-V2.6-Flash | 309B / 15B | Text, image, video, audio | Up to 1,050,000 |
| Liquid LFM2.5-24B-A2B | 24B / about 2B | Text | 128,000 on this route |

[Tencent's HY4 card](https://huggingface.co/tencent/Hy4-preview) describes a 78-layer MoE with gated sparse attention and cross-layer index reuse. Its backbone counts exclude a separate 10B multi-token-prediction layer. Tencent also flags excess reasoning and over-verification as preview limitations. A first-action test can assess its opening dispatch, but cannot establish how much work it completes over a long session.

The [MiMo Pro](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL) and [MiMo Flash](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL) cards describe sparse language backbones, native visual/audio components, and reinforcement learning across agent domains and harnesses. Pro has much more stored capacity. That does not imply it must win a constrained screenshot-description test or respond faster through a particular provider.

[Liquid's October 13 release](https://www.liquid.ai/blog/lfm2-5-24b-a2b) is a smaller open-weight model for local agents. It combines gated short convolutions, grouped-query attention, and sparse experts; unlike its predecessor, it is reasoning-only. Liquid advertises 131,072 context for the checkpoint, while this OpenRouter endpoint lists 128,000. We tested its hosted route, so these measurements are not local-device speed or memory results. Active counts describe work per token, not the total weights to load.

## Matching the inputs before comparing scores

All four planners replay the August full-tier source **`7182c21f`**: **100 Chrome Act cases, 48 native tools, temperature 0.15, and max_tokens 4,096**. We apply no reasoning-effort override, prompt folding, or compatibility syntax. Only the requested model ID changes. New files save both the request and raw API response.

The offline audit first reproduces all thirteen original models' consensus, schema-valid-call, ideal-tool, and exact-ideal counts from **1,300 historical responses**. We then add these four complete new runs and rescore the entire **seventeen-model pool**, with sixteen peers and **1,600 comparisons per model**. Old thirteen-model percentages are not copied unchanged into the new table.

Exact consensus compares the first proposed tool and its arguments after recursively sorting object keys. Values, defaults, and extra arguments remain significant. Tool consensus ignores the arguments. Schema validity and the archived canonical ideal action are separate checks. No-tool responses can agree with one another; consensus measures agreement, not ground truth. No browser tool is executed.

**Only the four new planners and two MiMo screenshot runs are October 14 inference.** The planner peers retain August 2 results, the Qwen/GLM screenshot references retain August 27 results, and Ling's screenshot row reuses its October 7 run. Their infrastructure, prices, caches, and serving dates differ. Old planner bodies were omitted; source reconstruction verifies the matching intended payload without proving full historical byte equality. Raw UTC timestamps begin October 13; the local test date is October 14 in Istanbul.

## Planner quality, speed, and the actual bill

Ranks below come from all seventeen models; the table shows the four new routes and five useful historical references. The complete pool remains in the saved report.

| Rank | Model | Exact consensus | Tool consensus | Valid / emitted | Ideal tool | Exact ideal | Median | p95 | Cost / 100 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | DeepSeek V4 Flash 0731 | 50.9% | 79.6% | 90 / 90 | 39 | 18 | 1.58s | 5.24s | $0.0504 |
| 2 | Tencent HY3 | 47.4% | 77.8% | 90 / 90 | 41 | 18 | 5.12s | 8.98s | $0.2459 |
| 3 | MiMo-V2.6-Pro | 43.6% | 78.6% | 95 / 95 | 44 | 16 | 6.12s | 46.68s | $0.1246 |
| 6 | GLM-5.2 | 42.8% | 75.9% | 86 / 89 | 39 | 20 | 1.73s | 4.44s | $0.5452 |
| 7 | MiMo-V2.6-Flash | 41.9% | 73.0% | 96 / 97 | 37 | 17 | 1.20s | 4.26s | $0.0110 |
| 9 | MiniMax M3 | 40.6% | 74.6% | 86 / 89 | 33 | 17 | 2.86s | 7.34s | $0.5038 |
| 10 | Poolside Laguna XS 2.1 | 39.6% | 73.2% | 88 / 89 | 31 | 5 | 1.15s | 2.15s | $0.0729 |
| 14 | Tencent HY4 Preview | 27.5% | 78.6% | 98 / 98 | 36 | 16 | 5.81s | 11.64s | $0.2961 |
| 15 | Liquid LFM2.5-24B-A2B | 24.9% | 68.2% | 94 / 95 | 23 | 6 | 1.83s | 6.68s | $0.0829 |

HY4 emits **98 native first calls**, of which **98** satisfy the archived schema, and reaches **36 ideal tool names**. Its 5.81s median and $0.2961 bill belong to the tested Tencent route. HY3's smaller model retains its own dated result; the shared seventeen-model rescoring makes their agreement columns comparable without implying identical serving conditions.

HY4's **27.5% exact consensus** falls well below HY3's 47.4%, even though its **78.6% tool consensus** slightly exceeds HY3's 77.8%. It often selects the same broad tool family with different arguments. This result provides clean dispatch evidence, but does not establish a planner upgrade from HY3 or support a claim about long-task reasoning quality.

MiMo Pro ranks **third in the full seventeen-model pool**, and leads the four new models with **43.6% exact consensus, 44 ideal tools, and 95 valid first calls**. Its position is only narrowly above Sonnet's agreement score, so the rank is not evidence of a broad capability advantage. Its **46.68s p95** is a substantial serving limitation for an interactive planner. On case 070, the user simply says “log in” on a blank New Tab page. Pro asks which site to use, matching the ideal tool family; its longer question, options, and explanation miss the rubric's exact argument string. That is useful clarification, even when it disagrees with a peer that reads the empty page first. Neither disagreement nor latency identifies the underlying cause by itself.

Flash emits **97 native first calls**, with **96 schema-valid**, at the lowest new-run bill and median. Liquid emits **95 native first calls**, with **94 valid**, and responds at a **1.83s median**. Liquid's tiny active path makes its hosted result interesting, but Flash is both faster and cheaper in these runs; hosted price does not follow active parameter count alone.

Liquid also trails on routing conformity: **23 ideal tools, six exact ideals, and 24.9% exact consensus**. It reads the accessibility tree first on 56 cases. That can be a useful observation step, but this suite does not execute it or test whether the model recovers to finish the task. High native coverage does not erase the lower agreement and ideal-action results.

Two concrete first-call defects remain: **Flash case 058** emits `extract_data({headings: ""})` without the required `type` field; **Liquid case 092** emits `press_keys({key: "m"})`, outside the sent key enum. We mark both invalid and retain the original responses. The HY4 and Pro first calls have no schema defects in this run. Native function calling still benefits from argument validation before execution.

There are also legitimate prose answers. Case 082 asks for France's capital; a correct “Paris” answer without a tool reduces native-call coverage and misses the canonical `done` action. We do not convert such answers into tool calls to improve scores. The new runs have **2, 5, 3, and 5 no-tool responses**, respectively, in HY4/Pro/Flash/Liquid order. None is an API failure.

Multi-call replies require the same care: **6, 3, 11, and 1 responses** contain multiple native calls. The benchmark compares and validates their **first** call only. The other calls remain in raw evidence and are not executed or scored. First-call validity is not a claim that every proposed action in a reply is valid.

## Vision: Flash leads this small cohort

Both MiMo routes receive **100 actual 1280×720 screenshots**, the original production six-section prompt, fixed user text, temperature **0**, and an **800-token** maximum. The original thinking-disabling kwargs are retained, without an extra reasoning override or provider pin. HY4 and Liquid receive no images and remain unscored for vision.

The report checks image/prompt/question/rubric/scorer parity and reproduces all **300 saved Qwen/GLM/Ling grades**. A strict pass combines enough weighted substring evidence with the case threshold and critical-check gate. Six numbered sections are a separate coverage measure, not an independent hard pass requirement. Literal matching can reject a recognized synonym, and the score is not a human measure of general visual intelligence.

| Model | Strict passes / 100 | Mean rubric | Median | p95 | Cost / 100 |
| --- | ---: | ---: | ---: | ---: | ---: |
| MiMo-V2.6-Flash | 81 | 94.3% | 1.91s | 4.59s | $0.0214 |
| Qwen3.8 Flash | 79 | 94.8% | 8.49s | 13.43s | $0.0411 |
| MiMo-V2.6-Pro | 77 | 94.0% | 5.73s | 11.59s | $0.0645 |
| GLM-5.3 Flash | 76 | 93.8% | 5.49s | 8.92s | $0.0211 |
| Ling 3.0 Flash VL | 65 | 88.1% | 3.46s | 4.88s | $0.0054 |

Flash's **81 passes** lead the five rows, versus Pro's **77**. Its screenshot median is **1.91s**, compared with **5.73s** for Pro, and its $0.0214 bill is roughly one third of Pro's $0.0645. Qwen and GLM remain dated references; GLM's old bill reflects its August launch promotion, not a claim that that price remains available today. Small pass gaps from one run each do not establish a stable statistical ranking.

**Ling 3.0 Flash VL is a compatible historical vision reference.** Its [October 7 screenshot test](/blog/ling30-flash-vl-compared-with-budget-vision-models) used the same 100 image hashes, system/user prompt, temperature 0, 800-token maximum, thinking-disabling kwargs, and unchanged scorer. Its 65 passes cost $0.0054, roughly a quarter of Flash's bill, with a 3.46-second median. That bill reflects Novita's dated promotion and cache state. Ling's earlier text-planner test used the May 41-tool protocol, so it does not enter the seventeen-model planner ranking above. No new Ling inference was run for this addition.

Qwen still has the highest **mean weighted rubric score, 94.8%**, versus Flash's 94.3%. Flash and Qwen both pass 75 screenshots; Flash alone passes six and Qwen alone passes four. Flash and Pro also share 75 passes, with six Flash-only and two Pro-only passes. Strict threshold passes and average recovered evidence describe different aspects of the same responses.

Strict-pass rates by difficulty, twenty images per band:

| Band | MiMo-V2.6-Flash | Qwen3.8 Flash | MiMo-V2.6-Pro | GLM-5.3 Flash | Ling 3.0 VL |
| --- | ---: | ---: | ---: | ---: | ---: |
| Easy | 85% | 70% | 85% | 80% | 70% |
| Basic | 75% | 85% | 80% | 70% | 70% |
| Intermediate | 90% | 85% | 80% | 85% | 65% |
| Advanced | 75% | 80% | 65% | 80% | 70% |
| Challenging | 80% | 75% | 75% | 65% | 50% |

Flash scores **4/5 on multilingual OCR**, compared with **2/5** for Pro. It also handles all five checkout, email, chart, photo, and map cases. Pro wins the calendar comparison 4/5 to 3/5 and occlusion/contrast 5/5 to 4/5. Each category has only five cases, so one screenshot changes its percentage by twenty points.

The shared failures remain important: **both MiMo models score 0/5 on modal overlays and 1/5 on form validation**, just as both Qwen3.8 and GLM-5.3 did in their saved runs. Flash's higher aggregate pass count does not remove these specific contract weaknesses.

All new screenshot outputs are nonempty and have six parsed sections. **Neither MiMo run hits the token cap.** Pro reports **1,438 reasoning tokens** within completion usage despite the disabling kwargs; Flash reports zero. Ling's saved run reports **33,885 reasoning tokens and 22 length-limited responses**, with 98 parsed six-section outputs, under that same budget. Its route did not eliminate reported reasoning either; the score therefore measures the delivered configuration, not the model's ceiling with different reasoning controls. Qwen/GLM historical finish reasons were not captured, so their clipping counts remain unknown. The MiMo and Ling raw streams preserve the reasoning evidence; historical `reasoningChars: 0` fields are an old parser convention.

## Cache, provider, and budget context

Planner token usage explains why list prices alone miss much of the bill:

| Planner | Prompt tokens | Completion tokens | Reasoning tokens within completion | Cached prompt share |
| --- | ---: | ---: | ---: | ---: |
| Tencent HY4 Preview | 2,317,050 | 12,780 | 9,158 | 89.1% |
| MiMo-V2.6-Pro | 2,334,035 | 13,593 | 9,517 | 89.5% |
| MiMo-V2.6-Flash | 2,333,851 | 3,159 | 0 | 98.2% |
| Liquid LFM2.5-24B-A2B | 2,412,778 | 30,106 | 28,066 | 97.6% |

The system prompt and tools repeat across cases, giving every model substantial reported cache reuse. Flash's Makora route lists a particularly low cache-read price; Liquid's cache-read discount is much smaller relative to its input rate, and its reasoning also contributes completion tokens. This helps explain why the smaller Liquid model costs more in the hosted replay. A future uncached run, another provider, or longer outputs would have another bill.

HY4's 100 planner responses identify Tencent. Flash uses Makora for both suites; Liquid uses its own provider. Pro's planner responses use DeepInfra and Novita, while all Pro screenshots use DeepInfra. Routes were chosen automatically. HY4's captured Tencent endpoint also has time-of-day pricing; we use the API's reported charge rather than applying a single headline rate to every token.

Six independent runners execute concurrently, with three requests per planner model and two per vision model. Median latency uses the average of the two middle successful requests; p95 is the nearest-rank 95th percentile. Both include network, provider, and generation time. They are not isolated model-compute or uncached-throughput measurements.

All reference latencies are recomputed with that same procedure. A median can differ slightly from an earlier article that selected the lower middle observation, such as Qwen's screenshot median of 8.49 seconds here versus 8.42 seconds in the original post.

The October 14 campaign records **606 Chat Completions requests: 600 scored cases plus six separate preflights**, with zero API errors and zero retries. The scored runs cost **$0.6005** in total; including preflights, the observed bill is **$0.6335**. None of those 600 new responses ends with a length limit. The reused historical reference runs are excluded from this campaign bill. API keys and authorization headers are excluded from the evidence.

For this workload, **Flash is the strongest new budget default to investigate**: cheap, fast first dispatch, the highest screenshot pass count here, and broad multimodal input. HY4 and Pro still deserve assessment through their ideal-tool choices and argument validity, rather than being reduced to one consensus rank. Liquid is the local-agent-oriented member of the group, with a useful hosted dispatch result; assessing its on-device advantage requires an actual local run. These conclusions concern the measured opening action and screenshot contract, not long-horizon task completion.

## Raw results and reproduction

The [analysis directory](https://github.com/webbrain-one/webbrain/tree/main/test/llm/analysis/2026-10-14-hy4-mimo26-lfm25) contains the seventeen-model report, case hashes, archived ideal actions, historical regressions, pairwise pass differences, provider metadata, campaign timings, and all six runners' logs. The raw [planner results](https://github.com/webbrain-one/webbrain/tree/main/test/llm/results) use the `2026-10-14-openrouter-hy4-mimo26-lfm25-full-7182` tag; raw [MiMo vision results](https://github.com/webbrain-one/webbrain/tree/main/test/vision/results) use `2026-10-14-openrouter-mimo26-vision`. Separate preflight directories are committed alongside them.

Every new planner case saves the complete request and API response. Every new vision case saves raw SSE, final text, usage, provider, finish reason, latency, prompt metadata, and image hashes; the shared PNGs remain in the corpus. All 600 new case results and six preflights accompany this post. The [100 raw Ling vision cases](https://github.com/webbrain-one/webbrain/tree/main/test/vision/results/2026-10-07-openrouter-ling30-budget_inclusionai_ling-3.0-flash-vl_production) are already committed; this update rechecks and reuses them.

```powershell
node test/llm/report-hy4-mimo26-lfm25.mjs
npm run test:vision:validate
node scripts/build-blog.mjs
```

The analysis README records the live settings and reconstruction commands. The orchestrator refuses to overwrite saved evidence; choose fresh tags for future inference. Historical regression and report generation require no API key.

Tags: #HY4 #MiMoV26 #LiquidAI #LFM25 #OpenRouter #BrowserAgent #ToolCalling #Vision #WebBrain
