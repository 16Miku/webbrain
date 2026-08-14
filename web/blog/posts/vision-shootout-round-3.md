---
title: >
  Round 3: Xiaomi MiMo V2.5 enters the vision shootout — and joins the "Unknowns: None" club
slug: vision-shootout-round-3
sortOrder: 50
date: 2026-05-07
readTime: 7 min read
description: >
  A third round of vision-model benchmarking for browser agents. Xiaomi's MiMo-V2.5 — the "looks promising" model from our research notes — sits down at the same probe with the same Google sign-in screen. Strong OCR, expensive image tokens, no calibrated uncertainty.
excerpt: >
  The empirical follow-up to last week's MiMo speculation post. Same probe, same Google sign-in screen, same prompt. MiMo at IQ3_S nails OCR and state extraction in the Qwen 3.6 tier — but joins Nemotron and Gemma in writing "Unknowns: None" instead of flagging the red-border ambiguity. Token cost ties the most expensive bucket; latency is in a different class. Plus a probe upgrade so big reasoning models stop tripping the default fetch headers timeout.
titleTag: >
  Round 3: Xiaomi MiMo V2.5 enters the vision shootout — and joins the "Unknowns: None" club — WebBrain Blog
ogTitle: >
  Round 3: Xiaomi MiMo V2.5 vs the vision shootout — does the omni-modal flagship dethrone Qwen 3.6?
ogDescription: >
  MiMo-V2.5 at IQ3_S nails OCR and state extraction but joins the 'Unknowns: None' club with Nemotron and Gemma. Token cost ties Qwen 27B-dense — the most expensive bucket. The speculation post meets the empirical numbers.
twitterTitle: >
  Round 3: Xiaomi MiMo V2.5 enters the vision shootout
twitterDescription: >
  Strong OCR, weak on uncertainty, expensive on tokens. The empirical follow-up to our MiMo speculation post.
keywords:
  - MiMo V2.5
  - Xiaomi MiMo
  - vision model benchmark
  - browser agent
  - llama.cpp vision
  - IQ3_S quantization
  - calibrated uncertainty
  - Qwen 3.6 vs MiMo
  - multimodal model
  - omni-modal
  - reasoning model
  - undici headers timeout
  - vision probe
