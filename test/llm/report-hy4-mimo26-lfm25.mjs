#!/usr/bin/env node
// Offline, auditable comparison against the pinned August full-tier cohort.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepEqual } from './lib/score.mjs';
import { OUT, DATE, MODELS, PLANNER_TAG, VISION_TAG, modelTag } from './prepare-hy4-mimo26-lfm25.mjs';
import { scoreVisionResponse } from '../vision/lib/score.mjs';
import { VISION_SYSTEM_PROMPT, PRODUCTION_USER_TEXT, REQUEST_DEFAULTS } from '../vision/prompt.mjs';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '../..');
const out = join(root, OUT);
mkdirSync(out, {recursive:true});
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const repoPath = path => relative(root, path).replaceAll('\\', '/');
const replayPath = join(here, 'freeze/full-replay-7182c21f.json');
const replay = read(replayPath), rubrics = read(join(out, 'rubrics.json'));
const historical = read(join(here, 'results/2026-08-02-full-suite-consensus.json'));
assert.equal(replay.meta.sourceCommit, rubrics.sourceCommit);
const resultDirs = readdirSync(join(here, 'results'));
const labels = {
  'deepseek/deepseek-v4-flash-0731': 'DeepSeek V4 Flash 0731',
  'tencent/hy3': 'Tencent HY3', 'z-ai/glm-5.2': 'GLM-5.2',
  'poolside/laguna-xs-2.1': 'Poolside Laguna XS 2.1',
  ...Object.fromEntries(MODELS.map(m => [m.model,m.label])),
  'minimax/minimax-m3': 'MiniMax M3',
};
const selected = new Set(Object.keys(labels));
const ids = Object.keys(replay.firstTurn).sort();
assert.equal(ids.length, 100);
const stable = value => value === null || typeof value !== 'object' ? value
  : Array.isArray(value) ? value.map(stable)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
const signature = call => JSON.stringify(stable(call || null));

// Validate precisely the JSON Schema keywords present in this archived tool set.
// Unknown validation keywords fail closed so future schema changes cannot slip by.
const keywords = new Set(['type', 'properties', 'required', 'items', 'enum', 'minimum', 'maxLength', 'description']);
function checkSchema(schema) {
  for (const key of Object.keys(schema)) assert(keywords.has(key), `Unsupported schema keyword: ${key}`);
  Object.values(schema.properties || {}).forEach(checkSchema);
  if (schema.items) checkSchema(schema.items);
}
for (const tools of Object.values(replay.tools)) tools.forEach(tool => checkSchema(tool.function.parameters));
function validate(value, schema, path = '$') {
  const errors = [];
  const types = { object: v => v !== null && typeof v === 'object' && !Array.isArray(v),
    array: Array.isArray, string: v => typeof v === 'string', boolean: v => typeof v === 'boolean',
    number: v => typeof v === 'number' && Number.isFinite(v), integer: Number.isInteger };
  if (schema.type && !types[schema.type]?.(value)) return [`${path}: expected ${schema.type}`];
  if (schema.enum && !schema.enum.some(option => deepEqual(option, value))) errors.push(`${path}: invalid enum`);
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
  if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${path}: maxLength exceeded`);
  for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: missing`);
  for (const [key, child] of Object.entries(schema.properties || {})) {
    if (Object.hasOwn(value, key)) errors.push(...validate(value[key], child, `${path}.${key}`));
  }
  if (schema.items) value.forEach((item, index) => errors.push(...validate(item, schema.items, `${path}[${index}]`)));
  return errors;
}

