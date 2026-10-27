// Browser-free sizing, format and token rules for vision mode screenshots.
// This file is shared verbatim by the Chrome and Firefox builds; keep both
// copies byte-identical (test/vision-mode.mjs checks).
//
// Why per-provider profiles: every vision API resizes images it considers too
// large BEFORE the model sees them, and the model then answers in the resized
// image's pixel space. A screenshot the server silently shrinks makes every
// coordinate the model returns wrong by the shrink factor. So the extension
// picks the largest size each provider accepts *unchanged*, aligns it to the
// provider's patch grid where that grid is known, and never sends more image
// pixels than CSS pixels (a retina capture is downscaled locally; `zoom` is
// the path to fine detail).

export const VISION_QUALITY_PRESETS = Object.freeze({
  economy: Object.freeze({ maxLongEdge: 1024, maxPixels: 600_000 }),
  balanced: Object.freeze({ maxLongEdge: 1440, maxPixels: 1_050_000 }),
  sharp: Object.freeze({ maxLongEdge: Infinity, maxPixels: Infinity }),
});

export const DEFAULT_VISION_QUALITY = 'balanced';

// coordinates: 'pixel' = image pixels from the top-left corner;
// 'normalized' = 0..1000 on both axes (Gemini and Qwen3-VL are trained on
// relative 0..1000 boxes and answer far more accurately in that space).
export const VISION_PROFILES = Object.freeze({
  anthropic: Object.freeze({
    id: 'anthropic', tokenModel: 'anthropic', coordinates: 'pixel',
    // Larger images are downscaled server-side (long edge 1568, ~1.15 MP).
    maxLongEdge: 1568, maxPixels: 1_150_000, maxShortEdge: Infinity, align: 1,
    format: 'webp', quality: 0.8,
  }),
  openai: Object.freeze({
    id: 'openai', tokenModel: 'openai_tiles', coordinates: 'pixel',
    // High detail fits 2048x2048 and then scales the short side to 768.
    maxLongEdge: 2048, maxPixels: Infinity, maxShortEdge: 768, align: 1,
    format: 'webp', quality: 0.8,
  }),
  gemini: Object.freeze({
    id: 'gemini', tokenModel: 'gemini', coordinates: 'normalized',
    maxLongEdge: 1536, maxPixels: 1_200_000, maxShortEdge: Infinity, align: 1,
    format: 'webp', quality: 0.8,
  }),
  qwen: Object.freeze({
    id: 'qwen', tokenModel: 'patch28', coordinates: 'pixel',
    // Qwen2-VL / Qwen2.5-VL / UI-TARS answer in absolute pixels of the
    // smart-resized image. Multiples of 28 make that resize the identity.
    maxLongEdge: Infinity, maxPixels: 1_003_520, maxShortEdge: Infinity, align: 28,
    format: 'jpeg', quality: 0.8,
  }),
  qwen3: Object.freeze({
    id: 'qwen3', tokenModel: 'patch32', coordinates: 'normalized',
    maxLongEdge: Infinity, maxPixels: 1_048_576, maxShortEdge: Infinity, align: 32,
    format: 'jpeg', quality: 0.8,
  }),
  relative1000: Object.freeze({
    id: 'relative1000', tokenModel: 'patch28', coordinates: 'normalized',
    // GLM-4.xV and InternVL are trained on boxes normalized to 0..1000.
    // JPEG because they are often served by local runtimes too.
    maxLongEdge: 1280, maxPixels: 1_003_520, maxShortEdge: Infinity, align: 28,
    format: 'jpeg', quality: 0.8,
  }),
  local: Object.freeze({
    id: 'local', tokenModel: 'patch28', coordinates: 'pixel',
    // llama.cpp's image loader (stb_image) cannot decode WebP; JPEG is the
    // one format every local server accepts.
    maxLongEdge: 1280, maxPixels: 1_003_520, maxShortEdge: Infinity, align: 28,
    format: 'jpeg', quality: 0.75,
  }),
  default: Object.freeze({
    id: 'default', tokenModel: 'patch28', coordinates: 'pixel',
    maxLongEdge: 1568, maxPixels: 1_150_000, maxShortEdge: Infinity, align: 1,
    format: 'jpeg', quality: 0.75,
  }),
});

