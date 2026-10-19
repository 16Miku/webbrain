import { D1_MODEL_ID, D1_CONSENT_KEY, D1_CONSENT_VERSION } from '../providers/d1-config.js';
export const DEFAULT_DECISION_MODEL = 'cloudflare/clef-flash';
// Auto (the default) uses a decision model only when one is already on hand,
// On uses the configured one for every decision, Off never uses one.
export const DECISION_MODE_KEY = 'decisionMode';
export const DECISION_MODES = Object.freeze(['auto', 'on', 'off']);
// The stored switch for each decision a decision model can answer. Semantic
// decisions (what a request says about an action) have no switch: they follow
// the configured model in On and Compass in Auto.
export const DECISION_FEATURE_KEYS = Object.freeze({
  done: 'systemOneDoneEnabled',
  watch: 'systemOneWatchEnabled',
  completion: 'systemOneCompletionEnabled',
  classifications: 'systemOneFastClassifications',
  browser: 'systemOneFastBrowser',
});
export const DECISION_FEATURES = Object.freeze([...Object.keys(DECISION_FEATURE_KEYS), 'semantic']);
export const DECISION_SETTINGS_KEYS = [
  DECISION_MODE_KEY, 'systemOneEnabled', 'typesafeApiKey', 'decisionProvider', 'decisionModel',
  'decisionApiKey', 'decisionLocalApiKey', 'decisionBaseUrl', 'decisionVisionMode', 'decisionVisionSupported',
  'decisionInputRate', 'decisionOutputRate', 'systemOneDoneEnabled', 'systemOneDoneThreshold',
  'systemOneWatchEnabled', 'systemOneCompletionEnabled', 'systemOneFastClassifications', 'systemOneFastBrowser',
  D1_CONSENT_KEY,
];

// The in-browser chat model answers decisions through its trained probe
// (Chrome; src/chrome/src/offscreen/bonsai-decision-probe.js). Kept in sync
// with WEBGPU_DECISION_MODEL_ID in providers/webgpu.js.
export const WEBGPU_CHAT_DECISION_MODEL = 'webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision';

const NO_DECISION_FEATURES = Object.freeze(Object.fromEntries(DECISION_FEATURES.map(feature => [feature, false])));
// Auto with Compass keeps what Compass did before modes existed: completion
// checks and semantic decisions on its managed model.
const AUTO_COMPASS_FEATURES = Object.freeze({ ...NO_DECISION_FEATURES, done: true, semantic: true });

// A saved mode wins. Profiles saved before modes existed map an enabled
// System One switch to On and everything else to the Auto default, without
// rewriting storage.
export function resolveDecisionMode(stored = {}) {
  if (DECISION_MODES.includes(stored?.[DECISION_MODE_KEY])) return stored[DECISION_MODE_KEY];
  return stored?.systemOneEnabled === true ? 'on' : 'auto';
}

// Whether the resolved configuration answers this decision. Every caller asks
// here instead of reading the mode or the feature switches itself.
export function decisionFeatureEnabled(config, feature) {
  return config?.enabled === true && config.features?.[feature] === true;
}

function doneThreshold(stored) {
  return Number.isFinite(stored.systemOneDoneThreshold) && stored.systemOneDoneThreshold >= .5 && stored.systemOneDoneThreshold <= .99 ? stored.systemOneDoneThreshold : .9;
}

// On: every decision unless its switch was turned off. A profile from before
// modes keeps the defaults it had then: feature switches opt in, and completion
// checks on an in-browser model opt in too.
function onDecisionFeatures(stored, config, legacy) {
  if (!legacy) {
    return { ...Object.fromEntries(Object.entries(DECISION_FEATURE_KEYS).map(([feature, key]) => [feature, stored[key] !== false])), semantic: true };
  }
  return {
    done: config.doneEnabled === true,
    watch: stored.systemOneWatchEnabled === true,
    completion: stored.systemOneCompletionEnabled === true,
    classifications: stored.systemOneFastClassifications === true,
    browser: stored.systemOneFastBrowser === true,
    semantic: true,
  };
}

