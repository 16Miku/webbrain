// Compass VLD Tiny v5 in the offscreen worker (src/chrome/src/offscreen/compass-vld-runtime.js):
// the pinned download, the MiniCPM-V processor port and the canvas M-RoPE positions,
// checked without a GPU. The processor reference (test/fixtures/compass-vld-processor.json)
// was written by the PyTorch processor of openbmb/MiniCPM-V-4.7-1B for synthetic images.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as runtime from '../src/chrome/src/offscreen/compass-vld-runtime.js';
import {
  WEBGPU_COMPASS_VLD_DTYPE, WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID, WEBGPU_DEFAULT_MODEL_ID, webgpuModelPreset,
} from '../src/chrome/src/providers/webgpu.js';

const MODEL = runtime.COMPASS_VLD_TINY_V5_MODEL_ID;
const fixture = JSON.parse(await readFile(new URL('./fixtures/compass-vld-processor.json', import.meta.url), 'utf8'));

test('the preset, the runtime and the default agree on the model, its dtype and its size', () => {
  assert.equal(MODEL, WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID);
  assert.equal(WEBGPU_DEFAULT_MODEL_ID, MODEL);
  assert.deepEqual(runtime.COMPASS_VLD_DTYPE, WEBGPU_COMPASS_VLD_DTYPE);
  assert.equal(runtime.isCompassVldModel(` ${MODEL} `), true);
  assert.equal(runtime.isCompassVldModel('webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision'), false);
  const files = runtime.compassVldFiles();
  assert.deepEqual(files.map(file => file.path), [
    'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer_config.json', 'chat_template.jinja', 'tokenizer.json',
    'onnx/embed_tokens_q8f16.onnx', 'onnx/embed_tokens_q8f16.onnx_data',
    'onnx/vision_encoder_fp16.onnx', 'onnx/vision_encoder_fp16.onnx_data',
    'onnx/decoder_model_merged_q8f16.onnx', 'onnx/decoder_model_merged_q8f16.onnx_data',
  ]);
  for (const file of files) {
    assert.ok(Number.isInteger(file.bytes) && file.bytes > 0, file.path);
    assert.match(file.sha256, /^[0-9a-f]{64}$/, file.path);
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  assert.equal(`${(total / 1e9).toFixed(1)} GB`, webgpuModelPreset(MODEL).size, 'the preset quotes the download size');
  // The smaller Q4 graphs are pinned too, for a lighter preset later.
  const lite = runtime.compassVldFiles({ embed_tokens: 'q4f16', vision_encoder: 'fp16', decoder_model_merged: 'q4f16' });
  assert.ok(lite.reduce((sum, file) => sum + file.bytes, 0) < total);
  assert.throws(() => runtime.compassVldFiles({ ...runtime.COMPASS_VLD_DTYPE, decoder_model_merged: 'fp32' }), /has no onnx\/decoder_model_merged_fp32\.onnx/);
});

test('files are read at a pinned commit, from their Hugging Face URL', () => {
  assert.match(runtime.COMPASS_VLD_REVISION, /^[0-9a-f]{40}$/);
  assert.equal(runtime.compassVldFileUrl('owner/repo', 'onnx/a.onnx'), `https://huggingface.co/owner/repo/resolve/${runtime.COMPASS_VLD_REVISION}/onnx/a.onnx`);
});

test('the tokenizer is built from the cached files alone: the class AutoTokenizer would pick, with the chat template', async () => {
  const library = await import('../src/chrome/vendor/transformers/transformers.web.js');
  const files = new Map();
  const put = (path, text) => files.set(runtime.compassVldFileUrl(MODEL, path), new TextEncoder().encode(text));
  const cache = { async match(url) { const bytes = files.get(url); return bytes ? new Response(bytes) : undefined; } };
  put('tokenizer.json', JSON.stringify({
    version: '1.0', truncation: null, padding: null, normalizer: null, post_processor: null,
    added_tokens: [{ id: 4, content: '<|im_end|>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true }],
    pre_tokenizer: { type: 'ByteLevel', add_prefix_space: false, trim_offsets: true, use_regex: true },
    decoder: { type: 'ByteLevel', add_prefix_space: true, trim_offsets: true, use_regex: true },
    model: { type: 'BPE', dropout: null, unk_token: null, continuing_subword_prefix: '', end_of_word_suffix: '', fuse_unk: false, byte_fallback: false,
      vocab: { h: 0, i: 1, hi: 2, '!': 3 }, merges: ['h i'] },
  }));
  put('tokenizer_config.json', JSON.stringify({ tokenizer_class: 'Qwen2TokenizerFast', eos_token: '<|im_end|>' }));
  put('chat_template.jinja', "{% for m in messages %}{{ m['content'] }}<|im_end|>{% endfor %}");
  // Offline, nothing may be fetched: AutoTokenizer.from_pretrained looked for
  // tokenizer_config.json at revision `main`, which the pinned download never caches.
  const previousFetch = library.env.fetch;
  library.env.fetch = async url => { throw new TypeError(`offline: ${url}`); };
  try {
    const tokenizer = await runtime.createCompassVldTokenizer(library, cache, MODEL);
    assert.equal(tokenizer.constructor, library.Qwen2Tokenizer);
    assert.deepEqual(Array.from(tokenizer.encode('hi!<|im_end|>', { add_special_tokens: false })), [2, 3, 4]);
    assert.equal(tokenizer.decode([2, 3, 4], { skip_special_tokens: true }), 'hi!');
    assert.equal(tokenizer.apply_chat_template([{ role: 'user', content: 'hi' }], { tokenize: false }), 'hi<|im_end|>');
    for (const name of ['Tensor', 'NoSuchTokenizer', undefined]) {
      put('tokenizer_config.json', JSON.stringify({ tokenizer_class: name }));
      assert.equal((await runtime.createCompassVldTokenizer(library, cache, MODEL)).constructor, library.PreTrainedTokenizer, `${name}: the base class`);
    }
    files.delete(runtime.compassVldFileUrl(MODEL, 'tokenizer.json'));
    await assert.rejects(runtime.createCompassVldTokenizer(library, cache, MODEL), error => error.code === 'text_model_not_downloaded');
  } finally {
    library.env.fetch = previousFetch;
  }
});

// Cache Storage and fetch, enough for the download path.
function memoryCache() {
  const entries = new Map();
  return {
    entries,
    async match(url) { const bytes = entries.get(url); return bytes ? new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } }) : undefined; },
    async put(url, response) { entries.set(url, new Uint8Array(await response.arrayBuffer())); },
    async delete(url) { return entries.delete(url); },
  };
}
const fileOf = (path, text) => {
  const bytes = new TextEncoder().encode(text);
  return { path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), body: bytes };
};

