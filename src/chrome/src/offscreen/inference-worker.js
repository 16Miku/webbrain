/**
 * Dedicated WebGPU worker for endpoint-free local model inference.
 *
 * WebGPU is unavailable in the MV3 service worker, and large ONNX allocations
 * are more reliable in a dedicated worker than on the offscreen document's
 * main thread. The offscreen host owns this worker and proxies correlated
 * request/response messages to it.
 */

let libraryPromise = null;
let libraryVersion = null;
let workerConfig = null;
let visionRuntime = null;
let visionRuntimeKey = '';
let visionRuntimeLoadPromise = null;
let visionRuntimeLoadKey = '';
let textRuntime = null;
let textRuntimeKey = '';
let textRuntimeLoadPromise = null;
let textRuntimeLoadKey = '';
let modelOperationQueue = Promise.resolve();
const TRANSFORMERS_CACHE_NAME = 'transformers-cache';
const TEXT_DOWNLOAD_EVENT = 'text-download-state';
const WEBGPU_TEXT_MAX_NEW_TOKENS = 256;
const readyTextModelKeys = new Set();
const textDownloadFiles = new Map();
const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
let activeTextDownloadModelId = '';
let textDownloadAbortController = null;
let textDownloadCancelMode = '';
let lastTextProgressPostAt = 0;
let webGpuAdapterProbePromise = null;
let webGpuAdapterSummary = '';
let observedWebGpuDevice = null;
let lastWebGpuDeviceError = '';
let lastWebGpuDeviceLost = '';
let textDownloadState = {
  status: 'not-downloaded',
  ready: false,
  modelId: '',
  dtype: '',
  file: '',
  loaded: 0,
  total: 0,
  progress: 0,
  error: '',
};

function textModelKey(modelId, dtype) {
  return `${String(modelId || '').trim()}|${String(dtype || '').trim()}`;
}

function textReadyMarkerUrl(modelId, dtype) {
  const key = encodeURIComponent(textModelKey(modelId, dtype));
  return `https://webbrain.one/.well-known/webgpu-model-ready/${key}`;
}

function safeDecodedUrl(value) {
  try { return decodeURIComponent(String(value || '')); } catch { return String(value || ''); }
}

function fetchTargetsActiveTextModel(input) {
  if (!activeTextDownloadModelId) return false;
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
  return safeDecodedUrl(url).includes(`/${activeTextDownloadModelId}/`);
}

async function controlledFetch(input, init = {}) {
  if (!nativeFetch) throw new Error('Fetch is unavailable in the WebGPU worker.');
  if (textDownloadAbortController && fetchTargetsActiveTextModel(input)) {
    return nativeFetch(input, { ...init, signal: textDownloadAbortController.signal });
  }
  return nativeFetch(input, init);
}

function textDownloadSnapshot() {
  return { ...textDownloadState };
}

function postTextDownloadState({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastTextProgressPostAt < 160) return;
  lastTextProgressPostAt = now;
  self.postMessage({ type: TEXT_DOWNLOAD_EVENT, state: textDownloadSnapshot() });
}

async function isTextModelReady(modelId, dtype) {
  const key = textModelKey(modelId, dtype);
  if (readyTextModelKeys.has(key)) return true;
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    const marker = await cache.match(textReadyMarkerUrl(modelId, dtype));
    if (!marker) return false;
    readyTextModelKeys.add(key);
    return true;
  } catch {
    return false;
  }
}

async function markTextModelReady(modelId, dtype) {
  const key = textModelKey(modelId, dtype);
  if (typeof caches === 'undefined') {
    readyTextModelKeys.add(key);
    return;
  }
  const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
  await cache.put(textReadyMarkerUrl(modelId, dtype), new Response(JSON.stringify({ modelId, dtype }), {
    headers: { 'content-type': 'application/json' },
  }));
  readyTextModelKeys.add(key);
}

