---
title: >
  Tiny Vision Models Compared: LFM 2.5 VL vs Qwen 3.5 0.8B
slug: tiny-vision-models-qwen38-reference
sortOrder: -220
date: 2026-08-21
readTime: 7 min read
description: >
  Qwen 3.8 27B set a strong 74/100 reference in WebBrain's 100-case browser-vision benchmark. We compare it with Qwen 3.5 0.8B and Liquid AI's 450M and 1.6B local VLMs—and explain why a weak benchmark score can still describe a useful fallback.
excerpt: >
  Qwen 3.8 27B is clearly better. The surprise is that Qwen 3.5 0.8B and tiny LFM2.5-VL models can still recover useful browser state, especially when vision is a local fallback rather than the whole agent.
titleTag: >
  Tiny Vision Models Compared: LFM 2.5 VL vs Qwen 3.5 0.8B - WebBrain Blog
ogTitle: >
  Tiny Vision Models Compared: LFM 2.5 VL vs Qwen 3.5 0.8B
ogDescription: >
  A strict 100-case WebBrain vision benchmark puts Qwen 3.8 27B far ahead, while showing where sub-2B local models can still earn a place in a browser agent.
twitterTitle: >
  Tiny Vision Models Compared: LFM 2.5 VL vs Qwen 3.5 0.8B
twitterDescription: >
  Qwen 3.8 27B scored 74/100. Qwen 3.5 0.8B scored 20. Tiny LFM2.5-VL models scored lower—but fallback vision is a different product problem.
keywords:
  - WebBrain
  - Qwen 3.8 27B
  - Qwen 3.5 0.8B
  - LFM2.5-VL-450M
  - LFM2.5-VL-1.6B
  - local vision model
  - WebGPU
  - browser agent
  - Apocalypse Mode
  - vision benchmark
author: Emre Sokullu
authorUrl: https://emresokullu.com
lede: >
  **Small vision models are not substitutes for a frontier API or a strong local model such as Qwen 3.8 27B.** Our new 100-case benchmark makes that obvious. It also shows something more useful: a tiny model can still be good enough when vision is an occasional local fallback, not the brain responsible for the entire browser session.
---

## The result at a glance

