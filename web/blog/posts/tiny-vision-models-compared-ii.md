---
title: >
  Tiny Vision Models Compared II: WebBrain, Gemma 4, and Larger Qwen 3.5 Models Join the Race
slug: tiny-vision-models-compared-ii
sortOrder: -240
date: 2026-08-22
readTime: 8 min read
description: >
  WebBrain VL 2 450M joins our 100-case browser-vision benchmark alongside Qwen 3.5 2B and 4B and Gemma 4 E4B, with the earlier Qwen and LFM baselines retained for context.
excerpt: >
  A browser-specific 450M fine-tune reaches the same strict-pass band as Qwen 3.5 2B and Gemma 4 E4B while remaining small enough for WebGPU. It will become WebBrain's default local vision model.
titleTag: >
  Tiny Vision Models Compared II: WebBrain vs Qwen 3.5 and Gemma 4 - WebBrain Blog
ogTitle: >
  Tiny Vision Models Compared II: WebBrain joins Qwen and Gemma
ogDescription: >
  WebBrain VL 2 450M reaches 44 strict passes in a 100-case browser benchmark, close to Qwen 3.5 2B and Gemma 4 E4B with far fewer parameters.
twitterTitle: >
  WebBrain VL 2 450M joins the tiny vision race
twitterDescription: >
  44/100 strict passes in WebBrain's browser-vision suite: similar to Qwen 3.5 2B and Gemma 4 E4B with roughly one-quarter to one-ninth as many parameters.
keywords:
  - WebBrain VL 2 450M
  - WebBrain
  - Qwen 3.5 4B
  - Qwen 3.5 2B
  - Qwen 3.5 0.8B
  - Gemma 4 E4B
  - LFM2.5-VL
  - WebGPU
  - browser vision
  - vision-language model
author: Emre Sokullu
authorUrl: https://emresokullu.com
lede: >
  **A 450M model trained for one narrow job can compete with much larger general-purpose vision models on that job.** WebBrain VL 2 450M passed 44 of our 100 browser-vision cases in its deployed ONNX/WebGPU configuration. Qwen 3.5 2B passed 39 and Gemma 4 E4B passed 41. Their mean rubric scores remain higher, so this is not a claim that 450M broadly beats either model. It is evidence that task-specific fine-tuning can move a genuinely tiny model into the same useful browser-observation band.
---

## The expanded table

Our [first tiny-vision comparison](/blog/tiny-vision-models-qwen38-reference/) established the baseline: the off-the-shelf LFM2.5-VL models were compact but weak under WebBrain's exact screenshot contract, while Qwen 3.5 0.8B was unexpectedly capable for its size.

