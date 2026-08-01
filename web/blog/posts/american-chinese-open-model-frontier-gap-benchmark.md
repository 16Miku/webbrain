---
title: >
  Two AI gaps are narrowing: American open weights and Chinese frontier models
slug: american-chinese-open-model-frontier-gap-benchmark
sortOrder: -130
date: 2026-08-02
readTime: 18 min read
description: >
  A consensus-ranked, cost-aware WebBrain planner test of ten new OpenRouter models from OpenAI, Anthropic, MiniMax, Z.ai, DeepSeek, Thinking Machines, Qwen, Moonshot, and Tencent.
excerpt: >
  DeepSeek V4 Flash, Tencent HY3, and GLM-5.2 lead our reference-free first-action consensus, but all three tested routes are text-only. Kimi K3 nearly matches Sonnet 5's dispatch reliability, MiniMax M3 remains the most attractive Claude-like value generalist, and Qwen 3.6 27B is still our practical RTX 5090 pick.
titleTag: >
  US-China open-weight and frontier model benchmark - WebBrain Blog
ogTitle: >
  Two AI gaps are narrowing: our ten-model planner benchmark
ogDescription: >
  Ten OpenRouter models, 1,000 calls, no reference-model judge: consensus quality, latency, modality, architecture, parameter count, and real test cost.
twitterTitle: >
  Ten-model planner test: two AI gaps are narrowing
twitterDescription: >
  DeepSeek, HY3, and GLM lead consensus; Kimi approaches Sonnet reliability; Qwen 27B remains the RTX 5090 choice.
keywords:
  - WebBrain
  - OpenRouter
  - open-weight AI
  - American AI
  - Chinese AI
  - DeepSeek V4
  - Tencent HY3
  - GLM-5.2
  - Kimi K3
  - MiniMax M3
  - Claude Sonnet 5
  - GPT-5.6
  - Qwen 3.6 27B
  - browser agent
  - tool calling
lede: >
  **Two gaps are narrowing at once.** American open-weight releases from Thinking Machines and Poolside are finally making the cheap, self-hostable model conversation less one-sided. At the frontier, Chinese labs are putting models such as Kimi K3 and GLM-5.2 much closer to the operational territory occupied by Claude and GPT. We tested ten current OpenRouter routes on WebBrain's complete 100-case browser-planner suite, then ranked them without treating Sonnet 5—or any other single model—as the judge. The result is encouraging, complicated, and much more useful than a one-number leaderboard: inexpensive Chinese text planners dominate first-action consensus, Kimi K3 nearly matches Sonnet 5's dispatch reliability, MiniMax M3 remains a compelling multimodal value choice, and Qwen 3.6 27B is still the model we would put in a single RTX 5090 workstation.
---

## The short version

We sent **1,000 successful requests**—100 per model—through the same current WebBrain Chrome planner suite. All ten runs completed without an API error or retry. Instead of measuring “alignment with Claude Sonnet 5,” we compared every model's normalized first action with the other nine models on each case.

The main findings:

- **DeepSeek V4 Flash 0731 ranks first by exact-action peer consensus**, followed by Tencent HY3 and GLM-5.2. They are fast and exceptionally inexpensive in this workload. They are also text-only on the routes we tested, so this is not a complete browser-agent ranking.
- **Claude Sonnet 5 remains the cleanest dispatcher** by simpler harness measures: 98 schema-valid actions and 47 ideal tool-name choices, both the best in the group. It also cost $7.22 for this replay because no prompt-cache reads were reported.
- **Kimi K3 is the strongest evidence that the Chinese frontier gap is narrowing.** It produced 97 valid calls and 44 ideal tool choices, close to Sonnet's 98 and 47, while ranking fifth in exact peer consensus. It was slow here, and its tested OpenRouter list price was not cheap.
- **MiniMax M3 remains our best-balanced Claude-like value generalist**, even though it is not the closest model to Sonnet on this narrow first-action measurement. It combines a 1M context, image and video input, a 23B-active MoE, 2.85-second median latency, and a $0.504 replay cost.
- **GPT-5.6 needs a two-turn test.** Luna and especially Terra frequently chose `get_accessibility_tree`, a cautious observation step that this first-action-only harness penalizes. Simply deleting those rows would make the score look better but would introduce selection bias.
- **Qwen 3.6 27B remains our single-RTX-5090 choice.** It is the only dense 27B model in this group, is realistically quantizable into a 32GB consumer GPU, supports vision and video, and avoids per-token API cost. Its current OpenRouter row had schema roughness, so local deployment still benefits from argument validation.