test('a download stores each file only after its size and SHA-256 match, and skips files already cached', async () => {
  const files = [fileOf('config.json', '{"a":1}'), fileOf('onnx/model.onnx_data', 'weights'.repeat(1000))];
  const cache = memoryCache();
  const fetched = [];
  const fetchImpl = async url => {
    fetched.push(url);
    const file = files.find(entry => url.endsWith(`/${entry.path}`));
    return new Response(file.body);
  };
  const events = [];
  await runtime.downloadCompassVld({ cache, fetchImpl, modelId: MODEL, files, onProgress: event => events.push(event) });
  assert.equal(fetched.length, 2);
  assert.equal(await runtime.compassVldFilesCached(cache, MODEL, undefined, files), true);
  assert.deepEqual(events.filter(event => event.status === 'done').map(event => event.file), files.map(file => file.path));
  assert.ok(events.some(event => event.status === 'progress' && event.loaded > 0 && event.total === files[1].bytes), 'progress counts bytes as they arrive');
  fetched.length = 0;
  await runtime.downloadCompassVld({ cache, fetchImpl, modelId: MODEL, files });
  assert.equal(fetched.length, 0, 'cached files are not fetched again');

  const corrupt = memoryCache();
  await assert.rejects(runtime.downloadCompassVld({ cache: corrupt, modelId: MODEL, files,
    fetchImpl: async url => new Response(url.endsWith('config.json') ? '{"a":2}' : files[1].body) }), /config\.json failed its integrity check/);
  assert.equal(corrupt.entries.size, 0, 'a file that fails its hash is removed');
  assert.equal(await runtime.compassVldFilesCached(corrupt, MODEL, undefined, files), false);
  let notFound = 0;
  await assert.rejects(runtime.downloadCompassVld({ cache: memoryCache(), modelId: MODEL, files,
    fetchImpl: async () => { notFound++; return new Response('missing', { status: 404 }); } }), /config\.json failed \(HTTP 404\)/);
  assert.equal(notFound, 1, 'a missing file is not fetched again');
  await assert.rejects(runtime.downloadCompassVld({ cache: memoryCache(), modelId: MODEL, files, isCancelled: () => true,
    fetchImpl: async () => { throw new Error('nothing is fetched after a cancel'); } }), error => error.name === 'AbortError');
});

