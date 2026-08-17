import { createEmergencyBoxStorage, createEmergencyBoxStore } from '../agent/emergency-box.js';
import { createEmergencyPdfTextSearch } from './emergency-pdf-search.js';
import { t } from './i18n.js';
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

const store = createEmergencyBoxStore();
const storage = createEmergencyBoxStorage();
const elements = Object.fromEntries([
  'document-title', 'offline-badge', 'document-source', 'save-copy', 'previous-page', 'page-number', 'page-count',
  'next-page', 'zoom-out', 'fit-width', 'zoom-in', 'search-form', 'document-search', 'fullscreen',
  'document-stage', 'reader-message', 'pdf-canvas', 'reader-status',
].map(id => [id, document.getElementById(id)]));

let record = null;
let file = null;
let pdf = null;
let pageNumber = 1;
let requestedPageNumber = 1;
let scale = 1.15;
let fitWidth = true;
let renderTask = null;
let renderSequence = 0;
let pageRequestSequence = 0;
let resizeTimer = null;
const textCache = new Map();
const textSearch = createEmergencyPdfTextSearch();

function setMessage(message, kind = '') {
  elements['reader-message'].hidden = false;
  elements['reader-message'].dataset.kind = kind;
  elements['reader-message'].textContent = message;
  elements['pdf-canvas'].hidden = true;
}

function setStatus(message = '', kind = '') {
  elements['reader-status'].textContent = message;
  elements['reader-status'].dataset.kind = kind;
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function safeFilename(value) {
  const name = String(value || 'emergency-document').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 120);
  return `${name || 'emergency-document'}.pdf`;
}

function enableControls() {
  for (const control of document.querySelectorAll('.reader-toolbar button, .reader-toolbar input, #save-copy')) {
    control.disabled = false;
  }
  updatePageControls();
}

function updatePageControls() {
  if (!pdf) return;
  elements['page-number'].value = String(pageNumber);
  elements['page-count'].textContent = String(pdf.numPages);
  elements['previous-page'].disabled = pageNumber <= 1;
  elements['next-page'].disabled = pageNumber >= pdf.numPages;
}

function cancelRender() {
  renderSequence += 1;
  const pendingTask = renderTask;
  renderTask = null;
  try { pendingTask?.cancel?.(); } catch { /* a completed render cannot be cancelled */ }
}

function cancelPendingResize() {
  clearTimeout(resizeTimer);
  resizeTimer = null;
}

async function renderPage(targetPageNumber = pageNumber, isCurrent = () => true) {
  if (!pdf || !isCurrent()) return false;
  const targetPage = Math.max(1, Math.min(pdf.numPages, Math.floor(Number(targetPageNumber) || 1)));
  cancelRender();
  const sequence = renderSequence;
  let page;
  try {
    page = await pdf.getPage(targetPage);
  } catch (error) {
    if (sequence !== renderSequence || !isCurrent()) return false;
    throw error;
  }
  if (sequence !== renderSequence || !isCurrent()) return false;
  let renderScale = scale;
  if (fitWidth) {
    const natural = page.getViewport({ scale: 1 });
    renderScale = Math.max(.5, Math.min(3, (elements['document-stage'].clientWidth - 56) / natural.width));
  }
  const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1);
  const cssViewport = page.getViewport({ scale: renderScale });
  const renderViewport = page.getViewport({ scale: renderScale * pixelRatio });
  // Keep superseded renders from clearing or partially painting the committed page.
  const renderCanvas = document.createElement('canvas');
  renderCanvas.width = Math.floor(renderViewport.width);
  renderCanvas.height = Math.floor(renderViewport.height);
  const context = renderCanvas.getContext('2d', { alpha: false });
  const task = page.render({ canvasContext: context, viewport: renderViewport });
  renderTask = task;
  try {
    await task.promise;
  } catch (error) {
    if (error?.name === 'RenderingCancelledException' || sequence !== renderSequence || !isCurrent()) return false;
    throw error;
  } finally {
    if (renderTask === task) renderTask = null;
  }
  if (sequence !== renderSequence || !isCurrent()) return false;
  const canvas = elements['pdf-canvas'];
  canvas.width = renderCanvas.width;
  canvas.height = renderCanvas.height;
  canvas.style.width = `${Math.floor(cssViewport.width)}px`;
  canvas.style.height = `${Math.floor(cssViewport.height)}px`;
  canvas.getContext('2d', { alpha: false }).drawImage(renderCanvas, 0, 0);
  pageNumber = targetPage;
  requestedPageNumber = targetPage;
  scale = renderScale;
  elements['reader-message'].hidden = true;
  canvas.hidden = false;
  canvas.setAttribute('aria-label', t('ep.page_aria', { page: targetPage, total: pdf.numPages }));
  updatePageControls();
  setStatus(t('ep.page_status', { page: targetPage, total: pdf.numPages, zoom: Math.round(scale * 100) }));
  elements['document-stage'].scrollTo({ top: 0, left: 0 });
  return true;
}

