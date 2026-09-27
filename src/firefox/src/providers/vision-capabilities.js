export const AUTO_VISION_PROVIDER_IDS = new Set(['llamacpp', 'lmstudio', 'localai']);
export const VISION_MODES = new Set(['auto', 'on', 'off']);

const DETECTION_SOURCES = {
  llamacpp: 'llamacpp_props',
  lmstudio: 'lmstudio_models',
  localai: 'localai_capabilities',
};

export function visionProviderKind(providerId, config = {}) {
  if (config?.type === 'llamacpp') return 'llamacpp';
  const id = String(providerId || '').trim().toLowerCase();
  if (AUTO_VISION_PROVIDER_IDS.has(id)) return id;
  const providerName = String(config?.providerName || '').trim().toLowerCase();
  return AUTO_VISION_PROVIDER_IDS.has(providerName) ? providerName : null;
}

export function canonicalizeVisionBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function visionCapabilityIdentity(providerId, config) {
  if (!AUTO_VISION_PROVIDER_IDS.has(providerId)) return null;
  const baseUrl = canonicalizeVisionBaseUrl(config?.baseUrl);
  if (!baseUrl) return null;
  const model = String(config?.model || '').trim();
  return {
    providerId,
    baseUrl,
    model,
    key: `${providerId}\n${baseUrl}\n${model}`,
  };
}

export function visionDetectionMatches(providerId, config, detection = config?.visionDetection, options = {}) {
  const identity = visionCapabilityIdentity(providerId, config);
  const transientEmptyModel = options.allowTransient === true
    && !identity?.model
    && detection?.transient === true
    && !String(detection?.model || '').trim();
  return !!identity
    && (!!identity.model || transientEmptyModel)
    && detection?.providerId === providerId
    && detection?.source === DETECTION_SOURCES[providerId]
    && canonicalizeVisionBaseUrl(detection?.baseUrl) === identity.baseUrl
    && String(detection?.model || '').trim() === identity.model
    && typeof detection?.supportsVision === 'boolean';
}

export function configuredVisionSupport(providerId, config) {
  const mode = VISION_MODES.has(config?.visionMode) ? config.visionMode : 'auto';
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return visionDetectionMatches(providerId, config, config?.visionDetection, { allowTransient: true })
    && config.visionDetection.supportsVision === true;
}

function modelId(entry) {
  return String(entry?.key || entry?.id || entry?.model || entry?.name || '').trim();
}

function selectModel(entries, requestedModel, { preferLoaded = false } = {}) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const requested = String(requestedModel || '').trim();
  if (requested) return entries.find(entry => modelId(entry) === requested) || null;
  if (preferLoaded) {
    const loaded = entries.filter(entry =>
      String(entry?.state || '').toLowerCase() === 'loaded'
      || (Array.isArray(entry?.loaded_instances) && entry.loaded_instances.length > 0)
    );
    if (loaded.length === 1) return loaded[0];
  }
  return entries.length === 1 ? entries[0] : null;
}

export function parseLmStudioVisionSupport(payload, model, apiVersion = 'v1') {
  const entries = apiVersion === 'v1' ? payload?.models : payload?.data;
  const entry = selectModel(entries, model, { preferLoaded: true });
  if (!entry) return null;
  if (apiVersion === 'v1') {
    return typeof entry?.capabilities?.vision === 'boolean'
      ? entry.capabilities.vision
      : null;
  }
  const type = String(entry?.type || '').trim().toLowerCase();
  if (type === 'vlm') return true;
  if (type === 'llm') return false;
  return null;
}

export function parseLlamaCppVisionSupport(payload) {
  return typeof payload?.modalities?.vision === 'boolean'
    ? payload.modalities.vision
    : null;
}

export function parseLocalAiVisionSupport(payload, model) {
  const entry = selectModel(payload?.data, model);
  if (!entry) return null;
  if (Array.isArray(entry.input_modalities)) {
    return entry.input_modalities.some(value => String(value).toLowerCase() === 'image');
  }
  if (Array.isArray(entry.capabilities)) {
    return entry.capabilities.some(value => String(value).toLowerCase() === 'vision');
  }
  if (typeof entry?.capabilities?.vision === 'boolean') return entry.capabilities.vision;
  return null;
}

export function visionDetectionSource(providerId) {
  return DETECTION_SOURCES[providerId] || '';
}
