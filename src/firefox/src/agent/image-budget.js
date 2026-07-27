// Browser-free image sizing shared by Agent and the unit suite. This file is
// mirrored in the Firefox tree; keep both copies byte-identical.

// These defaults match Claude for Chrome. Pixel dimensions and approximate
// vision-token area bound provider cost, while the byte/quality fields are
// consumed by each browser's platform-specific image encoder. Frozen so an
// accidental mutation of the shared default throws instead of silently
// changing every caller; per-capture overrides spread into a fresh object.
export const IMAGE_BUDGET = Object.freeze({
  pxPerToken: 28,
  maxTargetPx: 1568,
  maxTargetTokens: 1568,
  maxBase64Chars: 1398100,
  initialJpegQuality: 0.75,
  minJpegQuality: 0.10,
  jpegQualityStep: 0.05,
});

export function estimateImageTokens(w, h, pxPerToken) {
  return Math.ceil((w / pxPerToken) * (h / pxPerToken));
}

// Return the largest dimensions no greater than the original that fit both
// the per-side and token-area caps while preserving the aspect ratio.
export function fitImageDimensions(origW, origH, budget = IMAGE_BUDGET) {
  const { pxPerToken, maxTargetPx, maxTargetTokens } = budget;
  if (origW <= maxTargetPx && origH <= maxTargetPx
      && estimateImageTokens(origW, origH, pxPerToken) <= maxTargetTokens) {
    return [origW, origH];
  }
  if (origH > origW) {
    const [h, w] = fitImageDimensions(origH, origW, budget);
    return [w, h];
  }
  const aspect = origW / origH;
  let hi = origW;
  let lo = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (lo + 1 >= hi) {
      return [lo, Math.max(Math.round(lo / aspect), 1)];
    }
    const mid = Math.floor((lo + hi) / 2);
    const midH = Math.max(Math.round(mid / aspect), 1);
    if (mid <= maxTargetPx
        && estimateImageTokens(mid, midH, pxPerToken) <= maxTargetTokens) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
}
