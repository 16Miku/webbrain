import { CACHE_NAME, MODEL_BASE, MODEL_FILES, LABELS, isMediaUrl, centerCrop, normalizedPixels } from './config.js';

let sessionPromise;
let model;
let ort;
let queue = Promise.resolve();
let queued = 0;
const report = (status, progress = 0) => self.postMessage({ state: { status, progress } });

async function checkedBytes(response, limit, onProgress = () => {}) {
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('File is too large.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('File is too large.');
      chunks.push(value);
      onProgress(size);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function modelFile(name) {
  const spec = MODEL_FILES[name];
  const url = MODEL_BASE + name;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  const response = cached || await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(120_000) });
  const bytes = await checkedBytes(response, spec.bytes, loaded => {
    if (!cached && name === 'model.onnx') report('downloading', Math.round(loaded / spec.bytes * 100));
  });
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (bytes.length !== spec.bytes || hash !== spec.sha256) {
    await cache.delete(url);
    throw new Error('Model verification failed. Retry the download.');
  }
  if (!cached) await cache.put(url, new Response(bytes));
  return bytes;
}

async function prepare() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      report('downloading');
      model = JSON.parse(new TextDecoder().decode(await modelFile('safesocial-model.json')));
      const bytes = await modelFile('model.onnx');
      report('loading', 100);
      // Executable JS/WASM stays packaged; only pinned model data comes from HF.
      ort = await import('../../vendor/transformers/ort.webgpu.mjs');
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = {
        mjs: new URL('../../vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
        wasm: new URL('../../vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href,
      };
      const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      report('ready', 100);
      return session;
    })().catch(error => { sessionPromise = null; report('error'); throw error; });
  }
  return sessionPromise;
}

async function classify(url) {
  if (!isMediaUrl(url)) throw new Error('Unsupported media URL.');
  const session = await prepare();
  // Do not turn the classifier into an arbitrary fetch proxy or follow redirects
  // from a permitted CDN to an unrelated host. No page cookies are needed.
  const response = await fetch(url, {
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  const type = response.headers.get('content-type') || '';
  if (!/^image\/(jpeg|png|webp|avif)(?:;|$)/i.test(type)) throw new Error('Unsupported image format.');
  const bytes = await checkedBytes(response, 12 * 1024 * 1024);
  const bitmap = await createImageBitmap(new Blob([bytes], { type }));
  let tensor;
  let output;
  try {
    const size = model.preprocessing.image_size;
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const crop = centerCrop(bitmap.width, bitmap.height, model.preprocessing);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size);
    const values = normalizedPixels(context.getImageData(0, 0, size, size).data, model.preprocessing);
    tensor = new ort.Tensor('float32', values, [1, 3, size, size]);
    output = await session.run({ [model.input_name]: tensor });
    const probabilities = output[model.output_name]?.data;
    if (probabilities?.length !== model.labels.length) throw new Error('Unexpected classifier output.');
    const scores = Object.fromEntries(model.labels.map((label, index) => [label, Number(probabilities[index])]));
    if (LABELS.some(label => !Number.isFinite(scores[label]) || scores[label] < 0 || scores[label] > 1)) {
      throw new Error('Invalid classifier scores.');
    }
    return { scores };
  } finally {
    bitmap.close();
    tensor?.dispose();
    for (const value of Object.values(output || {})) value.dispose();
  }
}

self.onmessage = ({ data }) => {
  const { id, command, url } = data;
  if (queued >= 32) { self.postMessage({ id, error: 'Classifier is busy. Try again shortly.' }); return; }
  queued++;
  queue = queue.then(async () => {
    try {
      const result = command === 'prepare' ? (await prepare(), {})
        : command === 'classify' ? await classify(url) : (() => { throw new Error('Unknown classifier command.'); })();
      self.postMessage({ id, result });
    } catch (error) { self.postMessage({ id, error: error.message }); }
    finally { queued--; }
  });
};
