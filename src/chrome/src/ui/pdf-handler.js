import { normalizePdfOcrResult, renderPdfOcrTextLayer } from '../agent/pdf-ocr.js';

const api = globalThis.browser || globalThis.chrome;
const elements = Object.fromEntries([
  'pdf-title', 'pdf-stage', 'pdf-status', 'pdf-pages', 'previous-page', 'page-number',
  'page-count', 'next-page', 'zoom-out', 'fit-width', 'zoom-in', 'rotate-page',
  'search-form', 'document-search', 'search-submit', 'download-pdf', 'print-pdf', 'ocr-page', 'cancel-ocr-page',
].map(id => [id, document.getElementById(id)]));

const MIN_SCALE = .5;
const MAX_SCALE = 3;
const SCALE_STEP = .15;
const PDF_VIEWER_ENABLED_KEY = 'pdfViewerEnabled';
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_PDF_PAGES = 500;

const state = {
  pdf: null,
  pdfjs: null,
  pdfBytes: null,
  streamInfo: null,
  currentPage: 1,
  requestedPage: 1,
  scale: 1.15,
  fitWidth: true,
  rotation: 0,
  pageViews: new Map(),
  textCache: new Map(),
  ocrCache: new Map(),
  textLayerCount: 0,
  ocrTextLayerCount: 0,
  ocrInFlight: false,
  ocrRequestId: null,
  renderSequence: 0,
  renderTask: null,
  searchSequence: 0,
  resizeTimer: null,
};

function setStatus(message, kind = '') {
  elements['pdf-status'].textContent = message;
  elements['pdf-status'].dataset.kind = kind;
}

async function fallbackToNative(message = '') {
  if (message) setStatus(message, 'error');
  try {
    if (api?.mimeHandler?.abortAndFallbackToNativeHandler) {
      await api.mimeHandler.abortAndFallbackToNativeHandler();
      return;
    }
    const params = new URLSearchParams(globalThis.location.search);
    const url = new URL(String(params.get('url') || ''));
    const tabIdValue = params.get('tabId');
    const tabId = tabIdValue == null ? NaN : Number(tabIdValue);
    if (['http:', 'https:'].includes(url.protocol) && Number.isInteger(tabId) && tabId >= 0) {
      await api?.tabs?.update?.(tabId, { url: url.href });
    }
  } catch {
    // Keep the actionable error visible if native fallback is unavailable.
  }
}

function clampScale(value) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(value) || 1));
}

function pageCanvasDimensions(viewport, pixelRatio) {
  return {
    width: Math.max(1, Math.floor(viewport.width * pixelRatio)),
    height: Math.max(1, Math.floor(viewport.height * pixelRatio)),
  };
}

function updatePageControls() {
  const total = state.pdf?.numPages || 0;
  elements['page-number'].value = String(state.currentPage);
  elements['page-number'].max = String(Math.max(1, total));
  elements['page-count'].textContent = total ? String(total) : '—';
  elements['previous-page'].disabled = !total || state.currentPage <= 1;
  elements['next-page'].disabled = !total || state.currentPage >= total;
  updateOcrControl();
}

function currentPageHasNativeText() {
  return !!state.pageViews.get(state.currentPage)
    ?.querySelector('.pdf-text-layer span:not([data-webbrain-ocr])');
}

function updateOcrControl() {
  const button = elements['ocr-page'];
  if (!button) return;
  const hasOcr = state.ocrCache.has(state.currentPage);
  button.hidden = currentPageHasNativeText() || hasOcr || state.ocrInFlight;
  button.disabled = !state.pdf || state.ocrInFlight;
  const cancelButton = elements['cancel-ocr-page'];
  if (cancelButton) {
    cancelButton.hidden = !state.ocrInFlight;
    cancelButton.disabled = !state.ocrInFlight;
  }
}

function enableViewerControls() {
  for (const control of document.querySelectorAll('.pdf-controls button, .pdf-controls input')) {
    control.disabled = false;
  }
  updatePageControls();
}

