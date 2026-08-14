---
title: >
  Round 4: Qwen 3.5-9B-int4 punches above its weight — when 9B int4 beats 308B IQ3_S on affordance
slug: vision-shootout-round-4
sortOrder: 40
date: 2026-05-07
readTime: 6 min read
description: >
  Round 4 of the vision-model shootout for browser agents. A 9B int4 Qwen 3.5 model classifies the email-chip dropdown explicitly — something the 308B MiMo IQ3_S and the larger Qwen 3.6-A3B both missed. Cheapest image tokens after Gemma. The catch: it loses the red-border visual cue and joins the 'Unknowns: None' club.
excerpt: >
  A 9B int4 Qwen 3.5 on vLLM classifies the email-chip dropdown explicitly — something the 308B MiMo V2.5 at IQ3_S and the larger Qwen 3.6-35B-A3B both missed. Cheapest image tokens after Gemma. The catch: it loses the red-border visual cue and joins the "Unknowns: None" club. Suddenly the most interesting option for ≤8 GB VRAM. Plus an updated routing-policy table by VRAM bracket.
titleTag: >
  Round 4: Qwen 3.5-9B-int4 punches above its weight — when 9B int4 beats 308B IQ3_S on affordance — WebBrain Blog
ogTitle: >
  Round 4: Qwen 3.5-9B-int4 punches above its weight — affordance doesn't scale with size
ogDescription: >
  A 9B int4 model classifies the dropdown explicitly while the 308B IQ3_S misses it. What small + old + int4 actually buys you on a browser screen.
twitterTitle: >
  Round 4: Qwen 3.5-9B-int4 punches above its weight
twitterDescription: >
  9B int4 beats 308B IQ3_S on affordance classification. The size-vs-capability lens for browser-agent vision.
keywords:
  - Qwen 3.5 9B
  - AutoRound int4
  - vLLM vision
  - vision model benchmark
  - browser agent
  - affordance classification
  - MiMo V2.5 vs Qwen
  - low VRAM vision model
  - dropdown classification
  - calibrated uncertainty
  - Intel AutoRound
  - llama.cpp vs vLLM
html: true
lede: >
  Same probe, same screen, same prompt as [round 3](/blog/vision-shootout-round-3). This time: `Intel/Qwen3.5-9B-int4-AutoRound` on vLLM. Older generation than the round 1 winner, four times smaller, and aggressively quantized to int4 — yet it explicitly classifies the email-chip dropdown that MiMo V2.5 at IQ3_S (308B params!) and even Qwen 3.6-35B-A3B both missed. The affordance call doesn't scale with size. Visual cue extraction does.
---

## The setup, again

Same `test/vision-probe.mjs`, same Google sign-in screenshot at `test/fixtures/google-signin-password-error.jpg`, same 6-section structured caption prompt. This time pointed at vLLM on `localhost:8000` serving `Intel/Qwen3.5-9B-int4-AutoRound` — Intel's int4 quantization of the dense Qwen 3.5-9B-VL via AutoRound. Important framing for what follows:

- **Older.** Round 1's headline winner was Qwen 3.6-35B-A3B. This is the previous generation, 3.5 not 3.6.
- **Smaller.** 9B dense vs 35B-A3B (~3B active). About 4× fewer params.
- **Lower precision.** int4 AutoRound — meaningfully more aggressive than the GGUF Q4_K_M / FP16 variants of the larger models.
- **Different engine.** vLLM vs llama.cpp.

By any "size + recency + precision = capability" prior, this should land at the bottom of the table next to Gemma 4-E2B. It doesn't.

## The surprise: it classified the dropdown

The email chip `esokullu@gmail.com` with the small chevron is structurally a dropdown — click it, you get an account picker. Across the eight models we've now tested, only three caught this and put it in §3 as a structured input the planner can act on:

- Nemotron Omni 30B-A3B (round 2)
- Qwen 3.6-35B-A3B (round 1, but only as a parenthetical annotation under §2 — not a real §3 entry)
- **Qwen 3.5-9B-int4 (this round)**

Qwen 3.5-9B-int4's §3 entry, verbatim:

```
3) Inputs:
- Dropdown: Label "esokullu@gmail.com", value "esokullu@gmail.com",
  not focused, not disabled.
- Text field: Label "Enter your password", value "", focused,
  not disabled.
- Checkbox: Label "Show password", unchecked, not disabled.
```

Same structural framing Nemotron used. And this is a 9B int4 model. The thing the 308B MiMo at IQ3_S missed. The thing the 35B-A3B Qwen 3.6 only flagged parenthetically.

Best guess at why: the affordance call seems to hinge on the vision encoder family and the tile granularity it imposes, not the LLM head's parameter count. Qwen 3.5-9B-VL and Qwen 3.6 share lineage there; whatever in the encoder sees "chevron next to text → combobox" survives the int4 quant on the smaller model. Meanwhile MiMo's encoder produces 5557 prompt tokens for the same image and still doesn't put the chip in §3 — the encoder is doing more work and producing a worse structural read. The capability isn't where you'd expect it from the parameter count alone.

