/** Chrome MV3 proxy for the SQLite index worker owned by the offscreen host. */

import { validateOfflineRagIndexPath } from './offline-rag-index.js';

const OFFSCREEN_TARGET = 'offscreen-offline-rag';
const INDEX_PROGRESS_TARGET = 'offscreen-offline-rag-index-progress';
const ENSURE_HOST_ACTION = 'ensure_offscreen_offline_rag_host';
let nextRequestId = 1;

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('Offline RAG index operation canceled.', 'AbortError');
}

function remoteError(value = {}) {
  const error = value.name === 'AbortError'
    ? new DOMException(value.message || 'Offline RAG index operation canceled.', 'AbortError')
    : new Error(value.message || 'Offline RAG index operation failed.');
  if (value.code) error.code = value.code;
  return error;
}

export function createHostedOfflineRagIndexClient(options = {}) {
  const api = options.api || globalThis.chrome;
  if (!api?.runtime?.sendMessage) throw new Error('Chrome runtime messaging is unavailable.');
  const progressListeners = new Map();
  const activeRequests = new Set();
  let closed = false;

  const onMessage = message => {
    if (message?.target !== INDEX_PROGRESS_TARGET) return false;
    progressListeners.get(String(message.requestId || ''))?.(message.progress || {});
    return false;
  };
  api.runtime.onMessage?.addListener?.(onMessage);

  const ensureHost = options.ensureHost || (async () => {
    const response = await api.runtime.sendMessage({ target: 'background', action: ENSURE_HOST_ACTION });
    if (response?.error) throw new Error(String(response.error));
  });

  const request = async (action, payload = {}, requestOptions = {}) => {
    if (closed) throw new Error('Offline RAG index client is closed.');
    const signal = requestOptions.signal;
    if (signal?.aborted) throw abortError(signal);
    await ensureHost();
    if (closed) throw new Error('Offline RAG index client is closed.');
    if (signal?.aborted) throw abortError(signal);

    const requestId = `${Date.now().toString(36)}-${nextRequestId++}`;
    let sent = false;
    let cancellationSent = false;
    const cancel = () => {
      if (!sent || cancellationSent) return;
      cancellationSent = true;
      void api.runtime.sendMessage({
        target: OFFSCREEN_TARGET,
        action: 'cancel',
        requestId,
      }).catch(() => {});
    };
    progressListeners.set(
      requestId,
      typeof requestOptions.onProgress === 'function' ? requestOptions.onProgress : () => {},
    );
    activeRequests.add(requestId);
    signal?.addEventListener?.('abort', cancel, { once: true });
    try {
      sent = true;
      const response = await api.runtime.sendMessage({
        target: OFFSCREEN_TARGET,
        action,
        requestId,
        ...payload,
      });
      if (signal?.aborted) throw abortError(signal);
      if (closed) throw new Error('Offline RAG index client is closed.');
      if (response?.ok !== true) throw remoteError(response?.error);
      return response.result;
    } finally {
      signal?.removeEventListener?.('abort', cancel);
      progressListeners.delete(requestId);
      activeRequests.delete(requestId);
    }
  };

  return Object.freeze({
    async buildEmergencyIndex({ manifest, installId, indexPath, signal, onProgress }) {
      return await request('prepare-emergency-index', {
        manifest,
        installId: String(installId || ''),
        indexPath: validateOfflineRagIndexPath(indexPath),
      }, { signal, onProgress });
    },
    async deleteIndex(indexPath) {
      return await request('delete-index', {
        indexPath: validateOfflineRagIndexPath(indexPath),
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const requestId of activeRequests) {
        void api.runtime.sendMessage({
          target: OFFSCREEN_TARGET,
          action: 'cancel',
          requestId,
        }).catch(() => {});
      }
      progressListeners.clear();
      activeRequests.clear();
      api.runtime.onMessage?.removeListener?.(onMessage);
    },
  });
}