This follow-up adds four rows: **[WebBrain VL 2 450M](https://huggingface.co/webbrain-one/webbrain-vl-2-450M)**, **[Qwen 3.5 2B](https://huggingface.co/Qwen/Qwen3.5-2B)**, **[Qwen 3.5 4B](https://huggingface.co/Qwen/Qwen3.5-4B)**, and **[Gemma 4 E4B IT](https://huggingface.co/google/gemma-4-E4B-it)**. Every model saw the same 100 screenshots, the same production six-section prompt, and the same deterministic rubric.

![Strict-pass results for webbrain-vl-2, three Qwen 3.5 sizes, gemma4-e4b, and lfm-2.5-vl-1.6b](/assets/browser-vision-benchmark-strict-passes.png)

*One benchmark, one production prompt, and 100 held-out browser screenshots. A strict pass requires the complete six-section observation contract.*

| Model | Parameter class | Strict passes | Mean rubric | Errors | Reading |
| --- | ---: | ---: | ---: | ---: | --- |
| **[Qwen 3.5 4B](https://huggingface.co/Qwen/Qwen3.5-4B)**, MLX | 4B | **55/100** | **83.4%** | 0 | Strongest model in this small-model table |
| **[WebBrain VL 2 450M](https://huggingface.co/webbrain-one/webbrain-vl-2-450M)**, deployed ONNX | **453M** | **44/100** | 76.2% | 0 | Best strict-pass efficiency; WebGPU-ready |
| **[Gemma 4 E4B IT](https://huggingface.co/google/gemma-4-E4B-it)**, MLX | E4B | 41/100 | 81.3% | 0 | Better partial coverage, three fewer full passes |
| **[Qwen 3.5 2B](https://huggingface.co/Qwen/Qwen3.5-2B)**, MLX | 2B | 39/100 | 79.1% | 0 | Similar overall browser-observation band |
| **[Qwen 3.5 0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B)** | 0.8B | 20/100 | 41.6% | 0 | Strong off-the-shelf sub-1B baseline |
| **[LFM2.5-VL-1.6B](https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B)**, MLX | 1.6B | 12/100 | 44.4% | 0 | Partial evidence more often than complete answers |
| **[LFM2.5-VL-450M](https://huggingface.co/LiquidAI/LFM2.5-VL-450M)**, MLX | 450M | 1/100 | 21.6% | 0 | The off-the-shelf starting point |

The complete [benchmark source, screenshots, expected facts, scoring code, and committed result files are on GitHub](https://github.com/esokullu/webbrain/tree/main/test/vision).

We intentionally leave LFM2.5-VL-3B out of this comparison. Its run did not follow the numbered six-section output contract reliably, so including it in a compact-model leaderboard would mostly measure formatting failure rather than useful visual understanding. We discuss that result separately in the fine-tuning story.

## Strict pass and mean rubric measure different things

A strict pass is a complete answer under WebBrain's production contract. The model must return six numbered sections covering page purpose, exact visible text, inputs, state signals, blockers, and unknowns. It must recover the weighted facts for that case without a critical contradiction or confident guess.

The mean rubric score gives partial credit. A model can correctly read a page title, two controls, and an error message yet fail the case because it missed the modal blocking the entire viewport. That answer contributes to the mean score but not to the strict-pass count.

This is why the middle three rows need careful language:

- WebBrain V2 has **more complete passes** than Gemma E4B and Qwen 2B.
- Gemma and Qwen have **higher average rubric scores**, meaning they recover more of the expected evidence across all 100 cases.
- The fair conclusion is that all three occupy a similar task-performance band—not that the 450M model is universally better.

## What fine-tuning bought

WebBrain V2 uses the same 452,847,616-parameter LFM2.5-VL-450M foundation as the one-pass base row. Only 4,128,768 LoRA parameters—about 0.91% of the model—were trainable. The merged checkpoint does not become a multi-billion-parameter model after training; it remains a 453M model whose behavior has been redirected toward browser screenshots and WebBrain's response contract.

The deployed package uses FP16 embeddings and vision encoder weights with a symmetric-Q4 merged decoder. Its complete browser package is about **0.81 GB**. For scale, the local artifacts used in the new comparison were approximately 1.75 GB for Qwen 2B MLX 4-bit, 3.06 GB for Qwen 4B MLX 4-bit, and 6.86 GB for Gemma E4B MLX 4-bit. Those byte counts are not perfectly interchangeable—WebBrain uses ONNX while the other rows use MLX—but they describe the practical download and storage difference.

By nominal parameter count, WebBrain V2 has roughly **one-quarter as many parameters as Qwen 2B** and **one-ninth as many as Gemma E4B**. That is the efficiency result worth celebrating.

![Performance-versus-parameter scatter plot for webbrain-vl-2, Qwen 3.5, gemma4-e4b, and lfm-2.5-vl-1.6b](/assets/browser-vision-model-size.png)

*With parameters on X and strict passes on Y, WebBrain V2 is the clear upper-left efficiency outlier. Gemma's E4B label denotes its effective 4B class.*

## Qwen 4B still leads this table

Qwen 3.5 4B is the strongest row among the models collected here: 55 strict passes and an 83.4% mean rubric score. Its advantage persists into harder cases, and it is more reliable on multilingual OCR than the smaller rows.

If your deployment can comfortably host it, Qwen 4B is the higher-quality general-purpose choice in this group. The WebBrain result addresses a different constraint: how much browser-specific vision can fit into an extension-friendly local sidecar that runs through WebGPU.

## Why WebBrain V2 becomes the default

WebBrain normally reads the browser through structured sources first: page text, DOM state, accessibility information, URLs, and tool results. Vision is called when pixels contain information those sources missed—charts, canvas content, selected states, overlays, low-contrast labels, or a screenshot after a meaningful state change.

That architecture rewards a compact specialist. The model does not need to replace the planner or solve every multimodal problem. It needs to turn a browser viewport into reliable evidence often enough to unblock the main agent, while keeping screenshots local and the download reasonable.

For that role, V2 is a material upgrade over the raw 450M fallback:

- 44 strict passes instead of one in the comparable deployed/off-the-shelf table;
- no API or per-image token cost after download;
- a real Transformers.js/WebGPU smoke pass, not only server-side ONNX inference;
- an open-weight checkpoint, public dataset, evaluation artifacts, and release manifests.

We are therefore making **WebBrain VL 2 450M the default local vision model in WebBrain**, replacing the off-the-shelf LFM2.5-VL-450M behavior for this fallback slot. As always, the agent should corroborate high-impact visual claims before clicking, submitting, paying, or changing account state.

## The power of fine-tuning

WebBrain VL 2 450M is an open-weight tiny vision model focused on browser tasks and runnable on WebGPU. In this test it performed similarly to Qwen 3.5 2B and Gemma 4 E4B while using far fewer parameters—roughly one-quarter to one-ninth as many.

That does not shrink every vision problem to 450M parameters. It shows that a narrow production contract, a held-out benchmark, targeted data, and disciplined fine-tuning can move a small model much further than its raw checkpoint suggests.

The power of fine-tuning, actually.

Tags: #WebBrain #WebBrainVL #Qwen35 #Gemma4 #LFM25VL #WebGPU #FineTuning #BrowserAgent #LocalAI
