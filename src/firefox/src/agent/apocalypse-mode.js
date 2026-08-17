import { decompress as decompressZstd } from '../../vendor/fzstd.js';

const KIWIX_CATALOG_URL = 'https://opds.library.kiwix.org/catalog/v2/entries';
const KIWIX_LIBRARY_URL = 'https://download.kiwix.org/library/library_zim.xml';
const UNDECLARED_LICENSE_NOTICE = 'Not declared by the current catalog/archive metadata. Wikipedia text is generally CC BY-SA 4.0 unless otherwise noted; archive components may use additional licenses.';
const SHARED_KIWIX_ARCHIVE_CACHE = new Map();
const MAX_CACHED_KIWIX_ARCHIVES = 3;
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

export function isSimpleEnglishWikipediaArchive(item = {}) {
  const name = String(item.name || '').toLowerCase();
  return name === 'wikipedia_en-simple_all' || name === 'wikipedia_en_simple_all';
}

export function isBasicWikipediaArchive(item = {}) {
  return String(item.language || '').toLowerCase() === 'eng'
    && isSimpleEnglishWikipediaArchive(item)
    && String(item.flavour || '').toLowerCase() === 'nopic';
}

export function selectBasicWikipediaArchive(items = []) {
  return items
    .filter(isBasicWikipediaArchive)
    .sort((left, right) => String(right.archiveDate || '').localeCompare(String(left.archiveDate || '')))[0] || null;
}

export function selectWikipediaArchiveVariant(items = [], options = {}) {
  const includeImages = options.includeImages === true;
  const language = String(options.language || '').toLowerCase();
  return items
    .filter(item => {
      const name = String(item?.name || '').toLowerCase();
      if (!/(?:^|_)all(?:_|$)/.test(name) || isSimpleEnglishWikipediaArchive(item)) return false;
      if (language && String(item?.language || '').toLowerCase() !== language) return false;
      if (!includeImages) return String(item?.flavour || '').toLowerCase() === 'nopic';
      return wikipediaArchiveIncludesImages(item);
    })
    .sort((left, right) => String(right.archiveDate || '').localeCompare(String(left.archiveDate || ''))
      || Number(right.articleCount || 0) - Number(left.articleCount || 0))[0] || null;
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

export function parseKiwixLibrary(xml, language = 'eng') {
  const selectedLanguage = String(language || 'eng').toLowerCase();
  const books = String(xml || '').match(/<book\b[^>]*\/?>/gi) || [];
  return books.map((book) => {
    const name = attrText(book, 'name');
    const languages = attrText(book, 'language').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
    if (!/^wikipedia(?:_|$)/i.test(name) || !languages.includes(selectedLanguage)) return null;
    const flavour = attrText(book, 'flavour');
    const creator = attrText(book, 'creator');
    const publisher = attrText(book, 'publisher');
    const declaredLicense = attrText(book, 'license');
    const catalogSizeKiB = positiveInteger(attrText(book, 'size'));
    return {
      id: attrText(book, 'id'),
      title: attrText(book, 'title') || name,
      summary: attrText(book, 'description'),
      language: selectedLanguage,
      name,
      flavour,
      tier: classifyArchiveTier(name, flavour),
      tags: attrText(book, 'tags').split(';').filter(Boolean),
      articleCount: positiveInteger(attrText(book, 'articleCount')),
      archiveDate: attrText(book, 'date'),
      metaUrl: attrText(book, 'url'),
      catalogSize: catalogSizeKiB * 1024,
      source: [creator, publisher].filter(Boolean).join(' / ') || 'Kiwix / openZIM',
      license: declaredLicense || UNDECLARED_LICENSE_NOTICE,
      licenseDeclared: Boolean(declaredLicense),
    };
  }).filter(item => item?.id && item.metaUrl);
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
  url.searchParams.set('category', 'wikipedia');
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
const INITIAL_DIRECTORY_ENTRY_BYTES = 4 * 1024;
const MAX_DIRECTORY_ENTRY_CACHE = 4096;
const SUPPORTED_WIKIPEDIA_IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
]);
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

