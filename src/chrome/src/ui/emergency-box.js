import { createApocalypseStore } from '../agent/apocalypse-mode.js';
import {
  createEmergencyCorpusStore,
  isEmergencyCorpusRecord,
} from '../agent/emergency-corpus.js';
import {
  EMERGENCY_CORPUS_PROVISIONAL_MEASUREMENTS,
  EMERGENCY_CORPUS_RELEASE,
} from '../agent/emergency-corpus-release.js';
import {
  EMERGENCY_BOX_COMMUNICATION_RESOURCES,
  EMERGENCY_BOX_HEALTH_RESOURCES,
  compareEmergencyBoxResources,
  createEmergencyBoxStore,
  estimateEmergencyBoxResourceBytes,
  loadOpenStaxCatalog,
  OPENSTAX_CATALOG_SNAPSHOT_DATE,
  PREFETCHED_OPENSTAX_CATALOG,
  selectEmergencyBoxBasicResources,
} from '../agent/emergency-box.js';
import {
  E5_MODEL_DOWNLOAD_BYTES,
} from '../agent/offline-reranker.js';
import { t } from './i18n.js';
import {
  CORPUS_DOWNLOAD_ID,
  EMERGENCY_DOWNLOAD_STATE_MESSAGE,
  SEMANTIC_DOWNLOAD_ID,
  sendEmergencyDownloadCommand,
} from './emergency-download-client.js';
import { createOfflineRagReadinessController } from './offline-rag-readiness.js';
import { THEME_MODES, applyMode, loadMode, watch } from './theme.js';

const runtimeApi = globalThis.browser || globalThis.chrome;
let currentThemeMode = 'system';
loadMode().then((mode) => {
  currentThemeMode = mode;
  applyMode(mode, { syncStorage: false });
});
watch(() => currentThemeMode);
runtimeApi?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !changes.themeMode) return;
  const next = changes.themeMode.newValue;
  if (THEME_MODES.includes(next)) currentThemeMode = next;
});

const apocalypseStore = createApocalypseStore();
const resourceStore = createEmergencyBoxStore();
const corpusStore = createEmergencyCorpusStore();
const elements = Object.fromEntries([
  'mode-status', 'resource-count', 'installed-rail-count', 'installed-count', 'installed-bytes',
  'category-nav', 'resource-search', 'load-openstax', 'download-basic', 'download-all', 'notice', 'resource-list',
  'offline-rag-readiness', 'rag-components',
].map(id => [id, document.getElementById(id)]));

const OPENSTAX_CACHE_KEY = 'webbrainEmergencyOpenStaxCatalog';
const EMERGENCY_COMPONENT_STATE_EVENT = 'wb-emergency-component-download-state';
const EMERGENCY_COMPONENT_STATE_CHANNEL = 'webbrain-emergency-download-state';
const EMERGENCY_READER_PAGES = new Set(['emergency-pdf.html', 'emergency-communication.html']);
const downloadStateChannel = typeof BroadcastChannel === 'function'
  ? new BroadcastChannel(EMERGENCY_COMPONENT_STATE_CHANNEL)
  : null;
let apocalypseEnabled = false;
let activeFilter = 'all';
let openStaxResources = cachedOpenStaxCatalog();
let records = new Map();
let corpusRecord = null;
let semanticState = {
  status: 'unknown', ready: false, loaded: 0, total: E5_MODEL_DOWNLOAD_BYTES, progress: 0, error: '',
};
let loadingOpenStax = false;
let bulkDownloading = false;
let bulkDownloadKind = '';
let stopBulkDownload = false;
const downloads = new Map();

async function localGenerationStatus() {
  try {
    const state = await runtimeApi.runtime.sendMessage({
      target: 'background',
      action: 'get_webgpu_download_status',
    });
    const transfer = ['starting', 'queued', 'downloading', 'paused', 'stopping'].includes(state?.activeTransfer?.status)
      ? state.activeTransfer
      : state;
    const status = String(transfer?.status || '');
    if (status === 'ready') return 'ready';
    if (status === 'error') return 'error';
    if (status === 'downloading' || status === 'paused') return status;
    if (status === 'stopping') return 'downloading';
    if (status) return 'model-missing';
  } catch { /* Firefox and builds without WebGPU leave generation on Apocalypse Mode. */ }
  return apocalypseEnabled ? 'separate' : 'unavailable';
}

const ragReadiness = elements['offline-rag-readiness']
  ? createOfflineRagReadinessController({
    root: elements['offline-rag-readiness'],
    apocalypseStore,
    corpusStore,
    semanticReranker: {
      async status() {
        return semanticState.status === 'unknown' ? 'model-missing' : semanticState.status;
      },
      close() {},
    },
    getGenerationStatus: localGenerationStatus,
  })
  : { async refresh() {}, render() {}, close() {} };

function trackDownload(id, options = {}) {
  downloads.set(id, { kind: options.bulkKind || '' });
}

