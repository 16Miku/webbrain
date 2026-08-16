import { sanitizeWikipediaSvg } from './wikipedia-article-renderer.js';

const IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
]);

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function emptySession() {
  return {
    active: 0,
    cancelled: false,
    observer: null,
    objectUrls: new Set(),
    queue: [],
    queued: new WeakSet(),
    totalBytes: 0,
    urlPromises: new Map(),
  };
}

export function createWikipediaImageLoader(options = {}) {
  if (typeof options.readImage !== 'function') throw new Error('A local Wikipedia image reader is required.');
  const runtime = options.runtime || globalThis;
  const BlobClass = options.BlobClass || runtime.Blob;
  const URLApi = options.URLApi || runtime.URL;
  const Observer = options.IntersectionObserverClass === undefined
    ? runtime.IntersectionObserver
    : options.IntersectionObserverClass;
  if (typeof BlobClass !== 'function' || typeof URLApi?.createObjectURL !== 'function' || typeof URLApi?.revokeObjectURL !== 'function') {
    throw new Error('This browser cannot display local archive images.');
  }
  const concurrency = Math.floor(boundedNumber(options.concurrency, 3, 1, 6));
  const maxBytes = Math.floor(boundedNumber(options.maxBytes, 12 * 1024 * 1024, 1, 32 * 1024 * 1024));
  const maxTotalBytes = Math.floor(boundedNumber(options.maxTotalBytes, 48 * 1024 * 1024, maxBytes, 128 * 1024 * 1024));
  const loadTimeoutMs = Math.floor(boundedNumber(options.loadTimeoutMs, 15_000, 1_000, 30_000));
  const sanitizeSvg = options.sanitizeSvg || sanitizeWikipediaSvg;
  let current = emptySession();

  function failSlot(slot) {
    slot.dataset.state = 'failed';
    slot.setAttribute('aria-busy', 'false');
    slot.hidden = true;
  }

  function assetUrl(path, session, document) {
    if (session.urlPromises.has(path)) return session.urlPromises.get(path);
    const pending = (async () => {
      const asset = await options.readImage(path, { maxBytes });
      if (session.cancelled) return '';
      const mimeType = String(asset?.mimeType || '').split(';', 1)[0].trim().toLowerCase();
      const bytes = asset?.bytes;
      const byteLength = Number(asset?.byteLength ?? bytes?.byteLength);
      if (!IMAGE_MIME_TYPES.has(mimeType) || !bytes || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > maxBytes) {
        throw new Error('Unsupported local archive image.');
      }
      let blobParts = [bytes];
      let blobType = mimeType;
      if (mimeType === 'image/svg+xml') {
        const Decoder = options.TextDecoderClass || runtime.TextDecoder || globalThis.TextDecoder;
        if (typeof Decoder !== 'function') throw new Error('This browser cannot decode the Wikipedia vector image.');
        const safeSvg = sanitizeSvg(new Decoder().decode(bytes), document, { maxSourceChars: maxBytes });
        if (!safeSvg) throw new Error('The Wikipedia vector image has no safe content.');
        blobParts = [safeSvg];
        blobType = 'image/svg+xml;charset=utf-8';
      }
      if (session.totalBytes + byteLength > maxTotalBytes) throw new Error('Article image memory limit reached.');
      session.totalBytes += byteLength;
      const url = URLApi.createObjectURL(new BlobClass(blobParts, { type: blobType }));
      if (session.cancelled) {
        URLApi.revokeObjectURL(url);
        return '';
      }
      session.objectUrls.add(url);
      return url;
    })();
    session.urlPromises.set(path, pending);
    return pending;
  }

  async function loadSlot(slot, session) {
    if (session.cancelled || !slot?.isConnected) return;
    const image = slot.querySelector('img');
    const path = String(slot.dataset.wikipediaImagePath || '');
    if (!image || !path) return failSlot(slot);
    slot.dataset.state = 'loading';
    try {
      const url = await assetUrl(path, session, image.ownerDocument);
      if (!url || session.cancelled || !slot.isConnected) return;
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          runtime.clearTimeout(timeout);
          image.removeEventListener?.('load', loaded);
          image.removeEventListener?.('error', failed);
          callback(value);
        };
        const loaded = () => finish(resolve);
        const failed = error => finish(reject, error);
        const timeout = runtime.setTimeout(() => finish(reject, new Error('Local archive image did not decode.')), loadTimeoutMs);
        image.addEventListener('load', loaded, { once: true });
        image.addEventListener('error', failed, { once: true });
        image.src = url;
      });
      if (session.cancelled || !slot.isConnected) return;
      // Width/height from the archived HTML only reserves space while the
      // image is pending. Keeping that ratio on a full-width slot can turn a
      // tiny icon into a page-wide empty square after the real asset loads.
      slot.style.removeProperty('aspect-ratio');
      image.hidden = false;
      slot.querySelector('.wiki-image-placeholder')?.remove();
      slot.dataset.state = 'loaded';
      slot.setAttribute('aria-busy', 'false');
    } catch {
      if (!session.cancelled) failSlot(slot);
    }
  }

  function pump(session) {
    if (session.cancelled) return;
    while (session.active < concurrency && session.queue.length) {
      const slot = session.queue.shift();
      session.active += 1;
      void loadSlot(slot, session).finally(() => {
        session.active -= 1;
        pump(session);
      });
    }
  }

  function enqueue(slot, session) {
    if (session.cancelled || session.queued.has(slot)) return;
    session.queued.add(slot);
    session.queue.push(slot);
    pump(session);
  }

  function clear() {
    const session = current;
    session.cancelled = true;
    session.observer?.disconnect();
    session.queue.length = 0;
    for (const url of session.objectUrls) URLApi.revokeObjectURL(url);
    session.objectUrls.clear();
    current = emptySession();
  }

  function start(container) {
    clear();
    const session = current;
    const slots = Array.from(container?.querySelectorAll?.('[data-wikipedia-image-path]') || []);
    if (!slots.length) return 0;
    if (typeof Observer === 'function') {
      session.observer = new Observer((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          session.observer?.unobserve(entry.target);
          enqueue(entry.target, session);
        }
      }, { rootMargin: '600px 0px' });
      slots.forEach(slot => session.observer.observe(slot));
    } else {
      slots.forEach(slot => enqueue(slot, session));
    }
    return slots.length;
  }

  return { clear, start };
}
