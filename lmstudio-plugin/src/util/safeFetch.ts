/**
 * Safe fetch wrapper for the LM Studio plugin.
 *
 * Wraps the native `fetch` to add three security guarantees that are
 * easy to get wrong with the bare API:
 *
 *   1. Every redirect target is re-validated through the URL guard,
 *      so a public URL can't 30x to `http://169.254.169.254/...` (cloud
 *      metadata) or any RFC1918 / loopback / link-local target. The
 *      bare `fetch(..., { redirect: "follow" })` follows redirects
 *      transparently without the caller getting a chance to intervene.
 *
 *   2. Hostnames are resolved at the start of each hop and every
 *      returned address is checked against private-IP ranges. This
 *      closes the simple bypass where `attacker.example A 127.0.0.1`
 *      passes a syntactic hostname check but resolves to localhost.
 *      It does NOT fully close DNS-rebinding (TTL=0 returning a
 *      different IP between guard and connect) — see the urlGuard
 *      header comment for the residual window.
 *
 *   3. Response bodies are read with a hard byte cap so a malicious
 *      or accidental gigabyte response can't OOM the plugin. Chunks
 *      past the cap are dropped; the caller gets `truncated:true` and
 *      whatever fit.
 *
 * Cross-origin redirects also have `Authorization`, `Cookie`, and
 * `Proxy-*` request headers stripped so credentials picked up from a
 * page-injected `headers` arg can't leak to a different origin via an
 * open-redirect chain.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  assertSafeUrl,
  isPrivateIpv4,
  isPrivateIpv6,
  type UrlGuardOptions,
} from "./urlGuard.js";

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_BODY_CAP_BYTES = 10 * 1024 * 1024; // 10 MB hard ceiling

/** Headers we never forward across origins. Lower-case for easy compare. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "proxy-authenticate",
]);

/**
 * Strip headers that shouldn't survive a cross-origin redirect.
 * Same-origin redirects keep the full header set.
 */