const sources = historical.results.map(row => {
  const resultDir = row.resultDir || resultDirs.find(dir => dir.startsWith('2026-08-02-')
    && !dir.includes('-7182') && dir.endsWith(`_chrome_${row.model.replace(/[^\w.-]+/g, '_')}`));
  assert(resultDir, `Missing historical results: ${row.model}`);
  return { model: row.model, resultDir, historical: row, date: '2026-08-02' };
});
const fresh = MODELS.map(m => ({model:m.model,date:DATE,fresh:true,resultDir:PLANNER_TAG+'_chrome_'+modelTag(m.model)}));
const audit = [];
function load(source, { caseIds = ids, recordAudit = true } = {}) {
  const dir = join(here, 'results', source.resultDir), summary = read(join(dir, 'summary.json'));
  assert.equal(readdirSync(dir).filter(file => /^\d{3}\.json$/.test(file)).length, 100);
  assert.equal(summary.model, source.model);
  assert.equal(summary.cases, 100);
  assert.equal(summary.tier, 'full');
  assert.equal(summary.freeze, null);
  assert.equal(summary.modeOverride, null);
  assert.equal(summary.reasoningEffort, null);
  assert.equal(summary.chatTemplateCompat, 'off');
  assert.equal(summary.structuredToolsSent, true);
  if (source.fresh) {
    assert.equal(summary.replay.sha256, hash(readFileSync(replayPath)));
    assert.equal(summary.replay.sourceCommit, replay.meta.sourceCommit);
    assert.equal(summary.saveRequest, true);
  }
  const row = { model: source.model, label: labels[source.model] || source.model, date: source.date,
    source: repoPath(dir), fresh: !!source.fresh, cases: caseIds.length, errors: 0, responses: 0,
    emittedToolCalls: 0, nativeToolCalls: 0, schemaValidToolCalls: 0, idealToolMatches: 0, exactIdealMatches: 0,
    promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, reasoningTokens: 0,
    costRecords: 0, usageCost: 0, lengthLimited: 0, contentFallbackCalls: 0,
    accessibilityTreeFirstCalls: 0, attempts: 0, multiToolCallResponses: 0, noToolResponses: 0, noToolCaseIds: [], multiToolCallCaseIds: [], providers: {}, byTool: {}, schemaErrors: [] };
  const records = [], latencies = [];
  for (const id of caseIds) {
    const path = join(dir, `${id}.json`), bytes = readFileSync(path), record = JSON.parse(bytes);
    const archived = rubrics.cases[id].question, saved = replay.firstTurn[id];
    assert.equal(record.id, id);
    assert.equal(record.user, archived.user);
    assert.equal(record.mode, archived.mode);
    assert.deepEqual(record.tab, archived.tab);
    if (source.fresh) {
      assert.deepEqual(record.request, { model: source.model, temperature: saved.temperature,
        max_tokens: saved.max_tokens, messages: saved.messages, tools: replay.tools[saved.mode] }, `Request drift ${id}`);
      assert(!/^HTTP 40[13]:/.test(record.error || ''), 'Authentication failures cannot be scored.');
      assert(record.error || record.response?.choices?.length, `Missing raw API response ${id}`);
      if (record.response) {
        assert.equal(typeof record.response.model, 'string'); // Providers may return a checkpoint alias; keep the raw identifier.
        assert(!record.response.error, `Embedded response error ${id}`);
        assert.deepEqual(record.usage, record.response.usage);
      }
    }
    row.attempts += record.attempts || 1;
    if (record.error) row.errors++;
    else { row.responses++; latencies.push(record.latencyMs); }
    const call = record.firstToolCall || null, ideal = rubrics.cases[id].expected.idealFirstToolCall;
    if (!record.error && !call) { row.noToolResponses++; row.noToolCaseIds.push(id); }
    if ((record.response?.choices?.[0]?.message?.tool_calls?.length || 0) > 1) { row.multiToolCallResponses++; row.multiToolCallCaseIds.push(id); }
    let schemaErrors = [];
    if (call) {
      row.emittedToolCalls++;
      if (record.toolCallSource === 'tool_calls') row.nativeToolCalls++;
      if (source.fresh) {
        const native = record.response?.choices?.[0]?.message?.tool_calls?.[0];
        if (record.toolCallSource === 'tool_calls') {
          assert(native, `Missing native call ${id}`);
          try {
            const args = typeof native.function.arguments === 'string' ? JSON.parse(native.function.arguments) : native.function.arguments;
            assert.deepEqual(call, { name: native.function.name, args });
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            schemaErrors.push('Malformed native arguments JSON');
          }
        }
      }
      const tool = replay.tools[saved.mode].find(tool => tool.function.name === call.name);
      schemaErrors.push(...(tool ? validate(call.args, tool.function.parameters) : ['Unknown tool name']));
      if (!schemaErrors.length) row.schemaValidToolCalls++;
      else row.schemaErrors.push({ id, call, errors: schemaErrors });
      if (!record.error && call.name === ideal.name) {
        row.idealToolMatches++;
        if (deepEqual(call.args, ideal.args)) row.exactIdealMatches++;
      }
      if (call.name === 'get_accessibility_tree') row.accessibilityTreeFirstCalls++;
    }
    const toolName = call?.name || (record.error ? '(error)' : '(no-tool)');
    row.byTool[toolName] = (row.byTool[toolName] || 0) + 1;
    if (record.finishReason === 'length') row.lengthLimited++;
    if (record.toolCallSource === 'content_fallback') row.contentFallbackCalls++;
    if (typeof record.usage?.cost === 'number') { row.costRecords++; row.usageCost += record.usage.cost; }
    row.promptTokens += record.usage?.prompt_tokens || 0;
    row.cachedPromptTokens += record.usage?.prompt_tokens_details?.cached_tokens || 0;
    row.completionTokens += record.usage?.completion_tokens || 0;
    row.reasoningTokens += record.usage?.completion_tokens_details?.reasoning_tokens || 0;
    if (record.response?.provider) row.providers[record.response.provider] = (row.providers[record.response.provider] || 0) + 1;
    records.push({ id, call, name: toolName, signature: record.error ? `error:${source.model}:${id}` : signature(call) });
    if (recordAudit) audit.push({ model: source.model, id, path: repoPath(path), sha256: hash(bytes),
      requestSha256: record.request ? hash(JSON.stringify(record.request)) : null,
      rubricSha256: replay.meta.sourceHashes[`test/llm/expected/${id}.json`] });
  }
  if (caseIds.length === 100) {
    assert.equal(row.errors, summary.errors);
    assert.equal(row.emittedToolCalls, summary.withToolCall);
  }
  latencies.sort((a, b) => a - b);
  row.medianLatencyMs = latencies.length ? (latencies[Math.floor((latencies.length - 1) / 2)] + latencies[Math.floor(latencies.length / 2)]) / 2 : null;
  row.p95LatencyMs = latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null;
  row.cachedPromptSharePct = row.promptTokens ? row.cachedPromptTokens / row.promptTokens * 100 : null;
  if (source.fresh) assert.equal(row.costRecords, row.responses, `Missing API cost evidence: ${source.model}`);
  if (source.historical && caseIds.length === 100) for (const metric of ['emittedToolCalls', 'schemaValidToolCalls', 'idealToolMatches', 'exactIdealMatches']) {
    assert.equal(row[metric], source.historical[metric], `Historical ${metric} regression: ${source.model}`);
  }
  return { source, row, records };
}
function consensus(cohort) {
  const caseCount = cohort[0].records.length;
  assert(caseCount > 0);
  cohort.forEach(entry => assert.equal(entry.records.length, caseCount));
  return cohort.map(entry => {
    let exact = 0, names = 0;
    for (const peer of cohort.filter(peer => peer !== entry)) {
      for (let i = 0; i < caseCount; i++) {
        if (entry.records[i].signature === peer.records[i].signature) exact++;
        if (entry.records[i].name === peer.records[i].name) names++;
      }
    }
    return { ...entry.row, exactActionMatches: exact, toolNameMatches: names,
      comparisons: caseCount * (cohort.length - 1),
      exactActionConsensusPct: +(exact * 100 / (caseCount * (cohort.length - 1))).toFixed(1),
      toolNameConsensusPct: +(names * 100 / (caseCount * (cohort.length - 1))).toFixed(1) };
  }).sort((a, b) => b.exactActionMatches - a.exactActionMatches || b.toolNameMatches - a.toolNameMatches)
    .map((row, index) => ({ rank: index + 1, ...row }));
}