function cachedOpenStaxCatalog() {
  try {
    const cached = JSON.parse(globalThis.localStorage?.getItem(OPENSTAX_CACHE_KEY) || 'null');
    if (Array.isArray(cached?.items) && cached.items.length) return cached.items;
  } catch { /* Use the bundled catalog snapshot. */ }
  return [...PREFETCHED_OPENSTAX_CATALOG];
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function formatBytes(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number < 1024) return `${number} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = number;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatEstimatedSize(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1_000_000_000) {
    const megabytes = bytes / 1_000_000;
    if (megabytes === 0) return '0 MB';
    return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
  }
  const gigabytes = bytes / 1_000_000_000;
  return `${gigabytes.toFixed(gigabytes >= 10 ? 1 : 2)} GB`;
}

function estimatedDownloadBytes(resources) {
  return resources.reduce((sum, resource) => sum + estimateEmergencyBoxResourceBytes(resource), 0);
}

function remainingOfTotal(resources, pending) {
  return t('eb.remaining_of_total', {
    remaining: formatEstimatedSize(estimatedDownloadBytes(pending)),
    total: formatEstimatedSize(estimatedDownloadBytes(resources)),
  });
}

function ragComponentNetworkBytes({ includeInstalled = false } = {}) {
  let bytes = 0;
  if (includeInstalled || semanticState.status !== 'ready') bytes += E5_MODEL_DOWNLOAD_BYTES;
  if (EMERGENCY_CORPUS_RELEASE && (includeInstalled || corpusUiStatus() !== 'ready')) {
    bytes += Number(EMERGENCY_CORPUS_RELEASE.downloadBytes) || 0;
  }
  return bytes;
}

function kitRemainingLabel(resources, pending) {
  const pendingComponentBytes = ragComponentNetworkBytes({ includeInstalled: false });
  const totalComponentBytes = ragComponentNetworkBytes({ includeInstalled: true });
  return t('eb.remaining_of_total', {
    remaining: formatEstimatedSize(estimatedDownloadBytes(pending) + pendingComponentBytes),
    total: formatEstimatedSize(estimatedDownloadBytes(resources) + totalComponentBytes),
  });
}

function setNotice(message = '', kind = '') {
  elements.notice.textContent = message;
  elements.notice.dataset.kind = kind;
}

function catalogResources() {
  const resources = new Map();
  for (const item of [...EMERGENCY_BOX_COMMUNICATION_RESOURCES, ...EMERGENCY_BOX_HEALTH_RESOURCES, ...openStaxResources]) {
    resources.set(item.id, item.builtIn ? {
      ...item,
      status: 'ready',
      bytesReceived: item.totalBytes,
    } : item);
  }
  for (const record of records.values()) {
    const catalogResource = resources.get(record.id);
    const merged = { ...(catalogResource || {}), ...record };
    if (catalogResource && record.status !== 'ready') {
      if (catalogResource.url) {
        merged.url = catalogResource.url;
        merged.sourceUrl = catalogResource.sourceUrl || catalogResource.url;
      }
      if (catalogResource.storageKey) merged.storageKey = catalogResource.storageKey;
      if (Number(catalogResource.totalBytes) > 0) merged.totalBytes = catalogResource.totalBytes;
    }
    resources.set(record.id, merged);
  }
  return [...resources.values()];
}

function filteredResources() {
  const query = elements['resource-search'].value.trim().toLocaleLowerCase();
  return catalogResources()
    .filter(resource => {
      if (activeFilter === 'installed') return resource.status === 'ready';
      return activeFilter === 'all' || resource.category === activeFilter;
    })
    .filter(resource => !query || [resource.title, resource.description, resource.publisher, resource.collection]
      .some(value => String(value || '').toLocaleLowerCase().includes(query)))
    .sort((left, right) => compareEmergencyBoxResources(left, right, {
      groupCategories: activeFilter === 'all',
    }));
}

function statusLabel(status) {
  if (!status) return '';
  const known = new Set(['downloading', 'paused', 'ready', 'error']);
  return known.has(status) ? t(`eb.status.${status}`) : status;
}

function resourceActions(resource) {
  const status = resource.status || '';
  const disabled = apocalypseEnabled ? '' : ` disabled title="${escapeHtml(t('eb.enable_downloads_tooltip'))}"`;
  if (status === 'ready') {
    if (resource.builtIn) {
      return `<button type="button" class="resource-action read" data-action="read" data-id="${escapeHtml(resource.id)}">${escapeHtml(t('eb.read'))}</button>`;
    }
    return `
      <button type="button" class="resource-action read" data-action="read" data-id="${escapeHtml(resource.id)}">${escapeHtml(t('eb.read'))}</button>
      <button type="button" class="resource-action danger" data-action="delete" data-id="${escapeHtml(resource.id)}">${escapeHtml(t('eb.delete'))}</button>`;
  }
  if (status === 'downloading') {
    return `<button type="button" class="resource-action" data-action="pause" data-id="${escapeHtml(resource.id)}">${escapeHtml(t('eb.pause'))}</button>`;
  }
  if (status === 'paused') {
    return `
      <button type="button" class="resource-action primary" data-action="download" data-id="${escapeHtml(resource.id)}"${disabled}>${escapeHtml(t('eb.resume'))}</button>
      <button type="button" class="resource-action danger" data-action="delete" data-id="${escapeHtml(resource.id)}">${escapeHtml(t('eb.delete'))}</button>`;
  }
  if (status === 'error') {
    return `
      <button type="button" class="resource-action primary" data-action="download" data-id="${escapeHtml(resource.id)}"${disabled}>${escapeHtml(t('eb.retry'))}</button>
      <button type="button" class="resource-action danger" data-action="delete" data-id="${escapeHtml(resource.id)}">${escapeHtml(t('eb.delete'))}</button>`;
  }
  return `<button type="button" class="resource-action primary" data-action="download" data-id="${escapeHtml(resource.id)}"${disabled}>${escapeHtml(t('eb.download'))}</button>`;
}

function renderResource(resource) {
  const status = resource.status || '';
  const received = Number(resource.bytesReceived) || 0;
  const total = Number(resource.totalBytes) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
  const sourceUrl = safeExternalUrl(resource.sourceUrl);
  const progress = status && status !== 'ready'
    ? `<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="progress-fill" style="width:${percent}%"></div></div>
       <div class="progress-detail">${escapeHtml(resource.error || `${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''}`)}</div>`
    : '';
  return `
    <article class="resource-card" data-category="${escapeHtml(resource.category)}" data-status="${escapeHtml(status)}">
      <span class="resource-glyph" aria-hidden="true">PDF</span>
      <div class="resource-copy">
        <div class="resource-title-row">
          <h3 class="resource-title" title="${escapeHtml(resource.title)}">${escapeHtml(resource.title)}</h3>
          ${status ? `<span class="status-label" data-status="${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>` : ''}
        </div>
        <p class="resource-description">${escapeHtml(resource.description || '')}</p>
        <div class="resource-meta">
          <span>${escapeHtml(resource.collection || '')}</span>
          <span>${escapeHtml(resource.publisher || '')}</span>
          ${resource.published ? `<span>${escapeHtml(resource.published)}</span>` : ''}
          ${resource.language ? `<span>${escapeHtml(resource.language)}</span>` : ''}
          ${resource.builtIn ? '<span>Built in</span>' : ''}
          ${status === 'ready' ? `<span>${escapeHtml(formatBytes(received || total))}</span>` : ''}
          ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('eb.source'))} ↗</a>` : ''}
        </div>
        ${progress}
      </div>
      <div class="resource-actions">${resourceActions(resource)}</div>
    </article>`;
}

