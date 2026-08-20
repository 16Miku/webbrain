/** Main-thread client and pure query helpers for the offline SQLite worker. */

import { MAX_LEXICAL_CANDIDATES_PER_SOURCE, tokenizeForLexicalSearch } from './offline-rag.js';
import { detectOfflineQueryLanguage, isOfflineQueryStopWord } from './offline-query-stopwords.js';

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
// "not breathing" is the opposite of "breathing". Dropping the negation as a
// stopword made infant CPR lose to a page about an infant who is still breathing.
const QUERY_NEGATION_TOKENS = new Set(['not', 'no', 'never', 'without']);

function isDroppedQueryToken(token, query) {
  if (QUERY_NEGATION_TOKENS.has(token)) return false;
  return isOfflineQueryStopWord(token, query);
}

function quoteFts5Token(token) {
  return `"${token.replace(/"/g, '""')}"`;
}

export function relaxedFts5Prefix(token) {
  const value = String(token || '');
  if (value.length < RELAXED_MINIMUM_TOKEN_LENGTH) return '';
  const stem = value.slice(0, Math.max(RELAXED_MINIMUM_PREFIX_LENGTH, Math.ceil(value.length / 2)));
  return stem === value ? '' : stem;
}

// Infant, child, and adult technique differ in ways that can cause harm if the
// wrong passage is retrieved: abdominal thrusts on an infant, adult compression
// depth on a baby, adult adrenaline doses on a child. People type "baby" when
// the field guide says "infant". That is a closed synonym set, not a bm25
// weight, so expansion and ranking both key off the same table. Infant is not
// merged with child: a toddler can get abdominal thrusts, an infant cannot.
// English tokens expand only to English field-guide synonyms. A token from
// another language also keeps those English terms so it can still hit the
// mainly English archive, but it does not pull in a third language. Homographs
// that are ordinary English words (German Kind, Dutch kind) stay out.
export const AGE_COHORT_SYNONYMS = Object.freeze({
  newborn: Object.freeze({
    eng: Object.freeze(['newborn', 'newborns', 'neonate', 'neonates']),
    tur: Object.freeze(['yenidoğan', 'yenidogan']),
    spa: Object.freeze(['neonato', 'neonatos']),
    fra: Object.freeze(['nouveau-né', 'nouveau-nés', 'nouveaune', 'nouveaunes']),
    deu: Object.freeze(['neugeborenes', 'neugeborene', 'neugeboren']),
    por: Object.freeze(['recém-nascido', 'recem-nascido', 'recém-nascidos']),
    rus: Object.freeze(['новорождённый', 'новорожденный', 'новорождённого']),
    ara: Object.freeze(['وليد', 'حديثي']),
    zho: Object.freeze(['新生儿', '新生兒']),
    jpn: Object.freeze(['新生児']),
    kor: Object.freeze(['신생아']),
    hin: Object.freeze(['नवजात']),
  }),
  infant: Object.freeze({
    eng: Object.freeze(['baby', 'babies', 'infant', 'infants']),
    tur: Object.freeze(['bebek', 'bebeği', 'bebegi']),
    spa: Object.freeze(['bebé', 'bebe', 'bebés', 'bebes', 'lactante', 'lactantes']),
    fra: Object.freeze(['bébé', 'bébés', 'nourrisson', 'nourrissons']),
    deu: Object.freeze(['säugling', 'saeugling', 'säuglinge', 'saugling']),
    por: Object.freeze(['bebê', 'lactente']),
    nld: Object.freeze(['zuigeling', 'zuigelingen']),
    rus: Object.freeze(['младенец', 'младенца', 'грудничок']),
    ukr: Object.freeze(['немовля', 'немовляти']),
    pol: Object.freeze(['niemowlę', 'niemowle', 'niemowlęcia']),
    ara: Object.freeze(['رضيع', 'الرضيع', 'رضيعة']),
    fas: Object.freeze(['شیرخوار']),
    heb: Object.freeze(['תינוק', 'תינוקת']),
    zho: Object.freeze(['婴儿', '嬰兒', '婴幼儿']),
    jpn: Object.freeze(['乳児', '赤ちゃん']),
    kor: Object.freeze(['영아']),
    hin: Object.freeze(['शिशु']),
    ben: Object.freeze(['শিশু']),
    tha: Object.freeze(['ทารก']),
    vie: Object.freeze(['nhũ']),
    ind: Object.freeze(['bayi']),
    msa: Object.freeze(['bayi']),
    tgl: Object.freeze(['sanggol']),
  }),
  child: Object.freeze({
    eng: Object.freeze([
      'child', 'children', 'toddler', 'toddlers', 'pediatric', 'paediatric', 'kid', 'kids',
    ]),
    tur: Object.freeze(['çocuk', 'cocuk', 'çocuğu', 'cocugu']),
    spa: Object.freeze(['niño', 'nino', 'niña', 'nina', 'niños', 'ninos']),
    // German/Dutch "Kind" is an English word. Leave it out.
    fra: Object.freeze(['enfant', 'enfants', 'bambin', 'bambins']),
    deu: Object.freeze(['kleinkind', 'kleinkinder', 'kindes']),
    por: Object.freeze(['criança', 'crianca', 'crianças', 'criancas']),
    nld: Object.freeze(['kleuter', 'kleuters', 'kindje']),
    rus: Object.freeze(['ребёнок', 'ребенок', 'ребёнка', 'дети']),
    ukr: Object.freeze(['дитина', 'дитини', 'діти']),
    pol: Object.freeze(['dziecko', 'dziecka', 'dzieci']),
    ara: Object.freeze(['طفل', 'طفلة', 'اطفال', 'أطفال']),
    fas: Object.freeze(['کودک']),
    heb: Object.freeze(['ילד', 'ילדה', 'ילדים']),
    zho: Object.freeze(['儿童', '兒童', '小孩', '幼儿']),
    jpn: Object.freeze(['子供', '子ども', '幼児']),
    kor: Object.freeze(['어린이']),
    hin: Object.freeze(['बच्चा', 'बच्चे']),
    tha: Object.freeze(['เด็ก']),
    vie: Object.freeze(['trẻ']),
    ind: Object.freeze(['anak']),
  }),
  adult: Object.freeze({
    eng: Object.freeze(['adult', 'adults']),
    tur: Object.freeze(['yetişkin', 'yetiskin']),
    spa: Object.freeze(['adulto', 'adultos', 'adulta', 'adultas']),
    fra: Object.freeze(['adulte', 'adultes']),
    deu: Object.freeze(['erwachsene', 'erwachsener', 'erwachsenen']),
    por: Object.freeze(['adulto', 'adultos', 'adulta']),
    nld: Object.freeze(['volwassene', 'volwassenen']),
    rus: Object.freeze(['взрослый', 'взрослая', 'взрослого']),
    ukr: Object.freeze(['дорослий', 'доросла']),
    pol: Object.freeze(['dorosły', 'dorosly', 'dorosła']),
    ara: Object.freeze(['بالغ', 'بالغة', 'راشد']),
    fas: Object.freeze(['بزرگسال']),
    heb: Object.freeze(['מבוגר', 'מבוגרת']),
    zho: Object.freeze(['成人', '大人']),
    jpn: Object.freeze(['大人', '成人']),
    kor: Object.freeze(['성인']),
    hin: Object.freeze(['वयस्क']),
    tha: Object.freeze(['ผู้ใหญ่']),
    ind: Object.freeze(['dewasa']),
  }),
});

