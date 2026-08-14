import { decompress as decompressZstd } from '../../vendor/fzstd.js';

const KIWIX_CATALOG_URL = 'https://library.kiwix.org/catalog/v2/entries';
const UNDECLARED_LICENSE_NOTICE = 'Not declared by the current catalog/archive metadata. Wikipedia text is generally CC BY-SA 4.0 unless otherwise noted; archive components may use additional licenses.';
export const APOCALYPSE_FILE_PERMISSION_REQUIRED = 'file-permission-required';

function filePermissionError() {
  const error = new Error('File access requires confirmation. Open Apocalypse Mode and authorize the selected archive file again.');
  error.name = 'NotAllowedError';
  error.code = APOCALYPSE_FILE_PERMISSION_REQUIRED;
  return error;
}

function isFilePermissionError(error, target) {
  return target?.kind === 'file-handle'
    && (error?.code === APOCALYPSE_FILE_PERMISSION_REQUIRED
      || error?.name === 'NotAllowedError'
      || error?.name === 'SecurityError');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function tagText(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXml(match?.[1]);
}

function attrText(source, name) {
  const match = String(source || '').match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'));
  return decodeXml(match?.[1]);
}

function positiveInteger(value) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function classifyArchiveTier(name, flavour) {
  const normalizedName = String(name || '').toLowerCase();
  const normalizedFlavour = String(flavour || '').toLowerCase();
  if (!/(?:^|_)all(?:_|$)/.test(normalizedName)) return 'starter';
  if (normalizedFlavour === 'mini') return 'introductions';
  if (normalizedFlavour === 'nopic') return 'text';
  return 'full';
}

export function parseKiwixCatalog(xml) {
  const entries = String(xml || '').match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  return entries.map((entry) => {
    const acquisition = (entry.match(/<link\b[^>]*\brel=["']http:\/\/opds-spec\.org\/acquisition\/open-access["'][^>]*>/i) || [])[0] || '';
    const name = tagText(entry, 'name');
    const flavour = tagText(entry, 'flavour');
    const author = tagText((entry.match(/<author(?:\s[^>]*)?>[\s\S]*?<\/author>/i) || [])[0], 'name');
    const publisher = tagText((entry.match(/<publisher(?:\s[^>]*)?>[\s\S]*?<\/publisher>/i) || [])[0], 'name');
    const declaredLicense = tagText(entry, 'dc:rights') || tagText(entry, 'rights');
    return {
      id: tagText(entry, 'id').replace(/^urn:uuid:/i, ''),
      title: tagText(entry, 'title'),
      summary: tagText(entry, 'summary'),
      language: tagText(entry, 'language'),
      name,
      flavour,
      tier: classifyArchiveTier(name, flavour),
      tags: tagText(entry, 'tags').split(';').filter(Boolean),
      articleCount: positiveInteger(tagText(entry, 'articleCount')),
      archiveDate: tagText(entry, 'dc:issued') || tagText(entry, 'updated'),
      metaUrl: attrText(acquisition, 'href'),
      catalogSize: positiveInteger(attrText(acquisition, 'length')),
      source: [author, publisher].filter(Boolean).join(' / ') || 'Kiwix / openZIM',
      license: declaredLicense || UNDECLARED_LICENSE_NOTICE,
      licenseDeclared: Boolean(declaredLicense),
    };
  }).filter(item => item.id && item.language && item.metaUrl);
}

export function resolveKiwixDownload(item, metalinkXml) {
  const fileBlock = (String(metalinkXml || '').match(/<file\b[^>]*>[\s\S]*?<\/file>/i) || [])[0] || '';
  const pieces = (fileBlock.match(/<pieces\b[^>]*>[\s\S]*?<\/pieces>/i) || [])[0] || '';
  const pieceHashes = Array.from(pieces.matchAll(/<hash(?:\s[^>]*)?>([\s\S]*?)<\/hash>/gi), match => decodeXml(match[1]).toLowerCase());
  const mirrors = Array.from(fileBlock.matchAll(/<url\b([^>]*)>([\s\S]*?)<\/url>/gi), match => ({
    priority: positiveInteger(attrText(match[1], 'priority')) || Number.MAX_SAFE_INTEGER,
    url: decodeXml(match[2]),
  })).filter(mirror => /^https:\/\//.test(mirror.url)).sort((a, b) => a.priority - b.priority);
  const sha256Node = (fileBlock.match(/<hash\b[^>]*\btype=["']sha-256["'][^>]*>[\s\S]*?<\/hash>/i) || [])[0] || '';
  const resolved = {
    ...item,
    filename: attrText((fileBlock.match(/<file\b[^>]*>/i) || [])[0], 'name'),
    size: positiveInteger(tagText(fileBlock, 'size')),
    sha256: tagText(sha256Node, 'hash').toLowerCase(),
    pieceLength: positiveInteger(attrText((pieces.match(/<pieces\b[^>]*>/i) || [])[0], 'length')),
    pieceHashAlgorithm: attrText((pieces.match(/<pieces\b[^>]*>/i) || [])[0], 'type').toLowerCase(),
    pieceHashes,
    mirrors: mirrors.map(mirror => mirror.url),
    downloadUrl: mirrors[0]?.url || '',
  };
  if (!resolved.filename || !resolved.size || !resolved.downloadUrl || !resolved.pieceLength || resolved.pieceHashes.length === 0) {
    throw new Error('Kiwix Metalink did not include a complete resumable download description.');
  }
  if (resolved.pieceHashes.length !== Math.ceil(resolved.size / resolved.pieceLength)) {
    throw new Error('Kiwix Metalink piece count does not match the archive size.');
  }
  if (!['sha-1', 'sha-256'].includes(resolved.pieceHashAlgorithm)) {
    throw new Error(`Unsupported Kiwix piece hash algorithm (${resolved.pieceHashAlgorithm || 'missing'}).`);
  }
  return resolved;
}

export function kiwixCatalogUrl(language) {
  const url = new URL(KIWIX_CATALOG_URL);
  url.searchParams.set('lang', String(language || 'eng'));
  url.searchParams.set('q', 'wikipedia');
  url.searchParams.set('count', '200');
  return url.href;
}

export function normalizeStorageEstimate(estimate = {}) {
  const rawUsage = estimate?.usage == null ? 0 : Number(estimate.usage);
  const rawQuota = estimate?.quota == null ? null : Number(estimate.quota);
  const usage = Number.isFinite(rawUsage) ? Math.max(0, rawUsage) : null;
  const quota = Number.isFinite(rawQuota) ? Math.max(0, rawQuota) : null;
  const known = usage != null && quota != null;
  return { known, usage, quota, free: known ? Math.max(0, quota - usage) : null };
}

export function selectKiwixUpdate(installed, catalogItems) {
  return (catalogItems || [])
    .filter(item => item.name === installed?.name
      && item.flavour === installed?.flavour
      && String(item.archiveDate || '') > String(installed?.archiveDate || ''))
    .sort((left, right) => String(right.archiveDate || '').localeCompare(String(left.archiveDate || '')))[0] || null;
}

const ZIM_MAGIC = 0x044d495a;
const MAX_DIRECTORY_ENTRY_BYTES = 64 * 1024;
const ISO_639_3_TO_1 = Object.freeze({
  ara: 'ar', ben: 'bn', deu: 'de', eng: 'en', spa: 'es', fas: 'fa', fra: 'fr', hin: 'hi',
  ind: 'id', ita: 'it', jpn: 'ja', kor: 'ko', nld: 'nl', pol: 'pl', por: 'pt',
  rus: 'ru', swe: 'sv', tgl: 'tl', tur: 'tr', ukr: 'uk', vie: 'vi', zho: 'zh',
});

async function sourceBlob(source) {
  if (typeof source?.getFile === 'function') return await source.getFile();
  if (typeof source?.slice !== 'function') throw new Error('A ZIM Blob or file handle is required.');
  return source;
}

async function blobBytes(blob, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > blob.size) {
    throw new Error('ZIM pointer is outside the archive.');
  }
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function safeUint64(view, offset) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIM archive is too large for this browser.');
  return Number(value);
}

function nulString(bytes, start) {
  const end = bytes.indexOf(0, start);
  if (end < 0) throw new Error('ZIM directory entry contains an unterminated string.');
  return { value: new TextDecoder().decode(bytes.subarray(start, end)), next: end + 1 };
}

function decodeHtmlText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code[0].toLowerCase() === 'x' ? code.slice(1) : code, code[0].toLowerCase() === 'x' ? 16 : 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function relevantPassage(text, query, maxChars = 2400) {
  if (text.length <= maxChars) return text;
  const lower = text.toLocaleLowerCase();
  const offsets = String(query || '').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length >= 3)
    .map(token => lower.indexOf(token))
    .filter(offset => offset >= 0)
    .sort((left, right) => left - right);
  const start = Math.max(0, (offsets[0] || 0) - Math.floor(maxChars / 4));
  return `${start ? '…' : ''}${text.slice(start, start + maxChars).trim()}${start + maxChars < text.length ? '…' : ''}`;
}

function queryPaths(query) {
  const normalized = String(query || '').trim().replace(/\s+/g, '_');
  if (!normalized) return [];
  const capitalized = normalized[0].toUpperCase() + normalized.slice(1);
  const titleCased = normalized.split('_').map(token => token ? token[0].toUpperCase() + token.slice(1) : '').join('_');
  const tokens = normalized.split('_').filter(token => token.length >= 3);
  return Array.from(new Set([normalized, capitalized, titleCased, ...tokens, ...tokens.map(token => token[0].toUpperCase() + token.slice(1))]));
}

function normalizedTitleTerms(value) {
  return String(value || '').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 2);
}

function redirectAliasMatchesDestination(alias, destination) {
  const aliasTerms = normalizedTitleTerms(alias?.title || alias?.url);
  const destinationTerms = normalizedTitleTerms(destination?.title || destination?.url);
  if (aliasTerms.some(term => destinationTerms.includes(term))) return true;
  const insignificant = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'the', 'to']);
  const initials = destinationTerms.filter(term => !insignificant.has(term)).map(term => term[0]).join('');
  return aliasTerms.length === 1 && aliasTerms[0].length >= 2 && aliasTerms[0] === initials;
}

export function rankZimTitleCandidates(candidates, query, limit = 3) {
  const normalizedQuery = String(query || '').trim().replace(/\s+/g, '_').toLocaleLowerCase();
  const queryTerms = normalizedTitleTerms(query);
  const minimumMatches = queryTerms.length > 1 ? 2 : 1;
  const unique = new Map();
  for (const candidate of candidates || []) {
    if (!candidate || unique.has(candidate.index)) continue;
    const normalizedTitle = String(candidate.searchTitle || candidate.searchUrl || candidate.title || candidate.url || '').replace(/\s+/g, '_').toLocaleLowerCase();
    const titleTerms = new Set(normalizedTitleTerms(normalizedTitle));
    const matches = queryTerms.filter(term => titleTerms.has(term)).length;
    const fullPrefix = normalizedTitle.startsWith(normalizedQuery);
    if (!fullPrefix && matches < minimumMatches) continue;
    const exact = normalizedTitle === normalizedQuery;
    unique.set(candidate.index, {
      candidate,
      score: (exact ? 1000 : 0) + (fullPrefix ? 400 : 0) + matches * 100 - Math.abs(titleTerms.size - queryTerms.length),
    });
  }
  return Array.from(unique.values())
    .sort((left, right) => right.score - left.score || left.candidate.index - right.candidate.index)
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 3)))
    .map(item => item.candidate);
}

