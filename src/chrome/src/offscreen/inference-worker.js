/**
 * Dedicated WebGPU worker for the optional in-browser vision fallback.
 *
 * WebGPU is unavailable in the MV3 service worker, and large ONNX allocations
 * are more reliable in a dedicated worker than on the offscreen document's
 * main thread. The offscreen host owns this worker and proxies correlated
 * request/response messages to it.
 */

let libraryPromise = null;
let libraryVersion = null;
let workerConfig = null;
let activeRuntime = null;
let activeRuntimeKey = '';

async function loadLibrary() {
  if (libraryPromise) return libraryPromise;
  if (!workerConfig) throw new Error('Vision worker was not initialized.');
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

function postProgress(modelId, event) {
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

async function disposeRuntime() {
  if (activeRuntime?.model?.dispose) {
    try { await activeRuntime.model.dispose(); } catch {}
  }
  if (activeRuntime?.processor?.dispose) {
    try { await activeRuntime.processor.dispose(); } catch {}
  }
  activeRuntime = null;
  activeRuntimeKey = '';
}

async function getRuntime(modelId, dtype, device) {
  const key = `${modelId}|${device}|${JSON.stringify(dtype)}`;
  if (activeRuntime && activeRuntimeKey === key) return activeRuntime;
  const library = await loadLibrary();
  const { AutoModelForImageTextToText, AutoProcessor } = library;
  if (!AutoModelForImageTextToText || !AutoProcessor) {
    throw new Error('The packaged Transformers.js version does not include image-text-to-text support.');
  }
  await disposeRuntime();
  const progress_callback = event => postProgress(modelId, event);
  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(modelId, { progress_callback }),
    AutoModelForImageTextToText.from_pretrained(modelId, {
      device,
      dtype,
      progress_callback,
    }),
  ]);
  activeRuntime = { library, processor, model };
  activeRuntimeKey = key;
  return activeRuntime;
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
    const blocks = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          blocks.push({ type: 'text', text: block.text });
          continue;
        }
        const imageUrl = imageUrlFromBlock(block);
        if (imageUrl) {
          imageUrls.push(imageUrl);
          blocks.push({ type: 'image' });
        }
      }
    } else if (typeof message.content === 'string') {
      blocks.push({ type: 'text', text: message.content });
    }
    if (blocks.length) prepared.push({ role, content: blocks });
  }
  if (imageUrls.length !== 1) {
    throw new Error(`LFM2.5-VL requires exactly one screenshot; received ${imageUrls.length}.`);
  }
  return { messages: prepared, imageUrl: imageUrls[0] };
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
  const runtime = await getRuntime(modelId, dtype, device);
  const { messages, imageUrl } = prepareMultimodalMessages(payload?.messages);
  const prompt = runtime.processor.apply_chat_template(messages, {
    add_generation_prompt: true,
  });
  const image = await runtime.library.load_image(imageUrl);
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
  await disposeRuntime();
  const deletedCaches = [];
  if (typeof caches !== 'undefined') {
    for (const name of await caches.keys()) {
      if (!/transformers/i.test(name)) continue;
      if (await caches.delete(name)) deletedCaches.push(name);
    }
  }
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
    if (type === 'clear-cache') {
      self.postMessage({ id, ok: true, deletedCaches: await clearModelCache() });
      return;
    }
    if (type === 'chat') {
      const content = await runVision(payload);
      self.postMessage({ id, ok: true, content, raw: { model: payload?.modelId || '' } });
      return;
    }
    throw new Error(`Unknown vision worker message: ${type || 'missing type'}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
});
