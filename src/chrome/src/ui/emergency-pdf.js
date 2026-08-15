import { createEmergencyBoxStorage, createEmergencyBoxStore } from '../agent/emergency-box.js';
import { t } from './i18n.js';

const runtimeApi = globalThis.browser || globalThis.chrome;
const store = createEmergencyBoxStore();
const storage = createEmergencyBoxStorage();
const elements = Object.fromEntries([
  'document-title', 'document-source', 'save-copy', 'previous-page', 'page-number', 'page-count',
  'next-page', 'zoom-out', 'fit-width', 'zoom-in', 'search-form', 'document-search', 'fullscreen',
  'document-stage', 'reader-message', 'pdf-canvas', 'reader-status',
].map(id => [id, document.getElementById(id)]));

let record = null;
let file = null;
let pdf = null;
let pageNumber = 1;
let scale = 1.15;
let fitWidth = true;
let renderTask = null;
let renderSequence = 0;
let resizeTimer = null;
const textCache = new Map();

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

async function renderPage() {
  if (!pdf) return;
  const sequence = ++renderSequence;
  try { renderTask?.cancel?.(); } catch { /* a completed render cannot be cancelled */ }
  const page = await pdf.getPage(pageNumber);
  if (sequence !== renderSequence) return;
  if (fitWidth) {
    const natural = page.getViewport({ scale: 1 });
    scale = Math.max(.5, Math.min(3, (elements['document-stage'].clientWidth - 56) / natural.width));
  }
  const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1);
  const cssViewport = page.getViewport({ scale });
  const renderViewport = page.getViewport({ scale: scale * pixelRatio });
  const canvas = elements['pdf-canvas'];
  canvas.width = Math.floor(renderViewport.width);
  canvas.height = Math.floor(renderViewport.height);
  canvas.style.width = `${Math.floor(cssViewport.width)}px`;
  canvas.style.height = `${Math.floor(cssViewport.height)}px`;
  const context = canvas.getContext('2d', { alpha: false });
  renderTask = page.render({ canvasContext: context, viewport: renderViewport });
  try {
    await renderTask.promise;
  } catch (error) {
    if (error?.name === 'RenderingCancelledException') return;
    throw error;
  }
  if (sequence !== renderSequence) return;
  elements['reader-message'].hidden = true;
  canvas.hidden = false;
  canvas.setAttribute('aria-label', t('ep.page_aria', { page: pageNumber, total: pdf.numPages }));
  updatePageControls();
  setStatus(t('ep.page_status', { page: pageNumber, total: pdf.numPages, zoom: Math.round(scale * 100) }));
  elements['document-stage'].scrollTo({ top: 0, left: 0 });
}

async function goToPage(value) {
  if (!pdf) return;
  const next = Math.max(1, Math.min(pdf.numPages, Math.floor(Number(value) || 1)));
  if (next === pageNumber && !elements['pdf-canvas'].hidden) return;
  pageNumber = next;
  await renderPage();
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
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!pdf || !needle) return;
  setStatus(t('ep.searching', { query: needle }));
  const order = [];
  for (let number = pageNumber + 1; number <= pdf.numPages; number += 1) order.push(number);
  for (let number = 1; number <= pageNumber; number += 1) order.push(number);
  for (const number of order) {
    const text = await pageText(number);
    if (!text.toLocaleLowerCase().includes(needle)) continue;
    await goToPage(number);
    setStatus(t('ep.found', { query: needle, page: number }), 'success');
    return;
  }
  setStatus(t('ep.not_found', { query: needle }), 'error');
}

async function initialize() {
  const id = new URLSearchParams(globalThis.location.search).get('id');
  if (!id) throw new Error(t('ep.missing_resource'));
  record = await store.get(id);
  if (!record || record.status !== 'ready') throw new Error(t('ep.not_installed'));
  file = await storage.open(record.storageKey || record.id);
  elements['document-title'].textContent = record.title || file.name || t('ep.document');
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

elements['previous-page'].addEventListener('click', () => goToPage(pageNumber - 1));
elements['next-page'].addEventListener('click', () => goToPage(pageNumber + 1));
elements['page-number'].addEventListener('change', event => goToPage(event.target.value));
elements['zoom-out'].addEventListener('click', () => {
  fitWidth = false;
  scale = Math.max(.5, scale - .15);
  renderPage();
});
elements['zoom-in'].addEventListener('click', () => {
  fitWidth = false;
  scale = Math.min(3, scale + .15);
  renderPage();
});
elements['fit-width'].addEventListener('click', () => {
  fitWidth = true;
  renderPage();
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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
globalThis.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === 'ArrowLeft') goToPage(pageNumber - 1);
  if (event.key === 'ArrowRight') goToPage(pageNumber + 1);
  if (event.key === '+' || event.key === '=') elements['zoom-in'].click();
  if (event.key === '-') elements['zoom-out'].click();
});
globalThis.addEventListener('resize', () => {
  if (!fitWidth || !pdf) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderPage, 120);
});

initialize().catch(error => {
  elements['document-title'].textContent = t('ep.unavailable');
  setMessage(error.message, 'error');
  setStatus(error.message, 'error');
});