Those conclusions are deployment-specific. A text-only planner, a multimodal cloud agent, and a private one-GPU agent are different products. One global rank hides more than it reveals.

## What the ten models actually are

“Open source” is often used loosely in model discussions. We use **open-weight** for downloadable checkpoints and keep hosted closed models separate. Parameter counts below come from the labs' model cards when disclosed; an em dash means the developer has not published a reliable count for that exact model.

| Model | Lab / access | Architecture | Total / active parameters | Inputs on the tested route |
| --- | --- | --- | ---: | --- |
| [GPT-5.6 Luna Pro](https://developers.openai.com/api/docs/guides/latest-model) | OpenAI, US, closed | Undisclosed | — / — | Text, image, file |
| [MiniMax M3](https://huggingface.co/MiniMaxAI/MiniMax-M3) | MiniMax, China, open-weight | Sparse-attention MoE | 428B / ~23B | Text, image, video |
| [Claude Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5) | Anthropic, US, closed | Undisclosed | — / — | Text, image, file |
| [GLM-5.2](https://huggingface.co/zai-org/GLM-5.2) | Z.ai, China, open-weight | MoE | 753B / not separately disclosed | **Text only** |
| [DeepSeek V4 Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash) | DeepSeek, China, open-weight | MoE | 284B / 13B | **Text only** |
| [Inkling Small](https://thinkingmachines.ai/news/introducing-inkling/) | Thinking Machines, US, open-weight | MoE | Not disclosed / 12B | Text, image, audio |
| [Qwen 3.6 27B](https://huggingface.co/Qwen/Qwen3.6-27B) | Alibaba Qwen, China, open-weight | **Dense** | 27B / 27B | Text, image, video |
| [Kimi K3](https://huggingface.co/moonshotai/Kimi-K3) | Moonshot AI, China, open-weight | MoE | 2.8T / 104B | Text and image on this route; official checkpoint is multimodal |
| [GPT-5.6 Terra Pro](https://developers.openai.com/api/docs/guides/latest-model) | OpenAI, US, closed | Undisclosed | — / — | Text, image, file |
| [Tencent HY3](https://huggingface.co/tencent/Hy3) | Tencent, China, open-weight | MoE | 295B + 3.8B MTP / 21B | **Text only** |

The parameter table explains why “small” can be misleading. Inkling Small activates 12B parameters but its total size is not officially disclosed. DeepSeek activates just 13B of 284B. HY3 activates 21B of 295B. MiniMax M3 activates roughly 23B of 428B. Kimi K3 is in a different infrastructure class at 2.8 trillion total and 104B active. Qwen is the outlier in the other direction: all 27B dense parameters participate, but the full model is compact enough to make one-box local inference practical after quantization.

It also shows why the top three cannot simply be declared the three best browser models. GLM-5.2, DeepSeek V4 Flash, and HY3 received textual page state and tool schemas, but their tested routes cannot inspect a screenshot. MiniMax M3, Sonnet 5, Inkling Small, Qwen 3.6, Kimi K3, and the GPT-5.6 routes have a broader input surface. **This benchmark did not send images, video, audio, or files to any model**, so multimodality is product context rather than a scored advantage.

## What we ran

This was the current **full-tier**, non-frozen planner suite: 100 Chrome first-action cases per model, 41 available WebBrain tools, native structured tool calls, and no saved request bodies.

```text
cases per model:       100
models:                10
successful requests:   1,000
API errors:            0
retries:               0
concurrency:            3
max output:             4,096 tokens
Act temperature:        0.15
Ask temperature:        0.30
reasoning override:     none
API surface:            OpenRouter Chat Completions
code checkout tested:   7182c21f
```

The checkout matters. We ran the suite on commit `7182c21f`, then fast-forwarded the repository from `origin/main` before writing this article. The raw files preserve the actual run metadata; we do not attribute pre-pull results to the newer code.

“Non-frozen” also matters. Earlier WebBrain posts used a May 2026 frozen baseline and often reported agreement with a saved Sonnet reference. This run uses the current test definitions and does **not** inherit that historical leaderboard. It is appropriate for comparing these ten simultaneous runs with each other, not for splicing their percentages into older frozen tables.

Finally, this is a first-action test. It asks whether a model dispatches the right opening tool and arguments. It does not let a model browse for twenty turns, recover from a cautious observation, interpret a screenshot, execute code, or revise a plan after seeing a tool result. Those are not footnotes; they materially affect GPT-5.6, multimodal models, and long-horizon agent specialists.

## A consensus rank, not a Sonnet rank

For each case, we compared one model with each of the other nine models. The primary score is the share of those **900 pairwise comparisons** in which both models chose the same normalized full action: tool name plus normalized arguments. The secondary score compares only the tool name.

This is leave-one-out consensus. Sonnet contributes one peer vote when another model is scored, just like every other model, and cannot grade itself. No model is privileged as the reference.

| Rank | Model | Exact-action consensus | Tool-name consensus | Schema-valid / emitted | Ideal tool | Exact ideal | Median | p95 | Replay cost |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | **DeepSeek V4 Flash 0731** | **49.4%** | 78.9% | 90 / 90 | 39 | 18 | **1.56s** | 5.24s | **$0.050** |
| 2 | **Tencent HY3** | **46.6%** | 78.8% | 90 / 90 | 41 | 18 | 5.12s | 8.98s | $0.246 |
| 3 | **GLM-5.2** | **42.7%** | 76.1% | 86 / 89 | 39 | **20** | 1.73s | **4.44s** | $0.545 |
| 4 | Claude Sonnet 5 | 42.1% | 74.7% | **98 / 98** | **47** | 17 | 4.06s | 8.28s | $7.222 |
| 5 | Kimi K3 | 40.2% | 77.8% | 97 / 97 | 44 | 18 | 7.54s | 26.15s | $1.563 |
| 6 | MiniMax M3 | 39.8% | 73.9% | 86 / 89 | 33 | 17 | 2.85s | 7.34s | $0.504 |
| 7 | Qwen 3.6 27B | 37.1% | 73.9% | 83 / 92 | 36 | 17 | 2.23s | 19.36s | $0.670 |
| 8 | Inkling Small | 33.9% | 73.9% | 84 / 84 | 32 | 15 | **1.05s** | **2.06s** | $0.243 |
| 9 | GPT-5.6 Luna Pro | 14.3% | 74.7% | 89 / 89 | 32 | 3 | 5.12s | 7.96s | $0.228 |
| 10 | GPT-5.6 Terra Pro | 9.2% | 57.4% | 94 / 94 | 12 | 2 | 4.91s | 7.69s | $2.238 |

Consensus is not ground truth. Nine models can share the same weak habit, and a genuinely better model can disagree for a good reason. That is why the table retains the harness's deterministic ideal-tool and exact-ideal columns. Still, consensus is a much better answer to “what do the models collectively think?” than silently making Sonnet 5 the constitution.

The agreement signal is not noise. The ten models unanimously selected the same tool family on **35 of 100 cases**. At least seven of ten agreed on 81 cases. Only three cases had a top tool family supported by four or fewer models, and four cases tied for the plurality. The mean plurality was 8.34 models out of ten.

Some pairwise tool-family agreements were especially strong:

| Pair | Same tool family |
| --- | ---: |
| GLM-5.2 ↔ DeepSeek V4 Flash | 87% |
| Claude Sonnet 5 ↔ Kimi K3 | 86% |
| Kimi K3 ↔ Tencent HY3 | 85% |
| DeepSeek V4 Flash ↔ Tencent HY3 | 84% |

That is the core frontier result. Kimi K3 and Sonnet 5 independently chose the same first tool on 86 of 100 prompts. The three inexpensive Chinese text models also formed a very coherent planner cluster.

## The top three win narrowly—and without vision

DeepSeek V4 Flash is the cleanest cost-performance surprise. It leads exact-action consensus, emits 90 valid calls, matches 39 ideal tool names, and finishes with a 1.56-second median. The complete 100-call replay cost five cents. Its 39.63-second maximum was a single tail outlier; p95 stayed at 5.24 seconds.

HY3 is the steadier second-place result. It is only 2.8 consensus points behind DeepSeek, selects 41 ideal tools, and has no schema-invalid output. At $0.246 for the replay, it remains inexpensive enough to put behind retries or a verifier.

GLM-5.2 has the group's best exact-ideal count at 20, tied neither to consensus nor to Sonnet. It is fast at 1.73 seconds median and has a tight 4.44-second p95. Three calls failed schema validation because the accessibility filter contained a stray quote—`visible"`—which is a small generation defect with a large production consequence if the caller does not validate arguments.

All three results come with the same downside: **the tested routes are text-only**. They can plan over URLs, accessibility trees, extracted page text, and prior tool state. They cannot serve as WebBrain's only model when a canvas app, chart, CAPTCHA-like visual boundary, broken accessibility tree, or screenshot contains the decisive information.

This does not invalidate the ranking. It changes the label: DeepSeek, HY3, and GLM-5.2 are the leading **text-state first-action planners** in this ten-model run.

## Kimi K3 is the frontier-gap result

[Kimi K3](https://huggingface.co/moonshotai/Kimi-K3) is enormous: 2.8T total parameters, 104B active, 93 layers, and a 1M context architecture. The route completed 97 of 100 cases with valid tool calls, selected the ideal tool 44 times, and agreed with Sonnet's tool family on 86 cases.

Sonnet still leads on the basic dispatch metrics—98 valid calls and 47 ideal tools—and was more than three seconds faster at the median in this sample. Kimi's 7.54-second median and 26.15-second p95 were the slowest in the group. But the quality gap is no longer categorical. On this task, Kimi looks like a frontier multimodal peer with a worse serving profile, not a separate model tier.

Cost needs careful wording. Kimi's **observed replay cost** was $1.563 versus Sonnet's $7.222, but that does not mean Kimi had the lower list price. At test time, OpenRouter listed Kimi at $3/$15 per million input/output tokens, while Sonnet 5 had introductory $2/$10 pricing. Kimi's run reported 91% of prompt tokens as cache reads; Sonnet reported none. The workload bill favored Kimi because the route cached repeated tool-schema input, not because its headline token price was lower.

That distinction is exactly why we include both price and observed cost.

## MiniMax M3: still the best-balanced Claude-like value generalist

Our subjective product view still favors MiniMax M3 as the most attractive **Claude-like value generalist** in this set. That is not the same as claiming it won this table.

The measured first-action data does not make M3 the closest model to Sonnet 5. They chose the same tool family on 69 cases and the same normalized action on 49. Kimi, GLM, HY3, and DeepSeek all had higher tool-family agreement with Sonnet in this run.

M3's case is broader:

- 428B total parameters but only about 23B active per token;
- text, image, and video input on the tested route;
- roughly one million tokens of context;
- 2.85-second median latency;
- 89 emitted calls, 86 schema-valid;
- a $0.504 observed replay cost.

Three schema failures prevent an unqualified recommendation: an invalid `extract_data` enum, object-valued `clarify` options where strings were required, and an invalid `press_keys` key. Those are fixable with validation and retrying. More importantly, M3 delivers a much wider capability surface than the text-only leaders while costing about one-third of Kimi's observed replay and returning its median response 2.6 times faster.

So the evidence-based wording is: **M3 is not the consensus winner and was not the closest to Sonnet on first actions, but it remains our best overall balance of Claude-like agent behavior, multimodality, latency, context, and hosted cost.** Longer trajectories, prose quality, visual work, and recovery behavior require a different benchmark.

## GPT-5.6 is being cautious, not simply failing

The raw rank makes GPT-5.6 Luna and Terra look disastrous. The case traces tell a more specific story.

| GPT-5.6 route | `get_accessibility_tree` first | Direct-action cases | Ideal tool among direct actions | Exact ideal among direct actions |
| --- | ---: | ---: | ---: | ---: |
| Luna Pro | 54 | 46 | 32 / 46 (69.6%) | 3 / 46 (6.5%) |
| Terra Pro | 80 | 20 | 12 / 20 (60.0%) | 2 / 20 (10.0%) |

The current suite's ideal first action is never `get_accessibility_tree`; it expects the model to act from the state already present in the prompt. GPT-5.6 often asks for a fresh accessibility snapshot anyway. Other models sometimes agree: Luna's observation step matched the peer plurality in 41 of its 54 tree calls. Terra's matched in 43 of 80, but disagreed with the plurality in the other 37.

Would the numbers improve if we stripped those rows? Mechanically, yes: Luna's ideal-tool rate becomes 69.6% on the 46 cases where it chose a direct action, and Terra's becomes 60% on 20. But that is **selecting the cases after seeing the model's answer**. It rewards low coverage and does not reveal what either model would do after receiving the tree.

The correct follow-up is an observation-tolerant two-turn evaluation:

1. accept `get_accessibility_tree` as a provisional read step;
2. return a deterministic or real tree result;
3. score the next action, total latency, total tokens, and whether the extra observation changed the decision.

There is also an API mismatch worth disclosing. [OpenAI's GPT-5.6 guide](https://developers.openai.com/api/docs/guides/latest-model) recommends the Responses API for reasoning and tool-heavy multi-turn work because it can preserve reasoning and tool context. We tested OpenRouter's Chat Completions-compatible `openai/gpt-5.6-luna-pro` and `openai/gpt-5.6-terra-pro` routes, used no explicit reasoning-effort override, and stopped at the first action. The low rank is real for **this slot**; it is not evidence that GPT-5.6 performs poorly in a complete agent or in the direct OpenAI stack.

Luna is nevertheless interesting. OpenAI positions the Luna tier for efficient high-volume work, and its OpenRouter route cost only $0.228 for all 100 calls. If the two-turn test converts those cautious observations into good actions, Luna could become one of the most economical hosted planners in the set.

## Reliability: perfect API delivery is not perfect tool delivery

All ten routes completed every HTTP request without an API error. That is unusually clean. Tool-level dispatch was less uniform.

| Model | No tool emitted | Schema-invalid calls | Main defect |
| --- | ---: | ---: | --- |
| Claude Sonnet 5 | 2 | 0 | — |
| Kimi K3 | 3 | 0 | — |
| GPT-5.6 Terra Pro | 6 | 0 | — |
| Qwen 3.6 27B | 8 | **9** | Mostly quoted or malformed accessibility `filter`; one invalid key |
| DeepSeek V4 Flash | 10 | 0 | — |
| Tencent HY3 | 10 | 0 | — |
| GPT-5.6 Luna Pro | 11 | 0 | — |
| MiniMax M3 | 11 | 3 | Invalid enum/options/key values |
| GLM-5.2 | 11 | 3 | Stray quote in accessibility filter |
| Inkling Small | 16 | 0 | — |

“No tool” is not an API failure. It means the model answered in prose or stopped without dispatching a structured action. Depending on the prompt, that can be sensible boundary behavior. A schema-invalid action is different: the intent may be obvious to a person, but a strict agent cannot safely execute it.

Qwen's nine validation failures are the biggest operational warning in the suite. Most are variants of a quoted `visible` accessibility filter, suggesting one compact adapter-side repair could recover much of the row. Until that repair exists, the agent should validate, normalize only unambiguous values, and retry rather than passing malformed arguments to the browser.

## Cost: list price and workload price tell different stories

These were the OpenRouter list prices visible at test time, followed by the actual `usage.cost` sum in the saved responses. Prices can change, and provider routing or cache policy can change even when a model slug does not.

| Model | Input / output per 1M tokens | Prompt tokens reported cached | Actual 100-call cost |
| --- | ---: | ---: | ---: |
| DeepSeek V4 Flash 0731 | $0.09 / $0.18 | 96.8% | **$0.050** |
| GPT-5.6 Luna Pro | $0.10 / $0.60 | 80.0% | $0.228 |
| Inkling Small | $0.50 / $1.20 | 98.3% | $0.243 |
| Tencent HY3 | $0.132 / $0.528 | 32.6% | $0.246 |
| MiniMax M3 | $0.30 / $1.20 | 36.3% | $0.504 |
| GLM-5.2 | $0.42 / $1.32 | 91.0% | $0.545 |
| Qwen 3.6 27B | $0.30 / $2.00 | 87.4% | $0.670 |
| Kimi K3 | $3.00 / $15.00 | 91.0% | $1.563 |
| GPT-5.6 Terra Pro | $1.00 / $6.00 | 80.3% | $2.238 |
| Claude Sonnet 5 | $2.00 / $10.00 introductory | **0%** | **$7.222** |

The ten replays cost **$13.509 in total**. Sonnet alone accounted for 53.5% of that bill. DeepSeek delivered the highest exact-consensus score for 0.7% of Sonnet's observed cost, but that ratio depends heavily on DeepSeek's 96.8% cache-read share and Sonnet's zero.

The practical cost lessons are narrower:

- DeepSeek is astonishingly cheap for repeated-schema text planning on this route.
- HY3's low list price works even without a huge reported cache benefit.
- Luna is a credible budget route if a two-turn observation flow validates its behavior.
- M3 occupies a useful middle: inexpensive, multimodal, and faster than Kimi.
- Kimi's observed bill was much lower than Sonnet's, but its list price was higher under Sonnet's temporary introductory pricing.
- Local Qwen has hardware and electricity cost, but no metered API token bill and no provider-side data path.

## What about GLM-5.2 vision?

The OpenRouter `z-ai/glm-5.2` route in this test is text-only. There is a separate community effort to graft and quantize vision support, including [0xSero's four-GPU GLM-5.2 Vision build](https://huggingface.co/blog/0xSero/glm52-vision-on-4-gpus) and a [Baseten NVFP4 checkpoint](https://huggingface.co/baseten/GLM-5.2-Vision-NVFP4).

Those artifacts are worth sharing because they show a plausible route toward a more complete GLM agent. They are **not** evidence that the route we tested had vision, are not an official substitute for this text run, and are nowhere near a single-5090 deployment. The community build describes a roughly 341GB four-GPU configuration and explicitly lacks a full vision benchmark. We have not tested it, so it receives no score here.

## American open weights are back in the conversation

The American open-weight claim requires restraint. Inkling Small ranks eighth in exact consensus here, emits only 84 tool calls, and is not a score champion. Its significance is the product surface: a 12B-active downloadable model with text, image, and audio input, 1.05-second median latency on the tested hosted route, and a $0.243 replay cost.

It also does not stand alone. Our earlier [full-size Inkling test](/blog/thinking-machines-inkling-openrouter-planner-benchmark/) verified image and audio input and found a highly parseable, broad model. Poolside's [Laguna S 2.1 test](/blog/poolside-laguna-s-openrouter-planner-benchmark/) showed an extraordinarily inexpensive 118B-A8B American coding model, while [Laguna M.1](/blog/poolside-laguna-m1-openrouter-planner-benchmark/) fixed much of S's no-tool problem at 225B-A23B.

Those Poolside rows came from the older frozen suite and must not be numerically inserted into this new consensus table. Strategically, however, they matter. Six months ago, the cheap open-weight agent conversation was dominated by Qwen, MiniMax, Tencent, DeepSeek, StepFun, and Z.ai. Thinking Machines and Poolside now give US developers credible downloadable options at three different scales and with different modality tradeoffs.

The gap is narrowing. It is **not closed**. Chinese open-weight models occupy the top three consensus positions in this run, and Kimi supplies the strongest multimodal frontier row. American open weights now offer serious alternatives; they do not yet dominate this benchmark.

## Chinese frontier models are closing a different gap

The second gap is between Chinese labs and the leading closed US frontier APIs. This test supplies three different kinds of evidence:

1. **Kimi K3 nearly matches Sonnet's dispatch reliability** and agrees with its first tool on 86% of cases while remaining open-weight and multimodal.
2. **GLM-5.2 leads Sonnet in reference-free exact consensus** and exact-ideal count, but the tested route is text-only and has three schema failures.
3. **DeepSeek V4 Flash and HY3 turn strong planner agreement into commodity-priced inference**, again with the text-only limitation.

That is convergence, not equivalence. Sonnet still has the best schema-valid call rate and ideal tool-name count. GPT-5.6 is under-measured by this one-turn design. Vision, audio, computer-use trajectories, coding recovery, safety boundaries, multilingual prose, and provider reliability can all reverse a deployment choice.

Still, “Chinese models are cheaper but clearly a tier behind” is no longer a useful default. In first-action planning, the leading Chinese open-weight routes are peers with distinct modality and serving tradeoffs. Kimi K3 and GLM-5.2 make the frontier gap visibly narrower; DeepSeek and HY3 make the economics harder for every hosted competitor.

## What we would deploy for each job

| Deployment need | Our pick from this group | Why |
| --- | --- | --- |
| Cheapest hosted text-state planner | **DeepSeek V4 Flash** | Highest exact consensus, 1.56s median, $0.050 replay |
| Conservative text-only alternative | **Tencent HY3** | Second consensus rank, 41 ideal tools, clean schema, low list price |
| Closed multimodal dispatch reliability | **Claude Sonnet 5** | 98 valid calls and 47 ideal tool choices |
| Open-weight multimodal frontier | **Kimi K3** | 97 valid calls, 44 ideal tools, 86% tool agreement with Sonnet |
| Best-balanced Claude-like value generalist | **MiniMax M3** | Image/video, 1M context, 23B active, good latency and observed cost |
| Audio-capable open-weight route | **Inkling Small** | Text, image, and audio with a 12B-active footprint |
| High-volume route to retest in two turns | **GPT-5.6 Luna** | Very low list price; direct actions were often sensible after cautious observation was excluded |
| One RTX 5090, private and offline | **Qwen 3.6 27B quantized** | Dense 27B, multimodal, practical 32GB-class local deployment |

The last row deserves emphasis. **Qwen 3.6 27B is still the best model in this set to run on a consumer RTX 5090 box.** This new Qwen result used OpenRouter, not our local GPU, so its latency is not a hardware comparison. The hardware recommendation also draws on our earlier [local Qwen 3.6 27B NVFP4 planner run](/blog/qwen36-27b-nvfp4-planner-benchmark/), where the model reached a 1.76-second median with native structured tools.

The model is not perfect. The hosted full-suite row has nine schema-invalid calls, and a 27B dense model needs a 4-bit-class quantization rather than BF16 to leave useful room on a 32GB GPU for KV cache and concurrency. But no 284B–2.8T MoE in this table is a realistic single-card alternative. Qwen gives up some hosted frontier quality in exchange for privacy, offline availability, predictable marginal cost, multimodality, and a deployment an individual can actually own.

## Bottom line

This benchmark does not produce one universal winner. It produces a much more interesting map.

DeepSeek V4 Flash, Tencent HY3, and GLM-5.2 lead reference-free first-action consensus, but they are text-only on the tested routes. Claude Sonnet 5 is the most reliable dispatcher by valid-call and ideal-tool counts, at the highest observed replay cost. Kimi K3 is close enough to Sonnet on dispatch behavior to make Chinese frontier convergence concrete, although it is slower and not cheap at list price. MiniMax M3 does not win consensus or measured Sonnet agreement, yet remains our best-balanced Claude-like multimodal value generalist. GPT-5.6's cautious tree-first behavior demands a fair two-turn test before anyone draws a broad capability conclusion.

The geopolitical conclusion should be equally precise. **American and Chinese open-weight ecosystems are getting closer** because Thinking Machines and Poolside have restored credible US options across multimodal generalists and coding specialists. The Chinese ecosystem still leads this particular planner table. At the same time, **Chinese labs are closing the frontier-model gap**: Kimi K3 approaches Sonnet's action reliability, while GLM, DeepSeek, and Tencent make strong planning dramatically cheaper.

For a hosted system, choose by modality, latency, cache behavior, and tool reliability—not nationality or one benchmark number. For a consumer workstation, the answer is simpler: **Qwen 3.6 27B remains the most convincing model here for a single RTX 5090.** It is not the largest or the highest-scoring route. It is the model whose capability, modality, ownership, and hardware requirements meet in a machine people can actually put under a desk.

## Raw results

The committed result directories are:

```text
test/llm/results/2026-08-02-gpt56-luna-full_chrome_openai_gpt-5.6-luna-pro
test/llm/results/2026-08-02-minimax-m3-full_chrome_minimax_minimax-m3
test/llm/results/2026-08-02-claude-sonnet5-full_chrome_anthropic_claude-sonnet-5
test/llm/results/2026-08-02-glm52-full_chrome_z-ai_glm-5.2
test/llm/results/2026-08-02-deepseek-v4-flash-full_chrome_deepseek_deepseek-v4-flash-0731
test/llm/results/2026-08-02-inkling-small-full_chrome_thinkingmachines_inkling-small
test/llm/results/2026-08-02-qwen36-27b-full_chrome_qwen_qwen3.6-27b
test/llm/results/2026-08-02-kimi-k3-full_chrome_moonshotai_kimi-k3
test/llm/results/2026-08-02-gpt56-terra-full_chrome_openai_gpt-5.6-terra-pro
test/llm/results/2026-08-02-tencent-hy3-full_chrome_tencent_hy3
```

The derived reference-free ranking, token totals, latency percentiles, and cost sums are saved in:

```text
test/llm/results/2026-08-02-full-suite-consensus.json
```

No request bodies or API keys are stored in those files.

Tags: #OpenWeights #OpenRouter #DeepSeekV4 #TencentHY3 #GLM52 #KimiK3 #MiniMaxM3 #ClaudeSonnet5 #GPT56 #Inkling #Qwen36 #RTX5090 #ToolCalling #BrowserAgent #WebBrain
