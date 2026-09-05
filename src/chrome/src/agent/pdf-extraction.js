/**
 * Browser-neutral PDF fetching and text extraction helpers.
 *
 * PDF.js itself is loaded by an extension page, not by the MV3 service
 * worker. Keeping the extraction loop here lets the offscreen host own the
 * browser-only PDF.js runtime while the agent facade remains lightweight.
 */

export const PDF_EXTRACTION_MESSAGE = 'offscreen-pdf-extract';

export async function fetchPdfBytes(url, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, { credentials: 'include', signal: controller.signal });
    } catch (error) {
      if (typeof url === 'string' && url.startsWith('file://')) {
        throw new Error(
          'Cannot fetch local PDF from a file:// URL. WebBrain needs ' +
          'file-URL access in Chrome: open chrome://extensions, find ' +
          'WebBrain, click "Details", and enable "Allow access to file URLs". ' +
          'Then reload the PDF tab and try read_pdf again.'
        );
      }
      throw new Error(`PDF fetch failed: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`PDF fetch returned HTTP ${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export async function extractPdfTextFromBytes(pdfjs, bytes, opts = {}) {
  const fromPage = Math.max(1, Math.floor(opts.fromPage || 1));
  const requestedTo = opts.toPage ? Math.floor(opts.toPage) : fromPage + 49;
  const maxChars = Math.max(1000, Math.floor(opts.maxChars || 50000));

  const loadingTask = pdfjs.getDocument({
    data: bytes,
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;

  const totalPages = pdf.numPages;
  const startPage = Math.min(fromPage, totalPages);
  const endPage = Math.min(totalPages, Math.max(startPage, requestedTo));

  let title = '';
  try {
    const meta = await pdf.getMetadata();
    title = meta?.info?.Title || '';
  } catch { /* metadata is best-effort */ }

  const pages = [];
  let charCount = 0;
  let truncated = false;
  let lastRead = startPage - 1;

  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items
      .map(item => (item && typeof item.str === 'string' ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (charCount + pageText.length > maxChars) {
      const remaining = Math.max(0, maxChars - charCount);
      pages.push(pageText.slice(0, remaining) + '… [page truncated, use read_pdf with fromPage to read more]');
      lastRead = pageNumber;
      truncated = true;
      page.cleanup?.();
      break;
    }

    pages.push(pageText);
    charCount += pageText.length;
    lastRead = pageNumber;
    page.cleanup?.();
  }

  return {
    success: true,
    title,
    totalPages,
    fromPage: startPage,
    toPage: lastRead,
    pageCount: pages.length,
    pages,
    hasExtractableText: pages.join('\n').length > 100,
    truncated,
    byteLength: bytes.length,
  };
}
