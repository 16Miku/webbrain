#!/usr/bin/env node
// Offline report: all four models use the archived May 23 frozen goldens.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepEqual } from './lib/score.mjs';
import { buildPayload, isActionMode, loadFrozenBaseline } from './lib/build-payload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const out = join(here, 'analysis/2026-10-05-ling30-flash-vl');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const repoPath = file => relative(root, file).replaceAll('\\', '/');
const freezePath = join(here, 'freeze/baseline-2026-05-23.json');
const baseline = read(freezePath);
const rubricPath = join(here, 'analysis/2026-10-03-nex-n25/rubrics.json');
const rubrics = read(rubricPath);
loadFrozenBaseline(freezePath);
assert.equal(sha(baseline.systemContent), baseline.meta.systemHash);
assert.equal(baseline.tools.length, 41);
const toolNames = new Set(baseline.tools.map(t => t.function.name));
const sonnet = join(here, 'results/2026-05-23T18-47-31-246Z_chrome_anthropic_claude-sonnet-4.6');
const sources = [
  { label: 'Ling 3.0 Flash VL', date: '2026-10-05', fresh: true,
    dir: '2026-10-05-openrouter-ling30-flash-vl_chrome_inclusionai_ling-3.0-flash-vl_frozen' },
  { label: 'Nex-N2.5-Pro', date: '2026-10-03',
    dir: '2026-10-03-openrouter-nex-n25-pro_chrome_nex-agi_nex-n2.5-pro_frozen' },
  { label: 'Nex-N2.5-mini', date: '2026-10-03',
    dir: '2026-10-03-openrouter-nex-n25-mini_chrome_nex-agi_nex-n2.5-mini_frozen' },
  { label: 'MiniMax M3', date: '2026-06-21',
    dir: '2026-06-21-openrouter-minimax-m3_chrome_minimax_minimax-m3_frozen' },
];
const bands = [[1, 10, 'navigation'], [11, 15, 'browser-internals'], [16, 25, 'search'],
  [26, 33, 'page-reading'], [34, 41, 'forms'], [42, 47, 'github'], [48, 53, 'email'],
  [54, 59, 'downloads'], [60, 63, 'shopping'], [64, 67, 'scroll-inspect'],
  [68, 75, 'ambiguity'], [76, 81, 'destructive'], [82, 86, 'knowledge'],
  [87, 90, 'tab-management'], [91, 94, 'ui-mutations'],
  [95, 97, 'translation-accessibility'], [98, 100, 'multi-page']];
