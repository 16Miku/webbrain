---
title: >
  Liquid LFM3-VL-2B vs WebBrain Compass VLD: a launch-day benchmark
slug: lfm3-vl-2b-vs-webbrain-compass-vld
sortOrder: -420
date: 2026-10-28
readTime: 8 min read
description: >
  We ran Liquid's new LFM3-VL-2B against WebBrain Compass VLD Tiny v5, our MiniCPM-V-4.7-1B fine-tune, on 4,857 BenchKit tasks per model the night LFM3 launched. LFM3 wins six of nine suites. Total cost on RunPod: $0.34.
excerpt: >
  LFM3-VL-2B beats Compass VLD Tiny v5 on six of nine general vision and text suites, ties three, and loses none. Compass is still the only one of the two that is also a decision model. Next: an LFM3-based VLD.
titleTag: >
  LFM3-VL-2B vs WebBrain Compass VLD Tiny v5 - WebBrain Blog
ogTitle: >
  Liquid LFM3-VL-2B vs WebBrain Compass VLD: a launch-day benchmark
ogDescription: >
  Same tasks, same llama.cpp build, same rented GPU. LFM3-VL-2B wins six of nine BenchKit suites against our MiniCPM-V-based Compass. Compass keeps one edge: it is also a decision model.
twitterTitle: >
  LFM3-VL-2B vs WebBrain Compass VLD Tiny v5
twitterDescription: >
  4,857 BenchKit tasks per model on launch day for $0.34. LFM3 wins on vision and text; Compass still folds decisions into the same model. We'll build an LFM3-based VLD next.
keywords:
  - Liquid LFM3
  - LFM3-VL-2B
  - d1-2B
  - WebBrain Compass VLD Tiny v5
  - MiniCPM-V-4.7-1B
  - BenchKit
  - vision language model
  - decision model
  - llama.cpp
  - RunPod
author: Emre Sokullu
authorUrl: https://emresokullu.com
html: true
lede: >
  **Liquid released LFM3 on October 27, and that night we ran LFM3-VL-2B against WebBrain Compass VLD Tiny v5, the small on-device model inside WebBrain.** Same tasks, same engine, same GPU: 4,857 BenchKit tasks per model on a rented RTX A4000 for $0.34. To be frank, Compass loses: LFM3-VL-2B wins six of nine suites and Compass wins none. Compass is still the only one of the two that is also a decision model, and that shapes what we build next.
---

## What Compass actually is

