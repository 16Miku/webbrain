/** Shared, download-free retrieval boundary for standalone chat and search UI. */

import { createApocalypseStore, searchApocalypseArchives } from './apocalypse-mode.js';
import { createEmergencyCorpusStore } from './emergency-corpus.js';
import { createOfflineRagIndexClient, detectQueryLanguage, preferMatchingAgeCohort } from './offline-rag-index.js';
import {
  MAX_FINAL_PASSAGES,
  MAX_LEXICAL_CANDIDATES_PER_SOURCE,
  boundLexicalCandidates,
  createWikipediaReaderUrl,
  reciprocalRankFusion,
  selectDiverseRagHits,
  sha256Hex,
} from './offline-rag.js';

const ALLOWED_SOURCES = new Set(['wikipedia', 'emergency-box']);
export const OFFLINE_SEMANTIC_TIMEOUT_MS = 30_000;

function semanticTimeoutError() {
  const error = new Error('Semantic ranking timed out; using lexical retrieval.');
  error.code = 'semantic-timeout';
  return error;
}

async function runBoundedSemantic(operation, options = {}) {
  const parentSignal = options.signal;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(
    parentSignal?.reason instanceof Error
      ? parentSignal.reason
      : new DOMException('Offline retrieval canceled.', 'AbortError'),
  );
  if (parentSignal?.aborted) forwardAbort();
  else parentSignal?.addEventListener?.('abort', forwardAbort, { once: true });
  const timeoutId = setTimeout(() => controller.abort(semanticTimeoutError()), options.timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeoutId);
    parentSignal?.removeEventListener?.('abort', forwardAbort);
  }
}

