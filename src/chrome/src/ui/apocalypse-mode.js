import {
  isBasicWikipediaArchive,
  selectBasicWikipediaArchive,
  wikipediaArchiveIncludesImages,
} from '../agent/apocalypse-mode.js';
import {
  createEmergencyCorpusStore,
  createEmergencyCorpusStorage,
  deleteEmergencyCorpus,
  downloadAndInstallEmergencyCorpus,
} from '../agent/emergency-corpus.js';
import { EMERGENCY_CORPUS_RELEASE } from '../agent/emergency-corpus-release.js';
import { createHostedOfflineRagIndexClient } from '../agent/offline-rag-index-host.js';
import { createOfflineSemanticReranker } from '../agent/offline-reranker.js';
import {
  WEBGPU_DTYPE,
  WEBGPU_MODEL_ID,
} from '../providers/webgpu.js';
import { t } from './i18n.js';
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

const WEBGPU_VISION_DOWNLOAD_STATE_KEY = 'webgpuVisionDownloadState';
const BASIC_WIKIPEDIA_AUTO_START_SUPPRESSED_KEY = 'apocalypseBasicWikipediaAutoStartSuppressed';
const SUPPORTED_CATALOG_TIERS = new Set(['text', 'full']);
const supportsWebgpuVision = typeof globalThis.chrome?.offscreen?.createDocument === 'function';
const elements = Object.fromEntries([
  'enabled', 'installed-count', 'archive-bytes', 'storage-usage', 'notice',
  'vision-model-card', 'vision-model-status', 'vision-model-progress',
  'webgpu-provider-card', 'vision-model-test', 'vision-model-test-result',
  'models-readiness', 'models-readiness-label',
  'basic-wikipedia-card', 'basic-wikipedia-title', 'basic-wikipedia-description', 'basic-wikipedia-meta',
  'basic-wikipedia-status', 'basic-wikipedia-progress', 'basic-wikipedia-start',
  'emergency-corpus-card', 'emergency-corpus-title', 'emergency-corpus-description', 'emergency-corpus-meta',
  'emergency-corpus-status', 'emergency-corpus-progress', 'emergency-corpus-start',
  'semantic-model-card', 'semantic-model-title', 'semantic-model-description', 'semantic-model-meta',
  'semantic-model-status', 'semantic-model-progress', 'semantic-model-start',
  'emergency-box-callout', 'emergency-gate-reason', 'emergency-box-link',
  'offline-rag-readiness',
].map(id => [id, document.getElementById(id)]));
elements['vision-model-card'].hidden = !supportsWebgpuVision;
elements['webgpu-provider-card'].hidden = !supportsWebgpuVision;
elements['basic-wikipedia-card'].hidden = !supportsWebgpuVision;
if (elements['emergency-corpus-card']) elements['emergency-corpus-card'].hidden = !supportsWebgpuVision;
if (elements['semantic-model-card']) elements['semantic-model-card'].hidden = !supportsWebgpuVision;
let snapshot = null;
let basicWikipediaCatalogItem = null;
let basicWikipediaCatalogError = '';
let basicWikipediaCatalogLoading = false;
let basicWikipediaStartInFlight = false;
let basicWikipediaStartError = '';
let basicWikipediaAutoStartAttempted = false;
let basicWikipediaAutoStartSuppressed = false;
let corpusRecord = null;
let corpusProgress = { loaded: 0, total: 0, percent: 0, phase: '' };
let corpusDownloadInFlight = false;
let corpusAbortController = null;
let semanticState = { status: 'model-missing', loaded: 0, total: 0, progress: 0, error: '' };
let semanticDownloadInFlight = false;
let semanticAbortController = null;
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
const corpusStore = createEmergencyCorpusStore();
const corpusStorage = createEmergencyCorpusStorage();
const semanticReranker = createOfflineSemanticReranker();
const CORPUS_DOWNLOAD_ID = 'rag-emergency-corpus';
const SEMANTIC_DOWNLOAD_ID = 'rag-semantic-model';
const EMERGENCY_COMPONENT_STATE_EVENT = 'wb-emergency-component-download-state';
const EMERGENCY_COMPONENT_STATE_CHANNEL = 'webbrain-emergency-download-state';
const downloadStateChannel = typeof BroadcastChannel === 'function'
  ? new BroadcastChannel(EMERGENCY_COMPONENT_STATE_CHANNEL)
  : null;

function publishComponentDownloadState(detail) {
  try {
    globalThis.dispatchEvent(new CustomEvent(EMERGENCY_COMPONENT_STATE_EVENT, { detail }));
  } catch { /* Another extension page can still observe the broadcast below. */ }
  try {
    downloadStateChannel?.postMessage(detail);
  } catch { /* The footer tracker is optional and must never interrupt a download. */ }
}

