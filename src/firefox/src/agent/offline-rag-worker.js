/** Worker-owned SQLite FTS5 runtime for the optional offline RAG indexes. */

import sqlite3InitModule from '../../vendor/sqlite/index.mjs';
import { createEmergencyCorpusStorage } from './emergency-corpus.js';
import {
  createEmergencyPassages,
  decodeNormalizedEmergencyText,
  tokenizeForLexicalSearch,
  validateEmergencyCorpusManifest,
} from './offline-rag.js';
import {
  EMERGENCY_FTS_INSERT_SQL,
  EMERGENCY_FTS_SCHEMA_SQL,
  EMERGENCY_FTS_SEARCH_SQL,
  OFFLINE_RAG_INDEX_PROTOCOL_VERSION,
  parseEmergencyVectorIndex,
  validateOfflineRagIndexPath,
} from './offline-rag-index.js';

const SQLITE_POOL_DIRECTORY = '.webbrain-offline-rag-sahpool-v1';
const SQLITE_POOL_NAME = 'webbrain-offline-rag-sahpool-v1';
const canceledRequests = new Set();
let sqlitePromise;
let operationQueue = Promise.resolve();
let vectorCache = null;

function databaseFilename(indexPath) {
  return `/webbrain-${validateOfflineRagIndexPath(indexPath).slice('sqlite/'.length)}`;
}

function abortError() {
  return new DOMException('Offline RAG operation canceled.', 'AbortError');
}

function assertNotCanceled(id) {
  if (canceledRequests.has(id)) throw abortError();
}

async function yieldForCancellation(id) {
  await new Promise(resolve => setTimeout(resolve, 0));
  assertNotCanceled(id);
}

function postProgress(id, progress) {
  self.postMessage({
    protocolVersion: OFFLINE_RAG_INDEX_PROTOCOL_VERSION,
    id,
    kind: 'progress',
    progress,
  });
}

async function sqliteRuntime() {
  if (!sqlitePromise) {
    sqlitePromise = (async () => {
      try {
        const sqlite3 = await sqlite3InitModule({
          locateFile: filename => new URL(`../../vendor/sqlite/${filename}`, import.meta.url).href,
          print: () => {},
          printErr: (...args) => console.warn('[offline-rag/sqlite]', ...args),
        });
        const pool = await sqlite3.installOpfsSAHPoolVfs({
          name: SQLITE_POOL_NAME,
          directory: SQLITE_POOL_DIRECTORY,
          initialCapacity: 12,
        });
        await pool.reserveMinimumCapacity(12);
        return { sqlite3, pool };
      } catch (error) {
        sqlitePromise = null;
        throw error;
      }
    })();
  }
  return await sqlitePromise;
}

function createSchema(db) {
  db.exec(EMERGENCY_FTS_SCHEMA_SQL);
}

function insertMetadata(db, manifest) {
  const statement = db.prepare('INSERT INTO corpus_metadata(key, value) VALUES(?, ?)');
  try {
    for (const [key, value] of [
      ['schemaVersion', String(manifest.schemaVersion)],
      ['corpusId', manifest.corpusId],
      ['version', manifest.version],
      ['contentSha256', manifest.contentSha256],
      ['documentCount', String(manifest.documents.length)],
    ]) statement.bind([key, value]).stepReset().clearBindings();
  } finally {
    statement.finalize();
  }
}

function insertPassages(db, passages) {
  const statement = db.prepare(EMERGENCY_FTS_INSERT_SQL);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const passage of passages) {
      const searchTerms = tokenizeForLexicalSearch(
        `${passage.title}\n${passage.collection}\n${passage.locator}\n${passage.text}`,
        { language: passage.language },
      ).join(' ');
      statement.bind([
        passage.passageId,
        passage.documentId,
        passage.sourceId,
        passage.title,
        passage.language,
        passage.collection,
        passage.source,
        passage.license,
        passage.locator,
        passage.text,
        searchTerms,
        passage.passageSha256,
        passage.tokenEstimate,
        passage.ordinal,
        passage.readerUrl,
      ]).stepReset().clearBindings();
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve insertion error */ }
    throw error;
  } finally {
    statement.finalize();
  }
}

