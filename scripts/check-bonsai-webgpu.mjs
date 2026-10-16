import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Runs the packaged production inference worker on hardware WebGPU. Local repo
// mappings serve unpublished artifacts without changing model code or metadata.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
if (args.includes('--help')) {
  console.log(`Usage: node scripts/check-bonsai-webgpu.mjs --model owner/repo [--vision]
  --local-repo owner/repo=directory  Serve local artifacts (repeatable)
  --profile directory              Reuse browser cache (default .build/bonsai/browser-profile)
  --output file                    JSON evidence (default .build/bonsai/browser-result.json)
  --probe-only                     Check hardware/runtime without downloading
  --offline                        Require cached files; reject HF network fetches
  --clear-model-cache              Delete only the selected model's cached files
  --adapter-luid high,low           Select a Windows GPU without changing OS settings
  --skip-tools                     Skip the tool-template round trip
  --vision                         Verify two independent image-only facts
  --ocr                            Check exact image-only codes instead of color/shape
  --image-history                  Also verify a turn with two differently sized images
  --compact-images                 Use low-resolution OCR fixtures (196/216 image tokens)
  --timeout-ms N                   Per-operation deadline (default 1800000)
  --port N                         Stable origin for cache reuse (default 8769)`);
  process.exit(0);
}
const model = option('--model', 'danyalmalik/Ternary-Bonsai-2-2B-ONNX-WebGPU');
const vision = args.includes('--vision');
const ocr = args.includes('--ocr');
assert(!ocr || vision, '--ocr requires --vision');
const dtype = vision
  ? { embed_tokens: 'q2f16', vision_encoder: 'fp16', decoder_model_merged: 'q2f16' }
  : 'q2f16';
