#!/usr/bin/env node
// RTX 5060 Ti comparison using official, revision-pinned Q4_K_M GGUF files.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const analysis = join(root, 'test/llm/analysis/2026-10-29-spark-lfm-minicpm-compact');
const replay = join(root, 'test/llm/freeze/compact-replay-2026-09-07.json');
const runtime = process.env.LLAMA_SERVER || '/home/emre/Documents/lfm/llama.cpp/build/bin/llama-server';
const modelRoot = process.env.GGUF_MODEL_ROOT || '/home/emre/models';
const defaultDevice = process.env.LLAMA_DEVICE || 'CUDA2';
const defaultPort = process.env.LLAMA_PORT || '18080';
const requested = process.argv.find(a => a.startsWith('--model='))?.slice(8);
const deviceArg = process.argv.find(a => a.startsWith('--device='))?.slice(9) || defaultDevice;
const portArg = process.argv.find(a => a.startsWith('--port='))?.slice(7) || defaultPort;
const smokeOnly = process.argv.includes('--smoke');

const models = [
  { id: 'spark-x2.6-4b', name: 'Spark-X2.6-4B', source: 'XHToken/Spark-X2.6-4B', repo: 'XHToken/Spark-X2.6-4B-GGUF', revision: '0e8aa39a34063946ce07bbaaff392093b11b6829', file: 'Spark-X2.6-4B-Q4_K_M.gguf', bytes: 3543441312, sha256: '91cb2811aebb47ac916aa619d27d4cdd7f4143106b7917accb8ead4cd7f5cbd9' },
  { id: 'lfm3-1.7b', name: 'LFM3-1.7B', source: 'LiquidAI/LFM3-1.7B', repo: 'LiquidAI/LFM3-1.7B-GGUF', revision: 'bad5729bba61d076fff20d2548e62526665af215', file: 'LFM3-1.7B-Q4_K_M.gguf', bytes: 1099627808, sha256: '3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4' },
  { id: 'minicpm-v-4.7-1b', name: 'MiniCPM-V-4.7-1B', source: 'openbmb/MiniCPM-V-4.7-1B', repo: 'openbmb/MiniCPM-V-4.7-1B-gguf', revision: '345adbfa02c4a4671e61b7c75502dc9bf24fa93d', file: 'MiniCPM-V-4_7-1B-Q4_K_M.gguf', bytes: 672003680, sha256: 'f18f594747e5317ab490cff9c06339c9cfb89acbe2f02ebc48a4e167bc23576d' },
];

if (requested && !models.some(m => m.id === requested)) throw new Error(`Unknown model: ${requested}`);
await mkdir(analysis, { recursive: true });

const hashFile = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

const run = (command, args) => new Promise((accept, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)));
});

