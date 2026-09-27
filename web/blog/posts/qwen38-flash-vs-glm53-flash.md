---
title: >
  Qwen3.8 Flash vs GLM-5.3 Flash: the budget multimodal tier just reset
slug: qwen38-flash-vs-glm53-flash
sortOrder: -270
date: 2026-08-27
readTime: 9 min read
description: >
  We tested Qwen3.8 Flash and GLM-5.3 Flash on 400 WebBrain browser-agent cases. Both are huge multimodal MoEs with small active paths, million-token context, and near-identical list pricing. Qwen wins vision; GLM wins cost under a temporary launch discount.
excerpt: >
  Qwen3.8 Flash reaches 79 strict vision passes and a 2.55-second planner median. GLM-5.3 Flash lands at 76 vision passes, follows the canonical first route more often, and costs half as much only while its 50% launch promotion lasts.
titleTag: >
  Qwen3.8 Flash vs GLM-5.3 Flash browser benchmark - WebBrain Blog
ogTitle: >
  Qwen3.8 Flash vs GLM-5.3 Flash: 400 browser-agent tests
ogDescription: >
  Two new multimodal MoEs, 400 WebBrain cases, zero final errors. Qwen wins vision quality and text speed; GLM wins promotional cost and vision latency.
twitterTitle: >
  Qwen3.8 Flash vs GLM-5.3 Flash: the budget tier just reset
twitterDescription: >
  Qwen: 79/100 vision and 2.55s planner median. GLM: 76/100 vision and a temporary 50% price advantage. Architecture, pricing, and full WebBrain results.
keywords:
  - Qwen3.8 Flash
  - GLM-5.3 Flash
  - OpenRouter
  - multimodal model benchmark
  - browser agent
  - mixture of experts
  - vision language model
  - tool calling
  - cheap AI API
  - WebBrain
author: Emre Sokullu
authorUrl: https://emresokullu.com
lede: >
  **Two releases arriving within hours made the old budget multimodal shortlist look ancient.** Qwen3.8 Flash and GLM-5.3 Flash are not tiny models. They are enormous sparse systems that execute only a small fraction of their weights for each token, accept text, images, and video, and expose roughly million-token context windows. On OpenRouter their normal token prices are almost identical. We sent both through WebBrain's 100-case text-planner suite and 100-case production vision suite: **400 final case results, zero errors**. Qwen won vision quality and text speed. GLM followed our canonical first-action hint more often, answered screenshots faster, and was cheaper only because its launch price is temporarily cut in half.
---

## The short verdict

These are both credible one-model backends for a browser agent. Neither behaves like a bargain-bin checkpoint.

| Model | Text planner | Browser vision | Best reason to choose it |
| --- | --- | --- | --- |
| **Qwen3.8 Flash** | 97 tool calls + 3 terminal prose answers; 2.55s median | **79 strict passes**, **94.8%** mean rubric | Better overall vision and much faster text planning |
| **GLM-5.3 Flash** | **100 tool calls**; more canonical first routes | 76 strict passes, 93.8% mean rubric; **5.49s median** | Faster screenshots and exceptional promotional pricing |