const LOCAL_PROVIDER_NAMES = new Set(['llamacpp', 'ollama', 'lmstudio', 'webgpu', 'ods', 'localai', 'jan', 'osaurus']);

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

// The host of a configured base URL, compared exactly: a host name that only
// appears somewhere in the URL (a path, a longer domain) is not that host.
function urlHost(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Pick the vision profile for a provider object (or its config). Model ids
 * decide first because routers (OpenRouter, Bedrock, Vertex) serve several
 * families behind one provider name.
 */
export function detectVisionProfile(provider = {}) {
  const config = provider?.config || {};
  const model = lower(config.model || provider?.model);
  const name = lower(provider?.name || config.providerName || config.type);
  const baseUrl = lower(config.baseUrl || provider?.baseUrl);
  const category = lower(config.category || provider?.category);
  // Qwen3-VL and the natively multimodal Qwen3.5+ point in relative 0..1000.
  if (/qwen3(\.\d+)?-(vl|omni)|qwen3\.[5-9]/.test(model)) return VISION_PROFILES.qwen3;
  if (/glm-4(\.\d+)?v|internvl/.test(model)) return VISION_PROFILES.relative1000;
  if (/gemini/.test(model)) return VISION_PROFILES.gemini;
  if (/claude|anthropic/.test(model) || ['anthropic', 'vertex-anthropic', 'oauth-claude', 'claude'].includes(name)) {
    return VISION_PROFILES.anthropic;
  }
  if (/qwen|ui-tars|uitars|holo1|opencua/.test(model)) return VISION_PROFILES.qwen;
  if (/(^|\/)(gpt-|o\d|chatgpt|computer-use)/.test(model) || name === 'openai' || name === 'azure-openai'
      || urlHost(baseUrl) === 'api.openai.com') {
    return VISION_PROFILES.openai;
  }
  if (LOCAL_PROVIDER_NAMES.has(name) || category === 'local') return VISION_PROFILES.local;
  return VISION_PROFILES.default;
}

export function normalizeVisionQuality(value) {
  const key = lower(value);
  return Object.prototype.hasOwnProperty.call(VISION_QUALITY_PRESETS, key) ? key : DEFAULT_VISION_QUALITY;
}

function alignDown(value, align) {
  if (!(align > 1)) return Math.max(1, Math.floor(value));
  return Math.max(align * 2, Math.floor(value / align) * align);
}

/** Estimated prompt tokens for one image of `w`x`h` pixels on `profile`. */
export function estimateVisionTokens(w, h, profile = VISION_PROFILES.default) {
  const width = Math.max(1, Math.round(Number(w) || 1));
  const height = Math.max(1, Math.round(Number(h) || 1));
  switch (profile?.tokenModel) {
    case 'anthropic':
      return Math.ceil((width * height) / 750);
    case 'openai_tiles': {
      let sw = width;
      let sh = height;
      const fit = Math.min(1, 2048 / Math.max(sw, sh));
      sw *= fit; sh *= fit;
      const shortScale = Math.min(1, 768 / Math.min(sw, sh));
      sw *= shortScale; sh *= shortScale;
      return 85 + 170 * Math.ceil(sw / 512) * Math.ceil(sh / 512);
    }
    case 'gemini': {
      if (width <= 384 && height <= 384) return 258;
      const tile = Math.min(768, Math.max(256, Math.floor(Math.min(width, height) / 1.5)));
      return 258 * Math.ceil(width / tile) * Math.ceil(height / tile);
    }
    case 'patch32':
      return Math.ceil(width / 32) * Math.ceil(height / 32) + 2;
    case 'patch28':
    default:
      return Math.ceil(width / 28) * Math.ceil(height / 28) + 2;
  }
}

/**
 * Size of the model-facing screenshot for a CSS viewport. Returns integer
 * image dimensions plus independent X/Y factors (grid alignment can make
 * them differ by a fraction of a percent; mapping keeps both).
 */
export function planVisionImageSize({ cssWidth, cssHeight, profile = VISION_PROFILES.default, quality = DEFAULT_VISION_QUALITY } = {}) {
  const cw = Math.max(1, Number(cssWidth) || 1);
  const ch = Math.max(1, Number(cssHeight) || 1);
  const preset = VISION_QUALITY_PRESETS[normalizeVisionQuality(quality)];
  const maxLong = Math.min(profile.maxLongEdge ?? Infinity, preset.maxLongEdge);
  const maxPixels = Math.min(profile.maxPixels ?? Infinity, preset.maxPixels);
  const maxShort = profile.maxShortEdge ?? Infinity;
  let scale = 1;
  scale = Math.min(scale, maxLong / Math.max(cw, ch));
  scale = Math.min(scale, Math.sqrt(maxPixels / (cw * ch)));
  scale = Math.min(scale, maxShort / Math.min(cw, ch));
  if (!(scale > 0) || !Number.isFinite(scale)) scale = 1;
  const align = Math.max(1, Math.floor(profile.align || 1));
  const width = Math.min(Math.round(cw), alignDown(cw * scale, align));
  const height = Math.min(Math.round(ch), alignDown(ch * scale, align));
  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
    scaleX: Math.max(1, width) / cw,
    scaleY: Math.max(1, height) / ch,
    estimatedTokens: estimateVisionTokens(width, height, profile),
  };
}

