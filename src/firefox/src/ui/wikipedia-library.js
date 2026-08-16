import {
  createApocalypseStore,
  isBasicWikipediaArchive,
  selectWikipediaArchiveVariant,
  wikipediaArchiveIncludesImages,
} from '../agent/apocalypse-mode.js';
import { t } from './i18n.js';
import { THEME_MODES, applyMode, loadMode, watch } from './theme.js';

const WIKIPEDIA_LANGUAGES = Object.freeze([
  ['eng', 'English'], ['zho', '中文'], ['ara', 'العربية'], ['ben', 'বাংলা'], ['nld', 'Nederlands'],
  ['tgl', 'Filipino'], ['fra', 'Français'], ['deu', 'Deutsch'], ['heb', 'עברית'], ['hin', 'हिन्दी'],
  ['ind', 'Bahasa Indonesia'], ['jpn', '日本語'], ['kor', '한국어'], ['msa', 'Bahasa Melayu'], ['fas', 'فارسی'],
  ['pol', 'Polski'], ['por', 'Português'], ['rus', 'Русский'], ['spa', 'Español'], ['tha', 'ไทย'],
  ['tur', 'Türkçe'], ['ukr', 'Українська'], ['vie', 'Tiếng Việt'],
]);

const runtimeApi = globalThis.browser || globalThis.chrome;
const archiveStore = createApocalypseStore();
const fileHandles = new Map();
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

const elements = Object.fromEntries([
  'mode-status', 'source-form', 'language', 'download', 'replacement-note', 'notice',
  'current-source', 'current-title', 'current-status', 'current-meta', 'current-progress',
  'current-detail', 'current-actions',
].map(id => [id, document.getElementById(id)]));

for (const [value, label] of WIKIPEDIA_LANGUAGES) elements.language.add(new Option(label, value));

let snapshot = null;
let busy = false;
let processing = false;
let pollBusy = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
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

function setNotice(message = '', kind = '') {
  elements.notice.textContent = message;
  elements.notice.dataset.kind = kind;
}

async function command(commandName, payload = {}) {
  const response = await runtimeApi.runtime.sendMessage({
    target: 'background', action: 'apocalypse_mode', command: commandName, ...payload,
  });
  if (response?.error) throw new Error(response.error);
  return response;
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

function wikipediaRecords() {
  return (snapshot?.archives || []).filter(record => record.archiveKind === 'wikipedia');
}

function customWikipediaRecords() {
  const activeStatuses = new Set(['queued', 'downloading', 'retrying', 'paused', 'error']);
  return wikipediaRecords().filter(record => !isBasicWikipediaArchive(record)).sort((left, right) => {
    const activeDifference = Number(activeStatuses.has(right.status)) - Number(activeStatuses.has(left.status));
    return activeDifference || Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
  });
}

function currentRecord() {
  return customWikipediaRecords()[0]
    || wikipediaRecords()
      .filter(isBasicWikipediaArchive)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0]
    || null;
}

function selectedIncludesImages() {
  return elements['source-form'].elements.edition.value === 'images';
}

function matchingReadyRecord() {
  const includeImages = selectedIncludesImages();
  return customWikipediaRecords().find(record => record.status === 'ready'
    && record.language === elements.language.value
    && wikipediaArchiveIncludesImages(record) === includeImages) || null;
}