async function buildEmergencyIndex(id, payload) {
  const manifest = validateEmergencyCorpusManifest(payload?.manifest);
  const installId = String(payload?.installId || '');
  if (!/^[a-z0-9][a-z0-9._-]{0,199}$/.test(installId)) throw new Error('Emergency corpus install id is invalid.');
  const indexPath = validateOfflineRagIndexPath(payload?.indexPath);
  const filename = databaseFilename(indexPath);
  const { pool } = await sqliteRuntime();
  pool.unlink(filename);
  const storage = createEmergencyCorpusStorage();
  let db;
  try {
    assertNotCanceled(id);
    db = new pool.OpfsSAHPoolDb(filename);
    createSchema(db);
    insertMetadata(db, manifest);
    let passageCount = 0;
    for (let documentIndex = 0; documentIndex < manifest.documents.length; documentIndex += 1) {
      await yieldForCancellation(id);
      const document = manifest.documents[documentIndex];
      const file = await storage.readInstallFile(installId, document.path);
      const text = decodeNormalizedEmergencyText(await file.arrayBuffer());
      const passages = await createEmergencyPassages(document, text, { corpusVersion: manifest.version });
      insertPassages(db, passages);
      passageCount += passages.length;
      postProgress(id, {
        phase: 'indexing',
        documentsIndexed: documentIndex + 1,
        documentCount: manifest.documents.length,
        passageCount,
      });
    }
    assertNotCanceled(id);
    db.exec("INSERT INTO passages(passages) VALUES('optimize')");
    const integrity = db.selectValue('PRAGMA quick_check');
    if (integrity !== 'ok') throw new Error(`Emergency corpus SQLite integrity check failed: ${integrity}`);
    const storedDigest = db.selectValue("SELECT value FROM corpus_metadata WHERE key='contentSha256'");
    if (storedDigest !== manifest.contentSha256) throw new Error('Emergency corpus SQLite metadata checksum mismatch.');
    const storedPassages = Number(db.selectValue('SELECT count(*) FROM passages'));
    if (!storedPassages || storedPassages !== passageCount) {
      throw new Error('Emergency corpus SQLite passage count mismatch.');
    }
    const indexBytes = Number(db.selectValue('PRAGMA page_count')) * Number(db.selectValue('PRAGMA page_size'));
    if (!Number.isSafeInteger(indexBytes) || indexBytes <= 0) throw new Error('Emergency corpus SQLite index is empty.');
    return { indexPath, indexBytes, passageCount };
  } catch (error) {
    try { db?.close(); } catch { /* preserve build error */ }
    db = null;
    pool.unlink(filename);
    throw error;
  } finally {
    try { db?.close(); } catch { /* result already verified */ }
  }
}

function validatePreparedDatabase(db, manifest, expectedPassages) {
  const integrity = db.selectValue('PRAGMA quick_check');
  if (integrity !== 'ok') throw new Error(`Emergency corpus SQLite integrity check failed: ${integrity}`);
  const storedDigest = db.selectValue("SELECT value FROM corpus_metadata WHERE key='contentSha256'");
  if (storedDigest !== manifest.contentSha256) throw new Error('Emergency corpus SQLite metadata checksum mismatch.');
  const storedVersion = db.selectValue("SELECT value FROM corpus_metadata WHERE key='version'");
  if (storedVersion !== manifest.version) throw new Error('Emergency corpus SQLite version mismatch.');
  const storedPassages = Number(db.selectValue('SELECT count(*) FROM passages'));
  if (!storedPassages || storedPassages !== expectedPassages) {
    throw new Error('Emergency corpus SQLite passage count mismatch.');
  }
  return storedPassages;
}

