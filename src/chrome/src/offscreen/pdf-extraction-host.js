import {
  PDF_EXTRACTION_MESSAGE,
  PDF_EXTRACTION_READY_MESSAGE,
  PDF_PASSTHROUGH_MAX_BYTES,
  bytesToBase64,
  extractPdfTextFromBytes,
  fetchPdfBytes,
  isTrustedPdfExtractionSender,
  normalizePdfUrl,
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (![PDF_EXTRACTION_MESSAGE, PDF_EXTRACTION_READY_MESSAGE].includes(message?.type)) return false;
  if (!isTrustedPdfExtractionSender(sender)) {
    sendResponse({ ok: false, ready: false, error: 'Unauthorized PDF extraction sender.' });
    return false;
  }
  if (message.type === PDF_EXTRACTION_READY_MESSAGE) {
    sendResponse({ ok: true, ready: true });
    return false;
  }

  (async () => {
    const url = normalizePdfUrl(message.url);
    const bytes = await fetchPdfBytes(url);
    // PDF.js can transfer and detach the input buffer. Encode the optional
    // Claude document before parsing so text and document use the same fetch.
    const pdfBase64 = message.options?.includeBase64 === true
      && bytes.length <= PDF_PASSTHROUGH_MAX_BYTES
      ? bytesToBase64(bytes)
      : '';
    const pdfjs = await getPdfjs();
    const result = await extractPdfTextFromBytes(pdfjs, bytes, message.options || {});
    if (pdfBase64) result._pdfBase64 = pdfBase64;
    sendResponse({ ok: true, result });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });

  return true;
});