function cancelRender() {
  state.renderSequence += 1;
  const pendingTask = state.renderTask;
  state.renderTask = null;
  try { pendingTask?.cancel?.(); } catch { /* a completed render cannot be cancelled */ }
}

function isCurrentRender(sequence) {
  return sequence === state.renderSequence;
}

function renderScaleFor(page) {
  if (!state.fitWidth) return clampScale(state.scale);
  const naturalViewport = page.getViewport({ scale: 1, rotation: state.rotation });
  const availableWidth = Math.max(240, elements['pdf-stage'].clientWidth - 48);
  return clampScale(availableWidth / naturalViewport.width);
}

function createPageView(pageNumber, viewport) {
  const pageView = document.createElement('section');
  pageView.className = 'pdf-page';
  pageView.dataset.pageNumber = String(pageNumber);
  pageView.style.width = `${Math.ceil(viewport.width)}px`;
  pageView.style.height = `${Math.ceil(viewport.height)}px`;
  pageView.setAttribute('aria-label', `PDF page ${pageNumber} of ${state.pdf.numPages}`);

  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  canvas.setAttribute('aria-label', `PDF page ${pageNumber}`);

  const textLayer = document.createElement('div');
  textLayer.className = 'pdf-text-layer textLayer';
  textLayer.style.width = `${Math.ceil(viewport.width)}px`;
  textLayer.style.height = `${Math.ceil(viewport.height)}px`;
  pageView.append(canvas, textLayer);
  elements['pdf-pages'].append(pageView);
  state.pageViews.set(pageNumber, pageView);
  return { pageView, canvas, textLayer };
}

async function renderPage(pageNumber, sequence) {
  if (!isCurrentRender(sequence)) return false;
  const page = await state.pdf.getPage(pageNumber);
  if (!isCurrentRender(sequence)) return false;
  const renderScale = renderScaleFor(page);
  const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale: renderScale, rotation: state.rotation });
  const renderViewport = page.getViewport({ scale: renderScale * pixelRatio, rotation: state.rotation });
  const { pageView, canvas, textLayer } = createPageView(pageNumber, viewport);
  const dimensions = pageCanvasDimensions(viewport, pixelRatio);
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  canvas.style.width = `${Math.ceil(viewport.width)}px`;
  canvas.style.height = `${Math.ceil(viewport.height)}px`;
  const context = canvas.getContext('2d', { alpha: false });
  const task = page.render({ canvasContext: context, viewport: renderViewport });
  state.renderTask = task;
  try {
    await task.promise;
  } catch (error) {
    if (error?.name === 'RenderingCancelledException' || !isCurrentRender(sequence)) return false;
    throw error;
  } finally {
    if (state.renderTask === task) state.renderTask = null;
  }
  if (!isCurrentRender(sequence)) return false;

  const layer = new state.pdfjs.TextLayer({
    textContentSource: page.streamTextContent(),
    container: textLayer,
    viewport,
  });
  await layer.render();
  if (!isCurrentRender(sequence)) return false;
  if (textLayer.querySelector('span')) {
    state.textLayerCount += 1;
  } else {
    const ocrLines = state.ocrCache.get(pageNumber);
    const rendered = renderPdfOcrTextLayer(textLayer, ocrLines, viewport.width, viewport.height);
    if (rendered) state.ocrTextLayerCount += 1;
  }
  return pageView;
}

