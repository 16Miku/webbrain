import {
  PDF_EXTRACTION_MESSAGE,
  extractPdfTextFromBytes,
  fetchPdfBytes,
} from '../agent/pdf-extraction.js';
let pdfjsPromise = null;

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(chrome.runtime.getURL('vendor/pdfjs/pdf.mjs')).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc =
        chrome.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== PDF_EXTRACTION_MESSAGE) return false;

  (async () => {
    const url = String(message.url || '').trim();
    if (!url) throw new Error('PDF extraction requires a URL.');
    const bytes = await fetchPdfBytes(url);
    const pdfjs = await getPdfjs();
    const result = await extractPdfTextFromBytes(pdfjs, bytes, message.options || {});
    sendResponse({ ok: true, result });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });

  return true;
});