/**
 * Size of a `zoom` crop. The region is rendered at up to 2 image pixels per
 * CSS pixel (real detail on a retina surface), bounded so one zoom never
 * costs more than a full frame.
 */
export function planZoomImageSize({ regionWidth, regionHeight, devicePixelRatio = 1, profile = VISION_PROFILES.default } = {}) {
  const rw = Math.max(1, Number(regionWidth) || 1);
  const rh = Math.max(1, Number(regionHeight) || 1);
  const maxScale = Math.min(2, Math.max(1, Number(devicePixelRatio) || 1) * 1.5);
  const maxLong = Math.min(profile.maxLongEdge ?? Infinity, 1280);
  const maxPixels = Math.min(profile.maxPixels ?? Infinity, 900_000);
  let scale = maxScale;
  scale = Math.min(scale, maxLong / Math.max(rw, rh));
  scale = Math.min(scale, Math.sqrt(maxPixels / (rw * rh)));
  scale = Math.min(scale, (profile.maxShortEdge ?? Infinity) / Math.min(rw, rh));
  if (!(scale > 0) || !Number.isFinite(scale)) scale = 1;
  const align = Math.max(1, Math.floor(profile.align || 1));
  const width = Math.max(align > 1 ? align * 2 : 1, alignDown(rw * scale, align));
  const height = Math.max(align > 1 ? align * 2 : 1, alignDown(rh * scale, align));
  return { width, height, scaleX: width / rw, scaleY: height / rh, estimatedTokens: estimateVisionTokens(width, height, profile) };
}

/**
 * Image encoding for a profile. WebP is ~30% smaller than JPEG at the same
 * visual quality for UI screenshots, which shortens uploads; providers bill
 * by pixels, not bytes, so the token cost is the same either way.
 */
export function visionEncodingFor(profile = VISION_PROFILES.default, { webpSupported = true } = {}) {
  const format = profile.format === 'webp' && webpSupported ? 'webp' : 'jpeg';
  return { mimeType: `image/${format}`, quality: Number(profile.quality) || 0.75, format };
}

// Base64 payload ceiling per image (Anthropic rejects >5 MB decoded; most
// gateways cap request bodies far below that). Encoders step quality down
// until the image fits.
export const VISION_MAX_BASE64_CHARS = 1_400_000;
export const VISION_MIN_QUALITY = 0.35;
