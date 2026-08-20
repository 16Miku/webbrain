/** Proxy endpoint-free WebGPU requests from the service worker to a module Worker. */

let visionWorker = null;
let visionWorkerReady = null;
let nextVisionRequestId = 1;
const pendingVisionRequests = new Map();
let bonsaiWorker = null;
let bonsaiWorkerReady = null;
let nextBonsaiRequestId = 1;
const pendingBonsaiRequests = new Map();
let textDownloadStartChain = Promise.resolve();
const WEBGPU_BONSAI27_MODEL_ID = 'prism-ml/Bonsai-27B-gguf';
const WEBGPU_LFM25_MODEL_ID = 'LiquidAI/LFM2.5-2.6B-ONNX';
const WEBGPU_RUNTIME_BITGPU = 'bitgpu';
const TEXT_TRANSFER_STATUSES = new Set(['starting', 'queued', 'downloading', 'paused', 'stopping']);
const VISION_DOWNLOAD_STATE_MESSAGE = 'webgpu-vision-download-state';
const visionDownloadFiles = new Map();
let visionDownloadState = null;
let visionDownloadStateTimer = null;
let visionPreloadPromise = null;
let visionPreloadKey = '';
let visionPreloadLifecycle = null;

function publishVisionDownloadState(state, immediate = false) {
  visionDownloadState = {
    modelId: String(state?.modelId || ''),
    status: String(state?.status || 'idle'),
    progress: Math.max(0, Math.min(100, Number(state?.progress) || 0)),
    loaded: Math.max(0, Number(state?.loaded) || 0),
    total: Math.max(0, Number(state?.total) || 0),
    error: String(state?.error || '').slice(0, 500),
    updatedAt: Date.now(),
  };
  const flush = () => {
    visionDownloadStateTimer = null;
    try {
      const pending = chrome.runtime.sendMessage({
        type: VISION_DOWNLOAD_STATE_MESSAGE,
        state: visionDownloadState,
      });
      pending?.catch?.(() => {});
    } catch { /* The service worker may be shutting down with this document. */ }
  };
  if (immediate) {
    if (visionDownloadStateTimer) clearTimeout(visionDownloadStateTimer);
    flush();
  } else if (!visionDownloadStateTimer) {
    visionDownloadStateTimer = setTimeout(flush, 250);
  }
}

function updateVisionDownloadProgress(data) {
  const file = String(data?.file || 'model');
  const loaded = Math.max(0, Number(data?.loaded) || 0);
  const total = Math.max(0, Number(data?.total) || 0);
  if (total > 0) visionDownloadFiles.set(file, { loaded: Math.min(loaded, total), total });
  let aggregateLoaded = 0;
  let aggregateTotal = 0;
  for (const entry of visionDownloadFiles.values()) {
    aggregateLoaded += entry.loaded;
    aggregateTotal += entry.total;
  }
  const eventProgress = Math.max(0, Math.min(100, Number(data?.progress) || 0));
  publishVisionDownloadState({
    modelId: data?.modelId,
    status: 'downloading',
    progress: aggregateTotal > 0 ? aggregateLoaded / aggregateTotal * 100 : eventProgress,
    loaded: aggregateLoaded,
    total: aggregateTotal,
  });
}

function progressMatchesActiveVisionModel(data, activeModelId, preloading) {
  const progressModelId = String(data?.modelId || '').trim();
  return Boolean(preloading
    && progressModelId
    && progressModelId === String(activeModelId || '').trim());
}

function settleVisionRequest(data) {
  if (data?.type === 'text-download-state') {
    try {
      chrome.runtime.sendMessage({ type: 'webgpu-text-download-state', state: data.state }, () => {
        void chrome.runtime.lastError;
      });
    } catch {}
    return;
  }
  if (data?.type === 'progress') {
    if (!progressMatchesActiveVisionModel(data, visionDownloadState?.modelId, visionPreloadPromise)) return;
    console.debug('[webgpu] model download', data);
    updateVisionDownloadProgress(data);
    return;
  }
  const pending = pendingVisionRequests.get(data?.id);
  if (!pending) return;
  pendingVisionRequests.delete(data.id);
  if (data.ok) pending.resolve(data);
  else pending.reject(new Error(data.error || 'Vision worker failed.'));
}

