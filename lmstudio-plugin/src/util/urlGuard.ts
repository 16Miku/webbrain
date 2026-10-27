/**
 * URL safety guard.
 *
 * Why this exists: when an LLM is given a `fetch_url` tool, it will
 * eventually try to fetch URLs the user doesn't want it to — usually
 * because a page told it to ("for more info visit
 * http://192.168.1.1/admin"), or because of a prompt injection
 * attempt baked into a previously-fetched page. The plugin runs in
 * the user's local Node process, so anything reachable from that
 * process is reachable from the LLM: localhost services, intranet
 * apps, cloud-metadata endpoints (169.254.169.254), file:// URLs.
 *
 * `assertSafeUrl(url)` (sync) rejects:
 *   - non-http(s) protocols (file://, ftp://, gopher://, javascript:)
 *   - literal RFC1918 / loopback / link-local / ULA IPv6 hostnames
 *   - common private DNS spellings (localhost, *.local, *.internal, *.lan)
 *
 * The DNS-resolution-aware check (`guardedLookup`) lives in
 * `safeFetch.ts` because it requires `node:dns`. It runs as the request
 * socket's `lookup` hook on every hop, so the connection can only use
 * addresses that passed it. That additional layer closes the case
 * where a public-looking hostname has an A record pointing into
 * RFC1918 / loopback / link-local space, e.g. `attacker.example A
 * 127.0.0.1`, and DNS rebinding (a TTL=0 record answering public to a
 * check and private to the connection), because there is no separate
 * check to answer. `isPrivateIpv4` / `isPrivateIpv6` are exported so
 * the resolver-side check reuses the same range definitions.
 *
 * The layered defense (sync check + connect-time DNS check +
 * per-redirect re-validation) stops drive-by SSRF from open redirects,
 * naive hostname tricks and rebinding, but is NOT a hardened sandbox.
 *
 * To opt-out (e.g. you really do want to point this at your intranet)
 * call assertSafeUrl(url, { allowPrivate: true }) and pass the same
 * flag through to safeFetch.
 */

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  // [first byte, second byte]; second byte 0xFF means any
  [10, 0xff],          // 10.0.0.0/8
  [127, 0xff],         // 127.0.0.0/8 (loopback)
  [169, 254],          // 169.254.0.0/16 (link-local + cloud metadata)
  [192, 168],          // 192.168.0.0/16
  [100, 64],           // 100.64.0.0/10 carrier-grade NAT (we treat as private)
];

function ipv4ToBytes(ip: string): number[] | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const bytes = m.slice(1, 5).map((s) => parseInt(s, 10));
  if (bytes.some((b) => Number.isNaN(b) || b < 0 || b > 255)) return null;
  return bytes;
}

export function isPrivateIpv4(ip: string): boolean {
  const bytes = ipv4ToBytes(ip);
  if (!bytes || bytes.length < 4) return false;
  const a = bytes[0]!;
  const b = bytes[1]!;
  for (const [pa, pb] of PRIVATE_IPV4_RANGES) {
    if (a === pa && (pb === 0xff || b === pb)) return true;
  }
  // 172.16.0.0/12 — non-contiguous; second byte 16..31
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function isPrivateIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  // Loopback ::1, link-local fe80::/10, ULAs fc00::/7 (fc00..fdff),
  // mapped IPv4 ::ffff:<ipv4> if the inner ipv4 is private.
  if (lower === "::1") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  const v4mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped?.[1] && isPrivateIpv4(v4mapped[1])) return true;
  return false;
}

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
]);

const PRIVATE_TLDS = new Set([
  ".local",
  ".internal",
  ".lan",
  ".intranet",
  ".home",
  ".corp",
]);

function isPrivateHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (PRIVATE_HOSTNAMES.has(lower)) return true;
  for (const tld of PRIVATE_TLDS) {
    if (lower.endsWith(tld)) return true;
  }
  return false;
}

export interface UrlGuardOptions {
  /**
   * Set true to allow URLs that resolve to RFC1918 / loopback / link-
   * local addresses. Use only when you actually want the plugin to
   * reach intranet services. Default false.
   */
  allowPrivate?: boolean;
}

/**
 * Throws if the URL fails the safety check. Returns the parsed URL
 * object on success so callers can use `assertSafeUrl(url).hostname`
 * etc. without re-parsing.
 */
export function assertSafeUrl(input: string, opts: UrlGuardOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Refusing ${parsed.protocol} URL — this plugin only fetches http(s).`,
    );
  }
  if (opts.allowPrivate) return parsed;

  // hostname for IPv6 comes back wrapped in [] — strip them.
  let host = parsed.hostname;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  if (isPrivateIpv4(host)) {
    throw new Error(
      `Refusing private IPv4 ${host} — set allowPrivate to opt in.`,
    );
  }
  if (host.includes(":") && isPrivateIpv6(host)) {
    throw new Error(
      `Refusing private IPv6 ${host} — set allowPrivate to opt in.`,
    );
  }
  if (isPrivateHostname(host)) {
    throw new Error(
      `Refusing private hostname ${host} — set allowPrivate to opt in.`,
    );
  }
  return parsed;
}
