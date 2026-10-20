import { decisionNeedsLocalAssist, resolveDecisionConfig } from './decision-config.js';
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

// The decision configuration that applies right now, for `feature` when the
// caller names the decision it asks (decision-config.js DECISION_FEATURES).
export async function resolveCurrentDecisionConfig(stored = {}, compass = null, { feature = null } = {}) {
  const localAssistReady = decisionNeedsLocalAssist(stored, compass, feature) && await d1LocalAssistReady();
  return resolveDecisionConfig(stored, compass, { localAssistReady, feature });
}
