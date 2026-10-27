// Canvas helpers for vision mode: decode a capture, scale it to the exact
// model-facing size, read its pixels for diffing, and encode full frames or
// changed regions. No extension APIs, so the same file runs in Chrome's MV3
// service worker (OffscreenCanvas), Firefox's background page (canvas), and
// a plain page in the browser test suite. Shared verbatim by both builds.

import { VISION_MAX_BASE64_CHARS, VISION_MIN_QUALITY } from './vision-budget.js';

export function createCanvas(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined' && document?.createElement) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  throw new Error('No canvas implementation is available for vision screenshots.');
}

function context2d(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('The browser could not create a 2D canvas context.');
  return ctx;
}

async function sourceToBlob(source) {
  if (typeof Blob !== 'undefined' && source instanceof Blob) return source;
  const text = String(source || '');
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(text);
  if (!match) throw new Error('Unsupported screenshot source.');
  const mime = match[1] || 'image/png';
  if (!match[2]) return new Blob([decodeURIComponent(match[3])], { type: mime });
  const binary = atob(match[3]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function decodeImage(source) {
  const blob = await sourceToBlob(source);
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  // Very old Firefox background pages: fall back to an <img>.
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function sourceSize(image) {
  return {
    width: Math.round(image?.width || image?.naturalWidth || 0),
    height: Math.round(image?.height || image?.naturalHeight || 0),
  };
}

/**
 * Decode `source` and draw it at exactly `width`x`height`. Returns the
 * canvas, its RGBA pixels and the decoded size. A capture whose real size
 * differs from the planned one (emulated DPR, browser zoom, a compositor
 * that ignored the requested scale) is corrected here, so the model always
 * receives the planned image and the coordinate map stays exact.
 */
export async function rasterizeFrame(source, width, height) {
  const image = typeof source === 'string' || (typeof Blob !== 'undefined' && source instanceof Blob)
    ? await decodeImage(source)
    : source;
  const decoded = sourceSize(image);
  try {
    const w = Math.max(1, Math.round(width || decoded.width));
    const h = Math.max(1, Math.round(height || decoded.height));
    const canvas = createCanvas(w, h);
    const ctx = context2d(canvas);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, decoded.width || w, decoded.height || h, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data;
    return { canvas, ctx, pixels, width: w, height: h, sourceWidth: decoded.width, sourceHeight: decoded.height };
  } finally {
    try { image?.close?.(); } catch {}
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Canvas encoding failed.'))), type, quality);
  });
}

let webpSupport = null;
/** Whether this browser's canvas can encode WebP (Safari cannot). */
export async function supportsWebpEncoding() {
  if (webpSupport != null) return webpSupport;
  try {
    // convertToBlob refuses a canvas that never had a rendering context.
    const canvas = createCanvas(2, 2);
    context2d(canvas).fillRect(0, 0, 1, 1);
    const blob = await canvasToBlob(canvas, 'image/webp', 0.8);
    webpSupport = blob?.type === 'image/webp';
  } catch {
    webpSupport = false;
  }
  return webpSupport;
}

/**
 * Encode a region of `canvas` (default: all of it), optionally resampled to
 * `outWidth`x`outHeight`. Quality steps down until the base64 payload fits.
 */
export async function encodeCanvasRegion(canvas, region = null, {
  mimeType = 'image/jpeg',
  quality = 0.75,
  outWidth = null,
  outHeight = null,
  maxBase64Chars = VISION_MAX_BASE64_CHARS,
  minQuality = VISION_MIN_QUALITY,
} = {}) {
  const full = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const r = region ? {
    x: Math.max(0, Math.floor(region.x)),
    y: Math.max(0, Math.floor(region.y)),
    width: Math.max(1, Math.min(canvas.width - Math.max(0, Math.floor(region.x)), Math.round(region.width))),
    height: Math.max(1, Math.min(canvas.height - Math.max(0, Math.floor(region.y)), Math.round(region.height))),
  } : full;
  const w = Math.max(1, Math.round(outWidth || r.width));
  const h = Math.max(1, Math.round(outHeight || r.height));
  let target = canvas;
  if (r.x !== 0 || r.y !== 0 || r.width !== canvas.width || r.height !== canvas.height || w !== canvas.width || h !== canvas.height) {
    target = createCanvas(w, h);
    const ctx = context2d(target);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, r.x, r.y, r.width, r.height, 0, 0, w, h);
  }
  let type = mimeType;
  let q = Math.min(0.95, Math.max(minQuality, Number(quality) || 0.75));
  for (let attempt = 0; attempt < 12; attempt++) {
    const blob = await canvasToBlob(target, type, q);
    // A browser that cannot encode the requested type silently returns PNG.
    if (blob.type !== type && type !== 'image/jpeg') {
      type = 'image/jpeg';
      continue;
    }
    const base64 = arrayBufferToBase64(await blob.arrayBuffer());
    if (base64.length <= maxBase64Chars || q <= minQuality) {
      return { dataUrl: `data:${blob.type || type};base64,${base64}`, mimeType: blob.type || type, bytes: blob.size, width: w, height: h, quality: q };
    }
    q = Math.max(minQuality, Math.round((q - 0.1) * 100) / 100);
  }
  throw new Error('Could not encode the screenshot within the size limit.');
}

/** Copy a region of a canvas's pixels (for zoom diffs and tests). */
export function readCanvasPixels(canvas) {
  return context2d(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
}