async function loadLibrary() {
  if (libraryPromise) return libraryPromise;
  if (!workerConfig) throw new Error('WebGPU worker was not initialized.');
  libraryPromise = (async () => {
    let library;
    try {
      library = await import(workerConfig.transformersUrl);
    } catch (error) {
      libraryPromise = null;
      throw new Error(`The packaged Transformers.js runtime could not be loaded: ${error?.message || error}`);
    }
    libraryVersion = library.env?.version || library.VERSION || 'unknown';
    if (library.env) {
      library.env.allowLocalModels = false;
      library.env.allowRemoteModels = true;
      library.env.useBrowserCache = true;
      library.env.useWasmCache = false;
      library.env.fetch = controlledFetch;
      const wasm = library.env.backends?.onnx?.wasm;
      if (wasm) {
        wasm.numThreads = 1;
        wasm.wasmPaths = {
          mjs: workerConfig.wasmMjsUrl,
          wasm: workerConfig.wasmUrl,
        };
      }
    }
    return library;
  })();
  return libraryPromise;
}

function compactAdapterInfo(adapter) {
  if (!adapter) return '';
  const info = adapter.info || {};
  const identity = [info.vendor, info.architecture, info.device, info.description]
    .map(value => String(value || '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(' / ');
  const maxBufferSize = Number(adapter.limits?.maxBufferSize);
  const maxStorageBinding = Number(adapter.limits?.maxStorageBufferBindingSize);
  const limits = [
    Number.isFinite(maxBufferSize) ? `maxBufferSize=${maxBufferSize}` : '',
    Number.isFinite(maxStorageBinding) ? `maxStorageBufferBindingSize=${maxStorageBinding}` : '',
  ].filter(Boolean).join(', ');
  return [identity, limits].filter(Boolean).join('; ');
}

async function captureWebGpuAdapterSummary() {
  if (webGpuAdapterProbePromise) return webGpuAdapterProbePromise;
  webGpuAdapterProbePromise = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) return '';
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      webGpuAdapterSummary = compactAdapterInfo(adapter);
    } catch {}
    return webGpuAdapterSummary;
  })();
  return webGpuAdapterProbePromise;
}

function bindWebGpuDeviceDiagnostics(library) {
  const device = library?.env?.backends?.onnx?.webgpu?.device;
  if (!device || device === observedWebGpuDevice) return;
  observedWebGpuDevice = device;
  lastWebGpuDeviceError = '';
  lastWebGpuDeviceLost = '';
  device.addEventListener?.('uncapturederror', event => {
    lastWebGpuDeviceError = String(event?.error?.message || event?.message || 'Unknown WebGPU validation error.');
    console.error('[webgpu] uncaptured device error:', lastWebGpuDeviceError);
  });
  device.lost?.then(info => {
    if (device !== observedWebGpuDevice) return;
    lastWebGpuDeviceLost = String(info?.message || info?.reason || 'The WebGPU device was lost.');
    console.error('[webgpu] device lost:', lastWebGpuDeviceLost);
  }).catch(() => {});
}

function isWebGpuExecutionFailure(error) {
  return /OrtRun|BufferManager::Download|mapAsync|GPUBuffer|device lost/i.test(error?.message || String(error));
}