function ragStatusLabel(status) {
  const key = `eb.rag.status.${String(status || 'unavailable')}`;
  const translated = t(key);
  return translated === key ? String(status || '') : translated;
}

function corpusUiStatus() {
  if (corpusRecord?.status === 'ready' && corpusRecord.active) return 'ready';
  if (corpusRecord?.status && corpusRecord.status !== 'not-installed') return corpusRecord.status;
  return EMERGENCY_CORPUS_RELEASE ? 'not-installed' : 'unavailable';
}

function publishComponentDownloadState(detail) {
  try {
    globalThis.dispatchEvent(new CustomEvent(EMERGENCY_COMPONENT_STATE_EVENT, { detail }));
  } catch { /* Another extension page can still observe the broadcast below. */ }
  try {
    downloadStateChannel?.postMessage(detail);
  } catch { /* The footer tracker is optional and must never interrupt a download. */ }
}

function publishComponentDownloadStates({
  corpusStatus, corpusReceived, corpusTotal, corpusDetail,
  semanticStatus, semanticReceived, semanticTotal, semanticDetail,
}) {
  publishComponentDownloadState({
    id: CORPUS_DOWNLOAD_ID,
    status: corpusStatus,
    loaded: corpusReceived,
    total: corpusTotal,
    progress: corpusTotal > 0 ? corpusReceived / corpusTotal : 0,
    updatedAt: Number(corpusRecord?.updatedAt) || Date.now(),
    detail: corpusDetail,
  });
  publishComponentDownloadState({
    id: SEMANTIC_DOWNLOAD_ID,
    status: semanticStatus,
    loaded: semanticReceived,
    total: semanticTotal,
    progress: Number(semanticState.progress) || (semanticTotal > 0 ? semanticReceived / semanticTotal : 0),
    updatedAt: Date.now(),
    detail: semanticDetail,
  });
}

function componentAction(component, action, label, options = {}) {
  const disabled = options.disabled ? ' disabled' : '';
  const danger = options.danger ? ' danger' : '';
  const primary = options.primary ? ' primary' : '';
  return `<button type="button" class="resource-action${danger}${primary}" data-rag-action="${escapeHtml(action)}" data-rag-component="${escapeHtml(component)}"${disabled}>${escapeHtml(label)}</button>`;
}

function corpusActions(status) {
  if (status === 'ready') return componentAction('corpus', 'delete', t('eb.delete'), { danger: true });
  if (['downloading', 'verifying', 'extracting', 'indexing'].includes(status)) {
    return componentAction('corpus', 'pause', t('eb.pause'));
  }
  if (status === 'downloaded') return componentAction('corpus', 'download', t('eb.rag.install'), { primary: true });
  if (status === 'paused' || status === 'error') {
    return [
      componentAction('corpus', 'download', t('eb.retry'), { primary: true, disabled: !apocalypseEnabled || !EMERGENCY_CORPUS_RELEASE }),
      componentAction('corpus', 'cancel', t('eb.rag.cancel_install'), { danger: true }),
    ].join('');
  }
  return componentAction('corpus', 'download', t('eb.download'), {
    primary: true,
    disabled: !apocalypseEnabled || !EMERGENCY_CORPUS_RELEASE,
  });
}

function semanticActions(status) {
  if (status === 'ready') return componentAction('semantic', 'delete', t('eb.delete'), { danger: true });
  if (status === 'downloading') return componentAction('semantic', 'pause', t('eb.pause'));
  if (status === 'paused' || status === 'error') {
    return [
      componentAction('semantic', 'download', t('eb.retry'), { primary: true, disabled: !apocalypseEnabled }),
      componentAction('semantic', 'delete', t('eb.rag.clear_partial'), { danger: true }),
    ].join('');
  }
  return componentAction('semantic', 'download', t('eb.download'), { primary: true, disabled: !apocalypseEnabled });
}

