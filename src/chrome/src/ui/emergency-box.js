import { createApocalypseStore } from '../agent/apocalypse-mode.js';
import {
  EMERGENCY_BOX_HEALTH_RESOURCES,
  createEmergencyBoxStorage,
  createEmergencyBoxStore,
  deleteEmergencyResource,
  downloadEmergencyResource,
  loadOpenStaxCatalog,
  OPENSTAX_CATALOG_SNAPSHOT_DATE,
  PREFETCHED_OPENSTAX_CATALOG,
} from '../agent/emergency-box.js';
import { t } from './i18n.js';

const runtimeApi = globalThis.browser || globalThis.chrome;
const apocalypseStore = createApocalypseStore();
const resourceStore = createEmergencyBoxStore();
const resourceStorage = createEmergencyBoxStorage();
const elements = Object.fromEntries([
  'mode-status', 'resource-count', 'installed-rail-count', 'installed-count', 'installed-bytes',
  'category-nav', 'resource-search', 'load-openstax', 'download-all', 'notice', 'resource-list',
].map(id => [id, document.getElementById(id)]));

const OPENSTAX_CACHE_KEY = 'webbrainEmergencyOpenStaxCatalog';
let apocalypseEnabled = false;
let activeFilter = 'all';
let openStaxResources = cachedOpenStaxCatalog();
let records = new Map();
let loadingOpenStax = false;
let bulkDownloading = false;
let stopBulkDownload = false;
const downloads = new Map();

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

function setNotice(message = '', kind = '') {
  elements.notice.textContent = message;
  elements.notice.dataset.kind = kind;
}

function catalogResources() {
  const resources = new Map();
  for (const item of [...EMERGENCY_BOX_HEALTH_RESOURCES, ...openStaxResources]) resources.set(item.id, item);
  for (const record of records.values()) resources.set(record.id, { ...(resources.get(record.id) || {}), ...record });
  return [...resources.values()];
}

function filteredResources() {
  const query = elements['resource-search'].value.trim().toLocaleLowerCase();
  return catalogResources()
    .filter(resource => {
      if (activeFilter === 'installed') return records.has(resource.id);
      return activeFilter === 'all' || resource.category === activeFilter;
    })
    .filter(resource => !query || [resource.title, resource.description, resource.publisher, resource.collection]
      .some(value => String(value || '').toLocaleLowerCase().includes(query)))
    .sort((a, b) => {
      const readyDifference = Number(b.status === 'ready') - Number(a.status === 'ready');
      return readyDifference || String(a.title).localeCompare(String(b.title));
    });
}

function statusLabel(status) {
  if (!status) return '';
  const known = new Set(['downloading', 'paused', 'ready', 'error']);
  return known.has(status) ? t(`eb.status.${status}`) : status;
}

function resourceActions(resource) {
  const status = resource.status || '';
  const disabled = apocalypseEnabled ? '' : ' disabled title="Enable Apocalypse Mode to download resources"';
  if (status === 'ready') {
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
          ${status === 'ready' ? `<span>${escapeHtml(formatBytes(received || total))}</span>` : ''}
          ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('eb.source'))} ↗</a>` : ''}
        </div>
        ${progress}
      </div>
      <div class="resource-actions">${resourceActions(resource)}</div>
    </article>`;
}

function render() {
  const all = catalogResources();
  const installed = [...records.values()].filter(record => record.status === 'ready');
  const installedBytes = installed.reduce((sum, record) => sum + (Number(record.bytesReceived) || Number(record.totalBytes) || 0), 0);
  elements['resource-count'].textContent = String(all.length);
  elements['installed-rail-count'].textContent = String(installed.length);
  elements['installed-count'].textContent = String(installed.length);
  elements['installed-bytes'].textContent = formatBytes(installedBytes);
  elements['mode-status'].textContent = t(apocalypseEnabled ? 'eb.mode_on' : 'eb.mode_off');
  elements['mode-status'].dataset.enabled = String(apocalypseEnabled);
  elements['load-openstax'].disabled = loadingOpenStax;

  const filtered = filteredResources();
  const pendingCount = filtered.filter(resource => resource.status !== 'ready').length;
  elements['download-all'].disabled = bulkDownloading ? false : (!apocalypseEnabled || pendingCount === 0);
  elements['download-all'].querySelector('[data-download-all-label]').textContent = t(bulkDownloading ? 'eb.stop_all' : 'eb.download_all');

  elements['resource-list'].innerHTML = filtered.length
    ? filtered.map(renderResource).join('')
    : `<div class="empty-state"><span class="empty-glyph" aria-hidden="true">□</span>${escapeHtml(t('eb.no_resources'))}</div>`;
}