test('a dropped connection or a server error retries that file twice, and a stop ends the retries', async () => {
  const files = [fileOf('config.json', '{"a":1}'), fileOf('onnx/model.onnx_data', 'weights'.repeat(1000))];
  const waits = [];
  const sleep = async ms => { waits.push(ms); };
  const flaky = failures => {
    const calls = [];
    return { calls, fetchImpl: async url => {
      calls.push(url);
      const file = files.find(entry => url.endsWith(`/${entry.path}`));
      const failure = failures.shift();
      if (failure === 'network') throw new TypeError('Failed to fetch');
      if (failure === 'body') return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('network error')); } }));
      if (typeof failure === 'number') return new Response('busy', { status: failure });
      return new Response(file.body);
    } };
  };
  const cache = memoryCache();
  const first = flaky(['network', 'body']);
  await runtime.downloadCompassVld({ cache, modelId: MODEL, files, sleep, fetchImpl: first.fetchImpl });
  assert.equal(first.calls.length, 4, 'config.json after two failures, then the weights');
  assert.deepEqual(waits, [2000, 4000]);
  assert.equal(await runtime.compassVldFilesCached(cache, MODEL, undefined, files), true);

  const busy = flaky([503, 503, 503]);
  await assert.rejects(runtime.downloadCompassVld({ cache: memoryCache(), modelId: MODEL, files, sleep, fetchImpl: busy.fetchImpl }), /HTTP 503/);
  assert.equal(busy.calls.length, 3, 'two retries, then the error');

  let stopped = false;
  const stop = flaky(['network', 'network']);
  await assert.rejects(runtime.downloadCompassVld({ cache: memoryCache(), modelId: MODEL, files, isCancelled: () => stopped,
    sleep: async () => { stopped = true; }, fetchImpl: stop.fetchImpl }), error => error.name === 'AbortError');
  assert.equal(stop.calls.length, 1, 'a stop during the wait fetches nothing more');
});

test('Python rounding ties to even, as the processor does', () => {
  assert.deepEqual([0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5, 2.4, 2.6, 7].map(runtime.pyRound), [0, 2, 2, 4, -0, -2, -2, 2, 3, 7]);
});

// MiniCPMV4_6ImageProcessor.get_sliced_grid (transformers, image_processing_minicpmv4_6.py),
// transliterated: [rows, cols], or null for a thumbnail only.
function referenceSlicedGrid(height, width, maxSliceNums, scaleResolution) {
  const logRatio = Math.log(width / height);
  const multiple = Math.min(Math.ceil((width * height) / (scaleResolution * scaleResolution)), maxSliceNums);
  if (multiple <= 1) return null;
  let best = [1, 1];
  let minError = Infinity;
  for (const numSlices of [multiple - 1, multiple, multiple + 1]) {
    if (numSlices === 1 || numSlices > maxSliceNums) continue;
    for (let rows = 1; rows <= numSlices; rows += 1) {
      if (numSlices % rows) continue;
      const cols = numSlices / rows;
      const error = Math.abs(logRatio - Math.log(cols / rows));
      if (error < minError) { best = [rows, cols]; minError = error; } else if (error === minError && rows > best[0]) best = [rows, cols];
    }
  }
  return best;
}

test('the slice grid follows the processor for every screen size', () => {
  for (let width = 64; width <= 4096; width += 61) {
    for (let height = 64; height <= 4096; height += 67) {
      assert.deepEqual(runtime.getSlicedGrid(height, width, 9, 448), referenceSlicedGrid(height, width, 9, 448), `${width}x${height}`);
    }
  }
  assert.equal(runtime.getSlicedGrid(448, 448, 9, 448), null, 'up to one 448x448 area the thumbnail is enough');
  assert.deepEqual(runtime.getSlicedGrid(800, 1280, 9, 448), [2, 3]);
});

test('crops, image placeholders and canvas positions match the PyTorch processor', () => {
  assert.equal(fixture.image_pad, runtime.COMPASS_VLD.imagePad);
  for (const entry of fixture.cases) {
    // Pixels do not change the layout; the end-to-end decision check covers them.
    const images = entry.sizes.map(([width, height]) => runtime.preprocessImage(new Uint8Array(width * height * 3), width, height));
    assert.deepEqual(images.flatMap(image => image.crops.map(crop => [crop.h, crop.w])), entry.target_sizes, `${entry.name}: crops`);
    assert.equal(runtime.expandImagePlaceholders(entry.rendered, images), entry.expanded, `${entry.name}: placeholders`);
    const positions = runtime.canvasPositions(entry.input_ids, entry.target_sizes);
    assert.deepEqual([Array.from(positions.t), Array.from(positions.h), Array.from(positions.w)], entry.positions, `${entry.name}: positions`);
    assert.equal(positions.nextPosition, Math.max(...entry.positions.flat()) + 1);
  }
  assert.throws(() => runtime.expandImagePlaceholders('<|image_pad|> and <|image_pad|>', []), /2 image slots for 0 images/);
});

test('image pixels become RGB, alpha dropped and grey expanded, before the processor sees them', () => {
  assert.deepEqual(Array.from(runtime.toRGB(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 0]), 2, 1, 4)), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(runtime.toRGB(new Uint8Array([7, 9]), 2, 1, 1)), [7, 7, 7, 9, 9, 9]);
  assert.throws(() => runtime.toRGB(new Uint8Array(4), 2, 1, 2), /2 channels/);
  assert.deepEqual(Array.from(runtime.f16ToF32(new Uint16Array([0x3c00, 0xc000, 0x0001, 0x7c00, 0x0000]))), [1, -2, 2 ** -24, Infinity, 0]);
  assert.equal(runtime.argmax([0.1, 3, -2, 3]), 1, 'the first of equal maxima, as greedy decoding expects');
});