WebBrain Compass VLD Tiny v5 is not a model we trained from scratch. It is our fine-tune of [OpenBMB's MiniCPM-V-4.7-1B](https://huggingface.co/openbmb/MiniCPM-V-4.7-1B), trained in two rounds on one RTX 5090, about 20 hours in total:

- **Round 1:** one pass over 344,139 samples: WebBrain's own screenshot data, MolmoPoint GUI grounding, WebChain trajectories and the Compass text release. LoRA (rank 64) on every linear layer of the language model, the vision-to-language merger trained in full, the vision tower frozen.
- **Round 2:** 51,811 more samples, adding d1 page-state decision data, a larger share of text, and a replay of the visual data.

The result is one checkpoint for three jobs: vision-language (reading screenshots, pointing at elements), text and tool calls, and decisions (is the task done, which option matches the page). That is the VLD in the name. The [model card](https://huggingface.co/webbrain-one/webbrain-compass-vld-tiny-v5) has the full recipe.

## Sizes first

The two models are not the same size, and they spend their parameters in different places. These counts come straight from each checkpoint's weights:

| | Compass VLD Tiny v5 (MiniCPM-V-4.7-1B) | LFM3-VL-2B |
| --- | ---: | ---: |
| Total parameters | 1.55B | 1.92B |
| Language model, layers | 498M | 1,467M |
| Language model, embeddings and output head | 508M | 262M |
| Vision encoder | 522M | 164M |
| Vision-to-language projector | 26M | 25M |
| Language model design | Qwen3.5-0.8B-style: 18 Gated DeltaNet + 6 attention layers | LFM3: 13 gated short convolutions, 5 sliding-window and 6 global attention layers |

LFM3-VL-2B is about a quarter larger overall. It puts nearly three times as many parameters into its language-model layers, while MiniCPM puts about three times as many into its vision encoder. Keep that in mind below: the text-heavy suites favour the bigger language model, and the smaller one decodes faster.

## How we ran it

- **Harness:** [BenchKit](https://github.com/DogukanUrker/BenchKit) v0.2.1, headless, temperature 0, 300 seconds per task. Nine suites: four vision (MMVP, V* Bench, OCRBench, ChartQA) and five text (BenchKit's sanity set, IFEval, GSM8K, MMLU-Pro, BANKING77). ChartQA, GSM8K, MMLU-Pro and BANKING77 ran on fixed slices, and BenchKit spreads vision slices across categories.
- **Engine:** on launch day no vLLM or SGLang release could serve LFM3-VL, and llama.cpp support was an open pull request, [#31252](https://github.com/ggml-org/llama.cpp/pull/31252). We built that branch on the pod; it was merged into llama.cpp later the same day. Both models ran on that single build, BF16 weights with F16 vision encoders, 16 requests in flight. We converted Compass to GGUF from its merged weights with llama.cpp's own converter.
- **Settings:** thinking off for both. Compass has no thinking mode and LFM3 turns it on by default, so we switched it off to compare like with like. LFM3 kept Liquid's recommended repeat penalty of 1.1; Compass uses none.
- **Hardware and cost:** one RTX A4000 16 GB on RunPod community cloud at $0.17 an hour. The whole session took 121 minutes, including two llama.cpp builds, the conversion, the d1-2B run further down and some idle time at the end: about **$0.34**.
- **A check on the port:** LFM3's thinking-off scores land within about a point of Liquid's own model card: V* 79.6 vs 80.6, OCRBench 81.5 vs 82.2, ChartQA 82.0 vs 81.4. The pre-release llama.cpp support behaves.

Both models answered identical tasks, so we compare them task by task. The table gives the paired difference with its 95% interval, and a suite counts as a win only when that interval stays on one side of zero.

## Results

<div class="bench-style">
<style>
.bench, .bench-fig { --m-lfm3: #8b83ff; --m-compass: #2dd4bf; --m-d1: #fbbf24; }
[data-theme="light"] .bench, [data-theme="light"] .bench-fig { --m-lfm3: #5b52e8; --m-compass: #0f766e; --m-d1: #a16207; }
.bench table { font-variant-numeric: tabular-nums; }
.bench td.num, .bench th.num { text-align: right; }
.bench td.win { font-weight: 700; color: var(--text); }
.bench td.w-lfm3 { background: color-mix(in srgb, var(--m-lfm3) 18%, transparent); box-shadow: inset 3px 0 0 var(--m-lfm3); }
.bench td.w-compass { background: color-mix(in srgb, var(--m-compass) 18%, transparent); box-shadow: inset 3px 0 0 var(--m-compass); }
.bench td.w-d1 { background: color-mix(in srgb, var(--m-d1) 20%, transparent); box-shadow: inset 3px 0 0 var(--m-d1); }
.bench .pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.bench .pill.lfm3 { color: var(--text); background: color-mix(in srgb, var(--m-lfm3) 26%, transparent); }
.bench .pill.compass { color: var(--text); background: color-mix(in srgb, var(--m-compass) 26%, transparent); }
.bench .pill.tie { color: var(--text-dim); background: var(--tint-medium); }
.bench-note { color: var(--text-dim); font-size: 13px; margin: -12px 0 24px; }
.bench-fig { margin: 28px 0 36px; }
.bench-fig h3 { margin-bottom: 6px; }
.bench-fig figcaption { color: var(--text-dim); font-size: 14px; line-height: 1.6; margin: 0 0 10px; }
.bench-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; color: var(--text-dim); margin: 0 0 8px; }
.bench-legend span { display: inline-flex; align-items: center; gap: 6px; }
.bench-legend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.bench-legend i.lfm3 { background: var(--m-lfm3); }
.bench-legend i.compass { background: var(--m-compass); }
.bench-legend i.d1 { background: var(--m-d1); }
.bench-legend i.tie { background: var(--text-dim); }
.bench-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 8px 6px; background: var(--tint-soft-2); }
.bench-scroll svg { display: block; width: 100%; min-width: 600px; height: auto; }
.bench-fig svg text { font-family: inherit; }
.bench-fig .lab { fill: var(--text); font-size: 13px; }
.bench-fig .grp { fill: var(--text-dim); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.bench-fig .tick { fill: var(--text-dim); font-size: 12px; }
.bench-fig .val { fill: var(--text-dim); font-size: 12px; }
.bench-fig .val.strong { fill: var(--text); font-weight: 700; }
.bench-fig .grid { stroke: var(--border); stroke-width: 1; }
.bench-fig .zero { stroke: var(--text-dim); stroke-width: 1.5; }
.bench-fig .conn { stroke: var(--text-dim); stroke-width: 1; opacity: .45; }
.bench-fig .f-lfm3 { fill: var(--m-lfm3); } .bench-fig .s-lfm3 { stroke: var(--m-lfm3); }
.bench-fig .f-compass { fill: var(--m-compass); } .bench-fig .s-compass { stroke: var(--m-compass); }
.bench-fig .f-d1 { fill: var(--m-d1); } .bench-fig .s-d1 { stroke: var(--m-d1); }
.bench-fig .f-tie { fill: var(--text-dim); } .bench-fig .s-tie { stroke: var(--text-dim); }
.bench-fig .ci { stroke-width: 2.5; stroke-linecap: round; }
.bench-fig .ci.soft { opacity: .5; }
</style>
</div>

<div class="table-wrap bench">
<table>
<thead><tr>
<th>Suite</th><th class="num">Tasks</th><th class="num">LFM3-VL-2B</th><th class="num">Compass v5</th><th>Difference (95% interval)</th><th>Verdict</th>
</tr></thead>
<tbody>
<tr><td>MMVP</td><td class="num">300</td><td class="num">75.3</td><td class="num">73.7</td><td>+1.7 (−3.8 to +7.2)</td><td><span class="pill tie">too close</span></td></tr>
<tr><td>V* Bench</td><td class="num">191</td><td class="num win w-lfm3">79.6</td><td class="num">65.4</td><td>+14.1 (+6.0 to +22.3)</td><td><span class="pill lfm3">LFM3</span></td></tr>
<tr><td>OCRBench</td><td class="num">1,000</td><td class="num win w-lfm3">81.5</td><td class="num">72.6</td><td>+8.9 (+6.1 to +11.7)</td><td><span class="pill lfm3">LFM3</span></td></tr>
<tr><td>ChartQA</td><td class="num">1,000</td><td class="num win w-lfm3">82.0</td><td class="num">65.6</td><td>+16.4 (+13.5 to +19.3)</td><td><span class="pill lfm3">LFM3</span></td></tr>
<tr><td>Sanity</td><td class="num">25</td><td class="num">64.0</td><td class="num">48.0</td><td>+16.0 (−8.5 to +40.5)</td><td><span class="pill tie">too close</span></td></tr>
<tr><td>IFEval</td><td class="num">541</td><td class="num win w-lfm3">69.5</td><td class="num">54.9</td><td>+14.6 (+9.9 to +19.3)</td><td><span class="pill lfm3">LFM3</span></td></tr>
<tr><td>GSM8K</td><td class="num">500</td><td class="num">68.2</td><td class="num">70.6</td><td>−2.4 (−7.4 to +2.6)</td><td><span class="pill tie">too close</span></td></tr>
<tr><td>MMLU-Pro</td><td class="num">300</td><td class="num win w-lfm3">46.7</td><td class="num">23.0</td><td>+23.7 (+17.1 to +30.2)</td><td><span class="pill lfm3">LFM3</span></td></tr>
<tr><td>BANKING77</td><td class="num">1,000</td><td class="num win w-lfm3">38.0</td><td class="num">31.6</td><td>+6.4 (+3.3 to +9.5)</td><td><span class="pill lfm3">LFM3</span></td></tr>
</tbody>
</table>
</div>

**LFM3-VL-2B wins six of nine suites, three are too close to call, and Compass wins none.** The [appendix](#appendix-charts) has these numbers as charts.

**The vision gap is real.** LFM3 leads V* Bench, which asks about small details in high-resolution images, by 14 points; ChartQA by 16; OCRBench by 9. MMVP, image pairs that differ in one detail, is a tie. Inside OCRBench, Compass falls furthest behind on document questions (65.5 vs 80.0), key-information extraction (64.5 vs 79.0) and handwritten math (46.0 vs 70.0). It is ahead on artistic text (92.0 vs 84.0). On ChartQA the gap is widest on the machine-generated questions (74.4 vs 94.2) and still 13 points on the human-written ones (56.8 vs 69.8).

**The text gap follows the language-model sizes.** LFM3 leads IFEval by 14.6 points, MMLU-Pro by 23.7 and BANKING77 by 6.4. GSM8K is the exception: a statistical tie, with Compass slightly ahead at 70.6 against 68.2.

**Two harness effects cut both ways.** BenchKit counts both as wrong answers. LFM3 writes long explanations even with thinking off, about 1,080 tokens per MMLU-Pro question, and 52 of its 300 answers ran past the 300-second limit. Compass, without a repeat penalty, fell into repetition loops that BenchKit stopped: 60 times on IFEval and 24 on GSM8K. Compass also answers very briefly, 63 tokens per MMLU-Pro question on average, which is part of why it scores low there and part of why it is fast.

**Per token, Compass is the faster model.** On the A4000, one request at a time, it decodes 157 tokens per second against LFM3's 91. That follows from the smaller language model, and on a user's machine it matters: Compass answers a page-state decision request in about 0.94 seconds in the browser on an RTX 5090.

We left LFM3's thinking mode off. Liquid reports higher scores with it on (ChartQA 92.7, V* 86.4), at the cost of many more generated tokens.

## These are general benchmarks, not WebBrain's tasks

BenchKit's suites test general vision and text skill. WebBrain's own jobs are narrower: deciding whether a page shows a finished task, pointing at the right element, choosing the right browser tool. Compass was tuned for exactly those, and on our own evaluations it scores 120 of 126 on the d1 page-state test with zero false completions, and puts 65.5% of its points within 0.05 of the target on our visual grounding set. We haven't run LFM3-VL-2B on those tests yet, so this post doesn't settle which model is better inside WebBrain.

## Compass is also a decision model

The bigger difference is in what each checkpoint does. Compass is a VLD: the same model that reads screenshots and calls tools also answers WebBrain's decision questions. It scores each option with a yes/no verification pass plus a small probe on top, all inside the browser.

Liquid splits these jobs. LFM3-VL-2B is the vision-language chat model, and decisions come from a separate checkpoint, [d1-2B](https://huggingface.co/LiquidAI/d1-2B), built on the same LFM3-VL-2B backbone. It returns calibrated probabilities for every option in one pass, without generating text. Today there is no single Liquid model that does both.

We ran d1-2B as well, through llama.cpp's decision endpoint (`/v1/systemone`, support still in pull request [#31275](https://github.com/ggml-org/llama.cpp/pull/31275)), on the four suites BenchKit can score in decision mode. Same tasks as above:

<div class="table-wrap bench">
<table>
<thead><tr>
<th>Suite</th><th class="num">d1-2B (decision)</th><th class="num">LFM3-VL-2B (chat)</th><th class="num">Compass v5 (chat)</th><th class="num">Calibration error</th><th class="num">Median latency</th>
</tr></thead>
<tbody>
<tr><td>MMVP</td><td class="num win w-d1">80.7</td><td class="num">75.3</td><td class="num">73.7</td><td class="num">0.045</td><td class="num">119 ms</td></tr>
<tr><td>V* Bench</td><td class="num win w-d1">82.7</td><td class="num win w-lfm3">79.6</td><td class="num">65.4</td><td class="num">0.073</td><td class="num">1,930 ms</td></tr>
<tr><td>MMLU-Pro</td><td class="num">32.0</td><td class="num win w-lfm3">46.7</td><td class="num">23.0</td><td class="num">0.048</td><td class="num">130 ms</td></tr>
<tr><td>BANKING77</td><td class="num win w-d1">86.6</td><td class="num">38.0</td><td class="num">31.6</td><td class="num">0.058</td><td class="num">186 ms</td></tr>
</tbody>
</table>
</div>

The best score in each row is highlighted. On V* Bench, d1-2B and LFM3-VL-2B are within each other's 95% interval, so both are marked.

Picking among listed options is what d1 is built for, and it shows. On BANKING77 the chat models have to write one of 77 intent names exactly, while d1 only has to pick one. Its probabilities are well calibrated, and a decision takes 120 to 190 milliseconds on the A4000, about 1.9 seconds on V*'s large images. It loses to chat LFM3 on MMLU-Pro, where writing out the reasoning helps.

BenchKit can't put Compass in decision mode, because llama.cpp only serves native decision architectures through that endpoint. Compass's decision numbers come from our own d1 test above.

## What we take from it

LFM3-VL-2B is a clearly stronger base than MiniCPM-V-4.7-1B on general vision and text, for about a quarter more parameters and roughly 60% of the decode speed. Compass's edge is that it already folds decisions into the same model, which Liquid's lineup doesn't.

So the next step is to merge the two ideas: **an LFM3-based VLD**, LFM3-VL-2B fine-tuned with the Compass recipe (our screenshot data, the Compass text release and d1 decision data). We'll look into it, and if it holds up on our own decision, grounding and routing tests and runs fast enough in the browser, we expect to make it WebBrain's default on-device model once it's fine-tuned. Liquid already publishes an ONNX build of LFM3-VL-2B, which helps with the WebGPU path.

In the meantime, LFM3-VL-2B already works in WebBrain as a local model through llama.cpp.

## Appendix: charts

<figure class="bench-fig" id="chart-difference">
<h3>A. Difference per suite</h3>
<figcaption>LFM3-VL-2B minus Compass v5 in points, with the 95% interval of the per-task difference. Right of zero favours LFM3. A suite is a win only when its interval stays on one side of zero.</figcaption>
<div class="bench-legend"><span><i class="lfm3"></i>LFM3-VL-2B</span><span><i class="tie"></i>Too close to call</span></div>
<div class="bench-scroll">
<svg viewBox="0 0 720 392" role="img" aria-label="LFM3-VL-2B minus Compass v5 per suite, with 95% intervals" xmlns="http://www.w3.org/2000/svg"><title>LFM3-VL-2B minus Compass v5 per suite, with 95% intervals</title>
<line class="grid" x1="118.0" x2="118.0" y1="18" y2="340"/>
<text class="tick" x="118.0" y="358" text-anchor="middle">−10</text>
<line class="zero" x1="215.8" x2="215.8" y1="18" y2="340"/>
<text class="tick" x="215.8" y="358" text-anchor="middle">0</text>
<line class="grid" x1="313.6" x2="313.6" y1="18" y2="340"/>
<text class="tick" x="313.6" y="358" text-anchor="middle">+10</text>
<line class="grid" x1="411.5" x2="411.5" y1="18" y2="340"/>
<text class="tick" x="411.5" y="358" text-anchor="middle">+20</text>
<line class="grid" x1="509.3" x2="509.3" y1="18" y2="340"/>
<text class="tick" x="509.3" y="358" text-anchor="middle">+30</text>
<line class="grid" x1="607.1" x2="607.1" y1="18" y2="340"/>
<text class="tick" x="607.1" y="358" text-anchor="middle">+40</text>
<text class="tick" x="207.8" y="380" text-anchor="end">← Compass better</text>
<text class="tick" x="223.8" y="380">LFM3 better →</text>
<text class="grp" x="0" y="36">Vision</text>
<text class="lab" x="0" y="67.0">MMVP</text>
<line class="ci s-tie" x1="178.6" x2="286.2" y1="63.0" y2="63.0"/>
<circle class="f-tie" cx="232.4" cy="63.0" r="5.5"/>
<text class="val" x="294.2" y="67.0">+1.7</text>
<text class="lab" x="0" y="97.0">V* Bench</text>
<line class="ci s-lfm3" x1="274.5" x2="434.0" y1="93.0" y2="93.0"/>
<circle class="f-lfm3" cx="353.7" cy="93.0" r="5.5"/>
<text class="val strong" x="442.0" y="97.0">+14.1</text>
<text class="lab" x="0" y="127.0">OCRBench</text>
<line class="ci s-lfm3" x1="275.5" x2="330.3" y1="123.0" y2="123.0"/>
<circle class="f-lfm3" cx="302.9" cy="123.0" r="5.5"/>
<text class="val strong" x="338.3" y="127.0">+8.9</text>
<text class="lab" x="0" y="157.0">ChartQA</text>
<line class="ci s-lfm3" x1="347.9" x2="404.6" y1="153.0" y2="153.0"/>
<circle class="f-lfm3" cx="376.2" cy="153.0" r="5.5"/>
<text class="val strong" x="412.6" y="157.0">+16.4</text>
<text class="grp" x="0" y="178">Text</text>
<text class="lab" x="0" y="209.0">Sanity</text>
<line class="ci s-tie" x1="132.7" x2="612.0" y1="205.0" y2="205.0"/>
<circle class="f-tie" cx="372.3" cy="205.0" r="5.5"/>
<text class="val" x="620.0" y="209.0">+16.0</text>
<text class="lab" x="0" y="239.0">IFEval</text>
<line class="ci s-lfm3" x1="312.7" x2="404.6" y1="235.0" y2="235.0"/>
<circle class="f-lfm3" cx="358.6" cy="235.0" r="5.5"/>
<text class="val strong" x="412.6" y="239.0">+14.6</text>
<text class="lab" x="0" y="269.0">GSM8K</text>
<line class="ci s-tie" x1="143.4" x2="241.3" y1="265.0" y2="265.0"/>
<circle class="f-tie" cx="192.3" cy="265.0" r="5.5"/>
<text class="val" x="249.3" y="269.0">−2.4</text>
<text class="lab" x="0" y="299.0">MMLU-Pro</text>
<line class="ci s-lfm3" x1="383.1" x2="511.2" y1="295.0" y2="295.0"/>
<circle class="f-lfm3" cx="447.6" cy="295.0" r="5.5"/>
<text class="val strong" x="519.2" y="299.0">+23.7</text>
<text class="lab" x="0" y="329.0">BANKING77</text>
<line class="ci s-lfm3" x1="248.1" x2="308.7" y1="325.0" y2="325.0"/>
<circle class="f-lfm3" cx="278.4" cy="325.0" r="5.5"/>
<text class="val strong" x="316.7" y="329.0">+6.4</text>
</svg>
</div>
</figure>

<figure class="bench-fig" id="chart-scores">
<h3>B. Score per suite</h3>
<figcaption>Accuracy out of 100 for both models, with 95% Wilson intervals. The numbers on the right are the two scores.</figcaption>
<div class="bench-legend"><span><i class="lfm3"></i>LFM3-VL-2B</span><span><i class="compass"></i>Compass VLD Tiny v5</span></div>
<div class="bench-scroll">
<svg viewBox="0 0 720 328" role="img" aria-label="Score per suite for both models, with 95% Wilson intervals" xmlns="http://www.w3.org/2000/svg"><title>Score per suite for both models, with 95% Wilson intervals</title>
<line class="grid" x1="118.0" x2="118.0" y1="10" y2="298"/>
<text class="tick" x="118.0" y="316" text-anchor="middle">0</text>
<line class="grid" x1="240.5" x2="240.5" y1="10" y2="298"/>
<text class="tick" x="240.5" y="316" text-anchor="middle">25</text>
<line class="grid" x1="363.0" x2="363.0" y1="10" y2="298"/>
<text class="tick" x="363.0" y="316" text-anchor="middle">50</text>
<line class="grid" x1="485.5" x2="485.5" y1="10" y2="298"/>
<text class="tick" x="485.5" y="316" text-anchor="middle">75</text>
<line class="grid" x1="608.0" x2="608.0" y1="10" y2="298"/>
<text class="tick" x="608.0" y="316" text-anchor="middle">100</text>
<text class="lab" x="0" y="30.0">MMVP</text>
<line class="conn" x1="487.0" x2="479.1" y1="26.0" y2="26.0"/>
<line class="ci soft s-lfm3" x1="462.0" x2="509.5" y1="21.0" y2="21.0"/>
<circle class="f-lfm3" cx="487.0" cy="21.0" r="5"/>
<line class="ci soft s-compass" x1="453.2" x2="501.7" y1="31.0" y2="31.0"/>
<circle class="f-compass" cx="479.1" cy="31.0" r="5"/>
<text class="val f-lfm3" x="622" y="30.0">75.3</text>
<text class="val f-compass" x="668" y="30.0">73.7</text>
<text class="lab" x="0" y="62.0">V* Bench</text>
<line class="conn" x1="508.0" x2="438.5" y1="58.0" y2="58.0"/>
<line class="ci soft s-lfm3" x1="477.2" x2="533.0" y1="53.0" y2="53.0"/>
<circle class="f-lfm3" cx="508.0" cy="53.0" r="5"/>
<line class="ci soft s-compass" x1="404.6" x2="469.8" y1="63.0" y2="63.0"/>
<circle class="f-compass" cx="438.5" cy="63.0" r="5"/>
<text class="val f-lfm3" x="622" y="62.0">79.6</text>
<text class="val f-compass" x="668" y="62.0">65.4</text>
<text class="lab" x="0" y="94.0">OCRBench</text>
<line class="conn" x1="517.3" x2="473.7" y1="90.0" y2="90.0"/>
<line class="ci soft s-lfm3" x1="505.1" x2="528.6" y1="85.0" y2="85.0"/>
<circle class="f-lfm3" cx="517.3" cy="85.0" r="5"/>
<line class="ci soft s-compass" x1="460.0" x2="487.0" y1="95.0" y2="95.0"/>
<circle class="f-compass" cx="473.7" cy="95.0" r="5"/>
<text class="val f-lfm3" x="622" y="94.0">81.5</text>
<text class="val f-compass" x="668" y="94.0">72.6</text>
<text class="lab" x="0" y="126.0">ChartQA</text>
<line class="conn" x1="519.8" x2="439.4" y1="122.0" y2="122.0"/>
<line class="ci soft s-lfm3" x1="507.6" x2="531.1" y1="117.0" y2="117.0"/>
<circle class="f-lfm3" cx="519.8" cy="117.0" r="5"/>
<line class="ci soft s-compass" x1="424.7" x2="453.7" y1="127.0" y2="127.0"/>
<circle class="f-compass" cx="439.4" cy="127.0" r="5"/>
<text class="val f-lfm3" x="622" y="126.0">82.0</text>
<text class="val f-compass" x="668" y="126.0">65.6</text>
<text class="lab" x="0" y="158.0">Sanity</text>
<line class="conn" x1="431.6" x2="353.2" y1="154.0" y2="154.0"/>
<line class="ci soft s-lfm3" x1="336.1" x2="509.0" y1="149.0" y2="149.0"/>
<circle class="f-lfm3" cx="431.6" cy="149.0" r="5"/>
<line class="ci soft s-compass" x1="265.0" x2="443.9" y1="159.0" y2="159.0"/>
<circle class="f-compass" cx="353.2" cy="159.0" r="5"/>
<text class="val f-lfm3" x="622" y="158.0">64.0</text>
<text class="val f-compass" x="668" y="158.0">48.0</text>
<text class="lab" x="0" y="190.0">IFEval</text>
<line class="conn" x1="458.5" x2="387.0" y1="186.0" y2="186.0"/>
<line class="ci soft s-lfm3" x1="438.9" x2="476.7" y1="181.0" y2="181.0"/>
<circle class="f-lfm3" cx="458.5" cy="181.0" r="5"/>
<line class="ci soft s-compass" x1="366.4" x2="407.1" y1="191.0" y2="191.0"/>
<circle class="f-compass" cx="387.0" cy="191.0" r="5"/>
<text class="val f-lfm3" x="622" y="190.0">69.5</text>
<text class="val f-compass" x="668" y="190.0">54.9</text>
<text class="lab" x="0" y="222.0">GSM8K</text>
<line class="conn" x1="452.2" x2="463.9" y1="218.0" y2="218.0"/>
<line class="ci soft s-lfm3" x1="431.6" x2="471.3" y1="213.0" y2="213.0"/>
<circle class="f-lfm3" cx="452.2" cy="213.0" r="5"/>
<line class="ci soft s-compass" x1="443.9" x2="482.6" y1="223.0" y2="223.0"/>
<circle class="f-compass" cx="463.9" cy="223.0" r="5"/>
<text class="val f-lfm3" x="622" y="222.0">68.2</text>
<text class="val f-compass" x="668" y="222.0">70.6</text>
<text class="lab" x="0" y="254.0">MMLU-Pro</text>
<line class="conn" x1="346.8" x2="230.7" y1="250.0" y2="250.0"/>
<line class="ci soft s-lfm3" x1="319.4" x2="374.3" y1="245.0" y2="245.0"/>
<circle class="f-lfm3" cx="346.8" cy="245.0" r="5"/>
<line class="ci soft s-compass" x1="209.1" x2="255.7" y1="255.0" y2="255.0"/>
<circle class="f-compass" cx="230.7" cy="255.0" r="5"/>
<text class="val f-lfm3" x="622" y="254.0">46.7</text>
<text class="val f-compass" x="668" y="254.0">23.0</text>
<text class="lab" x="0" y="286.0">BANKING77</text>
<line class="conn" x1="304.2" x2="272.8" y1="282.0" y2="282.0"/>
<line class="ci soft s-lfm3" x1="289.5" x2="318.9" y1="277.0" y2="277.0"/>
<circle class="f-lfm3" cx="304.2" cy="277.0" r="5"/>
<line class="ci soft s-compass" x1="259.1" x2="287.0" y1="287.0" y2="287.0"/>
<circle class="f-compass" cx="272.8" cy="287.0" r="5"/>
<text class="val f-lfm3" x="622" y="286.0">38.0</text>
<text class="val f-compass" x="668" y="286.0">31.6</text>
</svg>
</div>
</figure>

<figure class="bench-fig" id="chart-categories">
<h3>C. Inside the vision suites</h3>
<figcaption>The categories OCRBench, ChartQA and V* Bench report, out of 100. Within each suite, the rows where Compass trails most come first.</figcaption>
<div class="bench-legend"><span><i class="lfm3"></i>LFM3-VL-2B</span><span><i class="compass"></i>Compass VLD Tiny v5</span></div>
<div class="bench-scroll">
<svg viewBox="0 0 720 566" role="img" aria-label="Per-category scores inside OCRBench, ChartQA and V* Bench for both models" xmlns="http://www.w3.org/2000/svg"><title>Per-category scores inside OCRBench, ChartQA and V* Bench for both models</title>
<line class="grid" x1="206.0" x2="206.0" y1="6" y2="540"/>
<text class="tick" x="206.0" y="558" text-anchor="middle">0</text>
<line class="grid" x1="323.0" x2="323.0" y1="6" y2="540"/>
<text class="tick" x="323.0" y="558" text-anchor="middle">25</text>
<line class="grid" x1="440.0" x2="440.0" y1="6" y2="540"/>
<text class="tick" x="440.0" y="558" text-anchor="middle">50</text>
<line class="grid" x1="557.0" x2="557.0" y1="6" y2="540"/>
<text class="tick" x="557.0" y="558" text-anchor="middle">75</text>
<line class="grid" x1="674.0" x2="674.0" y1="6" y2="540"/>
<text class="tick" x="674.0" y="558" text-anchor="middle">100</text>
<text class="grp" x="0" y="20">OCRBench</text>
<text class="lab" x="0" y="44.5">Handwritten math</text>
<rect class="f-lfm3" x="206.0" y="30.0" width="327.6" height="9" rx="3"/>
<text class="val" x="538.6" y="38.0">70.0</text>
<rect class="f-compass" x="206.0" y="42.0" width="215.3" height="9" rx="3"/>
<text class="val" x="426.3" y="50.0">46.0</text>
<text class="lab" x="0" y="77.5">Document questions</text>
<rect class="f-lfm3" x="206.0" y="63.0" width="374.4" height="9" rx="3"/>
<text class="val" x="585.4" y="71.0">80.0</text>
<rect class="f-compass" x="206.0" y="75.0" width="306.5" height="9" rx="3"/>
<text class="val" x="517.5" y="83.0">65.5</text>
<text class="lab" x="0" y="110.5">Key-information extraction</text>
<rect class="f-lfm3" x="206.0" y="96.0" width="369.7" height="9" rx="3"/>
<text class="val" x="580.7" y="104.0">79.0</text>
<rect class="f-compass" x="206.0" y="108.0" width="301.9" height="9" rx="3"/>
<text class="val" x="512.9" y="116.0">64.5</text>
<text class="lab" x="0" y="143.5">Non-semantic text</text>
<rect class="f-lfm3" x="206.0" y="129.0" width="411.8" height="9" rx="3"/>
<text class="val" x="622.8" y="137.0">88.0</text>
<rect class="f-compass" x="206.0" y="141.0" width="365.0" height="9" rx="3"/>
<text class="val" x="576.0" y="149.0">78.0</text>
<text class="lab" x="0" y="176.5">Handwriting</text>
<rect class="f-lfm3" x="206.0" y="162.0" width="374.4" height="9" rx="3"/>
<text class="val" x="585.4" y="170.0">80.0</text>
<rect class="f-compass" x="206.0" y="174.0" width="337.0" height="9" rx="3"/>
<text class="val" x="548.0" y="182.0">72.0</text>
<text class="lab" x="0" y="209.5">Regular text</text>
<rect class="f-lfm3" x="206.0" y="195.0" width="449.3" height="9" rx="3"/>
<text class="val" x="660.3" y="203.0">96.0</text>
<rect class="f-compass" x="206.0" y="207.0" width="421.2" height="9" rx="3"/>
<text class="val" x="632.2" y="215.0">90.0</text>
<text class="lab" x="0" y="242.5">Irregular text</text>
<rect class="f-lfm3" x="206.0" y="228.0" width="421.2" height="9" rx="3"/>
<text class="val" x="632.2" y="236.0">90.0</text>
<rect class="f-compass" x="206.0" y="240.0" width="421.2" height="9" rx="3"/>
<text class="val" x="632.2" y="248.0">90.0</text>
<text class="lab" x="0" y="275.5">Scene-text questions</text>
<rect class="f-lfm3" x="206.0" y="261.0" width="386.1" height="9" rx="3"/>
<text class="val" x="597.1" y="269.0">82.5</text>
<rect class="f-compass" x="206.0" y="273.0" width="386.1" height="9" rx="3"/>
<text class="val" x="597.1" y="281.0">82.5</text>
<text class="lab" x="0" y="308.5">Digit strings</text>
<rect class="f-lfm3" x="206.0" y="294.0" width="402.5" height="9" rx="3"/>
<text class="val" x="613.5" y="302.0">86.0</text>
<rect class="f-compass" x="206.0" y="306.0" width="411.8" height="9" rx="3"/>
<text class="val" x="622.8" y="314.0">88.0</text>
<text class="lab" x="0" y="341.5">Artistic text</text>
<rect class="f-lfm3" x="206.0" y="327.0" width="393.1" height="9" rx="3"/>
<text class="val" x="604.1" y="335.0">84.0</text>
<rect class="f-compass" x="206.0" y="339.0" width="430.6" height="9" rx="3"/>
<text class="val" x="641.6" y="347.0">92.0</text>
<text class="grp" x="0" y="374">ChartQA</text>
<text class="lab" x="0" y="398.5">Machine-generated questions</text>
<rect class="f-lfm3" x="206.0" y="384.0" width="440.9" height="9" rx="3"/>
<text class="val" x="651.9" y="392.0">94.2</text>
<rect class="f-compass" x="206.0" y="396.0" width="348.2" height="9" rx="3"/>
<text class="val" x="559.2" y="404.0">74.4</text>
<text class="lab" x="0" y="431.5">Human-written questions</text>
<rect class="f-lfm3" x="206.0" y="417.0" width="326.7" height="9" rx="3"/>
<text class="val" x="537.7" y="425.0">69.8</text>
<rect class="f-compass" x="206.0" y="429.0" width="265.8" height="9" rx="3"/>
<text class="val" x="476.8" y="437.0">56.8</text>
<text class="grp" x="0" y="464">V* Bench</text>
<text class="lab" x="0" y="488.5">Object attributes</text>
<rect class="f-lfm3" x="206.0" y="474.0" width="386.6" height="9" rx="3"/>
<text class="val" x="597.6" y="482.0">82.6</text>
<rect class="f-compass" x="206.0" y="486.0" width="313.6" height="9" rx="3"/>
<text class="val" x="524.6" y="494.0">67.0</text>
<text class="lab" x="0" y="521.5">Relative position</text>
<rect class="f-lfm3" x="206.0" y="507.0" width="351.0" height="9" rx="3"/>
<text class="val" x="562.0" y="515.0">75.0</text>
<rect class="f-compass" x="206.0" y="519.0" width="295.8" height="9" rx="3"/>
<text class="val" x="506.8" y="527.0">63.2</text>
</svg>
</div>
</figure>

<figure class="bench-fig" id="chart-decisions">
<h3>D. d1-2B in decision mode</h3>
<figcaption>Liquid's decision model next to both chat models on the same tasks, out of 100.</figcaption>
<div class="bench-legend"><span><i class="d1"></i>d1-2B (decision mode)</span><span><i class="lfm3"></i>LFM3-VL-2B</span><span><i class="compass"></i>Compass VLD Tiny v5</span></div>
<div class="bench-scroll">
<svg viewBox="0 0 720 240" role="img" aria-label="d1-2B in decision mode next to LFM3-VL-2B and Compass v5 in chat mode" xmlns="http://www.w3.org/2000/svg"><title>d1-2B in decision mode next to LFM3-VL-2B and Compass v5 in chat mode</title>
<line class="grid" x1="118.0" x2="118.0" y1="6" y2="214"/>
<text class="tick" x="118.0" y="232" text-anchor="middle">0</text>
<line class="grid" x1="257.0" x2="257.0" y1="6" y2="214"/>
<text class="tick" x="257.0" y="232" text-anchor="middle">25</text>
<line class="grid" x1="396.0" x2="396.0" y1="6" y2="214"/>
<text class="tick" x="396.0" y="232" text-anchor="middle">50</text>
<line class="grid" x1="535.0" x2="535.0" y1="6" y2="214"/>
<text class="tick" x="535.0" y="232" text-anchor="middle">75</text>
<line class="grid" x1="674.0" x2="674.0" y1="6" y2="214"/>
<text class="tick" x="674.0" y="232" text-anchor="middle">100</text>
<text class="lab" x="0" y="28.0">MMVP</text>
<rect class="f-d1" x="118.0" y="6.0" width="448.7" height="10" rx="3"/>
<text class="val" x="571.7" y="15.0">80.7</text>
<rect class="f-lfm3" x="118.0" y="19.0" width="418.7" height="10" rx="3"/>
<text class="val" x="541.7" y="28.0">75.3</text>
<rect class="f-compass" x="118.0" y="32.0" width="409.8" height="10" rx="3"/>
<text class="val" x="532.8" y="41.0">73.7</text>
<text class="lab" x="0" y="80.0">V* Bench</text>
<rect class="f-d1" x="118.0" y="58.0" width="459.8" height="10" rx="3"/>
<text class="val" x="582.8" y="67.0">82.7</text>
<rect class="f-lfm3" x="118.0" y="71.0" width="442.6" height="10" rx="3"/>
<text class="val" x="565.6" y="80.0">79.6</text>
<rect class="f-compass" x="118.0" y="84.0" width="363.6" height="10" rx="3"/>
<text class="val" x="486.6" y="93.0">65.4</text>
<text class="lab" x="0" y="132.0">MMLU-Pro</text>
<rect class="f-d1" x="118.0" y="110.0" width="177.9" height="10" rx="3"/>
<text class="val" x="300.9" y="119.0">32.0</text>
<rect class="f-lfm3" x="118.0" y="123.0" width="259.7" height="10" rx="3"/>
<text class="val" x="382.7" y="132.0">46.7</text>
<rect class="f-compass" x="118.0" y="136.0" width="127.9" height="10" rx="3"/>
<text class="val" x="250.9" y="145.0">23.0</text>
<text class="lab" x="0" y="184.0">BANKING77</text>
<rect class="f-d1" x="118.0" y="162.0" width="481.5" height="10" rx="3"/>
<text class="val" x="604.5" y="171.0">86.6</text>
<rect class="f-lfm3" x="118.0" y="175.0" width="211.3" height="10" rx="3"/>
<text class="val" x="334.3" y="184.0">38.0</text>
<rect class="f-compass" x="118.0" y="188.0" width="175.7" height="10" rx="3"/>
<text class="val" x="298.7" y="197.0">31.6</text>
</svg>
</div>
</figure>

Tags: #WebBrain #LFM3 #LiquidAI #CompassVLD #MiniCPM #BenchKit #VisionLanguage #DecisionModels #llamacpp #RunPod
