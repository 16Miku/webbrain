import { isValidUrl } from './isValidUrl.js';

/**
 * The one place a typed link is turned into something safe to save as an href.
 * A bare host gets https://; anything that is not a valid http(s) URL after that
 * (javascript:, data:, junk) is rejected with null. Used for adding AND editing,
 * so an edit cannot save what adding would have refused.
 */
export function normalizeLinkUrl(raw) {
  let url = String(raw ?? '').trim();
  if (!url) return null;
  const scheme = /^https?:\/\//i.exec(url);
  url = scheme ? scheme[0].toLowerCase() + url.slice(scheme[0].length) : `https://${url}`;
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) return null;
  } catch {
    return null;
  }
  return isValidUrl(url) ? url : null;
}