The important pricing word is **promotional**. On August 27, 2026, [OpenRouter listed GLM-5.3 Flash](https://openrouter.ai/z-ai/glm-5.3-flash) at **$0.075 per million input tokens and $0.25 per million output tokens**. That is a temporary 50% discount scheduled through September 9, 2026. Its intended list price is $0.15/$0.50, almost the same as [Qwen3.8 Flash](https://openrouter.ai/qwen/qwen3.8-flash) at $0.16/$0.47.

So GLM is not fundamentally a half-price model next to Qwen. It is a similarly priced model currently wearing a half-price launch sticker.

## Two different ways to make a giant model cheap

"Flash" used to imply a small dense checkpoint or an aggressively distilled sibling. These two releases take a more interesting route: keep a large pool of capacity, then make the active computation per token much smaller.

| Model | Disclosed language architecture | Active per token | Layers | Long-context design | OpenRouter context |
| --- | --- | ---: | ---: | --- | ---: |
| Qwen3.8 Flash | 125B main model, plus 51B n-gram embeddings and a 4B multi-token-prediction head | **6B** | 48 | Gated DeltaNet + Qwen Sparse Attention | 1,000,000 |
| GLM-5.3 Flash | 320B sparse MoE | **18B** | 45 | linear attention + sparse attention + IndexPool | 1,310,720 advertised; provider route tops out near 1M |

Those totals require context. “6B active” does not mean Qwen is a 6B download, and “18B active” does not make GLM a consumer-size 18B checkpoint. The weights are still large. What becomes small is the **hot path**: the parameters and attention work touched while generating each token. That is what makes hosted inference cheap and what makes unconventional local deployment—offloading cold capacity while keeping the active path fast—interesting.

### Qwen: 6B active, with memory moved out of the hot path

The production `qwen/qwen3.8-flash` route is based on the open [Qwen3.8-Flash-Next](https://huggingface.co/Qwen/Qwen3.8-Flash-Next) release, with production features such as a default 1M context and built-in tools. Qwen calls Flash-Next an early preview of the architecture behind Qwen4.

Its 48 layers repeat a 3:1 pattern: three Gated DeltaNet layers followed by one Qwen Sparse Attention layer, with MoE blocks after both. DeltaNet compresses the running history into a fixed-size state; sparse attention periodically retrieves precise information from the wider context. Only 6B of the 125B main-model parameters activate per token.

The stranger idea is the additional **51B-parameter n-gram embedding table**. Qwen stores useful short phrase patterns in a large lookup structure that is cheap to index and easier to offload than normal transformer computation. Capacity grows without forcing every parameter through the accelerator on every token. This is not a small model. It is a large model designed so that most of its size is computationally quiet.

### GLM: a larger active path, but half the layers of its ancestor

[GLM-5.3 Flash](https://huggingface.co/zai-org/GLM-5.3-Flash) is the first natively multimodal model in the GLM-5 family. It has 320B total parameters, 18B active per token, and 45 layers. Z.ai compares that with GLM-4.5's 355B total, 32B active, and 92 layers: similar stored capacity, almost half the active parameters, and roughly half the depth.

GLM also mixes linear and sparse attention. Linear attention maintains local state cheaply; sparse attention reaches back for global context. IndexPool reduces the sparse indexer's own memory and latency by pooling its keys, while Manifold-Constrained Hyper-Connections widen the residual path without paying the usual scaling penalty. [Z.ai reports](https://z.ai/blog/glm-5.3-flash) 3× less attention compute and a 4.4× smaller average KV cache than full GLM-5.3.

Both architectures arrive at the same product proposition: keep enough total capacity for modern coding, agent, and visual work, but stop paying dense-model prices to use it.

## OpenRouter pricing: nearly equal after the sale

OpenRouter prices per million tokens on August 27:

| Model | Input now | Output now | Cache read now | Normal/list input | Normal/list output |
| --- | ---: | ---: | ---: | ---: | ---: |
| `z-ai/glm-5.3-flash` | **$0.075** | **$0.25** | $0.015 | $0.15 | $0.50 |
| `qwen/qwen3.8-flash` | $0.16 | $0.47 | $0.016 | $0.16 | $0.47 |

At list price, GLM input is six percent cheaper and output is six percent more expensive. For most real workloads, that is the same price band. The current two-to-one gap is a launch promotion, not an architectural law; budget decisions made from the discounted column should include an expiry date.

Our runs also show why list rates are not the whole bill. Both text runs reported more than 2.4M cached prompt tokens because the WebBrain system prompt and tool schemas repeat. Qwen emitted fewer text-planner completion tokens, while the two vision runs emitted almost exactly the same number. The exact workload mix decides which nearly identical list price is cheaper.

## What we ran

Both model IDs were served through the same OpenRouter account on August 27, 2026.

The **regular LLM run** used WebBrain's 100-case Chrome first-action corpus at Full tier: current Act/Ask prompts, native OpenAI-compatible tool schemas, temperature 0.15, and no reasoning-effort override. It captures one response and does not execute the tool. The canonical `idealFirstToolCall` is a deterministic routing hint, not a full end-to-end success grade; a model that safely reads the accessibility tree before clicking can miss the hint and still finish the live task correctly.

The **vision run** used WebBrain's 100 browser screenshots and exact production vision contract: the shipped six-section prompt, temperature 0, 800-token maximum, weighted fact checks, and critical-fact gating. A strict pass requires both enough weighted evidence and every critical fact.

Two Qwen text requests and two Qwen vision requests hit temporary upstream 429 rate limits. All four succeeded on retry. Every final case file is complete, and no API key was stored in the results.

We did not include the separate 100-case multi-turn recovery suite in this pass.

## Vision: Qwen wins by three, GLM wins the clock

| Model | Strict passes | Mean rubric | Median | p95 | Output tokens | Observed cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **Qwen3.8 Flash** | **79 / 100** | **94.8%** | 8.42s | 13.43s | 45.3K | $0.041 |
| **GLM-5.3 Flash** | 76 / 100 | 93.8% | **5.49s** | **8.92s** | 45.1K | **$0.021 promo** / ~$0.042 list |

Qwen's quality lead is real but narrow: three strict passes and just under one rubric point. GLM's latency lead is larger. It answered a screenshot roughly three seconds sooner at the median and kept its p95 under Qwen's median-plus-half-a-second.

The difficulty curve shows where the three-pass difference comes from:

| Difficulty band | Qwen3.8 Flash | GLM-5.3 Flash |
| --- | ---: | ---: |
| Easy | 70% | **80%** |
| Basic | **85%** | 70% |
| Intermediate | 85% | 85% |
| Advanced | 80% | 80% |
| Challenging | **75%** | 65% |

Qwen is stronger at the hard end and dramatically better on authentication screens: 5/5 strict passes against GLM's 2/5. GLM wins photo understanding 5/5 to 4/5, multilingual OCR 3/5 to 2/5, and search results 5/5 to 4/5.

Their overlap is revealing. Both pass 72 cases. Qwen alone passes seven; GLM alone passes four; both fail 17. The shared blind spots are the same ones that have survived several model generations: **both score 0/5 on modal overlays and 1/5 on form validation**. More parameters and newer attention do not automatically fix a small inline error associated with the wrong field or a dialog whose blocker must be described precisely.

## Text planning: Qwen is faster, GLM follows the hint more often

| Model | Tool calls | Ideal name or terminal answer | Exact ideal | Tree first | Median | p95 | Observed cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **GLM-5.3 Flash** | **100** | **41** | **13** | 48 | 7.24s | 16.49s | **$0.045 promo** / ~$0.089 list |
| **Qwen3.8 Flash** | 97 + 3 terminal prose | 36 | 12 | 54 | **2.55s** | **11.54s** | $0.057 |

Qwen's three prose responses were knowledge questions where the expected terminal action was `done`; treating them as acceptable terminal answers gives it 36 ideal-name-or-terminal outcomes. GLM emits a structured tool on every case and reaches 41 canonical tool names.

The low exact totals need the same caution as every first-action article we publish. Many misses are harmless argument differences such as a trailing slash, an explicit read limit, or equivalent URL encoding. More importantly, both models often choose `get_accessibility_tree` where the deterministic hint expects an immediate click. GLM does that 48 times and Qwen 54 times. In a live browser loop, reading before acting is frequently prudent; this harness measures dispatch conformity, not final task completion.

The cleaner operational distinction is speed. Qwen's 2.55-second median is excellent for a 6B-active multimodal model carrying the full WebBrain prompt and tool set. GLM is more than twice as slow on text, even though it is substantially faster on the screenshot route we tested. Provider scheduling, vision preprocessing, cache behavior, and model architecture all contribute; “Flash” is not one universal latency class.

## The old budget Qwen shortlist is obsolete

Five days ago, our [six-model Qwen budget comparison](/blog/qwen-budget-vision-openrouter) ended with Qwen3-VL-32B Instruct at 69 strict passes and Qwen3-VL-30B-A3B Instruct at 68. Those were good results. They have already been passed by two general-purpose models that also handle serious text planning, million-token context, image input, and video input.

| Model | Vision passes | Mean rubric | Mean latency | Cost / 100 vision cases |
| --- | ---: | ---: | ---: | ---: |
| **Qwen3.8 Flash** | **79** | **94.8%** | 8.8s | $0.041 |
| **GLM-5.3 Flash** | 76 | 93.8% | 5.9s | **$0.021 promo** / ~$0.042 list |
| Muse Glimmer 30B | 73 | 93.3% | 16.1s | $0.098 |
| Qwen3-VL-32B Instruct | 69 | 91.9% | 4.6s | $0.022 |
| Qwen3-VL-30B-A3B Instruct | 68 | 91.3% | **2.2s** | $0.024 |

At GLM's current promotional price, the newer 320B-A18B model is **cheaper per token than every Qwen route in that old budget table**, while beating its best strict-pass score by seven. Qwen3.8 Flash costs about two cents more per 100 screenshots than the old instruct specialists, but buys ten extra passes over the 32B leader and replaces a vision-only purchasing decision with a modern multimodal generalist.

There is no longer a good reason to reach first for the archaic budget Qwen3-VL routes on OpenRouter. The exceptions are narrow and measurable: Qwen3-VL-30B-A3B remains the latency winner at 2.2 seconds, and Qwen3-VL-32B remains the absolute two-cent option. If those last milliseconds or pennies are the binding constraint, keep them. For a new general browser-agent deployment, the current Flash generation gives you a larger capability surface and materially better vision without leaving the budget tier.

## Which one should you call?

- **Best single hosted default:** Qwen3.8 Flash. It wins strict vision quality, has the stronger challenging-case floor, and its text-planner median is less than half GLM's.
- **Best value during the launch promotion:** GLM-5.3 Flash. It is slightly behind on vision quality but faster on screenshots, emits a tool on every planner case, and currently costs half its intended list rate.
- **Best post-promotion choice:** treat them as nearly equal on token price. Pick Qwen for vision hit rate and text latency; pick GLM for screenshot latency and slightly better canonical first-route conformity.
- **Best split WebBrain setup today:** Qwen is the faster text planner; GLM is the faster vision sub-call. WebBrain can configure those roles separately if latency matters more than using one model ID everywhere.

The larger lesson is architectural. The useful small-model metric is no longer the number in the model name. Qwen carries well over a hundred billion main-model parameters while activating six billion. GLM stores 320 billion while activating eighteen. Both can be much more capable than yesterday's 8B and 30B budget checkpoints without making each generated token traverse the whole model.

The budget tier did not merely get a little better. It got much larger, much more modern, and—in GLM's temporary case—even cheaper.

## Raw results

```text
test/llm/results/2026-08-27-openrouter-full_chrome_qwen_qwen3.8-flash
test/llm/results/2026-08-27-openrouter-full_chrome_z-ai_glm-5.3-flash
test/vision/results/2026-08-27-openrouter-full_qwen_qwen3.8-flash_production
test/vision/results/2026-08-27-openrouter-full_z-ai_glm-5.3-flash_production
```

The benchmark harness, screenshots, rubrics, and result files live in [`test/llm`](https://github.com/esokullu/webbrain/tree/main/test/llm) and [`test/vision`](https://github.com/esokullu/webbrain/tree/main/test/vision).

Tags: #Qwen38Flash #GLM53Flash #OpenRouter #MultimodalAI #MixtureOfExperts #VisionLanguageModel #ToolCalling #BrowserAgent #LocalAI #WebBrain
