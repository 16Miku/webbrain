#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseDomain } from 'tldts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COUPON_FOLLOW_ORIGIN = 'https://couponfollow.com';
const COUPON_FOLLOW_INDEXES = ['0', ...'abcdefghijklmnopqrstuvwxyz'];
const COUPON_SWIFT_URL = 'https://www.couponswift.com/stores';
const DEFAULT_CONCURRENCY = 2;
const MAX_FETCH_ATTEMPTS = 3;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PROVENANCE_PATH = 'scripts/data/coupon-domains.provenance.json';
const OUTPUTS = [
  'src/chrome/src/ui/coupon-domains.js',
  'src/firefox/src/ui/coupon-domains.js',
];

// Preserve the original conservative rollout and regional storefronts even if
// a third-party directory temporarily removes or renames one of its entries.
const VETTED_DOMAINS = [
  'amazon.com', 'amazon.ca', 'amazon.com.mx', 'amazon.com.br', 'amazon.co.uk', 'amazon.de', 'amazon.fr',
  'amazon.it', 'amazon.es', 'amazon.nl', 'amazon.pl', 'amazon.se', 'amazon.com.be', 'amazon.co.jp',
  'amazon.in', 'amazon.com.au', 'amazon.sg', 'amazon.ae', 'amazon.sa', 'amazon.com.tr', 'amazon.eg',
  'ebay.com', 'ebay.ca', 'ebay.co.uk', 'ebay.de', 'ebay.fr', 'ebay.it', 'ebay.es', 'ebay.com.au',
  'etsy.com', 'walmart.com', 'target.com', 'bestbuy.com', 'aliexpress.com', 'mercadolivre.com.br',
  'hepsiburada.com', 'trendyol.com', 'n11.com', 'shopeekh.com',
  'mercadolibre.com.ar', 'mercadolibre.com.mx', 'mercadolibre.com.co', 'mercadolibre.cl',
  'mercadolibre.com.pe', 'mercadolibre.com.uy', 'mercadolibre.com.ve', 'mercadolibre.com.ec',
  'mercadolibre.com.bo', 'mercadolibre.com.py', 'mercadolibre.com.do', 'mercadolibre.com.gt',
  'mercadolibre.com.hn', 'mercadolibre.com.ni', 'mercadolibre.com.pa', 'mercadolibre.com.sv',
  'mercadolibre.co.cr',
  'shopee.com', 'shopee.com.br', 'shopee.com.co', 'shopee.com.mx', 'shopee.cl', 'shopee.co.id',
  'shopee.com.my', 'shopee.com.ph', 'shopee.sg', 'shopee.co.th', 'shopee.vn', 'shopee.tw',
  'lazada.com', 'lazada.co.id', 'lazada.com.my', 'lazada.com.ph', 'lazada.sg', 'lazada.co.th', 'lazada.vn',
];

const SOURCE_DEFINITIONS = Object.freeze({
  couponfollow: Object.freeze({
    url: 'https://couponfollow.com/site/browse/{0,a-z}/all',
    evidenceTier: 'coupon-directory',
    minDomains: 3_000,
    maxDomains: 10_000,
    churnFloor: 100,
    maxChurnRatio: 0.20,
  }),
  couponswift: Object.freeze({
    url: COUPON_SWIFT_URL,
    evidenceTier: 'verified-store-directory',
    minDomains: 40,
    maxDomains: 100,
    churnFloor: 10,
    maxChurnRatio: 0.30,
  }),
  vetted: Object.freeze({
    url: 'https://github.com/webbrain-one/webbrain/blob/main/scripts/update-coupon-domains.mjs',
    evidenceTier: 'maintainer-vetted',
    minDomains: VETTED_DOMAINS.length,
    maxDomains: VETTED_DOMAINS.length,
    churnFloor: 0,
    maxChurnRatio: 0,
  }),
});
const SOURCE_IDS = Object.freeze(Object.keys(SOURCE_DEFINITIONS));

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function decodeSerializedUrl(value) {
  return decodeHtmlAttribute(String(value || ''))
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');
}

export function normalizeCouponDomain(value) {
  let input = String(value || '').trim().toLowerCase();
  if (!input) return null;
  try {
    input = decodeURIComponent(input);
  } catch {
    return null;
  }

  let hostname;
  try {
    hostname = new URL(input.includes('://') ? input : `https://${input}`).hostname;
  } catch {
    return null;
  }
  hostname = hostname.replace(/^www\./, '').replace(/\.$/, '');
  if (
    hostname.length > 253
    || !hostname.includes('.')
    || !/^[a-z0-9.-]+$/.test(hostname)
    || hostname.includes('..')
  ) return null;

  const parsed = parseDomain(hostname, {
    allowPrivateDomains: true,
    extractHostname: false,
  });
  if (!parsed.domain || (!parsed.isIcann && !parsed.isPrivate)) return null;
  return hostname;
}