const TOKEN_TO_AGE_COHORT = new Map();
const TOKEN_TO_AGE_LANGUAGE = new Map();
for (const [cohort, byLanguage] of Object.entries(AGE_COHORT_SYNONYMS)) {
  for (const [language, synonyms] of Object.entries(byLanguage)) {
    for (const synonym of synonyms) {
      if (/\s/.test(synonym)) continue;
      TOKEN_TO_AGE_COHORT.set(synonym, cohort);
      TOKEN_TO_AGE_LANGUAGE.set(synonym, language);
    }
  }
}

export function detectAgeCohort(value, options = {}) {
  const found = new Set();
  for (const token of tokenizeForLexicalSearch(value, { language: options.language })) {
    const cohort = TOKEN_TO_AGE_COHORT.get(token);
    if (cohort) found.add(cohort);
  }
  if (found.size === 1) return [...found][0];
  return '';
}

export function detectQueryLanguage(value) {
  const text = String(value || '');
  for (const token of tokenizeForLexicalSearch(text)) {
    const language = TOKEN_TO_AGE_LANGUAGE.get(token);
    if (language && language !== 'eng') return language;
  }
  return detectOfflineQueryLanguage(text);
}

export function documentAgeCohort(hit, options = {}) {
  const titleCohort = detectAgeCohort(hit?.title || '', options);
  if (titleCohort) return titleCohort;
  return detectAgeCohort(hit?.text || '', options);
}