function openReader(id) {
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

function actionButton(action, label, className = '') {
  return `<button type="button" class="${escapeHtml(className)}" data-action="${escapeHtml(action)}">${escapeHtml(label)}</button>`;
}

function renderCurrentRecord(record) {
  elements['current-source'].hidden = !record;
  if (!record) return;
  const status = String(record.status || '');
  const percent = record.size
    ? Math.min(100, Math.round((Number(record.bytesDownloaded) || 0) / Number(record.size) * 100))
    : 0;
  elements['current-title'].textContent = record.title || record.filename || t('wl.current_fallback');
  elements['current-status'].textContent = t(`ap.status.${status}`);
  elements['current-status'].dataset.status = status;
  elements['current-meta'].textContent = [
    record.language,
    String(record.archiveDate || t('ap.date_unknown')).slice(0, 10),
    wikipediaArchiveIncludesImages(record) ? t('wl.images_title') : t('wl.text_title'),
    formatBytes(record.size),
  ].filter(Boolean).join(' · ');
  elements['current-progress'].hidden = ['ready', 'deleting'].includes(status);
  elements['current-progress'].value = percent;
  if (record.replacementCleanupError) {
    elements['current-detail'].textContent = record.replacementCleanupError;
  } else if (Array.isArray(record.replacementArchiveIds) && record.replacementArchiveIds.length) {
    elements['current-detail'].textContent = t('wl.finalizing');
  } else if (record.error) {
    elements['current-detail'].textContent = record.error;
  } else if (status === 'ready') {
    elements['current-detail'].textContent = t('wl.ready_detail');
  } else {
    elements['current-detail'].textContent = `${formatBytes(record.bytesDownloaded)} / ${formatBytes(record.size)} · ${percent}%`;
  }

  let actions = '';
  if (['queued', 'downloading', 'retrying'].includes(status)) actions += actionButton('pause', t('ap.pause'));
  if (status === 'paused') actions += actionButton('resume', t('ap.resume'), 'primary');
  if (record.errorKind === 'file-permission-required') actions += actionButton('reauthorize', t('ap.reauthorize'), 'primary');
  else if (status === 'error' && record.downloadUrl && record.errorKind !== 'archive-unreadable') actions += actionButton('retry', t('ap.retry'), 'primary');
  if (status === 'ready') actions += actionButton('read', t('ap.reader.open'), 'primary');
  if (status === 'ready') actions += actionButton('delete', t('ap.delete'), 'danger');
  else if (status !== 'deleting') actions += actionButton('stop', t('st.providers.webgpu_download.stop'), 'danger');
  elements['current-actions'].innerHTML = actions;
}

function render() {
  const enabled = snapshot?.enabled === true;
  const record = currentRecord();
  const activeTransfer = record && ['queued', 'downloading', 'retrying', 'paused', 'deleting'].includes(record.status);
  const alreadyReady = matchingReadyRecord();
  elements['mode-status'].textContent = t(enabled ? 'wl.mode_on' : 'wl.mode_off');
  elements['mode-status'].dataset.kind = enabled ? 'ready' : 'disabled';
  elements.download.disabled = !enabled || busy || Boolean(activeTransfer) || Boolean(alreadyReady);
  elements.download.textContent = t(busy ? 'wl.preparing_button' : alreadyReady ? 'wl.already_ready' : 'wl.download');
  elements['replacement-note'].hidden = wikipediaRecords().every(recordItem => !isBasicWikipediaArchive(recordItem));
  renderCurrentRecord(record);
}

async function downloadSelected() {
  if (busy || snapshot?.enabled !== true) {
    if (snapshot?.enabled !== true) setNotice(t('wl.enable_first'), 'error');
    return;
  }
  busy = true;
  setNotice(t('wl.preparing'));
  render();
  try {
    const includeImages = selectedIncludesImages();
    const result = await command('catalog', { language: elements.language.value });
    const item = selectWikipediaArchiveVariant(result.items, { includeImages });
    if (!item) throw new Error(t('wl.unavailable'));
    const { download } = await command('resolve', { item });
    const replacementArchiveIds = wikipediaRecords()
      .filter(record => record.status === 'ready')
      .map(record => record.id);
    const confirmed = globalThis.confirm(t('wl.confirm_download', {
      title: download.title,
      size: formatBytes(download.size),
      date: download.archiveDate || t('ap.date_unknown'),
      replacements: replacementArchiveIds.length,
    }));
    if (!confirmed) {
      setNotice(t('ap.install_cancelled'));
      return;
    }
    snapshot = await command('install', { download, replacementArchiveIds });
    setNotice(t('wl.queued'), 'success');
    void command('process').catch(() => {});
  } catch (error) {
    setNotice(error.message, 'error');
  } finally {
    busy = false;
    render();
  }
}

async function runCurrentAction(action, button) {
  const record = currentRecord();
  if (!record) return;
  if (action === 'read') return openReader(record.id);
  if (action === 'stop' && !globalThis.confirm(t('wl.confirm_stop'))) return;
  if (action === 'delete') {
    const confirmation = record.target?.kind === 'file-handle' ? 'ap.delete_external' : 'ap.delete_internal';
    if (!globalThis.confirm(t(confirmation))) return;
  }
  button.disabled = true;
  try {
    if (action === 'reauthorize') {
      const handle = fileHandles.get(record.id);
      const incompleteDownload = Boolean(record.downloadUrl)
        && Number(record.bytesDownloaded) < Number(record.size);
      await authorizeFileHandle(handle, incompleteDownload ? 'readwrite' : 'read');
      snapshot = await command('reauthorize_file', { id: record.id });
      setNotice(t('ap.action_done', { action: t('ap.reauthorize') }), 'success');
      return;
    }
    const removesArchive = action === 'stop' || action === 'delete';
    snapshot = await command(removesArchive ? 'delete' : action, { id: record.id });
    setNotice(t('ap.action_done', {
      action: action === 'stop' ? t('st.providers.webgpu_download.stop') : t(`ap.${action}`),
    }), 'success');
  } catch (error) {
    setNotice(error.message, 'error');
  } finally {
    render();
  }
}

async function refresh() {
  snapshot = await command('status');
  const storedRecords = await archiveStore.listArchives().catch(() => []);
  fileHandles.clear();
  for (const record of storedRecords) {
    if (record.target?.kind === 'file-handle' && record.target.handle) fileHandles.set(record.id, record.target.handle);
  }
  render();
}

async function poll() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    await refresh();
    if (!processing && wikipediaRecords().some(record => ['queued', 'downloading', 'retrying'].includes(record.status))) {
      processing = true;
      command('process').catch(() => {}).finally(() => { processing = false; });
    }
  } catch (error) {
    setNotice(error.message, 'error');
  } finally {
    pollBusy = false;
  }
}

elements['source-form'].addEventListener('submit', event => {
  event.preventDefault();
  void downloadSelected();
});
elements['source-form'].addEventListener('change', render);
elements['current-actions'].addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (button) void runCurrentAction(button.dataset.action, button);
});
document.addEventListener('wb-locale-changed', render);
globalThis.addEventListener('focus', () => refresh().catch(error => setNotice(error.message, 'error')));

await refresh().catch(error => setNotice(error.message, 'error'));
setInterval(poll, 2_000);