function normalizedDomains(domains) {
  const result = new Set();
  for (const candidate of domains || []) {
    const domain = normalizeCouponDomain(candidate);
    if (domain) result.add(domain);
  }
  return [...result].sort();
}

export function extractCouponFollowDomains(html) {
  const domains = new Set();
  const hrefPattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  for (const match of String(html || '').matchAll(hrefPattern)) {
    let url;
    try {
      url = new URL(decodeHtmlAttribute(match[2]), COUPON_FOLLOW_ORIGIN);
    } catch {
      continue;
    }
    if (url.hostname !== 'couponfollow.com' && url.hostname !== 'www.couponfollow.com') continue;
    const merchantRoute = /^\/site\/([^/]+)\/?$/.exec(url.pathname);
    if (!merchantRoute) continue;
    const domain = normalizeCouponDomain(merchantRoute[1]);
    if (domain) domains.add(domain);
  }
  return [...domains].sort();
}

export function extractCouponSwiftDomains(html) {
  const domains = new Set();
  const patterns = [
    /"websiteUrl"\s*:\s*"([^"]+)"/g,
    /\\"websiteUrl\\"\s*:\s*\\"([^"\\]+)\\"/g,
  ];
  for (const pattern of patterns) {
    for (const match of String(html || '').matchAll(pattern)) {
      const domain = normalizeCouponDomain(decodeSerializedUrl(match[1]));
      if (domain) domains.add(domain);
    }
  }
  return [...domains].sort();
}

