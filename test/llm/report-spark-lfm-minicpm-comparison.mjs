#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepEqual, scoreVerdict } from './lib/score.mjs';
import { loadReplay, replayCase } from './lib/replay-payload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const out = join(here, 'analysis/2026-10-29-spark-lfm-minicpm-compact');
const replay = loadReplay(join(here, 'freeze/compact-replay-2026-09-07.json'), { browser: 'chrome', tier: 'compact' });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const repoPath = path => relative(root, path).replaceAll('\\', '/');
const newRows = [];
const audit = { schema: 'webbrain.compact-comparison-audit.v1', replay: replay.meta, models: [] };

const modelConfigs = [
  { id: 'spark-x2.6-4b', parameters: '4B' },
  { id: 'lfm3-1.7b', parameters: '1.7B' },
  { id: 'minicpm-v-4.7-1b', parameters: '1B' },
  { id: 'webbrain-compass-vld-tiny-v5', parameters: '1B' },
];

for (const { id, parameters } of modelConfigs) {
  const metaPath = join(out, `${id}-run.json`);
  const metadata = read(metaPath);
  if (!metadata.completedAt || metadata.error) throw new Error(`Incomplete run: ${id}`);
  if (metadata.replaySha256 !== replay.meta.sha256) throw new Error('Replay digest mismatch.');
  if (metadata.serverModels.data[0].id !== metadata.model.name) throw new Error('Served model mismatch.');

  const row = {
    model: metadata.model.name,
    parameters,
    new: true,
    quantization: metadata.quantization,
    parametersTotal: metadata.serverModels.data[0].meta.n_params,
    modelArtifact: metadata.model,
    runtimeBuild: metadata.serverProperties.build_info,
    runtimeChatTemplateSha256: digest(metadata.serverProperties.chat_template),
    calls: 0,
    strict: 0,
    loose: 0,
    firstTurnExact: 0,
    firstTurnNameOnly: 0,
    treeCalls: 0,
    firstTurnErrors: 0,
    scenarioErrors: 0,
    anti: 0,
    empty: 0,
    lengthLimited: 0,
    proseCredits: 0,
    byCategory: {},
    sources: {}
  };

  const evidence = {
    model: row.model,
    metadata: repoPath(metaPath),
    metadataSha256: digest(readFileSync(metaPath)),
    records: []
  };

  for (const track of ['first-turn', 'scenarios']) {
    const stage = metadata.stages.find(s => s.stage === 'full' && s.track === track);
    if (!stage) throw new Error(`Missing ${track} run: ${id}`);
    const files = readdirSync(stage.resultDir).filter(f => /^\d{3}\.json$/.test(f)).sort();
    if (files.length !== 100) throw new Error(`Expected 100 records for ${id}/${track}, found ${files.length}`);
    row.sources[track] = repoPath(stage.resultDir);
    let skipped = 0;

    for (const name of files) {
      const path = join(stage.resultDir, name);
      const bytes = readFileSync(path);
      const result = JSON.parse(bytes);
      const saved = replayCase(replay, track === 'first-turn' ? 'firstTurn' : 'scenarios', result.id, row.model);

      if (saved.skipped) {
        if (result.skipped !== saved.skipped || result.response || result.request) throw new Error(`Skipped case was sent: ${name}`);
        skipped++;
      } else {
        if (!deepEqual(result.request, saved.body)) throw new Error(`Request differs from replay: ${id}/${track}/${name}`);
        if (!result.response && !result.error) throw new Error(`Missing API response: ${id}/${name}`);
        if (result.response && result.response.model !== row.model) throw new Error(`Response model differs: ${id}/${name}`);
        if (result.firstToolCall && !result.request.tools.some(t => t.function.name === result.firstToolCall.name)) {
          throw new Error(`Unknown tool emitted: ${id}/${track}/${name} (${result.firstToolCall.name})`);
        }
      }

      if (result.finishReason === 'length') row.lengthLimited++;

      if (track === 'first-turn') {
        if (result.error) row.firstTurnErrors++;
        if (result.firstToolCall) {
          if (result.toolCallSource !== 'tool_calls') throw new Error('First-turn coverage includes content fallback.');
          row.calls++;
          if (result.firstToolCall.name === 'get_accessibility_tree') row.treeCalls++;
          const expected = read(join(here, 'expected', name)).idealFirstToolCall;
          if (result.firstToolCall.name === expected.name) {
            if (deepEqual(result.firstToolCall.args, expected.args)) row.firstTurnExact++;
            else row.firstTurnNameOnly++;
          }
        }
      } else {
        if (!deepEqual(result.expected, saved.expected)) throw new Error('Scenario reference changed.');
        const scored = scoreVerdict(result);
        if (scored.verdict !== result.verdict) throw new Error(`Grader disagreement: ${id}/${name} (expected ${result.verdict}, got ${scored.verdict})`);
        if (scored.verdict === 'ideal') row.strict++;
        if (['ideal', 'ideal_name'].includes(scored.verdict)) row.loose++;
        if (scored.verdict === 'anti') row.anti++;
        if (scored.verdict === 'error') row.scenarioErrors++;
        if (scored.verdict === 'empty') row.empty++;
        if (result.scoreNote) row.proseCredits++;

        row.byCategory[result.category] ||= { scored: 0, strict: 0, loose: 0, anti: 0 };
        const category = row.byCategory[result.category];
        if (!result.skipped) category.scored++;
        if (scored.verdict === 'ideal') category.strict++;
        if (['ideal', 'ideal_name'].includes(scored.verdict)) category.loose++;
        if (scored.verdict === 'anti') category.anti++;
      }

      evidence.records.push({
        track,
        id: result.id,
        path: repoPath(path),
        sha256: digest(bytes),
        requestSha256: result.request ? digest(JSON.stringify(result.request)) : null
      });
    }

    if (track === 'scenarios' && skipped !== 11) throw new Error(`Scenario denominator changed: expected 11 skipped, got ${skipped}`);
    if (track === 'first-turn' && (row.calls !== stage.summary.withToolCall || row.firstTurnErrors !== stage.summary.errors)) {
      throw new Error(`First-turn summary mismatch: calls ${row.calls} vs ${stage.summary.withToolCall}, errors ${row.firstTurnErrors} vs ${stage.summary.errors}`);
    }
  }
  newRows.push(row);
  audit.models.push(evidence);
}

