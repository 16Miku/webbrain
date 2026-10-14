#!/usr/bin/env node
// Runs the prepared campaign without persisting API credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { OUT, DATE, MODELS, PLANNER_TAG, VISION_TAG, modelTag } from './prepare-hy4-mimo26-lfm25.mjs';

assert(process.env.OPENROUTER_API_KEY, 'Set OPENROUTER_API_KEY in the process environment.');
const preflight = process.argv.includes('--preflight');
const stage = preflight ? 'preflight' : 'full';
const keyResponse = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } });
assert.equal(keyResponse.status, 200, `API key validation returned HTTP ${keyResponse.status}; no benchmark requests sent.`);
await mkdir(OUT, { recursive: true });
const runs = MODELS.flatMap(m => [{ model: m.model, track: 'planner', tag: PLANNER_TAG + (preflight ? '-preflight' : ''),
  dir: `test/llm/results/${PLANNER_TAG}${preflight ? '-preflight' : ''}_chrome_${modelTag(m.model)}`,
  script: 'test/llm/run-llamacpp.mjs', args: ['--tier','full','--chat-template-compat','off','--replay','test/llm/freeze/full-replay-7182c21f.json','--concurrency','3','--timeout','180000'] },
  ...(m.vision ? [{ model: m.model, track: 'vision', tag: VISION_TAG + (preflight ? '-preflight' : ''),
    dir: `test/vision/results/${VISION_TAG}${preflight ? '-preflight' : ''}_${modelTag(m.model)}_production`,
    script: 'test/vision/run.mjs', args: ['--concurrency','2','--timeout','180000'] }] : [])]);
for (const run of runs) {
  const existing = await access(run.dir).then(()=>true,()=>false);
  assert(!existing, `Refusing to overwrite existing evidence: ${run.dir}. Archive any failed pass before recovery.`);
}
if (!preflight) for (const m of MODELS) {
  const first = JSON.parse(await readFile(`test/llm/results/${PLANNER_TAG}-preflight_chrome_${modelTag(m.model)}/001.json`, 'utf8'));
  assert(!first.error && first.response?.choices?.length, `Planner preflight has no inference response: ${m.model}`);
  if (m.vision) {
    const image = JSON.parse(await readFile(`test/vision/results/${VISION_TAG}-preflight_${modelTag(m.model)}_production/001.json`, 'utf8'));
    assert(!image.error && image.response?.status === 200, `Vision preflight failed: ${m.model}`);
  }
}
const startedAt = new Date().toISOString();
const recorded = await Promise.all(runs.map(async run => {
  const started = Date.now();
  const child = spawn(process.execPath, [run.script,'--base','https://openrouter.ai/api/v1','--model',run.model,'--tag',run.tag,...run.args,...(preflight ? ['--only','1'] : [])], {
    env: {...process.env, VISION_PROBE_KEY:process.env.OPENROUTER_API_KEY}, stdio:['ignore','pipe','pipe'], windowsHide:true,
  });
  let stdout='', stderr='';
  child.stdout.on('data',data=>stdout+=data.toString());
  child.stderr.on('data',data=>{stderr+=data.toString();process.stderr.write(`[${run.model} ${run.track}] ${data}`);});
  const code = await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  const prefix = `${OUT}/${stage}-${run.track}-${modelTag(run.model)}`;
  await writeFile(prefix+'.stdout.log',stdout);
  await writeFile(prefix+'.stderr.log',stderr);
  return {model:run.model,track:run.track,dir:run.dir,exitCode:code,wallTimeMs:Date.now()-started};
}));
const campaign = {date:DATE,stage,startedAt,finishedAt:new Date().toISOString(),authentication:'validated before inference; credentials not saved',
  concurrency:{plannerPerModel:3,visionPerModel:2},reasoningOverride:null,retries:0,runs:recorded};
await writeFile(`${OUT}/campaign-${stage}.json`,JSON.stringify(campaign,null,2)+'\n');
assert(recorded.every(run=>run.exitCode===0),'At least one benchmark process failed; inspect saved logs and raw results.');
console.log(JSON.stringify(campaign,null,2));
