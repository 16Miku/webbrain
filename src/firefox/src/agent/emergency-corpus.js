/**
 * Transactional lifecycle for the optional Emergency Box plaintext corpus.
 *
 * Downloads are explicit and resumable. Extraction always targets an isolated
 * staging directory; the previous verified corpus remains active until every
 * document checksum and the lexical index have been verified. Keep the Chrome
 * and Firefox copies byte-identical.
 */

import {
  EMERGENCY_CORPUS_ID,
  computeCorpusContentSha256,
  validateArchivePath,
  validateEmergencyCorpusManifest,
  verifyEmergencyDocument,
} from './offline-rag.js';
import { createApocalypseStore } from './apocalypse-mode.js';

export const EMERGENCY_CORPUS_DB_NAME = 'webbrain_offline_rag';
export const EMERGENCY_CORPUS_DB_VERSION = 1;
export const EMERGENCY_CORPUS_STORE = 'corpora';
export const EMERGENCY_CORPUS_DIRECTORY = 'webbrain-offline-rag';
export const MAX_EMERGENCY_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_EMERGENCY_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_EMERGENCY_INDEX_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_EMERGENCY_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_EMERGENCY_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_EMERGENCY_ZIP_ENTRIES = 10_000;

const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,199}$/;
const HTTP_URL_RE = /^https:\/\//i;
const SHA256_INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected an ArrayBuffer or Uint8Array.');
}

/** Incremental SHA-256 used for archives too large for SubtleCrypto.digest. */
export function createStreamingSha256() {
  const state = new Uint32Array(SHA256_INITIAL);
  const schedule = new Uint32Array(64);
  const block = new Uint8Array(64);
  let blockLength = 0;
  let bytesHashed = 0;
  let finished = false;

  const compress = chunk => {
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      schedule[index] = (
        (chunk[offset] << 24)
        | (chunk[offset + 1] << 16)
        | (chunk[offset + 2] << 8)
        | chunk[offset + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = schedule[index - 15];
      const previous2 = schedule[index - 2];
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) >>> 0;
    }
    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + schedule[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  };

  const update = value => {
    if (finished) throw new Error('SHA-256 digest is already finalized.');
    const bytes = bytesFrom(value);
    bytesHashed += bytes.byteLength;
    if (!Number.isSafeInteger(bytesHashed)) throw new Error('SHA-256 input is too large.');
    let offset = 0;
    if (blockLength) {
      const needed = Math.min(64 - blockLength, bytes.byteLength);
      block.set(bytes.subarray(0, needed), blockLength);
      blockLength += needed;
      offset += needed;
      if (blockLength === 64) {
        compress(block);
        blockLength = 0;
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      compress(bytes.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      block.set(bytes.subarray(offset), 0);
      blockLength = bytes.byteLength - offset;
    }
    return api;
  };

  const digestHex = () => {
    if (finished) throw new Error('SHA-256 digest is already finalized.');
    finished = true;
    const bitLength = bytesHashed * 8;
    block[blockLength++] = 0x80;
    if (blockLength > 56) {
      block.fill(0, blockLength);
      compress(block);
      blockLength = 0;
    }
    block.fill(0, blockLength, 56);
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    block[56] = high >>> 24;
    block[57] = high >>> 16;
    block[58] = high >>> 8;
    block[59] = high;
    block[60] = low >>> 24;
    block[61] = low >>> 16;
    block[62] = low >>> 8;
    block[63] = low;
    compress(block);
    return [...state].map(word => word.toString(16).padStart(8, '0')).join('');
  };

  const api = Object.freeze({ update, digestHex });
  return api;
}

export async function hashBlobSha256(blob, options = {}) {
  if (!blob || typeof blob.stream !== 'function') throw new TypeError('Expected a Blob or File.');
  const signal = options.signal;
  const hasher = createStreamingSha256();
  const reader = blob.stream().getReader();
  let bytesRead = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      bytesRead += value.byteLength;
      options.onProgress?.({ phase: 'verifying', bytesReceived: bytesRead, totalBytes: blob.size });
    }
  } finally {
    try { reader.releaseLock(); } catch { /* reader may already be released */ }
  }
  return hasher.digestHex();
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
    transaction.onabort = () => reject(transaction.error || new Error('Offline corpus transaction aborted.'));
  });
}

function isClosingIdbError(error) {
  return error?.name === 'InvalidStateError'
    || /database connection is closing|connection is closing|database is closed/i.test(String(error?.message || error || ''));
}

function bindIdbLifetime(database, reset) {
  database.onversionchange = () => {
    try { database.close(); } catch { /* already closing */ }
    reset();
  };
  database.onclose = () => reset();
}

function safeKey(value, label = 'storage key') {
  const key = String(value || '').trim().toLowerCase();
  if (!SAFE_KEY_RE.test(key)) throw new Error(`Invalid Emergency Box ${label}.`);
  return key;
}

