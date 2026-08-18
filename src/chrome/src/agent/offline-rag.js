/**
 * Browser-neutral retrieval and corpus integrity primitives for Apocalypse Mode.
 *
 * This module performs no network access and never downloads a model or corpus.
 * Keep the Chrome and Firefox copies byte-identical.
 */

export const RAG_SOURCE_KINDS = Object.freeze(['wikipedia', 'emergency-box']);
export const EMERGENCY_CORPUS_SCHEMA_VERSION = 2;
export const EMERGENCY_CORPUS_ID = 'emergency-box-text';
export const MAX_LEXICAL_CANDIDATES_PER_SOURCE = 40;
export const MAX_GLOBAL_LEXICAL_CANDIDATES = 80;
export const MAX_FINAL_PASSAGES = 8;
export const MAX_PASSAGES_PER_DOCUMENT = 2;
export const EMERGENCY_PASSAGE_SCHEMA_VERSION = 2;
export const MIN_PASSAGE_TOKENS = 180;
export const MAX_PASSAGE_TOKENS = 700;
export const MAX_EVIDENCE_TOKENS = 6000;
export const VECTOR_CACHE_MAX_BYTES = 256 * 1024 * 1024;

const SHA256_RE = /^[a-f0-9]{64}$/;
const STABLE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,159}$/;
const LANGUAGE_RE = /^[a-z]{3}$/;
const HTTP_URL_RE = /^https?:\/\//i;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]/u;
const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const HEADING_RE = /^(?:#{1,6}\s+.+|(?:chapter|section|part|appendix)\s+[\p{L}\p{N}].*|\d+(?:\.\d+){0,4}[.):]?\s+\S.*)$/iu;

export class RagValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RagValidationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new RagValidationError(code, message, details);
}

function nonEmptyString(value, field, maximum = 2048) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid-field', 'Manifest field ' + field + ' must be a non-empty string.', { field });
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    fail('invalid-field', 'Manifest field ' + field + ' is too long.', { field });
  }
  return normalized;
}

export function validateArchivePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    fail('invalid-path', 'Archive entry path is empty or contains a NUL byte.');
  }
  if (value.includes('\\')) {
    fail('invalid-path', 'Archive entry paths must use forward slashes.', { path: value });
  }
  if (value.startsWith('/') || /^[a-z]:/i.test(value)) {
    fail('absolute-path', 'Absolute archive entry paths are not allowed.', { path: value });
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    fail('path-traversal', 'Archive entry path contains an empty or traversal segment.', { path: value });
  }
  const normalized = parts.join('/');
  if (normalized !== value) {
    fail('invalid-path', 'Archive entry path is not normalized.', { path: value });
  }
  return normalized;
}

