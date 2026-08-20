/** Cancellable MV3 proxy for offline retrieval hosted in the offscreen document. */

import { ensureOffscreen } from '../offscreen/ensure.js';

const TARGET = 'offscreen-offline-rag';
const ALLOWED_SOURCES = new Set(['wikipedia', 'emergency-box']);
let nextRequestId = 1;

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('Offline reference search canceled.', 'AbortError');
}

function remoteError(value = {}) {
  const error = value.name === 'AbortError'
    ? new DOMException(value.message || 'Offline reference search canceled.', 'AbortError')
    : new Error(value.message || 'Offline reference search failed.');
  if (value.code) error.code = value.code;
  return error;
}

function boundedStrings(values, predicate, maximum) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(predicate))].slice(0, maximum);
}

function boundedWikipediaQueries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([language, query]) => [String(language || '').trim().toLowerCase(), String(query || '').trim().slice(0, 500)])
    .filter(([language, query]) => /^[a-z]{3}$/.test(language) && query)
    .slice(0, 24));
}

export function createOffscreenOfflineRetrievalService(options = {}) {
  const api = options.api || globalThis.chrome;
  const ensureHost = options.ensureHost || ensureOffscreen;
  if (!api?.runtime?.sendMessage) throw new Error('Chrome runtime messaging is unavailable.');

  const request = async (action, payload = {}, requestOptions = {}) => {
    const signal = requestOptions.signal;
    if (signal?.aborted) throw abortError(signal);
    await ensureHost();
    if (signal?.aborted) throw abortError(signal);

    const requestId = `${Date.now().toString(36)}-${nextRequestId++}`;
    let cancellationSent = false;
    const cancel = () => {
      if (cancellationSent) return;
      cancellationSent = true;
      void api.runtime.sendMessage({ target: TARGET, action: 'cancel', requestId }).catch(() => {});
    };
    signal?.addEventListener?.('abort', cancel, { once: true });
    try {
      const response = await api.runtime.sendMessage({ target: TARGET, action, requestId, ...payload });
      if (signal?.aborted) throw abortError(signal);
      if (response?.ok !== true) throw remoteError(response?.error);
      return response.result;
    } finally {
      signal?.removeEventListener?.('abort', cancel);
    }
  };

  return Object.freeze({
    async status(requestOptions = {}) {
      return await request('status', {}, requestOptions);
    },
    async search(queryValue, searchOptions = {}) {
      const query = String(queryValue || '').trim().slice(0, 4_000);
      const sources = boundedStrings(searchOptions.sources, value => ALLOWED_SOURCES.has(value), 2);
      const languages = boundedStrings(searchOptions.languages, value => /^[a-z]{3}$/.test(value), 64);
      const queryLanguage = String(searchOptions.queryLanguage || '').trim().toLowerCase();
      return await request('search', {
        query,
        options: {
          sources: sources.length ? sources : [...ALLOWED_SOURCES],
          languages,
          semanticQuery: String(searchOptions.semanticQuery || '').trim().slice(0, 4_000),
          queryLanguage: /^[a-z]{3}$/.test(queryLanguage) ? queryLanguage : '',
          wikipediaQueriesByLanguage: boundedWikipediaQueries(searchOptions.wikipediaQueriesByLanguage),
          limit: Math.min(12, Math.max(1, Number(searchOptions.limit) || 6)),
        },
      }, searchOptions);
    },
  });
}