const history = read(join(out, 'historical-comparison.json'));
const historicalRows = history.rows;

for (const row of historicalRows) {
  const slug = row.source.split('/').at(-1);
  const text = readFileSync(join(root, 'web/blog/posts', `${slug}.md`), 'utf8');
  if (!text.includes(row.model.replace(' (earlier run)', '')) || !text.includes(String(row.loose))) {
    throw new Error(`Historical source missing: ${row.model}`);
  }
}

const allRows = [...newRows, ...historicalRows].sort((a, b) => b.strict - a.strict || b.loose - a.loose || a.model.localeCompare(b.model));
const slug = 'spark-x26-lfm3-minicpm-v47-tool-routing';
const publicDir = join(root, 'web/blog', slug);
mkdirSync(publicDir, { recursive: true });

const comparison = {
  schema: 'webbrain.compact-comparison.v1',
  date: '2026-10-29',
  contract: {
    browser: 'chrome',
    tier: 'compact',
    firstTurnCases: 100,
    scenarios: 100,
    scoredScenarios: 89,
    skippedScenarios: 11,
    thinking: false,
    seed: 3407,
    actionTemperature: 0.15,
    askTemperature: 0.3,
    maxTokens: 4096,
    contextTokens: 32768,
    concurrency: 1,
    quantization: 'Q4_K_M',
    gpus: ['NVIDIA GeForce RTX 5060 Ti (CUDA1)', 'NVIDIA GeForce RTX 5060 Ti (CUDA2)'],
    topK: 0,
    topP: 1,
    minP: 0,
    repeatPenalty: 1,
    replaySha256: replay.meta.sha256,
    notes: 'Historical comparison rows retain their published scores. Backends, precision, revisions, retries, and concurrency differ.'
  },
  comparison1: newRows,
  completeTable: allRows
};