export function validateZipEntryNames(entryNames = []) {
  if (!Array.isArray(entryNames)) {
    fail('invalid-entries', 'ZIP entry names must be an array.');
  }
  const seen = new Set();
  const normalized = [];
  for (const rawName of entryNames) {
    const name = validateArchivePath(rawName);
    if (seen.has(name)) {
      fail('duplicate-entry', 'ZIP contains a duplicate entry: ' + name, { path: name });
    }
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

export function validateEmergencyCorpusManifest(manifest, entryNames = null) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('invalid-manifest', 'Corpus manifest must be a JSON object.');
  }
  if (![1, EMERGENCY_CORPUS_SCHEMA_VERSION].includes(manifest.schemaVersion)) {
    fail(
      'unsupported-schema',
      'Unsupported Emergency Box corpus schema version: ' + String(manifest.schemaVersion),
      { expected: [1, EMERGENCY_CORPUS_SCHEMA_VERSION], actual: manifest.schemaVersion },
    );
  }
  if (manifest.corpusId !== EMERGENCY_CORPUS_ID) {
    fail('invalid-corpus-id', 'Unexpected corpusId: ' + String(manifest.corpusId));
  }
  const version = nonEmptyString(manifest.version, 'version', 120);
  const contentSha256 = nonEmptyString(manifest.contentSha256, 'contentSha256', 64).toLowerCase();
  if (!SHA256_RE.test(contentSha256)) {
    fail('invalid-checksum', 'Manifest contentSha256 must be a lowercase SHA-256 hex digest.');
  }
  if (!Number.isSafeInteger(manifest.downloadBytes) || manifest.downloadBytes < 0) {
    fail('invalid-size', 'Manifest downloadBytes must be a non-negative safe integer.');
  }
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    fail('invalid-documents', 'Corpus manifest must declare at least one document.');
  }

  const ids = new Set();
  const paths = new Set();
  const documents = manifest.documents.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      fail('invalid-document', 'Manifest document at index ' + index + ' must be an object.');
    }
    const id = nonEmptyString(source.id, 'documents[' + index + '].id', 160);
    if (!STABLE_ID_RE.test(id)) {
      fail('invalid-document-id', 'Document id is not a stable lowercase identifier: ' + id, { id });
    }
    if (ids.has(id)) fail('duplicate-document-id', 'Duplicate document id: ' + id, { id });
    ids.add(id);

    const title = nonEmptyString(source.title, 'documents[' + index + '].title', 500);
    const language = nonEmptyString(source.language, 'documents[' + index + '].language', 3);
    if (!LANGUAGE_RE.test(language)) {
      fail('invalid-language', 'Document language must be a lowercase ISO 639-3 code.', { id, language });
    }
    const collection = nonEmptyString(source.collection, 'documents[' + index + '].collection', 200);
    const sourceUrl = nonEmptyString(source.sourceUrl, 'documents[' + index + '].sourceUrl', 2048);
    if (!HTTP_URL_RE.test(sourceUrl)) {
      fail('invalid-source-url', 'Document sourceUrl must be HTTP(S).', { id });
    }
    const license = nonEmptyString(source.license, 'documents[' + index + '].license', 500);
    const path = validateArchivePath(nonEmptyString(source.path, 'documents[' + index + '].path', 512));
    const expectedPath = 'documents/' + id + '.txt';
    if (path !== expectedPath) {
      fail('invalid-document-path', 'Document path must match its stable id: ' + expectedPath, { id, path });
    }
    if (paths.has(path)) fail('duplicate-document-path', 'Duplicate document path: ' + path, { path });
    paths.add(path);
    const sha256 = nonEmptyString(source.sha256, 'documents[' + index + '].sha256', 64).toLowerCase();
    if (!SHA256_RE.test(sha256)) {
      fail('invalid-checksum', 'Document sha256 must be a lowercase SHA-256 hex digest.', { id });
    }
    return Object.freeze({ id, title, language, collection, sourceUrl, license, path, sha256 });
  });

  let passageSchemaVersion = 1;
  let indexes = null;
  if (manifest.schemaVersion === EMERGENCY_CORPUS_SCHEMA_VERSION) {
    passageSchemaVersion = Number(manifest.passageSchemaVersion);
    if (passageSchemaVersion !== EMERGENCY_PASSAGE_SCHEMA_VERSION) {
      fail('unsupported-passage-schema', 'Emergency Box passage schema is incompatible.', {
        expected: EMERGENCY_PASSAGE_SCHEMA_VERSION,
        actual: passageSchemaVersion,
      });
    }
    if (!manifest.indexes || typeof manifest.indexes !== 'object' || Array.isArray(manifest.indexes)) {
      fail('missing-indexes', 'Corpus schema 2 requires prebuilt FTS5 and vector indexes.');
    }
    const validateIndex = (source, kind, expectedPath) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        fail('invalid-index', `Manifest index ${kind} must be an object.`);
      }
      const path = validateArchivePath(nonEmptyString(source.path, `indexes.${kind}.path`, 512));
      if (path !== expectedPath) fail('invalid-index-path', `Manifest index ${kind} must use ${expectedPath}.`);
      const sha256 = nonEmptyString(source.sha256, `indexes.${kind}.sha256`, 64).toLowerCase();
      if (!SHA256_RE.test(sha256)) fail('invalid-checksum', `Manifest index ${kind} has an invalid SHA-256.`);
      if (!Number.isSafeInteger(source.bytes) || source.bytes <= 0) {
        fail('invalid-size', `Manifest index ${kind} must declare a positive byte size.`);
      }
      if (!Number.isSafeInteger(source.passageCount) || source.passageCount <= 0) {
        fail('invalid-index', `Manifest index ${kind} must declare a positive passage count.`);
      }
      return { path, sha256, bytes: source.bytes, passageCount: source.passageCount };
    };
    const fts5 = validateIndex(manifest.indexes.fts5, 'fts5', 'indexes/emergency-box-fts5.sqlite3');
    const vectorBase = validateIndex(
      manifest.indexes.vector,
      'vector',
      'indexes/emergency-box-e5-q8.bin',
    );
    const dimensions = Number(manifest.indexes.vector.dimensions);
    if (dimensions !== 384) fail('invalid-index', 'Emergency vector index must use 384 dimensions.');
    const vector = {
      ...vectorBase,
      dimensions,
      modelId: nonEmptyString(manifest.indexes.vector.modelId, 'indexes.vector.modelId', 200),
      modelRevision: nonEmptyString(manifest.indexes.vector.modelRevision, 'indexes.vector.modelRevision', 80),
      modelDtype: nonEmptyString(manifest.indexes.vector.modelDtype, 'indexes.vector.modelDtype', 20),
    };
    if (fts5.passageCount !== vector.passageCount) {
      fail('invalid-index', 'FTS5 and vector index passage counts do not match.');
    }
    indexes = Object.freeze({ fts5: Object.freeze(fts5), vector: Object.freeze(vector) });
  }

  if (entryNames !== null) {
    const entries = new Set(validateZipEntryNames(entryNames));
    if (!entries.has('manifest.json')) fail('missing-entry', 'ZIP is missing manifest.json.');
    for (const document of documents) {
      if (!entries.has(document.path)) {
        fail('missing-entry', 'ZIP is missing declared document: ' + document.path, { path: document.path });
      }
    }
    const declared = new Set([
      'manifest.json',
      ...documents.map(document => document.path),
      ...Object.values(indexes || {}).map(index => index.path),
    ]);
    for (const index of Object.values(indexes || {})) {
      if (!entries.has(index.path)) fail('missing-entry', 'ZIP is missing declared index: ' + index.path);
    }
    for (const path of entries) {
      if (!declared.has(path)) {
        fail('undeclared-entry', 'ZIP contains an undeclared file: ' + path, { path });
      }
    }
  }

  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    corpusId: EMERGENCY_CORPUS_ID,
    version,
    contentSha256,
    downloadBytes: manifest.downloadBytes,
    documents: Object.freeze(documents),
    passageSchemaVersion,
    indexes,
  });
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail('invalid-bytes', 'Expected an ArrayBuffer or Uint8Array.');
}