async function importEmergencyIndex(id, payload) {
  const manifest = validateEmergencyCorpusManifest(payload?.manifest);
  const declaration = manifest.indexes?.fts5;
  if (!declaration) return await buildEmergencyIndex(id, payload);
  const installId = String(payload?.installId || '');
  if (!/^[a-z0-9][a-z0-9._-]{0,199}$/.test(installId)) throw new Error('Emergency corpus install id is invalid.');
  const indexPath = validateOfflineRagIndexPath(payload?.indexPath);
  const filename = databaseFilename(indexPath);
  const storage = createEmergencyCorpusStorage();
  const source = await storage.readInstallFile(installId, declaration.path);
  if (!source || source.size !== declaration.bytes) throw new Error('Prebuilt Emergency FTS5 index size is invalid.');
  const { pool } = await sqliteRuntime();
  pool.unlink(filename);
  let offset = 0;
  let db;
  try {
    await pool.importDb(filename, async () => {
      assertNotCanceled(id);
      if (offset >= source.size) return undefined;
      const end = Math.min(source.size, offset + 8 * 1024 * 1024);
      const chunk = await source.slice(offset, end).arrayBuffer();
      offset = end;
      postProgress(id, { phase: 'importing-index', bytesImported: offset, totalBytes: source.size });
      return chunk;
    });
    assertNotCanceled(id);
    db = new pool.OpfsSAHPoolDb(filename, 'r');
    const passageCount = validatePreparedDatabase(db, manifest, declaration.passageCount);
    await storage.deleteInstallFile?.(installId, declaration.path).catch(() => {});
    return { indexPath, indexBytes: declaration.bytes, passageCount, prebuilt: true };
  } catch (error) {
    try { db?.close(); } catch { /* preserve import error */ }
    db = null;
    pool.unlink(filename);
    throw error;
  } finally {
    try { db?.close(); } catch { /* result already verified */ }
  }
}

async function searchEmergencyIndex(id, payload) {
  const indexPath = validateOfflineRagIndexPath(payload?.indexPath);
  const filename = databaseFilename(indexPath);
  const ftsQuery = String(payload?.ftsQuery || '').slice(0, 4096);
  const limit = Math.min(40, Math.max(1, Number(payload?.limit) || 40));
  if (!ftsQuery) return { rows: [] };
  const { pool } = await sqliteRuntime();
  if (!pool.getFileNames().includes(filename)) throw new Error('Offline Emergency Box index is not installed.');
  assertNotCanceled(id);
  const db = new pool.OpfsSAHPoolDb(filename, 'r');
  try {
    const rows = db.selectObjects(EMERGENCY_FTS_SEARCH_SQL, [ftsQuery, limit]);
    assertNotCanceled(id);
    return { rows };
  } finally {
    db.close();
  }
}

async function loadVectorIndex(id, installId, declaration) {
  const key = `${installId}:${String(declaration?.sha256 || '')}`;
  if (vectorCache?.key === key) return vectorCache.index;
  if (!/^[a-z0-9][a-z0-9._-]{0,199}$/.test(installId)) throw new Error('Emergency corpus install id is invalid.');
  const storage = createEmergencyCorpusStorage();
  const file = await storage.readInstallFile(installId, declaration?.path);
  if (!file || file.size !== declaration?.bytes) throw new Error('Emergency vector index size is invalid.');
  assertNotCanceled(id);
  const index = parseEmergencyVectorIndex(await file.arrayBuffer(), declaration);
  vectorCache = { key, index };
  return index;
}

function insertVectorWinner(winners, candidate, limit) {
  if (winners.length === limit && candidate.score <= winners[winners.length - 1].score) return;
  let index = winners.findIndex(winner => candidate.score > winner.score);
  if (index < 0) index = winners.length;
  winners.splice(index, 0, candidate);
  if (winners.length > limit) winners.pop();
}

