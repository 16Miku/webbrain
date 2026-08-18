/** Shared, download-free readiness and filter UI for offline retrieval. */

import { createApocalypseStore } from '../agent/apocalypse-mode.js';
import { createEmergencyCorpusStore } from '../agent/emergency-corpus.js';
import { emergencyRetrievalStatus } from '../agent/offline-retrieval.js';
import { createOfflineSemanticReranker } from '../agent/offline-reranker.js';
import { t } from './i18n.js';

export const OFFLINE_RAG_FILTERS_KEY = 'webbrainOfflineRagFilters';
export const OFFLINE_RAG_FILTERS_EVENT = 'webbrain-offline-rag-filters-changed';
const SOURCE_KINDS = Object.freeze(['wikipedia', 'emergency-box']);

export function normalizeOfflineRagFilters(value = {}) {
  const sourceValues = Array.isArray(value.sources) ? value.sources : SOURCE_KINDS;
  const sources = [...new Set(sourceValues
    .map(item => String(item || '').trim().toLowerCase())
    .filter(item => SOURCE_KINDS.includes(item)))];
  const languages = [...new Set((Array.isArray(value.languages) ? value.languages : [])
    .map(item => String(item || '').trim().toLowerCase())
    .filter(item => /^[a-z]{3}$/.test(item)))].sort();
  return Object.freeze({
    sources: Object.freeze(sources.length ? sources : [...SOURCE_KINDS]),
    languages: Object.freeze(languages),
  });
}

export function loadOfflineRagFilters(storage = globalThis.localStorage) {
  try { return normalizeOfflineRagFilters(JSON.parse(storage?.getItem(OFFLINE_RAG_FILTERS_KEY) || 'null') || {}); }
  catch { return normalizeOfflineRagFilters(); }
}

export function saveOfflineRagFilters(value, storage = globalThis.localStorage) {
  const filters = normalizeOfflineRagFilters(value);
  storage?.setItem(OFFLINE_RAG_FILTERS_KEY, JSON.stringify(filters));
  globalThis.dispatchEvent?.(new CustomEvent(OFFLINE_RAG_FILTERS_EVENT, { detail: filters }));
  return filters;
}

export function offlineRagRunPayload(storage = globalThis.localStorage) {
  const filters = loadOfflineRagFilters(storage);
  return { offlineRagSources: [...filters.sources], offlineRagLanguages: [...filters.languages] };
}

function statusLabel(status) {
  const key = `eb.rag.status.${status}`;
  const value = t(key);
  return value === key ? String(status || '') : value;
}

function wikipediaStatus(archives) {
  const wikipedia = (Array.isArray(archives) ? archives : [])
    .filter(record => record?.archiveKind === 'wikipedia');
  if (wikipedia.some(record => record.status === 'ready')) return 'title-only-fallback';
  return 'unavailable';
}

function installedLanguages(archives, corpus) {
  const values = [];
  for (const record of Array.isArray(archives) ? archives : []) {
    if (record?.archiveKind === 'wikipedia' && record.status === 'ready') values.push(record.language);
  }
  for (const metadata of corpus?.active?.manifest?.documents || []) values.push(metadata.language);
  return [...new Set(values.map(value => String(value || '').trim().toLowerCase())
    .filter(value => /^[a-z]{3}$/.test(value)))].sort();
}

function statusItem(labelKey, status, id) {
  return `<span class="offline-rag-status-item"><span>${t(labelKey)}</span><strong id="${id}" data-status="${status}">${statusLabel(status)}</strong></span>`;
}