const localRepos = {};
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '--local-repo') continue;
  const entry = args[++index] || '';
  const separator = entry.indexOf('=');
  assert(separator > 0, '--local-repo requires owner/repo=directory');
  localRepos[entry.slice(0, separator)] = path.resolve(entry.slice(separator + 1));
}
const output = path.resolve(option('--output', '.build/bonsai/browser-result.json'));
const profile = path.resolve(option('--profile', '.build/bonsai/browser-profile'));
const timeout = Number(option('--timeout-ms', 30 * 60_000));
const result = { model, dtype, vision, ocr, compactImages: !ocr || args.includes('--compact-images'), startedAt: new Date().toISOString(), checks: [], errors: [] };
const workerBootstrap = `
const nativeFetch = globalThis.fetch.bind(globalThis);
const mapped = ${JSON.stringify(Object.keys(localRepos))};
globalThis.fetch = (input, init) => {
  const source = typeof input === 'string' ? input : input.url || String(input);
  const url = new URL(source, self.location.href);
  if (url.hostname === 'huggingface.co') {
    if (${args.includes('--offline')}) throw new Error('Offline verification blocked a Hugging Face fetch: ' + url.pathname);
    const match = url.pathname.match(/^\\/([^/]+\\/[^/]+)\\/resolve\\/[^/]+\\/(.+)$/);
    if (match && mapped.includes(match[1])) {
      return nativeFetch('/models/' + match[1] + '/' + match[2], init);
    }
  }
  return nativeFetch(input, init);
};
await import('/extension/src/offscreen/inference-worker.js');
self.postMessage({ type: 'harness-ready' });
`;
const mime = file => ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream');
const server = http.createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  response.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Bonsai WebGPU verification</title>Production WebGPU worker verification');
      return;
    }
    if (pathname === '/worker.mjs') {
      response.setHeader('Content-Type', 'text/javascript'); response.end(workerBootstrap); return;
    }
    let base, relative;
    if (pathname.startsWith('/extension/')) {
      base = path.join(root, 'src/chrome'); relative = pathname.slice('/extension/'.length);
    } else if (pathname.startsWith('/models/')) {
      const match = pathname.match(/^\/models\/([^/]+\/[^/]+)\/(.+)$/);
      base = match && localRepos[match[1]]; relative = match?.[2];
    }
    if (!base || !relative) { response.writeHead(404); response.end(); return; }
    const file = path.resolve(base, relative);
    if (!file.startsWith(path.resolve(base) + path.sep)) { response.writeHead(403); response.end(); return; }
    const stat = await fs.stat(file);
    response.setHeader('Content-Type', mime(file));
    response.setHeader('Content-Length', stat.size);
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).on('error', () => response.destroy()).pipe(response);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(error.code || 'file error');
  }
});
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(profile, { recursive: true });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(option('--port', 8769)), '127.0.0.1', resolve); });
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: ['--enable-unsafe-webgpu', '--force-high-performance-gpu',
      ...(option('--adapter-luid', '') ? [`--use-adapter-luid=${option('--adapter-luid')}`] : [])],
  });
  const page = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error') result.errors.push(message.text().slice(0, 2000));
    console.log(`[browser:${message.type()}] ${message.text().slice(0, 1000)}`);
  });
  page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(() => new Promise((ready, failed) => {
    const pending = new Map(); let id = 0, progressAt = 0;
    const worker = new Worker('/worker.mjs', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'harness-ready') { ready(); }
      else if (data.id && pending.has(data.id)) {
        const { resolve, reject, timer } = pending.get(data.id);
        clearTimeout(timer); pending.delete(data.id);
        if (data.ok === false) reject(new Error(data.error)); else resolve(data);
      } else if (data.type === 'text-download-state' && Date.now() - progressAt > 10_000) {
        progressAt = Date.now(); console.log(JSON.stringify(data.state));
      }
    };
    worker.onerror = event => {
      failed(new Error(event.message));
      for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(event.message)); }
      pending.clear();
    };
    window.workerCall = (type, payload, timeout) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timeout: ${type}`)); }, timeout);
      pending.set(requestId, { resolve, reject, timer });
      worker.postMessage({ id: requestId, type, payload });
    });
  }));
  const call = (type, payload = {}) => page.evaluate(({ type, payload, timeout }) => window.workerCall(type, payload, timeout), { type, payload, timeout });
  const origin = new URL(page.url()).origin;
  await call('init', {
    transformersUrl: `${origin}/extension/vendor/transformers/transformers.web.js`,
    wasmMjsUrl: `${origin}/extension/vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs`,
    wasmUrl: `${origin}/extension/vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm`,
  });
  result.probe = await call('probe');
  console.log(JSON.stringify({ probe: result.probe }));
  assert(result.probe.hasWebGPU, 'Hardware WebGPU required');
  assert(!result.probe.isFallbackAdapter, 'Software WebGPU cannot validate this model');
  result.adapter = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return { vendor: adapter?.info.vendor, architecture: adapter?.info.architecture, description: adapter?.info.description, device: adapter?.info.device };
  });
  if (!args.includes('--probe-only')) {
    if (args.includes('--clear-model-cache')) {
      assert(!args.includes('--offline'), '--clear-model-cache cannot be used with --offline');
      await call('stop-text-download', { modelId: model, dtype });
    }
    const loadStarted = Date.now();
    result.offline = args.includes('--offline');
    result.download = await call(result.offline ? 'text-download-status' : 'download-text', { modelId: model, dtype, device: 'webgpu' });
    result.loadSeconds = (Date.now() - loadStarted) / 1000;
    assert(result.download.ready, 'Download did not become ready');
    const chat = async (name, messages, options = {}) => {
      const started = Date.now();
      const response = await call(vision ? 'multimodal-text-chat' : 'text-chat', { modelId: model, dtype, device: 'webgpu', messages, options: { maxTokens: 160, ...options } });
      result.checks.push({ name, seconds: (Date.now() - started) / 1000, ...response });
      console.log(JSON.stringify(result.checks.at(-1)));
      return response;
    };
    const reply = await chat('text', [{ role: 'user', content: 'What is 17 plus 26? Reply with only the number.' }]);
    assert.match(reply.content, /^\s*43[.!]?\s*$/, 'Text answer must be correct and terminate at the end of its turn');
    if (!args.includes('--skip-tools')) {
      const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Look up the current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
      const toolReply = await chat('tool-call', [{ role: 'system', content: 'Use the provided tool for weather requests.' }, { role: 'user', content: 'What is the weather in Istanbul? Call the weather tool.' }], { tools, maxTokens: 300 });
      assert.match(JSON.stringify(toolReply), /get_weather/);
      assert.match(JSON.stringify(toolReply), /Istanbul/i);
      assert.equal((toolReply.content.match(/<tool_call>/g) || []).length, 1, 'Expected one complete tool call');
      assert.match(toolReply.content, /<\/tool_call>/, 'Truncated tool call');
      const followup = await chat('tool-result', [
        { role: 'user', content: 'What is the weather in Istanbul?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'weather-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Istanbul"}' } }] },
        { role: 'tool', tool_call_id: 'weather-1', content: '{"city":"Istanbul","temperature_celsius":19,"condition":"sunny"}' },
      ], { tools });
      assert.match(followup.content, /19/);
    }
    if (vision) {
      const history = [];
      const imageFailures = [];
      for (const [color, code, shape] of [['red', 'K7M2', 'rectangle'], ['blue', 'R4X9', 'circle']]) {
        // Prism recommends at least 1024 visual tokens for OCR. Use ~1MP
        // fixtures by default; compact mode preserves the earlier low-resolution
        // quality check without changing the application's image processor.
        const image = await page.evaluate(({ color, code, shape, compact, ocr }) => {
          const width = color === 'red' ? 448 : 576;
          const height = color === 'red' ? 448 : 384;
          const canvas = document.createElement('canvas');
          canvas.width = compact ? width : color === 'red' ? 1024 : 1248;
          canvas.height = compact ? height : color === 'red' ? 1024 : 832;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.scale(canvas.width / width, canvas.height / height);
          ctx.fillStyle = color;
          if (ocr || shape === 'rectangle') ctx.fillRect(64, 40, width - 128, 180);
          else { ctx.beginPath(); ctx.arc(width / 2, 130, 90, 0, 2 * Math.PI); ctx.fill(); }
          if (ocr) { ctx.font = 'bold 76px Arial'; ctx.fillStyle = 'black'; ctx.textAlign = 'center'; ctx.fillText(code, width / 2, 340); }
          return canvas.toDataURL('image/png');
        }, { color, code, shape, compact: result.compactImages, ocr });
        await fs.writeFile(output.replace(/\.json$/, '') + `-${color}.png`, Buffer.from(image.split(',')[1], 'base64'));
        const message = { role: 'user', content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: ocr
            ? 'What color is the rectangle, and what four-character code is printed below it? Reply with the color and code.'
            : 'What color is the large shape, and what is its shape? Reply with the color and shape.' },
        ] };
        const answer = await chat(`image-${color}`, [message]);
        if (!new RegExp(color, 'i').test(answer.content)) imageFailures.push(`${color}: wrong image color`);
        if (ocr && !answer.content.replace(/\s/g, '').includes(code)) imageFailures.push(`${color}: wrong image-only code (expected ${code})`);
        if (!ocr && !new RegExp(shape, 'i').test(answer.content)) imageFailures.push(`${color}: wrong image shape (expected ${shape})`);
        history.push(message, { role: 'assistant', content: answer.content });
      }
      // A failed image answer already fails the run; do not spend another
      // long prefill asking the model to repeat its incorrect earlier answer.
      assert.deepEqual(imageFailures, [], 'Image checks failed');
      if (args.includes('--image-history')) {
        const answer = await chat('image-history', [...history, { role: 'user', content: ocr
          ? 'Repeat only the color and four-character code from the SECOND image.'
          : 'Repeat only the color and shape from the SECOND image.' }]);
        if (!/blue/i.test(answer.content)) imageFailures.push('history: wrong image selected');
        if (ocr && !answer.content.replace(/\s/g, '').includes('R4X9')) imageFailures.push('history: wrong image-only code');
        if (!ocr && !/circle/i.test(answer.content)) imageFailures.push('history: wrong image shape');
      }
      assert.deepEqual(imageFailures, [], 'Image checks failed');
    }
    await call('dispose-all');
    result.cacheAfterDispose = await call('text-download-status', { modelId: model, dtype });
    assert(result.cacheAfterDispose.ready, 'Disposing GPU allocations lost download readiness');
  }
  result.passed = true;
} catch (error) {
  result.passed = false; result.failure = error.stack; console.error(error); process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  console.log(`Evidence: ${output}`);
}