function normalizedFilter(values, fallback) {
  const source = Array.isArray(values) ? values : fallback;
  return new Set(source.map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
}

function languageAllowed(language, languages) {
  return !languages.size || languages.has(String(language || '').trim().toLowerCase());
}

export function emergencyRetrievalStatus(record) {
  if (record?.active && record.status === 'ready') return 'ready';
  if (['downloading', 'verifying', 'downloaded', 'extracting', 'indexing', 'paused', 'error'].includes(record?.status)) {
    return record.status;
  }
  return 'not-installed';
}

export async function wikipediaRecordsToRagHits(records = [], options = {}) {
  const output = [];
  const digestHex = options.digestHex || sha256Hex;
  for (const record of Array.isArray(records) ? records : []) {
    const archiveId = String(record?.archiveId || '').trim().toLowerCase();
    const articlePath = String(record?.path || '').trim().replace(/^\/+/, '');
    const text = String(record?.excerpt || record?.text || '').trim();
    if (!archiveId || !articlePath || !text) continue;
    let readerUrl;
    try { readerUrl = createWikipediaReaderUrl(archiveId, articlePath); }
    catch { continue; }
    const passageSha256 = await digestHex(text);
    output.push(Object.freeze({
      sourceKind: 'wikipedia',
      sourceId: archiveId,
      documentId: articlePath,
      passageId: `${archiveId}:${passageSha256.slice(0, 20)}`,
      title: String(record.title || articlePath.replace(/_/g, ' ')),
      language: String(record.language || 'und').toLowerCase(),
      text,
      lexicalRank: output.length + 1,
      lexicalScore: Number.isFinite(Number(record.lexicalScore)) ? Number(record.lexicalScore) : undefined,
      passageSha256,
      archiveDate: String(record.archiveDate || ''),
      collection: String(record.archiveTitle || 'Wikipedia'),
      locator: String(record.locator || record.title || ''),
      readerUrl,
      retrievalMode: String(record.retrievalMode || 'title-only'),
      source: String(record.source || 'Kiwix / openZIM'),
      license: String(record.license || ''),
    }));
    if (output.length >= MAX_LEXICAL_CANDIDATES_PER_SOURCE) break;
  }
  return output;
}

export async function searchWikipediaLexical(query, options = {}) {
  const search = options.search || searchApocalypseArchives;
  let reportedStatus = '';
  try {
    const records = await search(query, {
      limit: MAX_LEXICAL_CANDIDATES_PER_SOURCE,
      searchAllArchives: true,
      preferredLanguages: options.preferredLanguages,
      queriesByLanguage: options.queriesByLanguage,
      providers: options.providers,
      signal: options.signal,
      onSearchStatus(value) {
        const status = typeof value === 'string' ? value : value?.status;
        if (status) reportedStatus = String(status);
        options.onSearchStatus?.(value);
      },
    });
    const hits = await wikipediaRecordsToRagHits(records, options);
    const hasFullText = hits.some(hit => hit.retrievalMode === 'xapian-full-text');
    return {
      hits,
      status: hits.length
        ? (hasFullText ? 'ready' : 'title-only-fallback')
        : (reportedStatus || 'unavailable'),
    };
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') throw error;
    return { hits: [], status: 'unavailable', error: String(error?.message || error) };
  }
}

// Exact matching runs first and its results always rank above the relaxed pass,
// so a query that already works is unaffected. The second pass only fires when
// the first comes back thin, which is exactly the misspelled or inflected query
// that used to return nothing at all.
export const RELAXED_RETRY_THRESHOLD = 5;

function mergeLexicalHits(exact, relaxed) {
  const seen = new Set(exact.map(hit => hit?.passageId));
  const merged = [...exact];
  for (const hit of relaxed) {
    if (!hit?.passageId || seen.has(hit.passageId)) continue;
    seen.add(hit.passageId);
    merged.push(hit);
  }
  return merged;
}

export async function searchEmergencyLexical(query, options = {}) {
  const store = options.store || createEmergencyCorpusStore();
  const state = await store.get();
  const status = emergencyRetrievalStatus(state);
  if (status !== 'ready' || !state?.active?.indexPath) return { hits: [], status };
  const client = options.indexClient || options.getIndexClient?.();
  if (!client?.searchEmergency) return { hits: [], status: 'error', error: 'Offline SQLite client is unavailable.' };
  const request = relax => client.searchEmergency({
    indexPath: state.active.indexPath,
    sourceVersion: state.active.version,
    query,
    limit: MAX_LEXICAL_CANDIDATES_PER_SOURCE,
    signal: options.signal,
    relax,
  });
  try {
    const hits = preferMatchingAgeCohort(await request(false), query);
    if (hits.length >= RELAXED_RETRY_THRESHOLD) return { hits, status: 'ready', active: state.active };
    const relaxed = preferMatchingAgeCohort(await request(true), query);
    return { hits: mergeLexicalHits(hits, relaxed), status: 'ready', active: state.active, relaxed: true };
  } catch (error) {
    return { hits: [], status: 'error', active: state.active, error: String(error?.message || error) };
  }
}

export async function searchEmergencyVector(queryVector, options = {}) {
  const store = options.store || createEmergencyCorpusStore();
  const state = await store.get();
  const status = emergencyRetrievalStatus(state);
  if (status !== 'ready' || !state?.active?.indexPath) return { hits: [], status };
  if (!state.active.vectorIndex || !state.active.installId) {
    return { hits: [], status: 'vector-not-installed', active: state.active };
  }
  const client = options.indexClient || options.getIndexClient?.();
  if (!client?.searchEmergencyVector) return { hits: [], status: 'error', error: 'Offline vector client is unavailable.' };
  try {
    const hits = await client.searchEmergencyVector({
      installId: state.active.installId,
      indexPath: state.active.indexPath,
      vectorIndex: state.active.vectorIndex,
      sourceVersion: state.active.version,
      queryVector,
      limit: MAX_LEXICAL_CANDIDATES_PER_SOURCE,
      signal: options.signal,
    });
    return { hits, status: 'ready', active: state.active };
  } catch (error) {
    return { hits: [], status: 'error', active: state.active, error: String(error?.message || error) };
  }
}

function mergeSemanticRankings(rankings = []) {
  const fused = new Map();
  for (const ranking of rankings) {
    (Array.isArray(ranking) ? ranking : []).forEach((hit, index) => {
      const identity = [hit?.sourceKind, hit?.sourceId, hit?.documentId, hit?.passageId].join('\0');
      if (!hit?.passageId) return;
      const current = fused.get(identity) || { hit, score: 0, bestRank: Number.MAX_SAFE_INTEGER };
      current.score += 1 / (60 + index + 1);
      current.bestRank = Math.min(current.bestRank, index + 1);
      fused.set(identity, current);
    });
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.bestRank - right.bestRank)
    .map(item => item.hit);
}

export function createOfflineRetrievalService(options = {}) {
  const emergencyStore = options.emergencyStore || createEmergencyCorpusStore();
  const wikipediaStore = options.wikipediaStore || createApocalypseStore();
  const semanticTimeoutMs = Number.isFinite(Number(options.semanticTimeoutMs))
    && Number(options.semanticTimeoutMs) > 0
    ? Number(options.semanticTimeoutMs)
    : OFFLINE_SEMANTIC_TIMEOUT_MS;
  let ownedIndexClient = null;
  const indexClient = () => {
    if (options.indexClient) return options.indexClient;
    if (!ownedIndexClient) ownedIndexClient = (options.createIndexClient || createOfflineRagIndexClient)();
    return ownedIndexClient;
  };

  return Object.freeze({
    async status() {
      const [emergency, wikipediaArchives] = await Promise.all([
        emergencyStore.get().catch(() => null),
        wikipediaStore.listArchives().catch(() => []),
      ]);
      const semantic = options.semanticReranker?.status
        ? await options.semanticReranker.status().catch(() => 'error')
        : 'model-missing';
      return {
        wikipedia: options.wikipediaStatus || 'unknown',
        wikipediaLanguages: [...new Set(wikipediaArchives
          .filter(record => record?.archiveKind === 'wikipedia' && record.status === 'ready')
          .map(record => String(record.language || '').trim().toLowerCase())
          .filter(language => /^[a-z]{3}$/.test(language)))].sort(),
        emergencyBox: emergencyRetrievalStatus(emergency),
        semantic,
        localGeneration: options.localGenerationStatus?.() || 'unknown',
      };
    },
    async search(queryValue, searchOptions = {}) {
      const query = String(queryValue || '').trim();
      if (!query) return {
        query, hits: [], candidates: [], rankingMode: 'lexical-fallback',
        statuses: { wikipedia: 'skipped', emergencyBox: 'skipped', semantic: 'skipped' },
      };
      const sources = normalizedFilter(searchOptions.sources, [...ALLOWED_SOURCES]);
      for (const source of [...sources]) if (!ALLOWED_SOURCES.has(source)) sources.delete(source);
      const languages = normalizedFilter(searchOptions.languages, []);
      const semanticQuery = String(searchOptions.semanticQuery || '').trim() || query;
      const suppliedQueryLanguage = String(searchOptions.queryLanguage || '').trim().toLowerCase();
      const queryLanguage = /^[a-z]{3}$/.test(suppliedQueryLanguage)
        ? suppliedQueryLanguage
        : detectQueryLanguage(semanticQuery);
      const preferredLanguages = [...new Set([queryLanguage, ...languages].filter(Boolean))];
      const wikipediaPromise = sources.has('wikipedia')
        ? searchWikipediaLexical(query, {
          search: options.searchWikipedia,
          providers: options.wikipediaProviders,
          preferredLanguages,
          queriesByLanguage: searchOptions.wikipediaQueriesByLanguage,
          digestHex: options.digestHex,
          signal: searchOptions.signal,
          onSearchStatus: searchOptions.onSearchStatus,
        })
        : Promise.resolve({ hits: [], status: 'skipped' });
      const emergencyPromise = sources.has('emergency-box')
        ? searchEmergencyLexical(query, {
          store: emergencyStore,
          getIndexClient: indexClient,
          signal: searchOptions.signal,
        })
        : Promise.resolve({ hits: [], status: 'skipped' });
      let semanticFailure = null;
      // E5 was trained on natural-language queries. The lexical side wants the
      // stop-word-stripped keywords, but handing the same keyword soup to the
      // embedder throws away the sentence it needs, so the caller can pass the
      // user's own wording through for the semantic half.
      const queryVectorPromise = sources.has('emergency-box') && options.semanticReranker?.embedQuery
        ? runBoundedSemantic(
          signal => options.semanticReranker.embedQuery(semanticQuery, { signal }),
          { signal: searchOptions.signal, timeoutMs: semanticTimeoutMs },
        ).catch(error => {
          if (searchOptions.signal?.aborted) throw error;
          semanticFailure = error;
          if (error?.code === 'semantic-timeout') options.semanticReranker?.reset?.();
          searchOptions.onSemanticFallback?.(error);
          return null;
        })
        : Promise.resolve(null);
      const [wikipedia, emergency, queryVector] = await Promise.all([
        wikipediaPromise, emergencyPromise, queryVectorPromise,
      ]);
      const emergencyVector = queryVector
        ? await searchEmergencyVector(queryVector, {
          store: emergencyStore,
          getIndexClient: indexClient,
          signal: searchOptions.signal,
        })
        : { hits: [], status: queryVector === null ? 'model-missing' : 'skipped' };
      const lexical = boundLexicalCandidates([
        ...wikipedia.hits.filter(hit => languageAllowed(hit.language, languages)),
        ...emergency.hits.filter(hit => languageAllowed(hit.language, languages)),
      ]);
      let semantic = [];
      let semanticStatus = options.semanticReranker ? 'lexical-fallback' : 'model-missing';
      if (lexical.length && !emergencyVector.hits.length && !semanticFailure && options.semanticReranker?.rerank) {
        try {
          semantic = await runBoundedSemantic(
            signal => options.semanticReranker.rerank(semanticQuery, lexical, { signal }),
            { signal: searchOptions.signal, timeoutMs: semanticTimeoutMs },
          );
          semanticStatus = 'ready';
        } catch (error) {
          if (searchOptions.signal?.aborted) throw error;
          if (error?.code === 'semantic-timeout') options.semanticReranker?.reset?.();
          semanticStatus = 'lexical-fallback';
          searchOptions.onSemanticFallback?.(error);
        }
      }
      const vectorHits = emergencyVector.hits.filter(hit => languageAllowed(hit.language, languages));
      const semanticRankings = mergeSemanticRankings([vectorHits, semantic]);
      const fused = reciprocalRankFusion({ lexical, semantic: semanticRankings }, {
        includeSemanticOnly: vectorHits.length > 0,
      });
      const hits = selectDiverseRagHits(fused, {
        maximum: Math.min(MAX_FINAL_PASSAGES, Number(searchOptions.limit) || MAX_FINAL_PASSAGES),
      });
      return {
        query,
        hits,
        candidates: lexical,
        rankingMode: vectorHits.length
          ? 'hybrid-full-vector'
          : semanticStatus === 'ready' ? 'semantic-reranked' : 'lexical-fallback',
        statuses: {
          wikipedia: wikipedia.status,
          emergencyBox: emergency.status,
          semantic: vectorHits.length ? 'full-vector-ready' : semanticStatus,
          emergencyVector: emergencyVector.status,
        },
        errors: {
          wikipedia: wikipedia.error || '',
          emergencyBox: emergency.error || '',
          emergencyVector: emergencyVector.error || '',
        },
      };
    },
    indexClient,
    close() {
      ownedIndexClient?.close?.();
      ownedIndexClient = null;
      options.semanticReranker?.close?.();
    },
  });
}