function componentProgress(status, received, total, detail = '') {
  if (!['downloading', 'verifying', 'extracting', 'indexing', 'paused', 'error'].includes(status)) return '';
  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
  return `<div class="rag-component-progress">
    <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="progress-fill" style="width:${percent}%"></div></div>
    <div class="progress-detail">${escapeHtml(detail || `${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''}`)}</div>
  </div>`;
}

function renderRagComponents() {
  const corpusStatus = corpusUiStatus();
  const corpusReceived = Number(corpusRecord?.staging?.bytesReceived) || 0;
  const corpusTotal = Number(corpusRecord?.staging?.totalBytes)
    || Number(EMERGENCY_CORPUS_RELEASE?.downloadBytes)
    || 0;
  const activeCorpusBytes = Number(corpusRecord?.active?.extractedBytes || 0)
    + Number(corpusRecord?.active?.indexBytes || 0);
  const provisional = EMERGENCY_CORPUS_PROVISIONAL_MEASUREMENTS;
  const corpusMeta = corpusStatus === 'ready'
    ? `${corpusRecord.active.documentCount} ${t('eb.rag.documents')} · ${formatBytes(activeCorpusBytes)}`
    : EMERGENCY_CORPUS_RELEASE
      ? `${formatBytes(EMERGENCY_CORPUS_RELEASE.downloadBytes)} ${t('eb.rag.network')}`
      : t('eb.rag.corpus_pending_meta', {
        count: provisional.sourceDocumentCount,
        size: formatBytes(provisional.sourceTextBytes),
      });
  const corpusDetail = corpusRecord?.error
    || (corpusStatus === 'extracting' ? t('eb.rag.extracting_detail') : '')
    || (corpusStatus === 'indexing' ? t('eb.rag.indexing_detail') : '');
  const corpusDescriptionKey = !EMERGENCY_CORPUS_RELEASE
    ? 'eb.rag.corpus_pending'
    : (EMERGENCY_CORPUS_RELEASE.preview ? 'eb.rag.corpus_preview' : 'eb.rag.corpus_description');

  const semanticStatus = semanticState.status === 'unknown' ? 'model-missing' : semanticState.status;
  const semanticReceived = Number(semanticState.loaded) || 0;
  const semanticTotal = Number(semanticState.total) || E5_MODEL_DOWNLOAD_BYTES;
  const semanticDetail = semanticState.error || semanticState.file || '';
  if (elements['rag-components']) {
    elements['rag-components'].innerHTML = `
    <article class="rag-component" data-status="${escapeHtml(corpusStatus)}">
      <div class="rag-component-copy">
        <h3 class="rag-component-title">${escapeHtml(t('eb.rag.corpus_title'))}<span class="status-label" data-status="${escapeHtml(corpusStatus)}">${escapeHtml(ragStatusLabel(corpusStatus))}</span></h3>
        <p>${escapeHtml(t(corpusDescriptionKey))}</p>
        <div class="rag-component-meta"><span>${escapeHtml(corpusMeta)}</span></div>
      </div>
      <div class="rag-component-actions">${corpusActions(corpusStatus)}</div>
      ${componentProgress(corpusStatus, corpusReceived, corpusTotal, corpusDetail)}
    </article>
    <article class="rag-component" data-status="${escapeHtml(semanticStatus)}">
      <div class="rag-component-copy">
        <h3 class="rag-component-title">${escapeHtml(t('eb.rag.semantic_title'))}<span class="status-label" data-status="${escapeHtml(semanticStatus)}">${escapeHtml(ragStatusLabel(semanticStatus))}</span></h3>
        <p>${escapeHtml(t('eb.rag.semantic_description'))}</p>
        <div class="rag-component-meta"><span>${escapeHtml(formatBytes(E5_MODEL_DOWNLOAD_BYTES))} ${escapeHtml(t('eb.rag.network'))}</span><span>CPU / WASM</span></div>
      </div>
      <div class="rag-component-actions">${semanticActions(semanticStatus)}</div>
      ${componentProgress(semanticStatus, semanticReceived, semanticTotal, semanticDetail)}
    </article>`;
  }
  publishComponentDownloadStates({
    corpusStatus, corpusReceived, corpusTotal, corpusDetail,
    semanticStatus, semanticReceived, semanticTotal, semanticDetail,
  });
}