export function mergeZimProvenance(metadata = {}, embedded = {}) {
  const declaredLicense = embedded.License || (metadata.licenseDeclared === false ? '' : metadata.license);
  return {
    language: String(embedded.Language?.split(/[;,]/)[0] || metadata.language || 'eng'),
    archiveDate: embedded.Date || metadata.archiveDate || '',
    source: embedded.Source || [embedded.Creator, embedded.Publisher].filter(Boolean).join(' / ') || metadata.source || 'Kiwix / openZIM',
    license: declaredLicense || metadata.license || UNDECLARED_LICENSE_NOTICE,
    licenseDeclared: Boolean(declaredLicense),
  };
}

export function assertWikipediaZimArchive(embedded = {}) {
  const source = String(embedded.Source || '').toLocaleLowerCase();
  const name = String(embedded.Name || '').toLocaleLowerCase();
  const tags = String(embedded.Tags || '').toLocaleLowerCase().split(/[;,]/).map(tag => tag.trim());
  const wikipediaSource = /(?:^|[/:?\s(])(?:[a-z0-9-]+\.)*wikipedia\.org(?=$|[/:?#\s;,\)])/i.test(source);
  const wikipediaName = /^wikipedia(?:_|$)/i.test(name);
  const wikipediaTag = tags.some(tag => tag === 'wikipedia' || tag === '_category:wikipedia' || tag.startsWith('wikipedia:'));
  if (!wikipediaSource && !wikipediaName && !wikipediaTag) {
    throw new Error('This ZIM does not identify itself as a Wikipedia archive. Apocalypse Mode currently supports Wikipedia ZIM files only.');
  }
  return true;
}

function wikipediaArticleUrl(language, path) {
  const safePath = encodeURI(path).replace(/[?#]/g, character => encodeURIComponent(character));
  return `https://${language}.wikipedia.org/wiki/${safePath}`;
}

export async function openKiwixZim(source, metadata = {}) {
  const blob = await sourceBlob(source);
  if (blob.size < 80) throw new Error('ZIM archive header is truncated.');
  const headerBytes = await blobBytes(blob, 0, 80);
  const header = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  if (header.getUint32(0, true) !== ZIM_MAGIC) throw new Error('Invalid ZIM archive magic.');
  const articleCount = header.getUint32(24, true);
  const clusterCount = header.getUint32(28, true);
  const urlPointerPosition = safeUint64(header, 32);
  const clusterPointerPosition = safeUint64(header, 48);
  const mimeListPosition = safeUint64(header, 56);
  const checksumPosition = safeUint64(header, 72);
  if (!articleCount || !clusterCount || checksumPosition + 16 > blob.size || urlPointerPosition + articleCount * 8 > blob.size || clusterPointerPosition + clusterCount * 8 > blob.size) {
    throw new Error('ZIM archive index is corrupt or incomplete.');
  }

  async function pointerAt(position) {
    const bytes = await blobBytes(blob, position, position + 8);
    return safeUint64(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0);
  }

  const firstClusterPosition = await pointerAt(clusterPointerPosition);
  const mimeBytes = await blobBytes(blob, mimeListPosition, Math.min(firstClusterPosition, mimeListPosition + 64 * 1024));
  const mimeTypes = [];
  for (let offset = 0; offset < mimeBytes.length;) {
    const item = nulString(mimeBytes, offset);
    if (!item.value) break;
    mimeTypes.push(item.value);
    offset = item.next;
  }
  if (!mimeTypes.length) throw new Error('ZIM MIME type list is corrupt or incomplete.');

  async function directoryEntry(index) {
    if (!Number.isInteger(index) || index < 0 || index >= articleCount) throw new Error('ZIM directory index is outside the archive.');
    const position = await pointerAt(urlPointerPosition + index * 8);
    const bytes = await blobBytes(blob, position, Math.min(blob.size, position + MAX_DIRECTORY_ENTRY_BYTES));
    if (bytes.byteLength < 13) throw new Error('ZIM directory entry is truncated.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const mimeType = view.getUint16(0, true);
    const redirect = mimeType === 0xffff;
    const urlOffset = redirect ? 12 : 16;
    if (bytes.byteLength < urlOffset + 2) throw new Error('ZIM directory entry is truncated.');
    const url = nulString(bytes, urlOffset);
    const title = nulString(bytes, url.next);
    return {
      index,
      mimeType,
      namespace: String.fromCharCode(bytes[3]),
      url: url.value,
      title: title.value || url.value.replace(/_/g, ' '),
      redirectIndex: redirect ? view.getUint32(8, true) : null,
      clusterIndex: redirect ? null : view.getUint32(8, true),
      blobIndex: redirect ? null : view.getUint32(12, true),
    };
  }

  async function findPaths(path, limit, namespace = 'C') {
    let low = 0;
    let high = articleCount;
    const target = `${namespace}/${path}`;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const entry = await directoryEntry(middle);
      const key = `${entry.namespace}/${entry.url}`;
      if (key < target) low = middle + 1;
      else high = middle;
    }
    const entries = [];
    for (let index = low; index < articleCount && entries.length < limit; index += 1) {
      const entry = await directoryEntry(index);
      if (entry.namespace !== namespace || !entry.url.startsWith(path)) break;
      if (!entry.url.startsWith('_assets_/')) entries.push(entry);
    }
    return entries;
  }

  async function resolvedEntry(entry) {
    let current = entry;
    for (let depth = 0; current?.redirectIndex != null && depth < 8; depth += 1) {
      current = await directoryEntry(current.redirectIndex);
    }
    if (current?.redirectIndex != null) throw new Error('ZIM redirect chain is too deep.');
    return current;
  }

  async function clusterBlob(clusterIndex, blobIndex) {
    if (!Number.isInteger(clusterIndex) || clusterIndex < 0 || clusterIndex >= clusterCount) throw new Error('ZIM cluster index is outside the archive.');
    const start = await pointerAt(clusterPointerPosition + clusterIndex * 8);
    const end = clusterIndex + 1 < clusterCount
      ? await pointerAt(clusterPointerPosition + (clusterIndex + 1) * 8)
      : checksumPosition;
    if (end <= start) throw new Error('ZIM cluster boundaries are corrupt.');
    const compressed = await blobBytes(blob, start, end);
    const compression = compressed[0] & 0x0f;
    let contents;
    if (compression === 1) contents = compressed.subarray(1);
    else if (compression === 5) contents = decompressZstd(compressed.subarray(1));
    else throw new Error(`Unsupported ZIM cluster compression (${compression}).`);
    const wideOffsets = (compressed[0] & 0x10) !== 0;
    const width = wideOffsets ? 8 : 4;
    if (contents.byteLength < width) throw new Error('ZIM cluster offset table is truncated.');
    const view = new DataView(contents.buffer, contents.byteOffset, contents.byteLength);
    const readOffset = offset => wideOffsets ? safeUint64(view, offset) : view.getUint32(offset, true);
    const firstOffset = readOffset(0);
    const blobCount = firstOffset / width - 1;
    if (!Number.isInteger(blobCount) || blobIndex < 0 || blobIndex >= blobCount) throw new Error('ZIM blob index is outside the cluster.');
    const blobStart = readOffset(blobIndex * width);
    const blobEnd = readOffset((blobIndex + 1) * width);
    if (blobStart < firstOffset || blobEnd < blobStart || blobEnd > contents.byteLength) throw new Error('ZIM blob boundaries are corrupt.');
    return contents.subarray(blobStart, blobEnd);
  }

  let embeddedMetadataPromise;
  async function embeddedMetadata() {
    if (embeddedMetadataPromise) return await embeddedMetadataPromise;
    embeddedMetadataPromise = (async () => {
      const values = {};
      for (const key of ['Language', 'Date', 'License', 'Source', 'Creator', 'Publisher', 'Name', 'Tags', 'Title']) {
        const candidate = (await findPaths(key, 1, 'M'))[0];
        if (!candidate || candidate.url !== key) continue;
        const entry = await resolvedEntry(candidate);
        if (!entry || entry.redirectIndex != null) continue;
        const value = new TextDecoder().decode(await clusterBlob(entry.clusterIndex, entry.blobIndex)).trim();
        if (value) values[key] = value;
      }
      return values;
    })();
    return await embeddedMetadataPromise;
  }

  const embedded = await embeddedMetadata();
  const provenance = mergeZimProvenance(metadata, embedded);

  async function search(query, options = {}) {
    const limit = Math.max(1, Math.min(10, Number(options.limit) || 3));
    const results = [];
    const locatedCandidates = [];
    for (const path of queryPaths(query)) {
      locatedCandidates.push(...await findPaths(path, Math.max(24, limit * 8)));
    }
    const resolvedCandidates = [];
    const normalizedQuery = String(query || '').trim().replace(/\s+/g, '_').toLocaleLowerCase();
    for (const located of locatedCandidates) {
      const entry = await resolvedEntry(located);
      if (!entry) continue;
      const exactRedirectAlias = located.redirectIndex != null
        && String(located.url || '').toLocaleLowerCase() === normalizedQuery
        && redirectAliasMatchesDestination(located, entry);
      resolvedCandidates.push(exactRedirectAlias
        ? { ...entry, searchTitle: located.title, searchUrl: located.url }
        : entry);
    }
    for (const entry of rankZimTitleCandidates(resolvedCandidates, query, limit)) {
      if (!entry || entry.namespace !== 'C' || !String(mimeTypes[entry.mimeType] || '').startsWith('text/html')) continue;
      const bytes = await clusterBlob(entry.clusterIndex, entry.blobIndex);
      const excerpt = relevantPassage(decodeHtmlText(new TextDecoder().decode(bytes)), query);
      if (!excerpt) continue;
      const wikipediaLanguage = ISO_639_3_TO_1[provenance.language] || provenance.language.slice(0, 2);
      results.push({
        title: entry.title,
        excerpt,
        url: wikipediaArticleUrl(wikipediaLanguage, entry.url),
        ...provenance,
      });
    }
    return results;
  }

  return { articleCount, clusterCount, metadata: provenance, embeddedMetadata: embedded, search };
}

const APOCALYPSE_DB_NAME = 'webbrain_apocalypse_mode';
const APOCALYPSE_DB_VERSION = 1;
const CONFIG_STORE = 'config';
const ARCHIVE_STORE = 'archives';
const CONFIG_KEY = 'settings';
const ARCHIVE_DIRECTORY = 'webbrain-apocalypse';

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
    transaction.onabort = () => reject(transaction.error || new Error('Apocalypse Mode storage transaction aborted.'));
  });
}

export function createApocalypseStore(indexedDb = globalThis.indexedDB) {
  let databasePromise;
  const open = () => {
    if (!indexedDb) return Promise.reject(new Error('IndexedDB is unavailable.'));
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDb.open(APOCALYPSE_DB_NAME, APOCALYPSE_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CONFIG_STORE)) database.createObjectStore(CONFIG_STORE, { keyPath: 'key' });
        if (!database.objectStoreNames.contains(ARCHIVE_STORE)) database.createObjectStore(ARCHIVE_STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return databasePromise;
  };
  return {
    async getConfig() {
      const database = await open();
      const value = await idbRequest(database.transaction(CONFIG_STORE, 'readonly').objectStore(CONFIG_STORE).get(CONFIG_KEY));
      return { enabled: false, updatePolicy: 'manual', ...(value?.value || {}) };
    },
    async setConfig(patch) {
      const database = await open();
      const transaction = database.transaction(CONFIG_STORE, 'readwrite');
      const objectStore = transaction.objectStore(CONFIG_STORE);
      const current = await idbRequest(objectStore.get(CONFIG_KEY));
      const value = { enabled: false, updatePolicy: 'manual', ...(current?.value || {}), ...(patch || {}) };
      objectStore.put({ key: CONFIG_KEY, value });
      await idbTransaction(transaction);
      return value;
    },
    async listArchives() {
      const database = await open();
      return await idbRequest(database.transaction(ARCHIVE_STORE, 'readonly').objectStore(ARCHIVE_STORE).getAll());
    },
    async getArchive(id) {
      const database = await open();
      return await idbRequest(database.transaction(ARCHIVE_STORE, 'readonly').objectStore(ARCHIVE_STORE).get(id));
    },
    async putArchive(record) {
      const database = await open();
      const transaction = database.transaction(ARCHIVE_STORE, 'readwrite');
      transaction.objectStore(ARCHIVE_STORE).put(record);
      await idbTransaction(transaction);
      return record;
    },
    async putArchiveIfCurrent(record, expected = {}) {
      const database = await open();
      const transaction = database.transaction(ARCHIVE_STORE, 'readwrite');
      const objectStore = transaction.objectStore(ARCHIVE_STORE);
      const current = await idbRequest(objectStore.get(record.id));
      const matches = Boolean(current)
        && (expected.status == null || current.status === expected.status)
        && (expected.generation == null || (Number(current.generation) || 0) === (Number(expected.generation) || 0))
        && (expected.leaseToken == null || current.leaseToken === expected.leaseToken)
        && (expected.updatedAt == null || Number(current.updatedAt) === Number(expected.updatedAt));
      if (matches) objectStore.put(record);
      await idbTransaction(transaction);
      return matches;
    },
    async deleteArchive(id) {
      const database = await open();
      const transaction = database.transaction(ARCHIVE_STORE, 'readwrite');
      transaction.objectStore(ARCHIVE_STORE).delete(id);
      await idbTransaction(transaction);
    },
    async claimNext(timestamp, leaseToken, leaseDuration = 5 * 60_000) {
      const database = await open();
      const transaction = database.transaction(ARCHIVE_STORE, 'readwrite');
      const objectStore = transaction.objectStore(ARCHIVE_STORE);
      const records = await idbRequest(objectStore.getAll());
      const record = records.find(candidate => downloadable(candidate, timestamp));
      if (!record) {
        await idbTransaction(transaction);
        return null;
      }
      const claimed = { ...record, status: 'downloading', leaseToken, leaseUntil: timestamp + leaseDuration, updatedAt: timestamp };
      objectStore.put(claimed);
      await idbTransaction(transaction);
      return claimed;
    },
  };
}

function safeArchiveKey(value) {
  const key = String(value || '').replace(/[^a-z0-9._-]+/gi, '_').replace(/^\.+/, '').slice(0, 180);
  if (!key) throw new Error('Archive storage key is invalid.');
  return key;
}

async function putArchiveIfCurrent(store, record, expected) {
  if (typeof store.putArchiveIfCurrent === 'function') {
    return await store.putArchiveIfCurrent(record, expected);
  }
  const current = await store.getArchive(record.id);
  const matches = Boolean(current)
    && (expected.status == null || current.status === expected.status)
    && (expected.generation == null || (Number(current.generation) || 0) === (Number(expected.generation) || 0))
    && (expected.leaseToken == null || current.leaseToken === expected.leaseToken)
    && (expected.updatedAt == null || Number(current.updatedAt) === Number(expected.updatedAt));
  if (!matches) return false;
  await store.putArchive(record);
  return true;
}

export function createOpfsArchiveStorage(storageManager = globalThis.navigator?.storage) {
  async function directory(create = true) {
    if (typeof storageManager?.getDirectory !== 'function') throw new Error('Origin Private File System storage is unavailable in this browser.');
    const root = await storageManager.getDirectory();
    return await root.getDirectoryHandle(ARCHIVE_DIRECTORY, { create });
  }
  async function fileHandle(target, create = false, mode = 'read') {
    if (target?.kind === 'file-handle' && target.handle) {
      if (typeof target.handle.queryPermission === 'function') {
        let permission;
        try {
          permission = await target.handle.queryPermission({ mode });
        } catch (error) {
          if (isFilePermissionError(error, target)) throw filePermissionError();
          throw error;
        }
        if (permission !== 'granted') throw filePermissionError();
      }
      return target.handle;
    }
    if (target?.kind !== 'opfs') throw new Error('Unsupported archive storage target.');
    return await (await directory(create)).getFileHandle(safeArchiveKey(target.key), { create });
  }
  return {
    async ensurePermission(target, mode = 'read') {
      await fileHandle(target, false, mode);
      return true;
    },
    async write(target, offset, bytes) {
      const handle = await fileHandle(target, true, 'readwrite');
      const writable = await handle.createWritable({ keepExistingData: true });
      try {
        await writable.seek(offset);
        await writable.write(bytes);
      } finally {
        await writable.close();
      }
    },
    async remove(target) {
      if (target?.kind === 'file-handle') return;
      try {
        const dir = await directory(false);
        await dir.removeEntry(safeArchiveKey(target?.key));
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
      }
    },
    async exists(target) {
      if (target?.kind === 'file-handle') return false;
      try {
        await fileHandle(target, false);
        return true;
      } catch (error) {
        if (error?.name === 'NotFoundError') return false;
        throw error;
      }
    },
    async open(target) {
      return await (await fileHandle(target, false, 'read')).getFile();
    },
    async truncate(target, size) {
      const handle = await fileHandle(target, false, 'readwrite');
      const writable = await handle.createWritable({ keepExistingData: true });
      try {
        await writable.truncate(size);
      } finally {
        await writable.close();
      }
    },
    async estimate() {
      return typeof storageManager?.estimate === 'function' ? await storageManager.estimate() : {};
    },
  };
}

const MAX_RETRY_ATTEMPTS = 6;
const BASE_RETRY_MS = 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;
export const APOCALYPSE_DOWNLOAD_ALARM = 'wb_apocalypse_archive_download';
export const APOCALYPSE_UPDATE_ALARM = 'wb_apocalypse_archive_updates';
const APOCALYPSE_UPDATE_PERIOD_MINUTES = 24 * 60;

async function defaultDigestHex(bytes, algorithm) {
  const normalized = String(algorithm || '').toLowerCase() === 'sha-1' ? 'SHA-1' : 'SHA-256';
  const digest = await globalThis.crypto.subtle.digest(normalized, bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function retryDelay(attempt) {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** Math.max(0, attempt - 1)));
}

function downloadable(record, now) {
  return record.status === 'queued'
    || (record.status === 'downloading' && Number(record.leaseUntil) <= now)
    || (record.status === 'retrying' && Number(record.nextRetryAt) <= now);
}

function nextArchiveScheduleDelay(records, timestamp) {
  const delays = (records || []).map((record) => {
    if (record.status === 'queued') return 0;
    if (record.status === 'retrying') return Math.max(0, (Number(record.nextRetryAt) || 0) - timestamp);
    if (record.status === 'downloading') return Math.max(0, (Number(record.leaseUntil) || 0) - timestamp);
    return Number.POSITIVE_INFINITY;
  });
  const delay = Math.min(...delays);
  return Number.isFinite(delay) ? delay : null;
}

function advanceDownloadMirror(record) {
  const mirrors = Array.isArray(record?.mirrors)
    ? [...new Set(record.mirrors.filter(url => /^https:\/\//.test(String(url || ''))))]
    : [];
  if (!mirrors.length) return {};
  let currentIndex = Number(record.mirrorIndex);
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= mirrors.length
    || mirrors[currentIndex] !== record.downloadUrl) {
    currentIndex = mirrors.indexOf(record.downloadUrl);
  }
  const mirrorIndex = (currentIndex + 1) % mirrors.length;
  return { mirrors, mirrorIndex, downloadUrl: mirrors[mirrorIndex] };
}

function publicArchiveRecord(record) {
  const projected = { ...record };
  for (const field of ['pieceHashes', 'pieceLength', 'pieceHashAlgorithm', 'mirrors', 'mirrorIndex', 'sha256', 'leaseToken', 'leaseUntil']) {
    delete projected[field];
  }
  projected.target = record.target?.kind === 'file-handle'
    ? { kind: 'file-handle', name: record.target.handle?.name || record.filename || '' }
    : record.target;
  return projected;
}

function ownsDownloadClaim(record, generation, leaseToken, config) {
  return Boolean(record)
    && record.generation === generation
    && record.leaseToken === leaseToken
    && record.status === 'downloading'
    && config?.enabled === true;
}

export function createApocalypseArchiveManager(options = {}) {
  const store = options.store;
  const storage = options.storage;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const digestHex = options.digestHex || defaultDigestHex;
  const schedule = options.schedule || (() => {});
  const randomId = options.randomId || (() => globalThis.crypto.randomUUID());
  const now = options.now || (() => Date.now());
  const controllers = new Map();
  let processing = false;
  if (!store || !storage) throw new Error('Apocalypse Mode requires state and archive storage adapters.');

  async function getSnapshot() {
    const [config, archives] = await Promise.all([store.getConfig(), store.listArchives()]);
    return {
      enabled: config?.enabled === true,
      updatePolicy: config?.updatePolicy === 'automatic' ? 'automatic' : 'manual',
      archives,
      installedCount: archives.filter(record => record.status === 'ready').length,
      totalBytes: archives.filter(record => record.status === 'ready').reduce((sum, record) => sum + (Number(record.size) || 0), 0),
    };
  }

  async function setEnabled(enabled) {
    const config = await store.setConfig({ enabled: enabled === true });
    if (!enabled) {
      const archives = await store.listArchives();
      await Promise.all(archives.map(async (record) => {
        controllers.get(record.id)?.abort();
        if (record.status === 'ready') return;
        await putArchiveIfCurrent(store, {
          ...record,
          generation: (Number(record.generation) || 0) + 1,
          status: 'paused',
          updatedAt: now(),
        }, { status: record.status, generation: record.generation, updatedAt: record.updatedAt });
      }));
    } else {
      schedule(0);
    }
    return { ...config, enabled: enabled === true };
  }

  async function install(download, target) {
    const config = await store.getConfig();
    if (config?.enabled !== true) throw new Error('Apocalypse Mode is disabled. Enable it before installing an archive.');
    if (!download?.downloadUrl || !download?.size || !download?.pieceLength || !Array.isArray(download?.pieceHashes)) {
      throw new Error('Archive download metadata is incomplete.');
    }
    const timestamp = now();
    const id = randomId();
    const scopedTarget = target?.kind === 'opfs'
      ? { ...target, key: safeArchiveKey(`${id}-${target.key || download.filename || 'archive.zim'}`) }
      : target;
    const record = {
      ...download,
      archiveKind: download.archiveKind || (/^wikipedia(?:_|$)/i.test(String(download.name || '')) ? 'wikipedia' : ''),
      id,
      target: scopedTarget,
      status: 'queued',
      generation: 1,
      pieceIndex: 0,
      bytesDownloaded: 0,
      retryCount: 0,
      nextRetryAt: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await store.putArchive(record);
    schedule(0);
    return record;
  }

  async function pause(id) {
    const record = await store.getArchive(id);
    if (!record || record.status === 'ready') return record;
    controllers.get(id)?.abort();
    const next = { ...record, generation: (Number(record.generation) || 0) + 1, status: 'paused', updatedAt: now() };
    const saved = await putArchiveIfCurrent(store, next, {
      status: record.status, generation: record.generation, updatedAt: record.updatedAt,
    });
    return saved ? next : await store.getArchive(id);
  }

  async function resume(id) {
    const record = await store.getArchive(id);
    if (!record || record.status === 'ready') return record;
    const next = { ...record, generation: (Number(record.generation) || 0) + 1, status: 'queued', retryCount: 0, nextRetryAt: 0, error: '', errorKind: '', updatedAt: now() };
    const saved = await putArchiveIfCurrent(store, next, {
      status: record.status, generation: record.generation, updatedAt: record.updatedAt,
    });
    if (!saved) return await store.getArchive(id);
    schedule(0);
    return next;
  }

  async function remove(id) {
    const record = await store.getArchive(id);
    if (!record) return false;
    controllers.get(id)?.abort();
    const deleting = {
      ...record,
      generation: (Number(record.generation) || 0) + 1,
      status: 'deleting',
      error: '',
      errorKind: '',
      updatedAt: now(),
    };
    await store.putArchive(deleting);
    try {
      await storage.remove(deleting.target, deleting);
      if (typeof storage.exists === 'function' && await storage.exists(deleting.target, deleting)) {
        throw new Error('archive bytes are still present after deletion');
      }
      const current = await store.getArchive(id);
      if (!current) return true;
      if (current.generation !== deleting.generation || current.status !== 'deleting') {
        throw new Error('archive state changed while deletion was in progress');
      }
      await store.deleteArchive(id);
      if (await store.getArchive(id)) throw new Error('archive metadata is still present after deletion');
      return true;
    } catch (error) {
      const message = `Archive deletion failed: ${error?.message || String(error)}. Retry deletion to remove the retained archive bytes.`;
      const current = await store.getArchive(id);
      if (current && current.generation === deleting.generation) {
        await store.putArchive({ ...current, status: 'error', errorKind: 'delete-failed', error: message, updatedAt: now() });
      }
      throw new Error(message, { cause: error });
    }
  }

  async function processNext() {
    if (processing) return { processed: false, reason: 'busy' };
    processing = true;
    try {
    const config = await store.getConfig();
    if (config?.enabled !== true) return { processed: false, reason: 'disabled' };
    const timestamp = now();
    const leaseToken = randomId();
    const record = typeof store.claimNext === 'function'
      ? await store.claimNext(timestamp, leaseToken)
      : (await store.listArchives()).find(candidate => downloadable(candidate, timestamp));
    if (!record) return { processed: false, reason: 'idle' };
    const generation = Number(record.generation) || 0;
    const controller = new AbortController();
    controllers.set(record.id, controller);
    if (typeof store.claimNext !== 'function') await store.putArchive({ ...record, status: 'downloading', leaseToken, leaseUntil: timestamp + 5 * 60_000, updatedAt: timestamp });
    try {
      if (record.target?.kind === 'file-handle' && typeof storage.ensurePermission === 'function') {
        await storage.ensurePermission(record.target, 'readwrite');
      }
      const offset = Number(record.pieceIndex) * Number(record.pieceLength);
      const expectedLength = Math.min(Number(record.pieceLength), Number(record.size) - offset);
      const response = await fetchImpl(record.downloadUrl, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'follow',
        headers: { Range: `bytes=${offset}-${offset + expectedLength - 1}` },
        signal: controller.signal,
      });
      if (!response?.ok || (response.status !== 206 && !(offset === 0 && expectedLength === Number(record.size)))) {
        throw new Error(`Archive download returned HTTP ${response?.status || 0} without the requested byte range.`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== expectedLength) throw new Error(`Archive piece length mismatch (${bytes.byteLength}/${expectedLength}).`);
      const expectedHash = String(record.pieceHashes[record.pieceIndex] || '').toLowerCase();
      const actualHash = await digestHex(bytes, record.pieceHashAlgorithm);
      if (!expectedHash || actualHash.toLowerCase() !== expectedHash) throw new Error('Archive piece integrity check failed.');
      let current = await store.getArchive(record.id);
      let currentConfig = await store.getConfig();
      if (!ownsDownloadClaim(current, generation, leaseToken, currentConfig)) {
        return { processed: false, reason: 'cancelled' };
      }
      await storage.write(record.target, offset, bytes, record);
      current = await store.getArchive(record.id);
      currentConfig = await store.getConfig();
      if (!ownsDownloadClaim(current, generation, leaseToken, currentConfig)) {
        if (!current) await storage.remove(record.target, record).catch(() => {});
        return { processed: false, reason: 'cancelled' };
      }
      const bytesDownloaded = offset + bytes.byteLength;
      const finished = bytesDownloaded >= Number(record.size);
      if (finished && typeof storage.truncate === 'function') await storage.truncate(record.target, Number(record.size));
      if (finished && typeof storage.open === 'function') {
        await openKiwixZim(await storage.open(record.target), record);
      }
      const next = {
        ...current,
        status: finished ? 'ready' : 'queued',
        leaseToken: '',
        leaseUntil: 0,
        pieceIndex: Number(record.pieceIndex) + 1,
        bytesDownloaded,
        retryCount: 0,
        nextRetryAt: 0,
        error: '',
        errorKind: '',
        completedAt: finished ? now() : null,
        updatedAt: now(),
      };
      const saved = await putArchiveIfCurrent(store, next, {
        status: 'downloading', generation, leaseToken, updatedAt: current.updatedAt,
      });
      if (!saved) return { processed: false, reason: 'cancelled' };
      const nextDelay = nextArchiveScheduleDelay(await store.listArchives(), now());
      if (nextDelay != null) schedule(nextDelay);
      return { processed: true, archive: next };
    } catch (error) {
      const current = await store.getArchive(record.id);
      if (!current || current.generation !== generation || current.leaseToken !== leaseToken || controller.signal.aborted) {
        return { processed: false, reason: 'cancelled' };
      }
      const permissionRequired = isFilePermissionError(error, current.target);
      const retryCount = permissionRequired ? (Number(current.retryCount) || 0) : (Number(current.retryCount) || 0) + 1;
      const delay = retryDelay(retryCount);
      const retrying = !permissionRequired && retryCount < MAX_RETRY_ATTEMPTS;
      const next = {
        ...current,
        ...(permissionRequired ? {} : advanceDownloadMirror(current)),
        status: retrying ? 'retrying' : 'error',
        leaseToken: '',
        leaseUntil: 0,
        retryCount,
        nextRetryAt: retrying ? now() + delay : 0,
        error: error?.message || String(error),
        errorKind: permissionRequired ? APOCALYPSE_FILE_PERMISSION_REQUIRED : '',
        updatedAt: now(),
      };
      const saved = await putArchiveIfCurrent(store, next, {
        status: 'downloading', generation, leaseToken, updatedAt: current.updatedAt,
      });
      if (!saved) return { processed: false, reason: 'cancelled' };
      const nextDelay = nextArchiveScheduleDelay(await store.listArchives(), now());
      if (nextDelay != null) schedule(nextDelay);
      return { processed: false, reason: retrying ? 'retrying' : 'error', archive: next };
    } finally {
      if (controllers.get(record.id) === controller) controllers.delete(record.id);
    }
    } finally {
      processing = false;
    }
  }

  return { getSnapshot, setEnabled, install, pause, resume, retry: resume, remove, processNext };
}

export async function searchApocalypseArchives(query, options = {}) {
  const store = options.store || createApocalypseStore();
  const storage = options.storage || createOpfsArchiveStorage();
  const config = await store.getConfig();
  if (config.enabled !== true) return [];
  const archives = (await store.listArchives())
    .filter(record => record.status === 'ready')
    .sort((left, right) => String(right.archiveDate || '').localeCompare(String(left.archiveDate || '')));
  const providers = options.providers || [createKiwixZimProvider({ storage })];
  const results = [];
  const archiveErrors = [];
  for (const record of archives) {
    try {
      const provider = providers.find(candidate => candidate.supports(record));
      if (!provider) continue;
      results.push(...await provider.search(record, query, { limit: options.limit || 3 }));
      if (results.length >= (options.limit || 3)) break;
    } catch (error) {
      const permissionRequired = isFilePermissionError(error, record.target);
      const message = permissionRequired
        ? 'File access requires confirmation. Open Apocalypse Mode and authorize the selected archive file again.'
        : `Installed archive could not be read: ${error?.message || String(error)} Delete and reinstall or re-import it.`;
      archiveErrors.push(message);
      if (typeof store.putArchive === 'function') {
        await putArchiveIfCurrent(store, {
          ...record,
          status: 'error',
          errorKind: permissionRequired ? APOCALYPSE_FILE_PERMISSION_REQUIRED : 'archive-unreadable',
          error: message,
          updatedAt: Date.now(),
        }, { status: 'ready', generation: record.generation, updatedAt: record.updatedAt });
      }
      if (typeof options.onArchiveError === 'function') await options.onArchiveError(record, error);
    }
  }
  if (!results.length && archiveErrors.length) throw new Error(archiveErrors[0]);
  return results.slice(0, Math.max(1, Math.min(10, Number(options.limit) || 3)));
}

export function createKiwixZimProvider(options = {}) {
  const storage = options.storage || createOpfsArchiveStorage();
  return {
    id: 'kiwix-zim',
    supports(record) {
      return record?.archiveKind === 'wikipedia'
        && (record?.target?.kind === 'opfs' || record?.target?.kind === 'file-handle');
    },
    async search(record, query, searchOptions = {}) {
      const archive = await openKiwixZim(await storage.open(record.target), record);
      return await archive.search(query, searchOptions);
    },
  };
}

function importedArchiveRecord(metadata, file, inspected, id, target, status) {
  const timestamp = Date.now();
  const filename = safeArchiveKey(metadata.filename || file.name || `${id}.zim`);
  const provenance = inspected.metadata || mergeZimProvenance(metadata);
  return {
    id,
    title: metadata.title || (file.name || filename).replace(/\.zim$/i, ''),
    filename,
    language: provenance.language,
    archiveDate: provenance.archiveDate,
    tier: metadata.tier || 'imported',
    archiveKind: 'wikipedia',
    source: provenance.source,
    license: provenance.license,
    licenseDeclared: provenance.licenseDeclared,
    articleCount: inspected.articleCount,
    size: file.size,
    bytesDownloaded: status === 'ready' ? file.size : 0,
    generation: 1,
    status,
    target,
    createdAt: timestamp,
    completedAt: status === 'ready' ? timestamp : undefined,
    updatedAt: timestamp,
  };
}

export async function importKiwixArchive(source, metadata = {}, options = {}) {
  const store = options.store || createApocalypseStore();
  const storage = options.storage || createOpfsArchiveStorage();
  const config = await store.getConfig();
  if (config.enabled !== true) throw new Error('Apocalypse Mode is disabled. Enable it before importing an archive.');
  const blob = await sourceBlob(source);
  const inspected = await openKiwixZim(blob, metadata);
  assertWikipediaZimArchive(inspected.embeddedMetadata);
  const capacity = normalizeStorageEstimate(typeof storage.estimate === 'function' ? await storage.estimate() : {});
  if (capacity.known && blob.size > capacity.free) {
    throw new Error('Insufficient browser-managed storage space for this ZIM archive.');
  }
  const id = options.id || globalThis.crypto.randomUUID();
  const filename = safeArchiveKey(metadata.filename || blob.name || `${id}.zim`);
  const target = { kind: 'opfs', key: `${id}-${filename}` };
  let record = importedArchiveRecord(metadata, blob, inspected, id, target, 'importing');
  await store.putArchive(record);
  const chunkSize = Math.max(1024 * 1024, Number(options.chunkSize) || 4 * 1024 * 1024);
  try {
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      if (options.signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
      const current = await store.getArchive(id);
      if (!current || current.generation !== record.generation) throw new DOMException('Import cancelled.', 'AbortError');
      const bytes = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + chunkSize)).arrayBuffer());
      await storage.write(target, offset, bytes, record);
      const afterWrite = await store.getArchive(id);
      if (!afterWrite || afterWrite.generation !== record.generation || options.signal?.aborted) {
        throw new DOMException('Import cancelled.', 'AbortError');
      }
      const next = { ...afterWrite, bytesDownloaded: offset + bytes.byteLength, updatedAt: Date.now() };
      const saved = await putArchiveIfCurrent(store, next, {
        status: 'importing', generation: record.generation, updatedAt: afterWrite.updatedAt,
      });
      if (!saved) throw new DOMException('Import cancelled.', 'AbortError');
      record = next;
      if (typeof options.onProgress === 'function') options.onProgress(record);
    }
    if (options.signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    const ready = { ...record, status: 'ready', completedAt: Date.now(), updatedAt: Date.now() };
    const saved = await putArchiveIfCurrent(store, ready, {
      status: 'importing', generation: record.generation, updatedAt: record.updatedAt,
    });
    if (!saved) throw new DOMException('Import cancelled.', 'AbortError');
    record = ready;
    return record;
  } catch (error) {
    let cleanupError = null;
    try {
      await storage.remove(target);
      if (typeof storage.exists === 'function' && await storage.exists(target)) throw new Error('partial archive bytes are still present');
    } catch (caught) {
      cleanupError = caught;
    }
    const current = await store.getArchive(id);
    if (cleanupError && current) {
      const message = `Import failed and partial archive cleanup failed: ${cleanupError?.message || String(cleanupError)}. Retry deletion to remove the retained bytes.`;
      await store.putArchive({ ...current, status: 'error', errorKind: 'delete-failed', error: message, updatedAt: Date.now() });
      throw new Error(message, { cause: error });
    }
    if (!current || error?.name === 'AbortError') {
      await store.deleteArchive(id);
      throw error;
    }
    record = { ...current, status: 'error', bytesDownloaded: 0, error: error?.message || String(error), updatedAt: Date.now() };
    await store.putArchive(record);
    throw error;
  }
}

export async function registerKiwixArchiveHandle(handle, metadata = {}, options = {}) {
  if (typeof handle?.getFile !== 'function') throw new Error('A persistent ZIM file handle is required.');
  const store = options.store || createApocalypseStore();
  const config = await store.getConfig();
  if (config.enabled !== true) throw new Error('Apocalypse Mode is disabled. Enable it before importing an archive.');
  const file = await handle.getFile();
  const inspected = await openKiwixZim(file, metadata);
  assertWikipediaZimArchive(inspected.embeddedMetadata);
  const id = options.id || globalThis.crypto.randomUUID();
  const record = importedArchiveRecord(metadata, file, inspected, id, { kind: 'file-handle', handle, access: 'read' }, 'ready');
  await store.putArchive(record);
  return record;
}

export function createApocalypseController(api, options = {}) {
  const store = options.store || createApocalypseStore();
  const storage = options.storage || createOpfsArchiveStorage();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const schedule = options.schedule || ((delayMs) => api?.alarms?.create?.(APOCALYPSE_DOWNLOAD_ALARM, {
    delayInMinutes: Math.max(0.05, Number(delayMs) / 60_000),
  }));
  const manager = createApocalypseArchiveManager({ store, storage, fetchImpl, schedule });
  const importStaleMs = Math.max(30_000, Number(options.importStaleMs) || 60_000);
  const recoveryIntervalMs = Math.max(5_000, Number(options.recoveryIntervalMs) || Math.min(importStaleMs, 60_000));
  const now = options.now || (() => Date.now());
  let lastRecoveryAt = Number.NEGATIVE_INFINITY;
  let recoveryInFlight = null;
  const scheduleUpdateChecks = options.scheduleUpdateChecks || (() => api?.alarms?.create?.(APOCALYPSE_UPDATE_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: APOCALYPSE_UPDATE_PERIOD_MINUTES,
  }));
  const getUpdateCheckAlarm = options.getUpdateCheckAlarm || (() => api?.alarms?.get?.(APOCALYPSE_UPDATE_ALARM));
  const clearUpdateChecks = options.clearUpdateChecks || (() => api?.alarms?.clear?.(APOCALYPSE_UPDATE_ALARM));

  async function recoverInterruptedImports() {
    const records = await store.listArchives();
    const stale = records.filter(record => record.status === 'importing' && Number(record.updatedAt) <= now() - importStaleMs);
    const recovered = await Promise.all(stale.map(async (record) => {
      const generation = Number(record.generation) || 0;
      return await putArchiveIfCurrent(store, {
        ...record,
        generation: generation + 1,
        status: 'error',
        errorKind: 'import-interrupted',
        error: 'Import was interrupted. Partial archive bytes were retained to avoid racing a live import. Delete this entry, then choose the source .zim file again.',
        updatedAt: now(),
      }, { status: 'importing', generation, updatedAt: record.updatedAt });
    }));
    return recovered.filter(Boolean).length;
  }

  async function maybeRecoverInterruptedImports() {
    const timestamp = now();
    if (recoveryInFlight) return await recoveryInFlight;
    if (timestamp - lastRecoveryAt < recoveryIntervalMs) return 0;
    lastRecoveryAt = timestamp;
    recoveryInFlight = recoverInterruptedImports().finally(() => { recoveryInFlight = null; });
    return await recoveryInFlight;
  }

  async function snapshot() {
    await maybeRecoverInterruptedImports();
    const [state, estimate] = await Promise.all([manager.getSnapshot(), storage.estimate().catch(() => ({}))]);
    const archives = state.archives.map(publicArchiveRecord);
    const capacity = normalizeStorageEstimate(estimate);
    return { ...state, archives, storage: { usage: capacity.usage, quota: capacity.quota } };
  }

  async function catalog(language) {
    const config = await store.getConfig();
    if (config.enabled !== true) throw new Error('Apocalypse Mode is disabled. Enable it before loading the Kiwix catalog.');
    const response = await fetchImpl(kiwixCatalogUrl(language), { credentials: 'omit', redirect: 'follow' });
    if (!response.ok) throw new Error(`Kiwix catalog returned HTTP ${response.status}.`);
    return parseKiwixCatalog(await response.text());
  }

  async function resolve(item) {
    const config = await store.getConfig();
    if (config.enabled !== true) throw new Error('Apocalypse Mode is disabled. Enable it before resolving an archive download.');
    if (!/^https:\/\//.test(String(item?.metaUrl || ''))) throw new Error('Kiwix archive metadata URL is invalid.');
    if (!/^wikipedia(?:_|$)/i.test(String(item?.name || ''))) throw new Error('Apocalypse Mode currently supports Wikipedia catalog archives only.');
    const response = await fetchImpl(item.metaUrl, { credentials: 'omit', redirect: 'follow' });
    if (!response.ok) throw new Error(`Kiwix Metalink returned HTTP ${response.status}.`);
    return resolveKiwixDownload(item, await response.text());
  }

  async function syncUpdateSchedule() {
    const config = await store.getConfig();
    if (config.enabled === true && config.updatePolicy === 'automatic') {
      let existing = null;
      try { existing = await getUpdateCheckAlarm(); } catch {}
      if (!existing) await scheduleUpdateChecks();
    } else await clearUpdateChecks();
    return config;
  }

  async function syncDownloadSchedule() {
    const config = await store.getConfig();
    if (config.enabled !== true) return null;
    const timestamp = now();
    const delay = nextArchiveScheduleDelay(await store.listArchives(), timestamp);
    if (delay == null) return null;
    await schedule(delay);
    return delay;
  }

  async function setUpdatePolicy(policy) {
    const updatePolicy = policy === 'automatic' ? 'automatic' : 'manual';
    await store.setConfig({ updatePolicy });
    await syncUpdateSchedule();
    return await snapshot();
  }

  async function reauthorizeFile(id) {
    const record = await store.getArchive(id);
    if (!record || record.target?.kind !== 'file-handle' || !record.target.handle) {
      throw new Error('The selected archive file is unavailable.');
    }
    const incompleteDownload = Boolean(record.downloadUrl) && Number(record.bytesDownloaded) < Number(record.size);
    const mode = incompleteDownload ? 'readwrite' : 'read';
    if (typeof record.target.handle.queryPermission === 'function') {
      const permission = await record.target.handle.queryPermission({ mode });
      if (permission !== 'granted') throw filePermissionError();
    }
    if (incompleteDownload) return await manager.resume(id);
    const next = {
      ...record,
      generation: (Number(record.generation) || 0) + 1,
      status: 'ready',
      error: '',
      errorKind: '',
      updatedAt: now(),
    };
    const saved = await putArchiveIfCurrent(store, next, {
      status: record.status, generation: record.generation, updatedAt: record.updatedAt,
    });
    return saved ? next : await store.getArchive(id);
  }

  async function checkForUpdates(options = {}) {
    const config = await store.getConfig();
    if (config.enabled !== true || (config.updatePolicy !== 'automatic' && options.force !== true)) {
      return await snapshot();
    }
    const checkedAt = now();
    const records = await store.listArchives();
    const candidates = records.filter(record => record.status === 'ready' && record.name && record.flavour);
    const catalogs = new Map();
    for (const record of candidates) {
      const language = String(record.language || 'eng');
      if (!catalogs.has(language)) catalogs.set(language, await catalog(language));
      const updateAvailable = selectKiwixUpdate(record, catalogs.get(language));
      await putArchiveIfCurrent(store, {
        ...record,
        updateAvailable,
        lastUpdateCheckAt: checkedAt,
        updatedAt: checkedAt,
      }, {
        status: 'ready',
        generation: record.generation,
        updatedAt: record.updatedAt,
      });
    }
    await store.setConfig({ lastUpdateCheckAt: checkedAt });
    return await snapshot();
  }

  async function handle(action, payload = {}) {
    switch (action) {
      case 'status': return await snapshot();
      case 'enable': await manager.setEnabled(payload.enabled); await syncUpdateSchedule(); return await snapshot();
      case 'set_update_policy': return await setUpdatePolicy(payload.policy);
      case 'check_updates': return await checkForUpdates({ force: payload.force === true });
      case 'reauthorize_file': await reauthorizeFile(payload.id); return await snapshot();
      case 'catalog': return { items: await catalog(payload.language) };
      case 'resolve': return { download: await resolve(payload.item) };
      case 'install': {
        const estimate = await storage.estimate().catch(() => ({}));
        const capacity = normalizeStorageEstimate(estimate);
        if (capacity.known && Number(payload.download?.size) > capacity.free) {
          throw new Error(`Not enough extension storage (${capacity.free} bytes available).`);
        }
        if (!/^wikipedia(?:_|$)/i.test(String(payload.download?.name || ''))) {
          throw new Error('Apocalypse Mode currently supports Wikipedia catalog archives only.');
        }
        const key = `${payload.download?.id || 'wikipedia'}-${payload.download?.filename || 'archive.zim'}`;
        await manager.install({ ...payload.download, archiveKind: 'wikipedia' }, { kind: 'opfs', key: safeArchiveKey(key) });
        return await snapshot();
      }
      case 'pause': await manager.pause(payload.id); return await snapshot();
      case 'resume': await manager.resume(payload.id); return await snapshot();
      case 'retry': await manager.retry(payload.id); return await snapshot();
      case 'delete': await manager.remove(payload.id); return await snapshot();
      case 'process': return await manager.processNext();
      default: throw new Error(`Unknown Apocalypse Mode action: ${action}`);
    }
  }

  return { manager, store, storage, snapshot, catalog, resolve, recoverInterruptedImports, syncUpdateSchedule, syncDownloadSchedule, setUpdatePolicy, checkForUpdates, reauthorizeFile, handle };
}
