/**
 * Safe fetch wrapper for the LM Studio plugin.
 *
 * Replaces the native `fetch` with a `node:http(s)` request that
 * returns a standard `Response`, adding three security guarantees that
 * are easy to get wrong with the bare API:
 *
 *   1. Every redirect target is re-validated through the URL guard,
 *      so a public URL can't 30x to `http://169.254.169.254/...` (cloud
 *      metadata) or any RFC1918 / loopback / link-local target. The
 *      bare `fetch(..., { redirect: "follow" })` follows redirects
 *      transparently without the caller getting a chance to intervene.
 *
 *   2. Hostnames are resolved by the socket's own `lookup` hook, which
 *      checks every returned address against private-IP ranges before
 *      handing them to the connection. This closes the bypass where
 *      `attacker.example A 127.0.0.1` passes a syntactic hostname check
 *      but resolves to localhost, and DNS rebinding: the address that
 *      was checked is the address that is dialled, so a TTL=0 record
 *      has no second lookup to answer differently. Global `fetch` can't
 *      do this without an undici Agent, which isn't importable here.
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

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import * as zlib from "node:zlib";
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
 * Reject if any resolved address is in a private range.
 *
 * Why we check ALL returned addresses rather than just the first one:
 * Node's happy-eyeballs connect may try any of them, and it is
 * defense-in-depth against accidentally-misconfigured dual-stack hosts.
 */