async function renderAllPages() {
  if (!state.pdf) return false;
  const sequence = ++state.renderSequence;
  state.textLayerCount = 0;
  state.ocrTextLayerCount = 0;
  state.pageViews.clear();
  elements['pdf-pages'].replaceChildren();
  setStatus(`Rendering ${state.pdf.numPages} pages…`);
  for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber++) {
    const pageView = await renderPage(pageNumber, sequence);
    if (!pageView || !isCurrentRender(sequence)) return false;
  }
  if (!isCurrentRender(sequence)) return false;
  state.scale = renderScaleFor(await state.pdf.getPage(state.currentPage));
  updatePageControls();
  const target = state.pageViews.get(state.requestedPage);
  target?.scrollIntoView({ block: 'start' });
  if (state.textLayerCount === 0 && state.ocrTextLayerCount === 0) {
    setStatus(`Loaded ${state.pdf.numPages} pages; this PDF has no selectable text. Use OCR on the current page when a vision model is available.`, 'warning');
  } else {
    setStatus(`Page ${state.currentPage} of ${state.pdf.numPages} · ${Math.round(state.scale * 100)}%`);
  }
  updateOcrControl();
  return true;
}

function setCurrentPage(pageNumber) {
  const total = state.pdf?.numPages || 1;
  state.currentPage = Math.max(1, Math.min(total, Math.floor(Number(pageNumber) || 1)));
  updatePageControls();
}

function setPageStatus() {
  if (!state.pdf) return;
  setStatus(`Page ${state.currentPage} of ${state.pdf.numPages} · ${Math.round(state.scale * 100)}%`);
}

function scrollToPage(pageNumber) {
  setCurrentPage(pageNumber);
  state.requestedPage = state.currentPage;
  state.pageViews.get(state.currentPage)?.scrollIntoView({ block: 'start' });
  setPageStatus();
}

function updateCurrentPageFromScroll() {
  if (!state.pageViews.size) return;
  const stageTop = elements['pdf-stage'].getBoundingClientRect().top;
  let closestPage = state.currentPage;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const [pageNumber, pageView] of state.pageViews) {
    const distance = Math.abs(pageView.getBoundingClientRect().top - stageTop - 12);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestPage = pageNumber;
    }
  }
  if (closestPage !== state.currentPage) {
    setCurrentPage(closestPage);
    setPageStatus();
  }
}