function startVisionPreload(message) {
  const modelId = String(message?.model || '').trim();
  const key = `${modelId}|${message?.device || 'webgpu'}|${JSON.stringify(message?.dtype || {})}`;
  if (visionPreloadPromise && visionPreloadKey === key) return false;
  visionDownloadFiles.clear();
  publishVisionDownloadState({ modelId, status: 'starting', progress: 0 }, true);
  const lifecycle = { cancelMode: '' };
  visionPreloadKey = key;
  visionPreloadLifecycle = lifecycle;
  const operation = sendVisionWorkerMessage('preload', {
    modelId,
    device: message?.device,
    dtype: message?.dtype,
  }).then((response) => {
    if (lifecycle.cancelMode === 'stop') return response;
    const status = lifecycle.cancelMode === 'pause' ? 'paused' : response?.status || 'ready';
    publishVisionDownloadState({
      modelId,
      status,
      progress: status === 'ready' ? 100 : visionDownloadState?.progress || 0,
      loaded: status === 'not-downloaded' ? 0 : visionDownloadState?.loaded || 0,
      total: status === 'not-downloaded' ? 0 : visionDownloadState?.total || 0,
    }, true);
    return response;
  }).catch((error) => {
    if (lifecycle.cancelMode === 'stop') return;
    if (lifecycle.cancelMode) {
      publishVisionDownloadState({
        modelId,
        status: 'paused',
        progress: visionDownloadState?.progress || 0,
        loaded: visionDownloadState?.loaded || 0,
        total: visionDownloadState?.total || 0,
      }, true);
      return;
    }
    publishVisionDownloadState({
      modelId,
      status: 'error',
      progress: visionDownloadState?.progress || 0,
      loaded: visionDownloadState?.loaded || 0,
      total: visionDownloadState?.total || 0,
      error: error?.message || String(error),
    }, true);
  }).finally(() => {
    if (visionPreloadPromise === operation) {
      visionPreloadPromise = null;
      visionPreloadKey = '';
      visionPreloadLifecycle = null;
    }
  });
  visionPreloadPromise = operation;
  return true;
}

function detachVisionPreload(cancelMode) {
  if (visionPreloadLifecycle) visionPreloadLifecycle.cancelMode = cancelMode;
  visionPreloadPromise = null;
  visionPreloadKey = '';
  visionPreloadLifecycle = null;
}

function isBitgpuTextModel(modelId, runtime) {
  if (String(runtime || '').trim() === WEBGPU_RUNTIME_BITGPU) return true;
  return String(modelId || '').trim() === WEBGPU_BONSAI27_MODEL_ID;
}

function isActiveTextTransfer(state) {
  return TEXT_TRANSFER_STATUSES.has(String(state?.status || '').toLowerCase());
}

async function probeExistingTextWorkerStatus(modelId) {
  try {
    if (isBitgpuTextModel(modelId)) {
      if (!bonsaiWorker) return null;
      return await sendBonsaiWorkerMessage('text-download-status', { modelId });
    }
    if (!visionWorker) return null;
    return await sendVisionWorkerMessage('text-download-status', { modelId });
  } catch {
    return null;
  }
}

async function findActiveTextTransfer(requestedModel) {
  const otherModel = isBitgpuTextModel(requestedModel)
    ? WEBGPU_LFM25_MODEL_ID
    : WEBGPU_BONSAI27_MODEL_ID;
  const other = await probeExistingTextWorkerStatus(otherModel);
  return isActiveTextTransfer(other) ? other : null;
}

function startExclusiveTextDownload(message) {
  const operation = textDownloadStartChain.then(async () => {
    const activeTransfer = await findActiveTextTransfer(message.model);
    if (activeTransfer && String(activeTransfer.status || '').toLowerCase() !== 'paused') {
      const model = String(activeTransfer.modelId || 'Another WebGPU model');
      throw new Error(`${model} is still ${activeTransfer.status || 'downloading'}. Pause it before switching models.`);
    }
    return await sendTextWorkerMessage(message.model, 'start-download-text', {
      modelId: message.model,
      device: message.device,
      dtype: message.dtype,
      requireTools: message.requireTools === true,
    }, { exclusive: true, runtime: message.runtime });
  });
  textDownloadStartChain = operation.catch(() => {});
  return operation;
}

function settleBonsaiRequest(data) {
  if (data?.type === 'text-download-state') {
    try {
      chrome.runtime.sendMessage({ type: 'webgpu-text-download-state', state: data.state }, () => {
        void chrome.runtime.lastError;
      });
    } catch {}
    return;
  }
  const pending = pendingBonsaiRequests.get(data?.id);
  if (!pending) return;
  pendingBonsaiRequests.delete(data.id);
  if (data.ok) pending.resolve(data);
  else pending.reject(new Error(data.error || 'Bonsai worker failed.'));
}