const rows = [], audit = [];
function verifyRequest(result) {
  const question = read(join(here, 'questions', `${result.id}.json`));
  const payload = buildPayload(question, { browser: 'chrome' });
  assert.deepEqual(result.request, { model: result.request.model,
    temperature: isActionMode(question.mode) ? 0.15 : 0.3, max_tokens: 4096,
    messages: payload.messages, tools: payload.tools }, `Request drift: ${result.id}`);
}
for (const source of sources) {
  const dir = join(here, 'results', source.dir);
  const summary = read(join(dir, 'summary.json'));
  const files = readdirSync(dir).filter(f => /^\d{3}\.json$/.test(f)).sort();
  assert.equal(files.length, 100);
  assert.equal(summary.cases, 100);
  assert.equal(summary.freeze.systemHash, baseline.meta.systemHash);
  assert.equal(summary.freeze.toolCount, 41);
  assert.equal(summary.structuredToolsSent, true);
  assert.equal(summary.chatTemplateCompat, 'off');
  const row = { label: source.label, model: summary.model, date: source.date,
    protocol: 'frozen-native', source: repoPath(dir), cases: 100, errors: 0,
    responses: 0, parsedCalls: 0, nativeCalls: 0, validToolNames: 0,
    exactIdeal: 0, idealToolName: 0, sonnetMatches: 0, sonnetTooledMatches: 0,
    sonnetTooledCases: 0, lengthLimited: 0, costRecords: 0, reportedCostUsd: 0,
    promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0,
    malformedNativeArgumentJson: source.fresh ? [] : null,
    byTool: {}, providers: {}, byCategory: {}, disagreements: [] };
  const latencies = [];
  for (const file of files) {
    const filePath = join(dir, file), bytes = readFileSync(filePath);
    const result = JSON.parse(bytes);
    assert.equal(result.id, file.slice(0, 3));
    const ideal = rubrics.cases[result.id].idealFirstToolCall;
    const referencePath = join(sonnet, file), reference = read(referencePath);
    if (result.request) {
      assert.equal(result.request.model, summary.model);
      assert.equal(result.request.messages[0].role, 'system');
      assert.equal(result.request.messages[0].content, baseline.systemContent);
      assert.deepEqual(result.request.tools, baseline.tools);
    }
    const band = bands.find(([start, end]) => +result.id >= start && +result.id <= end)[2];
    const category = row.byCategory[band] ||= { cases: 0, errors: 0, exactIdeal: 0, idealName: 0, sonnetMatches: 0 };
    category.cases++;
    if (source.fresh) {
      verifyRequest(result);
      assert.equal(result.request.model, summary.model);
      assert(!/^HTTP 40[13]:/.test(result.error || ''), 'Authentication failure cannot be scored.');
      if (result.response) assert.equal(result.response.model, summary.model);
      assert(result.error || result.response?.choices?.length, `Missing API output: ${file}`);
      if (result.response) {
        assert.deepEqual(result.usage, result.response.usage);
        const native = result.response.choices[0].message?.tool_calls?.[0];
        if (native) {
          let parsedArgs = {};
          try {
            parsedArgs = typeof native.function.arguments === 'string' ? JSON.parse(native.function.arguments) : native.function.arguments;
          } catch {
            // Match the existing runner's fallback while preserving the raw
            // JSON defect rather than treating the empty args as model intent.
            row.malformedNativeArgumentJson.push({ id: result.id, name: native.function.name,
              arguments: native.function.arguments });
          }
          assert.deepEqual(result.firstToolCall, { name: native.function.name, args: parsedArgs });
        }
        if (result.toolCallSource === 'tool_calls') assert(native, `Missing native call: ${file}`);
      }
    }
    if (reference.firstToolCall) row.sonnetTooledCases++;
    const call = result.firstToolCall;
    if (result.error) { row.errors++; category.errors++; }
    else {
      row.responses++;
      latencies.push(result.latencyMs);
      if ((call?.name || null) === (reference.firstToolCall?.name || null)) { row.sonnetMatches++; category.sonnetMatches++; }
      if (reference.firstToolCall && call?.name === reference.firstToolCall.name) row.sonnetTooledMatches++;
      if (call?.name === ideal.name) {
        row.idealToolName++; category.idealName++;
        if (deepEqual(call.args, ideal.args)) { row.exactIdeal++; category.exactIdeal++; }
      } else row.disagreements.push({ id: result.id, ideal, actual: call });
    }
    if (call) {
      row.parsedCalls++;
      if (result.toolCallSource === 'tool_calls') row.nativeCalls++;
      if (toolNames.has(call.name)) row.validToolNames++;
    }
    const name = call?.name || (result.error ? '(error)' : '(no-tool)');
    row.byTool[name] = (row.byTool[name] || 0) + 1;
    if (result.finishReason === 'length') row.lengthLimited++;
    if (typeof result.usage?.cost === 'number') { row.costRecords++; row.reportedCostUsd += result.usage.cost; }
    row.promptTokens += result.usage?.prompt_tokens || 0;
    row.completionTokens += result.usage?.completion_tokens || 0;
    row.reasoningTokens += result.usage?.completion_tokens_details?.reasoning_tokens || 0;
    row.cachedTokens += result.usage?.prompt_tokens_details?.cached_tokens || 0;
    if (result.response?.provider) row.providers[result.response.provider] = (row.providers[result.response.provider] || 0) + 1;
    audit.push({ model: summary.model, id: result.id, path: repoPath(filePath), sha256: sha(bytes),
      requestSha256: result.request ? sha(JSON.stringify(result.request)) : null,
      rubricSha256: rubrics.sourceHashes[result.id], sonnetSha256: sha(readFileSync(referencePath)) });
  }
  assert.equal(row.errors, summary.errors);
  assert.equal(row.parsedCalls, summary.withToolCall);
  assert.equal(row.sonnetTooledCases, 92);
  latencies.sort((a, b) => a - b);
  row.status = row.responses ? row.errors ? 'partial' : 'completed' : 'endpoint-blocked';
  row.medianLatencyMs = latencies.length ? (latencies[Math.floor((latencies.length - 1) / 2)] + latencies[Math.floor(latencies.length / 2)]) / 2 : null;
  row.p95LatencyMs = latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null;
  row.averageLatencyMs = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  row.wallTimeMs = summary.totalLatencyMs;
  row.sonnetAlignmentPct = row.responses ? row.sonnetMatches : null;
  row.sonnetTooledAlignmentPct = row.responses ? 100 * row.sonnetTooledMatches / 92 : null;
  if (!row.responses) { row.exactIdeal = null; row.idealToolName = null; }
  if (!row.costRecords) row.reportedCostUsd = null;
  if (row.label === 'Nex-N2.5-Pro') assert.deepEqual([row.exactIdeal, row.idealToolName, row.sonnetAlignmentPct], [11, 27, 67]);
  if (row.label === 'MiniMax M3') assert.deepEqual([row.exactIdeal, row.idealToolName, row.sonnetAlignmentPct], [17, 32, 75]);
  if (row.label === 'Nex-N2.5-mini') assert.equal(row.errors, 100);
  rows.push(row);
}
const ling = rows[0];
const endpointPath = join(out, 'ling-openrouter-endpoints.json');
const endpoint = read(endpointPath).data.data.endpoints.find(e => e.provider_name === 'Novita');
assert(endpoint, 'Missing captured Novita prices.');
ling.cachedPromptPct = 100 * ling.cachedTokens / ling.promptTokens;
ling.cachePricingProvider = endpoint.provider_name;
ling.coldCacheEstimateUsd = ling.promptTokens * Number(endpoint.pricing.prompt)
  + ling.completionTokens * Number(endpoint.pricing.completion);
