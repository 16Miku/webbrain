# Vision model benchmark

This directory turns the one-shot `test/vision-probe.mjs` check into a reproducible 100-case benchmark for the exact screenshot-description sub-call used by WebBrain's `inspect_viewport`, screenshot tools, and auto-screenshot routing.

The default run sends every image with the production `VISION_SYSTEM_PROMPT`, production user text, temperature `0`, `max_tokens: 800`, and the same thinking-disabling chat-template kwargs as the one-shot probe. Cases are ordered from easy to challenging:

| IDs | Difficulty | What changes |
| --- | --- | --- |
| 001–020 | Easy | One dominant control or state, large text, little clutter |
| 021–040 | Basic | Multiple inputs, filters, rows, or visual relations |
| 041–060 | Intermediate | Errors, blockers, charts, row association, transient state |
| 061–080 | Advanced | Multilingual OCR, dense data, overlays, visual comparison |
| 081–100 | Challenging | Conflicting signals, tiny/partial text, severe occlusion, calibration |

Twenty category families cover authentication, search, checkout, validation, modals, toasts, loading, consent, dashboards, charts, tables, email, kanban, calendars, maps, photos, multilingual OCR, occlusion, security challenges, and unreadable/unknown content.

## Layout

```text
test/vision/
├── questions/NNN.json       # image, category, difficulty, focus question
├── expected/NNN.json        # deterministic weighted checks and critical facts
├── images/NNN.png           # 1280×720 browser viewport fixture
├── assets/                  # four open-license source images + attribution
├── fixtures/                # case definitions and HTML renderer
├── lib/score.mjs            # one shared grader
├── build-corpus.mjs         # regenerates questions/expected/manifest
├── render.mjs               # regenerates PNGs with local Playwright Chromium
├── validate.mjs             # validates schema, images, uniqueness, prompt parity
└── run.mjs                  # live OpenAI-compatible benchmark runner
```

## Run the suite

```bash
# Local llama.cpp-style endpoint
node test/vision/run.mjs --model Gemma-4-E2B-It

# LM Studio / Ollama / another OpenAI-compatible server
node test/vision/run.mjs --base http://127.0.0.1:1234/v1 --model molmo2-8b

# Small smoke subset spanning all difficulty bands
node test/vision/run.mjs --model molmo2-8b --only 1,21,41,61,81

# Hosted endpoint
VISION_PROBE_KEY=... node test/vision/run.mjs \
  --base https://openrouter.ai/api/v1 --model openai/gpt-4o
```

Useful selectors: `--difficulty 5`, `--category chart-reading`, `--concurrency 4`, `--resume`, and `--tag my-run`. Results land under `test/vision/results/<tag>_<model>_<prompt-mode>/`; result files include image/prompt hashes, latency, raw response, per-check evidence, per-dimension scores, and the binary success verdict. `summary.json` aggregates success rate and mean score by difficulty and category.

`--prompt-mode production` is the default and measures WebBrain as shipped. `--prompt-mode question` appends the case's focus question for a secondary targeted-VQA comparison; do not mix those results with production-mode scores.

## Scoring

The grader checks facts in the production six-section response: page purpose, exact visible strings, input states, state signals, blockers, and unknowns. Spatial/chart/photo checks may inspect the whole response. Exact UI strings are case-sensitive. A case succeeds only when its weighted score reaches the case threshold and every critical check passes. This keeps a fluent but hallucinated caption from counting as success.

## Regenerate and validate

```bash
node test/vision/build-corpus.mjs
node test/vision/render.mjs --force
node --test test/vision/lib/score.test.mjs
node test/vision/validate.mjs
```

The renderer is offline and deterministic. The four open-license image sources and attributions are documented in `assets/SOURCES.md`. When the production vision prompt changes, update `prompt.mjs` and `test/vision-probe.mjs`; validation intentionally fails until Chrome, Firefox, and both probes match.
