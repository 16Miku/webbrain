// Authenticated downloads use manual requests, then a local disk-backed URL.
// Browser downloads must never receive the remote URL: that API follows
// redirects outside the extension's request interception facilities.
const MAX_HOPS = 8;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const STALE_JOB_MS = 60 * 1000;
const redirectStatus = status => [301, 302, 303, 307, 308].includes(status);
const cleanUrl = value => { const url = new URL(value); url.hash = ''; return url.href; };
const stopped = signal => { if (signal?.aborted) throw new Error('Download stopped.'); };

// Only response Location is kept. A URL match alone is never sufficient:
// request ID, initiating extension and the exact extension document must agree.
function captureRequest(api, url, context) {
  let requestId = null, ambiguous = false, response = null;
  const identity = d => d?.url === url && d.method === 'GET'
    && d.type === 'xmlhttprequest'
    && (context.documentId
      ? d.documentId === context.documentId && d.initiator === context.origin
      : context.isCurrent() && d.documentUrl === context.documentUrl
        && d.originUrl === context.documentUrl);
  const before = d => {
    if (!identity(d) || typeof d.requestId !== 'string') return;
    if (requestId !== null && requestId !== d.requestId) ambiguous = true;
    requestId = d.requestId;
  };
  const headers = d => {
    if (!identity(d) || d.requestId !== requestId || response) { if (identity(d)) ambiguous = true; return; }
    const locations = (d.responseHeaders || []).filter(h => h.name?.toLowerCase() === 'location');
    response = { status: d.statusCode, location: locations.length === 1 && typeof locations[0].value === 'string'
      && locations[0].value.length <= 16384 ? locations[0].value : null };
  };
  api.webRequest.onBeforeRequest.addListener(before, { urls: ['<all_urls>'] });
  try { api.webRequest.onHeadersReceived.addListener(headers, { urls: ['<all_urls>'] }, ['responseHeaders']); }
  catch (error) { api.webRequest.onBeforeRequest.removeListener(before); throw error; }
  return {
    location() {
      if (ambiguous || requestId === null || !response || !redirectStatus(response.status) || !response.location
          || !context.isCurrent()) throw new Error('Redirect destination could not be bound to this download request.');
      return cleanUrl(new URL(response.location, url).href);
    },
    close() { api.webRequest.onBeforeRequest.removeListener(before); api.webRequest.onHeadersReceived.removeListener(headers); },
  };
}

export async function prepareAuthenticatedDownload(url, { api, transport, context, validateUrl, signal }) {
  const origin = new URL(url).origin;
  let current = cleanUrl(url);
  const deadline = Date.now() + MAX_LIFETIME_MS;
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      stopped(signal);
      const check = validateUrl(current);
      if (!check.ok) return { success: false, blocked: true, error: check.error };
      if (!context.isCurrent()) throw new Error('Download extension document changed.');
      const capture = captureRequest(api, current, context);
      const jobId = crypto.randomUUID();
      let keepStage = false;
      const cancel = () => { void transport.cancel(jobId).catch(() => {}); };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        stopped(signal);
        const start = await transport.start(jobId, current);
        if (!start?.success) throw new Error(start?.error || 'Download staging did not start.');
        let result;
        do {
          stopped(signal);
          if (Date.now() >= deadline) throw new Error('Download exceeded the 24-hour staging lifetime.');
          result = await transport.status(jobId);
          if (result?.pending) await new Promise(resolve => setTimeout(resolve, 250));
        } while (result?.pending);
        stopped(signal);
        if (result?.redirect) {
          const destination = capture.location();
          const next = validateUrl(destination);
          if (!next.ok) return { success: false, blocked: true, error: next.error };
          if (new URL(destination).origin !== origin) return { success: false, redirectRequiresPermission: true,
            redirectUrl: destination, error: 'The download redirects to another origin. Use download_files with the redirectUrl for a fresh permission decision.' };
          current = destination;
          continue;
        }
        if (!result?.success) throw new Error(result?.error || 'Download staging failed.');
        if (result.finalUrl !== current || !context.isCurrent()) throw new Error('Download response did not match its requested URL.');
        keepStage = true;
        return { ...result, sourceUrl: url };
      } finally {
        signal?.removeEventListener('abort', cancel);
        capture.close();
        if (keepStage) await transport.forget(jobId);
        else await transport.cancel(jobId).catch(() => {});
      }
    }
    return { success: false, blocked: true, error: `Download exceeded ${MAX_HOPS} validated redirect hops.` };
  } catch (error) { return { success: false, cancelled: !!signal?.aborted, error: String(error?.message || error) }; }
}