export function decodeNormalizedEmergencyText(value) {
  const bytes = bytesFrom(value);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('unexpected-bom', 'Emergency Box plaintext must not include a UTF-8 BOM.');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    fail('unsupported-encoding', 'Emergency Box plaintext is not valid UTF-8.', {
      cause: String(error?.message || error),
    });
  }
  if (!text.trim()) fail('empty-document', 'Emergency Box plaintext document is empty.');
  if (text.includes('\0')) fail('invalid-text', 'Emergency Box plaintext contains a NUL byte.');
  if (text.includes('\r')) fail('unnormalized-text', 'Emergency Box plaintext must use LF line endings.');
  if (text !== text.normalize('NFC')) {
    fail('unnormalized-text', 'Emergency Box plaintext must use Unicode NFC normalization.');
  }
  if (!text.endsWith('\n')) {
    fail('unnormalized-text', 'Emergency Box plaintext must end with one LF newline.');
  }
  return text;
}

export async function sha256Hex(value, cryptoImpl = globalThis.crypto) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : bytesFrom(value);
  if (typeof cryptoImpl?.subtle?.digest !== 'function') {
    fail('crypto-unavailable', 'SHA-256 verification is unavailable in this browser.');
  }
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyEmergencyDocument(document, value, options = {}) {
  if (!document || typeof document !== 'object' || !SHA256_RE.test(String(document.sha256 || ''))) {
    fail('invalid-document', 'Cannot verify a document without valid manifest metadata.');
  }
  const bytes = bytesFrom(value);
  const actualSha256 = await (options.digestHex || sha256Hex)(bytes);
  if (actualSha256 !== document.sha256) {
    fail('checksum-mismatch', 'Checksum mismatch for ' + document.path, {
      path: document.path,
      expected: document.sha256,
      actual: actualSha256,
    });
  }
  const text = decodeNormalizedEmergencyText(bytes);
  return Object.freeze({ document, bytes, text, sha256: actualSha256 });
}

export async function computeCorpusContentSha256(documents, options = {}) {
  if (!Array.isArray(documents) || documents.length === 0) {
    fail('invalid-documents', 'At least one document is required for a corpus digest.');
  }
  const rows = [...documents]
    .map(document => {
      const path = validateArchivePath(String(document?.path || ''));
      const sha256 = String(document?.sha256 || '').toLowerCase();
      if (!SHA256_RE.test(sha256)) fail('invalid-checksum', 'Invalid checksum for ' + path);
      return path + '\0' + sha256;
    })
    .sort();
  return await (options.digestHex || sha256Hex)(rows.join('\n') + '\n');
}