const oldCohort = sources.map(source => load(source));
const reproduced = consensus(oldCohort);
for (const row of reproduced) {
  const old = historical.results.find(old => old.model === row.model);
  assert.equal(row.exactActionConsensusPct, old.exactActionConsensusPct);
  assert.equal(row.toolNameConsensusPct, old.toolNameConsensusPct);
}
writeFileSync(join(out, 'historical-planner-regression.json'), JSON.stringify({ sourceCommit: replay.meta.sourceCommit,
  validatedModels: 13, cases: 1300, allConsensusAndSchemaAndIdealCountsReproduced: true, results: reproduced }, null, 2) + '\n');

const visionManifest = read(join(here, '../vision/analysis/2026-10-07-ling30-budget/manifest.json'));
const visionRubrics = read(join(here, '../vision/analysis/2026-10-07-ling30-budget/rubrics.json'));
for (const [path, sha256] of Object.entries(visionManifest.sourceHashes)) {
  assert.equal(hash(readFileSync(join(here, '../vision', path))), sha256, `Vision source drift: ${path}`);
}
const visionSources = [
  { model: 'qwen/qwen3.8-flash', label: 'Qwen3.8 Flash', date: '2026-08-27', path: 'test/vision/results/2026-08-27-openrouter-full_qwen_qwen3.8-flash_production' },
  { model: 'z-ai/glm-5.3-flash', label: 'GLM-5.3 Flash', date: '2026-08-27', path: 'test/vision/results/2026-08-27-openrouter-full_z-ai_glm-5.3-flash_production' },
  { model: 'inclusionai/ling-3.0-flash-vl', label: 'Ling 3.0 Flash VL', date: '2026-10-07', rawStreams: true,
    path: 'test/vision/results/2026-10-07-openrouter-ling30-budget_inclusionai_ling-3.0-flash-vl_production' },
];
function vision(source) {
  const cases = ids.map(id => read(join(root, source.path, `${id}.json`)));
  assert.deepEqual(cases.map(c => c.id), ids, `Vision case order/identity drift: ${source.model}`);
  for (const c of cases) {
    assert.equal(c.id, c.question.id);
    assert.equal(c.model, source.model);
    assert.equal(c.error, null, `Vision API failure: ${source.model}/${c.id}`);
    assert.equal(c.promptMode, 'production');
    assert.equal(c.image.sha256, visionManifest.images[c.id]);
    assert.equal(hash(readFileSync(join(here, '../vision', c.image.path))), c.image.sha256);
    assert.deepEqual(c.question, read(join(here, '../vision/questions', `${c.id}.json`)));
    assert.deepEqual(c.request, { systemPrompt: VISION_SYSTEM_PROMPT, userText: PRODUCTION_USER_TEXT,
      foldSystem: false, temperature: 0, maxTokens: 800, chatTemplateKwargs: REQUEST_DEFAULTS.chatTemplateKwargs });
    assert.deepEqual(c.score, scoreVisionResponse({ content: c.response.content, expected: visionRubrics[c.id] }));
    if (source.fresh || source.rawStreams) {
      const events = c.response.raw.split(/\r?\n/).filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
      assert(events.every(event => !event.error));
      assert(c.response.raw.includes('data: [DONE]'));
      assert.equal(events.map(event => event.choices?.[0]?.delta?.content || '').join(''), c.response.content);
      assert.deepEqual(events.findLast(event => event.usage)?.usage, c.response.usage);
      assert.equal(events.findLast(event => event.provider)?.provider, c.response.provider);
      assert.equal(events.findLast(event => event.choices?.[0]?.finish_reason)?.choices[0].finish_reason, c.response.finishReason);
    }
    audit.push({ track: 'vision', model: source.model, id: c.id, path: `${source.path}/${c.id}.json`, sha256: hash(readFileSync(join(root, source.path, `${c.id}.json`))) });
  }
  const sum = key => cases.reduce((s,c) => s + (c.response.usage?.[key] || 0),0);
  const group = key => Object.fromEntries([...new Set(cases.map(key))].map(k => {
    const selected = cases.filter(c => key(c) === k);
    return [k, { cases: selected.length, passes: selected.filter(c => c.score.success).length }];
  }));
  const latency = cases.map(c => c.latencyMs.total).sort((a,b) => a-b);
  const row = { ...source, cases: 100, errors: 0, passes: cases.filter(c => c.score.success).length,
    meanScore: cases.reduce((n,c) => n+c.score.ratio,0)/100,
    meanLatencyMs: latency.reduce((a,b)=>a+b,0)/100, medianLatencyMs: (latency[49]+latency[50])/2, p95LatencyMs: latency[94],
    costRecords: cases.filter(c=>typeof c.response.usage?.cost==='number').length, usageCost: sum('cost'),
    promptTokens: sum('prompt_tokens'), completionTokens: sum('completion_tokens'),
    cachedTokens: cases.reduce((n,c)=>n+(c.response.usage?.prompt_tokens_details?.cached_tokens||0),0),
    reasoningTokens: cases.reduce((n,c)=>n+(c.response.usage?.completion_tokens_details?.reasoning_tokens||0),0),
    sixSections: cases.filter(c=>c.score.sectionCount===6).length, emptyOutputs: cases.filter(c=>!c.response.content.trim()).length,
    lengthLimited: cases.some(c=>c.response.finishReason!=null) ? cases.filter(c=>c.response.finishReason==='length').length : null,
    byDifficulty: group(c=>c.question.difficulty.slug), byCategory: group(c=>c.question.category), providers: group(c=>c.response.provider||'not recorded'),
    caseScores: cases.map(c=>({id:c.id,pass:c.score.success,ratio:c.score.ratio,criticalFailures:c.score.criticalFailures})) };
  assert.equal(row.costRecords,100);
  if (!source.fresh) {
    const summary = read(join(root, source.path, 'summary.json'));
    assert.equal(row.passes,summary.overall.successes);
    assert(Math.abs(row.meanScore-summary.overall.meanScore)<1e-12);
  }
  return row;
}
const oldVision = visionSources.map(vision);
writeFileSync(join(out,'historical-vision-regression.json'),JSON.stringify({models:visionSources.length,cases:oldVision.length*100,inputAndScoreMatches:true,rows:oldVision},null,2)+'\n');

  if (process.argv.includes('--historical-only')) {
  console.log(`Historical regression passed: 1,300 planner responses and ${oldVision.length*100} vision responses.`);
} else {
  const newCohort = fresh.map(source => load(source));
  for (const entry of newCohort) assert.equal(entry.row.errors,0, `Recover and archive failed requests before ranking: ${entry.row.model}`);
  const results = consensus([...oldCohort,...newCohort]);
  const visionResults = [...oldVision,...MODELS.filter(m=>m.vision).map(m=>vision({model:m.model,label:m.label,date:DATE,fresh:true,
    path:`test/vision/results/${VISION_TAG}_${modelTag(m.model)}_production`}))].sort((a,b)=>b.passes-a.passes);
  const pairwise = newCohort.flatMap(entry => [...oldCohort,...newCohort].filter(peer=>peer!==entry).map(peer => ({model:entry.row.model,peer:peer.row.model,
    exactMatches:entry.records.filter((r,i)=>r.signature===peer.records[i].signature).length,
    toolMatches:entry.records.filter((r,i)=>r.name===peer.records[i].name).length,cases:100})));
  const visionPairwise = visionResults.flatMap(entry => visionResults.filter(peer=>peer!==entry).map(peer=>({model:entry.model,peer:peer.model,
    bothPass:entry.caseScores.filter((r,i)=>r.pass&&peer.caseScores[i].pass).length,
    modelOnlyPass:entry.caseScores.filter((r,i)=>r.pass&&!peer.caseScores[i].pass).length,
    peerOnlyPass:entry.caseScores.filter((r,i)=>!r.pass&&peer.caseScores[i].pass).length,
    neitherPass:entry.caseScores.filter((r,i)=>!r.pass&&!peer.caseScores[i].pass).length,cases:100})));
  const fullCampaign = read(join(out,'campaign-full.json')), preflightCampaign = read(join(out,'campaign-preflight.json'));
  const preflightCases = preflightCampaign.runs.map(run=>read(join(root,run.dir,'001.json')));
  assert.equal(preflightCases.length,6);
  assert(preflightCases.every(c=>!c.error));
  const benchmarkCost = newCohort.reduce((s,c)=>s+c.row.usageCost,0)+visionResults.filter(r=>r.fresh).reduce((s,r)=>s+r.usageCost,0);
  const preflightCost = preflightCases.reduce((s,c)=>s+(c.usage?.cost??c.response?.usage?.cost??0),0);
  const campaign = { benchmarkRequests:600,preflightRequests:6,totalRecordedRequests:606,inferenceResponses:606,
    apiErrors:0,retries:0,benchmarkCostUsd:benchmarkCost,preflightCostUsd:preflightCost,totalReportedCostUsd:benchmarkCost+preflightCost,
    startedAt:fullCampaign.startedAt,finishedAt:fullCampaign.finishedAt,wallTimeMs:Date.parse(fullCampaign.finishedAt)-Date.parse(fullCampaign.startedAt),
    concurrency:fullCampaign.concurrency,note:'Six runners execute concurrently. All individual request latencies include network/provider/generation time; historical infrastructure, caches, prices and concurrency conditions differ.' };
  const report = {date:DATE,status:'complete',sourceCommit:replay.meta.sourceCommit,replaySha256:hash(readFileSync(replayPath)),
    casesPerPlannerModel:100,actTools:48,consensusModels:17,comparisonsPerModel:1600,historicalPlannerModels:13,newPlannerModels:4,newVisionModels:2,historicalVisionModels:visionSources.length,
    method:'Leave-one-out consensus across all 17 models, comparing the first proposed tool call per response. Recursive object-key sorting only; preserve argument values, defaults, and extra arguments. Additional tool calls are counted separately and not executed or scored. No-tool/no-tool agrees; rejected API requests are excluded from quality. Consensus is agreement, not ground truth.',
    caveat:'Only the four October 14 planner models and two MiMo vision runs are new. Historical requests were omitted and are reconstructed from pinned source; full historical body equality is unprovable. Serving dates, provider routes, caches and bills differ. No browser tools are executed.',
    results,primaryComparison:results.filter(r=>selected.has(r.model)),visionResults,pairwise,visionPairwise,campaign};
  writeFileSync(join(out,'comparison.json'),JSON.stringify(report,null,2)+'\n');
  writeFileSync(join(out,'audit.json'),JSON.stringify({replaySha256:report.replaySha256,cases:audit},null,2)+'\n');
  const table = '| Model | Exact consensus | Tool consensus | Valid / emitted | Ideal tool | Exact ideal | Median | p95 | Cost |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n' +
    report.primaryComparison.map(r=>`| ${r.label} | ${r.exactActionConsensusPct.toFixed(1)}% | ${r.toolNameConsensusPct.toFixed(1)}% | ${r.schemaValidToolCalls} / ${r.emittedToolCalls} | ${r.idealToolMatches} | ${r.exactIdealMatches} | ${(r.medianLatencyMs/1000).toFixed(2)}s | ${(r.p95LatencyMs/1000).toFixed(2)}s | $${r.usageCost.toFixed(4)} |`).join('\n');
  const vtable = '| Model | Passes / 100 | Mean rubric | Median | p95 | Reported cost |\n| --- | ---: | ---: | ---: | ---: | ---: |\n'+visionResults.map(r=>`| ${r.label} | ${r.passes} | ${(r.meanScore*100).toFixed(1)}% | ${(r.medianLatencyMs/1000).toFixed(2)}s | ${(r.p95LatencyMs/1000).toFixed(2)}s | $${r.usageCost.toFixed(4)} |`).join('\n');
  writeFileSync(join(out,'report.md'),`# HY4, MiMo V2.6, and Liquid LFM2.5\n\n${report.method}\n\n${report.caveat}\n\n${table}\n\n## Vision\n\n${vtable}\n`);
  console.log(JSON.stringify({planner:report.primaryComparison.map(({label,exactActionConsensusPct,schemaValidToolCalls,idealToolMatches,medianLatencyMs,usageCost})=>({label,exactActionConsensusPct,schemaValidToolCalls,idealToolMatches,medianLatencyMs,usageCost})),vision:visionResults.map(({label,passes,meanScore,usageCost})=>({label,passes,meanScore,usageCost}))},null,2));
}