for (const model of models.filter(m => !requested || m.id === requested)) {
  const metadataFile = join(analysis, `${model.id}${smokeOnly ? '-preflight' : ''}-run.json`);
  if (existsSync(metadataFile)) throw new Error(`Refusing to overwrite run metadata: ${metadataFile}`);
  const modelFile = join(modelRoot, model.repo, model.file);
  const actualHash = await hashFile(modelFile);
  if (actualHash !== model.sha256) throw new Error(`Model hash mismatch for ${model.id}: got ${actualHash}, expected ${model.sha256}`);

  const args = [
    '--model', modelFile,
    '--alias', model.name,
    '--host', '127.0.0.1',
    '--port', String(portArg),
    '--device', deviceArg,
    '--n-gpu-layers', '99',
    '--ctx-size', '32768',
    '--parallel', '1',
    '--flash-attn', 'on',
    '--jinja',
    '--reasoning', 'off',
    '--seed', '3407',
    '--top-k', '0',
    '--top-p', '1',
    '--min-p', '0',
    '--repeat-penalty', '1',
    '--no-webui'
  ];

  const log = createWriteStream(join(analysis, `${model.id}-server.log`), { flags: 'a' });
  const server = spawn(runtime, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.pipe(log); server.stderr.pipe(log);
  let serverError = null;
  server.on('error', error => { serverError = error; });

  const metadata = {
    schema: 'webbrain.local-comparison-run.v1',
    startedAt: new Date().toISOString(),
    model,
    quantization: 'Q4_K_M',
    gpu: 'NVIDIA GeForce RTX 5060 Ti',
    runtime,
    args,
    replaySha256: await hashFile(replay),
    concurrency: 1,
    timeoutMs: 120000,
    thinking: false,
    seed: 3407,
    maxTokens: 4096,
    actionTemperature: 0.15,
    askTemperature: 0.3,
    stages: [],
    codeHashes: {}
  };

  for (const file of [
    'test/llm/run-llamacpp.mjs',
    'test/llm/run-scenarios.mjs',
    'test/llm/lib/score.mjs',
    'test/llm/lib/content-tool-call-parser.mjs',
    'test/llm/lib/replay-payload.mjs'
  ]) metadata.codeHashes[file] = await hashFile(join(root, file));

  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (serverError || server.exitCode !== null) throw serverError || new Error(`Server exited ${server.exitCode}; see ${model.id}-server.log`);
      try {
        const response = await fetch(`http://127.0.0.1:${portArg}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(accept => setTimeout(accept, 500));
    }
    if (!ready) throw new Error('Server did not become healthy.');

    metadata.serverProperties = await fetch(`http://127.0.0.1:${portArg}/props`).then(r => r.json());
    metadata.serverModels = await fetch(`http://127.0.0.1:${portArg}/v1/models`).then(r => r.json());
    if (metadata.serverModels.data[0]?.id !== model.name) throw new Error('The endpoint is serving a different model.');

    for (const stage of smokeOnly ? ['smoke'] : ['smoke', 'full']) {
      for (const track of ['first-turn', 'scenarios']) {
        const tag = `2026-10-29-${model.id}-compact-${smokeOnly ? 'preflight' : stage}`;
        const runner = track === 'first-turn' ? 'run-llamacpp.mjs' : 'run-scenarios.mjs';
        const commandArgs = [
          'test/llm/' + runner,
          '--base', `http://127.0.0.1:${portArg}`,
          '--model', model.name,
          '--tier', 'compact',
          '--browser', 'chrome',
          '--concurrency', '1',
          '--timeout', '120000',
          '--tag', tag,
          '--replay', replay
        ];
        if (stage === 'smoke') commandArgs.push('--only', track === 'first-turn' ? '1,16,34,68,82' : '1,11,41,61,71,81,91');
        else if (track === 'scenarios') commandArgs.push('--only', Array.from({ length: 100 }, (_, i) => i + 1).join(','));
        const resultDir = join(root, 'test/llm', track === 'first-turn' ? 'results' : 'results-scenarios', `${tag}_chrome_${model.name}_compact`);
        if (existsSync(join(resultDir, 'summary.json'))) throw new Error(`Refusing to overwrite results: ${resultDir}`);
        console.log(`Starting ${model.name}: ${stage} ${track}`);
        await run(process.execPath, commandArgs);
        const summary = JSON.parse(await readFile(join(resultDir, 'summary.json'), 'utf8'));
        metadata.stages.push({ stage, track, command: [process.execPath, ...commandArgs], resultDir, summary });
        await writeFile(metadataFile, JSON.stringify(metadata, null, 2) + '\n');
        if (stage === 'smoke' && (summary.errors || summary.byVerdict?.error)) throw new Error(`Preflight transport failure for ${model.name}.`);
      }
    }
    metadata.completedAt = new Date().toISOString();
  } catch (error) {
    metadata.error = error.message;
    throw error;
  } finally {
    if (server.exitCode === null) server.kill();
    await new Promise(accept => server.exitCode !== null ? accept() : server.once('exit', accept));
    log.end();
    await writeFile(metadataFile, JSON.stringify(metadata, null, 2) + '\n');
  }
}
