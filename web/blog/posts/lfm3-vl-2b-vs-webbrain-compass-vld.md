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
- **Hardware and cost:** one RTX A4000 16 GB on RunPod community cloud at $0.17 an hour. The whole session took 121 minutes, including two llama.cpp builds, the conversion, the d1-2B run further down and some idle time at the end: about **$0.34**, against a budget of $0.50.
- **A check on the port:** LFM3's thinking-off scores land within about a point of Liquid's own model card: V* 79.6 vs 80.6, OCRBench 81.5 vs 82.2, ChartQA 82.0 vs 81.4. The pre-release llama.cpp support behaves.

Both models answered identical tasks, so we compare them task by task. The table gives the paired difference with its 95% interval, and a suite counts as a win only when that interval stays on one side of zero.

## Results

| Suite | Tasks | LFM3-VL-2B | Compass v5 | Difference (95% interval) | Verdict |
| --- | ---: | ---: | ---: | --- | --- |
| MMVP | 300 | 75.3 | 73.7 | +1.7 (−3.8 to +7.2) | too close |
| V* Bench | 191 | 79.6 | 65.4 | +14.1 (+6.0 to +22.3) | LFM3 |
| OCRBench | 1,000 | 81.5 | 72.6 | +8.9 (+6.1 to +11.7) | LFM3 |
| ChartQA | 1,000 | 82.0 | 65.6 | +16.4 (+13.5 to +19.3) | LFM3 |
| Sanity | 25 | 64.0 | 48.0 | +16.0 (−8.5 to +40.5) | too close |
| IFEval | 541 | 69.5 | 54.9 | +14.6 (+9.9 to +19.3) | LFM3 |
| GSM8K | 500 | 68.2 | 70.6 | −2.4 (−7.4 to +2.6) | too close |
| MMLU-Pro | 300 | 46.7 | 23.0 | +23.7 (+17.1 to +30.2) | LFM3 |
| BANKING77 | 1,000 | 38.0 | 31.6 | +6.4 (+3.3 to +9.5) | LFM3 |

**LFM3-VL-2B wins six of nine suites, three are too close to call, and Compass wins none.**

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

| Suite | d1-2B (decision) | LFM3-VL-2B (chat) | Compass v5 (chat) | Calibration error | Median latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| MMVP | 80.7 | 75.3 | 73.7 | 0.045 | 119 ms |
| V* Bench | 82.7 | 79.6 | 65.4 | 0.073 | 1,930 ms |
| BANKING77 | 86.6 | 38.0 | 31.6 | 0.058 | 186 ms |
| MMLU-Pro | 32.0 | 46.7 | 23.0 | 0.048 | 130 ms |

Picking among listed options is what d1 is built for, and it shows. On BANKING77 the chat models have to write one of 77 intent names exactly, while d1 only has to pick one. Its probabilities are well calibrated, and a decision takes 120 to 190 milliseconds on the A4000, about 1.9 seconds on V*'s large images. It loses to chat LFM3 on MMLU-Pro, where writing out the reasoning helps.

BenchKit can't put Compass in decision mode, because llama.cpp only serves native decision architectures through that endpoint. Compass's decision numbers come from our own d1 test above.

## What we take from it

LFM3-VL-2B is a clearly stronger base than MiniCPM-V-4.7-1B on general vision and text, for about a quarter more parameters and roughly 60% of the decode speed. Compass's edge is that it already folds decisions into the same model, which Liquid's lineup doesn't.

So the next step is to merge the two ideas: **an LFM3-based VLD**, LFM3-VL-2B fine-tuned with the Compass recipe (our screenshot data, the Compass text release and d1 decision data). We'll look into it, and if it holds up on our own decision, grounding and routing tests and runs fast enough in the browser, we expect to make it WebBrain's default on-device model once it's fine-tuned. Liquid already publishes an ONNX build of LFM3-VL-2B, which helps with the WebGPU path.

In the meantime, LFM3-VL-2B already works in WebBrain as a local model through llama.cpp.

Tags: #WebBrain #LFM3 #LiquidAI #CompassVLD #MiniCPM #BenchKit #VisionLanguage #DecisionModels #llamacpp #RunPod
