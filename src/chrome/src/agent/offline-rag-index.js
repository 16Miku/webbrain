/** Main-thread client and pure query helpers for the offline SQLite worker. */

import { MAX_LEXICAL_CANDIDATES_PER_SOURCE, tokenizeForLexicalSearch } from './offline-rag.js';

export const OFFLINE_RAG_INDEX_PROTOCOL_VERSION = 2;
export const EMERGENCY_VECTOR_INDEX_FORMAT_VERSION = 1;
export const EMERGENCY_VECTOR_HEADER_BYTES = 4096;
export const EMERGENCY_VECTOR_DIMENSIONS = 384;
const EMERGENCY_VECTOR_MAGIC = 'WBVE5Q8\0';
export const EMERGENCY_FTS_SCHEMA_SQL = `
  PRAGMA journal_mode=DELETE;
  PRAGMA synchronous=FULL;
  PRAGMA temp_store=MEMORY;
  PRAGMA secure_delete=ON;
  CREATE TABLE corpus_metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE VIRTUAL TABLE passages USING fts5(
    passage_id UNINDEXED,
    document_id UNINDEXED,
    source_id UNINDEXED,
    title,
    language UNINDEXED,
    collection,
    source UNINDEXED,
    license UNINDEXED,
    locator,
    body,
    search_terms,
    passage_sha256 UNINDEXED,
    token_estimate UNINDEXED,
    ordinal UNINDEXED,
    reader_url UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`;
export const EMERGENCY_FTS_INSERT_SQL = `
  INSERT INTO passages(
    passage_id, document_id, source_id, title, language, collection, source, license,
    locator, body, search_terms, passage_sha256, token_estimate, ordinal, reader_url
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
export const EMERGENCY_FTS_SEARCH_SQL = `
  SELECT
    passage_id AS passageId,
    document_id AS documentId,
    source_id AS sourceId,
    title,
    language,
    collection,
    source,
    license,
    locator,
    body AS text,
    passage_sha256 AS passageSha256,
    CAST(token_estimate AS INTEGER) AS tokenEstimate,
    reader_url AS readerUrl,
    bm25(passages, 0, 0, 0, 7, 0, 2, 0, 0, 4, 1, 0.6, 0, 0, 0, 0) AS score
  FROM passages
  WHERE passages MATCH ?
  ORDER BY score ASC, passage_id ASC
  LIMIT ?
`;
const INDEX_PATH_RE = /^sqlite\/[a-z0-9][a-z0-9._-]{0,199}\.sqlite3$/;

export function validateOfflineRagIndexPath(value) {
  const path = String(value || '').trim().toLowerCase();
  if (!INDEX_PATH_RE.test(path)) throw new Error('Offline RAG index path is invalid.');
  return path;
}

// A person typing during an emergency misspells words, uses the wrong number or
// tense, and writes in a language that glues suffixes onto stems. Truncating a
// token to a prefix covers all three without a language-specific stemmer:
// "bleedng" and "bleeding" share "blee", "rehydrate" reaches "rehydration", and
// Turkish "turnike" reaches "turnikeyi". Kept deliberately crude, because it is
// only ever a second pass after exact matching has come up short.
const RELAXED_MINIMUM_TOKEN_LENGTH = 5;
const RELAXED_MINIMUM_PREFIX_LENGTH = 4;

function quoteFts5Token(token) {
  return `"${token.replace(/"/g, '""')}"`;
}

export function relaxedFts5Prefix(token) {
  const value = String(token || '');
  if (value.length < RELAXED_MINIMUM_TOKEN_LENGTH) return '';
  const stem = value.slice(0, Math.max(RELAXED_MINIMUM_PREFIX_LENGTH, Math.ceil(value.length / 2)));
  return stem === value ? '' : stem;
}

export function buildFts5Query(value, options = {}) {
  const maximumTerms = Math.min(32, Math.max(1, Number(options.maximumTerms) || 24));
  const tokens = tokenizeForLexicalSearch(value, { language: options.language })
    .filter(token => token.length <= 80)
    .slice(0, maximumTerms);
  if (!tokens.length) return '';
  if (options.relax !== true) return tokens.map(quoteFts5Token).join(' OR ');

  const terms = [];
  const seen = new Set();
  const push = term => {
    if (seen.has(term)) return;
    seen.add(term);
    terms.push(term);
  };
  for (const token of tokens) {
    push(quoteFts5Token(token));
    const stem = relaxedFts5Prefix(token);
    if (stem) push(`${quoteFts5Token(stem)}*`);
  }
  return terms.join(' OR ');
}

