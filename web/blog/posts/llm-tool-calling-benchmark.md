---
title: >
  13 LLMs, 100 browser tasks, two baselines: which model actually picks the right tool?
slug: llm-tool-calling-benchmark
sortOrder: 20
date: 2026-05-23
readTime: 8 min read
description: >
  We benchmarked 13 local and API LLMs on 100 real browser-agent tool-calling tasks against both consensus voting and Claude Sonnet 4.6. The winner depends on which question you ask.
excerpt: >
  We benchmarked 13 local and API models on 100 real browser-agent tool-calling tasks against both consensus voting and Claude Sonnet 4.6. The consensus winner (Qwen 3.6-35B-A3B at 94%) isn't the Sonnet-match winner (Qwen 3.6-27B at 77%) — and that gap tells you something useful about what "correct" means for tool calling.
titleTag: >
  13 LLMs, 100 Browser Tasks, Two Baselines: Which Model Actually Picks the Right Tool? — WebBrain Blog
ogTitle: >
  13 LLMs, 100 Browser Tasks: Which Model Picks the Right Tool?
ogDescription: >
  Benchmarking 13 models on real browser-agent tasks against consensus voting and Claude Sonnet 4.6. The consensus winner isn't the Sonnet-match winner.
twitterTitle: >
  13 LLMs, 100 Browser Tasks: Which Model Picks the Right Tool?
twitterDescription: >
  Consensus winner ≠ Sonnet-match winner. Full data and interactive explorer included.
keywords:
  - LLM benchmark
  - tool calling
  - browser agent
  - Qwen 3.6
  - Claude Sonnet
  - consensus voting
  - WebBrain
  - self-hosted LLM
  - MoE
  - Gemma 4
html: true
lede: >
  Our previous blog posts focused on vision — which model reads a screenshot best. This one is about the other half of a browser agent: **tool use and reasoning**. We ran 13 models through 100 real WebBrain prompts and scored them two ways: against majority-vote consensus and against Claude Sonnet 4.6. The consensus winner is not the Sonnet-match winner — and that gap tells you something useful about what “correct” means for tool calling.
---

## The setup

WebBrain routes browser automation through tool calls — `click`, `type`, `scroll`, `navigate`, and so on. The planner LLM sees a page description and a user prompt, then picks a tool and its arguments. We collected 100 representative prompts from real sessions and ran them through 13 models, most self-hosted on local hardware via llama.cpp and vLLM, plus one API model (MiniMax M2.7 through OpenRouter).

Each model got the same system prompt, the same page context, and the same user instruction. We recorded the first tool pick, latency, token counts, and cost.

## Two ways to score

There is no hand-labeled ground truth for these 100 prompts. Instead we used two reference signals:

- **Consensus voting** — for each prompt, take the tool that the majority of all 13 models chose. Then score each model by how often it agreed with the majority.
- **Sonnet 4.6 match** — use Claude Sonnet 4.6 (via API) as a strong reference. Score each model by how often its pick matched Sonnet’s pick.

Neither is perfect. Consensus rewards popularity, not correctness — if most models make the same mistake, the consensus is wrong. Sonnet is a strong model but not infallible, and it may have stylistic preferences that differ from equally valid alternatives. Using both baselines surfaces models that are *robust* (agree with the crowd) versus models that are *aligned with a strong reference* (track Sonnet’s judgment).

## Results: consensus leaderboard

