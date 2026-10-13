# HY4 Preview, MiMo V2.6, and Liquid LFM2.5 campaign

Completed October 14, 2026 (Istanbul; raw UTC timestamps begin October 13). **600/600 scored inference responses, six separate preflights, zero API errors, zero retries, and zero output-limit endings.** The scored bill is $0.6004711862; preflights add $0.0330258888 for $0.633497075 total. The full six-run campaign took 446,932 ms (7.45 minutes) with independent runners executing concurrently. A fresh credential authenticated before both stages; no credential is saved.

New planner results: Pro ranks 3/17 (43.6% exact consensus, 44 ideal tools, 95/95 schema-valid first calls, 6123 ms median, 46683 ms p95, $0.124612667); Flash ranks 7/17 (41.9%, 37, 96/97, 1195 ms, 4259 ms, $0.010978782); HY4 ranks 14/17 (27.5%, 36, 98/98, 5805.5 ms, 11638 ms, $0.2961319824); Liquid ranks 15/17 (24.9%, 23, 94/95, 1832 ms, 6677 ms, $0.0828711). No content-tool fallback was needed. Flash 058 misses `extract_data.type`; Liquid 092 sends an unsupported key enum. Schema validation and consensus inspect the first call only; multi-call responses remain in raw evidence.

Vision: Flash passes 81/100 (94.3% mean score, 1908 ms median, 4586 ms p95, $0.021394496); Pro passes 77/100 (94.0%, 5728 ms, 11589 ms, $0.0644821588). Both have 100 parsed six-section, nonempty outputs. Pro reports 1438 reasoning tokens despite the disabling kwargs; Flash reports zero. All 400 vision grades, including the two historical references, are reproduced from the unchanged scorer.

Requested models:

- `tencent/hy4-preview`: native tools, text-only route.
- `xiaomi/mimo-v2.6-pro`: native tools and image/video/audio input.
- `xiaomi/mimo-v2.6-flash`: native tools and image/video/audio input.
- `liquid/lfm-2.5-24b-a2b`: native tools, text-only route.

`config.json` records all output paths and settings. Public endpoint responses retrieved October 14 are archived in `openrouter-endpoints.json`. Endpoint metadata establishes advertised capabilities and rates, not measured model quality. Actual bills sum numeric `usage.cost` from every successful case. Providers are Tencent for HY4, Makora for Flash, Liquid for LFM, and DeepInfra (94)/Novita (6) for Pro's planner; all Pro screenshots use DeepInfra.

All four planner runs replay the full-tier August source `7182c21f58a94689c2ac3b547a279b9c5e699283`: 100 Chrome Act cases, 48 structured tools, temperature 0.15, max_tokens 4096, and no reasoning or compatibility override. The existing snapshot SHA-256 is `3d27c43da02747496dbd050a366ef6188f14eaf99a5b41de35e5c55581669062`. `rubrics.json` archives the matching ideal actions. This is a first-action-only test: no tools are executed, and ideal conformity is not task completion.

The report first reproduces the original 13-model/1,300-response consensus, schema validity, ideal-name, and exact-ideal metrics. All 17 models are then rescored against their other 16 peers: 1,600 comparisons per model. Only object keys are recursively sorted; argument values and extra/default arguments are retained. Historical percentages are not copied unchanged into a new pool. Native dispatch, content fallback, malformed argument JSON, and schema validity are reported separately.

Both MiMo models also receive the 100-screenshot production vision suite: the original six-section prompt, temperature 0, max_tokens 800, unchanged thinking-disabling kwargs, and provider auto-routing. HY4 and LFM are not assigned vision scores. The report compares against the saved August 27 Qwen3.8 Flash and GLM-5.3 Flash runs and reproduces all 200 of those grades, with unchanged images/prompts/rubrics/scorer. UTC timestamps in those raw files begin August 26; their original local test date and run tag are August 27.

Vision strict passes combine weighted substring checks and a section-structure score with the case threshold and critical-check gate. Six numbered sections are measured separately rather than required as an independent binary gate. Some recognized synonyms may fail literal matching; numbered drafting prose can resemble sections. Reasoning token usage and finish reasons are retained so output-budget effects are visible. Missing historical finish reasons remain null, not zero.

The old planner requests were omitted, so their full body equality with the source reconstruction cannot be proved. All new planner requests and API responses are saved. New vision runs retain raw SSE, final text, usage, provider, finish reason, latency, prompt metadata, and image hashes; shared PNGs remain under `test/vision/images`. Never save API keys or authorization headers.

Recorded live commands, after setting `OPENROUTER_API_KEY` in the process environment (use fresh tags for future inference; existing evidence is protected):

```powershell
node test/llm/run-hy4-mimo26-lfm25.mjs --preflight
node test/llm/run-hy4-mimo26-lfm25.mjs
node test/llm/report-hy4-mimo26-lfm25.mjs
npm run test:vision:validate
node scripts/build-blog.mjs
```

The orchestrator authenticates before inference and refuses to overwrite existing evidence. Six independent runners execute concurrently, with concurrency three per planner model and two per vision model. Preflights have separate result tags and are excluded from scored 100-case suites. All raw preflight/full-run results, errors, and logs must be committed and pushed with the post. Archive failures before targeted recovery; retain the first successful inference per case rather than rerunning successful cases to improve scores.

`comparison.json` contains every row of the full 17-model pool, planner and vision pairwise comparisons, schema defects, token/cache/provider evidence, and campaign accounting. `audit.json` records raw case and request hashes. `blog-verification.json` and PNGs record desktop/mobile checks of planner, vision, difficulty, usage, metadata, links, and index search; there were no page errors or page-level mobile overflow. Medians are the average of the middle two observations and p95 is nearest-rank, including for historical rows.

Historical/offline preparation can be verified without a key:

```powershell
node test/llm/prepare-hy4-mimo26-lfm25.mjs
node test/llm/report-hy4-mimo26-lfm25.mjs --historical-only
```