function abortError(message = 'Emergency Box text-pack operation paused.') {
  return new DOMException(message, 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason?.name === 'AbortError' ? signal.reason : abortError();
}

function parseContentRange(value) {
  const match = String(value || '').trim().match(/^bytes\s+([0-9]+)-([0-9]+)\/([0-9]+|\*)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
  return { start, end, total };
}

function normalizeIfRangeValidator(value) {
  const normalized = String(value || '').trim();
  if (/^"[^"\r\n]{0,252}"$/.test(normalized)) return normalized;
  if (normalized.length <= 128 && Number.isFinite(Date.parse(normalized))) return normalized;
  return '';
}

function responseIfRangeValidator(headers) {
  return normalizeIfRangeValidator(headers?.get?.('etag'))
    || normalizeIfRangeValidator(headers?.get?.('last-modified'));
}

function mismatchedValidator(headers, validator) {
  const headerName = validator.startsWith('"') ? 'etag' : 'last-modified';
  const raw = String(headers?.get?.(headerName) || '').trim();
  if (!raw) return false;
  const normalized = normalizeIfRangeValidator(raw);
  if (!normalized) return true;
  return headerName === 'etag' ? normalized !== validator : Date.parse(normalized) !== Date.parse(validator);
}

function completeContentRange(range, offset, totalBytes) {
  return !!range
    && range.start === offset
    && range.total === totalBytes
    && range.end + 1 === totalBytes;
}

function archiveKeyForDescriptor(descriptor) {
  return `${safeKey(descriptor.version, 'version')}-${descriptor.archiveSha256.slice(0, 20)}`;
}

function baseRecord(previous = {}) {
  return {
    id: EMERGENCY_CORPUS_ID,
    status: 'not-installed',
    active: null,
    staging: null,
    error: '',
    ...previous,
  };
}

export function validateEmergencyCorpusDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Emergency Box text-pack descriptor must be an object.');
  }
  if (value.id !== EMERGENCY_CORPUS_ID) throw new Error('Unexpected Emergency Box text-pack id.');
  const version = String(value.version || '').trim().toLowerCase();
  safeKey(version, 'version');
  const url = String(value.url || '').trim();
  if (!HTTP_URL_RE.test(url)) throw new Error('Emergency Box text-pack URL must use HTTPS.');
  const archiveSha256 = String(value.archiveSha256 || '').trim().toLowerCase();
  if (!SHA256_RE.test(archiveSha256)) throw new Error('Emergency Box archive SHA-256 is invalid.');
  const downloadBytes = Number(value.downloadBytes);
  if (!Number.isSafeInteger(downloadBytes) || downloadBytes <= 0 || downloadBytes > MAX_EMERGENCY_ARCHIVE_BYTES) {
    throw new Error('Emergency Box archive size is invalid or exceeds the 2 GiB safety limit.');
  }
  return Object.freeze({ id: EMERGENCY_CORPUS_ID, version, url, archiveSha256, downloadBytes });
}

export function createEmergencyCorpusStore(indexedDb = globalThis.indexedDB) {
  let databasePromise;
  const reset = () => { databasePromise = null; };
  const open = () => {
    if (!indexedDb) return Promise.reject(new Error('IndexedDB is unavailable.'));
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDb.open(EMERGENCY_CORPUS_DB_NAME, EMERGENCY_CORPUS_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(EMERGENCY_CORPUS_STORE)) {
          database.createObjectStore(EMERGENCY_CORPUS_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        bindIdbLifetime(request.result, reset);
        resolve(request.result);
      };
      request.onerror = () => {
        reset();
        reject(request.error);
      };
    });
    return databasePromise;
  };
  const withDatabase = async fn => {
    try {
      return await fn(await open());
    } catch (error) {
      if (!isClosingIdbError(error)) throw error;
      reset();
      await new Promise(resolve => setTimeout(resolve, 50));
      return await fn(await open());
    }
  };
  return Object.freeze({
    async get() {
      return await withDatabase(database => idbRequest(
        database.transaction(EMERGENCY_CORPUS_STORE, 'readonly')
          .objectStore(EMERGENCY_CORPUS_STORE).get(EMERGENCY_CORPUS_ID),
      ));
    },
    async put(record) {
      const normalized = baseRecord({ ...record, id: EMERGENCY_CORPUS_ID, updatedAt: Date.now() });
      await withDatabase(async database => {
        const transaction = database.transaction(EMERGENCY_CORPUS_STORE, 'readwrite');
        transaction.objectStore(EMERGENCY_CORPUS_STORE).put(normalized);
        await idbTransaction(transaction);
      });
      return normalized;
    },
    async delete() {
      await withDatabase(async database => {
        const transaction = database.transaction(EMERGENCY_CORPUS_STORE, 'readwrite');
        transaction.objectStore(EMERGENCY_CORPUS_STORE).delete(EMERGENCY_CORPUS_ID);
        await idbTransaction(transaction);
      });
    },
  });
}

async function getChildDirectory(parent, name, create) {
  return await parent.getDirectoryHandle(safeKey(name, 'directory'), { create });
}

