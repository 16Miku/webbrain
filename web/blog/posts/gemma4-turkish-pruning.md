---
title: >
  Pruning Gemma 4 26B-A4B to run on small GPUs
slug: gemma4-turkish-pruning
sortOrder: 30
date: 2026-05-19
readTime: 4 min read
description: >
  A practical Gemma 4 26B-A4B expert-pruning run: remove low-activation experts for Turkish+English workloads, then recover quality with a short LoRA heal.
excerpt: >
  Router hooks + expert activation telemetry + surgical long-tail removal + brief LoRA heal. Early run: 128→101 experts/layer, 26B→21B params, ~11 GB at 4-bit GGUF, with solid Turkish fluency and code performance.
cardTitle: >
  Pruning Gemma 4 26B-A4B for small GPUs: Turkish-first, language-agnostic MoE surgery
titleTag: >
  Pruning Gemma 4 26B-A4B for Small GPUs: Turkish-First, Language-Agnostic — WebBrain Blog
ogTitle: >
  Pruning Gemma 4 26B-A4B for Small GPUs
ogDescription: >
  128→101 experts/layer, 26B→21B params, ~11 GB 4-bit GGUF. Router hooks + long-tail expert removal + brief LoRA heal.
twitterTitle: >
  Pruning Gemma 4 26B-A4B for Small GPUs
twitterDescription: >
  Turkish-first PoC, language-agnostic method: router telemetry, surgical expert pruning, short LoRA recovery.
keywords:
  - Gemma 4
  - MoE pruning
  - expert pruning
  - Turkish LLM
  - GGUF
  - IQ4_XS
  - LoRA
  - small GPU
  - WebBrain
html: true
lede: >
  I’m pruning Google’s Gemma 4 26B-A4B for a Turkish + English deployment. The proof of concept is Turkish-first, but the method is language-agnostic: measure which experts are actually used, remove the long tail, then do a short LoRA heal to recover from the cuts.
---

## Why this works on MoE models

MoE models develop implicit specialization. In practice, Gemma 4 experts quietly separate across scripts and patterns: CJK characters, Cyrillic, Devanagari, Arabic script, Hangul, and more. For Turkish + English workloads, a meaningful subset of experts barely activates.

## Method

- Hook the routers and collect per-expert activation stats on Turkish + code + math + web-heavy data.
- Surgically prune low-utility long-tail experts at the layer level.
- Run a brief LoRA heal on Turkish instruction data so the model adapts to the reduced expert set.

## Early results

<div class="callout">
<ul>
        <li><strong>128 → 101</strong> experts per layer</li>
        <li><strong>26B → 21B</strong> parameters (~<strong>21%</strong> smaller)</li>
        <li>4-bit GGUF size: ~<strong>11 GB</strong></li>
        <li>Fits <strong>24 GB</strong> GPUs; possible on <strong>12 GB</strong> with <strong>IQ4_XS</strong></li>
        <li>Turkish fluency + code + general knowledge remain solid in practical checks</li>
      </ul>
</div>

## Why prune + heal instead of retrain or plain finetune?

**Pretraining from scratch** takes months and large budgets, and throws away Gemma’s pretraining value. **Finetuning only** keeps the full heavyweight model. **Prune + heal** preserves the valuable base and removes what this deployment does not use.

## Why this matters next

Even if VRAM gets cheaper, we still want specialized smaller models running side by side (planner, vision, coder). Pruning is the right operational tool: start from a strong base, keep only what serves the job.

Model link: [huggingface.co/esokullu/gemma4-tr-26b-a4b-pruned-gguf](https://huggingface.co/esokullu/gemma4-tr-26b-a4b-pruned-gguf)

Tags: #LLM #MoE #Pruning
