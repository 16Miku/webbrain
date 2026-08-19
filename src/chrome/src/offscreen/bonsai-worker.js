/**
 * Dedicated bitgpu worker for the optional Bonsai 27B WebGPU text model.
 *
 * LFM2.5 stays on inference-worker.js (Transformers.js / ONNX). Bonsai 27B is a
 * 1-bit GGUF hybrid and cannot share that runtime. This worker speaks the same
 * text-download / text-chat message types so the offscreen host can route by
 * model id.
 */

import { createEngine } from '../../vendor/bitgpu/index.js';
import { createChat } from '../../vendor/bitgpu/chat.js';

const WEBGPU_BONSAI27_MODEL_ID = 'prism-ml/Bonsai-27B-gguf';
const WEBGPU_BONSAI27_DTYPE = 'q1';
const CACHE_NAME = 'bitgpu-models-v1';
const TEXT_DOWNLOAD_EVENT = 'text-download-state';
const WEBGPU_BONSAI27_MAX_NEW_TOKENS = 2048;
const WEBGPU_BONSAI27_THINK_BUDGET = 128;
const WEBGPU_BONSAI27_MAX_SEQ_LEN = 4096;
const OOM_HINT = 'This machine cannot hold Bonsai 27B in GPU memory. Use LFM2.5 2.6B instead.';

let workerConfig = null;
let textRuntime = null;
let textRuntimeLoadPromise = null;
let modelOperationQueue = Promise.resolve();
const readyTextModelKeys = new Set();
const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
let queuedTextDownload = null;
let textDownloadAbortController = null;
let textDownloadCancelMode = '';
let lastTextProgressPostAt = 0;
let textDownloadState = {
  status: 'not-downloaded',
  ready: false,
  modelId: '',
  dtype: WEBGPU_BONSAI27_DTYPE,
  file: '',
  loaded: 0,
  total: 0,
  progress: 0,
  error: '',
};

function textModelKey(modelId, dtype) {
  return `${String(modelId || '').trim()}|${String(dtype || WEBGPU_BONSAI27_DTYPE).trim()}`;
}

function sameTextModel(leftModelId, leftDtype, rightModelId, rightDtype) {
  return textModelKey(leftModelId, leftDtype) === textModelKey(rightModelId, rightDtype);
}

function assertBonsaiModel(modelId) {
  const normalized = String(modelId || '').trim();
  if (normalized && normalized !== WEBGPU_BONSAI27_MODEL_ID) {
    throw new Error(`${normalized} is not the bundled Bonsai 27B WebGPU model.`);
  }
  return WEBGPU_BONSAI27_MODEL_ID;
}

function assertTextDownloadCanStart(payload) {
  const modelId = assertBonsaiModel(payload?.modelId);
  const dtype = payload?.dtype || WEBGPU_BONSAI27_DTYPE;
  const conflictsWithTransfer = textDownloadState.modelId
    && !sameTextModel(textDownloadState.modelId, textDownloadState.dtype, modelId, dtype)
    && ['downloading', 'paused', 'stopping'].includes(textDownloadState.status);
  const conflictsWithQueued = queuedTextDownload
    && !sameTextModel(queuedTextDownload.modelId, queuedTextDownload.dtype, modelId, dtype);
  if (conflictsWithTransfer || conflictsWithQueued) {
    const blockingModel = conflictsWithTransfer ? textDownloadState.modelId : queuedTextDownload.modelId;
    throw new Error(`Finish or stop the ${blockingModel} download before downloading ${modelId}.`);
  }
  return { modelId, dtype, key: textModelKey(modelId, dtype) };
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

function mapGpuError(error) {
  const message = error?.message || String(error);
  if (error?.name === 'GpuOutOfMemoryError' || /GPU allocation failed|maxStorageBufferBindingSize|maxBufferSize/i.test(message)) {
    return new Error(`${OOM_HINT} ${message}`);
  }
  return error instanceof Error ? error : new Error(message);
}

async function loadLibraries() {
  if (!workerConfig) throw new Error('Bonsai WebGPU worker was not initialized.');
  if (typeof createEngine !== 'function' || typeof createChat !== 'function') {
    throw new Error('The packaged bitgpu runtime could not be loaded.');
  }
  return { createEngine, createChat };
}

async function cachedResponse(url, { signal } = {}) {
  if (!nativeFetch) throw new Error('Fetch is unavailable in the Bonsai WebGPU worker.');
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) return hit;
  const response = await nativeFetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`fetch ${url} failed: HTTP ${response.status}`);
  cache.put(url, response.clone()).catch(() => {});
  return response;
}