function publishComponentDownloadStates() {
  const corpusStatus = corpusRecord?.status || (corpusDownloadInFlight ? 'downloading' : 'not-installed');
  const corpusTotal = Number(corpusProgress.totalBytes) || Number(corpusRecord?.staging?.totalBytes) || (corpusRecord?.status === 'ready' ? 245 * 1024 * 1024 : 0);
  const corpusReceived = Number(corpusProgress.bytesReceived) || Number(corpusRecord?.staging?.bytesReceived) || (corpusRecord?.status === 'ready' ? corpusTotal : 0);
  publishComponentDownloadState({
    id: CORPUS_DOWNLOAD_ID,
    status: corpusStatus,
    loaded: corpusReceived,
    total: corpusTotal,
    progress: corpusTotal > 0 ? corpusReceived / corpusTotal : (Number(corpusProgress.percent) ? Number(corpusProgress.percent) / 100 : 0),
    updatedAt: Number(corpusRecord?.updatedAt) || Date.now(),
    detail: corpusStatus === 'indexing' ? t('eb.rag.status.indexing') : '',
  });

  const semanticStatus = semanticState?.status || (semanticDownloadInFlight ? 'downloading' : 'model-missing');
  const semanticTotal = Number(semanticState?.total) || (semanticState?.status === 'ready' ? 134 * 1024 * 1024 : 0);
  const semanticReceived = Number(semanticState?.loaded) || (semanticState?.status === 'ready' ? semanticTotal : 0);
  publishComponentDownloadState({
    id: SEMANTIC_DOWNLOAD_ID,
    status: semanticStatus,
    loaded: semanticReceived,
    total: semanticTotal,
    progress: Number(semanticState?.progress) || (semanticTotal > 0 ? semanticReceived / semanticTotal : 0),
    updatedAt: Date.now(),
    detail: '',
  });
}

downloadStateChannel?.addEventListener('message', (event) => {
  if (event.data?.type === 'request') {
    publishComponentDownloadStates();
  }
});

let ragIndexClient = null;
const indexClient = () => {
  if (!ragIndexClient) ragIndexClient = createHostedOfflineRagIndexClient();
  return ragIndexClient;
};
const ragReadiness = createOfflineRagReadinessController({
  root: elements['offline-rag-readiness'],
  corpusStore,
  semanticReranker,
  getGenerationStatus: () => webgpuDownloadState.status === 'ready'
    ? 'ready'
    : webgpuDownloadState.status === 'error'
      ? 'error'
      : ['downloading', 'paused'].includes(webgpuDownloadState.status)
        ? webgpuDownloadState.status
        : 'model-missing',
});

