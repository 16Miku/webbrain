/**
 * fetch_url tool — raw HTTP fetch with content-type-aware response.
 *
 * Ported from src/chrome/src/network/network-tools.js but with two
 * adaptations for LM Studio (Node host):
 *   1. No `credentials: 'include'` — we have no browser cookie jar
 *      to forward, and silently sending nothing is more honest than
 *      sending an empty cookie header.
 *   2. URL safety guard layered on top — an LLM that decides to GET
 *      http://169.254.169.254/latest/meta-data/ would happily exfil
 *      cloud-credential blobs from the user's machine; the guard
 *      blocks file://, RFC1918, link-local, and ULA targets by
 *      default. Opt out per-call with `allowPrivate: true`.
 */

import { htmlToText } from "../util/htmlToText.js";
import { safeFetch, readBodyCapped } from "../util/safeFetch.js";
import {
  compactText,
  normalizeTextLimit,
  type CompactionMetadata,
} from "../util/compactText.js";

const FETCH_TEXT_LIMIT = 8000;
const FETCH_JSON_LIMIT = 16000;
const FETCH_MAX_CHARS_CAP = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;
// Hard byte ceiling for the streamed body. Sized to comfortably fit
// the largest "useful" response while still bounding worst-case memory
// use of the plugin process. We slice down to FETCH_TEXT_LIMIT /
// FETCH_JSON_LIMIT for the model after this — the body cap exists to
// stop an attacker from streaming a gigabyte of garbage into our
// buffer before we get a chance to truncate.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MB

export interface FetchUrlArgs {
  url: string;
  /** GET (default), POST, PUT, PATCH, DELETE, HEAD, OPTIONS. */
  method?: string;
  /** Extra headers. User-Agent is set by Node automatically. */
  headers?: Record<string, string>;
  /** Request body for non-GET methods. */
  body?: string;
  /** ms; default 30 000, cap 120 000. */
  timeout?: number;
  /**
   * Allow URLs that target RFC1918 / loopback / link-local addresses.
   * Off by default to keep the LLM out of cloud-metadata services and
   * the user's intranet. Set to true only when you actually want the
   * plugin to talk to localhost/private services.
   */
  allowPrivate?: boolean;
  /**
   * Maximum characters returned in the main text/json field after compaction.
   * Defaults to 8k for text/html and 16k for JSON; capped at 50k.
   */
  maxChars?: number;
  /**
   * When true (default), long text/json is compacted with a head/middle/tail
   * extractive pass. Set false to keep legacy head-only truncation.
   */
  compact?: boolean;
}

export interface FetchUrlResult {
  success: boolean;
  /** HTTP status code, when the request reached a server. */
  status?: number;
  /** Lower-cased content-type header. */
  contentType?: string;
  /** Final URL after any redirects. */
  url?: string;
  /** Document title, when the response was HTML. */
  title?: string;
  /** Extracted text (HTML/text responses) — capped at FETCH_TEXT_LIMIT. */
  text?: string;
  /** Pretty-printed JSON (when the response was application/json). */
  json?: string;
  /** Set when text/json was clipped to a limit. */
  truncated?: boolean;
  /** True when the plugin performed extractive text compaction. */
  compacted?: boolean;
  /** Details about the compaction/truncation strategy. */
  compaction?: CompactionMetadata;
  /** Pre-clip length, so the caller knows how much they didn't get. */
  originalLength?: number;
  /** For binary responses we don't inline — bytes from Content-Length. */
  sizeBytes?: number | null;
  /** Friendly note for binary responses we declined to inline. */
  note?: string;
  /** Failure case. */
  error?: string;
}