async function searchEmergencyVector(id, payload) {
  const indexPath = validateOfflineRagIndexPath(payload?.indexPath);
  const installId = String(payload?.installId || '');
  const declaration = payload?.vectorIndex || {};
  const limit = Math.min(40, Math.max(1, Number(payload?.limit) || 40));
  const query = payload?.queryVector instanceof Float32Array
    ? payload.queryVector
    : Float32Array.from(payload?.queryVector || []);
  const vectorIndex = await loadVectorIndex(id, installId, declaration);
  if (query.length !== vectorIndex.dimensions) throw new Error('Emergency vector query dimension is invalid.');
  let queryNormSquared = 0;
  for (const value of query) queryNormSquared += value * value;
  const queryNorm = Math.sqrt(queryNormSquared);
  if (!Number.isFinite(queryNorm) || queryNorm <= 0) throw new Error('Emergency vector query is empty.');
  const winners = [];
  const { vectors, norms, dimensions, passageCount } = vectorIndex;
  for (let row = 0; row < passageCount; row += 1) {
    if ((row & 4095) === 0) assertNotCanceled(id);
    let dot = 0;
    const offset = row * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      dot += query[dimension] * vectors[offset + dimension];
    }
    const norm = norms[row];
    if (norm > 0) insertVectorWinner(winners, { rowid: row + 1, score: dot / (queryNorm * norm) }, limit);
  }
  const { pool } = await sqliteRuntime();
  const filename = databaseFilename(indexPath);
  if (!pool.getFileNames().includes(filename)) throw new Error('Offline Emergency Box index is not installed.');
  const db = new pool.OpfsSAHPoolDb(filename, 'r');
  try {
    const placeholders = winners.map(() => '?').join(',');
    const rows = winners.length ? db.selectObjects(`
      SELECT rowid AS vectorRowid, passage_id AS passageId, document_id AS documentId,
        source_id AS sourceId, title, language, collection, source, license, locator,
        body AS text, passage_sha256 AS passageSha256,
        CAST(token_estimate AS INTEGER) AS tokenEstimate, reader_url AS readerUrl
      FROM passages WHERE rowid IN (${placeholders})
    `, winners.map(winner => winner.rowid)) : [];
    const byRowid = new Map(rows.map(row => [Number(row.vectorRowid), row]));
    return {
      rows: winners.map(winner => ({
        ...byRowid.get(winner.rowid),
        semanticScore: winner.score,
      })).filter(row => row.passageId),
    };
  } finally {
    db.close();
  }
}

async function deleteIndex(payload) {
  const filename = databaseFilename(payload?.indexPath);
  const { pool } = await sqliteRuntime();
  vectorCache = null;
  return { deleted: pool.unlink(filename) };
}

function serializeError(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error),
    code: error?.code ? String(error.code) : '',
    stack: error?.stack ? String(error.stack) : '',
  };
}

async function handleRequest(message) {
  const { id, type, payload } = message;
  try {
    let result;
    if (type === 'prepare-emergency-index') result = await importEmergencyIndex(id, payload);
    else if (type === 'build-emergency-index') result = await buildEmergencyIndex(id, payload);
    else if (type === 'search-emergency-index') result = await searchEmergencyIndex(id, payload);
    else if (type === 'search-emergency-vector') result = await searchEmergencyVector(id, payload);
    else if (type === 'delete-index') result = await deleteIndex(payload);
    else throw new Error(`Unsupported offline RAG worker request: ${type}`);
    self.postMessage({ protocolVersion: OFFLINE_RAG_INDEX_PROTOCOL_VERSION, id, kind: 'result', result });
  } catch (error) {
    self.postMessage({
      protocolVersion: OFFLINE_RAG_INDEX_PROTOCOL_VERSION,
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
  if (message.protocolVersion !== OFFLINE_RAG_INDEX_PROTOCOL_VERSION || !Number.isSafeInteger(message.id)) return;
  if (message.type === 'cancel') {
    canceledRequests.add(message.id);
    return;
  }
  operationQueue = operationQueue.then(
    () => handleRequest(message),
    () => handleRequest(message),
  );
});
