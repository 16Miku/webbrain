import { assertWikipediaZimArchive, createApocalypseArchiveManager, createApocalypseStore, createOpfsArchiveStorage, importKiwixArchive, normalizeStorageEstimate, openKiwixZim, registerKiwixArchiveHandle, selectKiwixUpdate } from '../agent/apocalypse-mode.js';
import {
  WEBGPU_DTYPE,
  WEBGPU_MODEL_ID,
} from '../providers/webgpu.js';
import { t } from './i18n.js';

const WIKIPEDIA_LANGUAGES = Object.freeze([
  ['eng', 'English'], ['zho', '中文'], ['ara', 'العربية'], ['ben', 'বাংলা'], ['nld', 'Nederlands'],
  ['tgl', 'Filipino'], ['fra', 'Français'], ['deu', 'Deutsch'], ['heb', 'עברית'], ['hin', 'हिन्दी'],
  ['ind', 'Bahasa Indonesia'], ['jpn', '日本語'], ['kor', '한국어'], ['msa', 'Bahasa Melayu'], ['fas', 'فارسی'],
  ['pol', 'Polski'], ['por', 'Português'], ['rus', 'Русский'], ['spa', 'Español'], ['tha', 'ไทย'],
  ['tur', 'Türkçe'], ['ukr', 'Українська'], ['vie', 'Tiếng Việt'],
]);

const runtimeApi = globalThis.browser || globalThis.chrome;
const WEBGPU_VISION_DOWNLOAD_STATE_KEY = 'webgpuVisionDownloadState';
const SUPPORTED_CATALOG_TIERS = new Set(['text', 'full']);
const supportsWebgpuVision = typeof globalThis.chrome?.offscreen?.createDocument === 'function';
const store = createApocalypseStore();
const storage = createOpfsArchiveStorage();
const elements = Object.fromEntries([
  'enabled', 'installed-count', 'archive-bytes', 'storage-usage', 'installed', 'language',
  'storage-target', 'external-storage-option', 'load-catalog', 'catalog-status', 'catalog', 'import-file', 'import-language', 'import-button', 'cancel-import', 'notice',
  'update-policy', 'vision-model-card', 'vision-model-status', 'vision-model-progress',
  'webgpu-provider-card', 'vision-model-test', 'vision-model-test-result',
].map(id => [id, document.getElementById(id)]));
for (const select of [elements.language, elements['import-language']]) {
  for (const [value, label] of WIKIPEDIA_LANGUAGES) select.add(new Option(label, value));
}
elements['vision-model-card'].hidden = !supportsWebgpuVision;
elements['webgpu-provider-card'].hidden = !supportsWebgpuVision;
let snapshot = null;
let catalogItems = [];
let catalogLoading = false;
let catalogRequest = 0;
let installReviewInFlight = false;
let importController = null;
let polling = false;
let processingDownload = false;
let visionDownloadState = null;
let fixedWebgpuProviderConfigured = false;
let fixedWebgpuProviderMarkedReady = false;
let visionTestRunning = false;
let webgpuDownloadStatusRequest = 0;
let webgpuDownloadState = {
  status: 'checking',
  ready: false,
  modelId: WEBGPU_MODEL_ID,
  dtype: WEBGPU_DTYPE,
  file: '',
  loaded: 0,
  total: 0,
  progress: 0,
  error: '',
};
const fileHandles = new Map();
const pageManager = createApocalypseArchiveManager({
  store,
  storage,
  schedule: () => command('process').catch(() => {}),
});
if (typeof globalThis.showSaveFilePicker === 'function') elements['external-storage-option'].hidden = false;

