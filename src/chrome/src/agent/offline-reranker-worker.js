/** Dedicated CPU/WASM multilingual E5 worker with a bounded persistent cache. */

import { env, pipeline } from '../../vendor/transformers/transformers.web.js';
import {
  E5_MODEL_DOWNLOAD_BYTES,
  E5_MODEL_DTYPE,
  E5_MODEL_ID,
  E5_MODEL_REVISION,
  E5_MODEL_VERSION,
  OFFLINE_RERANKER_PROTOCOL_VERSION,
  cosineSimilarity,
  e5PassageText,
  e5QueryText,
} from './offline-reranker.js';
import {
  VECTOR_CACHE_MAX_BYTES,
  buildVectorCacheKey,
  selectVectorCacheEvictions,
} from './offline-rag.js';

const MODEL_CACHE_NAME = 'transformers-cache';
const MODEL_MARKER_URL = `https://webbrain.one/.well-known/offline-e5-ready/${encodeURIComponent(E5_MODEL_VERSION)}`;
const VECTOR_DB_NAME = 'webbrain_offline_rag_vectors';
const VECTOR_DB_VERSION = 1;
const VECTOR_STORE = 'vectors';
const VECTOR_META_STORE = 'vectorMetadata';
const nativeFetch = globalThis.fetch?.bind(globalThis);
const canceledRequests = new Set();
const downloadFiles = new Map();
let vectorDatabasePromise;
let extractor = null;
let extractorPromise = null;
let operationQueue = Promise.resolve();
let downloadAbortController = null;
let downloadCancelMode = '';
let modelState = {
  status: 'unknown', ready: false, modelVersion: E5_MODEL_VERSION,
  loaded: 0, total: E5_MODEL_DOWNLOAD_BYTES, progress: 0, error: '',
};

if (env) {
  env.allowLocalModels = false;
  env.allowRemoteModels = false;
  env.useBrowserCache = true;
  env.useWasmCache = false;
  env.fetch = (input, init = {}) => {
    if (!nativeFetch) throw new Error('Network access is unavailable.');
    const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
    const targetsModel = safeDecode(url).includes(`/${E5_MODEL_ID}/`);
    return nativeFetch(input, targetsModel && downloadAbortController
      ? { ...init, signal: downloadAbortController.signal }
      : init);
  };
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) {
    wasm.numThreads = 1;
    wasm.wasmPaths = {
      mjs: new URL('../../vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
      wasm: new URL('../../vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href,
    };
  }
}

function safeDecode(value) {
  try { return decodeURIComponent(String(value || '')); } catch { return String(value || ''); }
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Vector cache transaction aborted.'));
  });
}

function vectorDatabase() {
  if (vectorDatabasePromise) return vectorDatabasePromise;
  vectorDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(VECTOR_DB_NAME, VECTOR_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(VECTOR_STORE)) database.createObjectStore(VECTOR_STORE, { keyPath: 'key' });
      if (!database.objectStoreNames.contains(VECTOR_META_STORE)) database.createObjectStore(VECTOR_META_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return vectorDatabasePromise;
}

async function readCachedVectors(keys) {
  const database = await vectorDatabase();
  const readTransaction = database.transaction(VECTOR_STORE, 'readonly');
  const readComplete = idbTransaction(readTransaction);
  const vectors = readTransaction.objectStore(VECTOR_STORE);
  const records = await Promise.all(keys.map(key => idbRequest(vectors.get(key))));
  await readComplete;
  const hits = records.map((record, index) => ({ record, key: keys[index] })).filter(item => item.record?.data);
  if (hits.length) {
    const touchTransaction = database.transaction(VECTOR_META_STORE, 'readwrite');
    const touchComplete = idbTransaction(touchTransaction);
    const metadata = touchTransaction.objectStore(VECTOR_META_STORE);
    const now = Date.now();
    for (const { record, key } of hits) {
      metadata.put({ key, byteLength: record.data.byteLength, lastUsedAt: now });
    }
    await touchComplete;
  }
  return new Map(records.map((record, index) => [keys[index], record?.data ? new Float32Array(record.data) : null]));
}

async function writeCachedVectors(entries) {
  if (!entries.length) return;
  const database = await vectorDatabase();
  const transaction = database.transaction([VECTOR_STORE, VECTOR_META_STORE], 'readwrite');
  const complete = idbTransaction(transaction);
  const vectors = transaction.objectStore(VECTOR_STORE);
  const metadata = transaction.objectStore(VECTOR_META_STORE);
  const now = Date.now();
  for (const { key, vector } of entries) {
    const data = vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength);
    vectors.put({ key, data });
    metadata.put({ key, byteLength: data.byteLength, lastUsedAt: now });
  }
  await complete;
  await enforceVectorCacheLimit();
}