function stripCrossOriginHeaders(
  headers: Record<string, string>,
  fromOrigin: string,
  toOrigin: string,
): Record<string, string> {
  if (fromOrigin === toOrigin) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Resolve a hostname's A/AAAA records and reject if any address is in
 * a private range. Literal IPs skip DNS and are classified directly.
 *
 * Why we check ALL returned addresses rather than just the first one
 * fetch will use: defense-in-depth against accidentally-misconfigured
 * dual-stack hosts and against future fetch-implementation changes
 * about which family wins in `lookup({ all: false })`.
 */
async function assertHostnameDoesNotResolveToPrivate(
  parsed: URL,
  opts: UrlGuardOptions,
): Promise<void> {
  if (opts.allowPrivate) return;

  // Strip the [..] wrapper IPv6 URL syntax adds.
  let host = parsed.hostname;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  // Literal IP — nothing to resolve, but classify it here as well
  // rather than trusting the sync guard ran with the same rules.
  const literal = isIP(host);
  if (literal === 4 || literal === 6) {
    if (literal === 4 ? isPrivateIpv4(host) : isPrivateIpv6(host)) {
      throw new Error(
        `Refusing private IPv${literal} ${host} — set allowPrivate to opt in.`,
      );
    }
    return;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch (e) {
    // Resolution failure isn't a security signal — let the subsequent
    // fetch surface a clean error. Don't fail the guard here.
    return;
  }

  for (const { address, family } of addresses) {
    if (family === 4 && isPrivateIpv4(address)) {
      throw new Error(
        `Refusing ${host} — resolves to private IPv4 ${address}. Set allowPrivate to opt in.`,
      );
    }
    if (family === 6 && isPrivateIpv6(address)) {
      throw new Error(
        `Refusing ${host} — resolves to private IPv6 ${address}. Set allowPrivate to opt in.`,
      );
    }
  }
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | undefined;
  signal?: AbortSignal;
  /** Allow private/loopback/link-local destinations. Default false. */
  allowPrivate?: boolean;
  /** Cap manual redirect hops. Default 5. */
  maxRedirects?: number;
}

/**
 * Fetch `initialUrl` with redirect-following that re-validates each
 * hop through the URL guard. Returns a Response object whose body has
 * NOT been consumed — caller is responsible for reading it (use
 * `readBodyCapped` to apply the streaming size limit).
 *
 * Uses `redirect: "manual"` under the hood so we can intercept each
 * 3xx Location header. On exhausting the hop budget, throws.
 */
export async function safeFetch(
  initialUrl: string,
  init: SafeFetchInit = {},
): Promise<Response> {
  const allowPrivate = !!init.allowPrivate;
  const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  // Initial URL goes through the full guard (sync structural check
  // + DNS resolution). Throws on a private hostname / IP / TLD.
  let current: URL;
  current = assertSafeUrl(initialUrl, { allowPrivate });
  await assertHostnameDoesNotResolveToPrivate(current, { allowPrivate });

  let originForCredentials = current.origin;
  let headers = { ...(init.headers || {}) };
  // Pass through method/body on the first hop only — 30x with body
  // forwarding is a footgun (RFC 7231 says 301/302/303 should drop
  // the body, 307/308 should preserve it; we conservatively drop on
  // every redirect to keep the surface predictable).
  let method = (init.method || "GET").toUpperCase();
  let body: string | undefined = init.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(current.toString(), {
      method,
      headers,
      body,
      redirect: "manual",
      ...(init.signal ? { signal: init.signal } : {}),
    });

    // Not a redirect — return as-is. Caller reads the body.
    if (res.status < 300 || res.status >= 400) return res;

    const location = res.headers.get("location");
    if (!location) return res; // 3xx without Location — let caller see it.

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`Invalid redirect Location: ${location}`);
    }

    // Re-validate the redirect target. Both sync (protocol /
    // hostname-pattern checks) and async (DNS resolution).
    next = assertSafeUrl(next.toString(), { allowPrivate });
    await assertHostnameDoesNotResolveToPrivate(next, { allowPrivate });

    // Cross-origin redirect → drop sensitive headers.
    headers = stripCrossOriginHeaders(headers, originForCredentials, next.origin);

    // Drop the request body and downgrade method per RFC 7231 / 7538
    // semantics for the common 301/302/303 case. 307/308 technically
    // preserve, but body forwarding to a different origin is rarely
    // what a fetch_url caller wants — we strip uniformly.
    body = undefined;
    if (res.status === 303) method = "GET";

    current = next;
    originForCredentials = next.origin;
  }

  throw new Error(
    `Too many redirects (>${maxRedirects}) starting from ${initialUrl}`,
  );
}

export interface CappedReadResult {
  text: string;
  /** True if the body was longer than `maxBytes` and we cut it short. */
  truncated: boolean;
  /** Bytes actually read (≤ maxBytes when truncated). */
  bytesRead: number;
}

/**
 * Read a Response body to a string with a hard byte cap. Decodes as
 * UTF-8 (the default for text/html/json/etc.); binary callers should
 * use res.arrayBuffer() and apply their own caps.
 *
 * On exceeding `maxBytes` we cancel the underlying reader so the
 * server doesn't keep sending and we don't keep buffering.
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number = DEFAULT_BODY_CAP_BYTES,
): Promise<CappedReadResult> {
  if (!res.body) return { text: "", truncated: false, bytesRead: 0 };

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let bytesRead = 0;
  let truncated = false;
  let out = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - bytesRead;
      if (value.length > remaining) {
        // Take only what fits, decode the partial chunk with `stream:false`
        // so the decoder flushes any pending lead bytes, then stop.
        const slice = value.subarray(0, Math.max(0, remaining));
        if (slice.length > 0) {
          out += decoder.decode(slice, { stream: false });
          bytesRead += slice.length;
        }
        truncated = true;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }

      out += decoder.decode(value, { stream: true });
      bytesRead += value.length;
    }
    if (!truncated) {
      // Final flush for any trailing multibyte sequence.
      out += decoder.decode();
    }
  } catch (e) {
    // Surface I/O errors to the caller — but only if we have nothing
    // useful. If we have a partial body, return it with truncated:true.
    if (out.length === 0) throw e;
    truncated = true;
  }

  return { text: out, truncated, bytesRead };
}
