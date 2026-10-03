# Nex-N2.5 OpenRouter comparison — October 3, 2026

The native runs use the existing frozen May 23 system prompt and 41-tool
schema (`systemHash` starts with `5c4fac1387025050`). All requests and raw
API responses, where inference succeeded, are saved in `test/llm/results/`.
Authorization headers are never saved. Set `OPENROUTER_API_KEY` in your
environment before rerunning; no credential is stored in these artifacts.

Run from the repository root. Use a **new tag** for a new measurement so
the original evidence is preserved:

```powershell
node test/llm/run-llamacpp.mjs --base https://openrouter.ai/api/v1 --model nex-agi/nex-n2.5-pro --tag YOUR-NEW-PRO-TAG --concurrency 2 --timeout 180000 --freeze test/llm/freeze/baseline-2026-05-23.json
node test/llm/run-llamacpp.mjs --base https://openrouter.ai/api/v1 --model nex-agi/nex-n2.5-mini --tag YOUR-NEW-MINI-TAG --concurrency 2 --timeout 180000 --freeze test/llm/freeze/baseline-2026-05-23.json
```

Mini's native run rejected all 100 cases with HTTP 404 at OpenRouter's
tool-compatibility routing filter. Its endpoint snapshot does not list
`tools` or `tool_choice` in `supported_parameters`, although the public
model page advertises function calling. This is an observation of the
hosted route on this date, not a judgment about the underlying weights.

We also tested ordinary chat and a native request with
`provider.require_parameters: false` (`mini-probes.json`). Ordinary chat
timed out after 15 seconds; relaxing parameter requirements still gave
HTTP 404. An initial broad text-fallback attempt produced no saved responses
and was stopped. The recorded fallback smoke used three cases:

```powershell
node test/llm/run-llamacpp.mjs --base https://openrouter.ai/api/v1 --model nex-agi/nex-n2.5-mini --tag YOUR-NEW-FALLBACK-TAG --only 1,26,82 --concurrency 1 --timeout 20000 --freeze test/llm/freeze/baseline-2026-05-23.json --chat-template-compat alternating
```

All three smoke requests timed out. `alternating` folds the frozen system
instructions into user text and lists tool names without sending structured
schemas. This is a diagnostic fallback, **not** the native frozen test.
Mini's quality, inference latency, and reported inference cost remain N/A.

Recompute and validate the original comparison, without making API calls:

```powershell
node test/llm/report-nex-n25-comparison.mjs
node --test test/llm/lib/score.test.mjs test/llm/lib/content-tool-call-parser.test.mjs
node scripts/build-blog.mjs
```

`comparison.json` contains machine-readable metrics and category counts;
`comparison.md` contains the full table; `case-audit.json` hashes every
result, saved request, rubric, and Sonnet reference. The report checks that
each fresh request reproduces the existing payload builder and compatibility
shim, and that native system/tools match the frozen snapshot. Frozen ideal
scores use May 23 goldens archived in `rubrics.json` from commit
`0bbaf627ec2637898b587d5a7e5895f318f25bab`, before September's tab-tool and
screenshot rubric changes. This reproduces MiniMax M3's published 17 exact /
32 ideal tool names and 75% Sonnet alignment. Qwen's compact row uses the
separate `compact-rubrics.json` snapshot, captured on October 3.
"Valid tool names" is not argument-schema validation.

The historical MiniMax M3 and Nex-N2-mini rows use the same frozen system
and tools. Their full requests were not saved, so per-case message byte
equality cannot be established; user context and site adapters are assembled
by the runner. Qwen 3.8 27B is the saved September 5 **compact** first-turn
run and is contextual only. Its scores must not be ranked against frozen
rows, and its vision or scenario scores are not mixed into this comparison.

`*-openrouter-endpoints.json` and `*-hf-config.json` preserve public provider
pricing, capabilities, and model architecture with source URLs and retrieval
timestamps. These prices and availability can change. Actual run cost is the
sum of saved `usage.cost` fields, not a calculation from advertised rates.

Only the first model response is scored. No tool calls are executed, no
screenshots are sent, and this is not completed-task success. Sonnet alignment
measures tool-name agreement, including agreement on no call; strict ideal
matching requires deep-equal arguments and gives no credit for terminal prose.
