/** Proxy WebGPU vision requests from the service worker to a module Worker. */

let visionWorker = null;
let visionWorkerReady = null;
let nextVisionRequestId = 1;
const pendingVisionRequests = new Map();

function settleVisionRequest(data) {
  if (data?.type === 'progress') {
    console.debug('[vision-webgpu] model download', data);
    return;
  }
  const pending = pendingVisionRequests.get(data?.id);
  if (!pending) return;
  pendingVisionRequests.delete(data.id);
  if (data.ok) pending.resolve(data);
  else pending.reject(new Error(data.error || 'Vision worker failed.'));
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

const VISION_MESSAGE_TYPES = new Set([
  'webgpu-vision-chat',
  'webgpu-vision-probe',
  'webgpu-vision-dispose',
  'webgpu-vision-clear-cache',
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!VISION_MESSAGE_TYPES.has(message?.type)) return false;
  (async () => {
    try {
      await ensureVisionWorker();
      if (message.type === 'webgpu-vision-probe') {
        sendResponse(await sendVisionWorkerMessage('probe'));
        return;
      }
      if (message.type === 'webgpu-vision-clear-cache') {
        sendResponse(await sendVisionWorkerMessage('clear-cache'));
        return;
      }
      if (message.type === 'webgpu-vision-dispose') {
        sendResponse(await sendVisionWorkerMessage('dispose'));
        return;
      }
      sendResponse(await sendVisionWorkerMessage('chat', {
        modelId: message.model,
        device: message.device,
        dtype: message.dtype,
        messages: message.messages || [],
        options: message.options || {},
      }));
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();
  return true;
});