export function normalizeEmergencyLexicalHits(rows, sourceVersion) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, MAX_LEXICAL_CANDIDATES_PER_SOURCE)
    .map((row, index) => Object.freeze({
      sourceKind: 'emergency-box',
      sourceId: String(sourceVersion || row?.sourceId || ''),
      documentId: String(row?.documentId || ''),
      passageId: String(row?.passageId || ''),
      title: String(row?.title || ''),
      language: String(row?.language || 'und'),
      collection: String(row?.collection || ''),
      source: String(row?.source || ''),
      license: String(row?.license || ''),
      locator: String(row?.locator || ''),
      text: String(row?.text || ''),
      passageSha256: String(row?.passageSha256 || ''),
      tokenEstimate: Number(row?.tokenEstimate) || 0,
      readerUrl: String(row?.readerUrl || ''),
      lexicalRank: index + 1,
      lexicalScore: Number.isFinite(Number(row?.score)) ? -Number(row.score) : 0,
    }))
    .filter(hit => hit.documentId && hit.passageId && hit.text && hit.readerUrl);
}

export function normalizeEmergencyVectorHits(rows, sourceVersion) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, MAX_LEXICAL_CANDIDATES_PER_SOURCE)
    .map((row, index) => Object.freeze({
      sourceKind: 'emergency-box',
      sourceId: String(sourceVersion || row?.sourceId || ''),
      documentId: String(row?.documentId || ''),
      passageId: String(row?.passageId || ''),
      title: String(row?.title || ''),
      language: String(row?.language || 'und'),
      collection: String(row?.collection || ''),
      source: String(row?.source || ''),
      license: String(row?.license || ''),
      locator: String(row?.locator || ''),
      text: String(row?.text || ''),
      passageSha256: String(row?.passageSha256 || ''),
      tokenEstimate: Number(row?.tokenEstimate) || 0,
      readerUrl: String(row?.readerUrl || ''),
      semanticRank: index + 1,
      semanticScore: Number.isFinite(Number(row?.semanticScore)) ? Number(row.semanticScore) : 0,
      retrievalMode: 'e5-full-vector',
    }))
    .filter(hit => hit.documentId && hit.passageId && hit.text && hit.readerUrl);
}

export function parseEmergencyVectorIndex(value, declaration = {}) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.byteLength < EMERGENCY_VECTOR_HEADER_BYTES) throw new Error('Emergency vector index is truncated.');
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (magic !== EMERGENCY_VECTOR_MAGIC) throw new Error('Emergency vector index has an invalid magic header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatVersion = view.getUint32(8, true);
  const dimensions = view.getUint32(12, true);
  const passageCount = view.getUint32(16, true);
  const headerBytes = view.getUint32(20, true);
  const vectorOffset = Number(view.getBigUint64(24, true));
  const normOffset = Number(view.getBigUint64(32, true));
  if (formatVersion !== EMERGENCY_VECTOR_INDEX_FORMAT_VERSION
      || dimensions !== EMERGENCY_VECTOR_DIMENSIONS
      || headerBytes !== EMERGENCY_VECTOR_HEADER_BYTES
      || vectorOffset !== headerBytes
      || normOffset !== vectorOffset + passageCount * dimensions
      || normOffset + passageCount * 4 !== bytes.byteLength) {
    throw new Error('Emergency vector index layout is incompatible.');
  }
  if (declaration.passageCount && declaration.passageCount !== passageCount) {
    throw new Error('Emergency vector index passage count does not match its manifest.');
  }
  if (declaration.dimensions && declaration.dimensions !== dimensions) {
    throw new Error('Emergency vector index dimensions do not match its manifest.');
  }
  const metadataBytes = bytes.subarray(64, headerBytes);
  const terminator = metadataBytes.indexOf(0);
  const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
    terminator < 0 ? metadataBytes : metadataBytes.subarray(0, terminator),
  ));
  if (Number(metadata.passageCount) !== passageCount || Number(metadata.dimensions) !== dimensions) {
    throw new Error('Emergency vector index metadata does not match its binary layout.');
  }
  for (const [metadataField, declarationField] of [
    ['clientModelId', 'modelId'],
    ['clientModelRevision', 'modelRevision'],
    ['clientModelDtype', 'modelDtype'],
  ]) {
    if (declaration[declarationField]
        && String(metadata[metadataField] || '') !== String(declaration[declarationField])) {
      throw new Error('Emergency vector index model does not match its manifest.');
    }
  }
  const vectors = new Int8Array(bytes.buffer, bytes.byteOffset + vectorOffset, passageCount * dimensions);
  const norms = new Float32Array(bytes.buffer, bytes.byteOffset + normOffset, passageCount);
  return Object.freeze({ formatVersion, dimensions, passageCount, metadata: Object.freeze(metadata), vectors, norms });
}