async function removeEntryIfPresent(directory, name, options = {}) {
  try {
    await directory.removeEntry(name, options);
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error;
  }
}

export function createEmergencyCorpusStorage(storageManager = globalThis.navigator?.storage) {
  const rootDirectory = async (create = true) => {
    if (typeof storageManager?.getDirectory !== 'function') {
      throw new Error('Origin Private File System storage is unavailable in this browser.');
    }
    const root = await storageManager.getDirectory();
    return await root.getDirectoryHandle(EMERGENCY_CORPUS_DIRECTORY, { create });
  };
  const corpusDirectory = async (create = true) => {
    return await (await rootDirectory(create)).getDirectoryHandle(EMERGENCY_CORPUS_ID, { create });
  };
  const downloadsDirectory = async (create = true) => {
    return await (await corpusDirectory(create)).getDirectoryHandle('downloads', { create });
  };
  const installsDirectory = async (create = true) => {
    return await (await corpusDirectory(create)).getDirectoryHandle('installs', { create });
  };
  const installDirectory = async (installId, create = true) => {
    return await getChildDirectory(await installsDirectory(create), installId, create);
  };
  const archiveFilename = archiveKey => `${safeKey(archiveKey, 'archive key')}.zip`;
  const archiveHandle = async (archiveKey, create = false) => {
    return await (await downloadsDirectory(create)).getFileHandle(archiveFilename(archiveKey), { create });
  };
  const installFileHandle = async (installId, archivePath, create = false) => {
    const path = validateArchivePath(archivePath);
    const parts = path.split('/');
    const filename = parts.pop();
    let directory = await installDirectory(installId, create);
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
    return await directory.getFileHandle(filename, { create });
  };
  return Object.freeze({
    async openArchive(archiveKey) {
      return await (await archiveHandle(archiveKey)).getFile();
    },
    async archiveSize(archiveKey) {
      try { return (await this.openArchive(archiveKey)).size; }
      catch (error) { if (error?.name === 'NotFoundError') return 0; throw error; }
    },
    async createArchiveWriter(archiveKey) {
      const writable = await (await archiveHandle(archiveKey, true)).createWritable({ keepExistingData: true });
      let settled = false;
      return Object.freeze({
        async write(position, bytes) {
          if (settled) throw new Error('Archive writer is already closed.');
          await writable.write({ type: 'write', position, data: bytes });
        },
        async truncate(size) {
          if (settled) throw new Error('Archive writer is already closed.');
          await writable.truncate(size);
        },
        async close() { if (!settled) { await writable.close(); settled = true; } },
        async abort(reason) { if (!settled) { await writable.abort(reason); settled = true; } },
      });
    },
    async deleteArchive(archiveKey) {
      let directory;
      try { directory = await downloadsDirectory(false); }
      catch (error) { if (error?.name === 'NotFoundError') return; throw error; }
      await removeEntryIfPresent(directory, archiveFilename(archiveKey));
    },
    async writeInstallFile(installId, archivePath, value) {
      const writable = await (await installFileHandle(installId, archivePath, true)).createWritable();
      try {
        await writable.write(bytesFrom(value));
        await writable.close();
      } catch (error) {
        try { await writable.abort(error); } catch { /* preserve original error */ }
        throw error;
      }
    },
    async createInstallFileWriter(installId, archivePath) {
      const writable = await (await installFileHandle(installId, archivePath, true)).createWritable();
      let position = 0;
      let settled = false;
      return Object.freeze({
        async write(value) {
          if (settled) throw new Error('Install-file writer is already closed.');
          const bytes = bytesFrom(value);
          await writable.write({ type: 'write', position, data: bytes });
          position += bytes.byteLength;
        },
        async close() { if (!settled) { await writable.close(); settled = true; } },
        async abort(reason) { if (!settled) { await writable.abort(reason); settled = true; } },
      });
    },
    async readInstallFile(installId, archivePath) {
      return await (await installFileHandle(installId, archivePath)).getFile();
    },
    async deleteInstallFile(installId, archivePath) {
      const path = validateArchivePath(archivePath);
      const parts = path.split('/');
      const filename = parts.pop();
      let directory = await installDirectory(installId, false);
      for (const part of parts) directory = await directory.getDirectoryHandle(part);
      await removeEntryIfPresent(directory, filename);
    },
    async deleteInstall(installId) {
      let directory;
      try { directory = await installsDirectory(false); }
      catch (error) { if (error?.name === 'NotFoundError') return; throw error; }
      await removeEntryIfPresent(directory, safeKey(installId, 'install id'), { recursive: true });
    },
    async listInstallIds() {
      let directory;
      try { directory = await installsDirectory(false); }
      catch (error) { if (error?.name === 'NotFoundError') return []; throw error; }
      const ids = [];
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === 'directory') ids.push(name);
      }
      return ids.sort();
    },
  });
}