function createFetchHooks(signal) {
  const fetchJson = async (url) => {
    const response = await cachedResponse(url, { signal });
    return response.json();
  };
  const fetchStream = async (url) => {
    const response = await cachedResponse(url, { signal });
    if (!response.body) throw new Error(`fetch ${url} returned no body.`);
    return response.body;
  };
  return { fetchJson, fetchStream };
}

async function isTextModelReady(modelId = WEBGPU_BONSAI27_MODEL_ID, dtype = WEBGPU_BONSAI27_DTYPE) {
  const key = textModelKey(modelId, dtype);
  if (readyTextModelKeys.has(key)) return true;
  if (typeof caches === 'undefined' || !workerConfig?.dataUrl) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(workerConfig.dataUrl);
    if (!hit) return false;
    readyTextModelKeys.add(key);
    return true;
  } catch {
    return false;
  }
}

async function markTextModelReady(modelId, dtype) {
  readyTextModelKeys.add(textModelKey(modelId, dtype));
}

async function getTextDownloadStatus(modelId, dtype) {
  const normalized = assertBonsaiModel(modelId);
  const normalizedDtype = dtype || WEBGPU_BONSAI27_DTYPE;
  const ready = await isTextModelReady(normalized, normalizedDtype);
  const sameModel = sameTextModel(textDownloadState.modelId, textDownloadState.dtype, normalized, normalizedDtype);
  if (sameModel && ['downloading', 'paused', 'stopping'].includes(textDownloadState.status)) {
    return textDownloadSnapshot();
  }
  if (ready) {
    return {
      status: 'ready',
      ready: true,
      modelId: normalized,
      dtype: normalizedDtype,
      file: sameModel ? textDownloadState.file : '',
      loaded: sameModel ? textDownloadState.loaded : 0,
      total: sameModel ? textDownloadState.total : 0,
      progress: 100,
      error: '',
    };
  }
  if (sameModel && textDownloadState.status === 'error') return textDownloadSnapshot();
  return {
    status: 'not-downloaded',
    ready: false,
    modelId: normalized,
    dtype: normalizedDtype,
    file: '',
    loaded: 0,
    total: 0,
    progress: 0,
    error: '',
  };
}

async function disposeTextRuntime() {
  if (textRuntimeLoadPromise) {
    try { await textRuntimeLoadPromise; } catch { /* load failed or was aborted */ }
  }
  try { textRuntime?.engine?.dispose?.(); } catch { /* GPU may already be lost */ }
  textRuntime = null;
  textRuntimeLoadPromise = null;
}

async function getTextRuntime({ localFilesOnly = false } = {}) {
  if (textRuntime) return textRuntime;
  if (textRuntimeLoadPromise) return textRuntimeLoadPromise;
  if (localFilesOnly && !await isTextModelReady()) {
    throw new Error(`${WEBGPU_BONSAI27_MODEL_ID} is not downloaded. Open Apocalypse Mode > WebGPU to download it before chatting.`);
  }
  textRuntimeLoadPromise = (async () => {
    const { createEngine: engineCreate, createChat: chatCreate } = await loadLibraries();
    navigator.storage?.persist?.().catch(() => {});
    const controller = textDownloadAbortController;
    const { fetchJson, fetchStream } = createFetchHooks(controller?.signal);
    const engine = await engineCreate({
      manifestUrl: workerConfig.manifestUrl,
      auxUrl: workerConfig.auxUrl,
      dataUrl: workerConfig.dataUrl,
      kvCache: 'q8',
      activation: 'f16',
      maxSeqLen: WEBGPU_BONSAI27_MAX_SEQ_LEN,
      fetchJson,
      fetchStream,
      onProgress(progress) {
        if (textDownloadCancelMode) return;
        const loaded = Math.max(0, Number(progress?.loaded) || 0);
        const total = Math.max(0, Number(progress?.total) || 0);
        const phase = String(progress?.phase || 'weights');
        textDownloadState = {
          ...textDownloadState,
          status: 'downloading',
          ready: false,
          modelId: WEBGPU_BONSAI27_MODEL_ID,
          dtype: WEBGPU_BONSAI27_DTYPE,
          file: phase,
          loaded,
          total,
          progress: total > 0 ? Math.min(100, (loaded / total) * 100) : textDownloadState.progress,
          error: '',
        };
        postTextDownloadState();
      },
    });
    const chat = await chatCreate(engine, {
      tokenizerJsonUrl: workerConfig.tokenizerJsonUrl,
      tokenizerConfigUrl: workerConfig.tokenizerConfigUrl,
      fetchJson,
    });
    textRuntime = { engine, chat };
    return textRuntime;
  })();
  try {
    return await textRuntimeLoadPromise;
  } catch (error) {
    await disposeTextRuntime();
    throw mapGpuError(error);
  } finally {
    textRuntimeLoadPromise = null;
  }
}