async function enforceVectorCacheLimit() {
  const database = await vectorDatabase();
  const listTransaction = database.transaction(VECTOR_META_STORE, 'readonly');
  const listComplete = idbTransaction(listTransaction);
  const entries = await idbRequest(listTransaction.objectStore(VECTOR_META_STORE).getAll());
  await listComplete;
  const plan = selectVectorCacheEvictions(entries, { maximumBytes: VECTOR_CACHE_MAX_BYTES });
  if (!plan.evictions.length) return plan;
  const transaction = database.transaction([VECTOR_STORE, VECTOR_META_STORE], 'readwrite');
  const complete = idbTransaction(transaction);
  for (const key of plan.evictions) {
    transaction.objectStore(VECTOR_STORE).delete(key);
    transaction.objectStore(VECTOR_META_STORE).delete(key);
  }
  await complete;
  return plan;
}

function publishModelState(patch = {}) {
  modelState = {
    ...modelState,
    ...patch,
    modelVersion: E5_MODEL_VERSION,
    total: E5_MODEL_DOWNLOAD_BYTES,
  };
  self.postMessage({
    protocolVersion: OFFLINE_RERANKER_PROTOCOL_VERSION,
    kind: 'model-state',
    state: modelState,
  });
  return { ...modelState };
}

async function hasReadyMarker() {
  if (typeof caches === 'undefined') return false;
  try { return !!(await (await caches.open(MODEL_CACHE_NAME)).match(MODEL_MARKER_URL)); }
  catch { return false; }
}

async function setReadyMarker() {
  const cache = await caches.open(MODEL_CACHE_NAME);
  await cache.put(MODEL_MARKER_URL, new Response(JSON.stringify({
    modelId: E5_MODEL_ID, revision: E5_MODEL_REVISION, dtype: E5_MODEL_DTYPE,
  }), { headers: { 'content-type': 'application/json' } }));
}

function aggregateDownloadProgress(event = {}) {
  const file = String(event.file || event.name || '');
  const total = Number(event.total) || 0;
  const loaded = Number(event.loaded) || (event.status === 'done' ? total : 0);
  if (file) downloadFiles.set(file, { loaded: Math.max(0, loaded), total: Math.max(0, total) });
  const observedLoaded = [...downloadFiles.values()].reduce((sum, item) => sum + Math.min(item.loaded, item.total || item.loaded), 0);
  const boundedLoaded = Math.min(E5_MODEL_DOWNLOAD_BYTES, observedLoaded);
  publishModelState({
    status: 'downloading', ready: false, loaded: boundedLoaded,
    progress: E5_MODEL_DOWNLOAD_BYTES ? boundedLoaded / E5_MODEL_DOWNLOAD_BYTES : 0,
    file, error: '',
  });
}

