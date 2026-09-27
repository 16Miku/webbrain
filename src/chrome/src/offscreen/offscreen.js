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
  if (msg?.bodyType) {
    throw new Error(`offscreen proxy received unsupported buffered body type: ${msg.bodyType}`);
  }
  return msg?.body || undefined;
}

const fetchProxyFormDataStartupCleanup = (async () => {
  try {
    const storageRoot = await navigator.storage.getDirectory();
    const dir = await storageRoot.getDirectoryHandle('fetch-proxy-form-data', { create: true });
    for await (const filename of dir.keys()) {
      try { await dir.removeEntry(filename); } catch {}
    }
    return dir;
  } catch {
    return null;
  }
})();

function fetchProxyBase64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function createFetchProxyFormDataState(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('offscreen proxy received invalid FormData entries');
  }
  const dir = await fetchProxyFormDataStartupCleanup;
  if (!dir) throw new Error('offscreen proxy could not open FormData staging storage');
  const token = crypto.randomUUID();
  const blobFiles = new Map();
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const staged of blobFiles.values()) {
      if (!staged.closed) {
        try { await staged.writable.abort(); } catch {}
      }
      try { await dir.removeEntry(staged.stagedFilename); } catch {}
    }
  };

  try {
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex];
      if (!entry || typeof entry.name !== 'string') {
        throw new Error('offscreen proxy received an invalid FormData field');
      }
      if (entry.kind === 'text') continue;
      if (entry.kind !== 'blob') {
        throw new Error(`offscreen proxy received an unsupported FormData field: ${entry.name}`);
      }
      const stagedFilename = `${token}-${entryIndex}.part`;
      const handle = await dir.getFileHandle(stagedFilename, { create: true });
      const writable = await handle.createWritable();
      blobFiles.set(entryIndex, { handle, writable, stagedFilename, closed: false });
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    async write(entryIndex, value) {
      const staged = blobFiles.get(entryIndex);
      if (!staged || staged.closed || typeof value !== 'string') {
        throw new Error(`offscreen proxy received an invalid FormData chunk for entry ${entryIndex}`);
      }
      await staged.writable.write(fetchProxyBase64Bytes(value));
    },
    async finish() {
      for (const staged of blobFiles.values()) {
        await staged.writable.close();
        staged.closed = true;
      }
      const form = new FormData();
      for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
        const entry = entries[entryIndex];
        if (entry.kind === 'text') {
          form.append(entry.name, String(entry.value ?? ''));
          continue;
        }
        const staged = blobFiles.get(entryIndex);
        const file = await staged.handle.getFile();
        const blob = new Blob([file], {
          type: typeof entry.type === 'string' && entry.type
            ? entry.type
            : 'application/octet-stream',
        });
        form.append(entry.name, blob, typeof entry.filename === 'string' && entry.filename
          ? entry.filename
          : 'blob');
      }
      return form;
    },
    cleanup,
  };
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
  let formDataState = null;
  let pendingRequest = null;
  let requestRunning = false;
  let fetchController = null;
  const cleanupFormData = async () => {
    const state = formDataState;
    formDataState = null;
    pendingRequest = null;
    if (state) await state.cleanup();
  };
  const post = (m) => { try { port.postMessage(m); } catch {} };
  const relayFetch = async (msg, body) => {
    requestRunning = true;
    fetchController = new AbortController();
    try {
      const res = await fetch(msg.url, {
        method: msg.method || 'POST',
        headers: msg.headers || {},
        body,
        signal: fetchController.signal,
      });
      await cleanupFormData();
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
      await cleanupFormData();
      post({ type: 'error', error: e?.message || String(e) });
    } finally {
      fetchController = null;
    }
  };

  port.onMessage.addListener(async (msg) => {
    try {
      if (msg?.type === 'form-data-chunk') {
        if (!formDataState || requestRunning) {
          throw new Error('offscreen proxy received a FormData chunk without an active upload');
        }
        await formDataState.write(msg.entryIndex, msg.value);
        post({
          type: 'form-data-chunk-ack',
          entryIndex: msg.entryIndex,
          sequence: msg.sequence,
        });
        return;
      }
      if (msg?.type === 'form-data-complete') {
        if (!formDataState || !pendingRequest || requestRunning) {
          throw new Error('offscreen proxy received FormData completion without an active upload');
        }
        const request = pendingRequest;
        const body = await formDataState.finish();
        await relayFetch(request, body);
        return;
      }
      if (!msg?.url || requestRunning || pendingRequest) return;
      if (msg.bodyType === 'form-data-chunked') {
        pendingRequest = msg;
        formDataState = await createFetchProxyFormDataState(msg.formDataEntries);
        post({ type: 'form-data-ready' });
        return;
      }
      await relayFetch(msg, requestBodyFromMessage(msg));
    } catch (e) {
      await cleanupFormData();
      post({ type: 'error', error: e?.message || String(e) });
    }
  });
  port.onDisconnect?.addListener(() => {
    try { fetchController?.abort(); } catch {}
    cleanupFormData().catch(() => {});
  });
});