function bytes(value) {
  const number = Number(value) || 0;
  if (number < 1024) return `${number} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = number;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function notice(message, kind = '') {
  elements.notice.textContent = message || '';
  elements.notice.dataset.kind = kind;
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

function basicWikipediaRecord() {
  const wikipedia = (snapshot?.archives || []).filter(record => record.archiveKind === 'wikipedia');
  const ready = wikipedia
    .filter(record => record.status === 'ready')
    .sort((left, right) => Number(right.completedAt || right.updatedAt || 0) - Number(left.completedAt || left.updatedAt || 0));
  if (ready.length) return ready[0];
  return wikipedia
    .filter(isBasicWikipediaArchive)
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0]
    || null;
}

function updateEmergencyBoxGate(readinessKind) {
  const locked = readinessKind !== 'ready';
  const callout = elements['emergency-box-callout'];
  const link = elements['emergency-box-link'];
  if (!callout || !link) return;
  callout.dataset.locked = String(locked);
  callout.setAttribute('aria-disabled', String(locked));
  elements['emergency-gate-reason'].hidden = !locked;
  link.setAttribute('aria-disabled', String(locked));
  if (locked) {
    link.removeAttribute('href');
    link.setAttribute('tabindex', '-1');
  } else {
    link.href = link.dataset.href;
    link.removeAttribute('tabindex');
  }
}

function updateOverallModelsReadiness() {
  if (!supportsWebgpuVision || !elements['models-readiness']) return;
  const textStatus = webgpuDownloadState.status;
  const visionStatus = visionDownloadState?.status || 'not-downloaded';
  const wikipediaStatus = basicWikipediaRecord()?.status
    || (basicWikipediaStartInFlight ? 'starting' : (basicWikipediaStartError || basicWikipediaCatalogError) ? 'error' : 'not-downloaded');
  const corpusStatus = corpusRecord?.status || (corpusDownloadInFlight ? 'downloading' : 'not-installed');
  const semanticStatus = semanticState?.status || (semanticDownloadInFlight ? 'downloading' : 'model-missing');

  let kind = 'pending';
  let key = 'ap.models.status.incomplete';
  if (snapshot?.enabled !== true) {
    kind = 'disabled';
    key = 'ap.models.status.disabled';
  } else if (textStatus === 'error' || visionStatus === 'error' || wikipediaStatus === 'error' || corpusStatus === 'error' || semanticStatus === 'error') {
    kind = 'error';
    key = 'ap.models.status.error';
  } else if (webgpuDownloadState.ready === true && visionStatus === 'ready' && wikipediaStatus === 'ready' && corpusStatus === 'ready' && semanticStatus === 'ready') {
    kind = 'ready';
    key = 'ap.models.status.ready';
  } else if (textStatus === 'paused' || visionStatus === 'paused' || wikipediaStatus === 'paused' || corpusStatus === 'paused' || semanticStatus === 'paused') {
    key = 'ap.models.status.paused';
  } else if (['checking', 'downloading', 'stopping'].includes(textStatus)
    || ['starting', 'downloading', 'stopping'].includes(visionStatus)
    || ['starting', 'queued', 'downloading', 'retrying'].includes(wikipediaStatus)
    || ['downloading', 'verifying', 'extracting', 'indexing'].includes(corpusStatus)
    || ['downloading'].includes(semanticStatus)) {
    key = 'ap.models.status.downloading';
  }
  elements['models-readiness'].dataset.kind = kind;
  elements['models-readiness-label'].textContent = t(key);
  updateEmergencyBoxGate(kind);
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
  track.hidden = state.status === 'ready';
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
  actions.stop.textContent = t(state.status === 'ready' ? 'ap.models.remove' : 'st.providers.webgpu_download.stop');
  for (const button of Object.values(actions)) {
    button.disabled = ['checking', 'stopping'].includes(state.status);
  }
  updateOverallModelsReadiness();
}

function confirmCompletedModelRemoval(action, status, modelTitleKey) {
  if (action !== 'stop' || status !== 'ready') return true;
  if (snapshot?.enabled === true || elements['enable']?.checked) {
    notice(t('ap.models.cannot_remove_while_enabled'), 'error');
    return false;
  }
  return globalThis.confirm(t('ap.models.confirm_remove', { model: t(modelTitleKey) }));
}

function setWebgpuDownloadState(state) {
  const normalized = normalizeWebgpuDownloadState(state);
  if (normalized.modelId && normalized.modelId !== WEBGPU_MODEL_ID) return;
  webgpuDownloadState = normalized;
  updateWebgpuDownloadPanel();
}

async function runVisionDownloadAction(action) {
  const actionMap = {
    start: 'start_webgpu_vision_download',
    resume: 'start_webgpu_vision_download',
    pause: 'pause_webgpu_vision_download',
    stop: 'stop_webgpu_vision_download',
  };
  const backgroundAction = actionMap[action];
  if (!backgroundAction) return;
  if (!confirmCompletedModelRemoval(action, visionDownloadState?.status, 'ap.models.vision.title')) return;
  const previous = visionDownloadState || { modelId: '' };
  visionDownloadState = {
    ...previous,
    status: action === 'pause' ? 'paused' : action === 'stop' ? 'stopping' : 'starting',
    error: '',
  };
  renderVisionDownload();
  try {
    const result = await providerCommand(backgroundAction);
    if (result?.ok === false) throw new Error(result.error || 'Vision Model download action failed.');
    if (action === 'start' || action === 'resume') {
      visionDownloadState = {
        ...visionDownloadState,
        status: result?.ready === true ? 'ready' : 'starting',
        progress: result?.ready === true ? 100 : visionDownloadState?.progress || 0,
      };
    } else {
      visionDownloadState = { ...visionDownloadState, ...result };
    }
    renderVisionDownload();
  } catch (error) {
    visionDownloadState = {
      ...visionDownloadState,
      status: 'error',
      error: error.message,
    };
    renderVisionDownload();
  }
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
  if (!confirmCompletedModelRemoval(action, webgpuDownloadState.status, 'ap.models.text.title')) return;
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

function renderInstalled() {
  elements['installed-count'].textContent = String(snapshot?.installedCount || 0);
  elements['archive-bytes'].textContent = bytes(snapshot?.totalBytes);
  const usage = snapshot?.storage?.usage;
  elements['storage-usage'].textContent = usage == null ? t('ap.unavailable') : bytes(usage);
  elements['storage-usage'].parentElement.title = `${t('ap.metric.storage')}: ${elements['storage-usage'].textContent}`;
  renderBasicWikipediaDownload();
}

function renderBasicWikipediaDownload() {
  if (!supportsWebgpuVision) return;
  const record = basicWikipediaRecord();
  const displayItem = record || basicWikipediaCatalogItem;
  const status = record?.status || 'not-downloaded';
  const progress = record?.size
    ? Math.min(100, Math.round((Number(record.bytesDownloaded) || 0) / Number(record.size) * 100))
    : 0;
  const statusElement = elements['basic-wikipedia-status'];
  const customEdition = Boolean(record && !isBasicWikipediaArchive(record));
  elements['basic-wikipedia-title'].textContent = t(customEdition ? 'ap.models.wikipedia.active_title' : 'ap.models.wikipedia.title');
  elements['basic-wikipedia-description'].textContent = t(customEdition ? 'ap.models.wikipedia.active_desc' : 'ap.models.wikipedia.desc');
  elements['basic-wikipedia-meta'].hidden = !displayItem;
  const tier = displayItem && wikipediaArchiveIncludesImages(displayItem) ? 'full' : 'text';
  elements['basic-wikipedia-meta'].textContent = `${displayItem?.language || 'eng'} · ${String(displayItem?.archiveDate || t('ap.date_unknown')).slice(0, 10)} · ${t(`ap.tier.${tier}`)}`;
  elements['basic-wikipedia-progress'].hidden = !record || ['ready', 'deleting'].includes(status);
  elements['basic-wikipedia-progress'].value = progress;
  statusElement.dataset.kind = status === 'ready' || status === 'error' ? status : '';

  if (status === 'ready') {
    statusElement.textContent = t('ap.status.ready');
  } else if (status === 'error') {
    statusElement.textContent = `${t('ap.status.error')}${record.error ? ` · ${record.error}` : ''}`;
  } else if (record) {
    statusElement.textContent = `${t(`ap.status.${status}`)}${record.size ? ` · ${progress}%` : ''}`;
  } else if (snapshot?.enabled !== true) {
    statusElement.textContent = t('ap.models.wikipedia.waiting');
  } else if (basicWikipediaStartInFlight) {
    statusElement.textContent = t('ap.models.wikipedia.starting');
  } else if (basicWikipediaStartError || basicWikipediaCatalogError) {
    statusElement.dataset.kind = 'error';
    statusElement.textContent = basicWikipediaStartError || basicWikipediaCatalogError || t('ap.models.wikipedia.unavailable');
  } else if (basicWikipediaCatalogLoading || !basicWikipediaCatalogItem) {
    statusElement.textContent = t('ap.models.wikipedia.finding');
  } else if (basicWikipediaAutoStartSuppressed) {
    statusElement.textContent = t('ap.models.wikipedia.stopped');
  } else {
    statusElement.textContent = t('ap.models.wikipedia.required');
  }

  const actions = Object.fromEntries(['pause', 'resume', 'retry', 'read', 'stop'].map(action => [
    action,
    elements['basic-wikipedia-card'].querySelector(`[data-basic-wikipedia-action="${action}"]`),
  ]));
  elements['basic-wikipedia-start'].hidden = snapshot?.enabled !== true || Boolean(record) || !basicWikipediaCatalogItem || basicWikipediaStartInFlight;
  actions.pause.hidden = !['queued', 'downloading', 'retrying'].includes(status);
  actions.resume.hidden = status !== 'paused';
  actions.retry.hidden = status !== 'error' || !record?.downloadUrl || record.errorKind === 'archive-unreadable';
  actions.read.hidden = status !== 'ready';
  actions.stop.hidden = !record || status === 'deleting';
  actions.stop.textContent = t(status === 'ready' ? 'ap.models.remove' : 'st.providers.webgpu_download.stop');
  for (const button of [elements['basic-wikipedia-start'], ...Object.values(actions)]) {
    button.disabled = basicWikipediaStartInFlight || status === 'deleting';
  }
  updateOverallModelsReadiness();
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
  const status = state.status || 'not-downloaded';
  const progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
  const active = status === 'starting' || status === 'downloading';
  elements['vision-model-status'].dataset.kind = status === 'ready' || status === 'error'
    ? status
    : '';
  elements['vision-model-progress'].hidden = !active;
  elements['vision-model-progress'].value = progress;
  elements['vision-model-test'].disabled = status !== 'ready' || visionTestRunning;
  if (status !== 'ready' && !visionTestRunning) setModelTestResult(elements['vision-model-test-result']);

  const actions = Object.fromEntries(['start', 'pause', 'resume', 'stop'].map(action => [
    action,
    document.querySelector(`[data-vision-download-action="${action}"]`),
  ]));
  actions.start.hidden = snapshot?.enabled !== true || !['idle', 'not-downloaded', 'error'].includes(status);
  actions.pause.hidden = !['starting', 'downloading'].includes(status);
  actions.resume.hidden = status !== 'paused';
  actions.stop.hidden = !['starting', 'downloading', 'paused', 'stopping', 'ready', 'error'].includes(status);
  actions.stop.textContent = t(status === 'ready' ? 'ap.models.remove' : 'st.providers.webgpu_download.stop');
  for (const button of Object.values(actions)) button.disabled = status === 'stopping';

  if (status === 'ready') {
    elements['vision-model-status'].textContent = t('ap.status.ready');
  } else if (status === 'error') {
    const message = String(state.error || '').trim();
    elements['vision-model-status'].textContent = `${t('ap.status.error')}${message ? ` · ${message}` : ''}`;
  } else if (status === 'downloading') {
    elements['vision-model-status'].textContent = `${t('ap.status.downloading')} · ${Math.round(progress)}%`;
  } else if (status === 'paused') {
    elements['vision-model-status'].textContent = `${t('ap.status.paused')} · ${Math.round(progress)}%`;
  } else if (status === 'stopping') {
    elements['vision-model-status'].textContent = t('st.providers.webgpu_download.stopping');
  } else if (status === 'starting') {
    elements['vision-model-status'].textContent = t('ap.status.queued');
  } else if (snapshot?.enabled) {
    elements['vision-model-status'].textContent = t('st.providers.webgpu_download.not_downloaded');
  } else {
    elements['vision-model-status'].textContent = t('ap.vision.waiting');
  }
  updateOverallModelsReadiness();
}

async function refreshVisionDownload() {
  if (!supportsWebgpuVision) return;
  const stored = await runtimeApi.storage.local.get(WEBGPU_VISION_DOWNLOAD_STATE_KEY);
  visionDownloadState = stored[WEBGPU_VISION_DOWNLOAD_STATE_KEY] || null;
  renderVisionDownload();
}

function renderEmergencyCorpusDownload() {
  if (!supportsWebgpuVision || !elements['emergency-corpus-card']) return;
  const record = corpusRecord;
  const status = record?.status || (corpusDownloadInFlight ? 'downloading' : 'not-installed');
  const active = ['downloading', 'verifying', 'extracting', 'indexing'].includes(status);
  const progress = Math.max(0, Math.min(100, Math.round(Number(corpusProgress.percent) || 0)));

  elements['emergency-corpus-status'].dataset.kind = status === 'ready' || status === 'error'
    ? status
    : (active ? 'loading' : '');
  elements['emergency-corpus-progress'].hidden = !active;
  elements['emergency-corpus-progress'].value = progress;

  const actions = Object.fromEntries(['retry', 'stop'].map(action => [
    action,
    elements['emergency-corpus-card'].querySelector(`[data-emergency-corpus-action="${action}"]`),
  ]));
  elements['emergency-corpus-start'].hidden = snapshot?.enabled !== true || status === 'ready' || active;
  actions.retry.hidden = status !== 'error';
  actions.stop.hidden = status !== 'ready' && !active;
  actions.stop.textContent = t(status === 'ready' ? 'ap.models.remove' : 'st.providers.webgpu_download.stop');

  for (const button of [elements['emergency-corpus-start'], ...Object.values(actions)]) {
    if (button) button.disabled = corpusDownloadInFlight && status !== 'downloading';
  }

  if (status === 'ready') {
    elements['emergency-corpus-status'].textContent = t('ap.status.ready');
  } else if (status === 'error') {
    const msg = record?.error || '';
    elements['emergency-corpus-status'].textContent = `${t('ap.status.error')}${msg ? ` · ${msg}` : ''}`;
  } else if (status === 'downloading') {
    elements['emergency-corpus-status'].textContent = `${t('ap.status.downloading')} · ${progress}%`;
  } else if (status === 'verifying') {
    elements['emergency-corpus-status'].textContent = t('eb.rag.status.verifying');
  } else if (status === 'extracting') {
    elements['emergency-corpus-status'].textContent = t('eb.rag.status.extracting');
  } else if (status === 'indexing') {
    elements['emergency-corpus-status'].textContent = t('eb.rag.status.indexing');
  } else if (snapshot?.enabled) {
    elements['emergency-corpus-status'].textContent = t('st.providers.webgpu_download.not_downloaded');
  } else {
    elements['emergency-corpus-status'].textContent = t('ap.vision.waiting');
  }
  updateOverallModelsReadiness();
  publishComponentDownloadStates();
}

function renderSemanticDownload() {
  if (!supportsWebgpuVision || !elements['semantic-model-card']) return;
  const state = semanticState || {};
  const status = state.status || (semanticDownloadInFlight ? 'downloading' : 'model-missing');
  const active = status === 'downloading';
  const progress = Math.max(0, Math.min(100, Math.round(Number(state.progress) || 0)));

  elements['semantic-model-status'].dataset.kind = status === 'ready' || status === 'error'
    ? status
    : (active ? 'loading' : '');
  elements['semantic-model-progress'].hidden = !active;
  elements['semantic-model-progress'].value = progress;

  const actions = Object.fromEntries(['retry', 'stop'].map(action => [
    action,
    elements['semantic-model-card'].querySelector(`[data-semantic-model-action="${action}"]`),
  ]));
  elements['semantic-model-start'].hidden = snapshot?.enabled !== true || status === 'ready' || active;
  actions.retry.hidden = status !== 'error';
  actions.stop.hidden = status !== 'ready' && !active;
  actions.stop.textContent = t(status === 'ready' ? 'ap.models.remove' : 'st.providers.webgpu_download.stop');

  for (const button of [elements['semantic-model-start'], ...Object.values(actions)]) {
    if (button) button.disabled = semanticDownloadInFlight && status !== 'downloading';
  }

  if (status === 'ready') {
    elements['semantic-model-status'].textContent = t('ap.status.ready');
  } else if (status === 'error') {
    const msg = state.error || '';
    elements['semantic-model-status'].textContent = `${t('ap.status.error')}${msg ? ` · ${msg}` : ''}`;
  } else if (status === 'downloading') {
    elements['semantic-model-status'].textContent = `${t('ap.status.downloading')} · ${progress}%`;
  } else if (snapshot?.enabled) {
    elements['semantic-model-status'].textContent = t('st.providers.webgpu_download.not_downloaded');
  } else {
    elements['semantic-model-status'].textContent = t('ap.vision.waiting');
  }
  updateOverallModelsReadiness();
  publishComponentDownloadStates();
}

async function refresh() {
  snapshot = await command('status');
  elements.enabled.checked = snapshot.enabled === true;
  renderInstalled();
  await refreshVisionDownload().catch(() => {});
  corpusRecord = await corpusStore.get().catch(() => null);
  renderEmergencyCorpusDownload();
  await semanticReranker.status().catch(() => 'error');
  semanticState = semanticReranker.snapshot();
  renderSemanticDownload();
  await ragReadiness.refresh({ archives: snapshot.archives }).catch(() => {});
}

async function loadBasicWikipediaAutoStartPreference() {
  try {
    const stored = await runtimeApi.storage.local.get(BASIC_WIKIPEDIA_AUTO_START_SUPPRESSED_KEY);
    basicWikipediaAutoStartSuppressed = stored[BASIC_WIKIPEDIA_AUTO_START_SUPPRESSED_KEY] === true;
  } catch {
    basicWikipediaAutoStartSuppressed = false;
  }
}

async function setBasicWikipediaAutoStartSuppressed(suppressed) {
  basicWikipediaAutoStartSuppressed = suppressed === true;
  if (basicWikipediaAutoStartSuppressed) {
    await runtimeApi.storage.local.set({ [BASIC_WIKIPEDIA_AUTO_START_SUPPRESSED_KEY]: true });
  } else {
    await runtimeApi.storage.local.remove(BASIC_WIKIPEDIA_AUTO_START_SUPPRESSED_KEY);
  }
}

async function startBasicWikipediaDownload({ automatic = false } = {}) {
  if (snapshot?.enabled !== true || basicWikipediaStartInFlight || basicWikipediaRecord() || !basicWikipediaCatalogItem) return;
  if (!automatic) await setBasicWikipediaAutoStartSuppressed(false);
  basicWikipediaStartInFlight = true;
  basicWikipediaStartError = '';
  renderBasicWikipediaDownload();
  try {
    const { download } = await command('resolve', { item: basicWikipediaCatalogItem });
    snapshot = await command('install', { download });
    renderInstalled();
    notice(t(automatic ? 'ap.models.wikipedia.started' : 'ap.queued'), 'success');
  } catch (error) {
    basicWikipediaStartError = error.message;
    notice(error.message, 'error');
  } finally {
    basicWikipediaStartInFlight = false;
    renderBasicWikipediaDownload();
  }
}

function maybeAutoStartBasicWikipediaDownload() {
  if (snapshot?.enabled !== true || basicWikipediaAutoStartSuppressed || basicWikipediaAutoStartAttempted
    || basicWikipediaStartInFlight || basicWikipediaRecord() || !basicWikipediaCatalogItem) return;
  basicWikipediaAutoStartAttempted = true;
  void startBasicWikipediaDownload({ automatic: true });
}

async function startEmergencyCorpusDownload({ automatic = false } = {}) {
  if (snapshot?.enabled !== true || corpusDownloadInFlight || !EMERGENCY_CORPUS_RELEASE) return;
  corpusDownloadInFlight = true;
  corpusAbortController = new AbortController();
  renderEmergencyCorpusDownload();
  try {
    corpusRecord = await downloadAndInstallEmergencyCorpus(EMERGENCY_CORPUS_RELEASE, {
      store: corpusStore,
      storage: corpusStorage,
      signal: corpusAbortController.signal,
      buildIndex: request => indexClient().buildEmergencyIndex(request),
      deleteIndex: path => indexClient().deleteIndex(path),
      onProgress: (progress) => {
        corpusProgress = progress || {};
        renderEmergencyCorpusDownload();
        void ragReadiness.refresh();
      },
    });
    notice(t(automatic ? 'ap.models.wikipedia.started' : 'ap.queued'), 'success');
  } catch (error) {
    if (error?.name !== 'AbortError') {
      notice(error.message, 'error');
    }
  } finally {
    corpusDownloadInFlight = false;
    corpusAbortController = null;
    corpusRecord = await corpusStore.get().catch(() => null);
    renderEmergencyCorpusDownload();
    await ragReadiness.refresh();
  }
}

async function maybeAutoStartEmergencyCorpusDownload() {
  if (snapshot?.enabled !== true || corpusDownloadInFlight || !EMERGENCY_CORPUS_RELEASE) return;
  corpusRecord = await corpusStore.get().catch(() => null);
  if (corpusRecord?.status === 'ready' || corpusRecord?.status === 'downloading' || corpusRecord?.status === 'verifying' || corpusRecord?.status === 'extracting' || corpusRecord?.status === 'indexing') {
    renderEmergencyCorpusDownload();
    return;
  }
  void startEmergencyCorpusDownload({ automatic: true });
}

async function startSemanticDownload({ automatic = false } = {}) {
  if (snapshot?.enabled !== true || semanticDownloadInFlight) return;
  semanticDownloadInFlight = true;
  semanticAbortController = new AbortController();
  renderSemanticDownload();
  try {
    await semanticReranker.download({
      signal: semanticAbortController.signal,
      onProgress: (progress) => {
        semanticState = { ...semanticState, ...progress, status: 'downloading' };
        renderSemanticDownload();
        void ragReadiness.refresh();
      },
    });
    notice(t(automatic ? 'ap.models.wikipedia.started' : 'ap.queued'), 'success');
  } catch (error) {
    if (error?.name !== 'AbortError') {
      notice(error.message, 'error');
    }
  } finally {
    semanticDownloadInFlight = false;
    semanticAbortController = null;
    await semanticReranker.status().catch(() => 'error');
    semanticState = semanticReranker.snapshot();
    renderSemanticDownload();
    await ragReadiness.refresh();
  }
}

async function maybeAutoStartSemanticDownload() {
  if (snapshot?.enabled !== true || semanticDownloadInFlight) return;
  await semanticReranker.status().catch(() => 'error');
  semanticState = semanticReranker.snapshot();
  if (semanticState?.status === 'ready' || semanticState?.status === 'downloading') {
    renderSemanticDownload();
    return;
  }
  void startSemanticDownload({ automatic: true });
}

async function loadBasicWikipediaCatalog() {
  if (snapshot?.enabled !== true || basicWikipediaCatalogItem || basicWikipediaCatalogLoading) return;
  basicWikipediaCatalogLoading = true;
  basicWikipediaCatalogError = '';
  renderBasicWikipediaDownload();
  try {
    const result = await command('catalog', { language: 'eng' });
    const supported = (Array.isArray(result.items) ? result.items : [])
      .filter(item => SUPPORTED_CATALOG_TIERS.has(item.tier));
    basicWikipediaCatalogItem = selectBasicWikipediaArchive(supported);
    basicWikipediaCatalogError = basicWikipediaCatalogItem ? '' : t('ap.models.wikipedia.unavailable');
    maybeAutoStartBasicWikipediaDownload();
  } catch (error) {
    basicWikipediaCatalogError = error.message;
  } finally {
    basicWikipediaCatalogLoading = false;
    renderBasicWikipediaDownload();
  }
}

async function runBasicWikipediaAction(action, sourceButton) {
  const record = basicWikipediaRecord();
  if (!record) return;
  if (action === 'read') {
    openWikipediaReader(record.id);
    return;
  }
  if (action === 'stop') {
    if (record.status === 'ready' && (snapshot?.enabled === true || elements['enable']?.checked)) {
      notice(t('ap.cannot_delete_while_enabled'), 'error');
      return;
    }
    const message = record.target?.kind === 'file-handle' ? t('ap.delete_external') : t('ap.delete_internal');
    if (!globalThis.confirm(message)) return;
    await setBasicWikipediaAutoStartSuppressed(true);
  }
  sourceButton.disabled = true;
  try {
    const archiveAction = action === 'stop' ? 'delete' : action;
    snapshot = await command(archiveAction, { id: record.id });
    renderInstalled();
    const actionLabel = action === 'stop'
      ? t(record.status === 'ready' ? 'ap.models.remove' : 'st.providers.webgpu_download.stop')
      : t(`ap.${archiveAction}`);
    notice(t('ap.action_done', { action: actionLabel }), 'success');
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    sourceButton.disabled = false;
    renderBasicWikipediaDownload();
  }
}

document.querySelectorAll('[data-webgpu-download-action]').forEach((button) => {
  button.addEventListener('click', () => runWebgpuDownloadAction(button.dataset.webgpuDownloadAction));
});
document.querySelectorAll('[data-vision-download-action]').forEach((button) => {
  button.addEventListener('click', () => runVisionDownloadAction(button.dataset.visionDownloadAction));
});
elements['vision-model-test'].addEventListener('click', testWebgpuVisionModel);
elements['basic-wikipedia-start'].addEventListener('click', () => startBasicWikipediaDownload());
document.querySelectorAll('[data-basic-wikipedia-action]').forEach((button) => {
  button.addEventListener('click', event => runBasicWikipediaAction(button.dataset.basicWikipediaAction, event.currentTarget));
});
elements['emergency-corpus-start']?.addEventListener('click', () => startEmergencyCorpusDownload());
document.querySelectorAll('[data-emergency-corpus-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.emergencyCorpusAction;
    if (action === 'retry') {
      void startEmergencyCorpusDownload();
    } else if (action === 'stop') {
      if (corpusRecord?.status === 'ready' && (snapshot?.enabled === true || elements.enabled?.checked)) {
        notice(t('ap.cannot_delete_while_enabled'), 'error');
        return;
      }
      if (corpusAbortController) {
        corpusAbortController.abort();
      } else if (corpusRecord?.status === 'ready') {
        const message = t('ap.delete_internal');
        if (!globalThis.confirm(message)) return;
        button.disabled = true;
        try {
          await deleteEmergencyCorpus({
            store: corpusStore,
            storage: corpusStorage,
            deleteIndex: path => indexClient().deleteIndex(path),
          });
          corpusRecord = null;
          renderEmergencyCorpusDownload();
          notice(t('eb.rag.deleted'), 'success');
        } catch (error) {
          notice(error.message, 'error');
        } finally {
          button.disabled = false;
        }
      }
    }
  });
});
elements['semantic-model-start']?.addEventListener('click', () => startSemanticDownload());
document.querySelectorAll('[data-semantic-model-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.semanticModelAction;
    if (action === 'retry') {
      void startSemanticDownload();
    } else if (action === 'stop') {
      if (semanticAbortController) {
        semanticAbortController.abort();
      } else {
        await semanticReranker.stop().catch(() => {});
        semanticState = semanticReranker.snapshot();
        renderSemanticDownload();
      }
    }
  });
});
semanticReranker.subscribe((state) => {
  semanticState = state;
  renderSemanticDownload();
});
elements['emergency-box-link'].addEventListener('click', (event) => {
  if (elements['emergency-box-link'].getAttribute('aria-disabled') !== 'true') return;
  event.preventDefault();
  notice(t('ap.emergency.gate'), 'error');
});

elements.enabled.addEventListener('change', async () => {
  try {
    snapshot = await command('enable', { enabled: elements.enabled.checked });
    if (snapshot.enabled === true) {
      basicWikipediaAutoStartAttempted = false;
      basicWikipediaStartError = '';
      await setBasicWikipediaAutoStartSuppressed(false);
    }
    if (snapshot.textModel?.modelId) setWebgpuDownloadState(snapshot.textModel);
    await refreshVisionDownload().catch(() => {});
    renderInstalled();
    renderEmergencyCorpusDownload();
    renderSemanticDownload();
    updateOverallModelsReadiness();
    notice(t(elements.enabled.checked ? 'ap.enabled_notice' : 'ap.disabled_notice'), 'success');
    if (snapshot.enabled === true) {
      void loadBasicWikipediaCatalog();
      void maybeAutoStartEmergencyCorpusDownload();
      void maybeAutoStartSemanticDownload();
    }
  } catch (error) { elements.enabled.checked = !elements.enabled.checked; notice(error.message, 'error'); }
});
document.addEventListener('wb-locale-changed', () => {
  renderInstalled();
  renderVisionDownload();
  updateWebgpuDownloadPanel();
  renderBasicWikipediaDownload();
  renderEmergencyCorpusDownload();
  renderSemanticDownload();
  updateOverallModelsReadiness();
  ragReadiness.render();
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
    await Promise.all([refresh(), refreshWebgpuDownloadStatus(), ragReadiness.refresh()]);
  } catch { /* The next poll or persisted alarm retries. */ }
  finally { polling = false; }
}

await Promise.all([
  refresh().catch(error => notice(error.message, 'error')),
  refreshWebgpuDownloadStatus(),
  loadBasicWikipediaAutoStartPreference(),
]);
if (snapshot?.enabled === true) {
  void loadBasicWikipediaCatalog();
  void maybeAutoStartEmergencyCorpusDownload();
  void maybeAutoStartSemanticDownload();
}
setInterval(poll, 2000);
globalThis.addEventListener('pagehide', () => {
  ragReadiness.close();
  ragIndexClient?.close?.();
  semanticReranker.close?.();
  downloadStateChannel?.close();
}, { once: true });
