---
title: >
  Round 2: Nemotron Omni 30B vs Qwen 3.6 — does cheaper image tokens beat calibrated uncertainty?
slug: vision-shootout-round-2
sortOrder: 70
date: 2026-04-29
readTime: 8 min read
description: >
  A second round of vision-model benchmarking for browser agents. NVIDIA's Nemotron Omni 30B-A3B-Reasoning and the dense Qwen 3.6-27B both enter — and one of them is 17% cheaper per image. We measure what changes for a real browser-agent workload, and what doesn't.
excerpt: >
  A second round of vision-model benchmarking for browser agents. NVIDIA's Nemotron Omni 30B-A3B-Reasoning is 17% cheaper per image and classifies inputs better than Qwen 3.6-35B-A3B — but loses on calibrated uncertainty, and is English-only. Plus a head-to-head with the dense Qwen 3.6-27B that explains why MoE is the right architecture for self-hosted vision.
titleTag: >
  Round 2: Nemotron Omni 30B vs Qwen 3.6 — does cheaper image tokens beat calibrated uncertainty? — WebBrain Blog
ogTitle: >
  Round 2: Nemotron Omni 30B vs Qwen 3.6 — vision shootout for browser agents
ogDescription: >
  NVIDIA's Nemotron Omni 30B is 17% cheaper per image and classifies inputs better — but loses on the one axis that matters most for a browser agent. Plus: which model wins for non-English users.
twitterTitle: >
  Round 2: Nemotron Omni 30B vs Qwen 3.6 vision shootout
twitterDescription: >
  Cheaper image tokens vs calibrated uncertainty — and a multilingual gotcha that decides the winner.
keywords:
  - Nemotron Omni 30B
  - Qwen 3.6 35B
  - Qwen 3.6 27B
  - vision model benchmark
  - browser agent
  - MoE vision model
  - calibrated uncertainty
  - vision encoder cost
  - NVFP4
  - llama.cpp
  - vLLM
  - A3B reasoning model
html: true
lede: >
  Last week we ran a [four-way vision-model shootout](/blog/vision-model-shootout) and Qwen 3.6 35B-A3B walked away with the round. Two new contenders showed up since: NVIDIA's **Nemotron Omni 30B-A3B-Reasoning**, and the dense **Qwen 3.6-27B** for an apples-to-MoE comparison within the same model family. Nemotron has two genuine wins over Qwen — and a third axis where it loses badly. Plus a multilingual gotcha that decides the round for most readers without us touching a benchmark.
---

## The setup, again

