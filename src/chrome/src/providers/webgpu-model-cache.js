/**
 * Whether an in-browser chat model finished downloading, read without the
 * offscreen document. The WebGPU worker writes a ready marker into Cache
 * Storage only after a complete download (markTextModelReady in
 * offscreen/inference-worker.js), and every extension context shares that
 * storage: pages, the service worker and the offscreen worker. Auto settings
 * ask this on hot paths (each completion check, each screenshot route), so it
 * stays one cache lookup and never starts the offscreen document to find out.
 */
import { WEBGPU_BONSAI2_VL_2B_MODEL_ID, webgpuModelDtype } from './webgpu.js';

const TRANSFORMERS_CACHE_NAME = 'transformers-cache';

// Ternary Bonsai 2 2B Vision chats, sees and answers decisions on the device,
// so the Auto decision and vision settings follow whether it is downloaded.
export const WEBGPU_LOCAL_ASSIST_MODEL_ID = WEBGPU_BONSAI2_VL_2B_MODEL_ID;

// Mirrors textDtypeKey()/textModelKey() in offscreen/inference-worker.js.
function textDtypeKey(dtype) {
  if (!dtype || typeof dtype !== 'object' || Array.isArray(dtype)) return String(dtype || '').trim();
  return JSON.stringify(Object.fromEntries(
    Object.entries(dtype).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

export function webgpuTextReadyMarkerUrl(modelId, dtype = webgpuModelDtype(modelId)) {
  const key = `${String(modelId || '').trim()}|${textDtypeKey(dtype)}`;
  return `https://webbrain.one/.well-known/webgpu-model-ready/${encodeURIComponent(key)}`;
}

/** true or false, or null when Cache Storage cannot be read in this context. */
export async function hasWebgpuTextModelCache(modelId, dtype) {
  const normalized = String(modelId || '').trim();
  if (!normalized || typeof caches === 'undefined') return null;
  try {
    // A named lookup never creates the cache when nothing was downloaded.
    const marker = await caches.match(
      webgpuTextReadyMarkerUrl(normalized, dtype ?? webgpuModelDtype(normalized)),
      { cacheName: TRANSFORMERS_CACHE_NAME },
    );
    return !!marker;
  } catch {
    return null;
  }
}

export async function isLocalAssistModelReady() {
  return await hasWebgpuTextModelCache(WEBGPU_LOCAL_ASSIST_MODEL_ID) === true;
}