function decodeHtmlArticleText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tr|ul)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code[0].toLowerCase() === 'x' ? code.slice(1) : code, code[0].toLowerCase() === 'x' ? 16 : 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function relevantPassage(text, query, maxChars = 2400) {
  if (text.length <= maxChars) return text;
  const lower = text.toLowerCase();
  const offsets = String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
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
  const pathTokens = normalized.split('_').filter(Boolean);
  const titleCasedTokens = pathTokens.map(token => token[0].toUpperCase() + token.slice(1));
  const titleCased = titleCasedTokens.join('_');
  const variantsByToken = pathTokens.map((token, tokenIndex) => {
    const variants = [titleCasedTokens[tokenIndex], token.toUpperCase()];
    const internalCount = Math.min(12, Math.max(0, token.length - 1));
    const maskLimit = 2 ** internalCount;
    for (let capitalCount = 1; capitalCount <= internalCount && variants.length < 64; capitalCount += 1) {
      for (let mask = 1; mask < maskLimit && variants.length < 64; mask += 1) {
        let bits = mask;
        let setBits = 0;
        while (bits) { setBits += bits & 1; bits >>>= 1; }
        if (setBits !== capitalCount) continue;
        for (const base of [titleCasedTokens[tokenIndex], token]) {
          if (variants.length >= 64) break;
          const characters = [...base];
          for (let bit = 0; bit < internalCount; bit += 1) {
            if (mask & (1 << bit)) characters[bit + 1] = characters[bit + 1].toUpperCase();
          }
          variants.push(characters.join(''));
        }
      }
    }
    return Array.from(new Set(variants));
  });
  const mixedCase = [];
  function combineTokenVariants(tokenIndex, parts) {
    if (mixedCase.length >= 128) return;
    if (tokenIndex >= variantsByToken.length) {
      mixedCase.push(parts.join('_'));
      return;
    }
    for (const variant of variantsByToken[tokenIndex]) {
      combineTokenVariants(tokenIndex + 1, [...parts, variant]);
      if (mixedCase.length >= 128) break;
    }
  }
  combineTokenVariants(0, []);
  const tokens = normalized.split('_').filter(token => token.length >= 3);
  return Array.from(new Set([
    normalized, capitalized, titleCased, normalized.toUpperCase(), ...mixedCase,
    ...tokens, ...tokens.map(token => token[0].toUpperCase() + token.slice(1)), ...tokens.map(token => token.toUpperCase()),
  ]));
}

function normalizedTitleTerms(value) {
  return String(value || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 2);
}

