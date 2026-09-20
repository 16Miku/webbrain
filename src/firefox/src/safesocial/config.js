/** SafeSocial is an optional, local multilabel image classifier, not a chat provider. */
export const SETTINGS_KEY = 'safeSocialSettings';
export const CACHE_NAME = 'webbrain-safesocial-v1';
export const MODEL_ID = 'webbrain-one/safesocial-trigger-classifier-efficientnet-lite0';
export const MODEL_REVISION = 'd39182d06486b237ba33bc675b9302a206182460';
export const MODEL_BASE = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/`;
export const MODEL_FILES = Object.freeze({
  'safesocial-model.json': { bytes: 6260, sha256: '650152199b9b17426f2c40b03d237c3c6bed88101c069da0f38444ef563cee14' },
  'model.onnx': { bytes: 13584716, sha256: 'fd37c1cd4aafa2bc318b7d29725fa6be3931d09cc1723bb30be3ee819ee22933' },
});
export const LABELS = Object.freeze([
  'romance_jealousy', 'social_fomo', 'luxury_status', 'travel_lifestyle',
  'body_beauty_comparison', 'achievement_status', 'social_proof_popularity', 'exclusivity_access',
]);
export const DEFAULT_LABELS = Object.freeze(Object.fromEntries(LABELS.map(label => [label,
  ['romance_jealousy', 'luxury_status', 'travel_lifestyle'].includes(label)])));

export function normalizeSettings(value = {}) {
  const threshold = value?.threshold;
  return {
    enabled: value?.enabled === true,
    action: ['blur', 'hide', 'dim', 'warn'].includes(value?.action) ? value.action : 'blur',
    // Match the current SafeSocial prototype's absolute probability cutoff.
    threshold: typeof threshold === 'number' && Number.isFinite(threshold)
      ? Math.min(0.99, Math.max(0.5, threshold)) : 0.95,
    labels: Object.fromEntries(LABELS.map(label => [label,
      typeof value?.labels?.[label] === 'boolean' ? value.labels[label] : DEFAULT_LABELS[label]])),
  };
}

export function isInstagramUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['www.instagram.com', 'instagram.com'].includes(url.hostname);
  } catch { return false; }
}

export function isMediaUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 8192) return false;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['cdninstagram.com', 'fbcdn.net'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

export function matchingLabels(scores, settings) {
  return LABELS.filter(label => settings.labels[label] && Number.isFinite(scores?.[label])
    && scores[label] >= settings.threshold && scores[label] <= 1);
}

export function centerCrop(width, height, { image_size: size, resize }) {
  // Training evaluation resizes the short edge to 256, then center-crops 224.
  const crop = Math.min(width, height) * size / resize;
  return { x: (width - crop) / 2, y: (height - crop) / 2, size: crop };
}

export function normalizedPixels(pixels, { image_size: size, mean, std }) {
  const plane = size * size;
  const values = new Float32Array(3 * plane);
  for (let index = 0; index < plane; index++) {
    for (let channel = 0; channel < 3; channel++) {
      values[channel * plane + index] = (pixels[index * 4 + channel] / 255 - mean[channel]) / std[channel];
    }
  }
  return values;
}