export function createOfflineRagReadinessController(options = {}) {
  const root = options.root;
  if (!root) throw new Error('Offline RAG readiness root is required.');
  const apocalypseStore = options.apocalypseStore || createApocalypseStore();
  const corpusStore = options.corpusStore || createEmergencyCorpusStore();
  const semanticReranker = options.semanticReranker || createOfflineSemanticReranker();
  let filters = loadOfflineRagFilters(options.storage);
  let languages = [];
  let lastState = null;

  const render = () => {
    const state = lastState || {
      wikipedia: 'unavailable', emergencyBox: 'not-installed', semantic: 'model-missing', generation: 'unavailable',
    };
    root.innerHTML = `
      <div class="offline-rag-readiness-head">
        <div><p class="offline-rag-eyebrow">${t('eb.rag.eyebrow')}</p><h2>${t('eb.rag.title')}</h2></div>
        ${options.manageHref ? `<a href="${options.manageHref}">${t('ap.emergency.open')}</a>` : ''}
      </div>
      <p class="offline-rag-note">${t('eb.rag.no_surprise_download')}</p>
      <div class="offline-rag-statuses" role="list" aria-label="${t('eb.rag.status_label')}">
        ${statusItem('eb.rag.wikipedia', state.wikipedia, 'offline-rag-wikipedia')}
        ${statusItem('eb.rag.emergency_search', state.emergencyBox, 'offline-rag-emergency')}
        ${statusItem('eb.rag.semantic', state.semantic, 'offline-rag-semantic')}
        ${statusItem('eb.rag.generation', state.generation, 'offline-rag-generation')}
      </div>
      <fieldset class="offline-rag-sources">
        <legend>${t('eb.rag.source_filters')}</legend>
        <label><input type="checkbox" value="wikipedia" data-offline-rag-source ${filters.sources.includes('wikipedia') ? 'checked' : ''}> ${t('eb.rag.wikipedia')}</label>
        <label><input type="checkbox" value="emergency-box" data-offline-rag-source ${filters.sources.includes('emergency-box') ? 'checked' : ''}> ${t('eb.rag.emergency_search')}</label>
      </fieldset>
      <fieldset class="offline-rag-languages">
        <legend>${t('eb.rag.language_filters')}</legend>
        <label><input type="checkbox" value="" data-offline-rag-language ${filters.languages.length ? '' : 'checked'}> ${t('eb.rag.all_installed_languages')}</label>
        ${languages.map(language => `<label><input type="checkbox" value="${language}" data-offline-rag-language ${filters.languages.includes(language) ? 'checked' : ''}> ${language}</label>`).join('')}
        ${languages.length ? '' : `<span>${t('eb.rag.no_installed_languages')}</span>`}
      </fieldset>`;
  };

  const readControls = target => {
    const sources = [...root.querySelectorAll('[data-offline-rag-source]:checked')].map(input => input.value);
    if (!sources.length && target?.matches?.('[data-offline-rag-source]')) target.checked = true;
    const actualSources = [...root.querySelectorAll('[data-offline-rag-source]:checked')].map(input => input.value);
    const allLanguages = root.querySelector('[data-offline-rag-language][value=""]');
    let selectedLanguages = [...root.querySelectorAll('[data-offline-rag-language]:checked')]
      .map(input => input.value).filter(Boolean);
    if (target === allLanguages && allLanguages.checked) selectedLanguages = [];
    else if (target?.matches?.('[data-offline-rag-language]') && target.value) allLanguages.checked = false;
    if (!selectedLanguages.length) allLanguages.checked = true;
    filters = saveOfflineRagFilters({ sources: actualSources, languages: selectedLanguages }, options.storage);
    render();
    options.onFiltersChanged?.(filters);
  };
  root.addEventListener('change', event => readControls(event.target));

  return Object.freeze({
    filters: () => filters,
    async refresh(refreshOptions = {}) {
      const [archives, corpus, semantic] = await Promise.all([
        refreshOptions.archives
          ? Promise.resolve(refreshOptions.archives)
          : apocalypseStore.listArchives().catch(() => []),
        corpusStore.get().catch(() => null),
        semanticReranker.status().catch(() => 'error'),
      ]);
      languages = installedLanguages(archives, corpus);
      const previousFilters = filters;
      filters = normalizeOfflineRagFilters({
        sources: filters.sources,
        languages: filters.languages.filter(language => languages.includes(language)),
      });
      if (JSON.stringify(filters) !== JSON.stringify(previousFilters)) {
        try {
          (options.storage || globalThis.localStorage)?.setItem(OFFLINE_RAG_FILTERS_KEY, JSON.stringify(filters));
        } catch { /* filter pruning still applies for this page */ }
      }
      const generation = await Promise.resolve(options.getGenerationStatus?.()).catch(() => 'error');
      lastState = Object.freeze({
        wikipedia: wikipediaStatus(archives),
        emergencyBox: emergencyRetrievalStatus(corpus),
        semantic: String(semantic || 'model-missing'),
        generation: String(generation || 'unavailable'),
      });
      render();
      return lastState;
    },
    render,
    close() { semanticReranker.close?.(); },
  });
}