export function rankZimTitleCandidates(candidates, query, limit = 3) {
  const normalizedQuery = String(query || '').trim().replace(/\s+/g, '_').toLowerCase();
  const queryTerms = normalizedTitleTerms(query);
  const minimumMatches = queryTerms.length > 1 ? 2 : 1;
  const unique = new Map();
  for (const candidate of candidates || []) {
    if (!candidate || unique.has(candidate.index)) continue;
    const normalizedTitle = String(candidate.searchTitle || candidate.searchUrl || candidate.title || candidate.url || '').replace(/\s+/g, '_').toLowerCase();
    const titleTerms = new Set(normalizedTitleTerms(normalizedTitle));
    const matches = queryTerms.filter(term => titleTerms.has(term)).length;
    const fullPrefix = normalizedTitle.startsWith(normalizedQuery);
    if (!fullPrefix && matches < minimumMatches) continue;
    const exact = normalizedTitle === normalizedQuery;
    unique.set(candidate.index, {
      candidate,
      score: (exact ? 1000 : 0) + (fullPrefix ? 400 : 0) + matches * 100
        - Math.abs(titleTerms.size - queryTerms.length) - (candidate.searchRedirectAlias ? 1100 : 0),
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

export function wikipediaArchiveIncludesImages(metadata = {}, embedded = {}) {
  const flavour = String(metadata.flavour || '').toLowerCase();
  const tags = [
    ...(Array.isArray(metadata.tags) ? metadata.tags : String(metadata.tags || '').split(/[;,]/)),
    ...String(embedded.Tags || '').split(/[;,]/),
  ].map(tag => String(tag || '').trim().toLowerCase()).filter(Boolean);
  if (flavour === 'nopic' || tags.includes('_pictures:no')) return false;
  return flavour === 'maxi' || tags.includes('_pictures:yes');
}

export function wikipediaArchiveMatchesSelection(item = {}, options = {}) {
  const language = String(options.language || '').toLowerCase();
  if (!language || String(item.language || '').toLowerCase() !== language) return false;
  if (isSimpleEnglishWikipediaArchive(item)) return false;
  const name = String(item.name || '').toLowerCase();
  if (name && !/(?:^|_)all(?:_|$)/.test(name)) return false;
  return wikipediaArchiveIncludesImages(item) === (options.includeImages === true);
}

export function isSupportedWikipediaImageMimeType(value) {
  return SUPPORTED_WIKIPEDIA_IMAGE_MIME_TYPES.has(String(value || '').split(';', 1)[0].trim().toLowerCase());
}

export function assertWikipediaZimArchive(embedded = {}) {
  const source = String(embedded.Source || '').toLowerCase();
  const name = String(embedded.Name || '').toLowerCase();
  const tags = String(embedded.Tags || '').toLowerCase().split(/[;,]/).map(tag => tag.trim());
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

  const directoryEntryCache = new Map();
  async function loadDirectoryEntry(index) {
    if (!Number.isInteger(index) || index < 0 || index >= articleCount) throw new Error('ZIM directory index is outside the archive.');
    const position = await pointerAt(urlPointerPosition + index * 8);
    let byteLength = Math.min(INITIAL_DIRECTORY_ENTRY_BYTES, blob.size - position);
    let bytes;
    while (true) {
      bytes = await blobBytes(blob, position, position + byteLength);
      if (bytes.byteLength < 13) throw new Error('ZIM directory entry is truncated.');
      const mimeType = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true);
      const urlOffset = mimeType === 0xffff ? 12 : 16;
      const urlEnd = bytes.indexOf(0, urlOffset);
      const titleEnd = urlEnd < 0 ? -1 : bytes.indexOf(0, urlEnd + 1);
      if (titleEnd >= 0) break;
      if (byteLength >= Math.min(MAX_DIRECTORY_ENTRY_BYTES, blob.size - position)) {
        throw new Error('ZIM directory entry contains an unterminated string.');
      }
      byteLength = Math.min(byteLength * 2, MAX_DIRECTORY_ENTRY_BYTES, blob.size - position);
    }
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

  async function directoryEntry(index) {
    if (directoryEntryCache.has(index)) return await directoryEntryCache.get(index);
    const pending = loadDirectoryEntry(index);
    directoryEntryCache.set(index, pending);
    if (directoryEntryCache.size > MAX_DIRECTORY_ENTRY_CACHE) {
      directoryEntryCache.delete(directoryEntryCache.keys().next().value);
    }
    try {
      return await pending;
    } catch (error) {
      if (directoryEntryCache.get(index) === pending) directoryEntryCache.delete(index);
      throw error;
    }
  }

  async function findPaths(path, limit, namespace = 'C', options = {}) {
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
      if (options.includeAssets === true || !entry.url.startsWith('_assets_/')) entries.push(entry);
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
  const imagesIncluded = wikipediaArchiveIncludesImages(metadata, embedded);

  async function search(query, options = {}) {
    const limit = Math.max(1, Math.min(10, Number(options.limit) || 3));
    const results = [];
    const locatedCandidates = [];
    const normalizedQuery = String(query || '').trim().replace(/\s+/g, '_').toLowerCase();
    for (const path of queryPaths(query)) {
      const located = await findPaths(path, Math.max(24, limit * 8));
      locatedCandidates.push(...located);
      if (located.some(entry => String(entry.url || '').toLowerCase() === normalizedQuery)) break;
    }
    const resolvedCandidates = [];
    for (const located of locatedCandidates) {
      const entry = await resolvedEntry(located);
      if (!entry) continue;
      const exactRedirectAlias = located.redirectIndex != null
        && String(located.url || '').toLowerCase() === normalizedQuery;
      resolvedCandidates.push(exactRedirectAlias
        ? { ...entry, searchTitle: located.title, searchUrl: located.url, searchRedirectAlias: true }
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
        path: entry.url,
        url: wikipediaArticleUrl(wikipediaLanguage, entry.url),
        ...provenance,
      });
    }
    return results;
  }

  async function readArticle(path, options = {}) {
    const normalizedPath = String(path || '').trim().replace(/^\/+/, '').replace(/\s+/g, '_');
    if (!normalizedPath) throw new Error('Choose a Wikipedia article to read.');
    const located = (await findPaths(normalizedPath, 1))[0];
    if (!located || located.url !== normalizedPath) throw new Error('The selected article is not present in this archive.');
    const entry = await resolvedEntry(located);
    if (!entry || entry.namespace !== 'C' || !String(mimeTypes[entry.mimeType] || '').startsWith('text/html')) {
      throw new Error('The selected archive entry is not a readable text article.');
    }
    const maxChars = Math.max(2_000, Math.min(500_000, Number(options.maxChars) || 250_000));
    const maxHtmlChars = Math.max(8_000, Math.min(2_000_000, Number(options.maxHtmlChars) || 1_000_000));
    const unsafeHtml = new TextDecoder().decode(await clusterBlob(entry.clusterIndex, entry.blobIndex));
    const text = decodeHtmlArticleText(unsafeHtml);
    const wikipediaLanguage = ISO_639_3_TO_1[provenance.language] || provenance.language.slice(0, 2);
    return {
      title: located.title || entry.title,
      path: located.url,
      text: text.slice(0, maxChars),
      // This remains untrusted archive content. The reader reconstructs a
      // strict semantic DOM and never inserts this string into the live page.
      unsafeHtml: unsafeHtml.slice(0, maxHtmlChars),
      imagesIncluded,
      truncated: text.length > maxChars || unsafeHtml.length > maxHtmlChars,
      url: wikipediaArticleUrl(wikipediaLanguage, located.url),
      ...provenance,
    };
  }

  async function readImage(path, options = {}) {
    const normalizedPath = String(path || '').trim().replace(/^\/+/, '');
    if (!normalizedPath || normalizedPath.length > 2_048 || /[\u0000-\u001f\u007f]/.test(normalizedPath)) {
      throw new Error('Choose an image from this Wikipedia archive.');
    }
    const located = (await findPaths(normalizedPath, 1, 'C', { includeAssets: true }))[0];
    if (!located || located.url !== normalizedPath) throw new Error('This image is not present in the archive.');
    const entry = await resolvedEntry(located);
    const mimeType = String(mimeTypes[entry?.mimeType] || '').split(';', 1)[0].trim().toLowerCase();
    if (!entry || entry.namespace !== 'C' || !isSupportedWikipediaImageMimeType(mimeType)) {
      throw new Error('This archive entry is not a supported image.');
    }
    const bytes = await clusterBlob(entry.clusterIndex, entry.blobIndex);
    const maxBytes = Math.max(1, Math.min(32 * 1024 * 1024, Number(options.maxBytes) || 12 * 1024 * 1024));
    if (bytes.byteLength > maxBytes) throw new Error('This archive image is too large to display safely.');
    return { path: located.url, mimeType, byteLength: bytes.byteLength, bytes: bytes.slice() };
  }

  return { articleCount, clusterCount, metadata: provenance, embeddedMetadata: embedded, imagesIncluded, search, readArticle, readImage };
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
    // The extension manifest declares unlimitedStorage, so estimate() is
    // informational rather than a hard OPFS quota.
    quotaLimited: false,
    async ensurePermission(target, mode = 'read') {
      await fileHandle(target, false, mode);
      return true;
    },
    async createWriter(target) {
      const handle = await fileHandle(target, true, 'readwrite');
      const writable = await handle.createWritable({ keepExistingData: true });
      let settled = false;
      return {
        async write(offset, bytes) {
          if (settled) throw new Error('Archive writer is already closed.');
          await writable.seek(offset);
          await writable.write(bytes);
        },
        async truncate(size) {
          if (settled) throw new Error('Archive writer is already closed.');
          await writable.truncate(size);
        },
        async close() {
          if (settled) return;
          await writable.close();
          settled = true;
        },
        async abort(reason) {
          if (settled) return;
          await writable.abort(reason);
          settled = true;
        },
      };
    },
    async write(target, offset, bytes) {
      const writer = await this.createWriter(target);
      try {
        await writer.write(offset, bytes);
        await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => {});
        throw error;
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
      const writer = await this.createWriter(target);
      try {
        await writer.truncate(size);
        await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => {});
        throw error;
      }
    },
    async estimate() {
      return typeof storageManager?.estimate === 'function' ? await storageManager.estimate() : {};
    },
  };
}

const MAX_RETRY_ATTEMPTS = 6;
const DEFAULT_MAX_PIECES_PER_WAKE = 8;
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
  const onArchiveReady = typeof options.onArchiveReady === 'function' ? options.onArchiveReady : async () => ({});
  const configuredMaxPieces = Number(options.maxPiecesPerWake);
  const maxPiecesPerWake = Number.isFinite(configuredMaxPieces)
    ? Math.max(1, Math.floor(configuredMaxPieces))
    : DEFAULT_MAX_PIECES_PER_WAKE;
  const controllers = new Map();
  let processing = false;
  if (!store || !storage) throw new Error('Apocalypse Mode requires state and archive storage adapters.');

  async function cancelledResult() {
    try {
      const config = await store.getConfig();
      if (config?.enabled === true) {
        const nextDelay = nextArchiveScheduleDelay(await store.listArchives(), now());
        if (nextDelay != null) schedule(nextDelay);
      }
    } catch {
      // Preserve the cancellation result if rearming the shared alarm fails.
    }
    return { processed: false, reason: 'cancelled' };
  }

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
        if (record.status === 'ready' || record.status === 'deleting') return;
        controllers.get(record.id)?.abort();
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
    if (!record || record.status === 'ready' || record.status === 'deleting') return record;
    controllers.get(id)?.abort();
    const next = { ...record, generation: (Number(record.generation) || 0) + 1, status: 'paused', updatedAt: now() };
    const saved = await putArchiveIfCurrent(store, next, {
      status: record.status, generation: record.generation, updatedAt: record.updatedAt,
    });
    return saved ? next : await store.getArchive(id);
  }

  async function resume(id) {
    const record = await store.getArchive(id);
    if (!record || record.status === 'ready' || record.status === 'deleting') return record;
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
    let record = typeof store.claimNext === 'function'
      ? await store.claimNext(timestamp, leaseToken)
      : (await store.listArchives()).find(candidate => downloadable(candidate, timestamp));
    if (!record) return { processed: false, reason: 'idle' };
    const generation = Number(record.generation) || 0;
    const controller = new AbortController();
    controllers.set(record.id, controller);
    if (typeof store.claimNext !== 'function') {
      record = { ...record, status: 'downloading', leaseToken, leaseUntil: timestamp + 5 * 60_000, updatedAt: timestamp };
      await store.putArchive(record);
    }
    if (record.writeSessionStartPiece != null) {
      const recovered = {
        ...record,
        pieceIndex: Math.max(0, Number(record.writeSessionStartPiece) || 0),
        bytesDownloaded: Math.max(0, Number(record.writeSessionStartBytes) || 0),
        writeSessionStartPiece: null,
        writeSessionStartBytes: null,
        updatedAt: now(),
      };
      const saved = await putArchiveIfCurrent(store, recovered, {
        status: 'downloading', generation, leaseToken, updatedAt: record.updatedAt,
      });
      if (!saved) return await cancelledResult();
      record = recovered;
    }
    let writer = null;
    let usedWriteSession = false;
    let writeSessionCommitted = false;
    async function abortWriteSession(reason) {
      if (!writer) return;
      const activeWriter = writer;
      writer = null;
      if (typeof activeWriter.abort === 'function') await activeWriter.abort(reason);
    }
    async function closeWriteSession() {
      if (!writer) return;
      const activeWriter = writer;
      writer = null;
      await activeWriter.close();
      writeSessionCommitted = true;
    }
    try {
      if (record.target?.kind === 'file-handle' && typeof storage.ensurePermission === 'function') {
        await storage.ensurePermission(record.target, 'readwrite');
      }
      if (typeof storage.createWriter === 'function') {
        const marked = {
          ...record,
          writeSessionStartPiece: Number(record.pieceIndex) || 0,
          writeSessionStartBytes: Number(record.bytesDownloaded) || 0,
          updatedAt: now(),
        };
        const saved = await putArchiveIfCurrent(store, marked, {
          status: 'downloading', generation, leaseToken, updatedAt: record.updatedAt,
        });
        if (!saved) return await cancelledResult();
        record = marked;
        writer = await storage.createWriter(record.target, record);
        usedWriteSession = true;
      }
      let piecesProcessed = 0;
      while (true) {
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
        return await cancelledResult();
      }
      if (writer) await writer.write(offset, bytes);
      else await storage.write(record.target, offset, bytes, record);
      current = await store.getArchive(record.id);
      currentConfig = await store.getConfig();
      if (!ownsDownloadClaim(current, generation, leaseToken, currentConfig)) {
        await abortWriteSession(new Error('Archive download was cancelled.')).catch(() => {});
        if (!current) await storage.remove(record.target, record).catch(() => {});
        return await cancelledResult();
      }
      const bytesDownloaded = offset + bytes.byteLength;
      const finished = bytesDownloaded >= Number(record.size);
      const continueInWake = !finished && piecesProcessed + 1 < maxPiecesPerWake;
      if (!continueInWake && writer) {
        if (finished && typeof writer.truncate === 'function') await writer.truncate(Number(record.size));
        await closeWriteSession();
      }
      if (finished && !usedWriteSession && typeof storage.truncate === 'function') {
        await storage.truncate(record.target, Number(record.size));
      }
      if (finished && typeof storage.open === 'function') {
        await openKiwixZim(await storage.open(record.target), record);
      }
      const next = {
        ...current,
        ...(usedWriteSession ? {
          writeSessionStartPiece: continueInWake ? current.writeSessionStartPiece : null,
          writeSessionStartBytes: continueInWake ? current.writeSessionStartBytes : null,
        } : {}),
        status: finished ? 'ready' : continueInWake ? 'downloading' : 'queued',
        leaseToken: continueInWake ? leaseToken : '',
        leaseUntil: continueInWake ? now() + 5 * 60_000 : 0,
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
      if (!saved) {
        if (writeSessionCommitted && !await store.getArchive(record.id)) {
          await storage.remove(record.target, record).catch(() => {});
        }
        return await cancelledResult();
      }
      let readyResult = {};
      if (finished) {
        try {
          readyResult = await onArchiveReady(next) || {};
        } catch (error) {
          readyResult = { replacementCleanupError: error?.message || String(error) };
        }
      }
      piecesProcessed += 1;
      if (continueInWake) {
        record = next;
        continue;
      }
      const nextDelay = nextArchiveScheduleDelay(await store.listArchives(), now());
      if (nextDelay != null) schedule(nextDelay);
      return { processed: true, archive: next, ...readyResult };
      }
    } catch (error) {
      await abortWriteSession(error).catch(() => {});
      const current = await store.getArchive(record.id);
      if (!current || current.generation !== generation || current.leaseToken !== leaseToken || controller.signal.aborted) {
        if (!current && writeSessionCommitted) await storage.remove(record.target, record).catch(() => {});
        return await cancelledResult();
      }
      const rollbackWriteSession = current.writeSessionStartPiece != null && !writeSessionCommitted;
      const permissionRequired = isFilePermissionError(error, current.target);
      const retryCount = permissionRequired ? (Number(current.retryCount) || 0) : (Number(current.retryCount) || 0) + 1;
      const delay = retryDelay(retryCount);
      const retrying = !permissionRequired && retryCount < MAX_RETRY_ATTEMPTS;
      const next = {
        ...current,
        ...(rollbackWriteSession ? {
          pieceIndex: Math.max(0, Number(current.writeSessionStartPiece) || 0),
          bytesDownloaded: Math.max(0, Number(current.writeSessionStartBytes) || 0),
        } : {}),
        ...(current.writeSessionStartPiece != null ? {
          writeSessionStartPiece: null,
          writeSessionStartBytes: null,
        } : {}),
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
      if (!saved) return await cancelledResult();
      const nextDelay = nextArchiveScheduleDelay(await store.listArchives(), now());
      if (nextDelay != null) schedule(nextDelay);
      return { processed: false, reason: retrying ? 'retrying' : 'error', archive: next };
    } finally {
      await abortWriteSession(new Error('Archive write session ended before commit.')).catch(() => {});
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
  const reportStatus = status => {
    try { options.onSearchStatus?.({ status }); } catch {}
  };
  if (config.enabled !== true && options.requireEnabled !== false) {
    reportStatus('disabled');
    return [];
  }
  const installedArchives = await store.listArchives();
  if (!installedArchives.length) {
    reportStatus('not_installed');
    return [];
  }
  const archives = installedArchives
    .filter(record => record.status === 'ready' && (!options.archiveId || record.id === options.archiveId))
    .sort((left, right) => String(right.archiveDate || '').localeCompare(String(left.archiveDate || '')));
  if (!archives.length) {
    reportStatus('not_ready');
    return [];
  }
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
  reportStatus(results.length ? 'matched' : 'no_match');
  return results.slice(0, Math.max(1, Math.min(10, Number(options.limit) || 3)));
}

function cachedKiwixArchive(record, storage, cache) {
  const targetIdentity = record?.target?.kind === 'file-handle'
    ? record.target.handle?.name || record.filename || 'selected-file'
    : record?.target?.key || record?.filename || 'browser-storage';
  const key = [record?.id, record?.generation, record?.updatedAt, record?.size, targetIdentity].join(':');
  if (cache.has(key)) {
    const pending = cache.get(key);
    cache.delete(key);
    cache.set(key, pending);
    return pending;
  }
  const pending = storage.open(record.target).then(source => openKiwixZim(source, record));
  cache.set(key, pending);
  while (cache.size > MAX_CACHED_KIWIX_ARCHIVES) cache.delete(cache.keys().next().value);
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

export function createKiwixZimProvider(options = {}) {
  const storage = options.storage || createOpfsArchiveStorage();
  const archiveCache = options.archiveCache || SHARED_KIWIX_ARCHIVE_CACHE;
  return {
    id: 'kiwix-zim',
    supports(record) {
      return record?.archiveKind === 'wikipedia'
        && (record?.target?.kind === 'opfs' || record?.target?.kind === 'file-handle');
    },
    async search(record, query, searchOptions = {}) {
      const archive = await cachedKiwixArchive(record, storage, archiveCache);
      return (await archive.search(query, searchOptions)).map(result => ({
        ...result,
        archiveId: record.id,
        archiveTitle: record.title || record.filename,
      }));
    },
    async read(record, path, readOptions = {}) {
      const archive = await cachedKiwixArchive(record, storage, archiveCache);
      return {
        ...(await archive.readArticle(path, readOptions)),
        archiveId: record.id,
        archiveTitle: record.title || record.filename,
      };
    },
    async readImage(record, path, readOptions = {}) {
      const archive = await cachedKiwixArchive(record, storage, archiveCache);
      return await archive.readImage(path, readOptions);
    },
  };
}

export async function readApocalypseArticle(archiveId, path, options = {}) {
  const store = options.store || createApocalypseStore();
  const storage = options.storage || createOpfsArchiveStorage();
  const record = (await store.listArchives()).find(item => item.id === archiveId && item.status === 'ready');
  if (!record) throw new Error('This Wikipedia archive is not installed or is not ready.');
  const provider = (options.providers || [createKiwixZimProvider({ storage })]).find(candidate => candidate.supports(record));
  if (!provider?.read) throw new Error('This archive cannot be opened by the text reader.');
  return await provider.read(record, path, {
    maxChars: options.maxChars,
    maxHtmlChars: options.maxHtmlChars,
  });
}

export async function readApocalypseImage(archiveId, path, options = {}) {
  const storage = options.storage || createOpfsArchiveStorage();
  const suppliedRecord = options.record;
  const record = suppliedRecord?.id === archiveId && suppliedRecord.status === 'ready'
    ? suppliedRecord
    : (await (options.store || createApocalypseStore()).listArchives())
      .find(item => item.id === archiveId && item.status === 'ready');
  if (!record) throw new Error('This Wikipedia archive is not installed or is not ready.');
  const provider = (options.providers || [createKiwixZimProvider({ storage })]).find(candidate => candidate.supports(record));
  if (!provider?.readImage) throw new Error('This archive cannot provide reader images.');
  return await provider.readImage(record, path, { maxBytes: options.maxBytes });
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
    imagesIncluded: inspected.imagesIncluded === true,
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
  if (storage.quotaLimited !== false && capacity.known && blob.size > capacity.free) {
    throw new Error('Insufficient browser-managed storage space for this ZIM archive.');
  }
  const id = options.id || globalThis.crypto.randomUUID();
  const filename = safeArchiveKey(metadata.filename || blob.name || `${id}.zim`);
  const target = { kind: 'opfs', key: `${id}-${filename}` };
  let record = importedArchiveRecord(metadata, blob, inspected, id, target, 'importing');
  await store.putArchive(record);
  const chunkSize = Math.max(1024 * 1024, Number(options.chunkSize) || 4 * 1024 * 1024);
  let writer = null;
  let writerCommitted = false;
  try {
    if (typeof storage.createWriter === 'function') writer = await storage.createWriter(target, record);
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      if (options.signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
      const current = await store.getArchive(id);
      if (!current || current.generation !== record.generation) throw new DOMException('Import cancelled.', 'AbortError');
      const bytes = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + chunkSize)).arrayBuffer());
      if (writer) await writer.write(offset, bytes);
      else await storage.write(target, offset, bytes, record);
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
    if (writer) {
      if (typeof writer.truncate === 'function') await writer.truncate(blob.size);
      await writer.close();
      writer = null;
      writerCommitted = true;
    }
    const ready = { ...record, status: 'ready', completedAt: Date.now(), updatedAt: Date.now() };
    const saved = await putArchiveIfCurrent(store, ready, {
      status: 'importing', generation: record.generation, updatedAt: record.updatedAt,
    });
    if (!saved) throw new DOMException('Import cancelled.', 'AbortError');
    record = ready;
    return record;
  } catch (error) {
    if (writer && !writerCommitted) {
      if (typeof writer.abort === 'function') await writer.abort(error).catch(() => {});
      writer = null;
    }
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
      const failed = { ...record, status: 'error', errorKind: 'delete-failed', error: message, updatedAt: Date.now() };
      await putArchiveIfCurrent(store, failed, {
        status: 'importing', generation: record.generation, updatedAt: record.updatedAt,
      });
      throw new Error(message, { cause: error });
    }
    if (!current || error?.name === 'AbortError') {
      await store.deleteArchive(id);
      throw error;
    }
    const failed = { ...record, status: 'error', bytesDownloaded: 0, error: error?.message || String(error), updatedAt: Date.now() };
    const saved = await putArchiveIfCurrent(store, failed, {
      status: 'importing', generation: record.generation, updatedAt: record.updatedAt,
    });
    if (saved) record = failed;
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
  const catalogTimeoutMs = Math.max(1_000, Number(options.catalogTimeoutMs) || 5_000);
  const libraryTimeoutMs = Math.max(5_000, Number(options.libraryTimeoutMs) || 30_000);
  const schedule = options.schedule || ((delayMs) => api?.alarms?.create?.(APOCALYPSE_DOWNLOAD_ALARM, {
    delayInMinutes: Math.max(0.05, Number(delayMs) / 60_000),
  }));
  const replacementCleanupInFlight = new Map();
  async function cleanupArchiveReplacements(record) {
    if (!record?.id || record.status !== 'ready') return {};
    if (isSimpleEnglishWikipediaArchive(record)) {
      if (Array.isArray(record.replacementArchiveIds) && record.replacementArchiveIds.length) {
        const current = await store.getArchive(record.id);
        if (current?.status === 'ready') {
          await putArchiveIfCurrent(store, {
            ...current,
            replacementArchiveIds: [],
            replacementCleanupError: '',
            updatedAt: Date.now(),
          }, { status: current.status, generation: current.generation, updatedAt: current.updatedAt });
        }
      }
      return {};
    }
    if (replacementCleanupInFlight.has(record.id)) return await replacementCleanupInFlight.get(record.id);
    const cleanup = (async () => {
      const pending = [...new Set((Array.isArray(record.replacementArchiveIds) ? record.replacementArchiveIds : [])
        .map(value => String(value || '')).filter(Boolean))];
      if (!pending.length) return {};
      const retained = [];
      const removed = [];
      const errors = [];
      for (const id of pending) {
        if (id === record.id) continue;
        const replacement = await store.getArchive(id);
        if (!replacement) continue;
        if (replacement.archiveKind !== 'wikipedia' || !['ready', 'error'].includes(replacement.status)) {
          retained.push(id);
          continue;
        }
        try {
          await manager.remove(id);
          removed.push(id);
        } catch (error) {
          retained.push(id);
          errors.push(error?.message || String(error));
        }
      }
      const current = await store.getArchive(record.id);
      if (current?.status === 'ready') {
        await putArchiveIfCurrent(store, {
          ...current,
          replacementArchiveIds: retained,
          replacementCleanupError: errors.join(' '),
          replacementsCompletedAt: retained.length ? null : Date.now(),
          updatedAt: Date.now(),
        }, { status: current.status, generation: current.generation, updatedAt: current.updatedAt });
      }
      return { replacementRemoved: removed, replacementRetained: retained, replacementCleanupError: errors.join(' ') };
    })().finally(() => replacementCleanupInFlight.delete(record.id));
    replacementCleanupInFlight.set(record.id, cleanup);
    return await cleanup;
  }
  const manager = createApocalypseArchiveManager({
    store,
    storage,
    fetchImpl,
    schedule,
    onArchiveReady: cleanupArchiveReplacements,
  });
  const importStaleMs = Math.max(30_000, Number(options.importStaleMs) || 60_000);
  const recoveryIntervalMs = Math.max(5_000, Number(options.recoveryIntervalMs) || Math.min(importStaleMs, 60_000));
  const now = options.now || (() => Date.now());
  let lastRecoveryAt = Number.NEGATIVE_INFINITY;
  let recoveryInFlight = null;
  let libraryCatalogTextPromise = null;
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
    const pendingReplacements = (await store.listArchives())
      .filter(record => record.status === 'ready' && Array.isArray(record.replacementArchiveIds) && record.replacementArchiveIds.length);
    for (const record of pendingReplacements) await cleanupArchiveReplacements(record);
    const [state, estimate] = await Promise.all([manager.getSnapshot(), storage.estimate().catch(() => ({}))]);
    const archives = state.archives.map(publicArchiveRecord);
    const capacity = normalizeStorageEstimate(estimate);
    return { ...state, archives, storage: { usage: capacity.usage, quota: capacity.quota } };
  }

  async function fetchCatalogResponse(url, timeoutMs) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await fetchImpl(url, {
        credentials: 'omit',
        redirect: 'follow',
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function loadLibraryCatalog() {
    if (!libraryCatalogTextPromise) {
      libraryCatalogTextPromise = fetchCatalogResponse(KIWIX_LIBRARY_URL, libraryTimeoutMs).then(async (response) => {
        if (!response.ok) throw new Error(`Kiwix library returned HTTP ${response.status}.`);
        return await response.text();
      }).catch((error) => {
        libraryCatalogTextPromise = null;
        throw error;
      });
    }
    return await libraryCatalogTextPromise;
  }

  async function catalog(language) {
    const config = await store.getConfig();
    if (config.enabled !== true) throw new Error('Apocalypse Mode is disabled. Enable it before loading the Kiwix catalog.');
    try {
      const response = await fetchCatalogResponse(kiwixCatalogUrl(language), catalogTimeoutMs);
      if (!response.ok) throw new Error(`Kiwix catalog returned HTTP ${response.status}.`);
      const items = parseKiwixCatalog(await response.text());
      if (items.length) return items;
    } catch { /* Fall back to Kiwix's static library catalog below. */ }
    try {
      const items = parseKiwixLibrary(await loadLibraryCatalog(), language);
      if (items.length) return items;
    } catch { /* Present one stable, actionable error to the management page. */ }
    throw new Error('Kiwix archives are temporarily unavailable. Try again.');
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
        if (storage.quotaLimited !== false && capacity.known && Number(payload.download?.size) > capacity.free) {
          throw new Error(`Not enough extension storage (${capacity.free} bytes available).`);
        }
        if (!/^wikipedia(?:_|$)/i.test(String(payload.download?.name || ''))) {
          throw new Error('Apocalypse Mode currently supports Wikipedia catalog archives only.');
        }
        const replacementEligible = /(?:^|_)all(?:_|$)/i.test(String(payload.download?.name || ''))
          && !isSimpleEnglishWikipediaArchive(payload.download);
        const requestedReplacementIds = new Set((replacementEligible && Array.isArray(payload.replacementArchiveIds)
          ? payload.replacementArchiveIds : []).slice(0, 16).map(value => String(value || '')));
        const replacementArchiveIds = (await store.listArchives())
          .filter(record => requestedReplacementIds.has(record.id)
            && record.archiveKind === 'wikipedia' && record.status === 'ready')
          .map(record => record.id);
        const key = `${payload.download?.id || 'wikipedia'}-${payload.download?.filename || 'archive.zim'}`;
        await manager.install({
          ...payload.download,
          archiveKind: 'wikipedia',
          replacementArchiveIds,
        }, { kind: 'opfs', key: safeArchiveKey(key) });
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