export async function withEmergencyCorpusLock(task, options = {}) {
  const lockManager = options.lockManager ?? globalThis.navigator?.locks;
  if (typeof lockManager?.request !== 'function') return await task();
  const lockOptions = { mode: 'exclusive' };
  if (options.signal) lockOptions.signal = options.signal;
  if (options.ifAvailable) lockOptions.ifAvailable = true;
  return await lockManager.request('webbrain-emergency-corpus', lockOptions, async (lock) => {
    if (options.ifAvailable && !lock) {
      if (typeof options.onLockUnavailable === 'function') {
        return await options.onLockUnavailable();
      }
      return null;
    }
    return await task(lock);
  });
}

async function persistState(store, current, patch, onProgress) {
  const record = await store.put(baseRecord({ ...current, ...patch, updatedAt: Date.now() }));
  onProgress(record);
  return record;
}

async function verifyDownloadedArchive(descriptor, archiveKey, storage, options = {}) {
  const file = await storage.openArchive(archiveKey);
  if (file.size !== descriptor.downloadBytes) {
    throw new Error(`Emergency Box archive size mismatch: expected ${descriptor.downloadBytes}, received ${file.size}.`);
  }
  const actualSha256 = await hashBlobSha256(file, options);
  if (actualSha256 !== descriptor.archiveSha256) {
    throw new Error(`Emergency Box archive checksum mismatch (expected ${descriptor.archiveSha256}, received ${actualSha256}).`);
  }
  return file;
}

async function downloadEmergencyCorpusArchive(descriptor, options) {
  const { store, storage, fetchImpl, signal, onProgress } = options;
  let current = baseRecord(await store.get() || {});
  const archiveKey = archiveKeyForDescriptor(descriptor);
  const matchingStaging = current.staging?.archiveKey === archiveKey
    && current.staging?.url === descriptor.url
    && current.staging?.archiveSha256 === descriptor.archiveSha256;
  if (!matchingStaging && current.staging) {
    if (current.staging.installId) await storage.deleteInstall(current.staging.installId).catch(() => {});
    if (current.staging.indexPath) await options.deleteIndex?.(current.staging.indexPath).catch(() => {});
    if (current.staging.archiveKey) await storage.deleteArchive(current.staging.archiveKey).catch(() => {});
  }
  let offset = matchingStaging ? await storage.archiveSize(archiveKey) : 0;
  let committedValidator = matchingStaging ? normalizeIfRangeValidator(current.staging?.ifRangeValidator) : '';
  if (offset > 0 && offset < descriptor.downloadBytes && !committedValidator) offset = 0;
  const staging = {
    archiveKey,
    archiveSha256: descriptor.archiveSha256,
    version: descriptor.version,
    url: descriptor.url,
    bytesReceived: offset,
    totalBytes: descriptor.downloadBytes,
    ifRangeValidator: committedValidator,
    phase: 'downloading',
    startedAt: matchingStaging ? current.staging.startedAt || Date.now() : Date.now(),
  };
  current = await persistState(store, current, { status: 'downloading', staging, error: '' }, onProgress);

  let writer;
  let response;
  let reader;
  let pendingValidator = committedValidator;
  let pendingRepresentationStarted = false;
  let rollbackWriter = false;
  let lastPersistedAt = 0;
  const fetchResponse = async headers => {
    const next = await fetchImpl(descriptor.url, { headers, signal });
    if (!next.ok) {
      try { await next.body?.cancel?.(); } catch { /* preserve HTTP error */ }
      throw new Error(`Emergency Box text-pack download returned HTTP ${next.status}.`);
    }
    return next;
  };
  try {
    throwIfAborted(signal);
    if (offset === descriptor.downloadBytes) {
      current = await persistState(store, current, {
        status: 'verifying', staging: { ...staging, phase: 'verifying' },
      }, onProgress);
      await verifyDownloadedArchive(descriptor, archiveKey, storage, { signal, onProgress });
      return await persistState(store, current, {
        status: 'downloaded',
        staging: { ...staging, phase: 'downloaded', bytesReceived: descriptor.downloadBytes, verifiedAt: Date.now() },
      }, onProgress);
    }
    response = await fetchResponse(offset > 0
      ? { Range: `bytes=${offset}-`, 'If-Range': committedValidator }
      : undefined);
    let range = parseContentRange(response.headers?.get?.('content-range'));
    if (offset > 0 && (
      response.status !== 206
      || !completeContentRange(range, offset, descriptor.downloadBytes)
      || mismatchedValidator(response.headers, committedValidator)
    )) {
      try { await response.body?.cancel?.(); } catch { /* retry full representation */ }
      response = await fetchResponse(undefined);
      offset = 0;
      range = parseContentRange(response.headers?.get?.('content-range'));
    }
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`Emergency Box text-pack download returned unexpected HTTP ${response.status}.`);
    }
    if (response.status === 206 && !completeContentRange(range, offset, descriptor.downloadBytes)) {
      throw new Error('Emergency Box text-pack returned an incomplete or mismatched Content-Range.');
    }
    if (offset === 0) pendingValidator = responseIfRangeValidator(response.headers);
    const contentLength = Number(response.headers?.get?.('content-length')) || 0;
    if (contentLength && offset + contentLength !== descriptor.downloadBytes) {
      throw new Error('Emergency Box text-pack Content-Length does not match its signed descriptor.');
    }
    writer = await storage.createArchiveWriter(archiveKey);
    if (offset === 0) {
      await writer.truncate(0);
      pendingRepresentationStarted = true;
    }
    reader = response.body?.getReader?.();
    if (!reader) throw new Error('Streaming downloads are unavailable in this browser.');
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > descriptor.downloadBytes) {
        rollbackWriter = true;
        throw new Error('Emergency Box text-pack exceeded its declared size.');
      }
      await writer.write(offset, value);
      offset += value.byteLength;
      const progress = {
        ...staging,
        bytesReceived: offset,
        ifRangeValidator: committedValidator,
        phase: 'downloading',
      };
      const now = Date.now();
      if (now - lastPersistedAt >= 500) {
        lastPersistedAt = now;
        current = await persistState(store, current, { status: 'downloading', staging: progress }, onProgress);
      } else {
        onProgress(baseRecord({ ...current, status: 'downloading', staging: progress }));
      }
    }
    if (offset !== descriptor.downloadBytes) {
      rollbackWriter = true;
      throw new Error('Emergency Box text-pack ended before its declared size.');
    }
    await writer.close();
    writer = null;
    committedValidator = pendingValidator;
    current = await persistState(store, current, {
      status: 'verifying',
      staging: { ...staging, bytesReceived: offset, ifRangeValidator: committedValidator, phase: 'verifying' },
    }, onProgress);
    await verifyDownloadedArchive(descriptor, archiveKey, storage, { signal, onProgress });
    return await persistState(store, current, {
      status: 'downloaded',
      staging: {
        ...staging,
        bytesReceived: offset,
        ifRangeValidator: committedValidator,
        phase: 'downloaded',
        verifiedAt: Date.now(),
      },
    }, onProgress);
  } catch (error) {
    try { await reader?.cancel?.(error); } catch { /* preserve original error */ }
    if (writer) {
      if (rollbackWriter) {
        try { await writer.abort(error); } catch { /* never commit invalid bytes */ }
      } else {
        try {
          await writer.close();
          if (pendingRepresentationStarted) committedValidator = pendingValidator;
        } catch {
          try { await writer.abort(error); } catch { /* preserve original error */ }
        }
      }
    }
    const paused = error?.name === 'AbortError' || signal?.aborted;
    const bytesReceived = await storage.archiveSize(archiveKey).catch(() => 0);
    if (!paused) await storage.deleteArchive(archiveKey).catch(() => {});
    current = await persistState(store, current, {
      status: paused ? 'paused' : 'error',
      error: paused ? '' : String(error?.message || error),
      staging: {
        ...staging,
        bytesReceived: paused ? bytesReceived : 0,
        ifRangeValidator: paused ? committedValidator : '',
        phase: paused ? 'downloading' : 'error',
      },
    }, onProgress);
    if (!paused) throw error;
    return current;
  }
}