async function loadExtractor({ allowDownload = false } = {}) {
  if (extractor) return extractor;
  if (extractorPromise) return await extractorPromise;
  if (!allowDownload && !await hasReadyMarker()) {
    const error = new Error('The multilingual E5 model is not installed.');
    error.code = 'model-missing';
    throw error;
  }
  const previousRemote = env.allowRemoteModels;
  env.allowRemoteModels = allowDownload;
  extractorPromise = pipeline('feature-extraction', E5_MODEL_ID, {
    revision: E5_MODEL_REVISION,
    dtype: E5_MODEL_DTYPE,
    device: 'wasm',
    local_files_only: !allowDownload,
    progress_callback: allowDownload ? aggregateDownloadProgress : undefined,
  }).then(value => {
    extractor = value;
    return value;
  }).finally(() => {
    env.allowRemoteModels = previousRemote;
    extractorPromise = null;
  });
  return await extractorPromise;
}

async function disposeExtractor() {
  const current = extractor;
  extractor = null;
  if (current?.dispose) await current.dispose().catch(() => {});
}

function assertNotCanceled(id) {
  if (canceledRequests.has(id)) throw new DOMException('Semantic reranking canceled.', 'AbortError');
}

function tensorVectors(tensor) {
  const value = tensor?.tolist?.();
  if (!Array.isArray(value)) throw new Error('E5 returned no embedding vectors.');
  const rows = Array.isArray(value[0]) ? value : [value];
  return rows.map(row => Float32Array.from(row));
}

async function embedTexts(runtime, texts) {
  const output = await runtime(texts, { pooling: 'mean', normalize: true });
  return tensorVectors(output);
}

async function modelStatus() {
  const ready = await hasReadyMarker();
  return publishModelState({
    status: ready ? 'ready' : 'model-missing', ready,
    loaded: ready ? E5_MODEL_DOWNLOAD_BYTES : 0,
    progress: ready ? 1 : 0,
    error: '',
  });
}

async function downloadModel() {
  if (await hasReadyMarker()) return await modelStatus();
  downloadAbortController = new AbortController();
  downloadCancelMode = '';
  downloadFiles.clear();
  publishModelState({ status: 'downloading', ready: false, loaded: 0, progress: 0, error: '' });
  try {
    await loadExtractor({ allowDownload: true });
    await setReadyMarker();
    return publishModelState({
      status: 'ready', ready: true, loaded: E5_MODEL_DOWNLOAD_BYTES, progress: 1, error: '', file: '',
    });
  } catch (error) {
    const paused = downloadAbortController.signal.aborted && downloadCancelMode === 'pause';
    if (paused) return publishModelState({ status: 'paused', ready: false, error: '' });
    publishModelState({ status: 'error', ready: false, error: String(error?.message || error) });
    throw error;
  } finally {
    downloadAbortController = null;
    downloadCancelMode = '';
  }
}

async function clearModelCache() {
  downloadCancelMode = 'stop';
  downloadAbortController?.abort();
  await disposeExtractor();
  if (typeof caches !== 'undefined') {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const decoded = safeDecode(request.url);
        if (decoded.includes(`/${E5_MODEL_ID}/`) || request.url === MODEL_MARKER_URL) await cache.delete(request);
      }
      await cache.delete(MODEL_MARKER_URL);
    }
  }
  downloadFiles.clear();
  return publishModelState({ status: 'model-missing', ready: false, loaded: 0, progress: 0, error: '', file: '' });
}