export function estimateRagTokens(value) {
  return Math.max(1, Math.ceil(String(value || '').length / 4));
}

function normalizedWords(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .match(WORD_RE) || [];
}

function cjkNgrams(value) {
  const characters = [...String(value || '').normalize('NFKC')].filter(character => CJK_RE.test(character));
  const output = [];
  for (let index = 0; index < characters.length; index += 1) {
    output.push(characters[index]);
    if (index + 1 < characters.length) output.push(characters[index] + characters[index + 1]);
    if (index + 2 < characters.length) {
      output.push(characters[index] + characters[index + 1] + characters[index + 2]);
    }
  }
  return output;
}

export function tokenizeForLexicalSearch(value, options = {}) {
  const text = String(value || '').normalize('NFKC');
  const tokens = [];
  const seen = new Set();
  const add = token => {
    const normalized = String(token || '').toLocaleLowerCase('und').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    tokens.push(normalized);
  };

  if (typeof Intl?.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(options.language || 'und', { granularity: 'word' });
    for (const segment of segmenter.segment(text)) {
      if (segment.isWordLike) add(segment.segment);
    }
  } else {
    for (const token of normalizedWords(text)) add(token);
  }
  if (CJK_RE.test(text)) {
    for (const token of cjkNgrams(text)) add(token);
  }
  return tokens;
}

function isHeading(line) {
  const text = String(line || '').trim();
  if (!text || text.length > 160) return false;
  if (HEADING_RE.test(text)) return true;
  const letters = [...text].filter(character => /\p{L}/u.test(character));
  return letters.length >= 3
    && text === text.toLocaleUpperCase('und')
    && !/[.!?;:]$/.test(text);
}

function splitOversizedText(text, maximumTokens, estimateTokens) {
  if (estimateTokens(text) <= maximumTokens) return [text];
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]?/gu) || [text];
  const chunks = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const sentence of sentences) {
    const candidate = current ? current + ' ' + sentence.trim() : sentence.trim();
    if (current && estimateTokens(candidate) > maximumTokens) flush();
    if (estimateTokens(sentence) <= maximumTokens) {
      current = current ? current + ' ' + sentence.trim() : sentence.trim();
      continue;
    }
    flush();
    const maximumChars = Math.max(64, maximumTokens * 4);
    for (let offset = 0; offset < sentence.length; offset += maximumChars) {
      chunks.push(sentence.slice(offset, offset + maximumChars).trim());
    }
  }
  flush();
  return chunks.filter(Boolean);
}