function render() {
  const all = catalogResources();
  const installed = all.filter(resource => resource.status === 'ready');
  const installedBytes = installed.reduce((sum, record) => sum + (Number(record.bytesReceived) || Number(record.totalBytes) || 0), 0);
  elements['resource-count'].textContent = String(all.length);
  elements['installed-rail-count'].textContent = String(installed.length);
  elements['installed-count'].textContent = String(installed.length);
  elements['installed-bytes'].textContent = formatBytes(installedBytes);
  elements['mode-status'].textContent = t(apocalypseEnabled ? 'eb.mode_on' : 'eb.mode_off');
  elements['mode-status'].dataset.enabled = String(apocalypseEnabled);
  elements['load-openstax'].disabled = loadingOpenStax;
  renderRagComponents();

  const filtered = filteredResources();
  const downloadable = filtered.filter(resource => !resource.builtIn);
  const pending = downloadable.filter(resource => resource.status !== 'ready');
  const basicResources = selectEmergencyBoxBasicResources(all).filter(resource => !resource.builtIn);
  const basicPending = basicResources
    .filter(resource => resource.status !== 'ready');
  const ragPendingCount = Number(corpusUiStatus() !== 'ready' && !!EMERGENCY_CORPUS_RELEASE)
    + Number(semanticState.status !== 'ready');
  const pendingCount = pending.length + ragPendingCount;
  const basicPendingCount = basicPending.length + ragPendingCount;
  const basicActive = bulkDownloading && bulkDownloadKind === 'basic';
  const allActive = bulkDownloading && bulkDownloadKind === 'all';
  elements['download-basic'].disabled = bulkDownloading
    ? !basicActive
    : (!apocalypseEnabled || basicPendingCount === 0);
  elements['download-basic'].querySelector('[data-download-basic-label]').textContent = t(basicActive ? 'eb.stop_all' : 'eb.download_basic');
  elements['download-basic'].querySelector('[data-download-basic-size]').textContent = basicActive
    ? ''
    : kitRemainingLabel(basicResources, basicPending);
  elements['download-all'].disabled = bulkDownloading
    ? !allActive
    : (!apocalypseEnabled || pendingCount === 0);
  const currentView = activeFilter !== 'all' || elements['resource-search'].value.trim() !== '';
  elements['download-all'].querySelector('[data-download-all-label]').textContent = t(allActive
    ? 'eb.stop_all'
    : (currentView ? 'eb.download_current_view' : 'eb.download_all'));
  elements['download-all'].querySelector('[data-download-all-size]').textContent = allActive
    ? ''
    : kitRemainingLabel(downloadable, pending);

  elements['resource-list'].innerHTML = filtered.length
    ? filtered.map(renderResource).join('')
    : `<div class="empty-state"><span class="empty-glyph" aria-hidden="true">□</span>${escapeHtml(t('eb.no_resources'))}</div>`;
}

function applyCorpusRecord(record) {
  if (!isEmergencyCorpusRecord(record)) return false;
  corpusRecord = record;
  return true;
}

function applyHostSnapshot(snapshot) {
  if (snapshot?.corpus) applyCorpusRecord(snapshot.corpus);
  if (snapshot?.semantic) semanticState = snapshot.semantic;
  if (Array.isArray(snapshot?.resources)) {
    for (const record of snapshot.resources) records.set(record.id, record);
  }
}

async function refreshState() {
  apocalypseEnabled = (await apocalypseStore.getConfig()).enabled === true;
  const host = await sendEmergencyDownloadCommand('status').catch(() => null);
  if (host?.corpus) applyCorpusRecord(host.corpus);
  else corpusRecord = await corpusStore.get();
  if (host?.semantic) semanticState = host.semantic;
  records = new Map((await resourceStore.list()).map(record => [record.id, record]));
  if (!apocalypseEnabled && !elements.notice.textContent) setNotice(t('eb.enable_downloads'));
  await ragReadiness.refresh().catch(() => {});
  render();
}

