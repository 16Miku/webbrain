/**
 * PDF reading for the agent.
 *
 * Why a separate module: Chrome's PDF viewer is a `chrome-extension://`
 * page that our content scripts cannot inject into, so click /
 * read_page / get_accessibility_tree all silently no-op against
 * PDF tabs. The agent ends up clicking around the viewer's chrome
 * indefinitely (see the qwen3.6-27b lease trace from 2026-05-04 —
 * 17 steps, 184 seconds, 345k input tokens, no progress).
 *
 * What this module does instead: fetches the PDF binary from the
 * tab URL via plain `fetch()`, parses it with the bundled pdfjs-dist
 * library, and returns per-page text. Works with all model providers
 * (text-only too) — the LLM gets readable text instead of being
 * stuck in a viewer-navigation loop.
 *
 * Tier 2 ("Claude passthrough"): when the active provider is
 * Anthropic, we ALSO attach the raw PDF bytes as a `document` content
 * block on a follow-up user message. Claude's API natively
 * understands PDF documents, so the model gets the full layout +
 * embedded images, not just plain text. The text extraction still
 * happens (tool result must be a string), the document attachment is
 * additional context.
 */

import { ensureOffscreen } from '../offscreen/ensure.js';
import { PDF_EXTRACTION_MESSAGE, fetchPdfBytes } from './pdf-extraction.js';

/**
 * Cheap byte-array → base64 conversion that doesn't blow the call
 * stack on multi-MB PDFs. fromCharCode.apply has a per-call argument
 * limit (~64k in V8), so we chunk.
 */
const BASE64_MAX_INPUT_BYTES = 32 * 1024 * 1024; // 32 MB safety cap

function bytesToBase64(bytes) {
  if (bytes.length > BASE64_MAX_INPUT_BYTES) {
    throw new Error(`PDF too large for base64 conversion (${bytes.length} bytes, cap ${BASE64_MAX_INPUT_BYTES}).`);
  }
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Heuristic: does this URL look like a PDF? Used by `read_page` to
 * decide whether to redirect to `read_pdf`.
 */
export function isPdfUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.pathname.toLowerCase().endsWith('.pdf')) return true;
  // Some servers include the .pdf in a query parameter (e.g. content-disposition
  // viewers, Google Drive previews). Catch the common patterns.
  const fileParam = parsed.searchParams.get('file');
  if (fileParam && fileParam.toLowerCase().endsWith('.pdf')) return true;
  return false;
}

/**
 * Extract text from a PDF.
 *
 * Returns:
 *   {
 *     success, title, totalPages, fromPage, toPage, pageCount,
 *     pages: ['page 1 text', 'page 2 text', ...],
 *     hasExtractableText, truncated, byteLength
 *   }
 *
 * `hasExtractableText` is a heuristic — a PDF that's pure scanned
 * images returns near-empty text from getTextContent(). The flag tells
 * the planner "you need a vision model for this PDF" without us
 * having to render every page to PNG ourselves.
 */
export async function extractPdfText(url, opts = {}) {
  await ensureOffscreen();
  const extraction = chrome.runtime.sendMessage({
    type: PDF_EXTRACTION_MESSAGE,
    url,
    options: {
      fromPage: opts.fromPage,
      toPage: opts.toPage,
      maxChars: opts.maxChars,
    },
  }).then((response) => {
    if (!response?.ok || !response.result) {
      throw new Error(response?.error || 'The offscreen PDF parser returned no result.');
    }
    return response.result;
  });

  // Only Claude-compatible providers need the original bytes. Keeping this
  // fetch in the service worker avoids sending multi-megabyte binary payloads
  // through extension messaging for every normal PDF read.
  const rawBytes = opts.includeBytes === true
    ? fetchPdfBytes(url)
    : Promise.resolve(null);
  const [result, bytes] = await Promise.all([extraction, rawBytes]);
  if (bytes) result._pdfBytes = bytes;
  return result;
}

/**
 * Whether the given provider can natively consume PDFs as a
 * `document` content block. Currently Anthropic only — OpenAI's
 * gpt-4o has its own PDF API surface (file-uploads + references)
 * that's a different shape, not portable from the Anthropic format,
 * so we keep that for a future iteration.
 */
export function providerSupportsPdfPassthrough(provider) {
  if (!provider) return false;
  const className = provider.constructor?.name || '';
  if (className === 'AnthropicProvider') return true;
  // Some users route Claude through OpenAI-compatible endpoints; the
  // model name is the only signal there.
  const model = (provider.config?.model || '').toLowerCase();
  if (className === 'OpenAICompatibleProvider' && model.includes('claude')) return true;
  return false;
}

/**
 * Build the `document` content block for the Anthropic Messages API
 * from raw PDF bytes. Caller is responsible for size-checking — Claude's
 * cap is ~32 MB base64 / ~24 MB binary as of writing, but we cap
 * lower (16 MB binary) to leave room for the rest of the conversation.
 */
export function buildClaudeDocumentBlock(bytes, name) {
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: bytesToBase64(bytes),
    },
    ...(name ? { title: name } : {}),
  };
}

export const PDF_PASSTHROUGH_MAX_BYTES = 16 * 1024 * 1024; // 16 MB
