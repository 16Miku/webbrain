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
 *   - cloud metadata endpoints, even when allowPrivate is set
 *
 * The DNS-resolution-aware check
 * (`assertHostnameDoesNotResolveToPrivate`) lives in `safeFetch.ts`
 * because it requires `node:dns` and is awaited once per redirect hop
 * inside the `safeFetch` wrapper. That additional layer closes the case
 * where a public-looking hostname has an A record pointing into
 * RFC1918 / loopback / link-local space, e.g. `attacker.example A
 * 127.0.0.1`. `isPrivateIpv4` / `isPrivateIpv6` are exported so the
 * resolver-side check reuses the same range definitions.
 *
 * Residual gap: DNS rebinding. An attacker controlling a domain with
 * TTL=0 can return a public IP at the time of the guard check and a
 * private IP at the time `fetch` connects. Closing this fully requires
 * pinning the resolved IP via a custom undici Agent + `lookup` hook —
 * tracked as a follow-up. The current layered defense (sync check +
 * DNS check + per-redirect re-validation) raises the bar enough to
 * stop drive-by SSRF from open redirects and naive hostname tricks
 * but is NOT a hardened sandbox.
 *
 * To opt-out (e.g. you really do want to point this at your intranet)
 * call assertSafeUrl(url, { allowPrivate: true }) and pass the same
 * flag through to safeFetch. In the plugin that flag comes only from
 * the user's "Allow private network access" setting, never from a tool
 * argument: a page the model just read must not be able to switch the
 * guard off. Cloud metadata endpoints stay blocked either way.
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

// Cloud instance-metadata services hand out the machine's cloud
// credentials. Reaching a service on the user's own LAN is a reasonable
// opt-in; giving the model those credentials is not, so these stay
// blocked even with allowPrivate. IPv6 entries are in the canonical form
// the WHATWG URL parser produces.
const CLOUD_METADATA_IPV4 = new Set([
  "169.254.169.254", // AWS, GCP, Azure, OCI, DigitalOcean, OpenStack and others
  "169.254.170.2",   // AWS ECS task metadata and credentials
  "169.254.170.23",  // AWS EKS Pod Identity agent
  "169.254.0.23",    // Tencent Cloud
  "100.100.100.200", // Alibaba Cloud
]);
const CLOUD_METADATA_IPV6 = new Set([
  "fd00:ec2::254",   // AWS IMDS over IPv6
  "fd00:ec2::23",    // AWS EKS Pod Identity agent over IPv6
]);
const CLOUD_METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
]);

/**
 * True for a cloud metadata endpoint, given a URL hostname (with or
 * without IPv6 brackets) or a resolved address. An IPv4-mapped IPv6
 * address counts as its IPv4 address.
 */
export function isCloudMetadataHost(host: string): boolean {
  let lower = host.toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]")) lower = lower.slice(1, -1);
  if (lower.endsWith(".")) lower = lower.slice(0, -1);
  if (CLOUD_METADATA_IPV4.has(lower) || CLOUD_METADATA_HOSTNAMES.has(lower)) return true;
  if (!lower.includes(":")) return false;

  // Canonicalise through the URL parser so fd00:ec2:0:0:0:0:0:254 and
  // ::ffff:169.254.169.254 compare equal to the forms listed above.
  let canonical: string;
  try {
    canonical = new URL(`http://[${lower}]/`).hostname.slice(1, -1);
  } catch {
    return false;
  }
  if (CLOUD_METADATA_IPV6.has(canonical)) return true;
  const mapped = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mapped?.[1] || !mapped[2]) return false;
  const hi = parseInt(mapped[1], 16);
  const lo = parseInt(mapped[2], 16);
  return CLOUD_METADATA_IPV4.has(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
}

/**
 * Appended to private-target refusals. The model reads tool errors, so
 * this tells it what to relay to the user instead of what to retry.
 */
export const PRIVATE_NETWORK_HINT =
  "private network access is off. The user can turn on \"Allow private " +
  "network access\" in this plugin's settings in LM Studio.";

export interface UrlGuardOptions {
  /**
   * Set true to allow URLs that resolve to RFC1918 / loopback / link-
   * local addresses. Use only when you actually want the plugin to
   * reach intranet services. Default false. Cloud metadata endpoints
   * stay blocked regardless. The plugin sets this from the user's
   * plugin setting; never take it from model-supplied tool arguments.
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
  if (isCloudMetadataHost(parsed.hostname)) {
    throw new Error(
      `Refusing cloud metadata endpoint ${parsed.hostname} — blocked even with private network access on.`,
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
      `Refusing private IPv4 ${host} — ${PRIVATE_NETWORK_HINT}`,
    );
  }
  if (host.includes(":") && isPrivateIpv6(host)) {
    throw new Error(
      `Refusing private IPv6 ${host} — ${PRIVATE_NETWORK_HINT}`,
    );
  }
  if (isPrivateHostname(host)) {
    throw new Error(
      `Refusing private hostname ${host} — ${PRIVATE_NETWORK_HINT}`,
    );
  }
  return parsed;
}