async function waitForHost(isActive) {
  for (;;) {
    const snapshot = await sendEmergencyDownloadCommand('status');
    applyHostSnapshot(snapshot);
    render();
    if (!isActive(snapshot) || stopBulkDownload) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
}

async function loadOpenStax() {
  if (loadingOpenStax) return;
  loadingOpenStax = true;
  setNotice(t('eb.loading_openstax'));
  render();
  try {
    openStaxResources = await loadOpenStaxCatalog();
    try {
      globalThis.localStorage?.setItem(OPENSTAX_CACHE_KEY, JSON.stringify({ updatedAt: Date.now(), items: openStaxResources }));
    } catch { /* The live catalog still works for this page load. */ }
    setNotice(t('eb.openstax_updated', { count: openStaxResources.length }), 'success');
  } catch (error) {
    setNotice(error.message, 'error');
  } finally {
    loadingOpenStax = false;
    render();
  }
}

function resourceById(id) {
  return catalogResources().find(resource => resource.id === id);
}

async function startDownload(resource, options = {}) {
  if (!resource || !apocalypseEnabled) return;
  if (downloads.has(resource.id) && options.resume !== true) return;
  if (options.confirm !== false) {
    const confirmed = globalThis.confirm(t('eb.confirm_download', {
      title: resource.title,
      publisher: resource.publisher || t('eb.unknown_publisher'),
    }));
    if (!confirmed) return;
  }
  trackDownload(resource.id, options);
  if (options.quiet !== true) setNotice(t('eb.keep_open'));
  try {
    await sendEmergencyDownloadCommand('start_resource', { resource: { ...resource } });
    const snapshot = await waitForHost(state => (
      state.active?.resources?.includes(resource.id)
      || ['downloading', 'queued'].includes(records.get(resource.id)?.status)
    ));
    const record = records.get(resource.id) || snapshot.resources?.find(item => item.id === resource.id);
    if (record?.status === 'ready' && options.quiet !== true) {
      setNotice(t('eb.download_complete', { title: record.title }), 'success');
    }
  } catch (error) {
    if (options.quiet !== true) setNotice(error.message, 'error');
  } finally {
    downloads.delete(resource.id);
    await refreshState();
  }
}

async function startCorpusDownload(options = {}) {
  if (!apocalypseEnabled || !EMERGENCY_CORPUS_RELEASE) {
    setNotice(t('eb.rag.corpus_pending'), 'error');
    return null;
  }
  if (downloads.has(CORPUS_DOWNLOAD_ID) && options.resume !== true) return corpusRecord;
  if (options.confirm !== false) {
    const installedEstimate = Number(EMERGENCY_CORPUS_RELEASE.installedTextBytes || 0)
      + Number(EMERGENCY_CORPUS_RELEASE.installedIndexBytes
        || Math.round(Number(EMERGENCY_CORPUS_RELEASE.installedTextBytes || 0) * 0.65));
    const confirmKey = EMERGENCY_CORPUS_RELEASE.preview
      ? 'eb.rag.confirm_corpus_preview'
      : 'eb.rag.confirm_corpus';
    if (!globalThis.confirm(t(confirmKey, {
      network: formatBytes(EMERGENCY_CORPUS_RELEASE.downloadBytes),
      installed: formatBytes(installedEstimate),
    }))) return null;
  }
  trackDownload(CORPUS_DOWNLOAD_ID, options);
  try {
    await sendEmergencyDownloadCommand('start_corpus');
    await waitForHost(state => (
      state.active?.corpus
      || ['downloading', 'verifying', 'downloaded', 'extracting', 'indexing'].includes(state.corpus?.status)
    ));
    if (corpusRecord?.status === 'ready' && options.quiet !== true) {
      setNotice(t(EMERGENCY_CORPUS_RELEASE.preview ? 'eb.rag.corpus_preview_ready' : 'eb.rag.corpus_ready'), 'success');
    }
    return corpusRecord;
  } catch (error) {
    if (options.quiet !== true) setNotice(error.message, 'error');
    return null;
  } finally {
    downloads.delete(CORPUS_DOWNLOAD_ID);
    await refreshState();
  }
}

async function startSemanticDownload(options = {}) {
  if (!apocalypseEnabled) return null;
  if (downloads.has(SEMANTIC_DOWNLOAD_ID) && options.resume !== true) return semanticState;
  if (semanticState.status === 'ready') return semanticState;
  if (options.confirm !== false && !globalThis.confirm(t('eb.rag.confirm_semantic', {
    network: formatBytes(E5_MODEL_DOWNLOAD_BYTES),
    installed: formatBytes(E5_MODEL_DOWNLOAD_BYTES),
  }))) return null;
  trackDownload(SEMANTIC_DOWNLOAD_ID, options);
  try {
    await sendEmergencyDownloadCommand('start_semantic');
    await waitForHost(state => state.active?.semantic || state.semantic?.status === 'downloading');
    if (semanticState.status === 'ready' && options.quiet !== true) {
      setNotice(t('eb.rag.semantic_ready'), 'success');
    }
    return semanticState;
  } catch (error) {
    if (options.quiet !== true) setNotice(error.message, 'error');
    return null;
  } finally {
    downloads.delete(SEMANTIC_DOWNLOAD_ID);
    await refreshState();
  }
}

async function removeCorpusComponent({ cancelOnly = false } = {}) {
  const snapshot = await sendEmergencyDownloadCommand(cancelOnly ? 'cancel_corpus' : 'delete_corpus');
  applyHostSnapshot(snapshot);
  if (!cancelOnly) corpusRecord = snapshot.corpus || null;
  render();
}

async function removeSemanticComponent() {
  const snapshot = await sendEmergencyDownloadCommand('stop_semantic');
  applyHostSnapshot(snapshot);
  render();
}

async function stopAndDeleteDownload(id) {
  await sendEmergencyDownloadCommand('stop_resource', { id });
  records.delete(id);
  setNotice(t('eb.deleted'), 'success');
  await refreshState();
}

async function handleDownloadControl(detail = {}) {
  const id = String(detail.id || '');
  const action = String(detail.action || '');
  if (id === CORPUS_DOWNLOAD_ID) {
    if (action === 'pause') await sendEmergencyDownloadCommand('pause_corpus');
    if (action === 'resume') await startCorpusDownload({ confirm: false, resume: true });
    if (action === 'stop') await removeCorpusComponent({ cancelOnly: true });
    await refreshState();
    return;
  }
  if (id === SEMANTIC_DOWNLOAD_ID) {
    if (action === 'pause') await sendEmergencyDownloadCommand('pause_semantic');
    if (action === 'resume') await startSemanticDownload({ confirm: false, resume: true });
    if (action === 'stop') await removeSemanticComponent();
    await refreshState();
    return;
  }
  const resource = resourceById(id);
  if (!id || !resource) return;
  if (action === 'pause') await sendEmergencyDownloadCommand('pause_resource', { id });
  if (action === 'resume') await startDownload(resource, { confirm: false, resume: true });
  if (action === 'stop') await stopAndDeleteDownload(id);
  await refreshState();
}

async function downloadResources(resources, kind) {
  if (bulkDownloading) {
    if (bulkDownloadKind === kind) {
      stopBulkDownload = true;
      for (const [id, entry] of downloads) {
        if (entry.kind !== kind) continue;
        if (id === CORPUS_DOWNLOAD_ID) void sendEmergencyDownloadCommand('pause_corpus').catch(() => {});
        else if (id === SEMANTIC_DOWNLOAD_ID) void sendEmergencyDownloadCommand('pause_semantic').catch(() => {});
        else void sendEmergencyDownloadCommand('pause_resource', { id }).catch(() => {});
      }
    }
    return;
  }
  if (!apocalypseEnabled) return;
  const pending = resources.filter(resource => resource.status !== 'ready');
  const corpusNeedsDownload = corpusUiStatus() !== 'ready' && !!EMERGENCY_CORPUS_RELEASE;
  const semanticNeedsDownload = semanticState.status !== 'ready';
  if (!pending.length && !corpusNeedsDownload && !semanticNeedsDownload) return;
  const componentCount = Number(corpusNeedsDownload) + Number(semanticNeedsDownload);
  const networkBytes = estimatedDownloadBytes(pending)
    + (corpusNeedsDownload ? Number(EMERGENCY_CORPUS_RELEASE.downloadBytes) || 0 : 0)
    + (semanticNeedsDownload ? E5_MODEL_DOWNLOAD_BYTES : 0);
  const corpusInstalledEstimate = corpusNeedsDownload
    ? Number(EMERGENCY_CORPUS_RELEASE.installedTextBytes || 0)
      + Number(EMERGENCY_CORPUS_RELEASE.installedIndexBytes
        || Math.round(Number(EMERGENCY_CORPUS_RELEASE.installedTextBytes || 0) * 0.65))
    : 0;
  const installedBytes = estimatedDownloadBytes(pending)
    + corpusInstalledEstimate
    + (semanticNeedsDownload ? E5_MODEL_DOWNLOAD_BYTES : 0);
  if (!globalThis.confirm(t('eb.rag.confirm_kit', {
    kit: t(kind === 'basic' ? 'eb.download_basic' : 'eb.download_all'),
    count: pending.length + componentCount,
    network: formatBytes(networkBytes),
    installed: formatBytes(installedBytes),
  }))) return;
  bulkDownloading = true;
  bulkDownloadKind = kind;
  stopBulkDownload = false;
  render();
  let completed = 0;
  if (corpusNeedsDownload && !stopBulkDownload) {
    setNotice(t('eb.rag.downloading_corpus'));
    await startCorpusDownload({ confirm: false, quiet: true, bulkKind: kind });
    if (corpusRecord?.status === 'ready') completed += 1;
  }
  if (semanticNeedsDownload && !stopBulkDownload) {
    setNotice(t('eb.rag.downloading_semantic'));
    await startSemanticDownload({ confirm: false, quiet: true, bulkKind: kind });
    if (semanticState.status === 'ready') completed += 1;
  }
  for (const resource of pending) {
    if (stopBulkDownload) break;
    setNotice(t('eb.downloading_all', {
      current: completed + 1,
      count: pending.length + componentCount,
      title: resource.title,
    }));
    await startDownload(resource, { confirm: false, quiet: true, bulkKind: kind });
    if (records.get(resource.id)?.status === 'ready') completed += 1;
  }
  const stopped = stopBulkDownload;
  bulkDownloading = false;
  bulkDownloadKind = '';
  stopBulkDownload = false;
  const stoppedKey = kind === 'basic' ? 'eb.download_basic_stopped' : 'eb.download_all_stopped';
  setNotice(t(stopped ? stoppedKey : 'eb.download_all_complete', { count: completed }), stopped ? '' : 'success');
  render();
}

async function downloadBasicKit() {
  return downloadResources(selectEmergencyBoxBasicResources(catalogResources()), 'basic');
}

async function downloadAllVisible() {
  return downloadResources(filteredResources(), 'all');
}

function openReader(resource) {
  const requestedReader = String(resource?.reader || 'emergency-pdf.html');
  const reader = EMERGENCY_READER_PAGES.has(requestedReader) ? requestedReader : 'emergency-pdf.html';
  const params = reader === 'emergency-pdf.html' ? `?id=${encodeURIComponent(resource?.id || '')}` : '';
  const url = runtimeApi.runtime.getURL(`src/ui/${reader}${params}`);
  const createData = { url, type: 'popup', width: 1120, height: 820 };
  try {
    if (globalThis.browser?.windows?.create) {
      globalThis.browser.windows.create(createData).catch(() => globalThis.open(url, '_blank'));
    } else if (globalThis.chrome?.windows?.create) {
      globalThis.chrome.windows.create(createData, () => {
        if (globalThis.chrome.runtime.lastError) globalThis.open(url, '_blank');
      });
    } else {
      globalThis.open(url, '_blank');
    }
  } catch {
    globalThis.open(url, '_blank');
  }
}

elements['category-nav'].addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  activeFilter = button.dataset.filter;
  elements['category-nav'].querySelectorAll('[data-filter]').forEach(candidate => {
    candidate.classList.toggle('active', candidate === button);
  });
  render();
});