async function enrichWebGpuExecutionError(error) {
  // WebGPU uncaptured-error/device-lost events can arrive just after OrtRun's
  // generic buffer readback exception. Give that event one task to land so the
  // user sees the actionable root error instead of only "Invalid Buffer".
  await new Promise(resolve => setTimeout(resolve, 0));
  const details = [lastWebGpuDeviceError, lastWebGpuDeviceLost]
    .map(value => String(value || '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const adapter = webGpuAdapterSummary || await captureWebGpuAdapterSummary();
  const suffix = [
    details.length ? `GPU detail: ${details.join(' ')}` : '',
    adapter ? `Adapter: ${adapter}.` : '',
    'Close other GPU-heavy tabs/apps and retry with a short prompt. If it persists, this GPU/driver cannot execute Ling with the current WebGPU runtime.',
  ].filter(Boolean).join(' ');
  return new Error(`${error?.message || String(error)} ${suffix}`);
}

function postProgress(modelId, event) {
  if (modelId === activeTextDownloadModelId && !textDownloadCancelMode) {
    const file = String(event?.file || event?.name || '');
    if (file) {
      const previous = textDownloadFiles.get(file) || { loaded: 0, total: 0, status: '' };
      const total = Number(event?.total || previous.total || 0);
      const loaded = event?.status === 'done' && total > 0
        ? total
        : Number(event?.loaded ?? previous.loaded ?? 0);
      textDownloadFiles.set(file, {
        status: event?.status || previous.status,
        loaded: Math.max(0, loaded),
        total: Math.max(0, total),
      });
    }
    let loaded = 0;
    let total = 0;
    for (const item of textDownloadFiles.values()) {
      if (item.total <= 0) continue;
      loaded += Math.min(item.loaded, item.total);
      total += item.total;
    }
    textDownloadState = {
      ...textDownloadState,
      status: 'downloading',
      ready: false,
      file,
      loaded,
      total,
      progress: total > 0 ? Math.max(0, Math.min(100, loaded / total * 100)) : 0,
      error: '',
    };
    postTextDownloadState({ force: event?.status === 'done' });
  }
  self.postMessage({
    type: 'progress',
    modelId,
    status: event?.status || '',
    file: event?.file || event?.name || '',
    loaded: Number(event?.loaded || 0),
    total: Number(event?.total || 0),
    progress: Number(event?.progress || 0),
  });
}

async function disposeRuntime(runtime) {
  if (runtime?.pipeline?.dispose) {
    try { await runtime.pipeline.dispose(); } catch {}
  } else if (runtime?.model?.dispose) {
    try { await runtime.model.dispose(); } catch {}
  }
  if (runtime?.processor?.dispose) {
    try { await runtime.processor.dispose(); } catch {}
  }
}

async function disposeVisionRuntime() {
  const runtime = visionRuntime;
  visionRuntime = null;
  visionRuntimeKey = '';
  await disposeRuntime(runtime);
}

async function disposeTextRuntime() {
  const runtime = textRuntime;
  textRuntime = null;
  textRuntimeKey = '';
  await disposeRuntime(runtime);
}

async function disposeAllRuntimes() {
  await disposeVisionRuntime();
  await disposeTextRuntime();
}

async function getVisionRuntime(modelId, dtype, device) {
  const key = `vision|${modelId}|${device}|${JSON.stringify(dtype)}`;
  if (visionRuntime && visionRuntimeKey === key) return visionRuntime;
  if (visionRuntimeLoadPromise) {
    if (visionRuntimeLoadKey === key) return visionRuntimeLoadPromise;
    await visionRuntimeLoadPromise.catch(() => {});
    if (visionRuntime && visionRuntimeKey === key) return visionRuntime;
  }

  const loadPromise = (async () => {
    const library = await loadLibrary();
    const { AutoModelForImageTextToText, AutoProcessor } = library;
    if (!AutoModelForImageTextToText || !AutoProcessor) {
      throw new Error('The packaged Transformers.js version does not include image-text-to-text support.');
    }
    await disposeVisionRuntime();
    const progress_callback = event => postProgress(modelId, event);
    const [processorResult, modelResult] = await Promise.allSettled([
      AutoProcessor.from_pretrained(modelId, { progress_callback }),
      AutoModelForImageTextToText.from_pretrained(modelId, {
        device,
        dtype,
        progress_callback,
      }),
    ]);
    if (processorResult.status === 'rejected' || modelResult.status === 'rejected') {
      const loaded = [processorResult, modelResult]
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);
      for (const resource of loaded) {
        if (resource?.dispose) {
          try { await resource.dispose(); } catch {}
        }
      }
      throw processorResult.status === 'rejected'
        ? processorResult.reason
        : modelResult.reason;
    }
    const processor = processorResult.value;
    const model = modelResult.value;
    visionRuntime = { library, processor, model };
    visionRuntimeKey = key;
    return visionRuntime;
  })();
  visionRuntimeLoadPromise = loadPromise;
  visionRuntimeLoadKey = key;
  try {
    return await loadPromise;
  } finally {
    if (visionRuntimeLoadPromise === loadPromise) {
      visionRuntimeLoadPromise = null;
      visionRuntimeLoadKey = '';
    }
  }
}

async function getTextRuntime(modelId, dtype, device, { localFilesOnly = false } = {}) {
  const key = `text|${modelId}|${device}|${JSON.stringify(dtype)}`;
  if (textRuntime && textRuntimeKey === key) return textRuntime;
  if (textRuntimeLoadPromise) {
    if (textRuntimeLoadKey === key) return textRuntimeLoadPromise;
    await textRuntimeLoadPromise.catch(() => {});
    if (textRuntime && textRuntimeKey === key) return textRuntime;
  }

  const loadPromise = (async () => {
    const library = await loadLibrary();
    if (!library.pipeline) {
      throw new Error('The packaged Transformers.js version does not include text generation.');
    }
    await captureWebGpuAdapterSummary();
    await disposeTextRuntime();
    const previousAllowLocalModels = library.env?.allowLocalModels;
    if (localFilesOnly && library.env) library.env.allowLocalModels = true;
    let pipeline;
    try {
      pipeline = await library.pipeline('text-generation', modelId, {
        device,
        dtype,
        local_files_only: localFilesOnly,
        progress_callback: event => postProgress(modelId, event),
      });
    } finally {
      if (localFilesOnly && library.env) library.env.allowLocalModels = previousAllowLocalModels;
    }
    bindWebGpuDeviceDiagnostics(library);
    textRuntime = {
      library,
      pipeline,
      model: pipeline.model,
      tokenizer: pipeline.tokenizer,
    };
    textRuntimeKey = key;
    return textRuntime;
  })();
  textRuntimeLoadPromise = loadPromise;
  textRuntimeLoadKey = key;
  try {
    return await loadPromise;
  } finally {
    if (textRuntimeLoadPromise === loadPromise) {
      textRuntimeLoadPromise = null;
      textRuntimeLoadKey = '';
    }
  }
}

async function getTextDownloadStatus(modelId, dtype) {
  const ready = await isTextModelReady(modelId, dtype);
  const sameModel = textDownloadState.modelId === modelId && textDownloadState.dtype === dtype;
  if (ready && (!sameModel || !['downloading', 'stopping'].includes(textDownloadState.status))) {
    textDownloadState = {
      status: 'ready',
      ready: true,
      modelId,
      dtype,
      file: sameModel ? textDownloadState.file : '',
      loaded: sameModel ? textDownloadState.loaded : 0,
      total: sameModel ? textDownloadState.total : 0,
      progress: 100,
      error: '',
    };
  } else if (!ready && !sameModel) {
    textDownloadState = {
      status: 'not-downloaded',
      ready: false,
      modelId,
      dtype,
      file: '',
      loaded: 0,
      total: 0,
      progress: 0,
      error: '',
    };
  }
  return textDownloadSnapshot();
}

async function downloadTextModel(payload) {
  const modelId = String(payload?.modelId || '').trim();
  if (!modelId) throw new Error('No text-generation model was specified.');
  const device = payload?.device || 'webgpu';
  const dtype = payload?.dtype || 'q4f16';
  if (await isTextModelReady(modelId, dtype)) {
    textDownloadState = {
      ...textDownloadState,
      status: 'ready',
      ready: true,
      modelId,
      dtype,
      progress: 100,
      error: '',
    };
    postTextDownloadState({ force: true });
    return textDownloadSnapshot();
  }

  const resuming = textDownloadState.status === 'paused'
    && textDownloadState.modelId === modelId
    && textDownloadState.dtype === dtype;
  if (!resuming) textDownloadFiles.clear();
  activeTextDownloadModelId = modelId;
  textDownloadCancelMode = '';
  const controller = new AbortController();
  textDownloadAbortController = controller;
  textDownloadState = {
    status: 'downloading',
    ready: false,
    modelId,
    dtype,
    file: resuming ? textDownloadState.file : '',
    loaded: resuming ? textDownloadState.loaded : 0,
    total: resuming ? textDownloadState.total : 0,
    progress: resuming ? textDownloadState.progress : 0,
    error: '',
  };
  postTextDownloadState({ force: true });

  try {
    await getTextRuntime(modelId, dtype, device);
    if (textDownloadCancelMode) {
      await disposeTextRuntime();
      return textDownloadSnapshot();
    }
    await markTextModelReady(modelId, dtype);
    textDownloadState = {
      ...textDownloadState,
      status: 'ready',
      ready: true,
      progress: 100,
      error: '',
    };
    postTextDownloadState({ force: true });
    return textDownloadSnapshot();
  } catch (error) {
    if (textDownloadCancelMode === 'pause' || textDownloadCancelMode === 'stop' || controller.signal.aborted) {
      textDownloadState = {
        ...textDownloadState,
        status: textDownloadCancelMode === 'stop' ? 'stopping' : 'paused',
        ready: false,
        error: '',
      };
      postTextDownloadState({ force: true });
      return textDownloadSnapshot();
    }
    textDownloadState = {
      ...textDownloadState,
      status: 'error',
      ready: false,
      error: error?.message || String(error),
    };
    postTextDownloadState({ force: true });
    throw error;
  } finally {
    if (textDownloadAbortController === controller) textDownloadAbortController = null;
    activeTextDownloadModelId = '';
  }
}

function pauseTextDownload() {
  if (textDownloadState.status !== 'downloading') return textDownloadSnapshot();
  textDownloadCancelMode = 'pause';
  textDownloadState = { ...textDownloadState, status: 'paused', ready: false, error: '' };
  textDownloadAbortController?.abort();
  postTextDownloadState({ force: true });
  return textDownloadSnapshot();
}

async function clearTextModelCache(modelId, dtype) {
  await disposeTextRuntime();
  const modelPath = `/${modelId}/`;
  const markerUrl = textReadyMarkerUrl(modelId, dtype);
  if (typeof caches !== 'undefined') {
    for (const name of await caches.keys()) {
      if (!/transformers/i.test(name)) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = safeDecodedUrl(request.url);
        if (url.includes(modelPath) || request.url === markerUrl) await cache.delete(request);
      }
      await cache.delete(markerUrl);
    }
  }
  readyTextModelKeys.delete(textModelKey(modelId, dtype));
  textDownloadFiles.clear();
  textDownloadCancelMode = '';
  textDownloadState = {
    status: 'not-downloaded',
    ready: false,
    modelId,
    dtype,
    file: '',
    loaded: 0,
    total: 0,
    progress: 0,
    error: '',
  };
  postTextDownloadState({ force: true });
  return textDownloadSnapshot();
}

