---
title: >
  Liquid LFM 2.5-8B-A1B on browser tool calling: where the new on-device MoE fits
slug: liquid-lfm25-tool-calling
sortOrder: 10
date: 2026-05-31
readTime: 7 min read
description: >
  We added Liquid AI's LFM 2.5-8B-A1B (8.3B total / 1.5B active MoE) to our browser-agent tool-calling benchmark. Against Claude Sonnet 4.6 it beats both small Qwens but loses to Gemma 4-E2B. Plus: a tool-schema drift bug that changes how we score everything, and why the license asymmetry (LFM's $10M revenue cliff vs Gemma 4's plain Apache 2.0) tilts the distillation call to Gemma.
excerpt: >
  Liquid AI's just-shipped LFM 2.5-8B-A1B (8.3B total / 1.5B active sparse MoE) joins our browser-agent benchmark. It beats both small Qwens and runs within reach of Gemma 4-E2B against Claude Sonnet 4.6 — but for the small-model distillation slot, plain Apache 2.0 still wins over LFM's $10M-revenue-cliff license. Also: a tool-schema drift bug we caught and the freeze fix we shipped.
titleTag: >
  Liquid LFM 2.5-8B-A1B on browser tool calling: an on-device MoE meets WebBrain — WebBrain Blog
ogTitle: >
  Liquid LFM 2.5-8B-A1B on browser tool calling: where it fits
ogDescription: >
  Liquid AI's 8B/1.5B-active on-device MoE in our browser-agent benchmark — and the methodology bug it caught.
twitterTitle: >
  Liquid LFM 2.5-8B-A1B on browser tool calling: where it fits
twitterDescription: >
  An on-device 8B/1.5B-active MoE vs Sonnet 4.6. Plus: a tool-schema drift bug that retroactively changes how we score every future benchmark.
keywords:
  - LFM 2.5
  - LFM2.5-8B-A1B
  - Liquid AI
  - on-device LLM
  - MoE
  - tool calling
  - browser agent
  - Claude Sonnet 4.6
  - WebBrain
  - Liquid Foundation Model
  - sparse mixture of experts
html: true
lede: >
  We added Liquid AI’s **LFM 2.5-8B-A1B** — their just-released on-device sparse Mixture-of-Experts model — to our browser-agent tool-calling benchmark. Against Claude Sonnet 4.6 it beats both small Qwens (0.8B and 2B) and lands within reach of Gemma 4-E2B, despite activating only 1.5B parameters per token. The same run also surfaced a methodology bug that retroactively changes how we score every future benchmark: when the WebBrain tool schema drifts between runs, the “vs Sonnet” score becomes unfair. We fixed it by freezing the schema.
---

## What is LFM 2.5-8B-A1B?