elements['resource-search'].addEventListener('input', render);
elements['load-openstax'].addEventListener('click', loadOpenStax);
elements['download-basic'].addEventListener('click', downloadBasicKit);
elements['download-all'].addEventListener('click', downloadAllVisible);
elements['resource-list'].addEventListener('click', async event => {
  const button = event.target.closest('[data-action][data-id]');
  if (!button) return;
  const { action, id } = button.dataset;
  const resource = resourceById(id);
  if (action === 'download') await startDownload(resource, {
    resume: ['paused', 'error'].includes(resource?.status),
  });
  if (action === 'pause') await sendEmergencyDownloadCommand('pause_resource', { id });
  if (action === 'read') openReader(resource);
  if (action === 'delete') {
    const config = await apocalypseStore.getConfig().catch(() => null);
    if (config?.enabled === true && resource?.status === 'ready') {
      setNotice(t('eb.cannot_delete_while_enabled'), 'error');
      return;
    }
    if (globalThis.confirm(t('eb.confirm_delete', { title: resource?.title || id }))) {
      try {
        await stopAndDeleteDownload(id);
      } catch (error) {
        setNotice(error.message, 'error');
      }
    }
  }
});
elements['rag-components']?.addEventListener('click', async event => {
  const button = event.target.closest('[data-rag-action][data-rag-component]');
  if (!button) return;
  const { ragAction: action, ragComponent: component } = button.dataset;
  try {
    if (component === 'corpus') {
      if (action === 'download') await startCorpusDownload({
        confirm: corpusUiStatus() === 'not-installed',
        resume: ['paused', 'error', 'downloaded'].includes(corpusUiStatus()),
      });
      if (action === 'pause') await sendEmergencyDownloadCommand('pause_corpus');
      if (action === 'cancel') await removeCorpusComponent({ cancelOnly: true });
      if (action === 'delete') {
        const config = await apocalypseStore.getConfig().catch(() => null);
        if (config?.enabled === true) {
          setNotice(t('eb.cannot_delete_while_enabled'), 'error');
          return;
        }
        if (globalThis.confirm(t('eb.rag.confirm_delete_corpus'))) {
          await removeCorpusComponent();
        }
      }
    }
    if (component === 'semantic') {
      if (action === 'download') await startSemanticDownload({
        resume: ['paused', 'error'].includes(semanticState.status),
      });
      if (action === 'pause') await sendEmergencyDownloadCommand('pause_semantic');
      if (action === 'delete') {
        const config = await apocalypseStore.getConfig().catch(() => null);
        if (config?.enabled === true) {
          setNotice(t('eb.cannot_delete_while_enabled'), 'error');
          return;
        }
        if (globalThis.confirm(t('eb.rag.confirm_delete_semantic'))) {
          await removeSemanticComponent();
        }
      }
    }
  } catch (error) {
    setNotice(error.message, 'error');
  }
});