function enqueueModelOperation(operation) {
  const result = modelOperationQueue.then(operation, operation);
  // Keep the queue usable after one request fails while preserving that
  // failure for the caller awaiting `result`.
  modelOperationQueue = result.catch(() => {});
  return result;
}

function imageUrlFromBlock(block) {
  if (block?.type === 'image_url') {
    return typeof block.image_url === 'string'
      ? block.image_url
      : block.image_url?.url;
  }
  if (block?.type === 'image') {
    return typeof block.image === 'string' ? block.image : block.url;
  }
  return '';
}

function prepareMultimodalMessages(messages) {
  const imageUrls = [];
  const prepared = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = ['system', 'user', 'assistant'].includes(message.role)
      ? message.role
      : 'user';
    const imageBlocks = [];
    const textBlocks = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          textBlocks.push({ type: 'text', text: block.text });
          continue;
        }
        const imageUrl = imageUrlFromBlock(block);
        if (imageUrl) {
          imageUrls.push(imageUrl);
          imageBlocks.push({ type: 'image' });
        }
      }
    } else if (typeof message.content === 'string') {
      textBlocks.push({ type: 'text', text: message.content });
    }
    // LFM2.5-VL's published chat template places <image> before the question.
    // Normalize OpenAI-style messages (which often put text first) to that
    // model-specific contract without changing the provider-facing API.
    const blocks = [...imageBlocks, ...textBlocks];
    if (blocks.length) prepared.push({ role, content: blocks });
  }
  if (imageUrls.length !== 1) {
    throw new Error(`LFM2.5-VL requires exactly one screenshot; received ${imageUrls.length}.`);
  }
  return { messages: prepared, imageUrl: imageUrls[0] };
}

