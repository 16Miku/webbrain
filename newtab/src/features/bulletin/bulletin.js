/**
 * WebBrain bulletin under the task box.
 *
 * A short notice WebBrain can publish to every new tab without an extension update:
 * the page reads https://webbrain.one/newtab-comm.html, and while that file is empty
 * (as shipped) nothing is shown and nothing is reserved on the page. It follows the
 * Apocalypse Mode bulletin (src/{chrome,firefox}/src/ui/apocalypse-comm.js, which
 * reads apocalypse-comm.html): https only, the response must come from webbrain.one,
 * at most 128 KB, a 5 s deadline, no cookies, no referrer, and the markup is shown in a
 * sandboxed srcdoc frame that cannot run scripts. Unlike that page, a new tab opens
 * many times a day, so the answer is cached in extension storage and the file is asked
 * for at most once every BULLETIN_REFRESH_MS per browser. The request carries no
 * identifiers: no cookies, no referrer, no query string.
 */
export const BULLETIN_ORIGIN = 'https://webbrain.one';
export const BULLETIN_FILE = 'newtab-comm.html';
export const BULLETIN_PLACEHOLDER_FILE = 'newtab-comm-placeholder.html';
export const MAX_BULLETIN_BYTES = 128_000;
export const BULLETIN_FETCH_TIMEOUT_MS = 5_000;
export const BULLETIN_REFRESH_MS = 10 * 60_000;
export const BULLETIN_LEASE_MS = 10_000;
export const BULLETIN_LEASE_POLL_MS = 25;
export const BULLETIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";
// A bulletin the last successful check returned stays visible while the file cannot be
// reached (an emergency notice matters most when the network is failing), but not forever.
export const BULLETIN_STALE_LIMIT_MS = 24 * 60 * 60_000;
export const BULLETIN_CACHE_KEY = 'wbNewtabBulletin';
export const BULLETIN_DISMISSED_KEY = 'wbNewtabBulletinDismissed';
const ALLOWED_HOSTS = ['webbrain.one', 'www.webbrain.one'];
const PREVIEW_HOSTS = ['localhost', '127.0.0.1'];

// Same rule as apocalypse-comm.js: whitespace, a doctype and complete comments only
// count as empty, so the shipped empty file (or a commented-out notice) shows nothing.
function isEmptyMarkup(markup) {
  let cursor = 0;
  while (cursor < markup.length) {
    if (markup[cursor].trim() === '') {
      cursor++;
      continue;
    }
    if (markup.startsWith('<!--', cursor)) {
      const end = markup.indexOf('-->', cursor + 4);
      if (end < 0) return false;
      cursor = end + 3;
      continue;
    }
    if (markup.slice(cursor, cursor + 9).toLowerCase() === '<!doctype') {
      const end = markup.indexOf('>', cursor + 9);
      if (end < 0) return false;
      cursor = end + 1;
      continue;
    }
    return false;
  }
  return true;
}

export function isRenderableMarkup(markup) {
  return typeof markup === 'string' && markup.length <= MAX_BULLETIN_BYTES && !isEmptyMarkup(markup);
}

const isPreviewLocation = (location) =>
  /^https?:$/.test(location?.protocol || '') && PREVIEW_HOSTS.includes(location?.hostname || '');

/**
 * The published file, or for a preview (`?newtab-comm=placeholder`) the sample banner.
 * A page served from localhost (a dev preview of the web site) reads its own copy.
 */
export function bulletinUrl(location = globalThis.location) {
  const params = new URLSearchParams(location?.search || '');
  const placeholder = params.get('newtab-comm') === 'placeholder';
  const filename = placeholder ? BULLETIN_PLACEHOLDER_FILE : BULLETIN_FILE;
  return new URL(`/${filename}`, isPreviewLocation(location) ? location.origin : BULLETIN_ORIGIN);
}

export function isPreviewUrl(url, location = globalThis.location) {
  return url.pathname.endsWith(`/${BULLETIN_PLACEHOLDER_FILE}`) || isPreviewLocation(location);
}

