import { assertWikipediaZimArchive, createApocalypseArchiveManager, createApocalypseStore, createOpfsArchiveStorage, importKiwixArchive, normalizeStorageEstimate, openKiwixZim, registerKiwixArchiveHandle, selectKiwixUpdate } from '../agent/apocalypse-mode.js';
import { t } from './i18n.js';

const runtimeApi = globalThis.browser || globalThis.chrome;
const store = createApocalypseStore();
const storage = createOpfsArchiveStorage();
const elements = Object.fromEntries([
  'enabled', 'installed-count', 'archive-bytes', 'storage-usage', 'installed', 'language', 'tier',
  'storage-target', 'external-storage-option', 'load-catalog', 'catalog', 'import-file', 'import-language', 'import-button', 'cancel-import', 'notice',
  'update-policy',
].map(id => [id, document.getElementById(id)]));
let snapshot = null;
let catalogItems = [];
let importController = null;
let polling = false;
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

function archiveButtons(record) {
  if (record.errorKind === 'file-permission-required') {
    return `<button data-action="reauthorize" data-id="${escapeHtml(record.id)}">${escapeHtml(t('ap.reauthorize'))}</button>`;
  }
  if (record.status === 'downloading' || record.status === 'queued' || record.status === 'retrying') {
    return `<button data-action="pause" data-id="${escapeHtml(record.id)}">${escapeHtml(t('ap.pause'))}</button>`;
  }
  if (record.status === 'paused') return `<button data-action="resume" data-id="${escapeHtml(record.id)}">${escapeHtml(t('ap.resume'))}</button>`;
  if (record.status === 'error' && record.downloadUrl && record.errorKind !== 'archive-unreadable') return `<button data-action="retry" data-id="${escapeHtml(record.id)}">${escapeHtml(t('ap.retry'))}</button>`;
  if (record.status === 'ready' && record.downloadUrl) return `<button data-action="update" data-id="${escapeHtml(record.id)}">${escapeHtml(t(record.updateAvailable ? 'ap.review_update' : 'ap.check_update'))}</button>`;
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
      <div class="meta">${escapeHtml(record.language)} · ${escapeHtml(t(`ap.tier.${record.tier}`))} · ${escapeHtml(record.archiveDate || t('ap.date_unknown'))} · ${bytes(record.size)} · ${escapeHtml(t(`ap.status.${record.status}`))}</div>
      ${error ? `<div class="meta" style="color:var(--bad)">${escapeHtml(error)}</div>` : ''}
      ${record.status === 'ready' ? '' : `<progress max="100" value="${progress}"></progress>`}</div>
      <div class="actions">${archiveButtons(record)}<button class="danger" data-action="delete" data-id="${escapeHtml(record.id)}">${escapeHtml(t('ap.delete'))}</button></div></article>`;
  }).join('');
}

function renderCatalog() {
  const tier = elements.tier.value;
  const items = catalogItems.filter(item => !tier || item.tier === tier);
  if (!items.length) {
    elements.catalog.innerHTML = `<div class="empty">${escapeHtml(t('ap.no_match'))}</div>`;
    return;
  }
  elements.catalog.innerHTML = items.slice(0, 80).map((item, index) => `<article class="item"><div><h3>${escapeHtml(item.title)}</h3>
    <div class="meta">${escapeHtml(item.language)} · ${escapeHtml(t(`ap.tier.${item.tier}`))} · ${escapeHtml(item.archiveDate)} · ${Number(item.articleCount || 0).toLocaleString()}</div>
    <div class="meta">${escapeHtml(t('ap.catalog.size_pending'))}</div></div>
    <div class="actions"><button class="primary" data-install="${index}">${escapeHtml(t('ap.review_install'))}</button></div></article>`).join('');
  const visible = items.slice(0, 80);
  elements.catalog.querySelectorAll('[data-install]').forEach(button => button.addEventListener('click', () => reviewInstall(visible[Number(button.dataset.install)])));
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
  renderInstalled();
}

async function reviewInstall(item) {
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
    notice(t('ap.resolving'));
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
      tier: t(`ap.tier.${download.tier}`),
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

elements.enabled.addEventListener('change', async () => {
  try {
    snapshot = await command('enable', { enabled: elements.enabled.checked });
    renderInstalled();
    notice(t(elements.enabled.checked ? 'ap.enabled_notice' : 'ap.disabled_notice'), 'success');
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

elements['load-catalog'].addEventListener('click', async () => {
  try {
    notice(t('ap.loading_catalog'));
    const result = await command('catalog', { language: elements.language.value });
    catalogItems = result.items || [];
    renderCatalog();
    notice(t('ap.loaded_catalog', { count: catalogItems.length }), 'success');
  } catch (error) { notice(error.message, 'error'); }
});
elements.tier.addEventListener('change', renderCatalog);

elements.installed.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
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
      await reviewInstall(replacement);
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
});

async function poll() {
  if (polling) return;
  polling = true;
  try {
    if ((snapshot?.archives || []).some(record => ['queued', 'downloading', 'retrying'].includes(record.status))) await command('process');
    await refresh();
  } catch { /* The next poll or persisted alarm retries. */ }
  finally { polling = false; }
}

await refresh().catch(error => notice(error.message, 'error'));
setInterval(poll, 2000);