export async function downloadEmergencyCorpus(descriptorValue, options = {}) {
  const descriptor = validateEmergencyCorpusDescriptor(descriptorValue);
  const store = options.store || createEmergencyCorpusStore();
  const storage = options.storage || createEmergencyCorpusStorage();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Network access is unavailable.');
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  return await withEmergencyCorpusLock(
    () => downloadEmergencyCorpusArchive(descriptor, {
      store, storage, fetchImpl, signal: options.signal, onProgress,
    }),
    { lockManager: options.lockManager, signal: options.signal },
  );
}

function concatenateChunks(chunks, totalBytes) {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function extractEmergencyCorpusArchive(archive, options = {}) {
  if (!archive || typeof archive.stream !== 'function') throw new TypeError('Expected an Emergency Box ZIP Blob.');
  const storage = options.storage;
  const installId = safeKey(options.installId, 'install id');
  if (!storage?.writeInstallFile || !storage?.readInstallFile) {
    throw new Error('Emergency Box extraction storage is unavailable.');
  }
  const fflate = options.fflate || await import('../../vendor/fflate/browser.js');
  if (typeof fflate?.Unzip !== 'function' || typeof fflate?.UnzipInflate !== 'function') {
    throw new Error('Bundled ZIP extraction runtime is unavailable.');
  }
  const signal = options.signal;
  const entryNames = [];
  const entrySet = new Set();
  const pendingWrites = [];
  let extractedBytes = 0;
  let manifestBytes = null;
  let extractionError = null;
  let entriesExtracted = 0;

  const unzip = new fflate.Unzip(file => {
    let name;
    try {
      name = validateArchivePath(file.name);
      if (entrySet.has(name)) throw new Error(`Emergency Box ZIP contains duplicate entry ${name}.`);
      if (entryNames.length >= (options.maximumEntries || MAX_EMERGENCY_ZIP_ENTRIES)) {
        throw new Error('Emergency Box ZIP contains too many entries.');
      }
      entrySet.add(name);
      entryNames.push(name);
    } catch (error) {
      extractionError = extractionError || error;
    }
    const maximumEntryBytes = name === 'manifest.json'
      ? (options.maximumManifestBytes || MAX_EMERGENCY_MANIFEST_BYTES)
      : name?.startsWith('indexes/')
        ? (options.maximumIndexBytes || MAX_EMERGENCY_INDEX_BYTES)
        : (options.maximumDocumentBytes || MAX_EMERGENCY_DOCUMENT_BYTES);
    if (Number.isSafeInteger(file.originalSize) && file.originalSize > maximumEntryBytes) {
      extractionError = extractionError || new Error(`Emergency Box ZIP entry ${name || file.name} exceeds its size limit.`);
    }
    let size = 0;
    const chunks = [];
    const streamEntry = name?.startsWith('indexes/') && typeof storage.createInstallFileWriter === 'function';
    const writerPromise = streamEntry ? storage.createInstallFileWriter(installId, name) : null;
    let writeChain = Promise.resolve();
    file.ondata = (error, chunk, final) => {
      if (error) {
        extractionError = extractionError || error;
        return;
      }
      if (chunk?.byteLength) {
        size += chunk.byteLength;
        extractedBytes += chunk.byteLength;
        if (size > maximumEntryBytes || extractedBytes > (options.maximumExtractedBytes || MAX_EMERGENCY_EXTRACTED_BYTES)) {
          extractionError = extractionError || new Error(`Emergency Box ZIP entry ${name || file.name} exceeds extraction limits.`);
          return;
        }
        const copy = new Uint8Array(chunk);
        if (streamEntry) writeChain = writeChain.then(async () => (await writerPromise).write(copy));
        else chunks.push(copy);
      }
      if (final && name && !extractionError) {
        if (streamEntry) pendingWrites.push(writeChain.then(async () => (await writerPromise).close()));
        else {
          const bytes = concatenateChunks(chunks, size);
          if (name === 'manifest.json') manifestBytes = bytes;
          pendingWrites.push(storage.writeInstallFile(installId, name, bytes));
        }
        entriesExtracted += 1;
        options.onProgress?.({
          phase: 'extracting', entriesExtracted, extractedBytes, archiveBytes: archive.size,
        });
      }
    };
    try { file.start(); }
    catch (error) { extractionError = extractionError || error; }
  });
  unzip.register(fflate.UnzipInflate);

  const reader = archive.stream().getReader();
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        unzip.push(new Uint8Array(), true);
        break;
      }
      unzip.push(value, false);
      if (pendingWrites.length) await Promise.all(pendingWrites.splice(0));
      if (extractionError) throw extractionError;
      await Promise.resolve();
    }
    if (pendingWrites.length) await Promise.all(pendingWrites.splice(0));
    if (extractionError) throw extractionError;
  } finally {
    try { reader.releaseLock(); } catch { /* reader may already be released */ }
  }
  if (!manifestBytes) throw new Error('Emergency Box ZIP is missing manifest.json.');
  let manifestValue;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
    manifestValue = JSON.parse(json);
  } catch (error) {
    throw new Error(`Emergency Box manifest is not valid UTF-8 JSON: ${error?.message || error}`);
  }
  const manifest = validateEmergencyCorpusManifest(manifestValue, entryNames);
  let documentsVerified = 0;
  for (const document of manifest.documents) {
    throwIfAborted(signal);
    const file = await storage.readInstallFile(installId, document.path);
    const verified = await verifyEmergencyDocument(document, await file.arrayBuffer());
    if (verified.bytes.byteLength > (options.maximumDocumentBytes || MAX_EMERGENCY_DOCUMENT_BYTES)) {
      throw new Error(`Emergency Box document ${document.path} exceeds its size limit.`);
    }
    documentsVerified += 1;
    options.onProgress?.({
      phase: 'verifying-documents', documentsVerified, documentCount: manifest.documents.length,
    });
  }
  const contentSha256 = await computeCorpusContentSha256(manifest.documents);
  if (contentSha256 !== manifest.contentSha256) {
    throw new Error(`Emergency Box corpus checksum mismatch (expected ${manifest.contentSha256}, received ${contentSha256}).`);
  }
  let indexesVerified = 0;
  for (const index of Object.values(manifest.indexes || {})) {
    throwIfAborted(signal);
    const file = await storage.readInstallFile(installId, index.path);
    if (file.size !== index.bytes) throw new Error(`Emergency Box index ${index.path} has an invalid size.`);
    const actualSha256 = await hashBlobSha256(file, { signal });
    if (actualSha256 !== index.sha256) {
      throw new Error(`Emergency Box index checksum mismatch for ${index.path}.`);
    }
    indexesVerified += 1;
    options.onProgress?.({
      phase: 'verifying-indexes', indexesVerified, indexCount: Object.keys(manifest.indexes).length,
    });
  }
  return Object.freeze({ manifest, entryNames: Object.freeze(entryNames), extractedBytes });
}