function sendBonsaiWorkerMessage(type, payload = {}) {
  const id = nextBonsaiRequestId++;
  return new Promise((resolve, reject) => {
    pendingBonsaiRequests.set(id, { resolve, reject });
    bonsaiWorker.postMessage({ id, type, payload });
  });
}

async function ensureBonsaiWorker() {
  if (bonsaiWorkerReady) return bonsaiWorkerReady;
  bonsaiWorker = new Worker(chrome.runtime.getURL('src/offscreen/bonsai-worker.js'), {
    type: 'module',
  });
  bonsaiWorker.addEventListener('message', event => settleBonsaiRequest(event.data));
  bonsaiWorker.addEventListener('error', event => {
    const error = new Error(event?.message || 'Bonsai worker crashed.');
    for (const pending of pendingBonsaiRequests.values()) pending.reject(error);
    pendingBonsaiRequests.clear();
    bonsaiWorker = null;
    bonsaiWorkerReady = null;
  });
  bonsaiWorkerReady = sendBonsaiWorkerMessage('init', {
    manifestUrl: chrome.runtime.getURL('vendor/bitgpu/models/bonsai-27b-gguf/manifest.json'),
    auxUrl: chrome.runtime.getURL('vendor/bitgpu/models/bonsai-27b-gguf/Bonsai-27B-Q1_0.aux.bin'),
    dataUrl: 'https://huggingface.co/prism-ml/Bonsai-27B-gguf/resolve/main/Bonsai-27B-Q1_0.gguf',
    tokenizerJsonUrl: 'https://huggingface.co/prism-ml/Bonsai-27B-unpacked/resolve/main/tokenizer.json',
    tokenizerConfigUrl: 'https://huggingface.co/prism-ml/Bonsai-27B-unpacked/resolve/main/tokenizer_config.json',
  });
  return bonsaiWorkerReady;
}

async function disposeOtherTextRuntime(keepRuntime) {
  if (keepRuntime !== 'onnx' && visionWorker) {
    try { await sendVisionWorkerMessage('dispose-text'); } catch { /* ONNX text session may already be empty */ }
  }
  if (keepRuntime !== 'bitgpu' && bonsaiWorker) {
    try { await sendBonsaiWorkerMessage('dispose-text'); } catch { /* Bonsai session may already be empty */ }
  }
}

async function sendTextWorkerMessage(modelId, type, payload = {}, { exclusive = false, runtime } = {}) {
  if (isBitgpuTextModel(modelId, runtime) || isBitgpuTextModel(payload.modelId, payload.runtime)) {
    if (exclusive) await disposeOtherTextRuntime('bitgpu');
    await ensureBonsaiWorker();
    return sendBonsaiWorkerMessage(type, payload);
  }
  if (exclusive) await disposeOtherTextRuntime('onnx');
  await ensureVisionWorker();
  return sendVisionWorkerMessage(type, payload);
}

function sendVisionWorkerMessage(type, payload = {}) {
  const id = nextVisionRequestId++;
  return new Promise((resolve, reject) => {
    pendingVisionRequests.set(id, { resolve, reject });
    visionWorker.postMessage({ id, type, payload });
  });
}

async function ensureVisionWorker() {
  if (visionWorkerReady) return visionWorkerReady;
  visionWorker = new Worker(chrome.runtime.getURL('src/offscreen/inference-worker.js'), {
    type: 'module',
  });
  visionWorker.addEventListener('message', event => settleVisionRequest(event.data));
  visionWorker.addEventListener('error', event => {
    const error = new Error(event?.message || 'Vision worker crashed.');
    for (const pending of pendingVisionRequests.values()) pending.reject(error);
    pendingVisionRequests.clear();
    visionWorker = null;
    visionWorkerReady = null;
  });
  visionWorkerReady = sendVisionWorkerMessage('init', {
    transformersUrl: chrome.runtime.getURL('vendor/transformers/transformers.web.js'),
    wasmMjsUrl: chrome.runtime.getURL('vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs'),
    wasmUrl: chrome.runtime.getURL('vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm'),
  });
  return visionWorkerReady;
}

