/** Client and deterministic helpers for the dedicated multilingual E5 worker. */

import { MAX_GLOBAL_LEXICAL_CANDIDATES } from './offline-rag.js';

export const OFFLINE_RERANKER_PROTOCOL_VERSION = 2;
export const E5_MODEL_ID = 'Xenova/multilingual-e5-small';
export const E5_MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const E5_MODEL_DTYPE = 'q8';
export const E5_MODEL_VERSION = `${E5_MODEL_ID}@${E5_MODEL_REVISION}:${E5_MODEL_DTYPE}`;
export const E5_MODEL_DOWNLOAD_BYTES = 140_461_908;

export function e5QueryText(value) {
  return `query: ${String(value || '').trim()}`;
}

export function e5PassageText(value) {
  return `passage: ${String(value || '').trim()}`;
}

function candidateIdentity(hit) {
  return [hit?.sourceKind, hit?.sourceId, hit?.documentId, hit?.passageId].map(value => String(value || '')).join('\0');
}

export function cosineSimilarity(left, right) {
  if (!left || !right || left.length !== right.length || !left.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]) || 0;
    const rightValue = Number(right[index]) || 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (!leftMagnitude || !rightMagnitude) return Number.NEGATIVE_INFINITY;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function rankCandidatesBySemanticScore(candidates = [], scores = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((hit, index) => ({
      ...hit,
      semanticScore: Number(scores[index]),
      originalIndex: index,
      identity: candidateIdentity(hit),
    }))
    .filter(item => Number.isFinite(item.semanticScore))
    .sort((left, right) =>
      right.semanticScore - left.semanticScore
      || left.originalIndex - right.originalIndex
      || left.identity.localeCompare(right.identity)
    )
    .map((item, index) => {
      const { originalIndex: _originalIndex, identity: _identity, ...hit } = item;
      return Object.freeze({ ...hit, semanticRank: index + 1 });
    });
}

function workerError(value = {}) {
  const error = value.name === 'AbortError'
    ? new DOMException(value.message || 'Semantic reranking canceled.', 'AbortError')
    : new Error(value.message || 'Semantic reranking failed.');
  if (value.code) error.code = value.code;
  return error;
}

function requestAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('Semantic reranking canceled.', 'AbortError');
}

export function createOfflineSemanticReranker(options = {}) {
  const worker = options.worker || new Worker(new URL('./offline-reranker-worker.js', import.meta.url), {
    type: 'module',
    name: 'webbrain-offline-e5',
  });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let modelState = Object.freeze({
    status: 'unknown', ready: false, modelVersion: E5_MODEL_VERSION,
    loaded: 0, total: E5_MODEL_DOWNLOAD_BYTES, progress: 0, error: '',
  });
  const stateListeners = new Set();
  const publishState = value => {
    modelState = Object.freeze({ ...modelState, ...value, modelVersion: E5_MODEL_VERSION });
    for (const listener of stateListeners) {
      try { listener(modelState); } catch { /* a UI listener must not break lifecycle */ }
    }
  };
  const rejectAll = error => {
    for (const request of pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    pending.clear();
  };
  worker.addEventListener('message', event => {
    const message = event.data || {};
    if (message.protocolVersion !== OFFLINE_RERANKER_PROTOCOL_VERSION) return;
    if (message.kind === 'model-state') {
      publishState(message.state || {});
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    if (message.kind === 'progress') {
      request.onProgress(message.progress || {});
      return;
    }
    pending.delete(message.id);
    request.cleanup();
    if (message.kind === 'result') request.resolve(message.result);
    else request.reject(workerError(message.error));
  });
  worker.addEventListener('error', event => {
    const error = new Error(event?.message || 'Semantic reranker worker crashed.');
    publishState({ status: 'error', ready: false, error: error.message });
    rejectAll(error);
  });

  const request = (type, payload = {}, requestOptions = {}) => {
    if (closed) return Promise.reject(new Error('Semantic reranker is closed.'));
    const id = nextId++;
    const signal = requestOptions.signal;
    if (signal?.aborted) return Promise.reject(
      signal.reason?.name === 'AbortError'
        ? signal.reason
        : new DOMException('Semantic reranking canceled.', 'AbortError'),
    );
    return new Promise((resolve, reject) => {
      const cancelType = requestOptions.cancelType || 'cancel';
      const abort = () => worker.postMessage({
        protocolVersion: OFFLINE_RERANKER_PROTOCOL_VERSION,
        id,
        type: cancelType,
      });
      const abortImmediately = () => {
        abort();
        if (cancelType !== 'cancel' || !pending.has(id)) return;
        pending.delete(id);
        signal?.removeEventListener?.('abort', abortImmediately);
        reject(requestAbortError(signal));
      };
      signal?.addEventListener?.('abort', abortImmediately, { once: true });
      pending.set(id, {
        resolve, reject,
        cleanup: () => signal?.removeEventListener?.('abort', abortImmediately),
        onProgress: typeof requestOptions.onProgress === 'function' ? requestOptions.onProgress : () => {},
      });
      worker.postMessage({ protocolVersion: OFFLINE_RERANKER_PROTOCOL_VERSION, id, type, payload });
    });
  };

  return Object.freeze({
    snapshot() { return modelState; },
    subscribe(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    async status() {
      const state = await request('model-status');
      publishState(state);
      return modelState.status;
    },
    async download({ signal, onProgress } = {}) {
      const state = await request('download-model', {}, { signal, onProgress, cancelType: 'pause-model' });
      publishState(state);
      return modelState;
    },
    async pause() {
      const state = await request('pause-model');
      publishState(state);
      return modelState;
    },
    async stop() {
      const state = await request('stop-model');
      publishState(state);
      return modelState;
    },
    async rerank(queryValue, candidatesValue, requestOptions = {}) {
      const query = String(queryValue || '').trim();
      const candidates = (Array.isArray(candidatesValue) ? candidatesValue : [])
        .slice(0, MAX_GLOBAL_LEXICAL_CANDIDATES)
        .filter(hit => hit?.passageId && hit?.passageSha256 && String(hit?.text || '').trim());
      if (!query || !candidates.length) return [];
      const result = await request('rerank', {
        query: query.slice(0, 4_000),
        candidates: candidates.map(hit => ({
          sourceKind: hit.sourceKind,
          sourceId: hit.sourceId,
          documentId: hit.documentId,
          passageId: hit.passageId,
          passageSha256: hit.passageSha256,
          text: String(hit.text).slice(0, 12_000),
        })),
      }, requestOptions);
      if (!Array.isArray(result?.scores) || result.scores.length !== candidates.length) {
        throw new Error('Semantic reranker returned an invalid score vector.');
      }
      return rankCandidatesBySemanticScore(candidates, result.scores);
    },
    async embedQuery(queryValue, requestOptions = {}) {
      const query = String(queryValue || '').trim();
      if (!query) throw new Error('Semantic query is empty.');
      const result = await request('embed-query', { query }, requestOptions);
      const vector = result?.vector instanceof Float32Array
        ? result.vector
        : Float32Array.from(result?.vector || []);
      if (vector.length !== 384) throw new Error('E5 returned an invalid query embedding.');
      return vector;
    },
    close() {
      if (closed) return;
      closed = true;
      worker.terminate();
      rejectAll(new Error('Semantic reranker closed.'));
      stateListeners.clear();
    },
  });
}