ling.coldCacheEstimateMethod = 'Same recorded token counts and captured Novita promotional input/output rates, with all prompt tokens billed uncached; a pricing estimate, not an extra run.';
const recheckPath = join(here, 'results/2026-10-05-openrouter-nex-n25-mini-route-recheck_chrome_nex-agi_nex-n2.5-mini_frozen/001.json');
const recheck = read(recheckPath);
verifyRequest(recheck);
assert.equal(recheck.request.model, 'nex-agi/nex-n2.5-mini');
assert.match(recheck.error || '', /^HTTP 404: .*No endpoints found that support tool use/);
audit.push({ model: recheck.request.model, track: 'route-recheck', id: recheck.id,
  path: repoPath(recheckPath), sha256: sha(readFileSync(recheckPath)), requestSha256: sha(JSON.stringify(recheck.request)) });
const table = ['| Model | Date | API responses | Native calls | Exact ideal | Ideal name | Sonnet alignment | Median | p95 | Reported cost |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
const score = v => v == null ? 'N/A' : `${v}/100`;
const seconds = v => v == null ? 'N/A' : (v / 1000).toFixed(2) + 's';
for (const row of rows) table.push(`| ${row.label} | ${row.date} | ${row.responses}/100 | ${row.nativeCalls}/100 | ${score(row.exactIdeal)} | ${score(row.idealToolName)} | ${row.sonnetAlignmentPct == null ? 'N/A' : row.sonnetAlignmentPct.toFixed(1) + '%'} | ${seconds(row.medianLatencyMs)} | ${seconds(row.p95LatencyMs)} | ${row.reportedCostUsd == null ? 'N/A' : '$' + row.reportedCostUsd.toFixed(5)} |`);
const notes = [
  'First response only, text inputs only, no browser tool execution. These scores are not task completion or vision quality.',
  'All rows use the May 23 frozen system prompt and 41 tools, plus May 23 ideal goldens archived in the prior Nex report.',
  'Exact ideal requires deep-equal arguments; ideal name ignores arguments. Neither credits terminal prose. Sonnet alignment measures tool-name agreement including no-tool agreement.',
  'Historical MiniMax requests were not saved, so per-case message byte equality is unverified. New requests are checked against the payload builder; historical Nex requests retain the frozen system and tools.',
  'Latency and usage.cost are measured on different dates and provider routes. Provider auto-routing is retained; advertised promotional prices do not guarantee every request uses that provider.',
  'Nex mini remains unscored: its saved 100-case run and authenticated October 5 route recheck reject structured tools before inference.',
  'Expired-key attempts were quarantined before the authenticated run and are excluded from these metrics.',
];
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'comparison.json'), JSON.stringify({ schema: 'webbrain.ling30-comparison.v1', date: '2026-10-05',
  freeze: { path: repoPath(freezePath), sha256: sha(readFileSync(freezePath)), ...baseline.meta },
  rubrics: { path: repoPath(rubricPath), sha256: sha(readFileSync(rubricPath)), sourceRevision: rubrics.sourceRevision },
  routeRecheck: { path: repoPath(recheckPath), error: recheck.error }, notes, rows }, null, 2) + '\n');
writeFileSync(join(out, 'case-audit.json'), JSON.stringify({ schema: 'webbrain.ling30-case-audit.v1', records: audit }, null, 2) + '\n');
writeFileSync(join(out, 'comparison.md'), table.join('\n') + '\n\n' + notes.map(n => `- ${n}`).join('\n') + '\n');
console.log(table.join('\n'));
console.log(`Verified ${audit.length} saved records.`);
