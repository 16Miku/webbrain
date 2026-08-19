/**
 * Worker driver for the vendored Xapian/libzim WebAssembly runtime.
 *
 * The vendored `libzim-wasm.js` is itself a worker script: upstream bakes its
 * message protocol in through --pre-js/--post-js. It takes `{ action, ... }`
 * messages and replies on the MessagePort passed in `event.ports[0]`.
 *
 * Two properties of that module shape the driver. The archive is module-global
 * state set by a single `loadArchive` call, so each open archive gets its own
 * worker rather than sharing one. And there is no `hasFulltextIndex` binding,
 * while `search()` catches its own exceptions and returns an empty vector, so a
 * missing index is indistinguishable from a query that matched nothing. The
 * index check therefore comes from WebBrain's own ZIM reader, passed in here,
 * which also means an archive without an index never starts a worker at all.
 *
 * This file contains no GPL code. It drives one. See docs/offline-rag-licensing.md.
 */

export const ZIM_XAPIAN_WORKER_PATH = 'vendor/libzim/libzim-wasm.js';
const INITIALIZE_TIMEOUT_MS = 45_000;
const SEARCH_TIMEOUT_MS = 20_000;

function abortError(message) {
  return typeof DOMException === 'function'
    ? new DOMException(message, 'AbortError')
    : Object.assign(new Error(message), { name: 'AbortError' });
}

// Upstream replies once per request on a fresh MessagePort. Every path clears the
// timer and closes the port so a slow archive cannot leak ports or handlers.
function requestOnce(worker, message, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError('Offline full-text search was canceled.'));
      return;
    }
    const channel = new MessageChannel();
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.onmessage = null;
      try { channel.port1.close(); } catch { /* already closed */ }
      signal?.removeEventListener('abort', onAbort);
      settle(value);
    };
    const onAbort = () => finish(reject, abortError('Offline full-text search was canceled.'));
    const timer = setTimeout(
      () => finish(reject, new Error(`The offline search runtime did not answer within ${timeoutMs}ms.`)),
      timeoutMs,
    );
    channel.port1.onmessage = event => finish(resolve, event.data);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      worker.postMessage(message, [channel.port2]);
    } catch (error) {
      finish(reject, error);
    }
  });
}

// WORKERFS reads `.name` and slices the blob; it never copies the archive, which
// matters when the archive is tens of gigabytes.
function asNamedFile(source, record) {
  if (source && typeof source.name === 'string' && source.name) return source;
  const name = String(record?.filename || `${record?.id || 'archive'}.zim`).replace(/[/\\]/g, '_');
  if (typeof File === 'function') return new File([source], name);
  throw new Error('The installed archive could not be presented to the search runtime as a file.');
}

/**
 * @param options.createWorker  () => Worker for the vendored runtime.
 * @param options.hasFullTextIndex  (record) => Promise<boolean>, answered by WebBrain's reader.
 */
export function createZimXapianRuntime(options = {}) {
  const createWorker = options.createWorker;
  const probeFullTextIndex = options.hasFullTextIndex;
  if (typeof createWorker !== 'function') {
    throw new Error('The Xapian runtime needs a worker factory for the vendored module.');
  }

  return Object.freeze({
    async openArchive({ source, record }) {
      let indexPresent = true;
      if (typeof probeFullTextIndex === 'function') {
        indexPresent = await probeFullTextIndex(record) === true;
      }
      // Nothing to search: report it without paying to start the runtime.
      if (!indexPresent) {
        return Object.freeze({
          hasFullTextIndex: () => false,
          searchWithSnippets: () => [],
          close: () => {},
        });
      }

      const worker = createWorker();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try { worker.terminate(); } catch { /* already gone */ }
      };
      try {
        const file = asNamedFile(source, record);
        const ready = await requestOnce(
          worker,
          { action: 'init', files: [file], assemblerType: 'wasm' },
          INITIALIZE_TIMEOUT_MS,
        );
        if (typeof ready === 'string' && /error|invalid/i.test(ready)) {
          throw new Error(`The offline search runtime refused the archive: ${ready}`);
        }
      } catch (error) {
        close();
        throw error;
      }

      return Object.freeze({
        hasFullTextIndex: () => true,
        async searchWithSnippets(query, searchOptions = {}) {
          if (closed) throw new Error('The offline search session is already closed.');
          const numResults = Math.max(1, Math.min(50, Number(searchOptions.limit) || 10));
          const reply = await requestOnce(
            worker,
            { action: 'searchWithSnippets', text: String(query || ''), numResults },
            SEARCH_TIMEOUT_MS,
            searchOptions.signal,
          );
          if (reply?.error) throw new Error(`Offline full-text search failed: ${reply.error}`);
          return Array.isArray(reply?.results) ? reply.results : [];
        },
        close,
      });
    },
  });
}