function validateIndexResult(value, expectedPath = '') {
  if (!value || typeof value !== 'object') throw new Error('Emergency Box indexer returned no result.');
  const passageCount = Number(value.passageCount);
  const indexBytes = Number(value.indexBytes);
  const indexPath = validateArchivePath(String(value.indexPath || ''));
  if (!Number.isSafeInteger(passageCount) || passageCount <= 0) {
    throw new Error('Emergency Box indexer produced no searchable passages.');
  }
  if (!Number.isSafeInteger(indexBytes) || indexBytes <= 0) {
    throw new Error('Emergency Box indexer produced an empty index.');
  }
  if (expectedPath && indexPath !== expectedPath) {
    throw new Error('Emergency Box indexer returned an unexpected database path.');
  }
  return Object.freeze({ passageCount, indexBytes, indexPath });
}

async function installEmergencyCorpusUnlocked(descriptor, options) {
  const { store, storage, signal, onProgress } = options;
  let current = baseRecord(await store.get() || {});
  const archiveKey = archiveKeyForDescriptor(descriptor);
  if (
    current.staging?.archiveKey !== archiveKey
    || current.staging?.archiveSha256 !== descriptor.archiveSha256
    || current.staging?.phase !== 'downloaded'
  ) {
    throw new Error('The verified Emergency Box text pack must be downloaded before installation.');
  }
  const archive = await verifyDownloadedArchive(descriptor, archiveKey, storage, { signal, onProgress });
  const installId = safeKey(
    options.installId || `${descriptor.version}-${descriptor.archiveSha256.slice(0, 12)}-${Date.now().toString(36)}`,
    'install id',
  );
  const indexPath = `sqlite/${installId}.sqlite3`;
  const previousActive = current.active;
  await storage.deleteInstall(installId).catch(() => {});
  current = await persistState(store, current, {
    status: 'extracting', error: '',
    staging: { ...current.staging, phase: 'extracting', installId, indexPath },
  }, onProgress);
  try {
    const extracted = await (options.extractArchive || extractEmergencyCorpusArchive)(archive, {
      storage, installId, signal, onProgress, fflate: options.fflate,
    });
    if (extracted.manifest.version !== descriptor.version) {
      throw new Error(`Emergency Box manifest version ${extracted.manifest.version} does not match descriptor ${descriptor.version}.`);
    }
    if (extracted.manifest.downloadBytes !== descriptor.downloadBytes) {
      throw new Error('Emergency Box manifest downloadBytes does not match the signed descriptor.');
    }
    current = await persistState(store, current, {
      status: 'indexing',
      staging: {
        ...current.staging, phase: 'indexing', installId, indexPath,
        manifest: extracted.manifest,
      },
    }, onProgress);
    if (typeof options.buildIndex !== 'function') {
      throw new Error('Emergency Box SQLite indexer is unavailable.');
    }
    const index = validateIndexResult(await options.buildIndex({
      manifest: extracted.manifest, installId, indexPath, storage, signal, onProgress,
    }), indexPath);
    throwIfAborted(signal);
    const activatedAt = Date.now();
    const active = Object.freeze({
      installId,
      version: extracted.manifest.version,
      contentSha256: extracted.manifest.contentSha256,
      archiveSha256: descriptor.archiveSha256,
      documentCount: extracted.manifest.documents.length,
      passageCount: index.passageCount,
      extractedBytes: Math.max(0, extracted.extractedBytes - Number(extracted.manifest.indexes?.fts5?.bytes || 0)),
      indexBytes: index.indexBytes,
      indexPath: index.indexPath,
      ftsIndex: extracted.manifest.indexes?.fts5 || null,
      vectorIndex: extracted.manifest.indexes?.vector || null,
      manifest: extracted.manifest,
      activatedAt,
    });
    current = await persistState(store, current, {
      status: 'ready', active, staging: null, error: '',
    }, onProgress);
    if (previousActive?.installId && previousActive.installId !== installId) {
      await storage.deleteInstall(previousActive.installId).catch(() => {});
    }
    if (previousActive?.indexPath && previousActive.indexPath !== indexPath) {
      await options.deleteIndex?.(previousActive.indexPath).catch(() => {});
    }
    await storage.deleteArchive(archiveKey).catch(() => {});
    return current;
  } catch (error) {
    await storage.deleteInstall(installId).catch(() => {});
    await options.deleteIndex?.(indexPath).catch(() => {});
    const paused = error?.name === 'AbortError' || signal?.aborted;
    current = await persistState(store, current, {
      status: paused ? 'paused' : 'error',
      active: previousActive || null,
      error: paused ? '' : String(error?.message || error),
      staging: {
        ...current.staging,
        installId: null,
        indexPath: null,
        phase: 'downloaded',
        manifest: null,
      },
    }, onProgress);
    if (!paused) throw error;
    return current;
  }
}

