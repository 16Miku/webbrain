---
title: >
  Two ways to give an open model eyes: Inkling Small vs GLM-5.2 Vision
slug: inkling-small-glm-5-2-vision-benchmark
sortOrder: -140
date: 2026-08-02
readTime: 10 min read
description: >
  We ran the same frozen WebBrain UI-vision probe against Thinking Machines Inkling Small on OpenRouter and a full GLM-5.2 Vision hybrid on four RTX PRO 6000 Blackwell GPUs at RunPod.
excerpt: >
  Both models read all 12 target strings and found the real sign-in blocker. Inkling Small was faster and more accurate on focus and error-state cues; the self-hosted GLM-5.2 derivative proved that a third-party vision graft can make a text-first 744B-class backbone genuinely useful on screenshots.
titleTag: >
  Inkling Small vs GLM-5.2 Vision UI benchmark - WebBrain Blog
ogTitle: >
  Inkling Small vs GLM-5.2 Vision: the same frozen UI test
ogDescription: >
  Native multimodality meets an open vision graft: one screenshot, one frozen prompt, OpenRouter vs four RTX PRO 6000 Blackwell GPUs.
twitterTitle: >
  Inkling Small vs GLM-5.2 Vision on the same UI screenshot
twitterDescription: >
  Both went 12/12 on visible strings. Inkling won the visual-state details; GLM's third-party vision graft still passed the core browser-agent test.
keywords:
  - WebBrain
  - Inkling Small
  - Thinking Machines
  - GLM-5.2 Vision
  - Baseten
  - RunPod
  - OpenRouter
  - multimodal model
  - vision-language model
  - open-weight AI
  - browser agent
  - UI understanding
lede: >
  **This is a comparison between two very different routes to multimodality.** Thinking Machines trained Inkling Small as a native text-image-audio model: a 276B-parameter MoE with 12B active. The original GLM-5.2 release is text-only, but open weights let Baseten attach Kimi K2.6's MoonViT vision tower through a small trained projector; a community checkpoint then compressed the full model enough to serve on four 96 GB RTX PRO 6000 Blackwell GPUs. We sent both the exact same Google sign-in screenshot, system prompt, user message, temperature, and output limit. Both read the page. Inkling Small produced the better browser-state description, while GLM-5.2 Vision delivered the more consequential ecosystem result: the open graft actually works.
---

## The short version

The screenshot contains a Google password challenge with twelve target strings, an account chip, an empty password field, a red validation border, a red warning icon, an enabled-looking `Next` button, and a small chevron that makes the account chip actionable.

Both models:

- read all **12/12 target strings**, including the email address;
- identified the page purpose;
- read the exact `Enter a password` validation message;
- recognized the warning icon;
- inferred that the empty password was the real blocker;
- produced no fabricated visible text;
- missed the account chip's dropdown affordance; and
- answered `Unknowns: None`, despite each having missed at least one meaningful detail.

Inkling Small did better on the remaining visual state. It reported the red input border and correctly treated the password field as focused. GLM omitted the border and marked the field as not focused. Inkling also returned much sooner on the tested hosted route.

| Frozen screenshot metric | Inkling Small | GLM-5.2 Vision hybrid |
| --- | --- | --- |
| Visible strings | **12 / 12** | **12 / 12** |
| Email OCR | Correct | Correct |
| Account chip recognized as dropdown | Missed | Missed; called it an email field |
| Password value | Correctly empty | Correctly empty |
| Password focus state | **Correct** | Incorrect |
| Red error state | **Border + icon + exact text** | Icon + exact text; border missed |
| Real blocker | Correct | Correct |
| Fabricated visible text | 0 | 0 |
| Honest uncertainty | Failed: `None` | Failed: `None` |
| Time to first token | **3.60s** | 15.64s |
| Total response time | **5.13s** | 21.63s |

That is an Inkling Small win on this fixture. It is not a universal vision leaderboard, and the latency column is particularly non-comparable: Inkling ran through a provider-managed OpenRouter route, while GLM ran on our one-off dedicated RunPod deployment. The useful result is the capability shape, not a synthetic hosted-versus-self-hosted speed crown.

## What we actually tested

### Inkling Small: native multimodality