async function ocrCurrentPage() {
  const pageNumber = state.currentPage;
  const pageView = state.pageViews.get(pageNumber);
  const canvas = pageView?.querySelector('.pdf-canvas');
  if (!state.pdf || !pageView || !canvas || !Number.isInteger(state.streamInfo?.tabId) || state.streamInfo.tabId < 0 || state.ocrInFlight) return;
  setStatus(`Capturing page ${pageNumber} for OCR…`);
  let imageDataUrl;
  try {
    imageDataUrl = canvas.toDataURL('image/png');
  } catch (error) {
    setStatus(`OCR could not capture page ${pageNumber}: ${error?.message || String(error)}`, 'error');
    return;
  }

  state.ocrInFlight = true;
  const requestId = `pdf-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.ocrRequestId = requestId;
  updateOcrControl();
  setStatus(`Reading text from page ${pageNumber} with OCR…`);
  try {
    const response = await api.runtime.sendMessage({
      target: 'background',
      action: 'ocr_pdf_page',
      requestId,
      tabId: state.streamInfo.tabId,
      originalUrl: String(state.streamInfo.originalUrl || ''),
      pageNumber,
      imageDataUrl,
    });
    if (state.ocrRequestId !== requestId) return;
    if (!response?.success) {
      throw new Error(response?.error || 'No OCR result was returned.');
    }
    const result = normalizePdfOcrResult(response);
    if (!result.success) throw new Error(result.error);
    setStatus(`Applying OCR to page ${pageNumber}…`);
    const wasCached = state.ocrCache.has(pageNumber);
    state.ocrCache.set(pageNumber, result.lines);
    const textLayer = pageView.querySelector('.pdf-text-layer');
    const rendered = renderPdfOcrTextLayer(textLayer, result.lines, pageView.clientWidth, pageView.clientHeight);
    if (!wasCached && rendered) state.ocrTextLayerCount += 1;
    setStatus(`OCR added ${rendered} text lines on page ${pageNumber}. Select the text to use WebBrain actions.`, 'success');
  } catch (error) {
    if (state.ocrRequestId === requestId) {
      setStatus(`OCR failed on page ${pageNumber}: ${error?.message || String(error)}`, 'error');
    }
  } finally {
    if (state.ocrRequestId === requestId) {
      state.ocrRequestId = null;
      state.ocrInFlight = false;
      updateOcrControl();
    }
  }
}

function cancelOcrRequest() {
  const requestId = state.ocrRequestId;
  if (!requestId) return false;
  state.ocrRequestId = null;
  state.ocrInFlight = false;
  setStatus('OCR cancelled.', 'warning');
  updateOcrControl();
  api.runtime.sendMessage({
    target: 'background',
    action: 'cancel_pdf_ocr',
    requestId,
  }).catch(() => {});
  return true;
}

async function pageText(pageNumber) {
  if (state.textCache.has(pageNumber)) return state.textCache.get(pageNumber);
  const page = await state.pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = content.items.map(item => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
  state.textCache.set(pageNumber, text);
  return text;
}

async function findText(query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  const sequence = ++state.searchSequence;
  if (!needle) {
    setStatus(`Page ${state.currentPage} of ${state.pdf.numPages} · ${Math.round(state.scale * 100)}%`);
    return;
  }
  setStatus(`Searching for “${needle}”…`);
  for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber++) {
    const text = await pageText(pageNumber);
    if (sequence !== state.searchSequence) return;
    if (text.toLocaleLowerCase().includes(needle)) {
      scrollToPage(pageNumber);
      setStatus(`Found “${needle}” on page ${pageNumber} of ${state.pdf.numPages}.`, 'success');
      return;
    }
  }
  setStatus(`“${needle}” was not found in this PDF.`, 'warning');
}

function safeFilename() {
  try {
    const url = new URL(String(state.streamInfo?.originalUrl || ''));
    const candidate = decodeURIComponent(url.pathname.split('/').pop() || '').replace(/\.pdf$/i, '');
    const safe = candidate.replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 100);
    if (safe) return `${safe}.pdf`;
  } catch { /* use the generic name below */ }
  return 'webbrain-document.pdf';
}

function downloadPdf() {
  if (!state.pdfBytes) return;
  const url = URL.createObjectURL(new Blob([state.pdfBytes], { type: 'application/pdf' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFilename();
  anchor.click();
  setStatus(`Downloaded ${anchor.download}.`, 'success');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function rerender() {
  cancelRender();
  return renderAllPages();
}

elements['previous-page'].addEventListener('click', () => scrollToPage(state.currentPage - 1));
elements['next-page'].addEventListener('click', () => scrollToPage(state.currentPage + 1));
elements['page-number'].addEventListener('change', event => scrollToPage(event.target.value));
elements['zoom-out'].addEventListener('click', () => {
  state.fitWidth = false;
  state.scale = clampScale(state.scale - SCALE_STEP);
  rerender().catch(error => fallbackToNative(`WebBrain could not zoom this PDF: ${error?.message || String(error)}`));
});
elements['zoom-in'].addEventListener('click', () => {
  state.fitWidth = false;
  state.scale = clampScale(state.scale + SCALE_STEP);
  rerender().catch(error => fallbackToNative(`WebBrain could not zoom this PDF: ${error?.message || String(error)}`));
});
elements['fit-width'].addEventListener('click', () => {
  state.fitWidth = true;
  rerender().catch(error => fallbackToNative(`WebBrain could not fit this PDF: ${error?.message || String(error)}`));
});
elements['rotate-page'].addEventListener('click', () => {
  cancelOcrRequest();
  state.rotation = (state.rotation + 90) % 360;
  state.ocrCache.clear();
  rerender().catch(error => fallbackToNative(`WebBrain could not rotate this PDF: ${error?.message || String(error)}`));
});
elements['search-form'].addEventListener('submit', event => {
  event.preventDefault();
  findText(elements['document-search'].value).catch(error => setStatus(`Search failed: ${error?.message || String(error)}`, 'error'));
});
elements['download-pdf'].addEventListener('click', downloadPdf);
elements['print-pdf'].addEventListener('click', () => globalThis.print());
elements['ocr-page'].addEventListener('click', () => ocrCurrentPage());
elements['cancel-ocr-page'].addEventListener('click', () => cancelOcrRequest());
elements['pdf-stage'].addEventListener('scroll', updateCurrentPageFromScroll, { passive: true });
globalThis.addEventListener('resize', () => {
  if (!state.pdf || !state.fitWidth) return;
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(() => {
    rerender().catch(error => fallbackToNative(`WebBrain could not resize this PDF: ${error?.message || String(error)}`));
  }, 120);
});
globalThis.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === 'ArrowLeft') scrollToPage(state.currentPage - 1);
  if (event.key === 'ArrowRight') scrollToPage(state.currentPage + 1);
  if (event.key === '+' || event.key === '=') elements['zoom-in'].click();
  if (event.key === '-') elements['zoom-out'].click();
});

async function initialize() {
  const explicitUrl = (() => {
    try {
      const value = new URLSearchParams(globalThis.location.search).get('url');
      const url = new URL(String(value || ''));
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  })();
  const explicitTabIdValue = new URLSearchParams(globalThis.location.search).get('tabId');
  const explicitTabId = explicitTabIdValue == null ? NaN : Number(explicitTabIdValue);
  const explicitViewer = Boolean(explicitUrl && Number.isInteger(explicitTabId) && explicitTabId >= 0);
  const hasMimeHandler = typeof api?.mimeHandler?.getStreamInfo === 'function';
  if (!explicitViewer && !hasMimeHandler) {
    throw new Error('Chrome PDF MIME handler API is unavailable. Use the explicit WebBrain PDF viewer entry instead.');
  }
  if (!explicitViewer) {
    const stored = await api.storage.local.get({ [PDF_VIEWER_ENABLED_KEY]: false });
    if (stored?.[PDF_VIEWER_ENABLED_KEY] !== true) {
      await fallbackToNative();
      return;
    }
  }
  const streamInfo = explicitViewer
    ? { streamUrl: explicitUrl, tabId: explicitTabId, originalUrl: explicitUrl, embedded: false }
    : await api.mimeHandler.getStreamInfo();
  if (!streamInfo?.streamUrl || !Number.isInteger(streamInfo.tabId)) {
    throw new Error('No readable PDF stream was provided. Open an online PDF or use the explicit WebBrain PDF viewer link.');
  }
  state.streamInfo = streamInfo;
  if (streamInfo.embedded === true) document.body.dataset.embedded = 'true';
  elements['pdf-title'].textContent = String(streamInfo.originalUrl || 'WebBrain PDF');
  globalThis.__webbrainSelectionShortcutConfig = {
    submitMessage: 'WB_PDF_SELECTION_SHORTCUT_SUBMIT',
    submitFields: {
      tabId: streamInfo.tabId,
      originalUrl: String(streamInfo.originalUrl || ''),
    },
    allowNestedFrame: true,
  };
  await import(api.runtime.getURL('src/content/selection-shortcut.js'));

  const response = await fetch(streamInfo.streamUrl, { credentials: 'include' });
  if (!response.ok) throw new Error(`Chrome PDF stream returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
    throw new Error('This PDF is larger than the WebBrain viewer limit.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error('Chrome returned an empty PDF stream.');
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error('This PDF is larger than the WebBrain viewer limit.');
  state.pdfBytes = bytes;

  state.pdfjs = await import(api.runtime.getURL('vendor/pdfjs/pdf.mjs'));
  state.pdfjs.GlobalWorkerOptions.workerSrc = api.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
  state.pdf = await state.pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  if (state.pdf.numPages > MAX_PDF_PAGES) {
    throw new Error(`This PDF has more than ${MAX_PDF_PAGES} pages, so Chrome's native viewer will be used.`);
  }
  enableViewerControls();
  await renderAllPages();
}

initialize().catch(error => {
  fallbackToNative(`WebBrain could not render this PDF: ${error?.message || String(error)}`);
});
