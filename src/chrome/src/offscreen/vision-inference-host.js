/** Proxy endpoint-free WebGPU requests from the service worker to a module Worker. */

let visionWorker = null;
let visionWorkerReady = null;
let nextVisionRequestId = 1;
const pendingVisionRequests = new Map();
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
      await ensureVisionWorker();
      if (message.type === 'webgpu-vision-preload') {
        const started = startVisionPreload(message);
        sendResponse({ ok: true, started });
        return;
      }
      if (message.type === 'webgpu-probe' || message.type === 'webgpu-vision-probe') {
        sendResponse(await sendVisionWorkerMessage('probe'));
        return;
      }
      if (message.type === 'webgpu-download-status') {
        sendResponse(await sendVisionWorkerMessage('text-download-status', {
          modelId: message.model,
          dtype: message.dtype,
        }));
        return;
      }
      if (message.type === 'webgpu-download-start') {
        sendResponse(await sendVisionWorkerMessage('start-download-text', {
          modelId: message.model,
          device: message.device,
          dtype: message.dtype,
          requireTools: message.requireTools === true,
        }));
        return;
      }
      if (message.type === 'webgpu-download-pause') {
        sendResponse(await sendVisionWorkerMessage('pause-text-download'));
        return;
      }
      if (message.type === 'webgpu-download-stop') {
        sendResponse(await sendVisionWorkerMessage('stop-text-download', {
          modelId: message.model,
          dtype: message.dtype,
        }));
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
        sendResponse(await sendVisionWorkerMessage('dispose-text'));
        return;
      }
      if (message.type === 'webgpu-chat') {
        sendResponse(await sendVisionWorkerMessage('text-chat', {
          modelId: message.model,
          device: message.device,
          dtype: message.dtype,
          requireTools: message.requireTools === true,
          messages: message.messages || [],
          options: message.options || {},
        }));
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
