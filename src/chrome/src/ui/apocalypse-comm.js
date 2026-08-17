const PRODUCTION_ORIGIN = 'https://webbrain.one';
const EMPTY_MARKUP = /^(?:\uFEFF|\s|<!--(?:.|\n|\r)*?-->|<!doctype[^>]*>)*$/i;
const MAX_COMM_BYTES = 128_000;
const FETCH_TIMEOUT_MS = 5_000;

function communicationUrl() {
  const params = new URLSearchParams(globalThis.location?.search || '');
  const placeholder = params.get('apocalypse-comm') === 'placeholder';
  const filename = placeholder ? 'apocalypse-comm-placeholder.html' : 'apocalypse-comm.html';
  const localPreview = /^https?:$/.test(globalThis.location?.protocol || '')
    && ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname || '');
  return new URL(`/${filename}`, localPreview ? globalThis.location.origin : PRODUCTION_ORIGIN);
}

function isRenderableMarkup(markup) {
  return typeof markup === 'string' && markup.length <= MAX_COMM_BYTES && !EMPTY_MARKUP.test(markup);
}

function insertionAnchor() {
  return document.querySelector('body > header, body > .header-row, body > nav, body > main');
}

function communicationDocument(markup, url) {
  const safeBase = String(url.href).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const head = `<base href="${safeBase}" target="_blank"><meta name="referrer" content="no-referrer">`;
  if (/<head(?:\s[^>]*)?>/i.test(markup)) {
    return markup.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${head}`);
  }
  return `${head}${markup}`;
}

function createSlot(url, markup) {
  const slot = document.createElement('aside');
  slot.className = 'apocalypse-comm-slot';
  slot.setAttribute('aria-label', 'WebBrain preparedness bulletin');

  const frame = document.createElement('iframe');
  frame.className = 'apocalypse-comm-frame';
  frame.title = 'WebBrain preparedness bulletin';
  frame.srcdoc = communicationDocument(markup, url);
  frame.loading = 'eager';
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'apocalypse-comm-dismiss';
  dismiss.textContent = '×';
  dismiss.title = 'Dismiss bulletin';
  dismiss.setAttribute('aria-label', 'Dismiss preparedness bulletin');
  dismiss.addEventListener('click', () => slot.remove());

  frame.addEventListener('load', () => { slot.dataset.loaded = 'true'; }, { once: true });
  slot.append(frame, dismiss);
  return slot;
}

async function loadCommunication() {
  if (document.querySelector('.apocalypse-comm-slot')) return;
  const anchor = insertionAnchor();
  if (!anchor) return;
  const url = communicationUrl();
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) return;
    const responseUrl = new URL(response.url || url.href);
    const localRequest = ['localhost', '127.0.0.1'].includes(url.hostname);
    const allowedResponse = localRequest
      ? responseUrl.origin === url.origin
      : responseUrl.protocol === 'https:' && ['webbrain.one', 'www.webbrain.one'].includes(responseUrl.hostname);
    if (!allowedResponse) return;
    const declaredSize = Number(response.headers.get('content-length')) || 0;
    if (declaredSize > MAX_COMM_BYTES) return;
    const markup = await response.text();
    if (!isRenderableMarkup(markup)) return;
    anchor.insertAdjacentElement('afterend', createSlot(responseUrl, markup));
  } catch {
    // The bulletin is optional and must never interfere with offline pages.
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

if (typeof document !== 'undefined') void loadCommunication();

export { communicationDocument, communicationUrl, isRenderableMarkup };
