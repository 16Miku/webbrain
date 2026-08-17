import { getLocale, t } from './i18n.js';

const runtimeApi = globalThis.browser || globalThis.chrome;
const EMERGENCY_DB_NAME = 'webbrain_emergency_box';
const EMERGENCY_DB_VERSION = 1;
const EMERGENCY_STORE = 'resources';
const VISION_STATE_KEY = 'webgpuVisionDownloadState';
const EXPANDED_KEY = 'wbDownloadTrackerExpanded';
const ACTIVE_STATUSES = new Set(['starting', 'queued', 'downloading', 'retrying', 'stopping']);
const ATTENTION_STATUSES = new Set(['paused', 'error']);
const PDF_STALE_AFTER_MS = 8_000;
const telemetry = new Map();
const activeActions = new Set();

const DOWNLOAD_LABELS = Object.freeze({
  en: 'Downloads', zh: '下载', ar: 'التنزيلات', bn: 'ডাউনলোড', nl: 'Downloads',
  tl: 'Mga download', fr: 'Téléchargements', de: 'Downloads', he: 'הורדות', hi: 'डाउनलोड',
  id: 'Unduhan', ja: 'ダウンロード', ko: '다운로드', ms: 'Muat turun', fa: 'دانلودها',
  pl: 'Pobieranie', pt: 'Downloads', ru: 'Загрузки', es: 'Descargas', th: 'ดาวน์โหลด',
  tr: 'İndirmeler', uk: 'Завантаження', vi: 'Tải xuống',
});

let emergencyDatabasePromise;
let textModelState = null;
let textModelStateRequested = false;
let expanded = false;
let refreshing = false;
let timer = 0;
let renderedItems = new Map();

function label() {
  return DOWNLOAD_LABELS[getLocale()] || DOWNLOAD_LABELS.en;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function clampProgress(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function progressFor(item) {
  if (Number(item.progress) > 0) return clampProgress(item.progress);
  const loaded = Math.max(0, Number(item.loaded) || 0);
  const total = Math.max(0, Number(item.total) || 0);
  return total > 0 ? clampProgress(loaded / total * 100) : 0;
}

function formatBytes(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number < 1024) return `${Math.round(number)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = number;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatDuration(value) {
  let seconds = Math.max(0, Math.round(Number(value) || 0));
  if (seconds < 60) return `${seconds}s`;
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${minutes}m`].filter(Boolean).slice(0, 2).join(' ');
}

function addTelemetry(items) {
  const now = Date.now();
  const liveIds = new Set(items.map(item => item.id));
  for (const id of telemetry.keys()) {
    if (!liveIds.has(id)) telemetry.delete(id);
  }
  return items.map(item => {
    const loaded = Math.max(0, Number(item.loaded) || 0);
    const previous = telemetry.get(item.id);
    const observedAt = now;
    const advanced = previous && loaded > previous.loaded;
    const elapsed = advanced ? Math.max(0.25, (observedAt - previous.observedAt) / 1000) : 0;
    const instantSpeed = advanced ? (loaded - previous.loaded) / elapsed : 0;
    const speed = instantSpeed > 0
      ? (previous?.speed > 0 ? previous.speed * 0.65 + instantSpeed * 0.35 : instantSpeed)
      : (previous?.speed || 0);
    const lastAdvancedAt = advanced
      ? observedAt
      : (previous?.lastAdvancedAt || Number(item.updatedAt) || observedAt);
    const next = { loaded, observedAt, speed, lastAdvancedAt };
    telemetry.set(item.id, next);
    return {
      ...item,
      speed,
      secondsSinceProgress: Math.max(0, (observedAt - lastAdvancedAt) / 1000),
    };
  });
}

function statusText(status) {
  if (status === 'starting') return t('ap.status.queued');
  if (status === 'stopping') return t('st.providers.webgpu_download.stopping');
  const key = `ap.status.${status}`;
  const translated = t(key);
  return translated === key ? status : translated;
}

function pageUrl(filename) {
  try {
    return runtimeApi?.runtime?.getURL?.(`src/ui/${filename}`) || filename;
  } catch {
    return filename;
  }
}

