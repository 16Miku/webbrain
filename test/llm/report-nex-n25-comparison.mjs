#!/usr/bin/env node
// Recompute the article's numbers from saved responses; no API calls or secrets.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepEqual } from './lib/score.mjs';
import { buildPayload, loadFrozenBaseline } from './lib/build-payload.mjs';
import { prepareMessagesForChatTemplate, getChatTemplateCompat } from './lib/chat-template-compat.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const out = join(here, 'analysis/2026-10-03-nex-n25');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const repoPath = path => relative(root, path).replaceAll('\\', '/');
const freezePath = join(here, 'freeze/baseline-2026-05-23.json');
const baseline = read(freezePath);
const rubrics = read(join(out, 'rubrics.json'));
const compactRubrics = read(join(out, 'compact-rubrics.json'));
loadFrozenBaseline(freezePath);
assert.equal(sha(baseline.systemContent), baseline.meta.systemHash);
assert.equal(baseline.tools.length, 41);
const names = new Set(baseline.tools.map(t => t.function.name));
const sonnetDir = join(here, 'results/2026-05-23T18-47-31-246Z_chrome_anthropic_claude-sonnet-4.6');
const configs = [
  { label: 'Nex-N2.5-Pro', protocol: 'frozen-native', fresh: true,
    dir: '2026-10-03-openrouter-nex-n25-pro_chrome_nex-agi_nex-n2.5-pro_frozen' },
  { label: 'Nex-N2.5-mini', protocol: 'frozen-native', fresh: true,
    dir: '2026-10-03-openrouter-nex-n25-mini_chrome_nex-agi_nex-n2.5-mini_frozen' },
  { label: 'MiniMax M3 (historical)', protocol: 'frozen-native',
    dir: '2026-06-21-openrouter-minimax-m3_chrome_minimax_minimax-m3_frozen' },
  { label: 'Nex-N2-mini (historical)', protocol: 'frozen-native',
    dir: '2026-07-08-openrouter-nex-n2-mini_chrome_nex-agi_nex-n2-mini_frozen' },
  { label: 'Qwen 3.8 27B (historical)', protocol: 'compact-native',
    dir: 'compact-benchmark-v1-openrouter-20260905T184456-qwen-qwen3.8-27b-first-turn-100_chrome_qwen_qwen3.8-27b_compact' },
  { label: 'Nex-N2.5-mini fallback smoke', protocol: 'frozen-text-fallback-smoke', fresh: true, count: 3,
    dir: '2026-10-03-openrouter-nex-n25-mini-text-fallback-smoke_chrome_nex-agi_nex-n2.5-mini_frozen' },
];
const bands = [
  [1, 10, 'navigation'], [11, 15, 'browser-internals'], [16, 25, 'search'],
  [26, 33, 'page-reading'], [34, 41, 'forms'], [42, 47, 'github'],
  [48, 53, 'email'], [54, 59, 'downloads'], [60, 63, 'shopping'],
  [64, 67, 'scroll-inspect'], [68, 75, 'ambiguity'], [76, 81, 'destructive'],
  [82, 86, 'knowledge'], [87, 90, 'tab-management'], [91, 94, 'ui-mutations'],
  [95, 97, 'translation-accessibility'], [98, 100, 'multi-page'],
];
const rows = [];
const evidence = [];
const table = [
  '| Model | Protocol | API responses | Parsed calls | Exact ideal | Ideal tool name | Sonnet tool-name alignment | Median | Reported cost |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
];
const quantile = (values, p) => values[Math.ceil(values.length * p) - 1];
for (const config of configs) {
  const dir = join(here, 'results', config.dir);
  const summary = read(join(dir, 'summary.json'));
  const files = readdirSync(dir).filter(f => /^\d{3}\.json$/.test(f)).sort();
  assert.equal(files.length, config.count || 100, `${config.label}: missing cases`);
  assert.equal(summary.cases, files.length);
  if (config.protocol === 'compact-native') {
    assert.equal(summary.tier, 'compact');
    assert.equal(summary.freeze, null);
  } else {
    assert.equal(summary.freeze.systemHash, baseline.meta.systemHash);
    assert.equal(summary.freeze.toolCount, 41);
  }
  const row = { label: config.label, model: summary.model, protocol: config.protocol,
    source: repoPath(dir), cases: files.length, errors: 0, responses: 0,
    parsedCalls: 0, nativeCalls: 0, contentFallbackCalls: 0, validToolNames: 0,
    exactIdeal: 0, idealToolName: 0, sonnetMatches: 0, sonnetTooledMatches: 0,
    sonnetTooledCases: 0, lengthLimited: 0, costRecords: 0, reportedCostUsd: 0,
    promptTokens: 0, completionTokens: 0, reasoningTokens: 0,
    byTool: {}, byCategory: {}, disagreements: [], providers: {} };
  const latencies = [];
  for (const file of files) {
    const path = join(dir, file);
    const bytes = readFileSync(path);
    const result = JSON.parse(bytes);
    const question = read(join(here, 'questions', file));
    const trackRubrics = config.protocol === 'compact-native' ? compactRubrics : rubrics;
    const rubric = trackRubrics.cases[result.id];
    const ideal = rubric.idealFirstToolCall;
    const sonnetPath = join(sonnetDir, file);
    const sonnet = read(sonnetPath);
    assert.equal(result.id, file.slice(0, 3));
    assert.equal(result.user, question.user);
    assert.deepEqual(result.tab, question.tab);
    if (config.fresh) {
      const payload = buildPayload(question, { browser: 'chrome' });
      const fallback = config.protocol.endsWith('smoke');
      const compat = getChatTemplateCompat({ value: fallback ? 'alternating' : 'off' });
      const request = { model: summary.model, temperature: question.mode === 'ask' ? 0.3 : 0.15,
        max_tokens: 4096, messages: prepareMessagesForChatTemplate(payload.messages, compat, { tools: payload.tools }) };
      if (!fallback) request.tools = baseline.tools;
      assert.deepEqual(result.request, request, `${config.label}/${file}: request drift`);
      assert(result.error || result.response?.choices?.length, `${file}: missing response and error`);
      if (result.response) assert.equal(result.response.model, summary.model);
      if (config.label === 'Nex-N2.5-mini') {
        assert.match(result.error || '', /^HTTP 404: .*No endpoints found that support tool use/);
      }
    }
    const call = result.firstToolCall;
    const band = bands.find(([start, end]) => +result.id >= start && +result.id <= end)[2];
    const category = row.byCategory[band] ||= { cases: 0, errors: 0, calls: 0, exact: 0, idealName: 0, sonnetMatches: 0 };
    category.cases++;
    if (result.error) { row.errors++; category.errors++; }
    else {
      row.responses++;
      latencies.push(result.latencyMs);
      const refName = sonnet.firstToolCall?.name || null;
      if (config.protocol === 'frozen-native') {
        if ((call?.name || null) === refName) { row.sonnetMatches++; category.sonnetMatches++; }
        if (refName && call?.name === refName) row.sonnetTooledMatches++;
      }
      if (call?.name === ideal.name) {
        row.idealToolName++; category.idealName++;
        if (deepEqual(call.args, ideal.args)) { row.exactIdeal++; category.exact++; }
      }
    }
    if (sonnet.firstToolCall) row.sonnetTooledCases++;
    if (call) {
      row.parsedCalls++; category.calls++;
      if (names.has(call.name)) row.validToolNames++;
      if (result.toolCallSource === 'tool_calls') row.nativeCalls++;
      if (result.toolCallSource === 'content_fallback') row.contentFallbackCalls++;
    }
    const tool = call?.name || (result.error ? '(error)' : '(no-tool)');
    row.byTool[tool] = (row.byTool[tool] || 0) + 1;
    if (result.finishReason === 'length') row.lengthLimited++;
    const usage = result.usage;
    if (typeof usage?.cost === 'number') { row.costRecords++; row.reportedCostUsd += usage.cost; }
    row.promptTokens += usage?.prompt_tokens || 0;
    row.completionTokens += usage?.completion_tokens || 0;
    row.reasoningTokens += usage?.completion_tokens_details?.reasoning_tokens || 0;
    if (result.response?.provider) {
      row.providers[result.response.provider] = (row.providers[result.response.provider] || 0) + 1;
    }
    if (!result.error && call?.name !== ideal.name) row.disagreements.push({ id: result.id, ideal, actual: call });
    evidence.push({ model: summary.model, protocol: config.protocol, id: result.id,
      path: repoPath(path), sha256: sha(bytes), requestSha256: result.request ? sha(JSON.stringify(result.request)) : null,
      rubricSha256: trackRubrics.sourceHashes[result.id], sonnetSha256: sha(readFileSync(sonnetPath)) });
  }
  assert.equal(row.errors, summary.errors);
  assert.equal(row.parsedCalls, summary.withToolCall);
  latencies.sort((a, b) => a - b);
  const scoreable = row.responses === row.cases && row.cases === 100;
  row.status = row.errors === row.cases ? 'endpoint-blocked' : scoreable ? 'completed' : 'partial';
  // We have no saved compact schema for the historical Qwen request. Do not
  // validate a compact call against the unrelated frozen tool-name list.
  if (config.protocol === 'compact-native') row.validToolNames = null;
  row.medianLatencyMs = latencies.length ? (latencies[Math.floor((latencies.length - 1) / 2)] + latencies[Math.floor(latencies.length / 2)]) / 2 : null;
  row.p95LatencyMs = latencies.length ? quantile(latencies, 0.95) : null;
  row.averageLatencyMs = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  row.wallTimeMs = summary.totalLatencyMs;
  row.sonnetAlignmentPct = scoreable && config.protocol === 'frozen-native' ? row.sonnetMatches : null;
  row.sonnetTooledAlignmentPct = scoreable && config.protocol === 'frozen-native'
    ? 100 * row.sonnetTooledMatches / row.sonnetTooledCases : null;
  if (!row.costRecords) row.reportedCostUsd = null;
  if (!scoreable) { row.exactIdeal = null; row.idealToolName = null; }
  // Frozen rows use the May 23 goldens from the original comparison commit.
  // Keep the published historical scores reproducible despite later rubric edits.
  if (config.label.startsWith('MiniMax')) {
    assert.equal(row.exactIdeal, 17); assert.equal(row.idealToolName, 32); assert.equal(row.sonnetAlignmentPct, 75);
  }
  if (config.label === 'Nex-N2-mini (historical)') assert.equal(row.sonnetAlignmentPct, 65);
  rows.push(row);
  const score = n => n == null ? 'N/A' : `${n}/100`;
  table.push(`| ${row.label} | ${row.protocol} | ${row.responses}/${row.cases} | ${row.parsedCalls}/${row.cases} | ${score(row.exactIdeal)} | ${score(row.idealToolName)} | ${row.sonnetAlignmentPct == null ? 'N/A' : row.sonnetAlignmentPct.toFixed(1) + '%'} | ${row.medianLatencyMs == null ? 'N/A' : (row.medianLatencyMs / 1000).toFixed(2) + 's'} | ${row.reportedCostUsd == null ? 'N/A' : '$' + row.reportedCostUsd.toFixed(5)} |`);
}
mkdirSync(out, { recursive: true });
const notes = [
  'Only first model turns are captured. No browser tools are executed; this is not end-to-end task success or a vision benchmark.',
  'Strict exact ideal: tool name plus deep-equal arguments. Ideal tool name ignores arguments. Prose receives no ideal-tool credit.',
  'Sonnet alignment compares tool names, including agreement on no tool. It is reference agreement, not correctness.',
  'All frozen-native rows pin the May 23 system prompt and 41 tools. User context and site adapters are assembled by the runner; old requests were not saved, so historical payload byte equality is unverified.',
  'Qwen 3.8 27B is the saved September 5 compact run. It is contextual only and cannot be ranked against frozen rows.',
  'Frozen ideal scores use May 23 goldens archived from commit 0bbaf627ec2637898b587d5a7e5895f318f25bab, reproducing historical MiniMax M3 scores (17 exact / 32 ideal names). Qwen uses a separate captured compact rubric snapshot; these protocols cannot be ranked together.',
  'The mini native endpoint rejected all 100 requests before inference. Its performance and cost are N/A, not a 0% intelligence score or free inference.',
  'Fallback smoke folds system instructions into user text, lists tool names and requests textual tool calls. It omits structured schemas and is not the native frozen benchmark.',
  'Latency and reported usage cost are route- and date-specific; native runs use concurrency 2, historical Nex-N2-mini used 3, fallback smoke uses 1.',
  'No reasoning effort override, seed, top_p, or top_k was sent. Native temperature is 0.15 for action modes or 0.3 for ask, max_tokens 4096.',
];
const report = { schema: 'webbrain.nex-n25-comparison.v1', date: '2026-10-03',
  freeze: { path: repoPath(freezePath), sha256: sha(readFileSync(freezePath)), ...baseline.meta },
  rubrics: { path: repoPath(join(out, 'rubrics.json')), sha256: sha(readFileSync(join(out, 'rubrics.json'))), sourceRevision: rubrics.sourceRevision },
  compactRubrics: { path: repoPath(join(out, 'compact-rubrics.json')), sha256: sha(readFileSync(join(out, 'compact-rubrics.json'))) }, notes, rows };
writeFileSync(join(out, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(join(out, 'case-audit.json'), JSON.stringify({ schema: 'webbrain.nex-n25-case-audit.v1', records: evidence }, null, 2) + '\n');
writeFileSync(join(out, 'comparison.md'), table.join('\n') + '\n\n' + notes.map(n => `- ${n}`).join('\n') + '\n');
console.log(table.join('\n'));
console.log(`Verified ${evidence.length} saved case records; report: ${repoPath(out)}/comparison.json`);