Same probe (`test/vision-probe.mjs` in the repo), same prompt (the 6-section structured caption WebBrain's vision sub-call uses), same image (the Google sign-in screen with a focused password field, red error border, and a small email chip with a dropdown affordance). The probe sends the exact system prompt, user message, and parameters our extension's vision sub-call sends, against any OpenAI-compatible endpoint.

If you missed round 1: we tested Gemma 4-E2B, Gemma 4-31B, Qwen 3.5-27B, and Qwen 3.6-35B-A3B. Headline finding was that Qwen 3.6's MoE variant beat the dense 27B on every axis — same VRAM, better quality, lower latency. [Round 1 here](/blog/vision-model-shootout). This post adds two models on top.

## A reasoning-suppression detour, then the numbers

First test on Nemotron: **18.4 seconds**. For a 30B-A3B with 195 completion tokens, that's wrong. The probe sets `chat_template_kwargs.enable_thinking: false` — the Qwen-style gate — but Nemotron uses `think: false` instead, so our flag was being ignored. The model was reasoning silently before emitting the structured caption.

Adding both keys (`enable_thinking: false` AND `think: false` — servers ignore unknown kwargs, so packing both is harmless) brought it down to **12.0 seconds**. We also tried `/no_think` as a system-prompt prefix per NVIDIA's docs; that did essentially nothing on top of the kwarg. The probe in the repo now sends all three keys (`enable_thinking`, `think`, `thinking` for the DeepSeek family) so future reasoning models are more likely to behave without manual surgery.

Once the gate was set right, the comparison stopped being about waiting and started being about caption quality. That's where it got interesting.

## The two things Nemotron does better

### 1. It's 17% cheaper per image than Qwen 3.6-A3B

Same screenshot, prompt-token counts:

- Gemma 4-31B: **574**
- Nemotron Omni 30B: **3636**
- Qwen 3.6-35B-A3B: **4374** (+20% over Nemotron)
- Qwen 3.6-27B dense: **5570** (+53% over Nemotron)

Different vision encoder family entirely — Nemotron-3-Nano has a tighter tile budget than Qwen2.5-VL. Doesn't matter if you're running this locally on a 5090 (you're paying in prompt-eval time, not money). Matters a lot if you're pointing the dedicated vision model at a paid endpoint — Nemotron is 17–53% cheaper than the Qwen variants for the exact same input.

### 2. It actually classifies the email chip as a dropdown

The test image's email chip — `esokullu@gmail.com` with a small chevron next to it — is visually a dropdown affordance. Click it, you get an account picker. It's not a heading, link, button, tab, or menu item, even though its main contents are text.

Nemotron classified it the right way:

```
3) Inputs:
- Label: "esokullu@gmail.com", Type: dropdown, Value: "esokullu@gmail.com",
   Focused: false, Disabled: false
- Label: "Enter your password", Type: text input, Value: "",
   Focused: true, Disabled: false
```

Qwen 3.6-A3B noted the same affordance, but as *parenthetical metadata* under "visible text" rather than as a structured input:

```
2) Visible text:
- "esokullu@gmail.com" (with dropdown arrow)
```

For a planning model that has to decide whether to `click({text: "esokullu@gmail.com"})` (Qwen's framing → "click the visible text" → no defined behavior) versus `click_ax({ref_id: "..."})` on a combobox role (Nemotron's framing → click-to-toggle a picker), Nemotron's reading is the right one. It encodes the affordance directly in the place the planner looks for actionable elements.

There's a real cost to this, though: by classifying the chip as an input, Nemotron *technically violated section 2 of the prompt* ("list the EXACT strings on buttons, links, headings, tabs, and menu items"). It omitted the email from the visible-text list because it decided the chip wasn't any of those things. Defensible reading — but if downstream code does a `.includes("@")` check on §2 to find email addresses, Nemotron would silently miss it. Whether you call this a win depends on whether you trust your prompt or your model.

## The one thing Nemotron does worse — and why it matters

Section 6 of our vision prompt asks for an "Unknowns" list — text the model couldn't read clearly, ambiguous states, anything it isn't sure of. The instruction is verbatim:

> If you cannot read something clearly, say so. Do not guess numbers, names, or identifiers.

Across every model we've tested, this is the bullet that gets the least respect. Most models write "None" by default even when they had visible reasons to be unsure. Round 1's headline finding was that **Qwen 3.6-35B-A3B was the only model that actually used section 6 honestly** — it flagged the red border on the password field as ambiguous (could mean focus, could mean error), and noted that interpretation should be DOM-cross-checked.

Nemotron also wrote "Unknowns: None" — even though it had the same red-border ambiguity to flag. So did Qwen 3.6-27B dense.

For a browser agent, this is the bullet that decides everything else. An affordance misclassification is recoverable — the planner has `get_accessibility_tree` to cross-check whether something really is a combobox. An OCR misread is recoverable too — `verify_form` reads the DOM, not pixels. But **overconfidence is not recoverable.** If the vision model commits to "this is a focus indicator, not an error" and the planner takes that as ground truth, you end up acting on a hallucinated state with no signal that anything's wrong. The "Unknowns" section is the planner's escape hatch — without it, model perception becomes ground truth.

So even though Nemotron has cheaper image tokens AND better affordance classification, it loses on the one axis a browser agent values most. Two wins, one loss — but the loss is structural, the wins are nice-to-haves.

## The Nemotron downside that decides the round for most readers

**Nemotron Omni 30B is English-only.**

WebBrain users on Spanish, French, Turkish, Chinese, German, Arabic, Japanese, Korean, Russian — anyone running the agent on pages in their own language — will get unusable captions out of Nemotron. The page text comes back garbled, half-translated, or transliterated. The Qwen 3.x family is multilingual by design and handles non-English page text natively.

For an English-language agent on English-language pages with a paid vision endpoint, Nemotron's 17% token discount is a real argument. For everyone else, it isn't a real option, regardless of how cheap it is per image.

## The full table

|  | Gemma 4-E2B | Gemma 4-31B | Qwen 3.6-27B dense | Qwen 3.6-35B-A3B | Nemotron Omni 30B-A3B |
| --- | --- | --- | --- | --- | --- |
| Architecture | Dense, ~2B effective | Dense 31B | Dense 27B | MoE 35B / ~3B active | MoE 30B / ~3B active, reasoning |
| Engine tested | llama.cpp | llama.cpp | vLLM (Intel int4 AutoRound) | llama.cpp | vLLM (NVFP4) |
| Latency | <span class="win">1.5s</span> | 4.6s | 5.9s | <span class="win">5.3s</span> | <span class="lose">12.0s</span> (after reasoning fix) |
| Prompt tokens (image) | <span class="win">574</span> | <span class="win">574</span> | <span class="lose">5570</span> | 4374 | <span class="win">3636</span> |
| Email chip OCR | <span class="lose">❌</span> | <span class="lose">❌</span> (`esokullullu`) | <span class="win">✓</span> | <span class="win">✓</span> | <span class="win">✓</span> |
| All 12 visible strings | <span class="lose">5 of 12</span> | <span class="win">12</span> | <span class="win">12</span> | <span class="win">12</span> | <span class="meh">11 in §2 (email moved to §3 as input)</span> |
| Affordance classification (email chip = dropdown) | <span class="lose">missed</span> | <span class="lose">missed</span> | <span class="lose">missed</span> | <span class="meh">noted as parenthetical</span> | <span class="win">explicit <code>Type: dropdown</code></span> |
| Red error state surfaced | <span class="lose">missed</span> | text only | <span class="win">border + icon + text</span> | <span class="win">border + icon + text + ambiguity flag</span> | <span class="win">border + icon + text</span> |
| Inferred semantic blocker | <span class="lose">no</span> | no | <span class="win">yes</span> | <span class="win">yes</span> | <span class="win">yes</span> |
| Honest "Unknowns" section | <span class="lose">no</span> | <span class="lose">no</span> | <span class="lose">no</span> | <span class="win">YES — only model that did</span> | <span class="lose">no</span> |
| Multilingual | weak | partial | <span class="win">native</span> | <span class="win">native</span> | <span class="lose">English-only</span> |

## Head-to-head: Qwen 3.6-35B-A3B vs Nemotron Omni 30B-A3B

For the two A3B MoEs that are realistically competing for the dedicated-vision-model slot:

| Axis | Qwen 3.6-35B-A3B | Nemotron Omni 30B-A3B |
| --- | --- | --- |
| OCR fidelity (email, etc.) | tie | tie — both correct |
| State extraction (red border, error, focus) | tie | tie |
| Affordance classification (email chip = dropdown?) | parenthetical annotation | <span class="win">explicit <code>Type: dropdown</code> in §3 ← Nemotron ahead</span> |
| Calibrated uncertainty (§6 Unknowns) | <span class="win">✓ flagged red-border ambiguity ← Qwen ahead</span> | ❌ "None" |
| Image token cost | 4374 | <span class="win">3636 (-17%) ← Nemotron ahead</span> |
| Latency (after reasoning fix) | <span class="win">5.3s ← Qwen ahead</span> | 12.0s |
| Multilingual page text | <span class="win">native ← Qwen ahead</span> | English-only |

## Verdict for consumer devices

**Qwen 3.6-35B-A3B is still the pick**, and round 2 makes the case stronger, not weaker:

- **It's faster.** 5.3s vs Nemotron's 12s, even after fixing Nemotron's reasoning gate.
- **It's faster than its own dense sibling.** Qwen 3.6-27B dense is 5.9s — slower than the larger 35B-A3B by virtue of MoE activating only ~3B params per token. Same VRAM bracket when both are quantized comparably, but the MoE wins on inference cost.
- **It's the only model that flags uncertainty**, which a browser agent values more than any of Nemotron's nice-to-haves.
- **It's multilingual.** WebBrain has users in Spanish, Turkish, French, Chinese — Nemotron's English-only ceiling rules it out for any of them, regardless of how cheap it is per image.

Reasoning + visual + faster than the dense 27B + multilingual is a remarkable combination on a single 35B-A3B that fits on consumer hardware. The 5090 we tested on can run this comfortably; so can a 4090 with the right quant. For self-hosted browser-agent vision, this is the model to beat.

### Where Nemotron makes sense anyway

If you tick all of these:

- You're operating in English on English pages exclusively.
- You're paying a paid vision API per image token (the 17% discount actually shows up on a bill).
- You're willing to give up the calibrated-uncertainty escape hatch.
- You can engineer around Nemotron's tendency to push interactive elements out of §2 into §3.

Then Nemotron is a real argument. Otherwise, it's an interesting data point — not a default.

## Where Gemma 4 lands

Round 1 was already not kind to Gemma. Round 2 doesn't change that — both Gemma 4-E2B and Gemma 4-31B are clearly behind every Qwen and Nemotron variant on the metrics that matter for a browser agent. Gemma's main appeal is the 574 image-token count (massively cheaper than the 3636–5570 range of Qwen / Nemotron), but the OCR keeps mangling identifiers (`esokullu` → `esokullullu`, `emreillu`, etc.) and section 6 is always "None". For a browser agent that needs to act on what it reads, that's not a tradeoff — it's a non-starter. Gemma is fine for very high-level page-purpose detection if you don't need precision on names, IDs, or dollar amounts. For an agent doing real form-filling or login-screen handling, neither variant is competitive.

## What's next

We're going to keep running this probe against new models as they show up — focusing specifically on what fits on consumer GPUs (8–32 GB VRAM) at usable latency. The gap between Gemma and the rest is wide enough now that we'll probably stop including Gemma in headline tables unless something major changes there.

The other dimension we want to nail down: **quantization and inference-engine effects.** A few questions we haven't answered cleanly yet:

- Does the same model on llama.cpp vs vLLM vs LM Studio produce the same caption quality at the same prompt-token count? Or do the engines preprocess images differently and shift cost?
- How much of Gemma's `esokullullu` failure is the model and how much is the quant? Does Q8 fix it? Does FP16 fix it?
- For Qwen 3.6-35B-A3B specifically: what's the smallest quant that preserves its calibrated-uncertainty behavior? At what point does §6 collapse back to "None"?
- Is NVFP4 actually faster than int4 AutoRound on a 5090, or is it tied / behind in practice?

Those are the next posts. The probe stays where it is — small, reproducible, same prompt every time. If you want to run your own comparisons, it's three lines:

```
node test/vision-probe.mjs ./shot.png http://127.0.0.1:8080  Qwen3.6-35B-A3B
node test/vision-probe.mjs ./shot.png http://127.0.0.1:8000  nemotron-omni-30b
node test/vision-probe.mjs ./shot.png http://localhost:11434/v1  llava:13b
```

<div class="callout">
<strong>Methodology caveat.</strong> One screenshot is one data point — the same caveat as round 1. Different pages will surface different model weaknesses. The probe is the cheapest possible way to compare models on whatever pages you actually care about; if a candidate model passes on a Google login screen but fails on a Stripe dashboard, that's worth knowing before you wire it in. Run it on your own screens before committing.
</div>