export async function createEmergencyPassages(document, text, options = {}) {
  if (!document || !STABLE_ID_RE.test(String(document.id || ''))) {
    fail('invalid-document-id', 'A stable document id is required to create passages.');
  }
  if (typeof text !== 'string' || !text.trim()) fail('empty-document', 'Cannot chunk an empty document.');
  const estimateTokens = options.estimateTokens || estimateRagTokens;
  const targetTokens = Math.min(
    Number.isSafeInteger(options.targetTokens) ? options.targetTokens : 420,
    MAX_PASSAGE_TOKENS,
  );
  const maximumTokens = Math.min(
    Number.isSafeInteger(options.maximumTokens) ? options.maximumTokens : MAX_PASSAGE_TOKENS,
    MAX_PASSAGE_TOKENS,
  );
  if (targetTokens < 32 || maximumTokens < targetTokens) {
    fail('invalid-budget', 'Passage token targets are invalid.');
  }

  const paragraphs = [];
  let currentHeading = document.title || document.id;
  let paragraphLines = [];
  const flushParagraph = () => {
    const value = paragraphLines.join('\n').trim();
    if (value) paragraphs.push({ locator: currentHeading, text: value });
    paragraphLines = [];
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    if (isHeading(line)) {
      flushParagraph();
      currentHeading = line.replace(/^#{1,6}\s+/, '').trim();
      paragraphLines.push(line);
      continue;
    }
    paragraphLines.push(line);
  }
  flushParagraph();

  const pieces = [];
  for (const paragraph of paragraphs) {
    for (const part of splitOversizedText(paragraph.text, maximumTokens, estimateTokens)) {
      pieces.push({ locator: paragraph.locator, text: part });
    }
  }

  const drafts = [];
  let current = null;
  const flush = () => {
    if (current?.text) drafts.push(current);
    current = null;
  };
  for (const piece of pieces) {
    const candidateText = current ? current.text + '\n\n' + piece.text : piece.text;
    const changesLocator = current && current.locator !== piece.locator;
    const currentTokens = current ? estimateTokens(current.text) : 0;
    // Extracted manuals often contain a heading every few lines. Treat a new
    // locator as a preferred boundary only after the current passage has enough
    // substance; otherwise full-vector releases balloon into hundreds of
    // thousands of tiny, low-context embeddings.
    if (current && (
      estimateTokens(candidateText) > targetTokens
      || (changesLocator && currentTokens >= MIN_PASSAGE_TOKENS)
    )) flush();
    if (!current) current = { locator: piece.locator, text: piece.text };
    else current.text = candidateText;
  }
  flush();

  const duplicateKeys = new Map();
  const passages = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    const passageHash = await (options.digestHex || sha256Hex)(draft.text);
    const identity = draft.locator + '\0' + passageHash;
    const occurrence = (duplicateKeys.get(identity) || 0) + 1;
    duplicateKeys.set(identity, occurrence);
    const identityHash = await (options.digestHex || sha256Hex)(
      document.id + '\0' + identity + '\0' + occurrence,
    );
    passages.push(Object.freeze({
      sourceKind: 'emergency-box',
      sourceId: options.corpusVersion || EMERGENCY_CORPUS_ID,
      documentId: document.id,
      passageId: document.id + ':' + identityHash.slice(0, 20),
      title: document.title,
      language: document.language,
      collection: document.collection,
      source: document.sourceUrl,
      license: document.license,
      locator: draft.locator,
      text: draft.text,
      passageSha256: passageHash,
      tokenEstimate: estimateTokens(draft.text),
      readerUrl: createEmergencyReaderUrl(document.id, document.id + ':' + identityHash.slice(0, 20)),
      ordinal: index,
    }));
  }
  return passages;
}

function safePart(value, field) {
  const normalized = String(value || '').trim();
  if (!STABLE_ID_RE.test(normalized)) fail('invalid-reader-target', 'Invalid ' + field + ' for reader target.');
  return normalized;
}

export function createEmergencyReaderUrl(documentId, passageId) {
  const document = safePart(documentId, 'document id');
  const passage = String(passageId || '').trim();
  if (!/^[a-z0-9._:-]{1,220}$/.test(passage)) {
    fail('invalid-reader-target', 'Invalid passage id for reader target.');
  }
  return 'webbrain-reader://emergency-box/' + encodeURIComponent(document)
    + '?passage=' + encodeURIComponent(passage);
}

export function createEmergencyPdfExtensionPath(resourceId) {
  const id = safePart(resourceId, 'pdf resource id');
  return 'src/ui/emergency-pdf.html?id=' + encodeURIComponent(id);
}

export function createWikipediaReaderUrl(archiveId, articlePath) {
  const archive = safePart(archiveId, 'archive id');
  const path = String(articlePath || '').replace(/^\/+/, '');
  if (!path || path.includes('\0') || path.split('/').some(part => part === '..')) {
    fail('invalid-reader-target', 'Invalid Wikipedia article path for reader target.');
  }
  return 'webbrain-reader://wikipedia/' + encodeURIComponent(archive)
    + '?article=' + encodeURIComponent(path);
}

export function validateRagReaderUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    fail('invalid-reader-target', 'Citation reader target is not a valid URL.');
  }
  if (url.protocol !== 'webbrain-reader:') {
    fail('invalid-reader-target', 'Citation reader target uses an unsupported scheme.');
  }
  if (!['emergency-box', 'wikipedia'].includes(url.hostname)) {
    fail('invalid-reader-target', 'Citation reader target uses an unsupported reader.');
  }
  if (url.username || url.password || url.port || url.hash) {
    fail('invalid-reader-target', 'Citation reader target contains unsupported URL components.');
  }
  let path;
  try {
    path = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    fail('invalid-reader-target', 'Citation reader target contains malformed encoding.');
  }
  safePart(path, 'reader id');
  if (url.hostname === 'emergency-box') {
    const passage = url.searchParams.get('passage') || '';
    if (!/^[a-z0-9._:-]{1,220}$/.test(passage)) {
      fail('invalid-reader-target', 'Emergency Box reader target has an invalid passage.');
    }
    if ([...url.searchParams.keys()].some(key => key !== 'passage')) {
      fail('invalid-reader-target', 'Emergency Box reader target has unsupported parameters.');
    }
  } else {
    const article = url.searchParams.get('article') || '';
    if (!article || article.includes('\0') || article.split('/').some(part => part === '..')) {
      fail('invalid-reader-target', 'Wikipedia reader target has an invalid article.');
    }
    if ([...url.searchParams.keys()].some(key => key !== 'article')) {
      fail('invalid-reader-target', 'Wikipedia reader target has unsupported parameters.');
    }
  }
  return url.href;
}

