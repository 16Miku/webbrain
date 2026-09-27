---
title: >
  DeepSeek V4 Flash Vision Exp tested: a great planner with experimental eyes
slug: deepseek-v4-flash-vision-openrouter
sortOrder: -280
date: 2026-08-27
readTime: 9 min read
description: >
  We tested DeepSeek V4 Flash Vision Exp on 200 WebBrain browser-agent cases. Its text planning beats Qwen3.8 Flash and GLM-5.3 Flash, but its experimental vision route trails both.
excerpt: >
  DeepSeek V4 Flash Vision Exp delivers the best first-action routing of our three new Flash models and a 2.60-second planner median. Its vision side is fast, but only 68 of 100 screenshots pass the strict rubric.
titleTag: >
  DeepSeek V4 Flash Vision Exp benchmark on OpenRouter - WebBrain Blog
ogTitle: >
  DeepSeek V4 Flash Vision Exp: 200 browser-agent tests
ogDescription: >
  A 284B-total, 13B-active MoE wins our text-planning comparison but trails Qwen and GLM on browser vision. Architecture, dynamic pricing, latency, cost, and raw results.
twitterTitle: >
  DeepSeek V4 Flash Vision Exp: fast planner, experimental eyes
twitterDescription: >
  45 canonical-or-terminal planner outcomes, 16 exact routes, and a 2.60s median. Vision is quick at 5.13s median but reaches only 68/100 strict passes.
keywords:
  - DeepSeek V4 Flash Vision Exp
  - DeepSeek V4 Flash 0731
  - OpenRouter
  - multimodal model benchmark
  - browser agent
  - mixture of experts
  - vision language model
  - tool calling
  - AI API pricing
  - WebBrain
author: Emre Sokullu
authorUrl: https://emresokullu.com
lede: >
  **DeepSeek's experimental multimodal route is a better browser planner than its name suggests—and a weaker vision model than the name might imply.** We sent `deepseek/deepseek-v4-flash-vision-exp` through WebBrain's 100-case Chrome planning corpus and 100 production-prompt screenshots on OpenRouter. All 200 requests completed. DeepSeek produced more canonical first actions than Qwen3.8 Flash or GLM-5.3 Flash, matched Qwen's excellent planner latency, and delivered the best p95. On screenshots it was the fastest of the three, yet strict quality fell to **68/100**, eleven passes behind Qwen. This is a strong agentic text model with useful experimental eyes—not yet the best all-purpose multimodal default.
---

## The short verdict

DeepSeek V4 Flash Vision Exp splits cleanly into two personalities:

| Role | DeepSeek result | Position among the three Flash models |
| --- | ---: | --- |
| Text planning | **45** ideal-name-or-terminal outcomes; **16** exact ideals | **Best routing conformity** |
| Planner latency | 2.60s median; **8.55s p95** | Essentially tied with Qwen at the median; best tail latency |
| Browser vision | 68 strict passes; 89.5% mean rubric | Third, behind Qwen's 79 and GLM's 76 |
| Vision latency | **5.13s median; 7.60s p95** | **Fastest** |
| Observed cost | $0.0942 for all 200 calls | Slightly below Qwen in our run; above promotional GLM |

The route makes sense when text, coding, reasoning, or tool use dominates and screenshots are occasional. If browser vision is a first-class workload, Qwen3.8 Flash remains the stronger single-model default. If roles can be split, DeepSeek is an appealing planner paired with a better vision specialist.

## What is actually behind the vision route?