html: true
lede: >
  A week ago we wrote a [research note about Xiaomi's MiMo V2.5](/blog/mimo-v25-pro-vs-flash) calling it a promising candidate for WebBrain — multimodal by design, long context, strong vendor benchmarks. This post is the empirical follow-up: same probe as [round 2](/blog/vision-shootout-round-2), same Google sign-in screen, same prompt. The speculation held up on most axes. On the one axis a browser agent values most, MiMo joined the wrong club.
---

## The setup, again

Same `test/vision-probe.mjs` from the repo, same 6-section structured caption prompt that WebBrain's vision sub-call ships with, same image (Google sign-in with focused password field, red error border, and the email chip with a dropdown chevron). MiMo-V2.5 was loaded at **IQ3_S** on `llama.cpp` (`localhost:8080`), 308B total params at ~3.0 bpw — the smallest sane quant that fits on the box we tested on. Run with `chat_template_kwargs.enable_thinking: false` AND `think: false` AND `thinking: false`; MiMo respected one of them and did not emit reasoning tokens during the vision call.

## A probe upgrade detour

First attempt: `UND_ERR_HEADERS_TIMEOUT`. Node's `fetch` (undici) waits at most 5 minutes for response headers before giving up. For a 308B-IQ3_S model with multimodal prefill, prompt-eval alone can blow past that — the server doesn't emit headers until the first generated token, and the first generated token doesn't arrive until after image embedding plus several thousand tokens of prefill on a quant that's bottlenecked on memory bandwidth.

Two-line fix: drop `fetch` for `node:http` directly, which has no default headers timeout. While we were in there, the probe also picked up streaming output (so you see tokens as they arrive instead of staring at a hung process), separate `reasoning_content` capture (MiMo and the DeepSeek-R1 family emit reasoning deltas on their own channel, separate from the visible output), and a `timings` readout showing prompt-eval and predict tokens-per-second when the server provides them. The probe in the repo handles all of this automatically now — no flags, no surgery.

This is the kind of thing the round 2 post flagged as future work: *"How much of behavior X is the model and how much is the engine / quant?"* The probe needs to be honest about both. It is, now.

## What MiMo got right

OCR and state extraction landed in the Qwen 3.6 tier, which is the right tier to land in:

- **All 12 visible strings**, verbatim, including `esokullu@gmail.com` with no character drift. Same fidelity as Qwen 3.5/3.6 — meaningfully better than Gemma's `esokullullu`-class OCR errors.
- **Red error state**: surfaced the border, the exclamation icon, and the "Enter a password" message together — the full visual triple, not just one of them.
- **Inferred semantic blocker**: "password field is empty and showing an error state... requires a password to proceed." Correct framing for a planner.
- **Page purpose**: "Google account password verification page." One line, correct. No flowery prose.

## Where MiMo landed in the table

### Image token cost: tied with the most expensive bucket

- Gemma 4-31B: 574
- Nemotron Omni 30B: 3636
- Qwen 3.6-35B-A3B: 4374
- Qwen 3.6-27B dense: 5570
- **MiMo V2.5 IQ3_S: 5557** — basically tied with Qwen 27B-dense

MiMo's vision encoder (a Qwen2.5-VL-derived patch tokenizer at this resolution) lands in the same expensive bracket as Qwen 27B-dense. ~9.7× Gemma's 574, ~53% above Nemotron. If you're paying per image token at a hosted endpoint, MiMo and the Qwen-dense family are the most expensive options on this board.

### Latency: bottlenecked on the quant

With a fully cold KV cache, text-only TTFB was 93 seconds for a 27-token prompt — that's the floor on this hardware running 308B at IQ3_S, and it's the model/quant talking, not the engine. Once the prompt cached (`cached_tokens: 5553` of 5557 on the warm run), the vision call returned 209 completion tokens in 61 seconds. Cold-cache vision wasn't measured cleanly because the first attempt timed out, but extrapolating from prompt-eval rate and prompt size, expect somewhere north of two minutes for cold multimodal — easily long enough to trip the default `fetch` headers timeout, which is exactly what happened.

For comparison, Qwen 3.6-35B-A3B was 5.3s end-to-end on the same hardware in round 2. MiMo at IQ3_S is in a different latency class.

### Affordance classification: missed the dropdown

The email chip — `esokullu@gmail.com` with a small chevron — is structurally a dropdown. MiMo captured the text correctly in §2 but did not classify the chip as an input in §3:

```
3) Inputs:
    - Password field: label "Enter your password", placeholder empty,
      current value empty, focused/disabled: focused
      (red border indicates error state).
    - Checkbox: label "Show password", unchecked.
```

Same miss as Gemma, Qwen 27B-dense, and Qwen 3.6-A3B (which only flagged the chevron parenthetically). Worse than Nemotron, which was the only model so far to put `Type: dropdown` in §3 explicitly. For a planner that scans §3 to find clickable inputs, this is the difference between "I can pick a different account here" and "the email is just a heading" — Nemotron's framing is the right one for browser agents.

### The "Unknowns: None" miss

Section 6 of the prompt is verbatim:

> If you cannot read something clearly, say so. Do not guess numbers, names, or identifiers.

The red border on the password field is genuinely ambiguous: the same color treatment is used for both focus rings and validation errors on Material-style components, and the planner needs to know which of the two it's looking at before it acts. Round 2's headline finding was that **Qwen 3.6-35B-A3B was the only model that flagged this ambiguity** — it explicitly said "border could mean focus, could mean error; cross-check with DOM."

MiMo wrote:

```
6) Unknowns: None.
```

So MiMo joins Nemotron, Qwen 27B-dense, Gemma 4-E2B, and Gemma 4-31B in the "wrote None even when there was something to flag" club. Round 2 argued that this is the bullet that decides everything else for a browser agent — affordance misses are recoverable via the accessibility tree, OCR misses are recoverable via DOM cross-check, but overconfidence is structurally unrecoverable. Without §6, model perception becomes ground truth, and ground truth includes whatever the model hallucinated.

## The speculation, revisited

The [Pro vs Flash post](/blog/mimo-v25-pro-vs-flash) was a research note: vendor benchmarks looked strong, omni-modal positioning matched WebBrain's screenshot-heavy loop, the recommendation was to add MiMo behind an opt-in routing flag and let the eval harness decide. Empirically:

- **Multimodal by design held up.** OCR and state extraction are real, not theoretical.
- **Long-context claims are untested by this probe** — it's a single-screenshot benchmark, not an agent-trace replay. We'll get to that.
- **Strong-benchmark posture didn't translate to calibrated uncertainty.** MiMo nails the visible-text and state extraction sections that overlap with traditional VLM benchmarks. The §6 honest-uncertainty bullet is not on any standard benchmark, and it shows.

None of this rules MiMo out — but the "should we route to it by default for browser-agent vision?" answer is no, not at IQ3_S, not on the calibrated-uncertainty axis. Qwen 3.6-35B-A3B at the same VRAM bracket beats it on the metric that matters most.

## The quantization caveat — same one round 2 raised, now with a data point

Round 2 closed with a question: *"For Qwen 3.6-35B-A3B specifically: what's the smallest quant that preserves its calibrated-uncertainty behavior? At what point does §6 collapse back to 'None'?"*

MiMo at IQ3_S gives us a sibling data point: **at 3.0 bpw on a 308B model, §6 collapses.** We don't yet know whether Q4_K_M, Q6_K, Q8_0, or BF16 of MiMo would behave differently. We also don't know the corresponding quant-vs-§6 curve for any other model on this list. The probe makes it cheap to map this curve once we have the storage and patience to run it. Open question, real follow-up.

## The full table, updated

|  | Gemma 4-E2B | Gemma 4-31B | Qwen 3.6-27B | Qwen 3.6-35B-A3B | Nemotron Omni 30B | MiMo V2.5 IQ3_S |
| --- | --- | --- | --- | --- | --- | --- |
| Architecture | Dense, ~2B | Dense 31B | Dense 27B | MoE 35B / ~3B active | MoE 30B / ~3B active | MoE 308B (omni) |
| Engine | llama.cpp | llama.cpp | vLLM int4 | llama.cpp | vLLM NVFP4 | llama.cpp IQ3_S |
| Latency (warm) | <span class="win">1.5s</span> | 4.6s | 5.9s | <span class="win">5.3s</span> | 12.0s | <span class="lose">61s / 209t</span> |
| Cold TTFB (text-only) | — | — | — | — | — | <span class="lose">93s / 27t</span> |
| Prompt tokens (image) | <span class="win">574</span> | <span class="win">574</span> | <span class="lose">5570</span> | 4374 | <span class="win">3636</span> | <span class="lose">5557</span> |
| Email chip OCR | <span class="lose">❌</span> | <span class="lose">❌</span> | <span class="win">✓</span> | <span class="win">✓</span> | <span class="win">✓</span> | <span class="win">✓</span> |
| All 12 visible strings | <span class="lose">5/12</span> | <span class="win">12</span> | <span class="win">12</span> | <span class="win">12</span> | <span class="meh">11 (email moved to §3)</span> | <span class="win">12</span> |
| Affordance: chip = dropdown | <span class="lose">missed</span> | <span class="lose">missed</span> | <span class="lose">missed</span> | <span class="meh">parenthetical</span> | <span class="win">explicit <code>Type: dropdown</code></span> | <span class="lose">missed</span> |
| Red error state | <span class="lose">missed</span> | text only | <span class="win">border + icon + text</span> | <span class="win">border + icon + text + flag</span> | <span class="win">border + icon + text</span> | <span class="win">border + icon + text</span> |
| Inferred blocker | <span class="lose">no</span> | no | <span class="win">yes</span> | <span class="win">yes</span> | <span class="win">yes</span> | <span class="win">yes</span> |
| Honest "Unknowns" §6 | <span class="lose">no</span> | <span class="lose">no</span> | <span class="lose">no</span> | <span class="win">YES — only model</span> | <span class="lose">no</span> | <span class="lose">no</span> |
| Multilingual | weak | partial | <span class="win">native</span> | <span class="win">native</span> | <span class="lose">English-only</span> | <span class="win">native (untested here)</span> |

## Verdict

**Qwen 3.6-35B-A3B is still the pick** for self-hosted browser-agent vision. The case from round 2 — fastest, only model with calibrated uncertainty, multilingual, fits on consumer hardware — survives round 3 unchanged. MiMo V2.5 at IQ3_S is mid-tier: roughly comparable to Qwen 27B-dense in token cost AND output quality, but in a much heavier latency class and without the calibration that makes the A3B variant special. It's a real model on a probe that's harder than its training distribution probably anticipated.

### Where MiMo would make sense anyway

- You need the omni-modal coverage MiMo claims (audio + video + image), not just static screenshots.
- You need MiMo's long-context reasoning behavior on multi-step agent traces — this probe is single-shot and can't speak to that.
- You're willing to run a higher quant (Q4_K_M or above) to find out whether §6 calibration recovers at higher precision. We don't know yet. The probe makes it cheap to find out.

For the dedicated single-screenshot vision sub-call inside a browser-agent loop, the answer at IQ3_S is: not yet. For the speculative routing layer in the Pro vs Flash post — keep it opt-in, escalate to it on uncertainty, but don't make it the default.

## What's next

- **Quant ladder for MiMo.** IQ3_S → Q4_K_M → Q6_K → Q8_0. Does §6 calibration recover at any point, or is this a model-level behavior rather than a quant artifact?
- **Same ladder for Qwen 3.6-35B-A3B.** Round 2's open question — at what bpw does the calibrated-uncertainty behavior collapse back to "None"? Knowing the floor is useful for anyone trying to fit the model on tighter VRAM budgets.
- **Multilingual screenshots.** MiMo is multilingual on paper; we haven't tested it on Turkish, Spanish, or Chinese pages. Round 2 ruled Nemotron out on this axis without WebBrain users seeing a benchmark; MiMo might recover here.
- **Cold-start with proper measurement.** The cold multimodal latency on this hardware is a real number we should publish, not extrapolate.

The probe stays where it is — three lines, mirror parity with the extension's actual sub-call:

```
node test/vision-probe.mjs ./shot.png http://127.0.0.1:8080  MiMo-V2.5-IQ3_S
node test/vision-probe.mjs ./shot.png http://127.0.0.1:8080  Qwen3.6-35B-A3B
node test/vision-probe.mjs ./shot.png http://localhost:11434/v1  llava:13b
```

<div class="callout">
<strong>Methodology caveat, again.</strong> One screenshot, one quant, one engine. The probe is the cheapest possible way to compare models on whatever pages and quants you actually care about — but a single Google sign-in screen doesn't generalize to every browser-agent workload. If a model passes here and fails on a Stripe dashboard, that's worth knowing before you wire it into the routing policy.
</div>