function bytes(value) {
  const number = Number(value) || 0;
  if (number < 1024) return `${number} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = number;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function notice(message, kind = '') {
  elements.notice.textContent = message || '';
  elements.notice.dataset.kind = kind;
}

function setCatalogStatus(message, kind = '') {
  elements['catalog-status'].textContent = message || '';
  elements['catalog-status'].dataset.kind = kind;
}

function setCatalogEmpty(message) {
  elements.catalog.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

function syncCatalogAvailability() {
  const enabled = snapshot?.enabled === true;
  elements['load-catalog'].disabled = !enabled || catalogLoading;
  if (enabled) return;
  catalogRequest += 1;
  catalogLoading = false;
  catalogItems = [];
  elements.catalog.setAttribute('aria-busy', 'false');
  setCatalogStatus(t('ap.catalog.enable'));
  setCatalogEmpty(t('ap.catalog.enable'));
}

async function authorizeFileHandle(handle, mode) {
  if (!handle) throw new Error(t('ap.file_permission_required'));
  if (typeof handle.queryPermission !== 'function') return;
  let permission;
  try {
    permission = await handle.queryPermission({ mode });
    if (permission !== 'granted' && typeof handle.requestPermission === 'function') {
      permission = await handle.requestPermission({ mode });
    }
  } catch {
    throw new Error(t('ap.file_permission_required'));
  }
  if (permission !== 'granted') throw new Error(t('ap.file_permission_required'));
}

async function command(command, payload = {}) {
  const response = await runtimeApi.runtime.sendMessage({ target: 'background', action: 'apocalypse_mode', command, ...payload });
  if (response?.error) throw new Error(response.error);
  return response;
}

async function providerCommand(action, payload = {}) {
  const response = await runtimeApi.runtime.sendMessage({ target: 'background', action, ...payload });
  if (response?.error) throw new Error(response.error);
  return response;
}

function normalizeWebgpuDownloadState(state = {}) {
  const allowedStatuses = new Set(['checking', 'not-downloaded', 'downloading', 'paused', 'stopping', 'ready', 'error']);
  const status = allowedStatuses.has(state.status) ? state.status : 'not-downloaded';
  const loaded = Math.max(0, Number(state.loaded) || 0);
  const total = Math.max(0, Number(state.total) || 0);
  const progress = status === 'ready'
    ? 100
    : Math.max(0, Math.min(100, Number(state.progress) || (total > 0 ? loaded / total * 100 : 0)));
  return {
    status,
    ready: state.ready === true || status === 'ready',
    modelId: String(state.modelId || ''),
    dtype: state.dtype && typeof state.dtype === 'object' ? state.dtype : String(state.dtype || WEBGPU_DTYPE),
    file: String(state.file || ''),
    loaded,
    total,
    progress,
    error: String(state.error || ''),
  };
}

function formatWebgpuBytes(bytesDownloaded) {
  const value = Math.max(0, Number(bytesDownloaded) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index++;
  }
  return `${amount >= 100 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[index]}`;
}

function webgpuDownloadStatusText(state = webgpuDownloadState) {
  const progress = Math.round(state.progress);
  switch (state.status) {
    case 'checking': return t('st.providers.webgpu_download.checking');
    case 'downloading': return t('st.providers.webgpu_download.downloading', { progress });
    case 'paused': return t('st.providers.webgpu_download.paused', { progress });
    case 'stopping': return t('st.providers.webgpu_download.stopping');
    case 'ready': return t('st.providers.webgpu_download.ready');
    case 'error': return t('st.providers.webgpu_download.error');
    default: return t('st.providers.webgpu_download.not_downloaded');
  }
}

function webgpuDownloadDetailText(state = webgpuDownloadState) {
  if (state.status === 'error') return state.error || t('st.providers.webgpu_download.error_detail');
  if (state.status === 'ready') return t('st.providers.webgpu_download.ready_detail');
  const file = state.file.split('/').pop() || '';
  if (state.total > 0) {
    const byteProgress = `${formatWebgpuBytes(state.loaded)} / ${formatWebgpuBytes(state.total)}`;
    return file ? `${file} · ${byteProgress}` : byteProgress;
  }
  if (file) return file;
  if (state.status === 'paused') return t('st.providers.webgpu_download.paused_detail');
  if (state.status === 'downloading') return t('st.providers.webgpu_download.preparing');
  return t('st.providers.webgpu_download.required');
}

function updateWebgpuDownloadPanel() {
  const panel = document.querySelector('[data-webgpu-download-panel]');
  if (!panel) return;
  const state = webgpuDownloadState;
  const progress = Math.round(state.progress);
  panel.dataset.state = state.status;
  panel.dataset.indeterminate = String(state.status === 'downloading' && state.total <= 0);
  panel.querySelector('[data-webgpu-download-status]').textContent = webgpuDownloadStatusText(state);
  panel.querySelector('[data-webgpu-download-detail]').textContent = webgpuDownloadDetailText(state);
  panel.querySelector('[data-webgpu-download-fill]').style.width = `${progress}%`;
  const track = panel.querySelector('[data-webgpu-download-track]');
  track.setAttribute('aria-label', t('st.providers.webgpu_download.progress_label'));
  track.setAttribute('aria-valuenow', String(progress));
  track.setAttribute('aria-valuetext', webgpuDownloadStatusText(state));
  const actions = Object.fromEntries(['start', 'pause', 'resume', 'stop'].map(action => [
    action,
    panel.querySelector(`[data-webgpu-download-action="${action}"]`),
  ]));
  actions.start.hidden = !['not-downloaded', 'error'].includes(state.status);
  actions.pause.hidden = state.status !== 'downloading';
  actions.resume.hidden = state.status !== 'paused';
  actions.stop.hidden = !['downloading', 'paused', 'stopping', 'ready', 'error'].includes(state.status);
  for (const button of Object.values(actions)) {
    button.disabled = ['checking', 'stopping'].includes(state.status);
  }
}

function setWebgpuDownloadState(state) {
  const normalized = normalizeWebgpuDownloadState(state);
  if (normalized.modelId && normalized.modelId !== WEBGPU_MODEL_ID) return;
  webgpuDownloadState = normalized;
  updateWebgpuDownloadPanel();
}

async function ensureFixedWebgpuProvider({ markConfigured = false } = {}) {
  if (fixedWebgpuProviderConfigured && (!markConfigured || fixedWebgpuProviderMarkedReady)) return;
  await providerCommand('update_provider', {
    providerId: 'webgpu',
    config: {
      model: WEBGPU_MODEL_ID,
      dtype: WEBGPU_DTYPE,
      contextWindow: 16384,
      promptTier: 'compact',
    },
    markConfigured,
  });
  fixedWebgpuProviderConfigured = true;
  if (markConfigured) fixedWebgpuProviderMarkedReady = true;
}

async function refreshWebgpuDownloadStatus() {
  if (!supportsWebgpuVision) return;
  const requestId = ++webgpuDownloadStatusRequest;
  try {
    await ensureFixedWebgpuProvider();
    const state = await providerCommand('get_webgpu_download_status');
    if (requestId !== webgpuDownloadStatusRequest) return;
    setWebgpuDownloadState(state);
    if (state?.ready === true) await ensureFixedWebgpuProvider({ markConfigured: true });
  } catch (error) {
    if (requestId === webgpuDownloadStatusRequest) setWebgpuDownloadState({ status: 'error', error: error.message });
  }
}

async function runWebgpuDownloadAction(action) {
  const actionMap = {
    start: 'start_webgpu_download',
    resume: 'start_webgpu_download',
    pause: 'pause_webgpu_download',
    stop: 'stop_webgpu_download',
  };
  const backgroundAction = actionMap[action];
  if (!backgroundAction) return;
  try {
    if (action === 'start' || action === 'resume') {
      await ensureFixedWebgpuProvider({ markConfigured: true });
    }
    if (action === 'start' || action === 'resume') {
      setWebgpuDownloadState({ ...webgpuDownloadState, status: 'downloading', error: '' });
    } else if (action === 'pause') {
      setWebgpuDownloadState({ ...webgpuDownloadState, status: 'paused', error: '' });
    } else {
      setWebgpuDownloadState({ ...webgpuDownloadState, status: 'stopping', error: '' });
    }
    setWebgpuDownloadState(await providerCommand(backgroundAction));
  } catch (error) {
    setWebgpuDownloadState({ ...webgpuDownloadState, status: 'error', ready: false, error: error.message });
  }
}

function setModelTestResult(element, message = '', kind = '') {
  element.textContent = message;
  element.dataset.kind = kind;
}

async function testWebgpuVisionModel() {
  if (visionDownloadState?.status !== 'ready' || visionTestRunning) return;
  visionTestRunning = true;
  renderVisionDownload();
  setModelTestResult(elements['vision-model-test-result'], t('st.vision.testing'));
  try {
    const result = await providerCommand('test_vision_provider');
    if (result?.ok) {
      setModelTestResult(
        elements['vision-model-test-result'],
        t('st.vision.connected', { model: result.model || 'LFM2.5-VL' }),
        'success',
      );
    } else {
      setModelTestResult(
        elements['vision-model-test-result'],
        t('st.vision.failed', { error: result?.error || 'Unknown error' }),
        'error',
      );
    }
  } catch (error) {
    setModelTestResult(elements['vision-model-test-result'], t('st.vision.failed', { error: error.message }), 'error');
  } finally {
    visionTestRunning = false;
    renderVisionDownload();
  }
}

function archiveButtons(record) {
  if (record.errorKind === 'file-permission-required') {
    return `<button data-action="reauthorize" data-id="${escapeHtml(record.id)}">${escapeHtml(t('ap.reauthorize'))}</button>`;
  }
  if (record.status === 'downloading' || record.status === 'queued' || record.status === 'retrying') {
    return `<button data-action="pause" data-id="${escapeHtml(record.id)}">${escapeHtml(t('ap.pause'))}</button>`;
  }
  if (record.status === 'paused') return `<button data-action="resume" data-id="${escapeHtml(record.id)}">${escapeHtml(t('ap.resume'))}</button>`;
  if (record.status === 'error' && record.downloadUrl && record.errorKind !== 'archive-unreadable') return `<button data-action="retry" data-id="${escapeHtml(record.id)}">${escapeHtml(t('ap.retry'))}</button>`;
  if (record.status === 'ready') {
    const update = record.downloadUrl
      ? `<button data-action="update" data-id="${escapeHtml(record.id)}">${escapeHtml(t(record.updateAvailable ? 'ap.review_update' : 'ap.check_update'))}</button>`
      : '';
    return `<button class="primary" data-action="read" data-id="${escapeHtml(record.id)}">${escapeHtml(t('ap.reader.open'))}</button>${update}`;
  }
  return '';
}

function renderInstalled() {
  const records = snapshot?.archives || [];
  elements['installed-count'].textContent = String(snapshot?.installedCount || 0);
  elements['archive-bytes'].textContent = bytes(snapshot?.totalBytes);
  const usage = snapshot?.storage?.usage;
  const quota = snapshot?.storage?.quota;
  elements['storage-usage'].textContent = quota == null ? t('ap.unavailable') : `${bytes(usage)} / ${bytes(quota)}`;
  if (!records.length) {
    elements.installed.innerHTML = `<div class="empty">${escapeHtml(t('ap.no_archives'))}</div>`;
    return;
  }
  elements.installed.innerHTML = records.map(record => {
    const progress = record.size ? Math.min(100, Math.round((Number(record.bytesDownloaded) || 0) / Number(record.size) * 100)) : 0;
    const error = record.errorKind === 'file-permission-required' ? t('ap.file_permission_required') : record.error;
    return `<article class="item"><div><h3>${escapeHtml(record.title || record.filename)}</h3>
      <div class="meta">${escapeHtml(record.language)} · ${escapeHtml(record.archiveDate || t('ap.date_unknown'))} · ${bytes(record.size)} · ${escapeHtml(t(`ap.status.${record.status}`))}</div>
      ${error ? `<div class="meta" style="color:var(--bad)">${escapeHtml(error)}</div>` : ''}
      ${record.status === 'ready' ? '' : `<progress max="100" value="${progress}"></progress>`}</div>
      <div class="actions">${archiveButtons(record)}<button class="danger" data-action="delete" data-id="${escapeHtml(record.id)}">${escapeHtml(t('ap.delete'))}</button></div></article>`;
  }).join('');
}

function renderCatalog() {
  const items = catalogItems;
  if (!items.length) {
    setCatalogEmpty(t(catalogLoading ? 'ap.loading_catalog' : 'ap.no_match'));
    return;
  }
  elements.catalog.innerHTML = items.map((item, index) => `<article class="item"><div><h3>${escapeHtml(item.title)}</h3>
    <div class="meta">${escapeHtml(item.language)} · ${escapeHtml(item.archiveDate)} · ${escapeHtml(t(`ap.tier.${item.tier}`))} · ${Number(item.articleCount || 0).toLocaleString()}</div>
    <div class="meta">${escapeHtml(t('ap.catalog.size_pending'))}</div></div>
    <div class="actions"><button class="primary" data-install="${index}">${escapeHtml(t('ap.review_install'))}</button></div></article>`).join('');
  const visible = items;
  elements.catalog.querySelectorAll('[data-install]').forEach((button) => {
    button.disabled = installReviewInFlight;
    button.addEventListener('click', () => reviewInstall(visible[Number(button.dataset.install)], button));
  });
}

function openWikipediaReader(id) {
  const url = runtimeApi.runtime.getURL(`src/ui/wikipedia-reader.html?id=${encodeURIComponent(id)}`);
  const popup = { url, type: 'popup', width: 1180, height: 840 };
  try {
    if (globalThis.browser?.windows?.create) globalThis.browser.windows.create(popup).catch(() => globalThis.open(url, '_blank'));
    else if (globalThis.chrome?.windows?.create) {
      globalThis.chrome.windows.create(popup, () => {
        if (globalThis.chrome.runtime.lastError) globalThis.open(url, '_blank');
      });
    } else globalThis.open(url, '_blank');
  } catch {
    globalThis.open(url, '_blank');
  }
}

function renderVisionDownload() {
  if (!supportsWebgpuVision) return;
  const state = visionDownloadState || {};
  const progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
  const active = state.status === 'starting' || state.status === 'downloading';
  elements['vision-model-status'].dataset.kind = state.status === 'ready' || state.status === 'error'
    ? state.status
    : '';
  elements['vision-model-progress'].hidden = !active;
  elements['vision-model-progress'].value = progress;
  elements['vision-model-test'].disabled = state.status !== 'ready' || visionTestRunning;
  if (state.status !== 'ready' && !visionTestRunning) setModelTestResult(elements['vision-model-test-result']);
  if (state.status === 'ready') {
    elements['vision-model-status'].textContent = t('ap.status.ready');
    return;
  }
  if (state.status === 'error') {
    const message = String(state.error || '').trim();
    elements['vision-model-status'].textContent = `${t('ap.status.error')}${message ? ` · ${message}` : ''}`;
    return;
  }
  if (state.status === 'downloading') {
    elements['vision-model-status'].textContent = `${t('ap.status.downloading')} · ${Math.round(progress)}%`;
    return;
  }
  if (state.status === 'starting' || snapshot?.enabled) {
    elements['vision-model-status'].textContent = t('ap.status.queued');
    return;
  }
  elements['vision-model-status'].textContent = t('ap.vision.waiting');
}

async function refreshVisionDownload() {
  if (!supportsWebgpuVision) return;
  const stored = await runtimeApi.storage.local.get(WEBGPU_VISION_DOWNLOAD_STATE_KEY);
  visionDownloadState = stored[WEBGPU_VISION_DOWNLOAD_STATE_KEY] || null;
  renderVisionDownload();
}

async function refresh() {
  snapshot = await command('status');
  const storedRecords = await store.listArchives().catch(() => []);
  fileHandles.clear();
  for (const record of storedRecords) {
    if (record.target?.kind === 'file-handle' && record.target.handle) fileHandles.set(record.id, record.target.handle);
  }
  elements.enabled.checked = snapshot.enabled === true;
  elements['update-policy'].value = snapshot.updatePolicy === 'automatic' ? 'automatic' : 'manual';
  syncCatalogAvailability();
  renderInstalled();
  await refreshVisionDownload().catch(() => {});
}

async function loadCatalog() {
  if (snapshot?.enabled !== true) {
    syncCatalogAvailability();
    return;
  }
  const request = ++catalogRequest;
  catalogLoading = true;
  catalogItems = [];
  elements['load-catalog'].disabled = true;
  elements.catalog.setAttribute('aria-busy', 'true');
  setCatalogStatus(t('ap.loading_catalog'), 'loading');
  setCatalogEmpty(t('ap.loading_catalog'));
  try {
    const result = await command('catalog', { language: elements.language.value });
    if (request !== catalogRequest) return;
    catalogItems = Array.isArray(result.items) ? result.items : [];
    catalogItems = catalogItems.filter(item => SUPPORTED_CATALOG_TIERS.has(item.tier));
    renderCatalog();
    setCatalogStatus(t('ap.loaded_catalog', { count: catalogItems.length }), 'success');
  } catch (error) {
    if (request !== catalogRequest) return;
    elements.catalog.innerHTML = '';
    setCatalogStatus(error.message, 'error');
  } finally {
    if (request === catalogRequest) {
      catalogLoading = false;
      elements.catalog.setAttribute('aria-busy', 'false');
      elements['load-catalog'].disabled = snapshot?.enabled !== true;
    }
  }
}

async function reviewInstall(item, sourceButton = null) {
  if (installReviewInFlight) return;
  installReviewInFlight = true;
  const originalButtonText = sourceButton?.textContent || '';
  elements.catalog.querySelectorAll('[data-install]').forEach((button) => { button.disabled = true; });
  if (sourceButton) {
    sourceButton.disabled = true;
    sourceButton.setAttribute('aria-busy', 'true');
    sourceButton.textContent = t('ap.review_loading');
  }
  notice(t('ap.resolving'));
  try {
    let target = null;
    if (elements['storage-target'].value === 'file') {
      const suggestedName = `${item.name || 'wikipedia'}_${item.flavour || 'archive'}_${String(item.archiveDate || '').slice(0, 10)}.zim`;
      const handle = await globalThis.showSaveFilePicker({
        suggestedName,
        types: [{ description: t('ap.file_description'), accept: { 'application/x-zim': ['.zim'] } }],
      });
      await authorizeFileHandle(handle, 'readwrite');
      target = { kind: 'file-handle', handle, access: 'readwrite' };
    }
    const { download } = await command('resolve', { item });
    const capacity = normalizeStorageEstimate(snapshot?.storage);
    const implication = target
      ? t('ap.space.external_unknown')
      : capacity.known ? t('ap.space.available', { size: bytes(capacity.free) }) : t('ap.space.unknown');
    const confirmed = globalThis.confirm(t('ap.confirm_install', {
      title: download.title,
      size: bytes(download.size),
      date: download.archiveDate || t('ap.date_unknown'),
      language: download.language,
      source: download.source,
      license: download.license,
      pieces: download.pieceHashes.length,
      algorithm: download.pieceHashAlgorithm,
      storage: implication,
    }));
    if (!confirmed) { notice(t('ap.install_cancelled')); return; }
    if (target) {
      const record = await pageManager.install(download, target);
      fileHandles.set(record.id, target.handle);
      snapshot = await command('status');
    } else {
      snapshot = await command('install', { download });
    }
    renderInstalled();
    notice(t('ap.queued'), 'success');
  } catch (error) { notice(error.message, 'error'); }
  finally {
    installReviewInFlight = false;
    elements.catalog.querySelectorAll('[data-install]').forEach((button) => {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = t('ap.review_install');
    });
    if (sourceButton && !sourceButton.matches('[data-install]')) {
      sourceButton.disabled = false;
      sourceButton.removeAttribute('aria-busy');
      sourceButton.textContent = originalButtonText;
    }
  }
}

async function reviewImport(file, external) {
  const inspected = await openKiwixZim(file, {
    language: elements['import-language'].value,
    source: t('ap.import.source'),
    license: t('ap.import.license'),
    licenseDeclared: false,
  });
  assertWikipediaZimArchive(inspected.embeddedMetadata);
  const provenance = inspected.metadata;
  const capacity = normalizeStorageEstimate(external || typeof storage.estimate !== 'function' ? {} : await storage.estimate());
  if (!external && capacity.known && file.size > capacity.free) {
    throw new Error(t('ap.space.insufficient', { required: bytes(file.size), available: bytes(capacity.free) }));
  }
  const implication = external
    ? t('ap.space.external_retained')
    : capacity.known ? t('ap.space.available', { size: bytes(capacity.free) }) : t('ap.space.unknown');
  return globalThis.confirm(t('ap.confirm_import', {
    title: file.name,
    size: bytes(file.size),
    date: provenance.archiveDate || t('ap.date_unknown'),
    language: provenance.language,
    source: provenance.source,
    license: provenance.license,
    storage: implication,
  })) ? provenance : null;
}

document.querySelectorAll('[data-webgpu-download-action]').forEach((button) => {
  button.addEventListener('click', () => runWebgpuDownloadAction(button.dataset.webgpuDownloadAction));
});
elements['vision-model-test'].addEventListener('click', testWebgpuVisionModel);

elements.enabled.addEventListener('change', async () => {
  try {
    snapshot = await command('enable', { enabled: elements.enabled.checked });
    syncCatalogAvailability();
    renderInstalled();
    notice(t(elements.enabled.checked ? 'ap.enabled_notice' : 'ap.disabled_notice'), 'success');
    if (snapshot.enabled === true) await loadCatalog();
  } catch (error) { elements.enabled.checked = !elements.enabled.checked; notice(error.message, 'error'); }
});

elements['update-policy'].addEventListener('change', async () => {
  const previous = snapshot?.updatePolicy || 'manual';
  try {
    snapshot = await command('set_update_policy', { policy: elements['update-policy'].value });
    renderInstalled();
    notice(t(snapshot.updatePolicy === 'automatic' ? 'ap.update_policy.automatic_notice' : 'ap.update_policy.manual_notice'), 'success');
  } catch (error) {
    elements['update-policy'].value = previous;
    notice(error.message, 'error');
  }
});

elements['load-catalog'].addEventListener('click', loadCatalog);
elements.language.addEventListener('change', loadCatalog);

elements.installed.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'read') {
    openWikipediaReader(button.dataset.id);
    return;
  }
  if (action === 'delete') {
    const record = snapshot.archives.find(item => item.id === button.dataset.id);
    const message = record?.target?.kind === 'file-handle'
      ? t('ap.delete_external')
      : t('ap.delete_internal');
    if (!globalThis.confirm(message)) return;
  }
  try {
    if (action === 'reauthorize') {
      const record = snapshot.archives.find(item => item.id === button.dataset.id);
      const handle = fileHandles.get(record?.id);
      const incompleteDownload = Boolean(record?.downloadUrl) && Number(record?.bytesDownloaded) < Number(record?.size);
      await authorizeFileHandle(handle, incompleteDownload ? 'readwrite' : 'read');
      snapshot = await command('reauthorize_file', { id: record.id });
      renderInstalled();
      notice(t('ap.action_done', { action: t('ap.reauthorize') }), 'success');
      return;
    }
    if (action === 'update') {
      const record = snapshot.archives.find(item => item.id === button.dataset.id);
      let replacement = record.updateAvailable;
      if (!replacement) {
        notice(t('ap.checking_update'));
        const result = await command('catalog', { language: record.language });
        replacement = selectKiwixUpdate(record, result.items);
      }
      if (!replacement) { notice(t('ap.current'), 'success'); return; }
      await reviewInstall(replacement, button);
      return;
    }
    snapshot = await command(action, { id: button.dataset.id });
    renderInstalled();
    notice(t('ap.action_done', { action: t(`ap.${action}`) }), 'success');
  } catch (error) { notice(error.message, 'error'); }
});

elements['import-button'].addEventListener('click', async () => {
  if (!snapshot?.enabled) { notice(t('ap.enable_import'), 'error'); return; }
  importController = new AbortController();
  elements['cancel-import'].hidden = false;
  elements['import-button'].disabled = true;
  try {
    if (elements['storage-target'].value === 'file' && typeof globalThis.showOpenFilePicker === 'function') {
      const [handle] = await globalThis.showOpenFilePicker({
        multiple: false,
        types: [{ description: t('ap.file_description'), accept: { 'application/x-zim': ['.zim'] } }],
      });
      await authorizeFileHandle(handle, 'read');
      const file = await handle.getFile();
      const provenance = await reviewImport(file, true);
      if (!provenance) { notice(t('ap.import_cancelled')); return; }
      await registerKiwixArchiveHandle(handle, {
        filename: handle.name,
        title: handle.name.replace(/\.zim$/i, ''),
        ...provenance,
      }, { store });
    } else {
      const file = elements['import-file'].files?.[0];
      if (!file) throw new Error(t('ap.choose_file'));
      const provenance = await reviewImport(file, false);
      if (!provenance) { notice(t('ap.import_cancelled')); return; }
      await importKiwixArchive(file, {
        filename: file.name,
        title: file.name.replace(/\.zim$/i, ''),
        ...provenance,
      }, { store, storage, signal: importController.signal, onProgress: () => refresh().catch(() => {}) });
    }
    await refresh();
    notice(t('ap.imported'), 'success');
  } catch (error) { notice(error.name === 'AbortError' ? t('ap.import_cancelled') : error.message, error.name === 'AbortError' ? '' : 'error'); }
  finally { importController = null; elements['cancel-import'].hidden = true; elements['import-button'].disabled = false; }
});
elements['cancel-import'].addEventListener('click', () => importController?.abort());
document.addEventListener('wb-locale-changed', () => {
  renderInstalled();
  renderCatalog();
  renderVisionDownload();
  updateWebgpuDownloadPanel();
});
runtimeApi.storage?.onChanged?.addListener?.((changes, area) => {
  if (!supportsWebgpuVision || area !== 'local' || !changes[WEBGPU_VISION_DOWNLOAD_STATE_KEY]) return;
  visionDownloadState = changes[WEBGPU_VISION_DOWNLOAD_STATE_KEY].newValue || null;
  renderVisionDownload();
});
runtimeApi.runtime?.onMessage?.addListener?.((message) => {
  if (message?.type !== 'webgpu-text-download-state') return false;
  setWebgpuDownloadState(message.state);
  return false;
});

async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (!processingDownload && (snapshot?.archives || []).some(record => ['queued', 'downloading', 'retrying'].includes(record.status))) {
      processingDownload = true;
      command('process').catch(() => {}).finally(() => { processingDownload = false; });
    }
    await Promise.all([refresh(), refreshWebgpuDownloadStatus()]);
  } catch { /* The next poll or persisted alarm retries. */ }
  finally { polling = false; }
}

await Promise.all([
  refresh().catch(error => notice(error.message, 'error')),
  refreshWebgpuDownloadStatus(),
]);
if (snapshot?.enabled === true) void loadCatalog();
setInterval(poll, 2000);