function assertAddressesArePublic(host: string, addresses: LookupAddress[]): void {
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

/**
 * Literal-IP hosts never reach `guardedLookup`: Node connects to them
 * directly without calling the socket's `lookup` hook. Classify them here
 * on every hop so this layer does not depend on `assertSafeUrl` alone.
 */
function assertLiteralIpIsPublic(url: URL): void {
  let host = url.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const family = isIP(host);
  if (family === 4 ? isPrivateIpv4(host) : family === 6 && isPrivateIpv6(host)) {
    throw new Error(
      `Refusing private IPv${family} ${host} — set allowPrivate to opt in.`,
    );
  }
}

/**
 * `lookup` hook for the request socket. Node calls it when connecting
 * and dials only the addresses it hands back, so the check and the use
 * are the same resolution — resolving first and then letting the HTTP
 * client resolve the name again would let a TTL=0 record answer public
 * to the check and private to the connection. Literal-IP hosts never
 * reach a lookup; `assertLiteralIpIsPublic` covers them.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, "");
      return;
    }
    try {
      if (addresses.length === 0) throw new Error(`No addresses found for ${hostname}`);
      assertAddressesArePublic(hostname, addresses);
    } catch (e) {
      callback(e as NodeJS.ErrnoException, "");
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

/** Statuses whose Response must have a null body (Fetch standard). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
/** Lenient flushing, as fetch uses, so a truncated stream still yields what decoded. */
const ZLIB_OPTIONS = {
  flush: zlib.constants.Z_SYNC_FLUSH,
  finishFlush: zlib.constants.Z_SYNC_FLUSH,
};
const BROTLI_OPTIONS = {
  flush: zlib.constants.BROTLI_OPERATION_FLUSH,
  finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
};

function abortReason(signal: AbortSignal): Error {
  return signal.reason ??
    Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

interface HopInit {
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal?: AbortSignal;
}

/**
 * Headers fetch adds on its own. Without them some servers refuse the
 * request (no User-Agent) or skip compression. Caller values win.
 */
function withFetchDefaultHeaders(
  headers: Record<string, string>,
  body: string | undefined,
): Record<string, string> {
  const out = { ...headers };
  const present = new Set(Object.keys(out).map((k) => k.toLowerCase()));
  const defaults: Array<[string, string]> = [
    ["accept", "*/*"],
    ["accept-encoding", "gzip, deflate, br"],
    ["user-agent", "node"],
  ];
  if (body !== undefined) defaults.push(["content-type", "text/plain;charset=UTF-8"]);
  for (const [k, v] of defaults) {
    if (!present.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Undo Content-Encoding like fetch: gzip / deflate / br, last-applied
 * first. An unknown coding leaves the body as it came.
 */
function decodeBody(incoming: http.IncomingMessage): Readable {
  const codings = (incoming.headers["content-encoding"] || "")
    .toLowerCase()
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .reverse();
  if (codings.length === 0) return incoming;
  const decoders: NodeJS.ReadWriteStream[] = [];
  for (const coding of codings) {
    if (coding === "gzip" || coding === "x-gzip") decoders.push(zlib.createGunzip(ZLIB_OPTIONS));
    else if (coding === "deflate") decoders.push(zlib.createInflate(ZLIB_OPTIONS));
    else if (coding === "br") decoders.push(zlib.createBrotliDecompress(BROTLI_OPTIONS));
    else return incoming;
  }
  // pipeline destroys every stage when one fails or the last is
  // destroyed (e.g. readBodyCapped cancelling), which closes the socket.
  return pipeline([incoming, ...decoders], () => {}) as unknown as Readable;
}

/**
 * Send one request (no redirect following) over a connection whose
 * address went through `guardedLookup`, and wrap the reply in a
 * standard `Response` with `url` set, as fetch would return it.
 */
function pinnedFetch(url: URL, init: HopInit, opts: UrlGuardOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    const { signal } = init;
    if (url.username || url.password) {
      reject(new TypeError(
        `Request cannot be constructed from a URL that includes credentials: ${url}`,
      ));
      return;
    }
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    if (!opts.allowPrivate) {
      try { assertLiteralIpIsPublic(url); } catch (e) { reject(e); return; }
    }

    let req: http.ClientRequest;
    try {
      req = (url.protocol === "https:" ? https : http).request(url, {
        method: init.method,
        headers: withFetchDefaultHeaders(init.headers, init.body),
        // A fresh connection per request: a pooled keep-alive socket was
        // resolved for whichever request opened it (possibly one with
        // allowPrivate), so reusing it would skip this request's lookup.
        agent: false,
        ...(opts.allowPrivate ? {} : { lookup: guardedLookup }),
      });
    } catch (e) {
      reject(e);
      return;
    }

    const onAbort = () => req.destroy(abortReason(signal!));
    signal?.addEventListener("abort", onAbort, { once: true });
    // Kept for the request's lifetime: a late socket error with no
    // listener would crash the plugin process.
    req.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    req.once("response", (incoming) => {
      signal?.removeEventListener("abort", onAbort);
      try {
        resolve(toFetchResponse(incoming, url, init.method, signal));
      } catch (e) {
        incoming.destroy();
        reject(e);
      }
    });
    req.end(init.body);
  });
}

function toFetchResponse(
  incoming: http.IncomingMessage,
  url: URL,
  method: string,
  signal: AbortSignal | undefined,
): Response {
  const status = incoming.statusCode ?? 0;
  if (status < 200 || status > 599) {
    throw new Error(`Unsupported HTTP status ${status} from ${url.origin}`);
  }
  const headers = new Headers();
  for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2) {
    headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
  }

  let body: ReadableStream<Uint8Array> | null = null;
  if (method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
    incoming.on("error", () => {});
    incoming.resume();
  } else {
    const decoded = decodeBody(incoming);
    if (signal) {
      // Aborting mid-body errors the stream with the abort reason, as fetch does.
      const onAbort = () => decoded.destroy(abortReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      decoded.once("close", () => signal.removeEventListener("abort", onAbort));
    }
    body = Readable.toWeb(decoded) as unknown as ReadableStream<Uint8Array>;
  }

  // Response's constructor rejects reason phrases fetch would accept;
  // the phrase is cosmetic.
  const statusMessage = incoming.statusMessage ?? "";
  const statusText = /^[\t\x20-\x7e\x80-\xff]*$/.test(statusMessage) ? statusMessage : "";
  const res = new Response(body, { status, statusText, headers });
  // Only fetch() can set Response.url; callers report it as the final URL.
  const finalUrl = new URL(url);
  finalUrl.hash = "";
  Object.defineProperty(res, "url", { value: finalUrl.toString() });
  return res;
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
 * Follows redirects manually so we can intercept each 3xx Location
 * header; every hop connects through the same pinned, guarded lookup.
 * On exhausting the hop budget, throws.
 */
export async function safeFetch(
  initialUrl: string,
  init: SafeFetchInit = {},
): Promise<Response> {
  const allowPrivate = !!init.allowPrivate;
  const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  // Initial URL goes through the sync structural check here; DNS
  // resolution is checked when the connection is made (guardedLookup).
  // Throws on a private hostname / IP / TLD.
  let current: URL;
  current = assertSafeUrl(initialUrl, { allowPrivate });

  let originForCredentials = current.origin;
  let headers = { ...(init.headers || {}) };
  // Pass through method/body on the first hop only — 30x with body
  // forwarding is a footgun (RFC 7231 says 301/302/303 should drop
  // the body, 307/308 should preserve it; we conservatively drop on
  // every redirect to keep the surface predictable).
  let method = (init.method || "GET").toUpperCase();
  let body: string | undefined = init.body;
  // The same requests fetch() refused before node:http replaced it.
  if (method === "CONNECT" || method === "TRACE" || method === "TRACK") {
    throw new TypeError(`'${method}' HTTP method is unsupported.`);
  }
  if (body !== undefined && (method === "GET" || method === "HEAD")) {
    throw new TypeError("Request with GET/HEAD method cannot have body.");
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await pinnedFetch(
      current,
      { method, headers, body, ...(init.signal ? { signal: init.signal } : {}) },
      { allowPrivate },
    );

    // Not a redirect — return as-is. Caller reads the body.
    if (res.status < 300 || res.status >= 400) return res;

    const location = res.headers.get("location");
    if (!location) return res; // 3xx without Location — let caller see it.

    // Redirect bodies are never read; release the connection.
    await res.body?.cancel().catch(() => {});

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`Invalid redirect Location: ${location}`);
    }

    // Re-validate the redirect target: sync protocol / hostname-pattern
    // checks here, DNS resolution when the next hop connects.
    next = assertSafeUrl(next.toString(), { allowPrivate });

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