// Resolve settings without rewriting credentials or opted-in features. The
// result keeps the selected provider's fields even when no decision is
// answered, so Settings and model discovery see the same configuration.
// Firefox has no in-browser model runtime, so Auto never finds one here and
// the option Chrome passes for it is accepted and ignored.
export function resolveDecisionConfig(stored = {}, compass = null, _options = {}) {
  stored = stored || {};
  const mode = resolveDecisionMode(stored);
  const legacy = mode === 'on' && !DECISION_MODES.includes(stored[DECISION_MODE_KEY]);
  const on = mode === 'on';
  const config = selectedDecisionConfig(stored, mode === 'off' ? null : compass, on);
  const features = mode === 'off' ? { ...NO_DECISION_FEATURES }
    : on ? onDecisionFeatures(stored, config, legacy)
      : config.provider === 'compass' ? { ...AUTO_COMPASS_FEATURES } : { ...NO_DECISION_FEATURES };
  const source = mode === 'off' ? 'off' : config.provider === 'compass' ? 'compass' : on ? 'configured' : 'none';
  return { ...config, enabled: mode !== 'off' && config.enabled, doneEnabled: features.done, mode, source, features };
}

// A profile saved before modes existed and left in On keeps the feature defaults it had then: a
// missing switch means off. Writing an explicit mode makes the modern reading apply (missing means
// on), so the switches the user sees have to be written down before the mode changes. Returns the
// explicit values to store; nothing for a profile that already has a mode or was not On.
export function materializeLegacyDecisionFeatures(stored = {}) {
  stored = stored || {};
  if (DECISION_MODES.includes(stored[DECISION_MODE_KEY]) || stored.systemOneEnabled !== true) return {};
  const { features } = resolveDecisionConfig(stored);
  const values = {};
  for (const [feature, key] of Object.entries(DECISION_FEATURE_KEYS)) {
    if (!Object.hasOwn(stored, key)) values[key] = features[feature] === true;
  }
  return values;
}