export async function installEmergencyCorpus(descriptorValue, options = {}) {
  const descriptor = validateEmergencyCorpusDescriptor(descriptorValue);
  const store = options.store || createEmergencyCorpusStore();
  const storage = options.storage || createEmergencyCorpusStorage();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  return await withEmergencyCorpusLock(
    () => installEmergencyCorpusUnlocked(descriptor, { ...options, store, storage, onProgress }),
    { lockManager: options.lockManager, signal: options.signal },
  );
}

export async function downloadAndInstallEmergencyCorpus(descriptorValue, options = {}) {
  const descriptor = validateEmergencyCorpusDescriptor(descriptorValue);
  const store = options.store || createEmergencyCorpusStore();
  const storage = options.storage || createEmergencyCorpusStorage();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  return await withEmergencyCorpusLock(async () => {
    const downloaded = await downloadEmergencyCorpusArchive(descriptor, {
      store, storage, fetchImpl: options.fetchImpl || globalThis.fetch,
      signal: options.signal, onProgress,
    });
    if (downloaded.status !== 'downloaded') return downloaded;
    return await installEmergencyCorpusUnlocked(descriptor, {
      ...options, store, storage, onProgress,
    });
  }, { lockManager: options.lockManager, signal: options.signal });
}

export async function recoverEmergencyCorpusLifecycle(options = {}) {
  const store = options.store || createEmergencyCorpusStore();
  const storage = options.storage || createEmergencyCorpusStorage();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  return await withEmergencyCorpusLock(async () => {
    let current = baseRecord(await store.get() || {});
    const interrupted = ['downloading', 'verifying', 'extracting', 'indexing'].includes(current.status);
    if (interrupted && current.staging?.installId) {
      await storage.deleteInstall(current.staging.installId).catch(() => {});
    }
    if (interrupted && current.staging?.indexPath) {
      await options.deleteIndex?.(current.staging.indexPath).catch(() => {});
    }
    if (interrupted) {
      const archiveBytes = current.staging?.archiveKey
        ? await storage.archiveSize(current.staging.archiveKey).catch(() => 0)
        : 0;
      const downloaded = archiveBytes === current.staging?.totalBytes
        && current.staging?.phase !== 'downloading';
      current = await persistState(store, current, {
        status: downloaded ? 'downloaded' : 'paused',
        error: '',
        staging: current.staging ? {
          ...current.staging,
          installId: null,
          indexPath: null,
          manifest: null,
          bytesReceived: archiveBytes,
          phase: downloaded ? 'downloaded' : 'downloading',
        } : null,
      }, onProgress);
    }
    const keep = new Set([
      current.active?.installId,
      current.staging?.installId,
    ].filter(Boolean));
    for (const installId of await storage.listInstallIds()) {
      if (!keep.has(installId)) await storage.deleteInstall(installId).catch(() => {});
    }
    return current;
  }, {
    lockManager: options.lockManager,
    ifAvailable: options.ifAvailable ?? true,
    onLockUnavailable: async () => baseRecord(await store.get() || {}),
  });
}