function createVisionProbeImage(RawImage) {
  if (!RawImage) throw new Error('The packaged runtime does not expose RawImage.');
  // LFM2.5-VL-450M is much more dependable at coarse visual classification
  // than fine OCR. Use three large, unlabeled color panels so the connection
  // test still proves that pixels reached the model without asking it to read
  // tiny synthetic glyphs.
  const width = 480;
  const height = 320;
  const channels = 3;
  const colors = [
    [255, 255, 0],
    [0, 0, 255],
    [255, 0, 0],
  ];
  const data = new Uint8ClampedArray(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const targetOffset = (y * width + x) * channels;
      const color = colors[Math.min(colors.length - 1, Math.floor(x / (width / colors.length)))];
      for (let channel = 0; channel < channels; channel++) {
        data[targetOffset + channel] = color[channel];
      }
    }
  }
  return new RawImage(data, width, height, channels);
}

async function runVision(payload) {
  const modelId = String(payload?.modelId || '').trim();
  if (!modelId) throw new Error('No vision model was specified.');
  const device = payload?.device || 'webgpu';
  const dtype = payload?.dtype || {
    embed_tokens: 'fp16',
    vision_encoder: 'fp16',
    decoder_model_merged: 'q4',
  };
  const runtime = await getVisionRuntime(modelId, dtype, device);
  const { messages, imageUrl } = prepareMultimodalMessages(payload?.messages);
  const prompt = runtime.processor.apply_chat_template(messages, {
    add_generation_prompt: true,
  });
  const image = payload?.options?.visionProbe === true
    ? createVisionProbeImage(runtime.library.RawImage)
    : await runtime.library.load_image(imageUrl);
  const inputs = await runtime.processor(image, prompt, { add_special_tokens: false });
  const requestedTokens = Number(payload?.options?.maxTokens);
  const maxNewTokens = Number.isFinite(requestedTokens)
    ? Math.max(1, Math.min(1600, Math.round(requestedTokens)))
    : 800;
  const outputs = await runtime.model.generate({
    ...inputs,
    do_sample: false,
    max_new_tokens: maxNewTokens,
  });
  const inputLength = inputs.input_ids.dims.at(-1);
  const generated = outputs.slice(null, [inputLength, null]);
  const decoded = runtime.processor.batch_decode(generated, { skip_special_tokens: true });
  return String(decoded?.[0] || '').trim();
}

function normalizeTextToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return toolCall;
  const usesFunctionWrapper = toolCall.function && typeof toolCall.function === 'object';
  const target = usesFunctionWrapper ? toolCall.function : toolCall;
  let parsedArguments = target.arguments;
  if (typeof parsedArguments === 'string') {
    try {
      parsedArguments = JSON.parse(parsedArguments);
    } catch {
      parsedArguments = {};
    }
  }
  if (!parsedArguments || typeof parsedArguments !== 'object' || Array.isArray(parsedArguments)) {
    // Ling's template calls .items() unconditionally, so malformed or omitted
    // historical arguments must still be represented by an object.
    parsedArguments = {};
  }
  if (parsedArguments === target.arguments) return toolCall;

  if (usesFunctionWrapper) {
    return {
      ...toolCall,
      function: { ...target, arguments: parsedArguments },
    };
  }
  return { ...toolCall, arguments: parsedArguments };
}

export function prepareTextMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    if (!message || typeof message !== 'object') return { role: 'user', content: '' };
    const prepared = {
      ...message,
      ...(Array.isArray(message.tool_calls)
        ? { tool_calls: message.tool_calls.map(normalizeTextToolCall) }
        : {}),
    };
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n');
      return { ...prepared, content: text };
    }
    return { ...prepared, content: String(message.content || '') };
  });
}

function splitThinking(content) {
  const source = String(content || '').trim();
  const match = /^<think>\s*([\s\S]*?)\s*<\/think>\s*([\s\S]*)$/i.exec(source);
  if (!match) return { content: source, reasoningContent: null };
  return {
    content: String(match[2] || '').trim(),
    reasoningContent: String(match[1] || '').trim() || null,
  };
}

async function runText(payload) {
  const modelId = String(payload?.modelId || '').trim();
  if (!modelId) throw new Error('No text-generation model was specified.');
  const device = payload?.device || 'webgpu';
  const dtype = payload?.dtype || 'q4f16';
  if (!await isTextModelReady(modelId, dtype)) {
    throw new Error('Ling 3.0 Tiny is not downloaded. Open Settings > Providers > WebGPU to download it before chatting.');
  }
  const runtime = await getTextRuntime(modelId, dtype, device, { localFilesOnly: true });
  const requestedTokens = Number(payload?.options?.maxTokens);
  const maxNewTokens = Number.isFinite(requestedTokens)
    ? Math.max(1, Math.min(WEBGPU_TEXT_MAX_NEW_TOKENS, Math.round(requestedTokens)))
    : WEBGPU_TEXT_MAX_NEW_TOKENS;
  const tools = Array.isArray(payload?.options?.tools) ? payload.options.tools : [];
  lastWebGpuDeviceError = '';
  lastWebGpuDeviceLost = '';
  let output;
  try {
    output = await runtime.pipeline(prepareTextMessages(payload?.messages), {
      do_sample: false,
      max_new_tokens: maxNewTokens,
      tools: tools.length ? tools : undefined,
      tokenizer_encode_kwargs: { enable_thinking: false },
    });
  } catch (error) {
    if (isWebGpuExecutionFailure(error)) throw await enrichWebGpuExecutionError(error);
    throw error;
  }
  const generated = output?.[0]?.generated_text;
  const content = Array.isArray(generated)
    ? generated.at(-1)?.content
    : generated;
  if (typeof content !== 'string') {
    throw new Error('The WebGPU model returned no generated text.');
  }
  return splitThinking(content);
}

