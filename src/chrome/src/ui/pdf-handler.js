const api = globalThis.browser || globalThis.chrome;
const elements = Object.fromEntries([
  'pdf-title', 'pdf-stage', 'pdf-status', 'pdf-pages', 'previous-page', 'page-number',
  'page-count', 'next-page', 'zoom-out', 'fit-width', 'zoom-in', 'rotate-page',
  'search-form', 'document-search', 'search-submit', 'download-pdf', 'print-pdf',
].map(id => [id, document.getElementById(id)]));

const MIN_SCALE = .5;
const MAX_SCALE = 3;
const SCALE_STEP = .15;

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
  textLayerCount: 0,
  renderSequence: 0,
  renderTask: null,
  searchSequence: 0,
  resizeTimer: null,
};

function setStatus(message, kind = '') {
  elements['pdf-status'].textContent = message;
  elements['pdf-status'].dataset.kind = kind;
}

async function fallbackToNative(message) {
  setStatus(message, 'error');
  try {
    await api?.mimeHandler?.abortAndFallbackToNativeHandler?.();
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
  if (textLayer.querySelector('span')) state.textLayerCount += 1;
  return pageView;
}

async function renderAllPages() {
  if (!state.pdf) return false;
  const sequence = ++state.renderSequence;
  state.textLayerCount = 0;
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
  if (state.textLayerCount === 0) {
    setStatus(`Loaded ${state.pdf.numPages} pages; this PDF has no selectable text.`, 'warning');
  } else {
    setStatus(`Page ${state.currentPage} of ${state.pdf.numPages} · ${Math.round(state.scale * 100)}%`);
  }
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
  state.rotation = (state.rotation + 90) % 360;
  rerender().catch(error => fallbackToNative(`WebBrain could not rotate this PDF: ${error?.message || String(error)}`));
});
elements['search-form'].addEventListener('submit', event => {
  event.preventDefault();
  findText(elements['document-search'].value).catch(error => setStatus(`Search failed: ${error?.message || String(error)}`, 'error'));
});
elements['download-pdf'].addEventListener('click', downloadPdf);
elements['print-pdf'].addEventListener('click', () => globalThis.print());
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
  if (!api?.mimeHandler?.getStreamInfo) {
    throw new Error('This Chrome version does not expose the PDF handler API.');
  }
  const streamInfo = await api.mimeHandler.getStreamInfo();
  if (!streamInfo?.streamUrl || !Number.isInteger(streamInfo.tabId)) {
    throw new Error('Chrome did not provide a readable PDF stream.');
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

  const response = await fetch(streamInfo.streamUrl);
  if (!response.ok) throw new Error(`Chrome PDF stream returned HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error('Chrome returned an empty PDF stream.');
  state.pdfBytes = bytes;

  state.pdfjs = await import(api.runtime.getURL('vendor/pdfjs/pdf.mjs'));
  state.pdfjs.GlobalWorkerOptions.workerSrc = api.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
  state.pdf = await state.pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  enableViewerControls();
  await renderAllPages();
}

initialize().catch(error => {
  fallbackToNative(`WebBrain could not render this PDF: ${error?.message || String(error)}`);
});