[OpenRouter describes DeepSeek V4 Flash Vision Exp](https://openrouter.ai/deepseek/deepseek-v4-flash-vision-exp) as an experimental image-enabled version of [DeepSeek V4 Flash 0731](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731). It accepts text and images, returns text, exposes a 1,048,576-token context window, and supports tool calling plus `low`, `high`, and `max` reasoning effort.

The well-documented part is the text backbone. The exact vision attachment is not yet documented publicly. OpenRouter says the route adds image understanding while retaining the base model's text capabilities, but neither its listing nor DeepSeek's public 0731 model card specifies the visual encoder, projector, image-token budget, or multimodal training recipe. Those details should not be reverse-engineered from marketing copy, so this article treats the vision stack as a measured black box.

### A 284B model with a 13B hot path

The underlying [DeepSeek V4 architecture](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash) is a sparse mixture of experts with **284 billion core parameters and 13 billion activated per token**. It is enormous in stored capacity but Flash-sized in live computation. The instruct checkpoint stores MoE expert weights in FP4 while most attention, normalization, and router parameters remain FP8.

DeepSeek combines two long-context mechanisms:

- **Compressed Sparse Attention (CSA)** retrieves a small set of relevant positions instead of attending densely over the whole sequence.
- **Heavily Compressed Attention (HCA)** maintains a much smaller representation of broader history.

The official report says the V4 family reaches one-million-token context while its Pro model uses 27% of DeepSeek V3.2's single-token inference FLOPs and 10% of its KV cache at that length. Manifold-Constrained Hyper-Connections strengthen signal flow across layers, and the training stack moves to the Muon optimizer. DeepSeek pre-trained V4 on more than 32 trillion tokens, cultivated domain-specific experts with supervised fine-tuning and GRPO, then consolidated them through on-policy distillation.

The 0731 revision adds **DSpark speculative decoding** to the checkpoint. DeepSeek's model card says the target and draft components ship together and can propose seven speculative tokens per step in vLLM. This also explains an otherwise confusing pair of figures: OpenRouter describes the core as 284B/13B, while Hugging Face metadata for the 0731 repository reports roughly 304B stored parameters after the attached speculative module. That explanation is an inference from the published checkpoint structure, not a separate parameter claim from DeepSeek.

This is the important architectural point: DeepSeek V4 Flash is not a small model. It is a very large sparse model designed to keep only a small portion of its capacity hot, compress long-context memory aggressively, and speculate ahead during decoding.

## OpenRouter pricing has a clock attached

On August 27, 2026, OpenRouter's models API listed these standard rates:

| Model | Input / 1M | Output / 1M | Cache read / 1M | Context |
| --- | ---: | ---: | ---: | ---: |
| `deepseek/deepseek-v4-flash-vision-exp` | $0.22 | $0.66 | **$0.007** | 1,048,576 |
| `qwen/qwen3.8-flash` | $0.15 | $0.47 | $0.016 | 1,000,000 |
| `z-ai/glm-5.3-flash` | **$0.075 promo** | **$0.25 promo** | $0.015 | 1,310,720 |

DeepSeek is not the cheapest route in this group. At standard rates its uncached input costs 47% more than Qwen and its output costs 40% more. GLM's temporary launch promotion makes the gap much larger.

There is also an unusual time-of-day override. The live OpenRouter model record doubles DeepSeek Vision Exp to **$0.44 input, $1.32 output, and $0.014 cache read per million tokens** on weekdays from **01:00–04:00 UTC** and **06:00–10:00 UTC**. Weekends and the remaining weekday hours use the standard rate. A production cost model should therefore include UTC scheduling, not just the headline price.

Our tests ran outside those peak windows. OpenRouter reported:

| Workload | Prompt tokens | Completion tokens | Observed cost |
| --- | ---: | ---: | ---: |
| 100 text-planner calls | 2.587M | 25.2K | $0.0495 |
| 100 production vision calls | 75.1K | 50.7K | $0.0447 |
| **Total** | **2.662M** | **76.0K** | **$0.0942** |

That total was about four percent lower than our Qwen run despite DeepSeek's higher list rates, largely because providers tokenize and meter images differently. It was 43% above GLM's promotional bill. Treat those observed totals as route-and-workload measurements, not a replacement for token pricing.

## What we ran

The **regular LLM benchmark** used WebBrain's 100-case Chrome first-action corpus at Full tier. Each case carries the current system prompt, page context, and production OpenAI-compatible tool schemas. The runner captures one response and does not execute the action. We used the same temperature and no reasoning-effort override as the Qwen3.8 Flash and GLM-5.3 Flash comparison.

The canonical `idealFirstToolCall` is intentionally a routing hint, not a complete task grade. A cautious model may inspect the accessibility tree where the fixture expects an immediate click and still behave well in a live loop. Exact matches are useful for regression testing, but they are not equivalent to end-to-end browser success.

The **vision benchmark** sent 100 browser screenshots through WebBrain's exact production vision contract: fixed six-section system prompt, temperature 0, an 800-token maximum, weighted fact checks, and critical-fact gating. A strict pass requires both the score threshold and every critical fact.

DeepSeek recommends temperature 1.0 and larger reasoning budgets for its hardest agent tasks. We intentionally did not adopt those settings: this run measures the model under WebBrain's normal fast planner and screenshot paths, apples-to-apples with the other two models—not DeepSeek's maximum-reasoning ceiling.

All 200 requests returned successfully. No API key or authorization header is present in the saved results.

## Text planning: DeepSeek takes the lead

| Model | Tool calls | Ideal name or terminal answer | Exact ideal | Tree first | Median | p95 | Observed cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **DeepSeek V4 Flash Vision Exp** | 93 + 7 prose responses | **45** | **16** | **43** | 2.60s | **8.55s** | $0.0495 |
| GLM-5.3 Flash | **100** | 41 | 13 | 48 | 7.24s | 16.49s | **$0.0446 promo** |
| Qwen3.8 Flash | 97 + 3 prose responses | 36 | 12 | 54 | **2.55s** | 11.54s | $0.0572 |

DeepSeek wins both conformity columns. It selected the expected tool name on 39 cases and gave a correct terminal prose answer on six `done` cases, producing 45 ideal-name-or-terminal outcomes. Sixteen calls also matched the canonical arguments exactly. The lower structured-call total is less worrying than it first appears: six of the seven prose responses were the correct terminal answer, while the seventh asked the expected clarification in ordinary text instead of invoking the `clarify` tool.

It also reads the accessibility tree less reflexively. DeepSeek chose `get_accessibility_tree` first 43 times, versus 48 for GLM and 54 for Qwen. That helps canonical conformity when a direct navigation or specialized tool is already justified, although reading first can still be prudent in a real browser session.

Latency is the more decisive win. Qwen remains 43 milliseconds faster at the median—functionally a tie—but DeepSeek cuts Qwen's p95 by three seconds and GLM's by almost eight. Across the full set, DeepSeek averaged 3.46 seconds per response.

The result fits the 0731 release's positioning. DeepSeek specifically re-post-trained Flash for agentic work and ships native tool schemas plus a speculative decoding module. In our harness, those improvements show up as both better first-route discipline and a tighter latency tail.

## Vision: fastest, but eleven passes behind Qwen

| Model | Strict passes | Mean rubric | Median | p95 | Output tokens | Observed cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **DeepSeek V4 Flash Vision Exp** | 68 / 100 | 89.5% | **5.13s** | **7.60s** | 50.7K | $0.0447 |
| GLM-5.3 Flash | 76 / 100 | 93.8% | 5.49s | 8.92s | 45.1K | **$0.0211 promo** / ~$0.042 list |
| Qwen3.8 Flash | **79 / 100** | **94.8%** | 8.42s | 13.43s | 45.3K | $0.0411 |

DeepSeek is unquestionably fast. It edges GLM at both the median and p95 and is dramatically quicker than Qwen. But the quality gap is too large to wave away as threshold noise: DeepSeek loses eight strict passes to GLM and eleven to Qwen, while its mean rubric falls more than four points below Qwen.

The difficulty curve makes the pattern visible:

| Difficulty | DeepSeek | GLM | Qwen |
| --- | ---: | ---: | ---: |
| Easy | 70% | **80%** | 70% |
| Basic | 75% | 70% | **85%** |
| Intermediate | 75% | **85%** | **85%** |
| Advanced | 65% | **80%** | **80%** |
| Challenging | 55% | 65% | **75%** |

The experimental route holds up through ordinary forms, tables, and dashboards, then degrades faster as screenshots become dense, multilingual, occluded, or calibration-heavy. It passed all five cases in toast notifications, consent banners, chart reading, data tables, and kanban boards. It managed only 2/5 for authentication, calendar, and multilingual OCR, 1/5 for form validation, and 0/5 for modal overlays.

Some of those failures are shared. Qwen and GLM also scored 0/5 on modal overlays and 1/5 on form validation in the same run. The vision route is not uniquely broken there. The sharper concern is the challenging band, where Qwen retains 15 passes, GLM 13, and DeepSeek 11.

At 68 strict passes, DeepSeek lands exactly alongside the older Qwen3-VL-30B-A3B result and one behind Qwen3-VL-32B from our [budget vision comparison](/blog/qwen-budget-vision-openrouter). That is respectable for a newly attached experimental capability, but it does not reset the budget vision tier the way Qwen3.8 Flash and GLM-5.3 Flash did.

## The right way to deploy it

- **Best reason to choose DeepSeek:** text-heavy browser agents. It leads canonical routing, nearly matches Qwen's median, and has the best p95.
- **Best single multimodal default:** Qwen3.8 Flash. Its planner is just as responsive at the median and its vision quality is materially stronger.
- **Best current value for frequent screenshots:** GLM-5.3 Flash while the launch discount lasts. It keeps most of Qwen's quality, approaches DeepSeek's vision speed, and costs much less today.
- **Best split configuration:** DeepSeek as the main planner, with Qwen or GLM handling screenshot description. WebBrain can configure the two roles separately.

DeepSeek V4 Flash Vision Exp is still useful as a one-model endpoint when images are occasional and switching providers is undesirable. It accepts the image, produces a structured description quickly, and keeps the excellent V4 Flash agent backbone available for the rest of the loop. The model ID's `exp` suffix should simply be taken seriously: the vision stack is measurable and functional, but not yet as mature as the text side.

## Raw results

```text
test/llm/results/2026-08-27-openrouter-full_chrome_deepseek_deepseek-v4-flash-vision-exp
test/vision/results/2026-08-27-openrouter-full_deepseek_deepseek-v4-flash-vision-exp_production
```

The benchmark harness, screenshots, rubrics, and complete result files live in [`test/llm`](https://github.com/esokullu/webbrain/tree/main/test/llm) and [`test/vision`](https://github.com/esokullu/webbrain/tree/main/test/vision). The directly comparable Qwen3.8 Flash and GLM-5.3 Flash analysis is in [our previous post](/blog/qwen38-flash-vs-glm53-flash).

Tags: #DeepSeekV4 #DeepSeekFlash #OpenRouter #MultimodalAI #MixtureOfExperts #VisionLanguageModel #ToolCalling #BrowserAgent #WebBrain