async function probeRuntime() {
  await loadLibrary();
  const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
  let adapter = null;
  if (hasWebGPU) {
    try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch {}
  }
  const isFallbackAdapter = !!(adapter?.isFallbackAdapter ?? adapter?.info?.isFallbackAdapter);
  return {
    libraryVersion,
    hasWebGPU: hasWebGPU && !!adapter,
    isFallbackAdapter,
    adapterFeatures: adapter ? [...adapter.features].slice(0, 12) : [],
  };
}

async function clearModelCache() {
  await disposeAllRuntimes();
  const deletedCaches = [];
  if (typeof caches !== 'undefined') {
    for (const name of await caches.keys()) {
      if (!/transformers/i.test(name)) continue;
      if (await caches.delete(name)) deletedCaches.push(name);
    }
  }
  readyTextModelKeys.clear();
  textDownloadFiles.clear();
  textDownloadState = {
    ...textDownloadState,
    status: 'not-downloaded',
    ready: false,
    file: '',
    loaded: 0,
    total: 0,
    progress: 0,
    error: '',
  };
  postTextDownloadState({ force: true });
  return deletedCaches;
}

self.addEventListener('message', async event => {
  const { id, type, payload } = event.data || {};
  try {
    if (type === 'init') {
      workerConfig = payload;
      self.postMessage({ id, ok: true });
      return;
    }
    if (type === 'probe') {
      self.postMessage({ id, ok: true, ...(await probeRuntime()) });
      return;
    }
    if (type === 'text-download-status') {
      const modelId = String(payload?.modelId || '').trim();
      const dtype = payload?.dtype || 'q4f16';
      self.postMessage({ id, ok: true, ...(await getTextDownloadStatus(modelId, dtype)) });
      return;
    }
    if (type === 'download-text') {
      const state = await enqueueModelOperation(() => downloadTextModel(payload));
      self.postMessage({ id, ok: true, ...state });
      return;
    }
    if (type === 'pause-text-download') {
      self.postMessage({ id, ok: true, ...pauseTextDownload() });
      return;
    }
    if (type === 'stop-text-download') {
      const modelId = String(payload?.modelId || '').trim();
      const dtype = payload?.dtype || 'q4f16';
      textDownloadCancelMode = 'stop';
      textDownloadState = { ...textDownloadState, status: 'stopping', ready: false, error: '' };
      textDownloadAbortController?.abort();
      postTextDownloadState({ force: true });
      const state = await enqueueModelOperation(() => clearTextModelCache(modelId, dtype));
      self.postMessage({ id, ok: true, ...state });
      return;
    }
    if (type === 'clear-cache') {
      const deletedCaches = await enqueueModelOperation(clearModelCache);
      self.postMessage({ id, ok: true, deletedCaches });
      return;
    }
    if (type === 'dispose' || type === 'dispose-all') {
      await enqueueModelOperation(disposeAllRuntimes);
      self.postMessage({ id, ok: true, disposed: true });
      return;
    }
    if (type === 'dispose-vision') {
      await enqueueModelOperation(disposeVisionRuntime);
      self.postMessage({ id, ok: true, disposed: true });
      return;
    }
    if (type === 'dispose-text') {
      await enqueueModelOperation(disposeTextRuntime);
      self.postMessage({ id, ok: true, disposed: true });
      return;
    }
    if (type === 'chat') {
      const content = await enqueueModelOperation(() => runVision(payload));
      self.postMessage({ id, ok: true, content, raw: { model: payload?.modelId || '' } });
      return;
    }
    if (type === 'text-chat') {
      const result = await enqueueModelOperation(() => runText(payload));
      self.postMessage({
        id,
        ok: true,
        ...result,
        raw: { model: payload?.modelId || '' },
      });
      return;
    }
    throw new Error(`Unknown WebGPU worker message: ${type || 'missing type'}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
});
