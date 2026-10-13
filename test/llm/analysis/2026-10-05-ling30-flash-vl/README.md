# Ling 3.0 Flash VL vs Nex-N2.5 and MiniMax M3

October 5, 2026: an authenticated 100-case run of
`inclusionai/ling-3.0-flash-vl` through OpenRouter, plus a one-case authenticated
recheck of `nex-agi/nex-n2.5-mini`. The new mini request still returns HTTP 404
at the tool-compatibility routing filter before inference. Its earlier 100-case
rejection remains a route failure, not a model accuracy score.

The comparison reuses the saved October 3 Nex-N2.5-Pro and mini runs and the
June 21 MiniMax M3 run. All four rows use the May 23 frozen system prompt and
41 structured tool schemas. Ideal actions use the May 23 rubrics archived at
`../2026-10-03-nex-n25/rubrics.json`, pinned to commit
`0bbaf627ec2637898b587d5a7e5895f318f25bab`. The current live goldens are different;
they are deliberately not mixed into this frozen comparison.

Set `OPENROUTER_API_KEY` in your environment. Use a new tag to avoid
overwriting the original evidence:

```powershell
node test/llm/run-llamacpp.mjs --base https://openrouter.ai/api/v1 --model inclusionai/ling-3.0-flash-vl --tag YOUR-NEW-LING-TAG --concurrency 2 --timeout 180000 --freeze test/llm/freeze/baseline-2026-05-23.json
node test/llm/run-llamacpp.mjs --base https://openrouter.ai/api/v1 --model nex-agi/nex-n2.5-mini --tag YOUR-NEW-MINI-RECHECK-TAG --only 1 --concurrency 1 --timeout 30000 --freeze test/llm/freeze/baseline-2026-05-23.json
```

No provider was pinned and no reasoning-effort override was sent. Requests use
temperature 0.15 for action modes or 0.3 for Ask, and `max_tokens: 4096`.
All 100 Ling responses identify Novita as their provider. No responses hit
the output limit; no requests required retries. Expired-key attempts were
quarantined locally before the successful authenticated run and excluded
from this comparison. Credentials and authorization headers are not saved.

Regenerate the report offline:

```powershell
node test/llm/report-ling30-comparison.mjs
node --test test/llm/lib/score.test.mjs test/llm/lib/content-tool-call-parser.test.mjs
node scripts/build-blog.mjs
```

`comparison.json` contains metrics, category scores, provider counts, cache
usage, and an uncached pricing estimate. `comparison.md` is the table for
review. `case-audit.json` hashes 400 full-suite records plus the current mini
recheck. Every new Ling request is verified against the existing payload
builder, frozen prompt/tools, and archived rubrics. Raw native calls and
usage fields are checked against the saved API responses. Historical Nex
and MiniMax headline scores are reproduced. Historical MiniMax full requests
were not saved, so complete per-case payload byte equality is unverified.

The observed Ling cost sums all 100 saved `usage.cost` fields: $0.0097693652.
Of 1,810,646 prompt tokens, 1,715,520 (94.7463%) are marked cached. The
uncached estimate holds the observed token counts fixed and applies captured
Novita promotional prices ($0.021/M input and $0.0616/M output) to all tokens,
ignoring cache discounts: $0.0385901012. This estimate is not a second run.
Novita's advertised rates carry a 72% promotional discount. Price, cache
behavior, and route selection can change; historical cost ratios are not
controlled serving comparisons.

The suite captures only each model's first response and never executes tools.
It sends text only, despite Ling's image/video capabilities. Sonnet alignment
is tool-name agreement (including no-tool agreement), not correctness. Exact
ideal matching uses deep-equal arguments, and ideal-name scoring gives no
credit for terminal prose. A known tool name does not guarantee valid
arguments; Ling's case 075 emits malformed argument JSON for
`scratchpad_write` (`"replace": ,`). The runner catches the JSON parse failure
and records empty parsed arguments; the raw response retains the defect.
Of 90 native calls, 89 have parseable argument JSON. This is JSON parsing
coverage, not complete argument-schema validation.

Public endpoint snapshots for all four models and Ling's released configuration
include source URLs and retrieval timestamps. Browser verification and
desktop/mobile screenshots accompany the generated blog.