async function rerank(id, payload = {}) {
  assertNotCanceled(id);
  if (!await hasReadyMarker()) {
    const error = new Error('The multilingual E5 model is not installed; using lexical ranking.');
    error.code = 'model-missing';
    throw error;
  }
  const query = String(payload.query || '').trim();
  const candidates = Array.isArray(payload.candidates) ? payload.candidates.slice(0, 80) : [];
  if (!query || !candidates.length) return { scores: [], cacheHits: 0, cacheMisses: 0 };
  const runtime = await loadExtractor({ allowDownload: false });
  assertNotCanceled(id);
  const [queryVector] = await embedTexts(runtime, [e5QueryText(query)]);
  const keys = candidates.map(hit => buildVectorCacheKey({
    modelVersion: E5_MODEL_VERSION,
    sourceVersion: String(hit.sourceId || ''),
    sourceKind: hit.sourceKind,
    passageId: hit.passageId,
    passageSha256: hit.passageSha256,
  }));
  let cached;
  try { cached = await readCachedVectors(keys); }
  catch { cached = new Map(); }
  const vectors = new Array(candidates.length);
  const misses = [];
  candidates.forEach((hit, index) => {
    const vector = cached.get(keys[index]);
    if (vector) vectors[index] = vector;
    else misses.push({ index, hit, key: keys[index] });
  });
  const writes = [];
  for (let offset = 0; offset < misses.length; offset += 8) {
    assertNotCanceled(id);
    const batch = misses.slice(offset, offset + 8);
    const embedded = await embedTexts(runtime, batch.map(item => e5PassageText(item.hit.text)));
    if (embedded.length !== batch.length) throw new Error('E5 returned an unexpected embedding batch size.');
    embedded.forEach((vector, index) => {
      const item = batch[index];
      vectors[item.index] = vector;
      writes.push({ key: item.key, vector });
    });
    self.postMessage({
      protocolVersion: OFFLINE_RERANKER_PROTOCOL_VERSION,
      id,
      kind: 'progress',
      progress: { phase: 'reranking', embedded: Math.min(misses.length, offset + batch.length), total: misses.length },
    });
  }
  try { await writeCachedVectors(writes); } catch { /* cache failure must not break retrieval */ }
  assertNotCanceled(id);
  return {
    scores: vectors.map(vector => cosineSimilarity(queryVector, vector)),
    cacheHits: candidates.length - misses.length,
    cacheMisses: misses.length,
  };
}

async function embedQuery(id, payload = {}) {
  assertNotCanceled(id);
  if (!await hasReadyMarker()) {
    const error = new Error('The multilingual E5 model is not installed; using lexical ranking.');
    error.code = 'model-missing';
    throw error;
  }
  const query = String(payload.query || '').trim();
  if (!query) throw new Error('Semantic query is empty.');
  const runtime = await loadExtractor({ allowDownload: false });
  assertNotCanceled(id);
  const [vector] = await embedTexts(runtime, [e5QueryText(query)]);
  return { vector };
}

function serializeError(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error),
    code: error?.code ? String(error.code) : '',
  };
}

async function handle(message) {
  const { id, type, payload } = message;
  try {
    let result;
    if (type === 'model-status') result = await modelStatus();
    else if (type === 'download-model') result = await downloadModel();
    else if (type === 'pause-model') {
      downloadCancelMode = 'pause';
      downloadAbortController?.abort();
      result = publishModelState({ status: 'paused', ready: false, error: '' });
    } else if (type === 'stop-model') result = await clearModelCache();
    else if (type === 'rerank') result = await rerank(id, payload);
    else if (type === 'embed-query') result = await embedQuery(id, payload);
    else throw new Error(`Unsupported semantic worker request: ${type}`);
    self.postMessage({ protocolVersion: OFFLINE_RERANKER_PROTOCOL_VERSION, id, kind: 'result', result });
  } catch (error) {
    self.postMessage({
      protocolVersion: OFFLINE_RERANKER_PROTOCOL_VERSION,
      id,
      kind: 'error',
      error: serializeError(error),
    });
  } finally {
    canceledRequests.delete(id);
  }
}

self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.protocolVersion !== OFFLINE_RERANKER_PROTOCOL_VERSION || !Number.isSafeInteger(message.id)) return;
  if (message.type === 'cancel') {
    canceledRequests.add(message.id);
    return;
  }
  if (message.type === 'pause-model') {
    downloadCancelMode = 'pause';
    downloadAbortController?.abort();
  } else if (message.type === 'stop-model') {
    downloadCancelMode = 'stop';
    downloadAbortController?.abort();
  }
  operationQueue = operationQueue.then(() => handle(message), () => handle(message));
});