function openEmergencyDatabase() {
  if (emergencyDatabasePromise) return emergencyDatabasePromise;
  if (!globalThis.indexedDB) return Promise.resolve(null);
  emergencyDatabasePromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(EMERGENCY_DB_NAME, EMERGENCY_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(EMERGENCY_STORE)) {
        request.result.createObjectStore(EMERGENCY_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return emergencyDatabasePromise;
}

async function emergencyRecords() {
  try {
    const database = await openEmergencyDatabase();
    if (!database) return [];
    return await new Promise((resolve, reject) => {
      const request = database.transaction(EMERGENCY_STORE, 'readonly').objectStore(EMERGENCY_STORE).getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

async function send(message) {
  if (!runtimeApi?.runtime?.sendMessage) return null;
  try {
    const response = await runtimeApi.runtime.sendMessage(message);
    return response?.error ? null : response;
  } catch {
    return null;
  }
}

async function apocalypseSnapshot() {
  return await send({ target: 'background', action: 'apocalypse_mode', command: 'status' });
}

async function readVisionState() {
  try {
    const stored = await runtimeApi?.storage?.local?.get?.(VISION_STATE_KEY);
    return stored?.[VISION_STATE_KEY] || null;
  } catch {
    return null;
  }
}

async function requestTextModelState(enabled) {
  if (textModelStateRequested || enabled !== true || !globalThis.chrome?.offscreen) return;
  textModelStateRequested = true;
  const state = await send({ target: 'background', action: 'get_webgpu_download_status' });
  if (state) textModelState = state;
  else textModelStateRequested = false;
}

function normalizedStatus(value) {
  const status = String(value || '').toLowerCase();
  return status === 'retrying' || status === 'queued' || status === 'starting'
    || status === 'downloading' || status === 'stopping' || status === 'paused' || status === 'error'
    ? status
    : '';
}

function modelItem(state, kind) {
  const status = normalizedStatus(state?.status);
  if (!ACTIVE_STATUSES.has(status) && !ATTENTION_STATUSES.has(status)) return null;
  return {
    id: `model-${kind}`,
    title: t(kind === 'text' ? 'ap.models.text.title' : 'ap.models.vision.title'),
    status,
    progress: progressFor(state || {}),
    loaded: state?.loaded,
    total: state?.total,
    updatedAt: state?.updatedAt,
    href: pageUrl('apocalypse-mode.html'),
    kind: 'model',
    modelKind: kind,
  };
}

function archiveItems(snapshot) {
  return (snapshot?.archives || []).flatMap(record => {
    const status = normalizedStatus(record?.status);
    if (!ACTIVE_STATUSES.has(status) && !ATTENTION_STATUSES.has(status)) return [];
    return [{
      id: `archive-${record.id}`,
      title: record.archiveTitle || record.title || record.name || t('ap.models.wikipedia.title'),
      status,
      progress: progressFor({ loaded: record.bytesDownloaded, total: record.size }),
      loaded: record.bytesDownloaded,
      total: record.size,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      href: pageUrl('wikipedia-library.html'),
      kind: 'archive',
      sourceId: record.id,
    }];
  });
}

function pdfItems(records) {
  const emergencyBoxOpen = /\/emergency-box\.html$/.test(globalThis.location?.pathname || '');
  const now = Date.now();
  return records.flatMap(record => {
    let status = normalizedStatus(record?.status);
    const stale = status === 'downloading' && !emergencyBoxOpen
      && now - (Number(record.updatedAt) || 0) > PDF_STALE_AFTER_MS;
    if (stale) status = 'paused';
    if (!ACTIVE_STATUSES.has(status) && !ATTENTION_STATUSES.has(status)) return [];
    return [{
      id: `pdf-${record.id}`,
      title: record.title || t('ep.document'),
      status,
      progress: progressFor({ loaded: record.bytesReceived, total: record.totalBytes }),
      loaded: record.bytesReceived,
      total: record.totalBytes,
      updatedAt: record.updatedAt,
      href: pageUrl('emergency-box.html'),
      detail: status === 'downloading' || stale ? t('eb.keep_open') : '',
      kind: 'pdf',
      sourceId: record.id,
    }];
  });
}

function priority(item) {
  if (item.status === 'error') return 0;
  if (ACTIVE_STATUSES.has(item.status)) return 1;
  return 2;
}

async function collectItems() {
  const [snapshot, vision, pdfs] = await Promise.all([
    apocalypseSnapshot(), readVisionState(), emergencyRecords(),
  ]);
  await requestTextModelState(snapshot?.enabled);
  return addTelemetry([
    modelItem(textModelState, 'text'),
    modelItem(vision, 'vision'),
    ...archiveItems(snapshot),
    ...pdfItems(pdfs),
  ].filter(Boolean).sort((left, right) => priority(left) - priority(right)
    || String(left.title).localeCompare(String(right.title))));
}

function glyphFor(item) {
  if (item.kind === 'model') return 'GPU';
  if (item.kind === 'archive') return 'ZIM';
  return 'PDF';
}

function livenessFor(item) {
  if (!ACTIVE_STATUSES.has(item.status) || item.status === 'stopping') return item.status;
  if (item.secondsSinceProgress <= 12) return 'moving';
  if (item.secondsSinceProgress <= 60) return 'working';
  return 'quiet';
}

function metricsFor(item) {
  const parts = [];
  if (Number(item.total) > 0) parts.push(`${formatBytes(item.loaded)} / ${formatBytes(item.total)}`);
  else if (Number(item.loaded) > 0) parts.push(formatBytes(item.loaded));
  if (ACTIVE_STATUSES.has(item.status) && item.status !== 'stopping') {
    if (item.speed > 0 && item.secondsSinceProgress <= 15) {
      parts.push(`${formatBytes(item.speed)}/s`);
      const remaining = Math.max(0, Number(item.total) - Number(item.loaded));
      if (remaining > 0) parts.push(`ETA ${formatDuration(remaining / item.speed)}`);
    } else if (item.secondsSinceProgress >= 2) {
      parts.push(`↻ ${formatDuration(item.secondsSinceProgress)}`);
    }
  }
  return parts.join(' · ');
}

function actionButton(action, label, item, className = '') {
  const disabled = activeActions.has(item.id) ? ' disabled' : '';
  return `<button type="button" class="wb-dl-action ${className}" data-download-action="${action}" data-download-id="${escapeHtml(item.id)}"${disabled}>${escapeHtml(label)}</button>`;
}

function actionsFor(item) {
  if (item.status === 'stopping') return '';
  const actions = [];
  if (ACTIVE_STATUSES.has(item.status)) actions.push(actionButton('pause', t('ap.pause'), item));
  if (ATTENTION_STATUSES.has(item.status)) actions.push(actionButton('resume', t('ap.resume'), item, 'primary'));
  actions.push(actionButton('stop', t('st.providers.webgpu_download.stop'), item, 'danger'));
  return actions.join('');
}

function summaryText(items) {
  const counts = new Map();
  for (const item of items) {
    const status = ACTIVE_STATUSES.has(item.status) ? 'downloading' : item.status;
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  return ['downloading', 'paused', 'error']
    .filter(status => counts.has(status))
    .map(status => `${statusText(status)} ${counts.get(status)}`)
    .join(' · ');
}

function renderRuler(items) {
  return items.map(item => `
    <span class="wb-dl-ruler-segment" data-status="${escapeHtml(item.status)}" style="flex-grow:${Math.max(1, Number(item.total) || 1)}">
      <span style="width:${progressFor(item)}%"></span>
    </span>`).join('');
}

function renderItems(items) {
  const manage = t('st.display.apocalypse_mode.manage');
  return items.map(item => `
    <li class="wb-dl-item" data-status="${escapeHtml(item.status)}" data-liveness="${livenessFor(item)}">
      <span class="wb-dl-kind" aria-hidden="true">${glyphFor(item)}</span>
      <span class="wb-dl-copy">
        <strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
        <span class="wb-dl-state"><i aria-hidden="true"></i>${escapeHtml(statusText(item.status))}${item.total ? ` · ${Math.round(progressFor(item))}%` : ''}</span>
        ${metricsFor(item) ? `<small class="wb-dl-metrics">${escapeHtml(metricsFor(item))}</small>` : ''}
        ${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ''}
      </span>
      <span class="wb-dl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progressFor(item))}">
        <span style="width:${progressFor(item)}%"></span>
      </span>
      <span class="wb-dl-actions">${actionsFor(item)}</span>
      <a class="wb-dl-manage" href="${escapeHtml(item.href)}" title="${escapeHtml(manage)}" aria-label="${escapeHtml(`${manage}: ${item.title}`)}">→</a>
    </li>`).join('');
}

async function stopPausedPdf(item) {
  const runtime = await import('../agent/emergency-box.js');
  await runtime.deleteEmergencyResource(item.sourceId, {
    store: runtime.createEmergencyBoxStore(),
    storage: runtime.createEmergencyBoxStorage(),
  });
}

function signalEmergencyBox(action, item) {
  const detail = { action, id: item.sourceId };
  if (/\/emergency-box\.html$/.test(globalThis.location?.pathname || '')) {
    globalThis.dispatchEvent(new CustomEvent('wb-emergency-download-control', { detail }));
    return;
  }
  try {
    const channel = new BroadcastChannel('webbrain-emergency-download-control');
    channel.postMessage(detail);
    channel.close();
  } catch { /* The owning page will recover the download as paused. */ }
}

async function runItemAction(item, action) {
  if (!item || activeActions.has(item.id)) return;
  if (action === 'stop' && !globalThis.confirm(t('wl.confirm_stop'))) return;
  activeActions.add(item.id);
  render([...renderedItems.values()]);
  try {
    if (item.kind === 'archive') {
      const command = action === 'stop' ? 'delete' : action;
      await send({ target: 'background', action: 'apocalypse_mode', command, id: item.sourceId });
    } else if (item.kind === 'model') {
      const suffix = item.modelKind === 'vision' ? '_vision' : '';
      const command = action === 'resume' ? `start_webgpu${suffix}_download` : `${action}_webgpu${suffix}_download`;
      const state = await send({ target: 'background', action: command });
      if (item.modelKind === 'text' && state) textModelState = state;
    } else if (item.kind === 'pdf') {
      if (action === 'resume' && !/\/emergency-box\.html$/.test(globalThis.location?.pathname || '')) {
        signalEmergencyBox('pause', item);
        globalThis.location.href = `${item.href}?resume=${encodeURIComponent(item.sourceId)}`;
        return;
      }
      if (action === 'stop' && !ACTIVE_STATUSES.has(item.status)) await stopPausedPdf(item);
      else signalEmergencyBox(action, item);
    }
  } finally {
    activeActions.delete(item.id);
    await refresh();
  }
}

function ensureTracker() {
  let tracker = document.getElementById('wb-download-tracker');
  if (tracker) return tracker;
  tracker = document.createElement('aside');
  tracker.id = 'wb-download-tracker';
  tracker.className = 'wb-download-tracker';
  tracker.hidden = true;
  tracker.innerHTML = `
    <button type="button" class="wb-dl-summary" aria-expanded="false">
      <span class="wb-dl-beacon" aria-hidden="true">↓</span>
      <span class="wb-dl-title"></span>
      <span class="wb-dl-stats" role="status" aria-live="polite"></span>
      <span class="wb-dl-chevron" aria-hidden="true">⌃</span>
    </button>
    <div class="wb-dl-ruler" aria-hidden="true"></div>
    <section class="wb-dl-panel">
      <ol class="wb-dl-list"></ol>
    </section>`;
  tracker.querySelector('.wb-dl-summary').addEventListener('click', () => {
    expanded = !expanded;
    try { localStorage.setItem(EXPANDED_KEY, String(expanded)); } catch {}
    applyExpandedState(tracker);
  });
  tracker.querySelector('.wb-dl-list').addEventListener('click', event => {
    const button = event.target.closest('[data-download-action][data-download-id]');
    if (!button) return;
    void runItemAction(renderedItems.get(button.dataset.downloadId), button.dataset.downloadAction);
  });
  document.body.append(tracker);
  return tracker;
}

function applyExpandedState(tracker) {
  tracker.dataset.expanded = String(expanded);
  tracker.querySelector('.wb-dl-summary').setAttribute('aria-expanded', String(expanded));
}

function render(items) {
  const tracker = ensureTracker();
  renderedItems = new Map(items.map(item => [item.id, item]));
  tracker.querySelector('.wb-dl-title').textContent = label();
  tracker.querySelector('.wb-dl-summary').setAttribute('aria-label', `${label()}: ${summaryText(items)}`);
  tracker.querySelector('.wb-dl-stats').textContent = summaryText(items);
  tracker.querySelector('.wb-dl-ruler').innerHTML = renderRuler(items);
  tracker.querySelector('.wb-dl-list').innerHTML = renderItems(items);
  tracker.hidden = items.length === 0;
  document.documentElement.classList.toggle('wb-download-tracker-visible', items.length > 0);
  applyExpandedState(tracker);
}

async function refresh() {
  if (refreshing || document.hidden) return;
  refreshing = true;
  try {
    render(await collectItems());
  } catch {
    // A tracker must never interfere with the page that owns a download.
  } finally {
    refreshing = false;
  }
}

try { expanded = localStorage.getItem(EXPANDED_KEY) === 'true'; } catch {}

runtimeApi?.runtime?.onMessage?.addListener?.(message => {
  if (message?.type !== 'webgpu-text-download-state') return false;
  textModelState = message.state || null;
  void refresh();
  return false;
});

runtimeApi?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area === 'local' && changes[VISION_STATE_KEY]) void refresh();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
document.addEventListener('wb-locale-changed', () => void refresh());

void refresh();
timer = globalThis.setInterval(() => void refresh(), 2_000);
globalThis.addEventListener('pagehide', () => globalThis.clearInterval(timer), { once: true });
