/** Trusted prompt policy and structured citation bridge for offline retrieval. */

import {
  createEmergencyBoxStore,
  emergencyBoxPdfCatalog,
  matchEmergencyBoxPdfResource,
} from './emergency-box.js';
import {
  assembleRagEvidence,
  createEmergencyPdfExtensionPath,
  ragReaderExtensionPath,
} from './offline-rag.js';

function retrievalStatus(statuses, hasEvidence) {
  if (hasEvidence) return 'matched';
  const values = ['wikipedia', 'emergencyBox']
    .filter(key => Object.hasOwn(statuses || {}, key))
    .map(key => String(statuses[key] || ''));
  if (values.length && values.every(value => value === 'skipped')) return 'skipped';
  if (values.some(value => ['ready', 'title-only-fallback', 'matched', 'no_match', 'no-match'].includes(value))) {
    return 'no_match';
  }
  if (values.includes('read_error') || values.includes('error')) return 'read_error';
  if (values.includes('not_ready') || values.some(value => [
    'downloading', 'verifying', 'downloaded', 'extracting', 'indexing', 'paused',
  ].includes(value))) return 'not_ready';
  if (values.includes('disabled')) return 'disabled';
  if (values.includes('not_installed') || values.includes('not-installed')) return 'not_installed';
  return 'no_match';
}

function extensionHref(relativePath, options) {
  const path = String(relativePath || '').replace(/^\/+/, '');
  const getExtensionUrl = options.getExtensionUrl;
  return typeof getExtensionUrl === 'function'
    ? getExtensionUrl(path)
    : `/${path}`;
}

function readerHref(readerUrl, options) {
  return extensionHref(ragReaderExtensionPath(readerUrl), options);
}

function installedEmergencyPdfIdSet(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value : []);
}

export async function attachInstalledEmergencyPdfLinks(references, options = {}) {
  const hits = Array.isArray(references) ? references : [];
  const emergency = hits.filter(hit => hit?.sourceKind === 'emergency-box');
  if (!emergency.length) return hits;

  let installed = options.installedEmergencyPdfIds;
  if (!installed) {
    try {
      const records = await (options.emergencyBoxStore || createEmergencyBoxStore()).list();
      installed = (Array.isArray(records) ? records : [])
        .filter(record => record?.status === 'ready' && record?.id)
        .map(record => record.id);
    } catch {
      return hits;
    }
  }
  const installedIds = installedEmergencyPdfIdSet(installed);
  if (!installedIds.size) return hits;

  const catalog = options.emergencyPdfCatalog || emergencyBoxPdfCatalog();
  return hits.map(reference => {
    if (reference?.sourceKind !== 'emergency-box') return reference;
    const resource = matchEmergencyBoxPdfResource(reference, catalog);
    if (!resource?.id || !installedIds.has(resource.id)) return reference;
    let pdfPath;
    try {
      pdfPath = createEmergencyPdfExtensionPath(resource.id);
    } catch {
      return reference;
    }
    return Object.freeze({
      ...reference,
      pdfResourceId: resource.id,
      pdfUrl: extensionHref(pdfPath, options),
    });
  });
}

export function offlineRagReferences(assembled, options = {}) {
  const passageKey = value => [value?.sourceKind, value?.sourceId, value?.documentId, value?.passageId]
    .map(part => String(part || '')).join('\0');
  const passages = new Map((assembled?.selected || []).map(hit => [passageKey(hit), hit]));
  return Object.freeze((assembled?.citations || []).map(citation => {
    const hit = passages.get(passageKey(citation)) || {};
    return Object.freeze({
      citationToken: citation.token,
      sourceKind: citation.sourceKind,
      sourceId: citation.sourceId,
      documentId: citation.documentId,
      passageId: citation.passageId,
      title: citation.title,
      passage: String(hit.text || ''),
      language: citation.language,
      archiveDate: citation.archiveDate,
      collection: citation.collection,
      locator: citation.locator,
      retrievalMode: citation.retrievalMode,
      source: citation.source,
      license: citation.license,
      readerUrl: citation.readerUrl,
      url: readerHref(citation.readerUrl, options),
      passageSha256: citation.passageSha256,
      truncated: citation.truncated,
    });
  }));
}

export async function retrieveOfflineRagForPrompt(queryValue, options = {}) {
  const query = String(queryValue || '').trim();
  if (!query || !options.service?.search) {
    return Object.freeze({
      attempted: false,
      status: 'skipped',
      matchCount: 0,
      references: Object.freeze([]),
      evidence: '',
      instructions: '',
      statuses: Object.freeze({}),
      rankingMode: 'lexical-fallback',
      usedTokens: 0,
      budgetTokens: 0,
    });
  }
  const retrieval = await options.service.search(query, {
    sources: options.sources,
    languages: options.languages,
    limit: options.limit,
    signal: options.signal,
    onSearchStatus: options.onSearchStatus,
    onSemanticFallback: options.onSemanticFallback,
  });
  const assembled = assembleRagEvidence(retrieval.hits, {
    contextWindowTokens: options.contextWindowTokens,
    systemTokens: options.systemTokens,
    historyTokens: options.historyTokens,
    questionTokens: options.questionTokens,
    generationTokens: options.generationTokens,
    otherReservedTokens: options.otherReservedTokens,
    maximumEvidenceTokens: options.maximumEvidenceTokens,
    maximumPassageTokens: options.maximumPassageTokens,
  });
  const references = Object.freeze(await attachInstalledEmergencyPdfLinks(
    offlineRagReferences(assembled, options),
    options,
  ));
  return Object.freeze({
    attempted: true,
    status: retrievalStatus(retrieval.statuses, references.length > 0),
    matchCount: references.length,
    references,
    evidence: assembled.evidence,
    instructions: assembled.instructions,
    statuses: Object.freeze({ ...(retrieval.statuses || {}) }),
    errors: Object.freeze({ ...(retrieval.errors || {}) }),
    rankingMode: retrieval.rankingMode,
    usedTokens: assembled.usedTokens,
    budgetTokens: assembled.budgetTokens,
    semanticRerankingUsed: assembled.semanticRerankingUsed,
  });
}
