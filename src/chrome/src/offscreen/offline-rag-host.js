/** Worker-capable host for standalone-chat offline retrieval in Chrome MV3. */

import { createOfflineRetrievalService } from '../agent/offline-retrieval.js';
import { createOfflineRagIndexClient } from '../agent/offline-rag-index.js';
import { getSharedOfflineSemanticReranker, resetSharedOfflineSemanticReranker } from '../agent/offline-semantic-runtime.js';

const TARGET = 'offscreen-offline-rag';
const INDEX_PROGRESS_TARGET = 'offscreen-offline-rag-index-progress';
const ALLOWED_SOURCES = new Set(['wikipedia', 'emergency-box']);
const requests = new Map();

const lazySemanticReranker = Object.freeze({
  rerank(...args) {
    return getSharedOfflineSemanticReranker().rerank(...args);
  },
  embedQuery(...args) {
    return getSharedOfflineSemanticReranker().embedQuery(...args);
  },
  reset() {
    resetSharedOfflineSemanticReranker();
  },
  close() {
    resetSharedOfflineSemanticReranker();
  },
});
const indexClient = createOfflineRagIndexClient();
const retrievalService = createOfflineRetrievalService({
  semanticReranker: lazySemanticReranker,
  indexClient,
});

function stringArray(values, predicate, maximum) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(predicate))].slice(0, maximum);
}

function wikipediaQueries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([language, query]) => [String(language || '').trim().toLowerCase(), String(query || '').trim().slice(0, 500)])
    .filter(([language, query]) => /^[a-z]{3}$/.test(language) && query)
    .slice(0, 24));
}

function serializeError(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 80),
    message: String(error?.message || error || 'Offline reference search failed.').slice(0, 1_000),
    code: String(error?.code || '').slice(0, 80),
  };
}

async function handleRequest(message) {
  const requestId = String(message.requestId || '').slice(0, 100);
  if (!requestId || requests.has(requestId)) throw new Error('Offline retrieval request ID is invalid.');
  const controller = new AbortController();
  requests.set(requestId, controller);
  try {
    if (message.action === 'status') return await retrievalService.status();
    if (message.action === 'search') {
      const query = String(message.query || '').trim().slice(0, 4_000);
      const sources = stringArray(message.options?.sources, value => ALLOWED_SOURCES.has(value), 2);
      const languages = stringArray(message.options?.languages, value => /^[a-z]{3}$/.test(value), 64);
      const queryLanguage = String(message.options?.queryLanguage || '').trim().toLowerCase();
      return await retrievalService.search(query, {
        sources: sources.length ? sources : [...ALLOWED_SOURCES],
        languages,
        semanticQuery: String(message.options?.semanticQuery || '').trim().slice(0, 4_000),
        queryLanguage: /^[a-z]{3}$/.test(queryLanguage) ? queryLanguage : '',
        wikipediaQueriesByLanguage: wikipediaQueries(message.options?.wikipediaQueriesByLanguage),
        limit: Math.min(12, Math.max(1, Number(message.options?.limit) || 6)),
        signal: controller.signal,
      });
    }
    if (message.action === 'prepare-emergency-index') {
      return await indexClient.buildEmergencyIndex({
        manifest: message.manifest,
        installId: String(message.installId || ''),
        indexPath: String(message.indexPath || ''),
        signal: controller.signal,
        onProgress(progress) {
          void chrome.runtime.sendMessage({
            target: INDEX_PROGRESS_TARGET,
            requestId,
            progress,
          }).catch(() => {});
        },
      });
    }
    if (message.action === 'delete-index') {
      return await indexClient.deleteIndex(String(message.indexPath || ''));
    }
    throw new Error('Unsupported offline retrieval action.');
  } finally {
    requests.delete(requestId);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== TARGET) return false;
  if (message.action === 'cancel') {
    requests.get(String(message.requestId || ''))?.abort();
    sendResponse({ ok: true });
    return false;
  }
  handleRequest(message).then(
    result => sendResponse({ ok: true, result }),
    error => sendResponse({ ok: false, error: serializeError(error) }),
  );
  return true;
});