function prepareModelText(
  raw: string,
  fallbackLimit: number,
  args: Pick<FetchUrlArgs, "maxChars" | "compact">,
  label: string,
): { text: string; compacted: boolean; compaction?: CompactionMetadata } {
  const maxChars = normalizeTextLimit(args.maxChars, fallbackLimit, FETCH_MAX_CHARS_CAP);
  if (raw.length <= maxChars) return { text: raw, compacted: false };

  if (args.compact === false) {
    const text = raw.slice(0, maxChars);
    return {
      text,
      compacted: false,
      compaction: {
        strategy: "head-truncate",
        maxChars,
        originalLength: raw.length,
        outputLength: text.length,
        omittedChars: raw.length - text.length,
      },
    };
  }

  const compacted = compactText(raw, { maxChars, label, hardCap: FETCH_MAX_CHARS_CAP });
  return {
    text: compacted.text,
    compacted: compacted.compacted,
    ...(compacted.compaction ? { compaction: compacted.compaction } : {}),
  };
}

export async function fetchUrl(args: FetchUrlArgs): Promise<FetchUrlResult> {
  if (!args?.url) return { success: false, error: "url is required" };

  const timeoutMs = Math.min(
    Math.max(args.timeout ?? DEFAULT_TIMEOUT_MS, 1000),
    120_000,
  );
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // safeFetch handles: URL guard → DNS check → manual redirect loop
    // (revalidating each Location through both checks) → cross-origin
    // header stripping. If any hop is a private IP / hostname, this
    // throws synchronously inside the await.
    const res = await safeFetch(args.url, {
      method: args.method || "GET",
      headers: args.headers || {},
      body: args.body,
      signal: controller.signal,
      allowPrivate: !!args.allowPrivate,
    });
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const status = res.status;
    const finalUrl = res.url;

    // JSON: pretty-print, cap separately (JSON is denser than prose).
    if (contentType.includes("json")) {
      const { text, truncated: bodyTruncated } = await readBodyCapped(res, MAX_RESPONSE_BYTES);
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* leave as-is if it's not valid JSON */
      }
      const prepared = prepareModelText(pretty, FETCH_JSON_LIMIT, args, "json response");
      return {
        success: true,
        status,
        contentType,
        url: finalUrl,
        json: prepared.text,
        truncated: prepared.text.length < pretty.length || bodyTruncated,
        compacted: prepared.compacted,
        ...(prepared.compaction ? { compaction: prepared.compaction } : {}),
        originalLength: pretty.length,
      };
    }

    // HTML: strip to readable text and capture <title>.
    if (contentType.includes("html") || contentType.includes("xhtml")) {
      const { text: html, truncated: bodyTruncated } = await readBodyCapped(res, MAX_RESPONSE_BYTES);
      const { title, text } = htmlToText(html);
      const prepared = prepareModelText(text, FETCH_TEXT_LIMIT, args, "html text");
      return {
        success: true,
        status,
        contentType,
        url: finalUrl,
        title,
        text: prepared.text,
        truncated: prepared.text.length < text.length || bodyTruncated,
        compacted: prepared.compacted,
        ...(prepared.compaction ? { compaction: prepared.compaction } : {}),
        originalLength: text.length,
      };
    }

    // Plain text family: return verbatim, just trimmed to the cap.
    if (
      contentType.startsWith("text/") ||
      contentType.includes("xml") ||
      contentType.includes("javascript") ||
      contentType.includes("csv") ||
      contentType.includes("markdown") ||
      contentType === ""
    ) {
      const { text, truncated: bodyTruncated } = await readBodyCapped(res, MAX_RESPONSE_BYTES);
      const prepared = prepareModelText(text, FETCH_TEXT_LIMIT, args, "text response");
      return {
        success: true,
        status,
        contentType,
        url: finalUrl,
        text: prepared.text,
        truncated: prepared.text.length < text.length || bodyTruncated,
        compacted: prepared.compacted,
        ...(prepared.compaction ? { compaction: prepared.compaction } : {}),
        originalLength: text.length,
      };
    }

    // Binary — don't inline (would bloat the conversation with garbage).
    const len = res.headers.get("content-length");
    return {
      success: true,
      status,
      contentType,
      url: finalUrl,
      note: "Binary content not inlined. Content-Type was " +
        contentType + ".",
      sizeBytes: len ? parseInt(len, 10) : null,
    };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      return { success: false, error: `Fetch timed out after ${timeoutMs} ms` };
    }
    return { success: false, error: `Fetch failed: ${err.message}` };
  } finally {
    clearTimeout(t);
  }
}