// Both generic transports use the same streaming OPFS store. The separate
// skill transport and its existing 1-GiB limit remain unchanged.
export function createAuthenticatedDownloadJobs(stageResponse, release) {
  const jobs = new Map();
  const cancel = async id => {
    const job = jobs.get(id); if (!job) return;
    job.controller.abort(); clearInterval(job.timer); clearTimeout(job.lifetime);
    jobs.delete(id);
    if (job.result?.releaseToken) await release(job.result.releaseToken);
  };
  return {
    async start(id, url) {
      for (const [key, job] of jobs) if (Date.now() - job.seen > STALE_JOB_MS) await cancel(key);
      if (!/^[\da-f-]{36}$/i.test(id) || jobs.has(id) || jobs.size >= 8) return { success: false, error: 'Invalid or excessive download staging jobs.' };
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return { success: false, error: 'Invalid download URL.' };
      const job = { controller: new AbortController(), seen: Date.now(), pending: true, result: null };
      jobs.set(id, job);
      // A heartbeat polls short runtime messages during long transfers. Each
      // lost owner is cancelled; no multi-hour runtime response is held open.
      job.timer = setInterval(() => { if (Date.now() - job.seen > STALE_JOB_MS) void cancel(id); }, 10000);
      job.lifetime = setTimeout(() => { void cancel(id); }, MAX_LIFETIME_MS);
      (async () => {
        try {
          const response = await fetch(url, { method: 'GET', credentials: 'include', redirect: 'manual', cache: 'no-store', signal: job.controller.signal });
          if (response.type === 'opaqueredirect' || redirectStatus(response.status)) {
            await response.body?.cancel?.(); job.result = { success: false, redirect: true };
          } else {
            if (!response.ok || cleanUrl(response.url) !== url) throw new Error(`Download request failed or changed URL (HTTP ${response.status}).`);
            const stage = await stageResponse(response, Number.MAX_SAFE_INTEGER);
            job.result = { success: true, finalUrl: url, localUrl: stage.localUrl, releaseToken: stage.token,
              bytesReceived: stage.bytesReceived, contentType: stage.contentType, contentDisposition: stage.contentDisposition || '' };
            if (job.controller.signal.aborted || !jobs.has(id)) await release(stage.token);
          }
        } catch (error) {
          job.controller.abort();
          job.result = { success: false, error: String(error?.message || error) };
        } finally { job.pending = false; }
      })();
      return { success: true, pending: true };
    },
    async status(id) { const job = jobs.get(id); if (!job) return { success: false, error: 'Download staging job expired.' }; job.seen = Date.now(); return job.pending ? { pending: true } : job.result; },
    cancel,
    release,
    async forget(id) { const job = jobs.get(id); clearInterval(job?.timer); clearTimeout(job?.lifetime); jobs.delete(id); },
  };
}

export function createDiskDownloadStore() {
  const entries = new Map();
  let directory;
  const startup = (async () => {
    const root = await navigator.storage.getDirectory();
    directory = await root.getDirectoryHandle('authenticated-downloads', { create: true });
    for await (const name of directory.keys()) await directory.removeEntry(name);
  })();
  // Keep an unavailable OPFS capability as an explicit failure, never fall back
  // to buffering an arbitrarily large authenticated file in a Blob/ArrayBuffer.
  startup.catch(() => {});
  const release = async token => {
    const entry = entries.get(token); if (!entry) return;
    entries.delete(token); URL.revokeObjectURL(entry.localUrl);
    await directory.removeEntry(entry.filename).catch(() => {});
  };
  const stage = async response => {
    await startup;
    const token = crypto.randomUUID(), filename = `${token}.file`;
    let writable, reader, bytesReceived = 0;
    try {
      const handle = await directory.getFileHandle(filename, { create: true });
      writable = await handle.createWritable(); reader = response.body?.getReader?.();
      if (!reader) throw new Error('A streaming response body is required for authenticated downloads.');
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytesReceived += value.byteLength;
        if (!Number.isSafeInteger(bytesReceived)) throw new Error('Download byte count exceeded the supported safe range.');
        await writable.write(value);
      }
      await writable.close();
      const file = await handle.getFile();
      const contentType = String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
      const localUrl = URL.createObjectURL(file.type === contentType ? file : new Blob([file], { type: contentType }));
      entries.set(token, { localUrl, filename });
      return { token, localUrl, bytesReceived, contentType, contentDisposition: String(response.headers.get('content-disposition') || '').slice(0, 2048) };
    } catch (error) {
      await reader?.cancel?.().catch(() => {}); await writable?.abort?.().catch(() => {});
      await directory.removeEntry(filename).catch(() => {}); throw error;
    } finally { reader?.releaseLock?.(); }
  };
  return { stage, release };
}
