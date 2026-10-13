#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const OUT = 'test/llm/analysis/2026-10-14-hy4-mimo26-lfm25';
export const DATE = '2026-10-14';
export const PLANNER_TAG = `${DATE}-openrouter-hy4-mimo26-lfm25-full-7182`;
export const VISION_TAG = `${DATE}-openrouter-mimo26-vision`;
export const MODELS = [
  { model: 'tencent/hy4-preview', label: 'Tencent HY4 Preview', vision: false },
  { model: 'xiaomi/mimo-v2.6-pro', label: 'MiMo-V2.6-Pro', vision: true },
  { model: 'xiaomi/mimo-v2.6-flash', label: 'MiMo-V2.6-Flash', vision: true },
  { model: 'liquid/lfm-2.5-24b-a2b', label: 'Liquid LFM2.5-24B-A2B', vision: false },
];
export const modelTag = model => model.replace(/[^\w.-]+/g, '_');

async function prepare() {
  await mkdir(OUT, { recursive: true });
  const path = 'test/llm/freeze/full-replay-7182c21f.json';
  const bytes = await readFile(path), replay = JSON.parse(bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '3d27c43da02747496dbd050a366ef6188f14eaf99a5b41de35e5c55581669062');
  assert.equal(replay.tools.act.length, 48);
  assert.equal(Object.keys(replay.firstTurn).length, 100);
  await writeFile(`${OUT}/rubrics.json`, await readFile('test/llm/analysis/2026-10-06-ling31-flash/rubrics.json'));
  const metadata = await Promise.all(MODELS.map(async model => {
    const url = `https://openrouter.ai/api/v1/models/${model.model}/endpoints`;
    const response = await fetch(url), data = await response.json();
    assert.equal(response.status, 200, `Unavailable route metadata: ${model.model}`);
    assert(data.data.endpoints.some(endpoint => endpoint.supported_parameters.includes('tools')));
    assert.equal(data.data.architecture.input_modalities.includes('image'), model.vision);
    return { ...model, url, status: response.status, retrievedAt: new Date().toISOString(), data };
  }));
  await writeFile(`${OUT}/openrouter-endpoints.json`, JSON.stringify(metadata, null, 2) + '\n');
  const config = { date: DATE, replayPath: path, replaySha256: createHash('sha256').update(bytes).digest('hex'), sourceCommit: replay.meta.sourceCommit,
    models: MODELS.map(model => ({ ...model,
      plannerDir: `test/llm/results/${PLANNER_TAG}_chrome_${modelTag(model.model)}`,
      visionDir: model.vision ? `test/vision/results/${VISION_TAG}_${modelTag(model.model)}_production` : null })),
    planner: { cases: 100, actTools: 48, temperature: 0.15, maxTokens: 4096, reasoningOverride: null, compatibility: 'off', concurrency: 3, timeoutMs: 180000 },
    vision: { cases: 100, temperature: 0, maxTokens: 800, promptMode: 'production', concurrency: 2, providerRouting: 'automatic' },
    historicalPlannerModels: 13,
    historicalVisionDirs: [
      'test/vision/results/2026-08-27-openrouter-full_qwen_qwen3.8-flash_production',
      'test/vision/results/2026-08-27-openrouter-full_z-ai_glm-5.3-flash_production',
    ],
    note: 'Only October 14 models are new inference. August historical responses are retained, dated separately, and verified against matching pinned inputs. Full historical request byte equality is unprovable because old planner runs omitted bodies.' };
  await writeFile(`${OUT}/config.json`, JSON.stringify(config, null, 2) + '\n');
  console.log(JSON.stringify({ models: MODELS.map(m => m.model), plannerCases: 400, visionCases: 200, replaySha256: config.replaySha256 }));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await prepare();