globalThis.addEventListener('wb-emergency-download-control', event => {
  void handleDownloadControl(event.detail).catch(error => setNotice(error.message, 'error'));
});
downloadStateChannel?.addEventListener('message', event => {
  if (event.data?.type === 'request') renderRagComponents();
});
runtimeApi?.runtime?.onMessage?.addListener?.((message) => {
  if (message?.type !== EMERGENCY_DOWNLOAD_STATE_MESSAGE) return false;
  const previousCorpus = corpusRecord?.status;
  const previousSemantic = semanticState?.status;
  if (message.corpus) applyCorpusRecord(message.corpus);
  if (message.semantic) semanticState = message.semantic;
  if (message.resource?.id && message.resource.status !== 'deleted') {
    records.set(message.resource.id, message.resource);
  }
  if (message.resource?.status === 'deleted') records.delete(message.resource.id);
  render();
  if (corpusRecord?.status !== previousCorpus || semanticState?.status !== previousSemantic) {
    void ragReadiness.refresh();
  }
  return false;
});

globalThis.addEventListener('beforeunload', () => {
  stopBulkDownload = true;
  ragReadiness.close();
  downloadStateChannel?.close();
});
globalThis.addEventListener('focus', () => refreshState().catch(error => setNotice(error.message, 'error')));
document.addEventListener('wb-locale-changed', () => {
  ragReadiness.render();
  render();
});

refreshState().then(async () => {
  if (!elements.notice.textContent) {
    setNotice(t('eb.openstax_prefetched', { count: openStaxResources.length, date: OPENSTAX_CATALOG_SNAPSHOT_DATE }));
  }
  const params = new URLSearchParams(globalThis.location.search);
  const resumeComponent = params.get('resumeComponent');
  if (resumeComponent) {
    globalThis.history.replaceState({}, '', globalThis.location.pathname);
    if (resumeComponent === CORPUS_DOWNLOAD_ID) await startCorpusDownload({ confirm: false, resume: true });
    if (resumeComponent === SEMANTIC_DOWNLOAD_ID) await startSemanticDownload({ confirm: false, resume: true });
    return;
  }
  if (apocalypseEnabled) {
    if (!downloads.has(CORPUS_DOWNLOAD_ID) && corpusRecord?.status !== 'ready' && corpusRecord?.status !== 'downloading' && corpusRecord?.status !== 'verifying' && corpusRecord?.status !== 'extracting' && corpusRecord?.status !== 'indexing' && EMERGENCY_CORPUS_RELEASE) {
      void startCorpusDownload({ confirm: false, quiet: true });
    }
    if (!downloads.has(SEMANTIC_DOWNLOAD_ID) && semanticState?.status !== 'ready' && semanticState?.status !== 'downloading') {
      void startSemanticDownload({ confirm: false, quiet: true });
    }
  }
  const resumeId = params.get('resume');
  if (!resumeId) return;
  globalThis.history.replaceState({}, '', globalThis.location.pathname);
  const resource = resourceById(resumeId);
  if (resource && ['paused', 'error'].includes(resource.status)) {
    await startDownload(resource, { confirm: false, resume: true });
  }
}).catch(error => setNotice(error.message, 'error'));
