import { linkifyPlainUrls, markdownImageRanges } from './markdown-link.js';

const ICON_SERVICE = 'https://icons.duckduckgo.com/ip3/';
const MAX_ICON_BYTES = 64 * 1024;
const RASTER_TYPES = new Set(['image/x-icon', 'image/vnd.microsoft.icon', 'image/ico', 'image/icon', 'image/png', 'image/jpeg', 'image/webp']);
const CHAT_TEXT_SELECTOR = '.message-text, .slash-command-text';
const LINKIFY_SKIP_SELECTOR = 'a, pre, code, style, script, button, textarea, [data-no-favicon]';
const LOCAL_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'test', 'invalid', 'example', 'onion', 'arpa'];

function publicHostname(href, baseURI) {
  try {
    const url = new URL(href, baseURI);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (hostname.length > 253 || !hostname.includes('.') || /[:\[\]]/.test(hostname)
      || /^[\d.]+$/.test(hostname) || LOCAL_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))) return '';
    const labels = hostname.split('.');
    if (!labels.every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))
      || !/^(?:[a-z]{2,63}|xn--[a-z\d-]+)$/.test(labels.at(-1))) return '';
    return hostname;
  } catch { return ''; }
}

// The type the bytes really have, or '' when they do not match the declared
// one. Many sites serve a PNG as favicon.ico, so an icon type accepts PNG too.
function rasterType(bytes, mime) {
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mime === 'image/png') return png ? mime : '';
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? mime : '';
  if (mime === 'image/webp') return String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' ? mime : '';
  if (png) return 'image/png';
  return bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 ? mime : '';
}

async function readIcon(response) {
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error('Favicon unavailable');
  }
  const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const size = Number(response.headers.get('content-length'));
  if (!RASTER_TYPES.has(mime) || size > MAX_ICON_BYTES || !response.body?.getReader) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error('Unsupported favicon');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ICON_BYTES) throw new Error('Favicon too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const type = rasterType(bytes, mime);
  if (!type) throw new Error('Invalid favicon');
  return new Blob([bytes], { type });
}

// A link whose favicon cannot load shows no icon and gives back its space.
function hideIcon(link) {
  link.classList.remove('chat-link-icon-ready');
  link.classList.add('chat-link-no-icon');
}

/**
 * Decorate chat links without allowing model text to choose an image URL.
 * Only a public hostname reaches the fixed favicon service; paths, queries,
 * fragments, cookies and referrers are never sent. A failed icon shows nothing.
 * The returned function releases observers, requests and local image URLs.
 */