[Thinking Machines describes Inkling Small](https://thinkingmachines.ai/news/introducing-inkling/#inkling-small) as a **276B-total, 12B-active MoE** trained with a similar recipe and the same scalable post-training stack as the 975B Inkling. The official preview reports results for text, vision, and audio tasks. The broader Inkling architecture is encoder-free in the usual specialist-tower sense: image patches and audio representations enter a shared autoregressive model rather than being bolted onto an already-finished text model.

We tested the exact OpenRouter model id:

```text
thinkingmachines/inkling-small
```

[OpenRouter listed the route](https://openrouter.ai/thinkingmachines/inkling-small) with 276B total / 12B active parameters and a 524K context window. This was a hosted route test; it was not a self-hosted weight deployment.

### GLM-5.2 Vision: open components composed after training

GLM's route is almost the architectural opposite.

[Baseten's GLM-5.2-Vision release](https://huggingface.co/baseten/GLM-5.2-Vision-NVFP4) starts with the **744B-total / 40B-active GLM-5.2 text backbone**, freezes it, freezes the 27-layer MoonViT vision tower from Kimi K2.6, and trains only a **49.5M-parameter PatchMerger projector** between them. The result accepts images even though the upstream Z.ai GLM-5.2 checkpoint is text-only.

We first tried to use that pure NVFP4 release. Its validated 256K deployment requires four B200 GPUs, and the full FP8 build requires eight B200s or eight H200s. That topology was not available to us when we ran the test.

Instead, we used the published community checkpoint:

```text
0xSero/GLM-5.2-MXFP8-NVFP4-NF3-Hybrid-Vision
revision 6395e588e0f22dc9c9988907d6281ce675ec7e20
```

[Its model card](https://huggingface.co/0xSero/GLM-5.2-MXFP8-NVFP4-NF3-Hybrid-Vision) describes the full 753B assembly with all 256 experts intact. It stores the 64 highest-priority experts per layer in NVFP4, the remaining 192 experts in a custom NF3 format, and non-expert layers in BF16 served as MXFP8. The checkpoint is approximately 342 GB and has a validated four-card recipe for 96 GB SM120 GPUs.

That distinction matters enough to state plainly:

> Our result is for the **community MXFP8 + NVFP4 + NF3 hybrid**, not Baseten's official pure-NVFP4 checkpoint.

The vision tower and projector come from the Baseten release, but text-weight numerics and the serving runtime differ. A later pure-NVFP4 B200 run may produce different latency and, potentially, different answers.

## The frozen probe

We reused `test/vision-probe.mjs` and the exact fixture from our earlier vision rounds:

```text
test/fixtures/google-signin-password-error.jpg
SHA-256: 15f287f319edae5fc0d97dd44201a0493a0864deb4bec556b236169a3f1b4e4a
```

The prompt forces six short sections:

1. page purpose;
2. exact visible strings;
3. inputs and their value/focus/disabled state;
4. state signals such as errors and overlays;
5. blockers; and
6. honest unknowns.

Both requests used:

```text
temperature: 0
max tokens: 800
thinking flags: disabled
system prompt: identical
user message: identical
image bytes: identical
```

This is narrower than MMMU, CharXiv, or a full computer-use benchmark. It asks a product question those suites do not: **can the model turn one browser screenshot into the terse, literal state description a planning agent needs?**

## The two answers

Inkling Small's critical lines were:

```text
Password field ... empty, focused, red border
Validation error "Enter a password" with red warning icon
Password field empty with active validation error
```

That is the important visual-state chain: empty value, focus, red border, warning icon, exact message, blocker.

GLM-5.2 Vision wrote:

```text
Password field ... value: empty, focused: no
Red error message "Enter a password" with an exclamation mark icon
Empty password field prevents proceeding; "Next" button is enabled
```

GLM got the semantic state but lost two visual details. The input is shown with the active floating label and red focus/error outline, so `focused: no` is the wrong call. The response also omitted the red border entirely. Its `Next` observation was useful, though: the button is visually enabled, but clicking it cannot advance while the password is empty.

Neither model understood the account identifier as a dropdown. Inkling called it an account pill; GLM called it an email field. Both read `esokullu@gmail.com` perfectly, but neither converted the small downward chevron into an actionable affordance. For a browser agent, OCR and affordance recognition are separate capabilities. Reading the label does not tell the planner that clicking it opens account selection.

## Why GLM's partial miss is still a real win

It would be easy to reduce this to “Inkling won 5.1 seconds versus 21.6 seconds.” That misses the interesting part.

Inkling Small was trained to understand images. GLM-5.2 was not. Its vision capability exists because several independently released components could be combined:

1. Z.ai released the GLM-5.2 text weights.
2. Moonshot released a strong MoonViT vision tower with Kimi K2.6.
3. Baseten trained and released a small projector connecting the two frozen models.
4. A community maintainer repackaged the full model into a four-GPU hybrid checkpoint and supplied the custom runtime.

The final system read every string, interpreted the validation error, and identified the correct blocker on its first frozen WebBrain probe. It did this without jointly retraining the enormous language backbone and vision encoder.

That is a strong argument for open weights as an ecosystem property, not merely a download checkbox. The original GLM-5.2 OpenRouter route remains text-only, but the model family is no longer practically limited to text for operators willing to deploy the derivative. The same general route could eventually give text-only releases from DeepSeek or Tencent useful vision, although “attach a tower and train a projector” is not a guarantee of quality. Alignment, tokenization, data, projector training, inference kernels, and evaluation still matter.

## What Inkling Small demonstrates

Inkling Small is the cleaner product result.

It is less than half GLM's active parameter count and roughly one-third the total parameter count, yet it retained the stronger visual-state read on this page. That does not prove small beats large; it shows why parameter count is a poor proxy when the multimodal training path is different. Native image training gave Inkling a better read of focus and color-coded validation cues than this particular post-hoc GLM graft.

This also strengthens the American open-weight story. Poolside's recent Laguna releases made US open models much more credible in inexpensive text planning. Thinking Machines is now adding native image and audio capability at a much broader generalist level. Inkling Small is still enormous by consumer-hardware standards, but 12B active is a meaningful serving target, and the official benchmark table places it surprisingly close to full Inkling on several reasoning and multimodal evaluations.

There are still caveats. We tested the hosted preview route, not local weights. One screenshot cannot establish OCR robustness, chart reasoning, multilingual UI performance, or behavior under image crops. The model also missed the account chevron and failed the prompt's uncertainty instruction.

## Deployment notes from the GLM run

The self-hosted side was not a one-command managed endpoint. We deployed on **RunPod Secure Cloud** using four NVIDIA RTX PRO 6000 Blackwell Server Edition GPUs with 96 GB each.

The first boot included:

- downloading 213 checkpoint files, approximately 342 GB;
- installing the small `glm52_vision` plugin from the checkpoint repository;
- loading approximately 84.93 GiB of weights per GPU;
- creating a 508,955-token FP8 KV pool at a 250K maximum model length; and
- compiling and warming the custom NF3, MXFP8, sparse-attention, and collective kernels.

The publisher's prebuilt GHCR vision image rejected anonymous pulls during our run. We therefore used the public `madeby561/vllm-glm52-nvfp4-nf3-hybrid:v3` base runtime and installed the repository's vision plugin inside the Pod. Once the endpoint was healthy, it exposed a standard OpenAI-compatible `/v1/chat/completions` API.

We saved the result locally, stopped the GPU workload, and deleted the benchmark Pod and its 500 GB volume. This was a dedicated one-off deployment, so we are intentionally not presenting its setup bill as if it were a comparable per-request model price.

## The recurring failure: confident completeness

Both answers ended with:

```text
6) Unknowns: None.
```

But neither answer was complete. Both missed the email-chip chevron, and GLM also missed the red border and focus state. This is exactly why WebBrain's vision prompt asks for unknowns: a planning agent should know when a visual interpretation is uncertain.

The models instead treated `Unknowns` as a box to close. That behavior is more dangerous than a simple OCR miss because it gives the downstream planner no reason to cross-check the DOM or accessibility tree. A production agent should therefore continue to merge vision with structured page reads rather than treating a confident screenshot caption as ground truth.

## Verdict

**Inkling Small wins this frozen screenshot.** It matched GLM's perfect visible-text recall, captured more of the error treatment, got the focus state right, and returned much faster on the route we tested.

**GLM-5.2 Vision still passes the consequential test.** A third-party open derivative gave a text-first 744B-class backbone working screenshot understanding. The community hybrid was not as visually precise as Inkling Small here, but it was accurate enough to help a browser planner: exact text, correct page purpose, correct error, correct blocker, no invented labels.

The broader conclusion is encouraging for both sides of the open-model ecosystem. American releases are becoming genuinely competitive and natively multimodal. Chinese open backbones are increasingly strong enough—and open enough—to become platforms for capabilities their original API routes do not expose. The gap is narrowing, but the route matters: native multimodal training produced the better answer today; open composition made the surprising answer possible at all.

Raw artifacts:

- [Inkling Small result](https://github.com/webbrain-one/webbrain/blob/main/test/vision-results/2026-08-02-inkling-small-openrouter.json)
- [Inkling Small evaluation](https://github.com/webbrain-one/webbrain/blob/main/test/vision-results/2026-08-02-inkling-small-openrouter-evaluation.json)
- [GLM-5.2 Vision result](https://github.com/webbrain-one/webbrain/blob/main/test/vision-results/2026-08-02-glm-5-2-vision-runpod-hybrid.json)
- [GLM-5.2 Vision evaluation](https://github.com/webbrain-one/webbrain/blob/main/test/vision-results/2026-08-02-glm-5-2-vision-runpod-hybrid-evaluation.json)
- [GLM-5.2 Vision deployment record](https://github.com/webbrain-one/webbrain/blob/main/test/vision-results/2026-08-02-glm-5-2-vision-runpod-hybrid-deployment.json)

<div class="callout">
<strong>Methodology limit.</strong> One screenshot is a probe, not a general vision benchmark. It is useful because the fixture simultaneously tests exact OCR, form state, color-coded validation, semantic blockers, and a small actionable chevron. A different page can reverse a narrow ranking. The result supports routing and follow-up tests; it does not establish a universal multimodal hierarchy.
</div>