// <base> keeps the bulletin's relative links on webbrain.one and opens them in a new tab.
// Restrictive CSP prevents external subresource loading or tracking by published notices.
export function bulletinDocument(markup, url) {
  const safeBase = String(url.href).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const head = `<base href="${safeBase}" target="_blank"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${BULLETIN_CSP}">`;
  if (/<head(?:\s[^>]*)?>/i.test(markup)) {
    return markup.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${head}`);
  }
  return `${head}${markup}`;
}

/** Stable id for "this bulletin was dismissed", so a different bulletin shows again. */
export function bulletinHash(markup) {
  // FNV-1a over UTF-16 code units, twice with different seeds: 64 bits are plenty to tell
  // two published notices apart, and it stays synchronous and dependency-free.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ markup.length;
  for (let i = 0; i < markup.length; i++) {
    const code = markup.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/**
 * Read the response body up to maxBytes, cancelling the stream early if it exceeds the limit.
 * Prevents memory exhaustion from missing/understated Content-Length or compressed payloads.
 */
export async function readBoundedText(response, maxBytes = MAX_BULLETIN_BYTES) {
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkSize = value ? (value.byteLength ?? value.length ?? 0) : 0;
        totalBytes += chunkSize;
        if (totalBytes > maxBytes) {
          try { await reader.cancel(); } catch {}
          return null;
        }
        if (value) {
          text += decoder.decode(value, { stream: true });
        }
      }
      text += decoder.decode();
      return text;
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  if (typeof response?.text === 'function') {
    const text = await response.text();
    if (typeof text !== 'string') return null;
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const byteLength = encoder ? encoder.encode(text).byteLength : text.length;
    if (byteLength > maxBytes) return null;
    return text;
  }

  return null;
}

/**
 * One request for the bulletin. Resolves { ok: true, url, markup } (markup '' when the
 * file is empty), or { ok: false } when it could not be read or failed a check.
 */
export async function fetchBulletin(url, { fetchImpl = globalThis.fetch, timeoutMs = BULLETIN_FETCH_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url.href, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller?.signal,
    });
    if (!response?.ok) return { ok: false };
    const responseUrl = new URL(response.url || url.href);
    const preview = PREVIEW_HOSTS.includes(url.hostname);
    const allowed = preview
      ? responseUrl.origin === url.origin
      : responseUrl.protocol === 'https:' && ALLOWED_HOSTS.includes(responseUrl.hostname);
    if (!allowed) return { ok: false };
    const declared = Number(response.headers?.get?.('content-length')) || 0;
    if (declared > MAX_BULLETIN_BYTES) return { ok: false };
    const text = await readBoundedText(response, MAX_BULLETIN_BYTES);
    if (typeof text !== 'string') return { ok: false };
    return { ok: true, url: responseUrl.href, markup: isRenderableMarkup(text) ? text : '' };
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Extension storage on either browser, or null in a plain preview page. */
export function bulletinStorage(env = globalThis) {
  const area = (typeof env.browser !== 'undefined' && env.browser?.storage?.local)
    || (typeof env.chrome !== 'undefined' && env.chrome?.storage?.local)
    || null;
  return area && typeof area.get === 'function' && typeof area.set === 'function' ? area : null;
}

const asCache = (value) => (value && typeof value === 'object'
  && Number.isFinite(value.checkedAt) && typeof value.markup === 'string' ? value : null);

async function waitForLease({
  storage,
  timeoutMs = BULLETIN_FETCH_TIMEOUT_MS + 1_000,
  now = () => Date.now(),
} = {}) {
  if (!storage || typeof storage.get !== 'function') return null;
  const start = now();
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / BULLETIN_LEASE_POLL_MS));
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, BULLETIN_LEASE_POLL_MS));
    let stored = {};
    try {
      stored = (await storage.get([BULLETIN_CACHE_KEY, BULLETIN_DISMISSED_KEY])) || {};
    } catch {
      return null;
    }
    const cache = asCache(stored[BULLETIN_CACHE_KEY]);
    const currentAt = now();
    const leaseActive = cache && Number.isFinite(cache.leaseUntil) && currentAt < cache.leaseUntil;
    if (cache && !leaseActive) {
      return { stored, cache };
    }
    if (currentAt - start >= timeoutMs) break;
  }
  return null;
}

/**
 * The bulletin to show now: { url, markup, hash } or null. Reads the cache first and asks
 * webbrain.one only when the last check is older than BULLETIN_REFRESH_MS. Coordinates
 * refreshes across new tabs using a storage lease so multiple tabs opening at once do not
 * dogpile requests or overwrite each other out of order. Never throws.
 */
export async function loadBulletin({
  storage = bulletinStorage(),
  fetchImpl = globalThis.fetch,
  location = globalThis.location,
  now = () => Date.now(),
} = {}) {
  try {
    const url = bulletinUrl(location);
    // Previews always read the file afresh and never touch what real new tabs cached.
    if (isPreviewUrl(url, location)) {
      const result = await fetchBulletin(url, { fetchImpl });
      return result.ok && result.markup
        ? { url: result.url, markup: result.markup, hash: bulletinHash(result.markup) }
        : null;
    }
    let stored = {};
    try {
      stored = (await storage?.get([BULLETIN_CACHE_KEY, BULLETIN_DISMISSED_KEY])) || {};
    } catch {
      stored = {};
    }
    let cache = asCache(stored[BULLETIN_CACHE_KEY]);
    let at = now();
    const hasActiveLease = (c) => Boolean(
      c && Number.isFinite(c.leaseUntil) && at < c.leaseUntil && at >= c.leaseUntil - BULLETIN_LEASE_MS
    );

    if (hasActiveLease(cache)) {
      // Another new-tab page holds an active lease to refresh. Wait for it to complete.
      const waited = await waitForLease({ storage, timeoutMs: BULLETIN_FETCH_TIMEOUT_MS + 1_000, now });
      if (waited) {
        stored = waited.stored;
        cache = waited.cache;
      }
      at = now();
    }

    if (!cache || at - cache.checkedAt >= BULLETIN_REFRESH_MS || at < cache.checkedAt) {
      // Need a refresh: acquire a cross-tab lease in storage to prevent dogpiling
      const leaseHolder = `${at}_${Math.random().toString(36).slice(2, 8)}`;
      const leaseUntil = at + BULLETIN_LEASE_MS;
      const leasingCache = {
        checkedAt: cache?.checkedAt ?? 0,
        fetchedAt: cache?.fetchedAt ?? 0,
        url: cache?.url ?? url.href,
        markup: cache?.markup ?? '',
        leaseUntil,
        leaseHolder,
      };

      let wonLease = true;
      if (storage) {
        try {
          await storage.set({ [BULLETIN_CACHE_KEY]: leasingCache });
          const verified = (await storage.get([BULLETIN_CACHE_KEY])) || {};
          const current = verified[BULLETIN_CACHE_KEY];
          if (current?.leaseHolder && current.leaseHolder !== leaseHolder) {
            wonLease = false;
          }
        } catch {
          // Fall back to direct fetch if storage write fails
        }
      }

      if (!wonLease) {
        const waited = await waitForLease({ storage, timeoutMs: BULLETIN_FETCH_TIMEOUT_MS + 1_000, now });
        if (waited) {
          stored = waited.stored;
          cache = waited.cache;
        }
      } else {
        let result = { ok: false };
        try {
          result = await fetchBulletin(url, { fetchImpl });
        } finally {
          const finishAt = now();
          let latestCache = null;
          try {
            const latestStored = (await storage?.get([BULLETIN_CACHE_KEY])) || {};
            latestCache = asCache(latestStored[BULLETIN_CACHE_KEY]);
          } catch {}

          const newer = latestCache && ((Number.isFinite(latestCache.checkedAt) && latestCache.checkedAt > at)
            || (Number.isFinite(latestCache.fetchedAt) && latestCache.fetchedAt > at))
            && latestCache.leaseHolder !== leaseHolder;
          if (newer) {
            cache = latestCache;
          } else if (result.ok) {
            cache = { checkedAt: finishAt, fetchedAt: finishAt, url: result.url, markup: result.markup };
            try {
              await storage?.set({ [BULLETIN_CACHE_KEY]: cache });
            } catch {}
          } else {
            // Keep the last bulletin a while, but wait a full interval before asking again.
            const keep = cache && Number.isFinite(cache.fetchedAt) && finishAt - cache.fetchedAt < BULLETIN_STALE_LIMIT_MS;
            cache = keep ? { ...cache, checkedAt: finishAt } : { checkedAt: finishAt, fetchedAt: 0, url: url.href, markup: '' };
            delete cache.leaseUntil;
            delete cache.leaseHolder;
            try {
              await storage?.set({ [BULLETIN_CACHE_KEY]: cache });
            } catch {}
          }
        }
      }
    }

    if (!cache?.markup || !isRenderableMarkup(cache.markup)) return null;
    const hash = bulletinHash(cache.markup);
    if (stored[BULLETIN_DISMISSED_KEY] === hash) return null;
    let bulletinUrlValue;
    try {
      bulletinUrlValue = new URL(cache.url);
    } catch {
      return null;
    }
    if (!(bulletinUrlValue.protocol === 'https:' && ALLOWED_HOSTS.includes(bulletinUrlValue.hostname))) return null;
    return { url: bulletinUrlValue.href, markup: cache.markup, hash };
  } catch {
    return null;
  }
}

/** Hide this bulletin on every new tab until a different one is published. */
export async function dismissBulletin(hash, storage = bulletinStorage()) {
  try {
    await storage?.set({ [BULLETIN_DISMISSED_KEY]: String(hash || '') });
  } catch {
    // The banner is already gone from this tab; the next tab may show it again.
  }
}