export function installChatLinkIcons(root, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  maxDomains = 64,
  concurrency = 4,
  observerImpl = root?.ownerDocument?.defaultView?.MutationObserver ?? globalThis.MutationObserver,
  intersectionObserverImpl = root?.ownerDocument?.defaultView?.IntersectionObserver ?? globalThis.IntersectionObserver,
} = {}) {
  if (!root?.querySelectorAll) return () => {};
  const document = root.ownerDocument;
  const cacheLimit = Math.min(64, Math.max(1, Math.floor(Number(maxDomains) || 64)));
  const workerLimit = Math.min(4, Math.max(1, Math.floor(Number(concurrency) || 4)));
  const deadline = Math.min(10000, Math.max(1, Number(timeoutMs) || 5000));
  const entries = new Map();
  const decorated = new WeakMap();
  const inspectedText = new WeakMap();
  const queue = [];
  const controllers = new Set();
  const objectUrls = new Set();
  const added = new Set();
  let disposed = false;
  let scheduled = false;
  let running = 0;

  function stillCurrent(image, entry) {
    const link = image.parentElement;
    return !disposed && root.contains(image) && decorated.get(link)?.image === image
      && decorated.get(link)?.hostname === entry.hostname;
  }

  function applyImage(image, entry) {
    if (!entry.url || !stillCurrent(image, entry)) return;
    image.onload = () => {
      if (stillCurrent(image, entry)) image.parentElement.classList.add('chat-link-icon-ready');
    };
    image.onerror = () => {
      if (stillCurrent(image, entry)) hideIcon(image.parentElement);
      image.removeAttribute('src');
    };
    image.src = entry.url;
  }

  async function load(entry) {
    const controller = new AbortController();
    controllers.add(controller);
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('Favicon request cancelled')), { once: true });
        timer = setTimeout(() => controller.abort(), deadline);
      });
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new Error('Favicon request cancelled');
          return fetchImpl(`${ICON_SERVICE}${encodeURIComponent(entry.hostname)}.ico`, {
            credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal,
          });
        }).then(readIcon),
        timeout,
      ]);
      if (disposed) return;
      entry.url = URL.createObjectURL(result);
      objectUrls.add(entry.url);
      entry.status = 'ready';
      for (const image of entry.images) applyImage(image, entry);
    } catch {
      entry.status = 'failed';
      for (const image of entry.images) if (stillCurrent(image, entry)) hideIcon(image.parentElement);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      entry.images.clear();
      running--;
      pump();
    }
  }

  function pump() {
    while (!disposed && running < workerLimit && queue.length) {
      const entry = queue.shift();
      running++;
      entry.status = 'loading';
      void load(entry);
    }
  }

  function requestIcon(link) {
    const state = decorated.get(link);
    if (disposed || !state?.image || !root.contains(link)) return;
    let entry = entries.get(state.hostname);
    if (!entry) {
      // A hard per-panel bound prevents long chats or streamed replacements
      // from causing unbounded lookups or an eviction/re-fetch loop.
      if (entries.size >= cacheLimit || typeof fetchImpl !== 'function') { hideIcon(link); return; }
      entry = { hostname: state.hostname, status: 'queued', url: '', images: new Set() };
      entries.set(state.hostname, entry);
      queue.push(entry);
    }
    if (entry.status === 'ready') applyImage(state.image, entry);
    else if (entry.status === 'failed') hideIcon(link);
    else {
      for (const image of entry.images) if (!stillCurrent(image, entry)) entry.images.delete(image);
      entry.images.add(state.image);
    }
    pump();
  }

  const visibility = typeof intersectionObserverImpl === 'function' ? new intersectionObserverImpl(records => {
    for (const record of records) if (record.isIntersecting) {
      visibility.unobserve(record.target);
      requestIcon(record.target);
    }
  }) : null;

  function precedingChatText(node) {
    const parent = node.nodeType === 1 ? node : node.parentElement;
    const message = parent?.closest(CHAT_TEXT_SELECTOR);
    if (!message || message === node) return '';
    const walker = document.createTreeWalker(message, 5, {
      acceptNode: child => child.nodeType === 1
        ? (child.matches('pre, code, style, script, button, textarea') ? 2 : 1) : 1,
    });
    let text = '';
    while (walker.nextNode() && walker.currentNode !== node) {
      if (walker.currentNode.nodeType === 3) text += walker.currentNode.textContent;
    }
    return text;
  }

  function decorate(link) {
    if (!root.contains(link)) return;
    const href = link.getAttribute('href');
    // Older saved HTML can contain !<a>, or an auto-link inside unfinished image
    // syntax. Include earlier inline siblings so formatting cannot hide it.
    if (!link.hasAttribute('data-no-favicon')) {
      const prefix = precedingChatText(link);
      if (prefix.endsWith('!') || markdownImageRanges(prefix + link.textContent)
        .some(([start, end]) => start < prefix.length && end > prefix.length)) {
        link.setAttribute('data-no-favicon', 'true');
      }
    }
    if (href !== null) {
      link.target = '_blank';
      const rel = new Set(String(link.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
      rel.add('noopener'); rel.add('noreferrer');
      link.setAttribute('rel', [...rel].join(' '));
    }
    const hostname = href !== null && !link.hasAttribute('download') && !link.closest('pre, code, [data-no-favicon]')
      ? publicHostname(href, document.baseURI) : '';
    const previous = decorated.get(link);
    if (previous?.hostname === hostname && previous?.href === href) return;
    visibility?.unobserve(link);
    if (previous?.image) entries.get(previous.hostname)?.images.delete(previous.image);
    previous?.image?.remove();
    // Restored chat HTML may contain an object URL from a closed panel.
    for (const image of link.querySelectorAll('.chat-link-icon')) image.remove();
    link.classList.remove('chat-link-icon-ready', 'chat-link-no-icon');
    link.classList.toggle('chat-link', Boolean(hostname));
    const state = { href, hostname, image: null };
    decorated.set(link, state);
    if (!hostname) return;
    const image = document.createElement('img');
    image.className = 'chat-link-icon';
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    image.width = 14; image.height = 14;
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    state.image = image;
    link.prepend(image);
    if (visibility) visibility.observe(link);
    else requestIcon(link);
  }

  function linkifyTextNode(node) {
    const parent = node.parentElement;
    if (!parent?.closest(CHAT_TEXT_SELECTOR) || parent.closest(LINKIFY_SKIP_SELECTOR)) return;
    const text = node.textContent;
    if (inspectedText.get(node) === text) return;
    inspectedText.set(node, text);
    if (!/https?:\/\//i.test(text)) return;
    const escaped = text.replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
    const html = linkifyPlainUrls(escaped, precedingChatText(node));
    if (!html.includes('<a ')) return;
    const template = document.createElement('template');
    template.innerHTML = html;
    const links = [...template.content.querySelectorAll('a')];
    node.replaceWith(template.content);
    for (const link of links) decorate(link);
  }

  function scan(node) {
    if (node.nodeType === 3) { linkifyTextNode(node); return; }
    if (node.nodeType !== 1) return;
    if (node.matches('a')) decorate(node);
    for (const link of node.querySelectorAll('a[href]')) decorate(link);
    // Saved chat HTML predates the formatter change. Upgrade only the newly
    // restored subtree, never code or existing links, without rerendering it.
    const walker = document.createTreeWalker(node, 5, {
      acceptNode: child => child.nodeType === 1 ? (child.matches(LINKIFY_SKIP_SELECTOR) ? 2 : 3) : 1,
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const text of textNodes) linkifyTextNode(text);
  }

  function detach(node) {
    if (node.nodeType !== 1 || root.contains(node)) return;
    const links = [...(node.matches('a') ? [node] : []), ...node.querySelectorAll('a')];
    for (const link of links) {
      visibility?.unobserve(link);
      const state = decorated.get(link);
      if (state?.image) entries.get(state.hostname)?.images.delete(state.image);
      decorated.delete(link);
    }
  }

  const observer = typeof observerImpl === 'function' ? new observerImpl(records => {
    for (const record of records) {
      if (record.type === 'attributes' || record.type === 'characterData') added.add(record.target);
      else {
        for (const node of record.removedNodes) detach(node);
        for (const node of record.addedNodes) if (node.nodeType === 1 || node.nodeType === 3) added.add(node);
      }
    }
    if (scheduled || !added.size) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed) return;
      const nodes = new Set(added); added.clear();
      for (const node of nodes) {
        if (!root.contains(node)) continue;
        let parent = node.parentNode;
        while (parent && !nodes.has(parent)) parent = parent.parentNode;
        if (!parent) scan(node);
      }
    });
  }) : null;
  scan(root);
  observer?.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['href', 'data-no-favicon', 'download'] });

  return () => {
    disposed = true;
    observer?.disconnect(); visibility?.disconnect();
    added.clear(); queue.length = 0;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear(); entries.clear();
  };
}
