import {
  WEBGPU_CHAT_DECISION_DTYPE,
  WEBGPU_CHAT_DECISION_MODEL,
  decisionNeedsChatAssist,
  decisionNeedsLocalAssist,
  resolveDecisionConfig,
} from './decision-config.js';
import { D1_KEEP_LOADED_KEY } from '../providers/d1-config.js';
import { d1PackageReady } from '../providers/d1-cache.js';

// Auto uses D1 once its package is downloaded and verified, Compass or not,
// while the user's Download or Load stands: Unload, Remove cached model and
// switching decisions Off end it (background.js d1_control). The lookup is one
// storage read and D1's ready marker, without the offscreen document or the
// GPU, so per-check callers can afford it. A downloaded chat or vision model
// never enables decisions.
export async function d1LocalAssistReady(api = globalThis.browser || globalThis.chrome, storageManager = globalThis.navigator?.storage) {
  try {
    const stored = await api.storage.local.get(D1_KEEP_LOADED_KEY);
    return stored?.[D1_KEEP_LOADED_KEY] === true && await d1PackageReady(storageManager);
  } catch { return false; }
}

// Whether Compass VLD Tiny v5, the in-browser chat model fine-tuned for
// decisions, finished downloading: the ready marker the WebGPU worker writes
// into Cache Storage after a verified download (markTextModelReady in
// offscreen/inference-worker.js, webgpu-model-cache.js). One cache lookup,
// without the offscreen document or the GPU. Never true in Firefox, which has
// no in-browser chat runtime.
export async function chatDecisionModelReady(cacheStorage = globalThis.caches) {
  try {
    if (!cacheStorage?.match) return false;
    const dtype = JSON.stringify(Object.fromEntries(Object.entries(WEBGPU_CHAT_DECISION_DTYPE)
      .sort(([left], [right]) => left.localeCompare(right))));
    const marker = `https://webbrain.one/.well-known/webgpu-model-ready/${encodeURIComponent(`${WEBGPU_CHAT_DECISION_MODEL}|${dtype}`)}`;
    return !!await cacheStorage.match(marker, { cacheName: 'transformers-cache' });
  } catch { return false; }
}

// The decision configuration that applies right now, for `feature` when the
// caller names the decision it asks (decision-config.js DECISION_FEATURES).
// Auto uses the in-browser chat model when it is downloaded, else D1.
export async function resolveCurrentDecisionConfig(stored = {}, compass = null, { feature = null } = {}) {
  const chatAssistReady = decisionNeedsChatAssist(stored, compass, feature) && await chatDecisionModelReady();
  const localAssistReady = !chatAssistReady && decisionNeedsLocalAssist(stored, compass, feature) && await d1LocalAssistReady();
  return resolveDecisionConfig(stored, compass, { localAssistReady, chatAssistReady, feature });
}