| # | Model | Agreement | Tool-call rate | Valid-tool rate |
| --- | --- | --- | --- | --- |
| 1 | **Qwen 3.6-35B-A3B** | 94.2% | 93% | 93% |
| 2 | Qwen 3.6-27B | 87.0% | 87% | 87% |
| 3 | Intel Gemma 4-31B-it-int4 | 87.3% | 87% | 87% |
| 4 | Qwen 3.5-4B | 85.8% | 85% | 85% |
| 5 | MiniMax M2.7 | 84.1% | 90% | 90% |
| 6 | Gemma 4-26B-A4B | 81.7% | 89% | 89% |
| 7 | Gemma 4-E2B | 81.5% | 85% | 84% |
| 8 | Gemma 4-E4B | 80.5% | 85% | 85% |
| 9 | Qwen 3.5-9B | 80.0% | 82% | 82% |
| 10 | Browser-Use Qwen 30B-A3B | 78.2% | 84% | 84% |
| 11 | Nemotron Omni 30B | 52.8% | 76% | 75% |
| 12 | Qwen 3.5-0.8B | 48.8% | 88% | 88% |
| 13 | Qwen 3.5-2B | 43.0% | 82% | 82% |

**Both Qwen 3.6 models are excellent here.** The 35B-A3B MoE dominates consensus at 94%, and the dense 27B is close behind at 87%. The MoE architecture matters for deployment: 35B total but only 3B active means it runs on modest hardware while drawing on a much larger parameter pool. Intel’s Gemma 4 int4 quant also lands in the top tier. Below that, most models cluster in the 78–86% range. The sub-4B models (0.8B and 2B) fall apart — they still *make* tool calls at high rates, but they pick the wrong tool nearly half the time.

## Results: Sonnet 4.6 match

| # | Model | Match (all) | Match (tool only) | Tool-call rate |
| --- | --- | --- | --- | --- |
| — | **Claude Sonnet 4.6** <span class="badge badge-good">reference</span> | 100% | 100% | 92% |
| 1 | **Qwen 3.6-27B** | 77.0% | 77.2% | 90% |
| 2 | MiniMax M2.7 | 77.0% | 76.1% | 90% |
| 3 | Intel Gemma 4-31B-it-int4 | 74.0% | 72.8% | 87% |
| 4 | Qwen 3.5-4B | 73.0% | 71.7% | 85% |
| 5 | Gemma 4-26B-A4B | 71.0% | 70.7% | 89% |
| 6 | Qwen 3.6-35B-A3B | 70.0% | 70.7% | 93% |
| 7 | Qwen 3.5-9B | 70.0% | 69.6% | 82% |
| 8 | Gemma 4-E4B | 68.0% | 68.5% | 85% |
| 9 | Nemotron Omni 30B | 66.0% | 66.3% | 76% |
| 10 | Gemma 4-E2B | 60.0% | 59.7% | 85% |
| 11 | Browser-Use Qwen 30B-A3B | 59.0% | 58.7% | 84% |
| 12 | Qwen 3.5-0.8B | 53.0% | 52.2% | 88% |

Here the leaderboard reshuffles. **Qwen 3.6-27B** (the dense model, not the MoE) takes the top spot at 77% match, tied with MiniMax — making the 27B the more accurate of the two Qwen models when measured against a frontier reference. The consensus champion, Qwen 3.6-35B-A3B, drops to 6th place at 70%.

## The interesting gap

The same model can rank 1st on consensus and 6th on Sonnet match. What’s going on?

Qwen 3.6-35B-A3B is the model that other models most agree with — it anchors the consensus. But Sonnet 4.6 often makes *different* choices that the 35B MoE doesn’t follow. The dense 27B tracks Sonnet more closely, possibly because Sonnet is also a dense model and they share similar reasoning patterns for ambiguous cases.

<div class="callout">
<strong>What this means in practice:</strong> if you're building a self-hosted browser agent and you want the model that makes the safest, most predictable picks, Qwen 3.6-35B-A3B is your best bet — it's the one everyone else agrees with. If you want the model whose judgment most resembles a frontier API model, the dense Qwen 3.6-27B is closer to Sonnet’s reasoning. Both are valid strategies. Pick based on whether you value consensus safety or frontier alignment.
</div>

## Other findings

### Sub-4B Qwen models are not ready for tool calling