We built a new 100-case suite around the exact screenshot-description call WebBrain uses for `inspect_viewport`, screenshot tools, and automatic screenshot routing. The [complete benchmark—images, rubrics, validation, and runner—is available on GitHub](https://github.com/webbrain-one/webbrain/tree/main/test/vision). The cases progress from large, obvious controls to dense tables, charts, multilingual OCR, overlays, conflicting signals, occlusion, and deliberately unreadable text.

[Qwen 3.8 27B NVFP4](https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4) is the main reference. It is the result to compare the small models against, not a claim that every 27B deployment or every API will produce the same number.

| Model | Parameters | Passed | Mean rubric score | Reading |
| --- | ---: | ---: | ---: | --- |
| **Qwen 3.8 27B NVFP4** | 27B | **74/100** | **93.2%** | Strong local reference |
| **[Qwen 3.5 0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B)** | 0.8B | **20/100** | 41.6% | Unexpectedly capable tiny candidate |
| **[LFM2.5-VL-1.6B](https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B)** | 1.6B | **12/100** | **44.4%** | Better partial coverage, lower strict pass rate |
| **[LFM2.5-VL-450M](https://huggingface.co/LiquidAI/LFM2.5-VL-450M)** | 450M | **1/100** | 21.6% | Very small fallback, not a general VLM replacement |

We are deliberately not comparing latency here. Qwen 3.8 27B ran as NVFP4 through vLLM on a remote GPU; Qwen 3.5 0.8B ran through LM Studio; the LFM rows used MLX. Those are different machines, quantizations, and inference stacks. The quality comparison is still useful because every row received the same 100 images, the same production prompt, and the same deterministic grader. The speed numbers would not be a controlled model comparison.

## What “passed” means

This is not a general image-captioning leaderboard. It tests one narrow but important browser-agent contract.

For each 1280×720 viewport, the model must return six structured sections: page purpose, exact visible text, inputs, state signals, blockers, and unknowns. The grader checks weighted facts and marks critical errors. A fluent answer does not pass if it misses the blocking modal, changes an exact button label, associates a status with the wrong table row, or confidently guesses text that is intentionally unreadable.

That strictness explains why the mean rubric score matters next to the binary pass rate. LFM2.5-VL-450M passed only one case, but its 21.6% mean score shows that it still extracted pieces of useful evidence. LFM2.5-VL-1.6B had a slightly higher mean score than Qwen 3.5 0.8B, yet Qwen crossed the full success threshold more often. Qwen's useful facts were more concentrated into complete answers; the 1.6B LFM spread more partial credit across the suite.

## Qwen 3.8 27B is the clear reference

Qwen 3.8 27B passed 74 cases and maintained a 93.2% mean rubric score. More importantly, it stayed useful as the suite became harder: 85% on easy cases, 80% on both basic and intermediate cases, 70% on advanced cases, and 55% on the challenging final fifth.

It swept several browser-relevant categories: dashboards, charts, data tables, kanban boards, toast notifications, consent banners, ordinary photos, and low-contrast or occluded content. That breadth is what a primary local vision model should look like. It does not merely read large text; it preserves relationships and state across different interface types.

If you can run Qwen 3.8 27B locally, it is the obvious choice among these four. A strong frontier vision API is also a reasonable choice when local hardware, setup time, or model storage matters more than keeping screenshots on the device.

## Qwen 3.5 0.8B is the surprise

The interesting small-model result is Qwen 3.5 0.8B. Twenty passes out of 100 is nowhere near the 27B reference, but it is remarkable for a model below one billion parameters.

Its capability was not evenly distributed. It passed all five data-table cases, four of five photo-understanding cases, and three of five map-and-travel cases. It was much less reliable on authentication, checkout, modals, consent, email, kanban, multilingual OCR, and uncertainty calibration.

That profile makes it a candidate for targeted routing, not a universal vision backend. If WebBrain already knows that the current task is row extraction, a simple photo, or a map, the 0.8B model may provide surprisingly good evidence. If the task depends on a transient error, a blocker, or exact small UI text, the benchmark says not to trust it alone.

We have not bundled Qwen 3.5 0.8B into WebBrain's WebGPU path yet. Serving it through LM Studio or vLLM is straightforward, but integrating its full multimodal stack into the browser runtime is a different engineering problem. The result is strong enough that we think it is worth exploring.

## The LFM results are a baseline, not a ceiling

The raw LFM2.5-VL numbers are modest. The 1.6B model passed 12 cases; the 450M model passed one. The larger LFM was most useful on photos, tables, kanban boards, and maps. The 450M checkpoint frequently recovered some visible text or broad page state but failed the full contract, especially exact labels, blockers, and uncertainty.

We should be candid about that. LFM2.5-VL-450M is not close to Qwen 3.8 27B, and this run does not justify treating it as a general replacement for a frontier VLM.

It also is not the end of the LFM story. Liquid AI explicitly recommends use-case fine-tuning for both the 450M and 1.6B checkpoints and publishes supervised fine-tuning paths. We tested the off-the-shelf models. We have not yet fine-tuned them on WebBrain's screenshot format, control states, exact-label discipline, blocker detection, or “do not guess” behavior.

That makes these results a useful before-picture. A WebBrain-specific training set could directly target the failures this benchmark exposes. Fine-tuning is not a guarantee, and any improvement would have to survive the same held-out suite, but the LFM family is unusually practical for this experiment because the checkpoints are small and explicitly intended for adaptation.

## Why WebBrain still ships the 450M fallback

WebBrain does not ask the vision model to run the whole agent. The main planner still chooses tools, reasons over history, and decides what to do next. Most browser state can often be recovered from the URL, page text, DOM, accessibility tree, and tool results. Vision enters when those sources are incomplete: canvases, charts, selected states, visual blockers, broken semantics, or a screenshot after an important state change.

That means the local vision model is used relatively rarely. Its job is to add visual evidence when the ordinary browser-reading path is not enough.

For that role, LFM2.5-VL-450M has three product advantages even when its strict benchmark score is weak:

- **It is small enough for an in-browser fallback.** WebBrain's ONNX package is about 770 MB and runs through WebGPU on supported Chromium systems.
- **Screenshots can stay on the device.** The visual observation becomes text context for the selected planner instead of requiring a remote image upload.
- **It shares a family with WebBrain's offline text stack.** [Apocalypse Mode](/blog/why-we-built-apocalypse-mode) uses LFM2.5 2.6B for local text generation and can augment it with offline retrieval from installed Wikipedia and document indexes. The 450M vision sidecar gives that resilient local stack a compact set of eyes.

In an offline or degraded-network scenario, the comparison is not always “450M versus the best API.” It may be “450M versus no visual model at all.” The benchmark tells us to keep its claims narrow and its outputs corroborated; it does not tell us that the fallback has no value.

## A practical split stack

Our preferred architecture remains modular:

1. Use **Qwen 3.8 27B locally** if you have the hardware and want a strong private multimodal reference.
2. Use a **frontier vision API** if you prefer managed quality and accept the provider's image-data path.
3. Or pair an inexpensive text-only planner—such as [Laguna S 2.1 through OpenRouter](/blog/poolside-laguna-s-openrouter-planner-benchmark)—with WebBrain's local LFM2.5-VL-450M fallback.

The third option is easy to underestimate. A browser agent does not need to purchase an image-capable call for every planning turn when only a minority of states require pixel inspection. A cheap text model can run the main loop; the local sidecar can fill the visual gap only when necessary.

WebBrain is also working on larger model-specific vision paths. Experimental checkpoints for [Laguna XS 2.1 Vision](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-NVFP4) and [DeepSeek V4 Flash Vision](https://huggingface.co/webbrain-one/DeepSeek-V4-Flash-Vision-NVFP4) are available on our Hugging Face page. Those projects aim to make strong text-first models natively useful on screenshots rather than relying forever on a separate tiny captioner.

The current Bonsai 27B option is separate from this comparison. It is a beta, text-only path for WebBrain's local stack, so it does not replace the vision fallback and does not belong in this vision table.

## Bottom line

Small models do not replace frontier APIs or a new local model such as Qwen 3.8 27B. They are not supposed to.

Qwen 3.8 27B is the clear quality choice in this run. Qwen 3.5 0.8B is the most surprising small model and deserves more work, especially if we can make its browser/WebGPU integration practical. LFM2.5-VL-1.6B is a useful adaptation target. LFM2.5-VL-450M has a poor strict success rate today, but it remains small, private, available offline, and capable of recovering partial visual evidence when WebBrain's normal page-reading tools are not enough.

That is what “it works” means here. Not that a 450M model becomes a 27B model, and not that one lucky caption makes it trustworthy. It means the system can reserve expensive or heavyweight vision for the cases that need it, keep a compact fallback on the device, corroborate its observations with browser-native evidence, and improve the small checkpoint through task-specific fine-tuning over time.

Tags: #WebBrain #Qwen38 #Qwen35 #LFM25VL #WebGPU #LocalAI #VisionLanguageModel #BrowserAgent #ApocalypseMode