export async function cancelEmergencyCorpusInstall(options = {}) {
  const store = options.store || createEmergencyCorpusStore();
  const storage = options.storage || createEmergencyCorpusStorage();
  return await withEmergencyCorpusLock(async () => {
    const current = baseRecord(await store.get() || {});
    if (current.staging?.installId) await storage.deleteInstall(current.staging.installId).catch(() => {});
    if (current.staging?.indexPath) await options.deleteIndex?.(current.staging.indexPath).catch(() => {});
    if (current.staging?.archiveKey) await storage.deleteArchive(current.staging.archiveKey).catch(() => {});
    return await store.put({
      ...current,
      status: current.active ? 'ready' : 'not-installed',
      staging: null,
      error: '',
    });
  }, { lockManager: options.lockManager });
}

export async function deleteEmergencyCorpus(options = {}) {
  const store = options.store || createEmergencyCorpusStore(options.indexedDb);
  const storage = options.storage || createEmergencyCorpusStorage(options.opfsRoot);
  const current = baseRecord(await store.get() || {});
  if (current.active?.installId && !options.force && !options.allowWhileEnabled) {
    const apocalypseStore = options.apocalypseStore || createApocalypseStore(options.indexedDb || globalThis.indexedDB);
    const apocalypseConfig = await apocalypseStore.getConfig().catch(() => null);
    if (apocalypseConfig?.enabled === true) {
      throw new Error('Cannot delete emergency corpus while Apocalypse Mode is enabled. Disable Apocalypse Mode first.');
    }
  }
  return await withEmergencyCorpusLock(async () => {
    if (current.active?.indexPath) await options.deleteIndex?.(current.active.indexPath).catch(() => {});
    if (current.active?.installId) await storage.deleteInstall(current.active.installId).catch(() => {});
    if (current.staging?.indexPath) await options.deleteIndex?.(current.staging.indexPath).catch(() => {});
    if (current.staging?.installId) await storage.deleteInstall(current.staging.installId).catch(() => {});
    if (current.staging?.archiveKey) await storage.deleteArchive(current.staging.archiveKey).catch(() => {});
    await store.delete();
    return true;
  }, { lockManager: options.lockManager });
}