## What else it got right

- **All 12 visible strings**, verbatim, including `esokullu@gmail.com`.
- **Page purpose**: "Google account password entry screen." Terse, correct.
- **Inferred semantic blocker**: "password field is empty and marked as required." Correct framing for a planner.

## Where it slipped: the red-border visual cue

This is where the small + int4 cost shows up. Qwen 3.5-9B-int4's §4:

```
4) State signals:
- Error message: "Enter a password" displayed below the password
  input field.
- No loading spinners, toasts, modals, or other overlays.
```

No mention of the red border on the password field. No mention of the small red exclamation icon. The error message text is captured, but the visual treatment that makes the error visible at a glance — the colored border ring around the input — is missed entirely.

Compare round 1's **Qwen 3.5-27B** entry, which got border + icon + text. Same model family, three times the parameters, and the visual cues come back. This is a clean data point: **visual state extraction does scale with size and quant**, even when affordance classification doesn't. The 9B-int4 reads the structure right but misses what the colors mean.

For a browser agent this is recoverable — DOM cross-check confirms the validation state — but it's a real gap. If you were relying on the vision sub-call to flag "this form has an error" without round-tripping through the accessibility tree, the smaller model wouldn't tell you.

## The §6 result you can probably guess

Section 6 of the prompt:

> If you cannot read something clearly, say so. Do not guess numbers, names, or identifiers.

Qwen 3.5-9B-int4 wrote:

```
6) Unknowns:
- None.
```

Joins the club. We're now at five models in the "wrote None even when there was something to flag" bucket (the red border ambiguity is right there to call out — it's used for both focus and error on Material-style inputs and a planner needs to know which). Across **seven model variants from five families on three engines at three quant levels**, only Qwen 3.6-35B-A3B does §6 honestly. That's no longer a quirk — it's the central finding of the shootout series.

## The numbers

- **Image tokens: 3379** — cheapest after Gemma's 574. Beats Nemotron's 3636, well below Qwen 3.6-A3B's 4374, ~40% under MiMo IQ3_S's 5557.
- **Latency: 10.3s end-to-end** for 252 completion tokens, of which ~8 seconds is prompt-eval / TTFT and ~2.3 seconds is decode at ~110 tok/s. Slower than Qwen 3.6-A3B's 5.3s in round 2, but in a different VRAM bracket.
- **VRAM: ~6 GB** at int4 — by far the most consumer-friendly model on the table. Fits on hardware that none of the other strong contenders can touch.
- **Headers: 615 ms.** vLLM's request handling is noticeably snappier than llama.cpp's on small models — irrelevant for total latency but pleasant for interactive use.

## The full table, updated

|  | Gemma 4-E2B | Gemma 4-31B | Qwen 3.6-27B | Qwen 3.6-35B-A3B | Nemotron Omni 30B | MiMo V2.5 IQ3_S | Qwen 3.5-9B-int4 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Architecture | Dense ~2B | Dense 31B | Dense 27B | MoE 35B / ~3B active | MoE 30B / ~3B active | MoE 308B (omni) | Dense 9B |
| Engine | llama.cpp | llama.cpp | vLLM int4 | llama.cpp | vLLM NVFP4 | llama.cpp IQ3_S | vLLM int4 AR |
| Latency | <span class="win">1.5s</span> | 4.6s | 5.9s | <span class="win">5.3s</span> | 12.0s | <span class="lose">61s / 209t</span> | 10.3s / 252t |
| Prompt tokens (image) | <span class="win">574</span> | <span class="win">574</span> | <span class="lose">5570</span> | 4374 | 3636 | <span class="lose">5557</span> | <span class="win">3379</span> |
| Email chip OCR | <span class="lose">❌</span> | <span class="lose">❌</span> | <span class="win">✓</span> | <span class="win">✓</span> | <span class="win">✓</span> | <span class="win">✓</span> | <span class="win">✓</span> |
| All 12 visible strings | <span class="lose">5/12</span> | <span class="win">12</span> | <span class="win">12</span> | <span class="win">12</span> | <span class="meh">11 (email moved to §3)</span> | <span class="win">12</span> | <span class="win">12</span> |
| Affordance: chip = dropdown | <span class="lose">missed</span> | <span class="lose">missed</span> | <span class="lose">missed</span> | <span class="meh">parenthetical</span> | <span class="win">explicit</span> | <span class="lose">missed</span> | <span class="win">explicit</span> |
| Red error state | <span class="lose">missed</span> | text only | <span class="win">border + icon + text</span> | <span class="win">border + icon + text + flag</span> | <span class="win">border + icon + text</span> | <span class="win">border + icon + text</span> | <span class="meh">text only</span> |
| Inferred blocker | <span class="lose">no</span> | no | <span class="win">yes</span> | <span class="win">yes</span> | <span class="win">yes</span> | <span class="win">yes</span> | <span class="win">yes</span> |
| Honest "Unknowns" §6 | <span class="lose">no</span> | <span class="lose">no</span> | <span class="lose">no</span> | <span class="win">YES — only model</span> | <span class="lose">no</span> | <span class="lose">no</span> | <span class="lose">no</span> |
| Multilingual | weak | partial | <span class="win">native</span> | <span class="win">native</span> | <span class="lose">English-only</span> | <span class="win">native (untested)</span> | <span class="win">native (untested)</span> |
| VRAM bracket | ~3 GB | ~20 GB | ~16 GB | ~22 GB | ~18 GB | ~110 GB | <span class="win">~6 GB</span> |

