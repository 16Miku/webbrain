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

async function getTextRuntime(modelId, dtype, device) {
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
    await disposeTextRuntime();
    const pipeline = await library.pipeline('text-generation', modelId, {
      device,
      dtype,
      progress_callback: event => postProgress(modelId, event),
    });
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
  const runtime = await getTextRuntime(modelId, dtype, device);
  const requestedTokens = Number(payload?.options?.maxTokens);
  const maxNewTokens = Number.isFinite(requestedTokens)
    ? Math.max(1, Math.min(1600, Math.round(requestedTokens)))
    : 512;
  const tools = Array.isArray(payload?.options?.tools) ? payload.options.tools : [];
  const output = await runtime.pipeline(prepareTextMessages(payload?.messages), {
    do_sample: false,
    max_new_tokens: maxNewTokens,
    tools: tools.length ? tools : undefined,
    tokenizer_encode_kwargs: { enable_thinking: false },
  });
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