async function refreshState({ recoverInterrupted = false } = {}) {
  apocalypseEnabled = (await apocalypseStore.getConfig()).enabled === true;
  const stored = await resourceStore.list();
  if (recoverInterrupted) {
    for (const record of stored) {
      if (record.status !== 'downloading') continue;
      record.status = 'paused';
      record.error = '';
      record.updatedAt = Date.now();
      await resourceStore.put(record);
    }
  }
  records = new Map((await resourceStore.list()).map(record => [record.id, record]));
  if (!apocalypseEnabled && !elements.notice.textContent) setNotice(t('eb.enable_downloads'));
  render();
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
  if (!resource || downloads.has(resource.id) || !apocalypseEnabled) return;
  if (options.confirm !== false) {
    const confirmed = globalThis.confirm(t('eb.confirm_download', {
      title: resource.title,
      publisher: resource.publisher || t('eb.unknown_publisher'),
    }));
    if (!confirmed) return;
  }
  const controller = new AbortController();
  downloads.set(resource.id, controller);
  if (options.quiet !== true) setNotice(t('eb.keep_open'));
  try {
    const record = await downloadEmergencyResource(resource, {
      store: resourceStore,
      storage: resourceStorage,
      signal: controller.signal,
      onProgress: next => {
        records.set(next.id, next);
        render();
      },
    });
    records.set(record.id, record);
    if (record.status === 'ready' && options.quiet !== true) setNotice(t('eb.download_complete', { title: record.title }), 'success');
  } catch (error) {
    if (options.quiet !== true) setNotice(error.message, 'error');
  } finally {
    downloads.delete(resource.id);
    await refreshState();
  }
}

async function downloadAllVisible() {
  if (bulkDownloading) {
    stopBulkDownload = true;
    for (const controller of downloads.values()) controller.abort();
    return;
  }
  if (!apocalypseEnabled) return;
  const pending = filteredResources().filter(resource => resource.status !== 'ready');
  if (!pending.length) return;
  if (!globalThis.confirm(t('eb.confirm_download_all', { count: pending.length }))) return;
  bulkDownloading = true;
  stopBulkDownload = false;
  render();
  let completed = 0;
  for (const resource of pending) {
    if (stopBulkDownload) break;
    setNotice(t('eb.downloading_all', { current: completed + 1, count: pending.length, title: resource.title }));
    await startDownload(resource, { confirm: false, quiet: true });
    if (records.get(resource.id)?.status === 'ready') completed += 1;
  }
  const stopped = stopBulkDownload;
  bulkDownloading = false;
  stopBulkDownload = false;
  setNotice(t(stopped ? 'eb.download_all_stopped' : 'eb.download_all_complete', { count: completed }), stopped ? '' : 'success');
  render();
}

function openReader(id) {
  const url = runtimeApi.runtime.getURL(`src/ui/emergency-pdf.html?id=${encodeURIComponent(id)}`);
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
elements['download-all'].addEventListener('click', downloadAllVisible);
elements['resource-list'].addEventListener('click', async event => {
  const button = event.target.closest('[data-action][data-id]');
  if (!button) return;
  const { action, id } = button.dataset;
  const resource = resourceById(id);
  if (action === 'download') await startDownload(resource);
  if (action === 'pause') downloads.get(id)?.abort();
  if (action === 'read') openReader(id);
  if (action === 'delete' && globalThis.confirm(t('eb.confirm_delete', { title: resource?.title || id }))) {
    downloads.get(id)?.abort();
    try {
      await deleteEmergencyResource(id, { store: resourceStore, storage: resourceStorage });
      records.delete(id);
      setNotice(t('eb.deleted'), 'success');
      render();
    } catch (error) {
      setNotice(error.message, 'error');
    }
  }
});

globalThis.addEventListener('beforeunload', () => {
  stopBulkDownload = true;
  for (const controller of downloads.values()) controller.abort();
});
globalThis.addEventListener('focus', () => refreshState().catch(error => setNotice(error.message, 'error')));
document.addEventListener('wb-locale-changed', render);

refreshState({ recoverInterrupted: true }).then(() => {
  if (!elements.notice.textContent) {
    setNotice(t('eb.openstax_prefetched', { count: openStaxResources.length, date: OPENSTAX_CATALOG_SNAPSHOT_DATE }));
  }
}).catch(error => setNotice(error.message, 'error'));