## What this rounds out about size, quant, and capability

Four rounds in, the capability axes are starting to separate cleanly:

- **Affordance classification (chip = dropdown) is encoder-driven, not size-driven.** Three of the eight model variants got it. They span 9B–308B parameters, three families, three engines, three quants. Common factor isn't size — it looks more like a property of how the vision tokenizer / encoder treats small UI sub-components like a chevron-with-text.
- **Visual state extraction (red border, focus rings, error icons) does scale with size and quant.** The 9B-int4 reads form structure correctly but loses the colored cues; the same family at 27B gets them back. This matters for surface-level error detection — though it's recoverable from the DOM.
- **OCR fidelity scales coarsely.** Above ~9B, every model now reads the email correctly. Below that, Gemma 4-E2B mangles identifiers. There's a knee somewhere around 7-9B; below it, you can't trust the model on names, IDs, or amounts.
- **Calibrated uncertainty (§6) is a model-level behavior, not a size or quant artifact.** Eight variants tested, exactly one does it. Until proven otherwise, this is intrinsic to the Qwen 3.6-A3B post-training mix — not something you get for free by going larger.

## Verdict for VRAM-budget operators

**If you have ≤8 GB of VRAM** and need a self-hosted vision sub-call for a browser agent, Qwen 3.5-9B-int4 on vLLM is suddenly the most interesting option on this list. It nails what matters most for navigating browser forms — find the dropdown, OCR the strings, identify the blocker — while sacrificing what matters least: the precise visual cue surfacing, which is recoverable from the DOM. **It does not replace Qwen 3.6-35B-A3B** for users with the VRAM headroom — the §6 calibration is the difference, and it's the single most important difference on the table for browser-agent reliability — but on a 6-8 GB GPU, this is a much more capable model than its specs suggest.

For a routing policy, the rough shape is now:

- **≥22 GB VRAM**: Qwen 3.6-35B-A3B. Wins on §6 calibration, fast, multilingual.
- **~16 GB**: Qwen 3.6-27B dense. Trades §6 for fewer params; still gets visual cues.
- **~6-8 GB**: Qwen 3.5-9B-int4 on vLLM. Surprisingly competent on structure / OCR / blocker; lose the colored cues.
- **Hosted, English-only, paying per token**: Nemotron Omni 30B is the cheapest with strong affordance. [Round 2](/blog/vision-shootout-round-2) covers the tradeoffs.
- **Speculative / omni-modal coverage needed**: [MiMo V2.5](/blog/mimo-v25-pro-vs-flash) behind a feature flag, but not as the default — see [round 3](/blog/vision-shootout-round-3).

## What's next

- **Quant ladder for Qwen 3.5-9B.** int4 AutoRound vs Q4_K_M GGUF vs Q6_K vs Q8_0 vs FP16. Does the red-border miss recover at higher precision, or is it a 9B-vs-27B capability gap? This is the cleanest controlled experiment we can run on this board.
- **Multilingual screenshots.** Qwen 3.5 is multilingual on paper; no test on this board uses non-English UI yet.
- The follow-ups already promised in [round 3](/blog/vision-shootout-round-3) still stand: MiMo quant ladder, Qwen 3.6-A3B §6-collapse threshold, cold-start measurement.

The probe is unchanged from round 3 (and unchanged from rounds 1-2 in everything that affects model behavior — same prompt, same temperature, same max tokens). Three lines:

```
node test/vision-probe.mjs ./shot.png http://127.0.0.1:8000 qwen3.5-9b
node test/vision-probe.mjs ./shot.png http://127.0.0.1:8080 MiMo-V2.5-IQ3_S
node test/vision-probe.mjs ./shot.png http://127.0.0.1:8080 Qwen3.6-35B-A3B
```

<div class="callout">
<strong>Methodology caveat, again.</strong> Still one screenshot, still one fixture, now eight model variants. The reason the same Google sign-in screen keeps doing useful work as we add models is that it surfaces every axis we care about: OCR identifiers, structured affordances, visual state cues, ambiguity. Different pages will surface different weaknesses; if a model passes here and fails on a Stripe dashboard, that's worth knowing before you wire it in.
</div>