async function downloadTextModel(payload, { onStarted } = {}) {
  const modelId = assertBonsaiModel(payload?.modelId);
  const dtype = payload?.dtype || WEBGPU_BONSAI27_DTYPE;
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
    && sameTextModel(textDownloadState.modelId, textDownloadState.dtype, modelId, dtype);
  textDownloadCancelMode = '';
  const controller = new AbortController();
  textDownloadAbortController = controller;
  textDownloadState = {
    status: 'downloading',
    ready: false,
    modelId,
    dtype,
    file: resuming ? textDownloadState.file : 'weights',
    loaded: resuming ? textDownloadState.loaded : 0,
    total: resuming ? textDownloadState.total : 0,
    progress: resuming ? textDownloadState.progress : 0,
    error: '',
  };
  postTextDownloadState({ force: true });
  onStarted?.(textDownloadSnapshot());

  try {
    await getTextRuntime();
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
    const mapped = mapGpuError(error);
    textDownloadState = {
      ...textDownloadState,
      status: 'error',
      ready: false,
      error: mapped.message,
    };
    postTextDownloadState({ force: true });
    throw mapped;
  } finally {
    if (textDownloadAbortController === controller) textDownloadAbortController = null;
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
  const normalized = assertBonsaiModel(modelId);
  const normalizedDtype = dtype || WEBGPU_BONSAI27_DTYPE;
  if (typeof caches !== 'undefined' && workerConfig) {
    try {
      const cache = await caches.open(CACHE_NAME);
      for (const url of [
        workerConfig.dataUrl,
        workerConfig.tokenizerJsonUrl,
        workerConfig.tokenizerConfigUrl,
      ].filter(Boolean)) {
        await cache.delete(url);
      }
    } catch { /* cache removal is best-effort */ }
  }
  readyTextModelKeys.delete(textModelKey(normalized, normalizedDtype));
  textDownloadCancelMode = '';
  const clearedState = {
    status: 'not-downloaded',
    ready: false,
    modelId: normalized,
    dtype: normalizedDtype,
    file: '',
    loaded: 0,
    total: 0,
    progress: 0,
    error: '',
  };
  textDownloadState = clearedState;
  postTextDownloadState({ force: true });
  return { ...clearedState };
}

function enqueueModelOperation(operation) {
  const result = modelOperationQueue.then(operation, operation);
  modelOperationQueue = result.catch(() => {});
  return result;
}

function prepareTextMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (!message || typeof message !== 'object') return { role: 'user', content: '' };
    const role = ['system', 'user', 'assistant'].includes(message.role) ? message.role : 'user';
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n');
      return { role, content: text };
    }
    return { role, content: String(message.content || '') };
  }).filter(message => message.content || message.role === 'system');
}

