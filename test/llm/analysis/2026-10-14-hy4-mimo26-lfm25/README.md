# HY4 Preview, MiMo V2.6, and Liquid LFM2.5 campaign

Prepared October 14, 2026. **Live inference is pending a fresh OpenRouter key. No new benchmark scores or measured bills are claimed yet.** The last supplied credential expired October 7, and no API key is configured in the workspace environment.

Requested models:

- `tencent/hy4-preview`: native tools, text-only route.
- `xiaomi/mimo-v2.6-pro`: native tools and image/video/audio input.
- `xiaomi/mimo-v2.6-flash`: native tools and image/video/audio input.
- `liquid/lfm-2.5-24b-a2b`: native tools, text-only route.

`config.json` records all planned output paths and settings. Public endpoint responses retrieved October 14 are archived in `openrouter-endpoints.json`. Endpoint metadata establishes advertised capabilities and rates, not measured model quality.

All four planner runs will replay the full-tier August source `7182c21f58a94689c2ac3b547a279b9c5e699283`: 100 Chrome Act cases, 48 structured tools, temperature 0.15, max_tokens 4096, and no reasoning or compatibility override. The existing snapshot SHA-256 is `3d27c43da02747496dbd050a366ef6188f14eaf99a5b41de35e5c55581669062`. `rubrics.json` archives the matching ideal actions. This is a first-action-only test: no tools are executed, and ideal conformity is not task completion.

The report first reproduces the original 13-model/1,300-response consensus, schema validity, ideal-name, and exact-ideal metrics. Once four complete new runs exist, all 17 models are rescored against their other 16 peers: 1,600 comparisons per model. Only object keys are recursively sorted; argument values and extra/default arguments are retained. Historical percentages are not copied unchanged into a new pool. Native dispatch, content fallback, malformed argument JSON, and schema validity are reported separately.

Both MiMo models will also receive the 100-screenshot production vision suite: the original six-section prompt, temperature 0, max_tokens 800, unchanged thinking-disabling kwargs, and provider auto-routing. HY4 and LFM are not assigned vision scores. The report compares against the saved August 27 Qwen3.8 Flash and GLM-5.3 Flash runs and already reproduces all 200 of those grades, with unchanged images/prompts/rubrics/scorer. UTC timestamps in those raw files begin August 26; their original local test date and run tag are August 27.

Vision strict passes combine weighted substring checks and a section-structure score with the case threshold and critical-check gate. Six numbered sections are measured separately rather than required as an independent binary gate. Some recognized synonyms may fail literal matching; numbered drafting prose can resemble sections. Reasoning token usage and finish reasons are retained so output-budget effects are visible. Missing historical finish reasons remain null, not zero.

The old planner requests were omitted, so their full body equality with the source reconstruction cannot be proved. All new planner requests and API responses will be saved. New vision runs retain raw SSE, final text, usage, provider, finish reason, latency, prompt metadata, and image hashes; shared PNGs remain under `test/vision/images`. Never save API keys or authorization headers.

After setting `OPENROUTER_API_KEY` in the process environment:

```powershell
node test/llm/run-hy4-mimo26-lfm25.mjs --preflight
node test/llm/run-hy4-mimo26-lfm25.mjs
node test/llm/report-hy4-mimo26-lfm25.mjs
npm run test:vision:validate
node scripts/build-blog.mjs
```

The orchestrator authenticates before inference and refuses to overwrite existing evidence. Six independent runners execute concurrently, with concurrency three per planner model and two per vision model. Preflights have separate result tags and are excluded from scored 100-case suites. All raw preflight/full-run results, errors, and logs must be committed and pushed with the post. Archive failures before targeted recovery; retain the first successful inference per case rather than rerunning successful cases to improve scores.

Historical/offline preparation can be verified without a key:

```powershell
node test/llm/prepare-hy4-mimo26-lfm25.mjs
node test/llm/report-hy4-mimo26-lfm25.mjs --historical-only
```
