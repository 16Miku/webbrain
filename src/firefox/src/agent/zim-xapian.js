/**
 * Xapian search boundary for installed Wikipedia ZIM archives.
 *
 * The GPL worker is vendored under vendor/libzim/. This file stays
 * license-neutral: it opens a session, normalizes snippets, and falls back to
 * title lookup when the archive has no index or the worker fails.
 */

export const JAVASCRIPT_LIBZIM_VERSION = '0.95';
export const JAVASCRIPT_LIBZIM_COMMIT = '470b36920fba421a4c1a83b326e66d8aa0533870';
export const LIBZIM_VERSION = '9.8.1';
export const XAPIAN_VERSION = '1.4.31';
export const ZIM_XAPIAN_DISTRIBUTION_STATUS = 'bundled-from-source';
export const ZIM_XAPIAN_RUNTIME_BUNDLED = true;

const MAX_RESULTS_PER_ARCHIVE = 10;
const MAX_EXCERPT_CHARS = 4_000;

function supportsWikipediaRecord(record) {
  return record?.archiveKind === 'wikipedia'
    && (record?.target?.kind === 'opfs' || record?.target?.kind === 'file-handle');
}

function boundedLimit(value) {
  const number = Number.parseInt(String(value || ''), 10);
  return Math.max(1, Math.min(MAX_RESULTS_PER_ARCHIVE, Number.isSafeInteger(number) ? number : MAX_RESULTS_PER_ARCHIVE));
}

function decodeEntity(_match, numeric, named) {
  if (numeric) {
    const hexadecimal = numeric[0]?.toLowerCase() === 'x';
    const point = Number.parseInt(hexadecimal ? numeric.slice(1) : numeric, hexadecimal ? 16 : 10);
    try { return Number.isSafeInteger(point) ? String.fromCodePoint(point) : ' '; }
    catch { return ' '; }
  }
  return ({ amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' })[String(named || '').toLowerCase()] || ' ';
}

export function normalizeXapianSnippet(value) {
  return String(value || '')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);|&(amp|apos|gt|lt|nbsp|quot);/gi, decodeEntity)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EXCERPT_CHARS);
}

function resultValue(result, property, getter) {
  if (result?.[property] != null) return result[property];
  if (typeof result?.[getter] === 'function') return result[getter]();
  return '';
}

export function normalizeXapianResults(results, record, options = {}) {
  const normalized = [];
  const maximum = boundedLimit(options.limit);
  for (const result of Array.isArray(results) ? results : []) {
    const path = String(resultValue(result, 'path', 'getPath') || '').trim().replace(/^\/+/, '');
    if (!path) continue;
    const title = String(resultValue(result, 'title', 'getTitle') || path.replace(/_/g, ' ')).trim();
    const excerpt = normalizeXapianSnippet(resultValue(result, 'snippet', 'getSnippet'));
    const scoreValue = resultValue(result, 'score', 'getScore');
    const rawScore = scoreValue === '' || scoreValue == null ? Number.NaN : Number(scoreValue);
    normalized.push(Object.freeze({
      archiveId: String(record.id || ''),
      archiveTitle: String(record.title || record.filename || 'Wikipedia'),
      archiveDate: String(record.archiveDate || ''),
      language: String(record.language || 'und').toLowerCase(),
      path,
      title,
      excerpt: excerpt || title,
      locator: title,
      lexicalScore: Number.isFinite(rawScore) ? rawScore : maximum - normalized.length,
      retrievalMode: 'xapian-full-text',
      source: String(record.source || 'Kiwix / openZIM'),
      license: String(record.license || ''),
    }));
    if (normalized.length >= maximum) break;
  }
  return normalized;
}

function statusReporter(callback, record) {
  return (status, details = {}) => {
    try { callback?.({ status, archiveId: String(record?.id || ''), ...details }); }
    catch {}
  };
}

/**
 * Create a provider compatible with searchApocalypseArchives().
 *
 * runtime.openArchive({ source, record }) must resolve to a session with:
 *   hasFullTextIndex(): Promise<boolean> | boolean
 *   searchWithSnippets(query, { limit, language }): Promise<Array<Result>>
 *   close(): Promise<void> | void
 */
export function createZimXapianProvider(options = {}) {
  const runtime = options.runtime || null;
  const storage = options.storage || null;
  const fallbackProvider = options.fallbackProvider || null;

  async function fallback(record, query, searchOptions, reason, error = null) {
    statusReporter(searchOptions.onSearchStatus || options.onStatus, record)('title-only-fallback', {
      reason,
      error: error ? String(error?.message || error) : '',
    });
    if (!fallbackProvider?.search) return [];
    return await fallbackProvider.search(record, query, searchOptions);
  }

  return Object.freeze({
    id: 'zim-xapian',
    distributionStatus: ZIM_XAPIAN_DISTRIBUTION_STATUS,
    supports: supportsWikipediaRecord,
    async search(record, queryValue, searchOptions = {}) {
      const query = String(queryValue || '').trim();
      if (!query) return [];
      if (!runtime?.openArchive) {
        return await fallback(record, query, searchOptions, 'runtime-not-bundled');
      }

      let session = null;
      let delegatedToFallback = false;
      try {
        const source = storage?.open
          ? await storage.open(record.target)
          : await record?.target?.handle?.getFile?.();
        if (!source) throw new Error('The installed archive could not be opened for Xapian search.');
        session = await runtime.openArchive({ source, record });
        if (typeof session?.hasFullTextIndex !== 'function' || !await session.hasFullTextIndex()) {
          delegatedToFallback = true;
          return await fallback(record, query, searchOptions, 'full-text-index-missing');
        }
        if (typeof session.searchWithSnippets !== 'function') {
          throw new Error('The bundled Xapian worker does not implement searchWithSnippets().');
        }
        const limit = boundedLimit(searchOptions.limit);
        const results = await session.searchWithSnippets(query, {
          limit,
          language: String(record.language || ''),
        });
        statusReporter(searchOptions.onSearchStatus || options.onStatus, record)('xapian-full-text');
        return normalizeXapianResults(results, record, { limit });
      } catch (error) {
        if (delegatedToFallback) throw error;
        return await fallback(record, query, searchOptions, 'xapian-runtime-error', error);
      } finally {
        try { await session?.close?.(); } catch {}
      }
    },
    async read(record, path, readOptions = {}) {
      if (!fallbackProvider?.read) throw new Error('This archive cannot be opened by the text reader.');
      return await fallbackProvider.read(record, path, readOptions);
    },
    async readImage(record, path, readOptions = {}) {
      if (!fallbackProvider?.readImage) throw new Error('This archive cannot provide reader images.');
      return await fallbackProvider.readImage(record, path, readOptions);
    },
  });
}