async function runText(payload) {
  const modelId = assertBonsaiModel(payload?.modelId);
  if (!await isTextModelReady(modelId, payload?.dtype || WEBGPU_BONSAI27_DTYPE)) {
    throw new Error(`${modelId} is not downloaded. Open Apocalypse Mode > WebGPU to download it before chatting.`);
  }
  const runtime = await getTextRuntime({ localFilesOnly: true });
  const requestedTokens = Number(payload?.options?.maxTokens);
  const maxTokens = Number.isFinite(requestedTokens)
    ? Math.max(1, Math.min(WEBGPU_BONSAI27_MAX_NEW_TOKENS, Math.round(requestedTokens)))
    : WEBGPU_BONSAI27_MAX_NEW_TOKENS;
  let result;
  try {
    result = await runtime.chat.send(prepareTextMessages(payload?.messages), {
      think: true,
      thinkBudget: WEBGPU_BONSAI27_THINK_BUDGET,
      maxTokens,
      temperature: 0.5,
      topP: 0.85,
      topK: 20,
    });
  } catch (error) {
    throw mapGpuError(error);
  }
  const content = String(result?.text || '').trim();
  const reasoningContent = String(result?.thinkText || '').trim() || null;
  if (!content && reasoningContent) {
    throw new Error(`${modelId} used its generation budget before finishing reasoning. Retry with a shorter prompt.`);
  }
  if (!content) throw new Error('The WebGPU model returned no generated text.');
  return { content, reasoningContent };
}

async function probeRuntime() {
  const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
  let adapter = null;
  if (hasWebGPU) {
    try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch {}
  }
  const isFallbackAdapter = !!(adapter?.isFallbackAdapter ?? adapter?.info?.isFallbackAdapter);
  return {
    libraryVersion: 'bitgpu-0.19.1',
    hasWebGPU: hasWebGPU && !!adapter,
    isFallbackAdapter,
    adapterFeatures: adapter ? [...adapter.features].slice(0, 12) : [],
  };
}

self.addEventListener('message', async (event) => {
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
      self.postMessage({ id, ok: true, ...(await getTextDownloadStatus(payload?.modelId, payload?.dtype)) });
      return;
    }
    if (type === 'start-download-text') {
      const request = assertTextDownloadCanStart(payload);
      queuedTextDownload = request;
      let acknowledged = false;
      const operation = enqueueModelOperation(() => {
        if (queuedTextDownload !== request) return getTextDownloadStatus(request.modelId, request.dtype);
        return downloadTextModel(payload, {
          onStarted(state) {
            acknowledged = true;
            self.postMessage({ id, ok: true, ...state });
          },
        });
      });
      void operation.then((state) => {
        if (!acknowledged) self.postMessage({ id, ok: true, ...state });
      }).catch((error) => {
        if (!acknowledged) self.postMessage({ id, ok: false, error: error?.message || String(error) });
      }).finally(() => {
        if (queuedTextDownload?.key === request.key) queuedTextDownload = null;
      });
      return;
    }
    if (type === 'pause-text-download') {
      self.postMessage({ id, ok: true, ...pauseTextDownload() });
      return;
    }
    if (type === 'stop-text-download') {
      const modelId = assertBonsaiModel(payload?.modelId);
      const dtype = payload?.dtype || WEBGPU_BONSAI27_DTYPE;
      const targetsQueuedTransfer = queuedTextDownload
        && sameTextModel(queuedTextDownload.modelId, queuedTextDownload.dtype, modelId, dtype);
      if (targetsQueuedTransfer) queuedTextDownload = null;
      textDownloadCancelMode = 'stop';
      textDownloadState = { ...textDownloadState, status: 'stopping', ready: false, error: '' };
      textDownloadAbortController?.abort();
      postTextDownloadState({ force: true });
      const state = await enqueueModelOperation(() => clearTextModelCache(modelId, dtype));
      self.postMessage({ id, ok: true, ...state });
      return;
    }
    if (type === 'dispose-text' || type === 'dispose' || type === 'dispose-all') {
      await enqueueModelOperation(disposeTextRuntime);
      self.postMessage({ id, ok: true, disposed: true });
      return;
    }
    if (type === 'text-chat') {
      const result = await enqueueModelOperation(() => runText(payload));
      self.postMessage({
        id,
        ok: true,
        ...result,
        raw: { model: payload?.modelId || WEBGPU_BONSAI27_MODEL_ID },
      });
      return;
    }
    throw new Error(`Unknown Bonsai WebGPU worker message: ${type || 'missing type'}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
});
