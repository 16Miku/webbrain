# Accessibility-tree representation benchmark

Issue #3055 compares the shipped line-oriented accessibility tree with a
short-key NDJSON candidate and conventional full JSON. The benchmark is
inference-ready but does not change the production representation.

Run it with the exact tokenizer used for this report:

```text
node test/llm/accessibility-tree-benchmark.mjs \
  --out test/llm/analysis/accessibility-tree-benchmark/report.json
```

The fixture contains four representative surfaces, 65 nodes, 12 control
selection tasks, duplicate labels, form state, stable refs, and multi-page
trees. It is grounded in the existing AX contract and scenarios 034, 051, 053,
058, and 060 under `test/llm/`.

## Baseline result

Counts below are `o200k_base` tokens over the four complete tree contents. A
positive delta means the candidate used more tokens than the current line
format.

| Representation | Tree tokens | Token delta vs line | Paged wire tokens | Token delta vs line | Pages | Round-trip | Selection/ref integrity |
|---|---:|---:|---:|---:|---:|---:|---:|
| Current line text | 982 | — | 2,267 | — | 10 | 4/4 | 12/12, 35/35 |
| Compact short-key NDJSON | 1,603 | +63.24% | 3,255 | +43.58% | 12 | 4/4 | 12/12, 35/35 |
| Full JSON baseline | 1,703 | +73.42% | 4,178 | +84.30% | 17 | 4/4 | 12/12, 35/35 |

All representations preserve node order, explicit hierarchy depth, stable
`ref_id`s, and exact continuation arguments in the deterministic corpus. The
selection metric is representation availability—not model accuracy—because
the structural benchmark does not pretend that a parser round-trip proves an
LLM selected the right control.

The candidate formats are not compatible with the current workflow descriptor
parser (`src/chrome/src/agent/workflows.js` and its mirrored Firefox module):
the line parser recovered all 62 records, while JSON recovered none. Adopting a
candidate would therefore require an explicit representation/version boundary,
new parser coverage, and mirrored Chrome/Firefox changes. On this corpus there
is no material token benefit to justify that compatibility cost, so the shipped
line format remains the result.

## Luna spot check

Using Codex credits, `gpt-5.6-luna` evaluated the same 12 tasks against all
three representations with the target fields withheld during selection. It
returned valid JSON for all 36 requests and selected the correct action/ref in
12/12 cases for line text, compact NDJSON, and full JSON. The predictions were
identical across formats, so this controlled sample found no selection-quality
difference; it is not large enough to establish local-model or frontier-model
reliability. The token and compatibility disadvantages above still decide the
recommendation. The recorded result is
`test/llm/analysis/accessibility-tree-benchmark/luna-selection.json`.

## Model A/B runs

The script can run the same selection prompts against any OpenAI-compatible
endpoint:

```text
node test/llm/accessibility-tree-benchmark.mjs --infer \
  --base http://127.0.0.1:1234 --model local-model \
  --model-class compact --out compact.json
```

Run the same command for a frontier model, changing only the endpoint/model
label, then compare `inference.formats.*.passRate` and reported prompt-token
usage. Keep temperature, seed, prompt, and candidate task order fixed. Runs
against a real endpoint are intentionally separate from the checked-in
deterministic report because model credentials, availability, and outputs are
not stable repository fixtures.
