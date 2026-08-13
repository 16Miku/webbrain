const DB_NAME = 'webbrain_wikipedia';
const DB_VERSION = 1;
const ARTICLE_STORE = 'articles';
const META_STORE = 'meta';
const BUILT_IN_SOURCE = 'skills/wikipedia.md';
const SEARCH_TOOL = 'search_wikipedia';
const SUMMARY_TOOL = 'get_wikipedia_summary';
const SEARCH_STOP_WORDS = new Set([
  'about', 'and', 'are', 'for', 'from', 'how', 'into', 'the', 'this', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
]);

export const WIKIPEDIA_SYNC_ALARM = 'wb_wikipedia_offline_sync';
export const WIKIPEDIA_CATALOG_REVISION = 1368863307;
export const WIKIPEDIA_SYNC_BATCH_SIZE = 20;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Wikipedia storage transaction aborted.'));
  });
}

function normalizeTitle(value) {
  return String(value || '').replace(/_/g, ' ').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pageUrl(title, candidate = '') {
  if (/^https:\/\/en\.wikipedia\.org\/wiki\//.test(String(candidate || ''))) return candidate;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title || '').replace(/ /g, '_'))}`;
}

function normalizeRecord(page = {}) {
  const title = cleanText(page.title || page.key);
  const extract = cleanText(page.extract || page.excerpt || page.description);
  if (!title || !extract) return null;
  return {
    key: normalizeTitle(title),
    pageid: Number(page.pageid ?? page.id) || null,
    title,
    extract: extract.slice(0, 4000),
    url: pageUrl(title, page.canonicalurl || page.fullurl || page.url),
    revision: Number(page.lastrevid ?? page.revision) || null,
    license: 'CC BY-SA 4.0',
    modified: 'Introduction extracted and normalized to plain text by WebBrain.',
    updatedAt: Date.now(),
  };
}

export function mergeWikipediaRecords(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const existingHasRevision = Number(existing.revision) > 0;
  const incomingHasRevision = Number(incoming.revision) > 0;
  const preferIncoming = incomingHasRevision !== existingHasRevision
    ? incomingHasRevision
    : String(incoming.extract || '').length >= String(existing.extract || '').length;
  const contentRecord = preferIncoming ? incoming : existing;
  return {
    ...contentRecord,
    updatedAt: Math.max(Number(existing.updatedAt) || 0, Number(incoming.updatedAt) || 0) || contentRecord.updatedAt,
  };
}

export function createWikipediaStore(indexedDb = globalThis.indexedDB) {
  let databasePromise = null;
  const open = () => {
    if (!indexedDb) return Promise.reject(new Error('IndexedDB is unavailable.'));
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDb.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(ARTICLE_STORE)) {
          database.createObjectStore(ARTICLE_STORE, { keyPath: 'key' });
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return databasePromise;
  };
  return {
    async get(title) {
      const db = await open();
      return await requestResult(db.transaction(ARTICLE_STORE, 'readonly').objectStore(ARTICLE_STORE).get(normalizeTitle(title)));
    },
    async getAll() {
      const db = await open();
      return await requestResult(db.transaction(ARTICLE_STORE, 'readonly').objectStore(ARTICLE_STORE).getAll());
    },
    async putMany(records) {
      const db = await open();
      const transaction = db.transaction(ARTICLE_STORE, 'readwrite');
      const store = transaction.objectStore(ARTICLE_STORE);
      for (const value of records || []) {
        const record = normalizeRecord(value);
        if (!record) continue;
        const request = store.get(record.key);
        request.onsuccess = () => store.put(mergeWikipediaRecords(request.result, record));
      }
      await transactionDone(transaction);
    },
    async getMeta(key) {
      const db = await open();
      return (await requestResult(db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(key)))?.value;
    },
    async setMeta(key, value) {
      const db = await open();
      const transaction = db.transaction(META_STORE, 'readwrite');
      transaction.objectStore(META_STORE).put({ key, value });
      await transactionDone(transaction);
    },
    async status() {
      const db = await open();
      const transaction = db.transaction([ARTICLE_STORE, META_STORE], 'readonly');
      const countRequest = transaction.objectStore(ARTICLE_STORE).count();
      const syncRequest = transaction.objectStore(META_STORE).get('sync');
      const [articleCount, syncRecord] = await Promise.all([
        requestResult(countRequest),
        requestResult(syncRequest),
      ]);
      const sync = syncRecord?.value || {};
      return { articleCount, ...sync };
    },
    async clear() {
      const db = await open();
      const transaction = db.transaction([ARTICLE_STORE, META_STORE], 'readwrite');
      transaction.objectStore(ARTICLE_STORE).clear();
      transaction.objectStore(META_STORE).clear();
      await transactionDone(transaction);
    },
  };
}

function terms(value) {
  const tokens = String(value || '').toLocaleLowerCase('en').match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) || [];
  return [...new Set(tokens.filter(token => (token.length >= 2 || /^[a-z](?:\+\+|#)$/i.test(token)) && !SEARCH_STOP_WORDS.has(token)))];
}

function passage(extract, queryTerms, maxChars = 800) {
  const text = cleanText(extract);
  if (text.length <= maxChars) return text;
  const lower = text.toLocaleLowerCase('en');
  const first = queryTerms.map(term => lower.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0] || 0;
  const start = Math.max(0, first - Math.floor(maxChars / 3));
  return `${start ? '…' : ''}${text.slice(start, start + maxChars).trim()}${start + maxChars < text.length ? '…' : ''}`;
}

export function searchWikipediaRecords(records, query, limit = 5) {
  const queryText = cleanText(query).toLocaleLowerCase('en');
  const queryTerms = terms(queryText);
  if (!queryTerms.length) return [];
  return (records || []).map((record) => {
    const title = cleanText(record.title).toLocaleLowerCase('en');
    const body = cleanText(record.extract).toLocaleLowerCase('en');
    let score = title === queryText ? 1000 : title.startsWith(queryText) ? 600 : title.includes(queryText) ? 400 : 0;
    for (const term of queryTerms) {
      if (title.split(/\W+/u).includes(term)) score += 80;
      else if (title.includes(term)) score += 35;
      const matches = body.split(term).length - 1;
      score += Math.min(matches, 5) * 8;
    }
    return { record, score };
  }).filter(result => result.score > 0)
    .sort((left, right) => right.score - left.score || left.record.title.localeCompare(right.record.title))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)))
    .map(({ record }) => ({
      id: record.pageid,
      title: record.title,
      excerpt: passage(record.extract, queryTerms),
      url: record.url,
      revision: record.revision || null,
      license: record.license || 'CC BY-SA 4.0',
      modified: record.modified || 'Introduction extracted and normalized to plain text by WebBrain.',
    }));
}

function isBuiltInWikipediaTool(tool) {
  return isBuiltInWikipediaProvenance(tool, 'skillId')
    && (tool?.name === SEARCH_TOOL || tool?.name === SUMMARY_TOOL);
}

function isBuiltInWikipediaProvenance(value, idField = 'id') {
  return value?.[idField] === 'wikipedia'
    && value?.sourceType === 'built-in'
    && value?.sourceUrl === BUILT_IN_SOURCE;
}

function recordsFromOnlineResult(toolName, result) {
  if (!result?.success) return [];
  if (toolName === SEARCH_TOOL) return (result.data?.pages || []).map(normalizeRecord).filter(Boolean);
  const pages = result.data?.query?.pages;
  return (Array.isArray(pages) ? pages : Object.values(pages || {})).map(normalizeRecord).filter(Boolean);
}

function localResult(tool, records, status, originalError) {
  if (!records.length) return {
    success: false,
    provider: 'local Wikipedia cache',
    skillTool: tool.name,
    skillName: tool.skillName || 'Wikipedia',
    offline: true,
    cache: status,
    error: `${originalError || 'Wikipedia is unavailable.'} No matching offline Wikipedia article is cached yet.`,
  };
  if (tool.name === SEARCH_TOOL) {
    return {
      success: true,
      status: 200,
      provider: 'local Wikipedia cache',
      skillTool: tool.name,
      skillName: tool.skillName || 'Wikipedia',
      offline: true,
      cache: status,
      license: 'Wikipedia text is available under CC BY-SA 4.0; each result links to its article history for attribution.',
      data: { pages: records },
    };
  }
  const record = records[0];
  return {
    success: true,
    status: 200,
    provider: 'local Wikipedia cache',
    skillTool: tool.name,
    skillName: tool.skillName || 'Wikipedia',
    offline: true,
    cache: status,
    license: 'Wikipedia text is available under CC BY-SA 4.0; the canonical article URL provides attribution and revision history.',
    data: {
      query: {
        pages: {
          [record.id || record.title]: {
            pageid: record.id,
            title: record.title,
            extract: record.excerpt,
            fullurl: record.url,
            canonicalurl: record.url,
            lastrevid: record.revision,
            license: record.license,
            modified: record.modified,
          },
        },
      },
    },
  };
}

export async function executeWikipediaSkillTool(tool, args = {}, options = {}) {
  const executeOnline = options.executeOnline;
  if (typeof executeOnline !== 'function') {
    return { success: false, error: 'Wikipedia online executor is unavailable.' };
  }
  if (!isBuiltInWikipediaTool(tool)) {
    return await executeOnline(tool, args, options);
  }
  const store = options.store || createWikipediaStore();
  let online;
  if (options.online !== false && globalThis.navigator?.onLine !== false) {
    online = await executeOnline(tool, args, options);
    if (online?.success) {
      const records = recordsFromOnlineResult(tool.name, online);
      if (records.length) await store.putMany(records).catch(() => {});
      return online;
    }
  }
  const status = await store.status().catch(() => ({ articleCount: 0, state: 'unavailable' }));
  const query = tool.name === SEARCH_TOOL ? args.q : args.titles;
  let matches = [];
  if (tool.name === SUMMARY_TOOL) {
    const exact = await store.get(query).catch(() => null);
    if (exact) matches = searchWikipediaRecords([exact], query, 1);
  }
  if (!matches.length) {
    const all = await store.getAll().catch(() => []);
    matches = searchWikipediaRecords(all, query, tool.name === SEARCH_TOOL ? args.limit : 1);
  }
  return localResult(tool, matches, status, online?.error);
}

function wikiApiUrl(parameters) {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  for (const [key, value] of Object.entries({ action: 'query', format: 'json', formatversion: 2, maxlag: 5, ...parameters })) {
    url.searchParams.set(key, String(value));
  }
  return url.href;
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'GET',
    credentials: 'omit',
    headers: { 'Api-User-Agent': 'WebBrain offline Wikipedia sync (https://github.com/webbrain-one/webbrain)' },
  });
  if (!response.ok) throw new Error(`Wikipedia sync returned HTTP ${response.status}.`);
  return await response.json();
}

export async function syncWikipediaOfflineBatch(options = {}) {
  const store = options.store || createWikipediaStore();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Wikipedia sync fetch is unavailable.');
  let sync = await store.getMeta('sync').catch(() => null);
  let titles = await store.getMeta('titles').catch(() => null);
  if (!sync || sync.catalogRevision !== WIKIPEDIA_CATALOG_REVISION || !Array.isArray(titles)) {
    const catalog = await fetchJson(wikiApiUrl({
      action: 'parse',
      oldid: WIKIPEDIA_CATALOG_REVISION,
      prop: 'links|revid',
    }), fetchImpl);
    if (Number(catalog.parse?.revid) !== WIKIPEDIA_CATALOG_REVISION) {
      throw new Error('Wikipedia vital-article catalog revision did not match the pinned revision.');
    }
    titles = (catalog.parse?.links || []).filter(link => link.ns === 0).map(link => link.title);
    if (titles.length < 900 || titles.length > 1100) {
      throw new Error(`Wikipedia vital-article catalog had an unexpected size (${titles.length}).`);
    }
    sync = { state: 'downloading', catalogRevision: WIKIPEDIA_CATALOG_REVISION, cursor: 0, total: titles.length };
    await store.setMeta('titles', titles);
  }
  const cursor = Math.max(0, Number(sync.cursor) || 0);
  const batch = titles.slice(cursor, cursor + WIKIPEDIA_SYNC_BATCH_SIZE);
  if (batch.length) {
    const response = await fetchJson(wikiApiUrl({
      prop: 'extracts|info',
      exintro: 1,
      explaintext: 1,
      exchars: 2400,
      inprop: 'url',
      redirects: 1,
      titles: batch.join('|'),
    }), fetchImpl);
    await store.putMany(response.query?.pages || []);
  }
  const nextCursor = cursor + batch.length;
  const finished = nextCursor >= titles.length;
  const next = {
    state: finished ? 'ready' : 'downloading',
    catalogRevision: WIKIPEDIA_CATALOG_REVISION,
    cursor: nextCursor,
    total: titles.length,
    updatedAt: Date.now(),
  };
  await store.setMeta('sync', next);
  return next;
}

export function hasBuiltInWikipediaSkill(skills) {
  return (skills || []).some(skill => isBuiltInWikipediaProvenance(skill));
}

export async function configureWikipediaOfflineSync(api, skills, options = {}) {
  const store = options.store || createWikipediaStore();
  if (!hasBuiltInWikipediaSkill(skills)) {
    await api?.alarms?.clear?.(WIKIPEDIA_SYNC_ALARM);
    await store.clear().catch(() => {});
    return { enabled: false };
  }
  await api?.alarms?.create?.(WIKIPEDIA_SYNC_ALARM, { delayInMinutes: 1 });
  return { enabled: true };
}

export async function handleWikipediaOfflineAlarm(alarm, api, skills, options = {}) {
  if (alarm?.name !== WIKIPEDIA_SYNC_ALARM || !hasBuiltInWikipediaSkill(skills)) return false;
  const state = await syncWikipediaOfflineBatch(options);
  if (state.state !== 'ready') {
    await api?.alarms?.create?.(WIKIPEDIA_SYNC_ALARM, { delayInMinutes: 1 });
  }
  return true;
}