export function ragReaderExtensionPath(value) {
  const url = new URL(validateRagReaderUrl(value));
  const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const parameters = new URLSearchParams();
  if (url.hostname === 'emergency-box') {
    parameters.set('document', id);
    parameters.set('passage', url.searchParams.get('passage'));
    return `src/ui/emergency-text.html?${parameters}`;
  }
  parameters.set('id', id);
  parameters.set('article', url.searchParams.get('article'));
  return `src/ui/wikipedia-reader.html?${parameters}`;
}

function candidateIdentity(hit) {
  return [
    String(hit?.sourceKind || ''),
    String(hit?.sourceId || ''),
    String(hit?.documentId || ''),
    String(hit?.passageId || ''),
  ].join('\0');
}

export function boundLexicalCandidates(hits = [], options = {}) {
  const perSource = Math.min(
    MAX_LEXICAL_CANDIDATES_PER_SOURCE,
    Number.isSafeInteger(options.perSource) ? options.perSource : MAX_LEXICAL_CANDIDATES_PER_SOURCE,
  );
  const globalLimit = Math.min(
    MAX_GLOBAL_LEXICAL_CANDIDATES,
    Number.isSafeInteger(options.globalLimit) ? options.globalLimit : MAX_GLOBAL_LEXICAL_CANDIDATES,
  );
  const sourceCounts = new Map();
  const seen = new Set();
  const output = [];
  const sorted = [...(Array.isArray(hits) ? hits : [])].sort((left, right) => {
    const rankDifference = (Number(left?.lexicalRank) || Number.MAX_SAFE_INTEGER)
      - (Number(right?.lexicalRank) || Number.MAX_SAFE_INTEGER);
    return rankDifference || candidateIdentity(left).localeCompare(candidateIdentity(right));
  });
  for (const hit of sorted) {
    if (!RAG_SOURCE_KINDS.includes(hit?.sourceKind)) continue;
    const identity = candidateIdentity(hit);
    if (!hit?.passageId || seen.has(identity)) continue;
    const count = sourceCounts.get(hit.sourceKind) || 0;
    if (count >= perSource) continue;
    sourceCounts.set(hit.sourceKind, count + 1);
    seen.add(identity);
    output.push({ ...hit, lexicalRank: Number(hit.lexicalRank) || count + 1 });
    if (output.length >= globalLimit) break;
  }
  return output;
}

export function reciprocalRankFusion(rankings = {}, options = {}) {
  const lexical = boundLexicalCandidates(rankings.lexical || [], options);
  const lexicalById = new Map(lexical.map(hit => [candidateIdentity(hit), hit]));
  const semantic = Array.isArray(rankings.semantic) ? rankings.semantic : [];
  const k = Number.isFinite(options.k) && options.k > 0 ? options.k : 60;
  const lexicalWeight = Number.isFinite(options.lexicalWeight) ? options.lexicalWeight : 1;
  const semanticWeight = Number.isFinite(options.semanticWeight) ? options.semanticWeight : 1;
  const includeSemanticOnly = options.includeSemanticOnly === true;
  const fused = new Map();

  lexical.forEach((hit, index) => {
    const identity = candidateIdentity(hit);
    fused.set(identity, {
      ...hit,
      lexicalRank: index + 1,
      fusionScore: lexicalWeight / (k + index + 1),
    });
  });
  semantic.forEach((hit, index) => {
    const identity = candidateIdentity(hit);
    if (!lexicalById.has(identity) && !includeSemanticOnly) return;
    const record = fused.get(identity) || {
      ...hit,
      lexicalRank: Number.MAX_SAFE_INTEGER,
      fusionScore: 0,
    };
    record.semanticRank = index + 1;
    record.fusionScore += semanticWeight / (k + index + 1);
    fused.set(identity, record);
  });
  return [...fused.values()].sort((left, right) =>
    right.fusionScore - left.fusionScore
    || left.lexicalRank - right.lexicalRank
    || candidateIdentity(left).localeCompare(candidateIdentity(right))
  );
}