function expandQueryTokens(tokens) {
  const expanded = [];
  const seen = new Set();
  const push = token => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    expanded.push(token);
  };
  for (const token of tokens) {
    push(token);
    const cohort = TOKEN_TO_AGE_COHORT.get(token);
    if (!cohort) continue;
    const tokenLanguage = TOKEN_TO_AGE_LANGUAGE.get(token);
    for (const synonym of AGE_COHORT_SYNONYMS[cohort].eng) push(synonym);
    if (tokenLanguage && tokenLanguage !== 'eng') {
      for (const synonym of AGE_COHORT_SYNONYMS[cohort][tokenLanguage] || []) push(synonym);
    }
  }
  return expanded;
}

function ageCohortPreference(hit, queryCohort, options = {}) {
  const docCohort = documentAgeCohort(hit, options);
  if (queryCohort) {
    if (docCohort === queryCohort) return 0;
    if (!docCohort) return 1;
    return 2;
  }
  // Unmarked questions default to adult technique. Age-specific pages wait
  // for an age word so "burns" is not captured by "Burns in children".
  if (!docCohort || docCohort === 'adult') return 0;
  return 1;
}

function encyclopediaPreference(hit) {
  const collection = String(hit?.collection || '').toLowerCase();
  if (hit?.sourceKind === 'wikipedia' || collection === 'wikipedia') return 1;
  return 0;
}

function distinctiveQueryTerms(query, options = {}) {
  return tokenizeForLexicalSearch(query, { language: options.language })
    .filter(token => token.length <= 80 && !isDroppedQueryToken(token, query) && !TOKEN_TO_AGE_COHORT.has(token));
}

function distinctiveCoverage(hit, terms, options = {}) {
  if (!terms.length) return 0;
  const titleTokens = new Set(tokenizeForLexicalSearch(hit?.title || '', { language: options.language }));
  const bodyTokens = new Set(tokenizeForLexicalSearch(hit?.text || '', { language: options.language }));
  let score = 0;
  for (const term of terms) {
    if (titleTokens.has(term)) score += 3;
    else if (bodyTokens.has(term)) score += 1;
  }
  return score;
}

function languagePreference(hit, queryLanguage) {
  if (!queryLanguage) return 1;
  const docLanguage = String(hit?.language || '').toLowerCase();
  if (docLanguage === queryLanguage) return 0;
  if (!docLanguage || docLanguage === 'und') return 1;
  return 2;
}

// Matching-cohort passages stay ahead of unlabelled ones, which stay ahead of
// a conflicting cohort. Encyclopedia hits sort after field-guide hits inside a
// bucket, then language concordance, then the original bm25 order.
export function preferMatchingAgeCohort(hits, query, options = {}) {
  const rows = Array.isArray(hits) ? hits : [];
  const queryCohort = detectAgeCohort(query, options);
  const queryLanguage = detectQueryLanguage(query);
  const distinctive = distinctiveQueryTerms(query, options);
  return rows
    .map((hit, index) => ({
      hit,
      index,
      age: ageCohortPreference(hit, queryCohort, options),
      coverage: distinctiveCoverage(hit, distinctive, options),
      encyclopedia: encyclopediaPreference(hit),
      language: languagePreference(hit, queryLanguage),
    }))
    .sort((left, right) =>
      left.age - right.age
      || right.coverage - left.coverage
      || left.encyclopedia - right.encyclopedia
      || left.language - right.language
      || left.index - right.index)
    .map((item, rank) => (item.hit?.lexicalRank === rank + 1
      ? item.hit
      : Object.freeze({ ...item.hit, lexicalRank: rank + 1 })));
}

export function buildFts5Query(value, options = {}) {
  const maximumTerms = Math.min(32, Math.max(1, Number(options.maximumTerms) || 24));
  const rawTokens = tokenizeForLexicalSearch(value, { language: options.language })
    .filter(token => token.length <= 80);
  const contentTokens = rawTokens.filter(token => !isDroppedQueryToken(token, value));
  const tokens = expandQueryTokens((contentTokens.length ? contentTokens : rawTokens).slice(0, maximumTerms))
    .slice(0, 32);
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
        limit: MAX_LEXICAL_CANDIDATES_PER_SOURCE,
      }, { signal });
      return preferMatchingAgeCohort(
        normalizeEmergencyLexicalHits(result?.rows, sourceVersion),
        query,
      ).slice(0, safeLimit);
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