// The provider configuration itself. `on` means the user turned decisions on:
// only then can an explicit local choice (D1, the chat model) or a configured
// key answer; Compass answers whenever it is passed in.
function selectedDecisionConfig(stored, compass, on) {
  const explicitD1 = stored.decisionProvider === 'webgpu_d1' && on && stored[D1_CONSENT_KEY] === D1_CONSENT_VERSION;
  const explicitChat = stored.decisionProvider === 'webgpu_chat' && on;
  const provider = explicitD1 ? 'webgpu_d1' : explicitChat ? 'webgpu_chat' : compass ? 'compass' : (stored.decisionProvider || (stored.typesafeApiKey ? 'typesafe' : 'openrouter'));
  if (provider === 'webgpu_d1') return {
    provider, model: D1_MODEL_ID, apiKey: '', baseUrl: '', url: '', local: true,
    enabled: on && stored[D1_CONSENT_KEY] === D1_CONSENT_VERSION,
    doneEnabled: stored.systemOneDoneEnabled === true,
    threshold: doneThreshold(stored),
    supportsVision: stored.decisionVisionMode !== 'off', experimental: true,
    requiresIndependentSuccessConfirmation: true,
    config: { category: 'local', providerName: provider, inputCostPerMillionUsd: 0, outputCostPerMillionUsd: 0 },
  };
  // Explicitly selected, like D1: an on-device decision provider that never
  // leaves the browser. A positive completion still needs independent proof.
  // Chrome-only: Firefox keeps the selection (never a cloud fallback) but
  // never enables it; config-transfer.js imports it with System One off.
  if (provider === 'webgpu_chat') return {
    provider, model: WEBGPU_CHAT_DECISION_MODEL, apiKey: '', baseUrl: '', url: '', local: true,
    enabled: false, unavailable: 'chrome_only',
    doneEnabled: stored.systemOneDoneEnabled === true,
    threshold: doneThreshold(stored),
    supportsVision: stored.decisionVisionMode !== 'off', experimental: true,
    requiresIndependentSuccessConfirmation: true,
    config: { category: 'local', providerName: provider, inputCostPerMillionUsd: 0, outputCostPerMillionUsd: 0 },
  };
  if (!['compass', 'openrouter', 'typesafe', 'local'].includes(provider)) throw new Error('Unknown decision provider.');
  const defaults = { compass: DEFAULT_DECISION_MODEL, openrouter: DEFAULT_DECISION_MODEL, typesafe: 'jev-1.13.0', local: 'kev-latest' };
  const model = compass ? DEFAULT_DECISION_MODEL : String(stored.decisionModel || defaults[provider]).trim();
  const baseUrl = provider === 'compass' ? String(compass.baseUrl || 'https://api.webbrain.one/v1')
    : provider === 'openrouter' ? 'https://openrouter.ai/api/alpha'
      : provider === 'typesafe' ? 'https://api.typesafe.ai/v1'
        : String(stored.decisionBaseUrl || 'http://127.0.0.1:8009').trim();
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid decision endpoint.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback) throw new Error('Decision endpoints require HTTPS outside localhost.');
  const apiKey = String((provider === 'compass' ? compass?.apiKey : provider === 'typesafe' ? stored.typesafeApiKey : provider === 'local' ? stored.decisionLocalApiKey : stored.decisionApiKey) || '').trim();
  const visionMode = compass ? 'auto' : (stored.decisionVisionMode || 'auto');
  const rate = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    provider, model, apiKey, baseUrl: baseUrl.replace(/\/$/, ''),
    url: baseUrl.replace(/\/$/, '') + (['compass', 'openrouter'].includes(provider) ? '/decisions' : provider === 'typesafe' || url.pathname.replace(/\/$/, '').endsWith('/v1') ? '/systemone' : '/v1/systemone'),
    local: provider === 'local' && loopback,
    enabled: !!compass || (on && (provider === 'local' || !!apiKey)),
    doneEnabled: !!compass || stored.systemOneDoneEnabled !== false,
    threshold: doneThreshold(stored),
    supportsVision: visionMode === 'on' || (visionMode !== 'off' && (compass ? true : stored.decisionVisionSupported === true)),
    config: { category: provider === 'local' && loopback ? 'local' : 'cloud', providerName: provider === 'compass' ? 'webbrain-cloud' : provider,
      inputCostPerMillionUsd: rate(stored.decisionInputRate, provider === 'typesafe' ? .042 : provider === 'local' ? 0 : .02),
      outputCostPerMillionUsd: rate(stored.decisionOutputRate, 0) },
  };
}

export async function listDecisionModels(config, fetchImpl = globalThis.fetch, signal) {
  if (config.provider === 'webgpu_chat') return [{ id: WEBGPU_CHAT_DECISION_MODEL, name: 'Ternary Bonsai 2 2B Vision (in-browser, experimental)', supportsVision: true, inputRate: 0, outputRate: 0 }];
  if (config.provider === 'webgpu_d1') return [{ id: D1_MODEL_ID, name: 'D1 FP16 (experimental, on-device)', supportsVision: true, inputRate: 0, outputRate: 0 }];
  return withCompletionTimeout(requestSignal => discoverDecisionModels(config, fetchImpl, requestSignal), signal, 5000);
}

async function discoverDecisionModels(config, fetchImpl, signal) {
  const url = config.provider === 'openrouter' ? 'https://openrouter.ai/api/v1/models?output_modalities=decisions' : config.baseUrl + (config.baseUrl.endsWith('/v1') ? '/models' : '/v1/models');
  const response = await fetchImpl(url, { credentials: 'omit', redirect: 'error', signal, headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {} });
  if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}.`);
  const body = await response.json();
  const models = Array.isArray(body) ? body : body.data || body.models || [];
  if (!Array.isArray(models)) throw new Error('Invalid decision model catalog.');
  return models.filter(m => config.provider !== 'openrouter' || m.architecture?.output_modalities?.includes('decisions')).map(m => ({
    id: m.id || m.name, name: m.name || m.id,
    supportsVision: m.architecture?.input_modalities?.includes('image') === true,
    inputRate: Number(m.pricing?.prompt || 0) * 1e6, outputRate: Number(m.pricing?.completion || 0) * 1e6,
  })).filter(m => typeof m.id === 'string');
}
import { withCompletionTimeout } from './completion-verifier.js';