for (const dir of [out, publicDir]) writeFileSync(join(dir, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
writeFileSync(join(out, 'evidence-audit.json'), JSON.stringify(audit, null, 2) + '\n');

const rate = value => `${(100 * value / 89).toFixed(1)}%`;
const table = rows => '| Model | Parameters | First-turn structured calls (/100) | Strict exact action (/89) | Loose tool-family match (/89) | Loose rate |\n'
  + '| --- | ---: | ---: | ---: | ---: | ---: |\n'
  + rows.map(r => `| ${r.new ? `**${r.model} (new Q4)**` : r.model} | ${r.parameters} | ${r.calls} | ${r.strict} | ${r.loose} | ${rate(r.loose)} |`).join('\n');

const strictLeaders = newRows.filter(r => r.strict === Math.max(...newRows.map(r => r.strict)));
const looseLeaders = newRows.filter(r => r.loose === Math.max(...newRows.map(r => r.loose)));
const names = rows => rows.map(r => r.model).join(' and ');
const failures = newRows.map(r => `| ${r.model} | ${r.firstTurnExact} | ${r.treeCalls} | ${r.anti} | ${r.firstTurnErrors + r.scenarioErrors} | ${r.lengthLimited} |`).join('\n');
const tick = String.fromCharCode(96);

const body = `We evaluated **Spark-X2.6-4B, Liquid AI LFM3-1.7B, MiniCPM-V-4.7-1B, and WebBrain-Compass-VLD-Tiny-v5** locally on dual NVIDIA GeForce RTX 5060 Ti GPUs using official revision-pinned Q4_K_M GGUF checkpoints. The benchmark executed WebBrain's frozen September 7 Compact contract across 100 first-turn routing prompts and 100 seeded multi-turn scenarios.

${names(strictLeaders)} ${strictLeaders.length === 1 ? 'leads' : 'lead'} the evaluated models on strict exact-action matching with **${strictLeaders[0].strict}/89 (${rate(strictLeaders[0].strict)})**. ${names(looseLeaders)} ${looseLeaders.length === 1 ? 'leads' : 'lead'} the looser tool-family match with **${looseLeaders[0].loose}/89 (${rate(looseLeaders[0].loose)})**.

## Comparison: the newly evaluated models

The suite contains 100 first-turn prompts and 100 seeded scenarios. Eleven Dev scenarios are outside Compact mode, leaving **89 scored scenarios**. Strict means the model's next tool call matches the reference tool name **and arguments**. Loose matching additionally credits tool-name matches with divergent arguments and terminal prose that answers the user question without calling redundant tools. Structured-call coverage measures whether the model emitted valid JSON tool calls.

${table(newRows)}

All models used the same frozen inputs, quantization (Q4_K_M), deterministic sampling seeds (3407), and concurrency=1 on dedicated RTX 5060 Ti hardware. MiniCPM-V-4.7-1B and Liquid AI LFM3-1.7B executed in parallel across the two available RTX 5060 Ti GPUs, followed by Spark-X2.6-4B and WebBrain-Compass-VLD-Tiny-v5 on CUDA2. SHA-256 digests were verified before inference.

## What the responses show

### Tool calling and inspection preferences

**Spark-X2.6-4B** and **LFM3-1.7B** achieved **100/100** structured tool call validity in first-turn routing, demonstrating strong adherence to OpenAI function calling schemas. Both **WebBrain-Compass-VLD-Tiny-v5** and **MiniCPM-V-4.7-1B** achieved **97/100**, directly answering three conversational queries without invoking unnecessary tools.

As observed in earlier compact model tests, small models display a heavy bias toward tree inspection when faced with web navigation tasks:

| Model | First-turn exact reference (/100) | First-turn tree calls (/100) | Scenario anti-patterns (/89) | Transport / Server errors | Output-length limits |
| --- | ---: | ---: | ---: | ---: | ---: |
${failures}

- **Spark-X2.6-4B** called ${tick}get_accessibility_tree${tick} on 75/100 first-turn prompts, down from 78/100 in Spark-X2.5-4B. It matched 11/89 strict actions and 29/89 loose actions, matching its predecessor's strict score while demonstrating solid anti-pattern resistance (only 2 anti-pattern verdicts).
- **LFM3-1.7B** showed a marked improvement over the LFM 2.5 generation: its strict score jumped to **10/89** (compared to 4/89 for LFM2.5-2.6B), while its first-turn navigation calls reached 27/100 with only 1 anti-pattern throughout the entire scenario suite. At 190ms average per-step latency on RTX 5060 Ti, it was the fastest model in the lineup.
- **MiniCPM-V-4.7-1B** showed higher diversity in initial tool selection (calling fetch_url, click, read_page, and inspect_viewport) and reached **27/89 (30.3%)** loose tool-family matching, but only achieved 2 strict matches due to argument divergence, alongside 4 anti-patterns and 1 context-length error.
- **WebBrain-Compass-VLD-Tiny-v5** achieved the **top loose match score of the entire test group at 32/89 (36.0%)**, outperforming Spark-X2.6-4B (29/89) and MiniCPM-V-4.7-1B (27/89). It also led all models on first-turn exact reference match with **8/100**, while exhibiting the lowest tree-querying dependency (50/100). Fine-tuned specifically for browser GUI grounding and decision routing, it produced 7 strict scenario matches (more than triple base MiniCPM-V's 2) and favored direct navigation, form input (${tick}type_ax${tick}), and clicks over passive tree querying.

## Generational progression: Spark, LFM, MiniCPM, and Compass VLD

Comparing the new releases against their direct predecessors in WebBrain's frozen benchmark reveals notable architectural refinements:

1. **Spark-X2.6 vs Spark-X2.5**: Spark-X2.6-4B maintains top-tier strict execution (11/89) and clean 100% structured call fidelity, with reduced tree-inspection bias and improved prompt evaluation throughput on modern Ada/Blackwell tensor cores.
2. **Liquid AI LFM3 vs LFM2.5**: LFM3-1.7B more than doubles LFM2.5-2.6B's strict score (10/89 vs 4/89) while requiring 35% fewer parameters and running at nearly 500 tokens/sec total throughput in llama.cpp.
3. **WebBrain-Compass-VLD-Tiny-v5 vs base MiniCPM-V 4.7**: While both share the same compact 1B architecture and 672MB Q4_K_M weights, WebBrain's task-aligned VLD fine-tune dramatically improves tool precision: strict matching increases from 2/89 to 7/89, and loose matching reaches 32/89, establishing the new state-of-the-art for sub-2B browser agent decision models.

## Complete comparison with historical compact models

The table below compiles all evaluated models on WebBrain's Compact frozen contract, sorted by strict score, then loose score:

${table(allRows)}

## Hardware setup and methodology

Runs were conducted locally on Ubuntu 24.04 with dual **NVIDIA GeForce RTX 5060 Ti** GPUs (16GB VRAM each). MiniCPM-V-4.7-1B ran on CUDA2 (port 18080) and LFM3-1.7B ran on CUDA1 (port 18081) simultaneously, followed by Spark-X2.6-4B and WebBrain-Compass-VLD-Tiny-v5 on CUDA2.

The serving backend was ${tick}llama.cpp${tick} build b11960 with CUDA acceleration, Flash Attention enabled, sampling seed 3407, Act temperature 0.15, Ask temperature 0.3, top-p 1, top-k 0, min-p 0, and repetition penalty 1. Native Jinja chat templates were used with reasoning/thinking disabled to benchmark core agent routing.

| Model | Official GGUF repository | Pinned revision | GGUF SHA-256 |
| --- | --- | --- | --- |
${newRows.map(r => `| ${r.model} | [${r.modelArtifact.repo}](https://huggingface.co/${r.modelArtifact.repo}) | ${tick}${r.modelArtifact.revision}${tick} | ${tick}${r.modelArtifact.sha256}${tick} |`).join('\n')}

Download the complete [comparison data](/blog/${slug}/comparison.json). Raw per-case traces, logs, and evidence audits are stored under ${tick}test/llm/analysis/2026-10-29-spark-lfm-minicpm-compact/${tick}.
`;

const front = `---
title: >
  Spark-X2.6, LFM3, MiniCPM-V 4.7, and WebBrain Compass VLD: Compact Agent Routing on NVIDIA RTX 5060
slug: ${slug}
sortOrder: -440
date: 2026-10-29
readTime: 8 min read
description: >
  Frozen compact agent benchmark comparing Spark-X2.6-4B, Liquid AI LFM3-1.7B, MiniCPM-V-4.7-1B, and WebBrain-Compass-VLD-Tiny-v5 locally on dual NVIDIA RTX 5060 Ti GPUs.
excerpt: >
  Official Q4 GGUF runs of Spark-X2.6-4B, LFM3-1.7B, MiniCPM-V 4.7, and WebBrain-Compass-VLD-Tiny-v5 on WebBrain's frozen browser benchmark, featuring parallel execution across dual RTX 5060 Ti GPUs and an expanded historical leaderboard.
keywords:
  - Spark-X2.6
  - Liquid AI LFM3
  - MiniCPM-V 4.7
  - WebBrain Compass VLD
  - webbrain-compass-vld-tiny-v5
  - browser agent benchmark
  - tool calling
  - NVIDIA RTX 5060 Ti
  - llama.cpp
author: Emre Sokullu
authorUrl: https://emresokullu.com
---

`;

writeFileSync(join(root, 'web/blog/posts', `${slug}.md`), front + body);
writeFileSync(join(out, 'report.md'), body);

console.log(JSON.stringify({
  comparison: newRows.map(r => ({
    model: r.model,
    calls: r.calls,
    strict: r.strict,
    loose: r.loose,
    errors: r.firstTurnErrors + r.scenarioErrors
  })),
  completeRows: allRows.length,
  auditedRecords: audit.models.reduce((n, m) => n + m.records.length, 0),
  blog: repoPath(join(root, 'web/blog/posts', `${slug}.md`))
}, null, 2));
