import {
  assertWikipediaZimArchive,
  createApocalypseStore,
  createOpfsArchiveStorage,
  importKiwixArchive,
  isBasicWikipediaArchive,
  isSimpleEnglishWikipediaArchive,
  normalizeStorageEstimate,
  openKiwixZim,
  registerKiwixArchiveHandle,
  selectWikipediaArchiveVariant,
  wikipediaArchiveIncludesImages,
  wikipediaArchiveMatchesSelection,
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
const BASIC_WIKIPEDIA_AUTO_START_SUPPRESSED_KEY = 'apocalypseBasicWikipediaAutoStartSuppressed';
const archiveStore = createApocalypseStore();
const importStorage = createOpfsArchiveStorage();
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
  'import-file', 'import-language', 'import-button', 'cancel-import', 'current-source', 'archive-list',
].map(id => [id, document.getElementById(id)]));

for (const select of [elements.language, elements['import-language']]) {
  for (const [value, label] of WIKIPEDIA_LANGUAGES) select.add(new Option(label, value));
}

let snapshot = null;
let busy = false;
let importBusy = false;
let importController = null;
let importArchiveId = '';
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

async function suppressBasicWikipediaAutoStart() {
  await runtimeApi.storage.local.set({ [BASIC_WIKIPEDIA_AUTO_START_SUPPRESSED_KEY]: true });
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

function managedWikipediaRecords() {
  const activeStatuses = new Set(['queued', 'downloading', 'retrying', 'paused', 'importing', 'deleting', 'error']);
  return [...wikipediaRecords()].sort((left, right) => {
    const activeDifference = Number(activeStatuses.has(right.status)) - Number(activeStatuses.has(left.status));
    const customDifference = Number(!isBasicWikipediaArchive(right)) - Number(!isBasicWikipediaArchive(left));
    return activeDifference || customDifference || Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
  });
}

function selectedIncludesImages() {
  return elements['source-form'].elements.edition.value === 'images';
}

function matchingReadyRecord() {
  const includeImages = selectedIncludesImages();
  return customWikipediaRecords().find(record => record.status === 'ready'
    && wikipediaArchiveMatchesSelection(record, {
      language: elements.language.value,
      includeImages,
    })) || null;
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

function actionButton(action, label, className, id) {
  return `<button type="button" class="${escapeHtml(className || '')}" data-action="${escapeHtml(action)}" data-id="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
}

function renderArchiveRecord(record) {
  const status = String(record.status || '');
  const percent = record.size
    ? Math.min(100, Math.round((Number(record.bytesDownloaded) || 0) / Number(record.size) * 100))
    : 0;
  const meta = [
    record.language,
    String(record.archiveDate || t('ap.date_unknown')).slice(0, 10),
    wikipediaArchiveIncludesImages(record) ? t('wl.images_title') : t('wl.text_title'),
    formatBytes(record.size),
  ].filter(Boolean).join(' · ');
  let detail;
  if (record.replacementCleanupError) {
    detail = record.replacementCleanupError;
  } else if (Array.isArray(record.replacementArchiveIds) && record.replacementArchiveIds.length) {
    detail = t('wl.finalizing');
  } else if (record.error) {
    detail = record.error;
  } else if (status === 'ready') {
    detail = t('wl.ready_detail');
  } else {
    detail = `${formatBytes(record.bytesDownloaded)} / ${formatBytes(record.size)} · ${percent}%`;
  }

  let actions = '';
  if (['queued', 'downloading', 'retrying'].includes(status)) actions += actionButton('pause', t('ap.pause'), '', record.id);
  if (status === 'paused') actions += actionButton('resume', t('ap.resume'), 'primary', record.id);
  if (record.errorKind === 'file-permission-required') actions += actionButton('reauthorize', t('ap.reauthorize'), 'primary', record.id);
  else if (status === 'error' && record.downloadUrl && record.errorKind !== 'archive-unreadable') actions += actionButton('retry', t('ap.retry'), 'primary', record.id);
  if (status === 'ready') actions += actionButton('read', t('ap.reader.open'), 'primary', record.id);
  if (status === 'ready') actions += actionButton('delete', t('ap.delete'), 'danger', record.id);
  else if (status === 'importing' && record.id === importArchiveId) actions += actionButton('cancel-import', t('ap.cancel'), 'danger', record.id);
  else if (status !== 'deleting') actions += actionButton('stop', t('st.providers.webgpu_download.stop'), 'danger', record.id);

  return `<article class="archive-record" data-archive-id="${escapeHtml(record.id)}">
    <div class="current-heading">
      <h3>${escapeHtml(record.title || record.filename || t('wl.current_fallback'))}</h3>
      <span class="current-status" data-status="${escapeHtml(status)}">${escapeHtml(t(`ap.status.${status}`))}</span>
    </div>
    <p class="current-meta">${escapeHtml(meta)}</p>
    <progress max="100" value="${percent}"${['ready', 'deleting'].includes(status) ? ' hidden' : ''}></progress>
    <p class="current-detail">${escapeHtml(detail)}</p>
    <div class="current-actions">${actions}</div>
  </article>`;
}

function renderCurrentRecords(records) {
  elements['current-source'].hidden = records.length === 0;
  elements['archive-list'].innerHTML = records.map(renderArchiveRecord).join('');
}

function render() {
  const enabled = snapshot?.enabled === true;
  const records = managedWikipediaRecords();
  const activeTransfer = records.some(record => ['queued', 'downloading', 'retrying', 'paused', 'importing', 'deleting'].includes(record.status));
  const alreadyReady = matchingReadyRecord();
  elements['mode-status'].textContent = t(enabled ? 'wl.mode_on' : 'wl.mode_off');
  elements['mode-status'].dataset.kind = enabled ? 'ready' : 'disabled';
  elements.download.disabled = !enabled || busy || Boolean(activeTransfer) || Boolean(alreadyReady);
  elements.download.textContent = t(busy ? 'wl.preparing_button' : alreadyReady ? 'wl.already_ready' : 'wl.download');
  elements['import-button'].disabled = !enabled || busy || importBusy;
  elements['import-file'].disabled = !enabled || busy || importBusy;
  elements['replacement-note'].hidden = wikipediaRecords().every(recordItem => !isSimpleEnglishWikipediaArchive(recordItem));
  renderCurrentRecords(records);
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
    const item = selectWikipediaArchiveVariant(result.items, {
      language: elements.language.value,
      includeImages,
    });
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

async function reviewImport(file, external) {
  const inspected = await openKiwixZim(file, {
    language: elements['import-language'].value,
    source: t('ap.import.source'),
    license: t('ap.import.license'),
    licenseDeclared: false,
  });
  assertWikipediaZimArchive(inspected.embeddedMetadata);
  const provenance = inspected.metadata;
  const capacity = normalizeStorageEstimate(external || typeof importStorage.estimate !== 'function'
    ? {}
    : await importStorage.estimate());
  if (!external && capacity.known && file.size > capacity.free) {
    throw new Error(t('ap.space.insufficient', {
      required: formatBytes(file.size),
      available: formatBytes(capacity.free),
    }));
  }
  const storageMessage = external
    ? t('ap.space.external_retained')
    : capacity.known ? t('ap.space.available', { size: formatBytes(capacity.free) }) : t('ap.space.unknown');
  return globalThis.confirm(t('ap.confirm_import', {
    title: file.name,
    size: formatBytes(file.size),
    date: provenance.archiveDate || t('ap.date_unknown'),
    language: provenance.language,
    source: provenance.source,
    license: provenance.license,
    storage: storageMessage,
  })) ? provenance : null;
}

function beginImport(cancelable) {
  importBusy = true;
  elements['cancel-import'].hidden = !cancelable;
  render();
}

function finishImport() {
  importBusy = false;
  importController = null;
  importArchiveId = '';
  elements['cancel-import'].hidden = true;
  elements['import-file'].value = '';
  render();
}

async function importExternalArchive() {
  beginImport(false);
  try {
    const [handle] = await globalThis.showOpenFilePicker({
      multiple: false,
      types: [{ description: t('ap.file_description'), accept: { 'application/x-zim': ['.zim'] } }],
    });
    await authorizeFileHandle(handle, 'read');
    const file = await handle.getFile();
    const provenance = await reviewImport(file, true);
    if (!provenance) {
      setNotice(t('ap.import_cancelled'));
      return;
    }
    const record = await registerKiwixArchiveHandle(handle, {
      filename: handle.name,
      title: handle.name.replace(/\.zim$/i, ''),
      ...provenance,
    }, { store: archiveStore });
    fileHandles.set(record.id, handle);
    await refresh();
    setNotice(t('ap.imported'), 'success');
  } catch (error) {
    const cancelled = error?.name === 'AbortError';
    setNotice(cancelled ? t('ap.import_cancelled') : error.message, cancelled ? '' : 'error');
  } finally {
    finishImport();
  }
}

async function importCopiedArchive(file) {
  if (!file || importBusy) return;
  if (snapshot?.enabled !== true) {
    setNotice(t('ap.enable_import'), 'error');
    elements['import-file'].value = '';
    return;
  }
  beginImport(true);
  importController = new AbortController();
  importArchiveId = globalThis.crypto.randomUUID();
  try {
    const provenance = await reviewImport(file, false);
    if (!provenance) {
      setNotice(t('ap.import_cancelled'));
      return;
    }
    await importKiwixArchive(file, {
      filename: file.name,
      title: file.name.replace(/\.zim$/i, ''),
      ...provenance,
    }, {
      id: importArchiveId,
      store: archiveStore,
      storage: importStorage,
      signal: importController.signal,
    });
    await refresh();
    setNotice(t('ap.imported'), 'success');
  } catch (error) {
    const cancelled = error?.name === 'AbortError';
    setNotice(cancelled ? t('ap.import_cancelled') : error.message, cancelled ? '' : 'error');
  } finally {
    finishImport();
  }
}

async function chooseLocalArchive() {
  if (importBusy || busy) return;
  if (snapshot?.enabled !== true) {
    setNotice(t('ap.enable_import'), 'error');
    return;
  }
  if (typeof globalThis.showOpenFilePicker === 'function') {
    await importExternalArchive();
    return;
  }
  elements['import-file'].click();
}

async function runArchiveAction(action, id, button) {
  const record = wikipediaRecords().find(item => item.id === id);
  if (!record) return;
  if (action === 'read') return openReader(record.id);
  if (action === 'cancel-import') {
    importController?.abort();
    button.disabled = true;
    return;
  }
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
    if (removesArchive && isBasicWikipediaArchive(record)) await suppressBasicWikipediaAutoStart();
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
elements['import-button'].addEventListener('click', () => { void chooseLocalArchive(); });
elements['import-file'].addEventListener('change', () => {
  void importCopiedArchive(elements['import-file'].files?.[0]);
});
elements['cancel-import'].addEventListener('click', () => importController?.abort());
elements['archive-list'].addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (button) void runArchiveAction(button.dataset.action, button.dataset.id, button);
});
document.addEventListener('wb-locale-changed', render);
globalThis.addEventListener('focus', () => refresh().catch(error => setNotice(error.message, 'error')));

await refresh().catch(error => setNotice(error.message, 'error'));
setInterval(poll, 2_000);
