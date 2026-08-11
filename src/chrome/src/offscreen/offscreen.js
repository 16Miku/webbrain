/**
 * Offscreen document — fetch proxy for local network LLM servers.
 *
 * Chrome MV3 service workers can't always reach HTTP servers on the local
 * network (Private Network Access + CORS restrictions). This offscreen
 * document receives fetch requests from the service worker, makes them
 * from a regular page context (which has different networking rules),
 * and sends the response back.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'offscreen-fetch') return false;

  (async () => {
    try {
      const res = await fetch(msg.url, {
        method: msg.method || 'POST',
        headers: msg.headers || {},
        body: requestBodyFromMessage(msg),
      });

      const text = await res.text();
      sendResponse({
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        body: text,
      });
    } catch (e) {
      sendResponse({
        ok: false,
        status: 0,
        error: e.message,
      });
    }
  })();

  return true; // keep sendResponse channel open for async
});

function requestBodyFromMessage(msg) {
  if (msg?.bodyType !== 'form-data') return msg?.body || undefined;
  if (!Array.isArray(msg.formDataEntries)) {
    throw new Error('offscreen proxy received invalid FormData entries');
  }
  const form = new FormData();
  for (const entry of msg.formDataEntries) {
    if (!entry || typeof entry.name !== 'string') {
      throw new Error('offscreen proxy received an invalid FormData field');
    }
    if (entry.kind === 'text') {
      form.append(entry.name, String(entry.value ?? ''));
      continue;
    }
    if (entry.kind !== 'blob' || typeof entry.value !== 'string') {
      throw new Error(`offscreen proxy received an unsupported FormData field: ${entry.name}`);
    }
    const binary = atob(entry.value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], {
      type: typeof entry.type === 'string' && entry.type
        ? entry.type
        : 'application/octet-stream',
    });
    form.append(entry.name, blob, typeof entry.filename === 'string' && entry.filename
      ? entry.filename
      : 'blob');
  }
  return form;
}

// Streaming variant of the fetch proxy, over a long-lived port. The
// buffered onMessage path above can only respond after the ENTIRE body
// has been consumed, so any caller-side timeout covers time-to-last-byte
// and streamed LLM responses arrive in one burst. Over a port we report
// headers first — the caller's stall timeout then only covers the
// connection phase, exactly like a direct fetch — and relay body chunks
// as they arrive so SSE streams stay incremental and unbounded in length.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen-fetch-stream') return;
  port.onMessage.addListener(async (msg) => {
    if (!msg?.url) return;
    const post = (m) => { try { port.postMessage(m); } catch {} };
    try {
      const res = await fetch(msg.url, {
        method: msg.method || 'POST',
        headers: msg.headers || {},
        body: requestBodyFromMessage(msg),
      });
      post({
        type: 'headers',
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        hasBody: !!res.body,
      });
      // HEAD and null-body statuses (204/205/304) legitimately expose no
      // ReadableStream. Headers are the complete response in that case.
      if (!res.body) {
        post({ type: 'done' });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        post({ type: 'chunk', text: decoder.decode(value, { stream: true }) });
      }
      const tail = decoder.decode();
      if (tail) post({ type: 'chunk', text: tail });
      post({ type: 'done' });
    } catch (e) {
      post({ type: 'error', error: e?.message || String(e) });
    }
  });
});