const WEBGPU_MESSAGE_TYPES = new Set([
  'webgpu-chat',
  'webgpu-download-start',
  'webgpu-download-pause',
  'webgpu-download-stop',
  'webgpu-download-status',
  'webgpu-dispose',
  'webgpu-probe',
  'webgpu-vision-chat',
  'webgpu-vision-probe',
  'webgpu-vision-preload',
  'webgpu-vision-pause',
  'webgpu-vision-stop',
  'webgpu-vision-dispose',
  'webgpu-vision-clear-cache',
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!WEBGPU_MESSAGE_TYPES.has(message?.type)) return false;
  (async () => {
    try {
      // Bonsai is GGUF/bitgpu. Never boot Transformers.js for those messages —
      // that runtime always fetches config.json, which the GGUF repo does not have.
      if (!isBitgpuTextModel(message.model, message.runtime)) {
        await ensureVisionWorker();
      }
      if (message.type === 'webgpu-vision-preload') {
        await ensureVisionWorker();
        const started = startVisionPreload(message);
        sendResponse({ ok: true, started });
        return;
      }
      if (message.type === 'webgpu-probe' || message.type === 'webgpu-vision-probe') {
        await ensureVisionWorker();
        sendResponse(await sendVisionWorkerMessage('probe'));
        return;
      }
      if (message.type === 'webgpu-download-status') {
        const status = await sendTextWorkerMessage(message.model, 'text-download-status', {
          modelId: message.model,
          dtype: message.dtype,
        }, { runtime: message.runtime });
        const activeTransfer = await findActiveTextTransfer(message.model);
        sendResponse(activeTransfer ? { ...status, activeTransfer } : status);
        return;
      }
      if (message.type === 'webgpu-download-start') {
        sendResponse(await startExclusiveTextDownload(message));
        return;
      }
      if (message.type === 'webgpu-download-pause') {
        const paused = [];
        if (visionWorker) paused.push(await sendVisionWorkerMessage('pause-text-download'));
        if (bonsaiWorker) paused.push(await sendBonsaiWorkerMessage('pause-text-download'));
        sendResponse(paused.find(state => state?.status === 'paused') || paused[0] || { ok: true, status: 'paused' });
        return;
      }
      if (message.type === 'webgpu-download-stop') {
        sendResponse(await sendTextWorkerMessage(message.model, 'stop-text-download', {
          modelId: message.model,
          dtype: message.dtype,
        }, { runtime: message.runtime }));
        return;
      }
      if (message.type === 'webgpu-vision-pause') {
        detachVisionPreload('pause');
        const response = await sendVisionWorkerMessage('pause-vision-download', {
          modelId: message.model,
        });
        publishVisionDownloadState({
          modelId: message.model,
          status: 'paused',
          progress: visionDownloadState?.progress || 0,
          loaded: visionDownloadState?.loaded || 0,
          total: visionDownloadState?.total || 0,
        }, true);
        sendResponse(response);
        return;
      }
      if (message.type === 'webgpu-vision-stop') {
        detachVisionPreload('stop');
        publishVisionDownloadState({
          modelId: message.model,
          status: 'stopping',
          progress: visionDownloadState?.progress || 0,
          loaded: visionDownloadState?.loaded || 0,
          total: visionDownloadState?.total || 0,
        }, true);
        const response = await sendVisionWorkerMessage('stop-vision-download', {
          modelId: message.model,
          dtype: message.dtype,
        });
        visionDownloadFiles.clear();
        publishVisionDownloadState({
          modelId: message.model,
          status: 'not-downloaded',
          progress: 0,
          loaded: 0,
          total: 0,
        }, true);
        sendResponse(response);
        return;
      }
      if (message.type === 'webgpu-vision-clear-cache') {
        const response = await sendVisionWorkerMessage('clear-cache', { modelId: message.model });
        visionDownloadFiles.clear();
        publishVisionDownloadState({ modelId: message.model, status: 'not-downloaded', progress: 0 }, true);
        sendResponse(response);
        return;
      }
      if (message.type === 'webgpu-vision-dispose') {
        sendResponse(await sendVisionWorkerMessage('dispose-vision'));
        return;
      }
      if (message.type === 'webgpu-dispose') {
        const disposed = [];
        if (visionWorker) disposed.push(await sendVisionWorkerMessage('dispose-text'));
        if (bonsaiWorker) disposed.push(await sendBonsaiWorkerMessage('dispose-text'));
        sendResponse(disposed[0] || { ok: true, disposed: true });
        return;
      }
      if (message.type === 'webgpu-chat') {
        sendResponse(await sendTextWorkerMessage(message.model, 'text-chat', {
          modelId: message.model,
          device: message.device,
          dtype: message.dtype,
          requireTools: message.requireTools === true,
          messages: message.messages || [],
          options: message.options || {},
        }, { exclusive: true, runtime: message.runtime }));
        return;
      }
      const response = await sendVisionWorkerMessage('chat', {
        modelId: message.model,
        device: message.device,
        dtype: message.dtype,
        messages: message.messages || [],
        options: message.options || {},
      });
      publishVisionDownloadState({ modelId: message.model, status: 'ready', progress: 100 }, true);
      sendResponse(response);
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();
  return true;
});