function textOverlap(left, right) {
  const leftTokens = new Set(tokenizeForLexicalSearch(left));
  const rightTokens = new Set(tokenizeForLexicalSearch(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / Math.min(leftTokens.size, rightTokens.size);
}

export function selectDiverseRagHits(hits = [], options = {}) {
  const maximum = Math.min(
    MAX_FINAL_PASSAGES,
    Number.isSafeInteger(options.maximum) ? options.maximum : MAX_FINAL_PASSAGES,
  );
  const perDocument = Math.min(
    MAX_PASSAGES_PER_DOCUMENT,
    Number.isSafeInteger(options.perDocument) ? options.perDocument : MAX_PASSAGES_PER_DOCUMENT,
  );
  const output = [];
  const documentCounts = new Map();
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!RAG_SOURCE_KINDS.includes(hit?.sourceKind) || !hit?.documentId || !hit?.passageId) continue;
    const documentKey = hit.sourceKind + '\0' + hit.sourceId + '\0' + hit.documentId;
    if ((documentCounts.get(documentKey) || 0) >= perDocument) continue;
    const duplicate = output.some(selected =>
      selected.sourceKind === hit.sourceKind
      && selected.sourceId === hit.sourceId
      && selected.documentId === hit.documentId
      && (
        selected.passageId === hit.passageId
        || textOverlap(selected.text, hit.text) >= (options.overlapThreshold || 0.82)
      )
    );
    if (duplicate) continue;
    output.push(hit);
    documentCounts.set(documentKey, (documentCounts.get(documentKey) || 0) + 1);
    if (output.length >= maximum) break;
  }
  return output;
}

function stableTokenHash(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value || '')) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

export function citationTokenForHit(hit) {
  const source = hit?.sourceKind === 'wikipedia' ? 'W' : 'E';
  return '[WB-' + source + '-' + stableTokenHash(candidateIdentity(hit)).toUpperCase() + ']';
}

function completePassageWithinBudget(text, maximumTokens, estimateTokens) {
  const normalized = String(text || '').trim();
  if (estimateTokens(normalized) <= maximumTokens) return { text: normalized, truncated: false };
  const sentences = normalized.match(/[^.!?。！？\n]+[.!?。！？]+/gu) || [];
  let selected = '';
  for (const sentence of sentences) {
    const candidate = selected ? selected + ' ' + sentence.trim() : sentence.trim();
    if (estimateTokens(candidate) > maximumTokens) break;
    selected = candidate;
  }
  if (selected) return { text: selected, truncated: true };
  const maximumChars = Math.max(64, maximumTokens * 4);
  return { text: normalized.slice(0, maximumChars).trimEnd(), truncated: true };
}