Liquid AI shipped [LFM 2.5-8B-A1B](https://www.liquid.ai/blog/lfm2-5-8b-a1b) on May 28, 2026 — days before this benchmark. It is a hybrid sparse-MoE built for on-device deployment: **8.3B total parameters, 1.5B active per token** (the “A1B” in the name signals roughly 1B active). The architecture pairs Liquid’s LFM2 backbone (24 layers: 18 gated short-convolution “LIV” blocks and 6 grouped-query-attention blocks) with per-layer sparse-MoE FFNs from layer 3 onward — 32 experts per layer with top-4 routing via normalized-sigmoid gating. Context window is 131,072 tokens. Pretraining: 38T tokens, plus large-scale RL post-training that explicitly targets instruction following, tool use, math, and knowledge reasoning.

The lab spun out of MIT’s liquid-neural-networks research and has built the LFM series around efficiency at the edge — phones, laptops, NPUs — rather than chasing frontier-scale accuracy. The 8B-A1B variant is also explicitly a *reasoning* model: it produces an explicit chain of thought before its final answer. That detail turns out to be important for how the model behaves on browser tasks. Open weights are on [Hugging Face](https://huggingface.co/LiquidAI). We tested through the `maternion/lfm2.5` Ollama package on `localhost:11434` — same harness as the rest of our benchmark.

What caught our attention: Liquid AI claims the 2.5 line leads peer small models on IFEval and IFBench, and they highlighted tool use as a first-class RL training objective. Browser tool calling is a stricter test — the model has to pick the right tool from a large schema and pass valid arguments. We wanted to see whether the tool-use training claim holds up when the schema is real WebBrain tools.

## The bug we caught (and what we changed)

The first LFM 2.5 run looked terrible — 34% match with Sonnet, ranked dead last among 14 models. We were about to write that up when we noticed something suspicious: the system prompt and tool list that LFM 2.5 saw were not the same ones Sonnet had seen a week earlier.

WebBrain’s tool schema lives in `src/chrome/src/agent/tools.js` and evolves between releases. Between the May 23 baseline run (which Sonnet defined) and the May 30 LFM run, two tools had been removed (`execute_js`, `download_file`) and three added (`drag_drop`, `hover`, `wait_for_stable`). The system prompt had also changed. So 8 of Sonnet’s 100 picks were tools LFM 2.5 didn’t even have access to. Scoring “match with Sonnet” against a different schema is invalid.

We fixed this by adding a **frozen baseline** mode to the benchmark runner: a snapshot of the system prompt and tools array from Sonnet’s run, replayed verbatim for every comparison. The runner now accepts `--freeze freeze/baseline-2026-05-23.json` and pins the schema. Re-running LFM 2.5 under the frozen baseline:

```
node test/llm/run-llamacpp.mjs \
  --freeze freeze/baseline-2026-05-23.json \
  --base http://localhost:11434/v1 \
  --model maternion/lfm2.5
```

<div class="callout">
<strong>The freeze isn’t cosmetic.</strong> Adding it lifted LFM 2.5 from <strong>34% → 40%</strong> match with Sonnet. Six percentage points came back just from giving the model the same tool list and system prompt the reference saw. That is the size of the methodology error we were running before, and it would have been baked into any future comparison too. Every benchmark we publish from this point uses the frozen baseline.
</div>

## How LFM 2.5 compares

Under the frozen baseline, LFM 2.5 lands at 40% match with Sonnet, 38% on the stricter “match when Sonnet picked a tool” metric (which excludes the 8 cases Sonnet returned no tool), and 83% tool-call rate. Here is where it slots into the leaderboard:

| # | Model | Match vs Sonnet | Match (tool only) | Tool-call rate | Class |
| --- | --- | --- | --- | --- | --- |
| — | **Claude Sonnet 4.6** <span class="badge badge-good">reference</span> | 100% | 100% | 92% | API |
| 1 | Qwen 3.6-27B | 77.0% | 77.2% | 92% | 27B dense |
| 2 | MiniMax M2.7 | 77.0% | 76.1% | 88% | API |
| 3 | Intel Gemma 4-31B-it-int4 | 74.0% | 72.8% | 88% | 31B int4 |
| 4 | Qwen 3.5-4B | 73.0% | 71.7% | 82% | 4B dense |
| 5 | Gemma 4-26B-A4B | 71.0% | 70.7% | 87% | 26B / 4B-act |
| 6 | Qwen 3.6-35B-A3B | 70.0% | 70.7% | 90% | 35B / 3B-act |
| 7 | Qwen 3.5-9B | 70.0% | 69.6% | 90% | 9B dense |
| 8 | Gemma 4-E4B | 68.0% | 68.5% | 87% | 4.5B eff |
| 9 | Nemotron Omni 30B | 67.0% | 68.5% | 93% | 30B |
| 10 | Gemma 4-E2B | 63.0% | 60.9% | 76% | 2.3B eff |
| 11 | Browser-Use 30B-A3B | 43.0% | 45.7% | 93% | 30B / 3B-act |
| 12 | **Liquid LFM 2.5-8B-A1B** <span class="badge badge-new">new</span> | 40.0% | 38.0% | 83% | **8.3B / 1.5B-act** |
| 13 | Qwen 3.5-0.8B | 37.0% | 34.8% | 90% | 0.8B dense |
| 14 | Qwen 3.5-2B | 36.0% | 34.8% | 89% | 2B dense |

## The right comparison: by active / effective compute

Raw rank (12 of 14) is misleading because the “total parameters” column is doing very different things across these models. LFM 2.5-8B-A1B has 8.3B stored weights but only 1.5B fire per token. Gemma 4 E-series uses MatFormer + Per-Layer Embeddings so that “2.3B effective” really is the runtime cost despite a larger stored footprint. Qwen 3.5 small models are plain dense. The honest comparison is by *active or effective parameters at inference time*:

| Model | Active / effective | Stored | Match vs Sonnet | Tool-call rate |
| --- | --- | --- | --- | --- |
| Gemma 4-E2B | 2.3B eff | ~5.1B | 63.0% | 76% |
| Qwen 3.5-2B (dense) | 2.0B | 2.0B | 36.0% | 89% |
| **Liquid LFM 2.5-8B-A1B** | 1.5B active | 8.3B | 40.0% | 83% |
| Qwen 3.5-0.8B (dense) | 0.8B | 0.8B | 37.0% | 90% |

In the 1–2.5B-active-parameter band, Gemma 4-E2B remains the clear browser-agent champion at 63% — nothing in this weight class comes close. LFM 2.5 lands second among them at 40%, beating both small Qwens by 3–4 points with comparable active compute. Worth noting: LFM 2.5 has the highest *stored* footprint in this group (8.3 GB of weights at fp16, or about 4.6 GB at int4), so it is small at runtime but not small on disk — the MoE trade-off.

The Liquid AI claim that the 2.5 line is tuned for tool use is partially supported by the data. The tool-call rate at 83% sits between the “tool-confident-but-wrong” small Qwens (89–90%) and Sonnet’s more measured 92%. The model has learned to *reach for* tools at the right rate. Where it falls short is in tool *selection* — picking the right tool for a given DOM-driving task. We suspect part of this is the reasoning-only training: a CoT-first model burns tokens deliberating before acting, which can look like “no tool call” on a one-shot benchmark even when the underlying decision would have been correct on a second turn.

## Where LFM 2.5 disagrees with Sonnet

Looking at the per-task breakdown, the divergence is systematic, not random. LFM 2.5 has a clear tool-preference bias compared to Sonnet:

- **Under-uses `get_accessibility_tree`:** 18 picks vs Sonnet’s 32. The accessibility tree is the canonical “look at the page structure before acting” tool, and Sonnet reaches for it more than any other.
- **Under-uses `navigate`:** 14 vs Sonnet’s 23. LFM 2.5 sometimes goes to `new_tab` or `research_url` where Sonnet simply navigates the current tab.
- **Over-uses `read_page` and `research_url`:** 13 + 9 vs Sonnet’s 5 + 0. Sonnet never picks `research_url` in these 100 cases. LFM 2.5 reaches for content-reading tools as a default response.
- **Returns no-tool more often:** 17 cases where LFM 2.5 emitted text only, vs Sonnet’s 8. Thirteen of those overlap with cases where Sonnet picked a real tool.

This reads less like “the model can’t reason about browser actions” and more like “the model has a different theory of what to do first.” Its instinct is to read content before acting on it; Sonnet’s instinct is to inspect the page structure first. Both are coherent strategies. They are just different.

## Where LFM 2.5 fits for WebBrain

With 1.5B active parameters per token, LFM 2.5-8B-A1B sits in a useful niche for on-device inference: comparable runtime cost to Gemma 4-E2B (2.3B effective), open weights, designed from day one for laptops and NPUs, and tuned for tool use. We have [written before](/blog/llm-tool-calling-benchmark) about wanting to ship in-browser inference in upcoming WebBrain releases via WebGPU, and the model-selection problem for that path is fundamentally different from the “best model on a beefy GPU” question. You want something whose *per-token compute* stays low, fits in available browser memory budgets, and degrades gracefully when the user’s machine is under load. By that lens, an MoE that activates only 1.5B at a time is exactly the architecture you want — you pay a one-time weight-load cost, then run cheap.

For pure tool routing on browser tasks today, Gemma 4-E2B is still the small-model pick at 63%. LFM 2.5 is the runner-up in its compute class at 40%, and the model is brand new — this is the first WebBrain measurement we have on it. Liquid AI’s focus on on-device deployment also means the inference story (quantization, mobile NPU paths, deterministic latency) is taken more seriously by them than by labs targeting cloud-scale serving. That matters for our use case.

Two concrete things we will try next: (1) adjust the WebBrain system prompt to nudge tool selection toward inspect-first rather than read-first — that change alone might recover several points without retraining anything; (2) re-run with a multi-turn agent loop instead of single-shot scoring, since a CoT-reasoning model is probably under-credited by “first-tool-call” evaluation.

## Bottom line: still Gemma 4-E2B for distillation

For anyone picking a small model to *build on* — distill, fine-tune, ship inside an extension or app — the call right now isn’t close. Gemma 4-E2B is the better pick, and not only for the 23-point browser-tool-calling gap (63% vs 40% against Sonnet).

The licensing matters too. Gemma 4 ships under [plain Apache 2.0](https://ai.google.dev/gemma/terms) — a real change from earlier Gemma generations, which carried a custom restricted license. No revenue thresholds, no usage caveats, no obligation to come back and re-negotiate. You can fine-tune Gemma 4, redistribute the derivative commercially, and even compete with Google’s own products without asking anyone.

LFM 2.5 ships under the [LFM Open License v1.0](https://www.liquid.ai/lfm-license), which is Apache-2.0-derived but adds one consequential clause: commercial use is free *only while your annual revenue is below $10M USD*. Cross the threshold and the commercial grant terminates — you have to contact `sales@liquid.ai` for a paid license. This makes complete sense from Liquid’s side. They don’t have Google’s research-as-loss-leader budget, and the $10M floor is calibrated to let hobbyists, researchers, and pre-revenue startups use the models freely while monetizing the enterprise tail. It is a reasonable business model for a young lab.

But if you’re a startup or an open-source project deciding which model to distill onto your own hardware target, that $10M cliff is a future-self problem worth thinking about. If your project succeeds and crosses the threshold three years from now, you will be in the position of either re-negotiating mid-flight or rewriting your stack onto a different base. Gemma 4 has none of that risk — the license you start with is the license you keep.

So: LFM 2.5 is an interesting on-device architecture from a lab worth watching, and we will retest the line as it evolves. For WebBrain’s small-model slot today, we’re sticking with Gemma 4-E2B.

## Reproducibility

The frozen baseline (system prompt + tool array from Sonnet’s May 23 run, 41 tools, system hash `5c4fac1387025050`) and the runner patch are in the repo. To reproduce this LFM 2.5 result against your own Ollama instance:

```
ollama pull maternion/lfm2.5
export WB_FREEZE_BASELINE=test/llm/freeze/baseline-2026-05-23.json
node test/llm/run-llamacpp.mjs \
  --base http://localhost:11434/v1 \
  --model maternion/lfm2.5
```

You should see a banner like:

```
▸ FROZEN baseline loaded: test/llm/freeze/baseline-2026-05-23.json
  source: anthropic/claude-sonnet-4.6 @ 2026-05-23T18-47-31-246Z
  tools=41, systemBytes=35242, systemHash=5c4fac1387025050…
```

If you don’t see that banner, the run is on the live (drifting) schema and the numbers are not comparable.

All data and the interactive explorer:

- [github.com/webbrain-one/webbrain/tree/main/test/llm/analysis](https://github.com/webbrain-one/webbrain/tree/main/test/llm/analysis) — spreadsheets and the per-task HTML matrix
- [freeze/baseline-2026-05-23.json](https://github.com/webbrain-one/webbrain/blob/main/test/llm/freeze/baseline-2026-05-23.json) — the snapshot the runner pins to

Tags: #LFM2.5 #LiquidAI #SmallLanguageModel #ToolCalling #BrowserAgent #OnDeviceAI
