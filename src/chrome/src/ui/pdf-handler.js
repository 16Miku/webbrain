const api = globalThis.browser || globalThis.chrome;
const status = document.getElementById('pdf-status');
const pages = document.getElementById('pdf-pages');

function setStatus(message, kind = '') {
  status.textContent = message;
  status.dataset.kind = kind;
}

async function fallbackToNative(message) {
  setStatus(message, 'error');
  try {
    await api?.mimeHandler?.abortAndFallbackToNativeHandler?.();
  } catch {
    // Keep the actionable error visible if native fallback is unavailable.
  }
}

function pageCanvasDimensions(viewport, pixelRatio) {
  return {
    width: Math.max(1, Math.floor(viewport.width * pixelRatio)),
    height: Math.max(1, Math.floor(viewport.height * pixelRatio)),
  };
}

async function renderFirstPage(pdfjs, pdf) {
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1.15 });
  const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  const dimensions = pageCanvasDimensions(viewport, pixelRatio);
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  canvas.style.width = `${Math.ceil(viewport.width)}px`;
  canvas.style.height = `${Math.ceil(viewport.height)}px`;
  const context = canvas.getContext('2d', { alpha: false });

  const textLayer = document.createElement('div');
  textLayer.className = 'pdf-text-layer textLayer';
  textLayer.style.width = `${Math.ceil(viewport.width)}px`;
  textLayer.style.height = `${Math.ceil(viewport.height)}px`;

  const pageView = document.createElement('section');
  pageView.className = 'pdf-page';
  pageView.style.width = `${Math.ceil(viewport.width)}px`;
  pageView.style.height = `${Math.ceil(viewport.height)}px`;
  pageView.dataset.pageNumber = '1';
  pageView.setAttribute('aria-label', `PDF page 1 of ${pdf.numPages}`);
  pageView.append(canvas, textLayer);
  pages.replaceChildren(pageView);

  await page.render({
    canvasContext: context,
    viewport: page.getViewport({ scale: 1.15 * pixelRatio }),
  }).promise;

  const layer = new pdfjs.TextLayer({
    textContentSource: page.streamTextContent(),
    container: textLayer,
    viewport,
  });
  await layer.render();
  setStatus(`Page 1 of ${pdf.numPages}`);
}

async function initialize() {
  if (!api?.mimeHandler?.getStreamInfo) {
    throw new Error('This Chrome version does not expose the PDF handler API.');
  }
  const streamInfo = await api.mimeHandler.getStreamInfo();
  if (!streamInfo?.streamUrl || !Number.isInteger(streamInfo.tabId)) {
    throw new Error('Chrome did not provide a readable PDF stream.');
  }

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

  const pdfjs = await import(api.runtime.getURL('vendor/pdfjs/pdf.mjs'));
  pdfjs.GlobalWorkerOptions.workerSrc = api.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
  const pdf = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  await renderFirstPage(pdfjs, pdf);
}

initialize().catch(error => {
  fallbackToNative(`WebBrain could not render this PDF: ${error?.message || String(error)}`);
});