Qwen 3.5-0.8B and 3.5-2B both maintain tool-call rates above 82% — they *try* to call tools. But they pick the wrong one 43–53% of the time. High tool-call rate with low accuracy is worse than refusing to call, because the agent acts confidently on the wrong action.

### Gemma 4 is blazing fast

Gemma 4 models are the latency winners across the board. Median response times sit around 450–630 ms on llama.cpp — the fastest in the entire test. Qwen models are noticeably slower, with the dense 27B at ~10.3 seconds being the slowest by far. We did not apply any inference optimization (speculative decoding, continuous batching, quantization tuning) to the Qwen models, so there is headroom to close that gap. But out of the box, if you need sub-second tool routing, Gemma 4 is the answer.

### MiniMax M2.7: strong but with trade-offs

MiniMax M2.7 ties for first on Sonnet match at 77% and scores well on consensus. It’s a genuinely good tool-calling model. But it has no vision capability, and it’s a much larger model parameter-wise — you can’t self-host it on consumer hardware. For a browser agent that needs both tool routing *and* screenshot understanding, MiniMax can only fill one of those roles. It cost $0.16 for the full 100-prompt run via OpenRouter, which is cheap for an API but infinitely more than the $0 self-hosted models.

### Nemotron Omni 30B is solid

NVIDIA’s Nemotron Omni 30B-A3B doesn’t top any leaderboard here, but it’s a reliable mid-tier pick at 53% consensus and 66% Sonnet match. Its lower tool-call rate (76%) means it’s more conservative about routing — it sometimes declines to pick a tool rather than guessing wrong. For use cases where false positives are costly, that caution has value.

### Qwen 3.5-4B: the biggest surprise in the benchmark

This is the result that genuinely surprised us. At just 4B parameters, Qwen 3.5-4B hits 86% consensus agreement and 73% Sonnet match — competitive with models 7× its size. It outperforms the 9B Qwen on both metrics. It beats every Gemma 4 variant on consensus. It even edges out MiniMax on Sonnet match. For the amount of VRAM it uses (≤8 GB), the tool-calling quality is remarkable. If you are building a browser agent on constrained hardware, this tiny model deserves serious consideration.

### Sub-2B: Gemma 4-E2B is the best of the small

In the smallest weight class (under 2B parameters), Gemma 4-E2B clearly beats both Qwen 3.5-0.8B and 3.5-2B. It reaches 82% consensus agreement where the two Qwen sub-2B models manage only 43–49%. The E2B also has the fastest latency in the entire benchmark. It’s not accurate enough to trust unsupervised, but if you need a tiny model for pre-filtering or speculative routing on extremely limited hardware, Gemma 4-E2B is the only sub-2B option worth considering.

## Explore the raw data

All benchmark data is open. The repo contains both spreadsheets and an interactive HTML explorer that lets you drill into per-task differences:

- [github.com/webbrain-one/webbrain/tree/main/test/llm/analysis](https://github.com/webbrain-one/webbrain/tree/main/test/llm/analysis)

Files included:

- `llm_browser_agent_vs_consensus.xlsx` — full consensus benchmark with per-task breakdowns
- `llm_browser_agent_vs_sonnet.xlsx` — Sonnet 4.6 comparison with per-task breakdowns
- `llm_browser_agent_vs_sonnet_simple.html` — interactive leaderboard and per-task matrix (open locally in a browser)

## What we’re doing with this

WebBrain already uses Qwen 3.6-35B-A3B as the default planner for self-hosted deployments. This benchmark confirms that choice for consensus-safe routing. We are also exploring a hybrid approach: use the MoE for fast routing on clear-cut prompts, and fall back to the dense 27B (or an API call to Sonnet) for ambiguous cases where frontier judgment matters more than speed.

The per-task data also revealed specific prompt categories where all local models diverge from Sonnet — these are candidates for improved system prompts or few-shot examples in the tool-calling pipeline.

Tags: #LLM #Benchmark #ToolCalling #BrowserAgent