function deserializeWorkerError(value = {}) {
  const error = value.name === 'AbortError'
    ? new DOMException(value.message || 'Offline RAG operation canceled.', 'AbortError')
    : new Error(value.message || 'Offline RAG worker failed.');
  if (value.code) error.code = value.code;
  if (value.stack && error.name !== 'AbortError') error.stack = value.stack;
  return error;
}

function requestAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('Offline RAG operation canceled.', 'AbortError');
}

export function createOfflineRagIndexClient(options = {}) {
  const worker = options.worker || new Worker(new URL('./offline-rag-worker.js', import.meta.url), {
    type: 'module',
    name: 'webbrain-offline-rag',
  });
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  const rejectAll = error => {
    for (const request of pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    pending.clear();
  };
  worker.addEventListener('message', event => {
    const message = event.data || {};
    if (message.protocolVersion !== OFFLINE_RAG_INDEX_PROTOCOL_VERSION) return;
    const request = pending.get(message.id);
    if (!request) return;
    if (message.kind === 'progress') {
      request.onProgress(message.progress || {});
      return;
    }
    pending.delete(message.id);
    request.cleanup();
    if (message.kind === 'result') request.resolve(message.result);
    else request.reject(deserializeWorkerError(message.error));
  });
  worker.addEventListener('error', event => {
    rejectAll(new Error(event?.message || 'Offline RAG worker crashed.'));
  });

  const request = (type, payload, requestOptions = {}) => {
    if (closed) return Promise.reject(new Error('Offline RAG index client is closed.'));
    const id = nextId++;
    const signal = requestOptions.signal;
    if (signal?.aborted) return Promise.reject(
      signal.reason?.name === 'AbortError'
        ? signal.reason
        : new DOMException('Offline RAG operation canceled.', 'AbortError'),
    );
    return new Promise((resolve, reject) => {
      const abortImmediately = () => {
        worker.postMessage({
          protocolVersion: OFFLINE_RAG_INDEX_PROTOCOL_VERSION,
          id,
          type: 'cancel',
        });
        if (!pending.has(id)) return;
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
      worker.postMessage({
        protocolVersion: OFFLINE_RAG_INDEX_PROTOCOL_VERSION,
        id,
        type,
        payload,
      });
    });
  };

  return Object.freeze({
    async buildEmergencyIndex({ manifest, installId, indexPath, signal, onProgress }) {
      return await request('prepare-emergency-index', {
        manifest,
        installId: String(installId || ''),
        indexPath: validateOfflineRagIndexPath(indexPath),
      }, { signal, onProgress });
    },
    async searchEmergency({ indexPath, sourceVersion, query, limit, signal, relax }) {
      const ftsQuery = buildFts5Query(query, { relax: relax === true });
      if (!ftsQuery) return [];
      const safeLimit = Math.min(
        MAX_LEXICAL_CANDIDATES_PER_SOURCE,
        Math.max(1, Number.isSafeInteger(limit) ? limit : MAX_LEXICAL_CANDIDATES_PER_SOURCE),
      );
      const result = await request('search-emergency-index', {
        indexPath: validateOfflineRagIndexPath(indexPath),
        ftsQuery,
        limit: safeLimit,
      }, { signal });
      return normalizeEmergencyLexicalHits(result?.rows, sourceVersion);
    },
    async searchEmergencyVector({ installId, indexPath, vectorIndex, sourceVersion, queryVector, limit, signal }) {
      const vector = queryVector instanceof Float32Array ? queryVector : Float32Array.from(queryVector || []);
      if (vector.length !== EMERGENCY_VECTOR_DIMENSIONS) throw new Error('Emergency vector query must have 384 dimensions.');
      const safeLimit = Math.min(
        MAX_LEXICAL_CANDIDATES_PER_SOURCE,
        Math.max(1, Number.isSafeInteger(limit) ? limit : MAX_LEXICAL_CANDIDATES_PER_SOURCE),
      );
      const result = await request('search-emergency-vector', {
        installId: String(installId || ''),
        indexPath: validateOfflineRagIndexPath(indexPath),
        vectorIndex,
        queryVector: vector,
        limit: safeLimit,
      }, { signal });
      return normalizeEmergencyVectorHits(result?.rows, sourceVersion);
    },
    async deleteIndex(indexPath) {
      return await request('delete-index', { indexPath: validateOfflineRagIndexPath(indexPath) });
    },
    close() {
      if (closed) return;
      closed = true;
      worker.terminate();
      rejectAll(new Error('Offline RAG index client closed.'));
    },
  });
}