async function goToPage(value) {
  if (!pdf) return false;
  const request = ++pageRequestSequence;
  const isCurrent = () => request === pageRequestSequence;
  const next = Math.max(1, Math.min(pdf.numPages, Math.floor(Number(value) || 1)));
  requestedPageNumber = next;
  try {
    const rendered = await renderPage(next, isCurrent);
    if (!rendered && isCurrent() && requestedPageNumber === next) requestedPageNumber = pageNumber;
    return rendered;
  } catch (error) {
    if (isCurrent() && requestedPageNumber === next) requestedPageNumber = pageNumber;
    throw error;
  }
}

function requestPage(value) {
  cancelPendingResize();
  textSearch.cancel();
  return goToPage(value);
}

function rerenderRequestedPage() {
  cancelPendingResize();
  return goToPage(requestedPageNumber);
}

async function pageText(number) {
  if (textCache.has(number)) return textCache.get(number);
  const page = await pdf.getPage(number);
  const content = await page.getTextContent();
  const text = content.items.map(item => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
  textCache.set(number, text);
  return text;
}

async function findText(query) {
  cancelPendingResize();
  const needle = String(query || '').trim().toLocaleLowerCase();
  const pendingSearch = textSearch.find(needle, {
    pageNumber,
    numPages: pdf?.numPages || 0,
    pageText,
  });
  pageRequestSequence += 1;
  requestedPageNumber = pageNumber;
  cancelRender();
  if (pdf && needle) setStatus(t('ep.searching', { query: needle }));
  else if (pdf) setStatus(t('ep.page_status', {
    page: pageNumber, total: pdf.numPages, zoom: Math.round(scale * 100),
  }));
  const result = await pendingSearch;
  if (!pdf || !textSearch.isCurrent(result)) return;
  if (!needle) {
    await textSearch.apply(result, isCurrent => renderPage(pageNumber, isCurrent));
    return;
  }
  if (result.error) {
    const applied = await textSearch.apply(result, isCurrent => renderPage(pageNumber, isCurrent));
    if (!applied) return;
    throw result.error;
  }
  if (result.page) {
    requestedPageNumber = result.page;
    let applied;
    try {
      applied = await textSearch.apply(result, isCurrent => renderPage(result.page, isCurrent));
    } catch (error) {
      if (textSearch.isCurrent(result) && requestedPageNumber === result.page) requestedPageNumber = pageNumber;
      throw error;
    }
    if (!applied) return;
    setStatus(t('ep.found', { query: result.query, page: result.page }), 'success');
    return;
  }
  const applied = await textSearch.apply(result, isCurrent => renderPage(pageNumber, isCurrent));
  if (!applied) return;
  setStatus(t('ep.not_found', { query: result.query }), 'error');
}

async function initialize() {
  const id = new URLSearchParams(globalThis.location.search).get('id');
  if (!id) throw new Error(t('ep.missing_resource'));
  record = await store.get(id);
  if (!record || record.status !== 'ready') throw new Error(t('ep.not_installed'));
  file = await storage.open(record.storageKey || record.id);
  elements['document-title'].textContent = record.title || file.name || t('ep.document');
  elements['offline-badge'].hidden = false;
  document.title = `${record.title || t('ep.document')} — WebBrain`;
  const sourceUrl = safeExternalUrl(record.sourceUrl);
  if (sourceUrl) {
    elements['document-source'].href = sourceUrl;
    elements['document-source'].hidden = false;
  }
  const pdfjs = await import(runtimeApi.runtime.getURL('vendor/pdfjs/pdf.mjs'));
  pdfjs.GlobalWorkerOptions.workerSrc = runtimeApi.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
  pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), verbosity: 0 }).promise;
  enableControls();
  await renderPage();
}

elements['previous-page'].addEventListener('click', () => requestPage(requestedPageNumber - 1));
elements['next-page'].addEventListener('click', () => requestPage(requestedPageNumber + 1));
elements['page-number'].addEventListener('change', event => requestPage(event.target.value));
elements['zoom-out'].addEventListener('click', () => {
  fitWidth = false;
  scale = Math.max(.5, scale - .15);
  rerenderRequestedPage();
});
elements['zoom-in'].addEventListener('click', () => {
  fitWidth = false;
  scale = Math.min(3, scale + .15);
  rerenderRequestedPage();
});
elements['fit-width'].addEventListener('click', () => {
  fitWidth = true;
  rerenderRequestedPage();
});
elements['search-form'].addEventListener('submit', event => {
  event.preventDefault();
  findText(elements['document-search'].value).catch(error => setStatus(error.message, 'error'));
});
elements.fullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else elements['document-stage'].requestFullscreen?.();
});
elements['save-copy'].addEventListener('click', () => {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFilename(record?.title);
  anchor.click();
  setStatus(t('ep.exported'), 'success');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
globalThis.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === 'ArrowLeft') requestPage(requestedPageNumber - 1);
  if (event.key === 'ArrowRight') requestPage(requestedPageNumber + 1);
  if (event.key === '+' || event.key === '=') elements['zoom-in'].click();
  if (event.key === '-') elements['zoom-out'].click();
});
globalThis.addEventListener('resize', () => {
  if (!fitWidth || !pdf) return;
  cancelPendingResize();
  resizeTimer = setTimeout(rerenderRequestedPage, 120);
});

initialize().catch(error => {
  elements['document-title'].textContent = t('ep.unavailable');
  setMessage(error.message, 'error');
  setStatus(error.message, 'error');
});