export function assembleRagEvidence(hits = [], options = {}) {
  const estimateTokens = options.estimateTokens || estimateRagTokens;
  const contextWindowTokens = Number.isSafeInteger(options.contextWindowTokens)
    ? options.contextWindowTokens
    : 16_384;
  const reservedTokens = [
    options.systemTokens,
    options.historyTokens,
    options.questionTokens,
    options.generationTokens ?? 4096,
    options.otherReservedTokens,
  ].reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0), 0);
  const availableTokens = Math.max(0, contextWindowTokens - reservedTokens);
  const evidenceBudget = Math.min(
    MAX_EVIDENCE_TOKENS,
    Number.isSafeInteger(options.maximumEvidenceTokens)
      ? options.maximumEvidenceTokens
      : MAX_EVIDENCE_TOKENS,
    availableTokens,
  );
  // A single long passage can swallow a small budget whole. Callers that would
  // rather see several sources than one article intro cap each passage here.
  const passageBudget = Math.max(1, Math.min(
    MAX_PASSAGE_TOKENS,
    Number.isSafeInteger(options.maximumPassageTokens)
      ? options.maximumPassageTokens
      : MAX_PASSAGE_TOKENS,
  ));
  const candidates = selectDiverseRagHits(hits, options);
  const selected = [];
  const citations = [];
  let usedTokens = 0;

  for (const hit of candidates) {
    let readerUrl;
    try {
      readerUrl = validateRagReaderUrl(hit.readerUrl);
    } catch {
      continue;
    }
    const bounded = completePassageWithinBudget(
      hit.text,
      Math.min(passageBudget, evidenceBudget - usedTokens),
      estimateTokens,
    );
    if (!bounded.text) continue;
    const passageTokens = estimateTokens(bounded.text);
    if (passageTokens > passageBudget || usedTokens + passageTokens > evidenceBudget) continue;
    const citationToken = citationTokenForHit(hit);
    const selectedHit = { ...hit, text: bounded.text, citationToken, readerUrl };
    selected.push(selectedHit);
    citations.push(Object.freeze({
      token: citationToken,
      sourceKind: hit.sourceKind,
      sourceId: String(hit.sourceId || ''),
      documentId: String(hit.documentId || ''),
      passageId: String(hit.passageId || ''),
      title: String(hit.title || ''),
      language: String(hit.language || ''),
      archiveDate: String(hit.archiveDate || ''),
      collection: String(hit.collection || ''),
      locator: String(hit.locator || ''),
      retrievalMode: String(hit.retrievalMode || ''),
      source: String(hit.source || ''),
      license: String(hit.license || ''),
      readerUrl,
      passageSha256: String(hit.passageSha256 || ''),
      truncated: bounded.truncated,
    }));
    usedTokens += passageTokens;
  }

  const evidence = selected.map(hit => {
    const provenance = [
      hit.sourceKind === 'wikipedia' ? 'Offline Wikipedia' : 'Emergency Box',
      hit.title,
      hit.locator,
      hit.language,
      hit.archiveDate,
      hit.collection,
    ].filter(Boolean).join(' | ');
    return hit.citationToken + ' ' + provenance + '\n' + hit.text;
  }).join('\n\n');

  return Object.freeze({
    instructions: [
      'Answer only from the supplied offline evidence.',
      'Cite supported claims with the exact citation tokens shown.',
      'Answer whatever part of the question the evidence does support, then state plainly which part it does not cover.',
      'A partial sourced answer is better than none, but never close a gap with unstated knowledge.',
    ].join(' '),
    evidence,
    citations: Object.freeze(citations),
    selected: Object.freeze(selected),
    usedTokens,
    budgetTokens: evidenceBudget,
    semanticRerankingUsed: selected.some(hit => Number.isInteger(hit.semanticRank)),
  });
}

export function buildVectorCacheKey(value = {}) {
  const modelVersion = nonEmptyString(value.modelVersion, 'modelVersion', 200);
  const sourceVersion = nonEmptyString(value.sourceVersion, 'sourceVersion', 200);
  const sourceKind = nonEmptyString(value.sourceKind, 'sourceKind', 40);
  if (!RAG_SOURCE_KINDS.includes(sourceKind)) fail('invalid-source-kind', 'Unsupported RAG source kind.');
  const passageId = nonEmptyString(value.passageId, 'passageId', 240);
  const passageSha256 = nonEmptyString(value.passageSha256, 'passageSha256', 64).toLowerCase();
  if (!SHA256_RE.test(passageSha256)) fail('invalid-checksum', 'Vector cache key needs a passage SHA-256.');
  return [modelVersion, sourceKind, sourceVersion, passageId, passageSha256].map(encodeURIComponent).join('|');
}

export function selectVectorCacheEvictions(entries = [], options = {}) {
  const maximumBytes = Number.isSafeInteger(options.maximumBytes)
    ? Math.min(options.maximumBytes, VECTOR_CACHE_MAX_BYTES)
    : VECTOR_CACHE_MAX_BYTES;
  const normalized = (Array.isArray(entries) ? entries : []).map(entry => ({
    key: String(entry?.key || ''),
    byteLength: Math.max(0, Number(entry?.byteLength) || 0),
    lastUsedAt: Math.max(0, Number(entry?.lastUsedAt) || 0),
  }));
  let totalBytes = normalized.reduce((sum, entry) => sum + entry.byteLength, 0);
  const evictions = [];
  for (const entry of normalized.sort((left, right) =>
    left.lastUsedAt - right.lastUsedAt || left.key.localeCompare(right.key)
  )) {
    if (totalBytes <= maximumBytes) break;
    evictions.push(entry.key);
    totalBytes -= entry.byteLength;
  }
  return Object.freeze({ evictions: Object.freeze(evictions), remainingBytes: totalBytes, maximumBytes });
}