function assertTrustedSourceUrl(value, sourceId) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${sourceId} source must use HTTPS: ${url}`);
  if (sourceId === 'couponfollow') {
    if (!['couponfollow.com', 'www.couponfollow.com'].includes(url.hostname)) {
      throw new Error(`CouponFollow redirected to an unexpected host: ${url.hostname}`);
    }
    if (!/^\/site\/browse\/(?:0|[a-z])\/all\/?$/.test(url.pathname)) {
      throw new Error(`CouponFollow returned an unexpected route: ${url.pathname}`);
    }
    return;
  }
  if (sourceId === 'couponswift') {
    if (!['couponswift.com', 'www.couponswift.com'].includes(url.hostname) || !/^\/stores\/?$/.test(url.pathname)) {
      throw new Error(`CouponSwift returned an unexpected URL: ${url}`);
    }
    return;
  }
  throw new Error(`Unknown network source: ${sourceId}`);
}

async function fetchText(url, { fetchImpl = fetch, sourceId } = {}) {
  assertTrustedSourceUrl(url, sourceId);
  let response;
  let lastError;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.8',
          'user-agent': 'WebBrainCouponDomainUpdater/2.0 (+https://github.com/webbrain-one/webbrain)',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok || ![406, 408, 425, 429, 500, 502, 503, 504].includes(response.status)) break;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt === MAX_FETCH_ATTEMPTS) throw lastError;
    await response?.body?.cancel?.().catch(() => {});
    const retryAfter = Number(response?.headers?.get?.('retry-after') || 0) * 1_000;
    const delayMs = retryAfter > 0 ? Math.min(retryAfter, 10_000) : attempt * 750;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  if (response.url) assertTrustedSourceUrl(response.url, sourceId);
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error(`${url} returned unexpected content type ${contentType}`);
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${url} declared ${declaredLength} bytes; limit is ${MAX_RESPONSE_BYTES}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error(`${url} exceeded the ${MAX_RESPONSE_BYTES}-byte response limit`);
  }
  return text;
}

async function mapConcurrent(items, concurrency, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function collectCouponFollowDomains({ concurrency = DEFAULT_CONCURRENCY, fetchImpl = fetch } = {}) {
  const boundedConcurrency = Math.max(1, Math.min(8, Number(concurrency) || DEFAULT_CONCURRENCY));
  const urls = COUPON_FOLLOW_INDEXES.map((index) => `${COUPON_FOLLOW_ORIGIN}/site/browse/${index}/all`);
  const pages = await mapConcurrent(urls, boundedConcurrency, async (url) => {
    const html = await fetchText(url, { fetchImpl, sourceId: 'couponfollow' });
    const domains = extractCouponFollowDomains(html);
    if (!domains.length) throw new Error(`${url} contained no merchant domains`);
    return domains;
  });
  return normalizedDomains(pages.flat());
}

export async function collectCouponSwiftDomains({ fetchImpl = fetch } = {}) {
  const html = await fetchText(COUPON_SWIFT_URL, { fetchImpl, sourceId: 'couponswift' });
  const domains = extractCouponSwiftDomains(html);
  if (!domains.length) throw new Error(`${COUPON_SWIFT_URL} contained no merchant websiteUrl records`);
  return domains;
}

export async function collectCouponDomainEvidence({ concurrency = DEFAULT_CONCURRENCY, fetchImpl = fetch } = {}) {
  const [couponFollow, couponSwift] = await Promise.all([
    collectCouponFollowDomains({ concurrency, fetchImpl }),
    collectCouponSwiftDomains({ fetchImpl }),
  ]);
  return new Map([
    ['couponfollow', new Set(couponFollow)],
    ['couponswift', new Set(couponSwift)],
    ['vetted', new Set(normalizedDomains(VETTED_DOMAINS))],
  ]);
}

function sourceCount(manifest, sourceId) {
  return Number(manifest?.sources?.[sourceId]?.domainCount || 0);
}

export function assertCouponDomainEvidence(evidence, { previousManifest = null, allowLargeChurn = false } = {}) {
  for (const sourceId of SOURCE_IDS) {
    const definition = SOURCE_DEFINITIONS[sourceId];
    const count = evidence.get(sourceId)?.size || 0;
    if (count < definition.minDomains || count > definition.maxDomains) {
      throw new Error(`${sourceId} yielded ${count} domains; expected ${definition.minDomains}-${definition.maxDomains}`);
    }
    const previousCount = sourceCount(previousManifest, sourceId);
    if (!allowLargeChurn && previousCount) {
      const allowedDelta = Math.max(
        definition.churnFloor,
        Math.ceil(previousCount * definition.maxChurnRatio),
      );
      if (Math.abs(count - previousCount) > allowedDelta) {
        throw new Error(`${sourceId} count changed from ${previousCount} to ${count}; limit is ${allowedDelta}`);
      }
    }
  }
}

function unionEvidenceDomains(evidence) {
  const domains = new Set();
  for (const sourceDomains of evidence.values()) {
    for (const domain of sourceDomains) domains.add(domain);
  }
  return [...domains].sort();
}

export function activeDomainsFromManifest(manifest) {
  const domains = [];
  for (const [domain, sources] of Object.entries(manifest?.domains || {})) {
    if (Object.values(sources || {}).some((record) => record?.active === true)) domains.push(domain);
  }
  return normalizedDomains(domains);
}

export function assertCouponDomainChurn(previousDomains, nextDomains, { allowLargeChurn = false } = {}) {
  const previous = new Set(normalizedDomains(previousDomains));
  const next = new Set(normalizedDomains(nextDomains));
  const added = [...next].filter((domain) => !previous.has(domain));
  const removed = [...previous].filter((domain) => !next.has(domain));
  const limit = Math.max(100, Math.ceil(previous.size * 0.15));
  if (!allowLargeChurn && previous.size && (added.length > limit || removed.length > limit)) {
    throw new Error(`coupon snapshot churn exceeded ${limit}: ${added.length} added, ${removed.length} removed`);
  }
  return { added, removed, limit };
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

export function buildCouponDomainProvenance(evidence, { previousManifest = null, asOf } = {}) {
  if (!validDate(asOf)) throw new Error(`Invalid --as-of date: ${asOf}`);
  if (previousManifest?.asOf && asOf < previousManifest.asOf) {
    throw new Error(`--as-of ${asOf} predates the existing manifest ${previousManifest.asOf}`);
  }

  const records = new Map();
  for (const [domain, sources] of Object.entries(previousManifest?.domains || {})) {
    const normalized = normalizeCouponDomain(domain);
    if (!normalized || normalized !== domain) continue;
    const copied = {};
    for (const sourceId of SOURCE_IDS) {
      const previous = sources?.[sourceId];
      if (!previous || !validDate(previous.firstSeen) || !validDate(previous.lastSeen)) continue;
      copied[sourceId] = {
        firstSeen: previous.firstSeen,
        lastSeen: previous.lastSeen,
        active: false,
      };
    }
    if (Object.keys(copied).length) records.set(domain, copied);
  }

  for (const sourceId of SOURCE_IDS) {
    for (const domain of [...(evidence.get(sourceId) || [])].sort()) {
      const sources = records.get(domain) || {};
      const previous = sources[sourceId];
      sources[sourceId] = {
        firstSeen: previous?.firstSeen || asOf,
        lastSeen: asOf,
        active: true,
      };
      records.set(domain, sources);
    }
  }

  const sources = {};
  for (const sourceId of SOURCE_IDS) {
    const definition = SOURCE_DEFINITIONS[sourceId];
    sources[sourceId] = {
      url: definition.url,
      evidenceTier: definition.evidenceTier,
      domainCount: evidence.get(sourceId)?.size || 0,
    };
  }

  const domains = {};
  for (const domain of [...records.keys()].sort()) {
    const sourceRecords = records.get(domain);
    domains[domain] = {};
    for (const sourceId of SOURCE_IDS) {
      if (sourceRecords[sourceId]) domains[domain][sourceId] = sourceRecords[sourceId];
    }
  }

  return {
    schemaVersion: 1,
    asOf,
    activeDomainCount: unionEvidenceDomains(evidence).length,
    sources,
    domains,
  };
}

export function validateCouponDomainProvenance(manifest, { enforceSourceBounds = false } = {}) {
  if (manifest?.schemaVersion !== 1 || !validDate(manifest?.asOf)) {
    throw new Error('Invalid coupon-domain provenance schema or asOf date');
  }
  for (const sourceId of SOURCE_IDS) {
    const source = manifest.sources?.[sourceId];
    const definition = SOURCE_DEFINITIONS[sourceId];
    if (
      source?.url !== definition.url
      || source?.evidenceTier !== definition.evidenceTier
      || !Number.isInteger(source?.domainCount)
      || (enforceSourceBounds && (
        source.domainCount < definition.minDomains
        || source.domainCount > definition.maxDomains
      ))
    ) throw new Error(`Invalid provenance source metadata for ${sourceId}`);
  }
  for (const [domain, sources] of Object.entries(manifest.domains || {})) {
    if (normalizeCouponDomain(domain) !== domain) throw new Error(`Invalid provenance domain: ${domain}`);
    for (const [sourceId, record] of Object.entries(sources || {})) {
      if (!SOURCE_DEFINITIONS[sourceId]) throw new Error(`Unknown provenance source: ${sourceId}`);
      if (!validDate(record?.firstSeen) || !validDate(record?.lastSeen) || typeof record?.active !== 'boolean') {
        throw new Error(`Invalid provenance evidence for ${domain}/${sourceId}`);
      }
      if (record.firstSeen > record.lastSeen || record.lastSeen > manifest.asOf) {
        throw new Error(`Invalid provenance date order for ${domain}/${sourceId}`);
      }
    }
  }
  const active = activeDomainsFromManifest(manifest);
  if (active.length !== manifest.activeDomainCount) {
    throw new Error(`Manifest activeDomainCount is ${manifest.activeDomainCount}; found ${active.length}`);
  }
  for (const sourceId of SOURCE_IDS) {
    const activeForSource = Object.values(manifest.domains || {})
      .filter((sources) => sources?.[sourceId]?.active === true).length;
    if (activeForSource !== manifest.sources[sourceId].domainCount) {
      throw new Error(`${sourceId} domainCount is ${manifest.sources[sourceId].domainCount}; found ${activeForSource}`);
    }
  }
  return manifest;
}

export function renderCouponDomainModule(domains, { sources = SOURCE_IDS.map((id) => SOURCE_DEFINITIONS[id].url) } = {}) {
  const normalized = normalizedDomains(domains);
  if (!normalized.length) throw new Error('Refusing to render an empty coupon merchant domain set.');
  const sourceLines = sources.map((source) => ` * Source: ${source}`).join('\n');
  return `/**\n * Generated by \`npm run update:coupon-domains\`; do not edit by hand.\n${sourceLines}\n * Runtime updates are intentionally disabled: this reviewed snapshot ships with the extension.\n */\nexport const COUPON_MERCHANT_DOMAINS = new Set([\n${normalized.map((domain) => `  '${domain}',`).join('\n')}\n]);\n`;
}

export function renderCouponDomainProvenance(manifest) {
  validateCouponDomainProvenance(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function domainsFromModule(source) {
  return normalizedDomains([...String(source || '').matchAll(/^  '([^']+)',$/gm)].map((match) => match[1]));
}

async function readOptional(relativePath) {
  try {
    return await readFile(path.join(ROOT, relativePath), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readProvenance() {
  const source = await readOptional(PROVENANCE_PATH);
  if (!source) return null;
  return validateCouponDomainProvenance(JSON.parse(source), { enforceSourceBounds: true });
}

function parseArgs(argv) {
  const args = {
    check: false,
    bootstrapFromSnapshot: false,
    concurrency: DEFAULT_CONCURRENCY,
    asOf: new Date().toISOString().slice(0, 10),
    allowLargeChurn: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      args.check = true;
      continue;
    }
    if (arg === '--bootstrap-from-snapshot') {
      args.bootstrapFromSnapshot = true;
      continue;
    }
    if (arg === '--allow-large-churn') {
      args.allowLargeChurn = true;
      continue;
    }
    if (arg === '--concurrency') {
      args.concurrency = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--as-of') {
      args.asOf = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8) {
    throw new Error('--concurrency must be an integer from 1 to 8');
  }
  if (!validDate(args.asOf)) throw new Error('--as-of must use YYYY-MM-DD');
  if (args.check && args.bootstrapFromSnapshot) throw new Error('--check cannot be combined with --bootstrap-from-snapshot');
  return args;
}

async function assertGeneratedFiles(manifest) {
  const provenanceSource = await readOptional(PROVENANCE_PATH);
  const canonicalProvenance = renderCouponDomainProvenance(manifest);
  if (provenanceSource !== canonicalProvenance) throw new Error(`${PROVENANCE_PATH} is not canonical`);

  const domains = activeDomainsFromManifest(manifest);
  const expected = renderCouponDomainModule(domains);
  const changed = [];
  for (const relativePath of OUTPUTS) {
    if (await readOptional(relativePath) !== expected) changed.push(relativePath);
  }
  if (changed.length) throw new Error(`coupon domain snapshot is stale: ${changed.join(', ')}`);
  return domains.length;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const previousManifest = await readProvenance();
  if (args.check) {
    if (!previousManifest) throw new Error(`${PROVENANCE_PATH} is missing`);
    const count = await assertGeneratedFiles(previousManifest);
    console.log(`Checked ${count} coupon merchant domains and provenance (no network requests).`);
    return;
  }

  if (args.bootstrapFromSnapshot && previousManifest) {
    throw new Error('--bootstrap-from-snapshot is only allowed while the provenance manifest is missing');
  }
  let evidence;
  if (args.bootstrapFromSnapshot) {
    const currentDomains = domainsFromModule(await readOptional(OUTPUTS[0]));
    if (!currentDomains.length) throw new Error('Cannot bootstrap from an empty coupon-domain snapshot');
    const vetted = new Set(normalizedDomains(VETTED_DOMAINS));
    const couponSwift = await collectCouponSwiftDomains();
    evidence = new Map([
      ['couponfollow', new Set(currentDomains.filter((domain) => !vetted.has(domain)))],
      ['couponswift', new Set(couponSwift)],
      ['vetted', vetted],
    ]);
  } else {
    evidence = await collectCouponDomainEvidence({
      concurrency: args.concurrency,
    });
  }
  assertCouponDomainEvidence(evidence, {
    previousManifest,
    allowLargeChurn: args.allowLargeChurn,
  });
  const domains = unionEvidenceDomains(evidence);
  let previousDomains = previousManifest ? activeDomainsFromManifest(previousManifest) : [];
  if (!previousDomains.length) {
    previousDomains = domainsFromModule(await readOptional(OUTPUTS[0]));
  }
  const churn = assertCouponDomainChurn(previousDomains, domains, {
    allowLargeChurn: args.allowLargeChurn,
  });
  const manifest = buildCouponDomainProvenance(evidence, {
    previousManifest,
    asOf: args.asOf,
  });
  const renderedModule = renderCouponDomainModule(domains);
  const files = new Map([
    [PROVENANCE_PATH, renderCouponDomainProvenance(manifest)],
    ...OUTPUTS.map((relativePath) => [relativePath, renderedModule]),
  ]);
  const changed = [];
  for (const [relativePath, rendered] of files) {
    if (await readOptional(relativePath) === rendered) continue;
    changed.push(relativePath);
    const outputPath = path.join(ROOT, relativePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, rendered);
  }
  console.log(
    `Wrote ${domains.length} coupon merchant domains (${churn.added.length} added, ${churn.removed.length} removed; ${changed.length} files changed).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(`update-coupon-domains: ${error.message}`);
    process.exitCode = 1;
  });
}
