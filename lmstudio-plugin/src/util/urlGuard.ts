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
 *   - literal RFC1918 / loopback / link-local / ULA IPv6 hostnames,
 *     including IPv6 forms that embed a private IPv4 (IPv4-mapped,
 *     NAT64, 6to4, Teredo)
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

/*
 * IP literals are classified on their bytes, never on their spelling.
 * The WHATWG URL parser rewrites `[::ffff:127.0.0.1]` to
 * `[::ffff:7f00:1]` and `http://2130706433/` to `127.0.0.1`, and an
 * IPv6 address has many equivalent texts (`::1`, `0:0:0:0:0:0:0:1`,
 * `::0001`), so any string-prefix check misses forms that still
 * connect to the same host.
 */

function ipv4ToBytes(ip: string): number[] | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const bytes = m.slice(1, 5).map((s) => parseInt(s, 10));
  if (bytes.some((b) => Number.isNaN(b) || b < 0 || b > 255)) return null;
  return bytes;
}

/**
 * Parse an IPv6 literal (optionally `[...]`-wrapped, with a `%zone`
 * suffix or a trailing dotted IPv4) into its 16 bytes. Returns null for
 * anything that is not a well-formed IPv6 address.
 */
function ipv6ToBytes(ip: string): number[] | null {
  let s = ip;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":")) return null;

  // Rewrite a trailing dotted IPv4 (`::ffff:1.2.3.4`) as two hex groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToBytes(tail);
    if (!v4) return null;
    s = s.slice(0, lastColon + 1) +
      ((v4[0]! << 8) | v4[1]!).toString(16) + ":" +
      ((v4[2]! << 8) | v4[3]!).toString(16);
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groupsToBytes = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const v = parseInt(group, 16);
      out.push(v >> 8, v & 0xff);
    }
    return out;
  };
  const head = groupsToBytes(halves[0]!);
  if (!head) return null;
  if (halves.length === 1) return head.length === 16 ? head : null;
  const rest = groupsToBytes(halves[1]!);
  // `::` must stand for at least one zero group.
  if (!rest || head.length + rest.length > 14) return null;
  return [
    ...head,
    ...new Array<number>(16 - head.length - rest.length).fill(0),
    ...rest,
  ];
}

/** True if the first `bits` bits of `addr` equal those of `prefix`. */
function inPrefix(addr: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i * 8 < bits; i++) {
    const take = Math.min(8, bits - i * 8);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((addr[i]! ^ prefix[i]!) & mask) !== 0) return false;
  }
  return true;
}

function v6(text: string): number[] {
  const bytes = ipv6ToBytes(text);
  if (!bytes) throw new Error(`bad IPv6 range constant ${text}`);
  return bytes;
}

const PRIVATE_IPV4_RANGES: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8],        // 0.0.0.0/8 "this host"; 0.0.0.0 connects to loopback
  [[10, 0, 0, 0], 8],       // 10.0.0.0/8
  [[100, 64, 0, 0], 10],    // 100.64.0.0/10 carrier-grade NAT (we treat as private)
  [[127, 0, 0, 0], 8],      // 127.0.0.0/8 (loopback)
  [[169, 254, 0, 0], 16],   // 169.254.0.0/16 (link-local + cloud metadata)
  [[172, 16, 0, 0], 12],    // 172.16.0.0/12
  [[192, 168, 0, 0], 16],   // 192.168.0.0/16
  [[224, 0, 0, 0], 4],      // 224.0.0.0/4 multicast
  [[240, 0, 0, 0], 4],      // 240.0.0.0/4 reserved, incl. 255.255.255.255
];

const PRIVATE_IPV6_RANGES: Array<[number[], number]> = [
  [v6("::"), 128],          // unspecified; connects to loopback
  [v6("::1"), 128],         // loopback
  [v6("fc00::"), 7],        // unique-local
  [v6("fe80::"), 10],       // link-local
  [v6("fec0::"), 10],       // site-local (deprecated)
  [v6("ff00::"), 8],        // multicast
];

/**
 * IPv6 ranges that carry an IPv4 address inside them. The stack (or a
 * translator on the path) delivers these to the embedded IPv4 host, so
 * that address gets the IPv4 rules. Teredo carries two: the server, and
 * the client XOR 0xff.
 */
const IPV4_EMBEDDING_RANGES: Array<[number[], number, (b: number[]) => number[][]]> = [
  [v6("::ffff:0:0"), 96, (b) => [b.slice(12)]],      // IPv4-mapped
  [v6("::"), 96, (b) => [b.slice(12)]],              // IPv4-compatible (deprecated)
  [v6("::ffff:0:0:0"), 96, (b) => [b.slice(12)]],    // IPv4-translated (SIIT)
  [v6("64:ff9b::"), 96, (b) => [b.slice(12)]],       // NAT64 well-known prefix
  [v6("2002::"), 16, (b) => [b.slice(2, 6)]],        // 6to4
  [v6("2001::"), 32, (b) => [                        // Teredo
    b.slice(4, 8),
    b.slice(12).map((x) => x ^ 0xff),
  ]],
];

function isPrivateIpv4Bytes(bytes: number[]): boolean {
  return PRIVATE_IPV4_RANGES.some(([prefix, bits]) => inPrefix(bytes, prefix, bits));
}

export function isPrivateIpv4(ip: string): boolean {
  const bytes = ipv4ToBytes(ip);
  return !!bytes && isPrivateIpv4Bytes(bytes);
}

export function isPrivateIpv6(host: string): boolean {
  const bytes = ipv6ToBytes(host);
  if (!bytes) return false;
  if (PRIVATE_IPV6_RANGES.some(([prefix, bits]) => inPrefix(bytes, prefix, bits))) {
    return true;
  }
  for (const [prefix, bits, embedded] of IPV4_EMBEDDING_RANGES) {
    if (inPrefix(bytes, prefix, bits) && embedded(bytes).some(isPrivateIpv4Bytes)) {
      return true;
    }
  }
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
// blocked even with allowPrivate. Like the private ranges, they are
// matched on address bytes, so every spelling of an address (and every
// IPv6 form that embeds one) is covered.
const CLOUD_METADATA_IPV4: number[][] = [
  "169.254.169.254", // AWS, GCP, Azure, OCI, DigitalOcean, OpenStack and others
  "169.254.170.2",   // AWS ECS task metadata and credentials
  "169.254.170.23",  // AWS EKS Pod Identity agent
  "169.254.0.23",    // Tencent Cloud
  "100.100.100.200", // Alibaba Cloud
].map((ip) => ipv4ToBytes(ip)!);
const CLOUD_METADATA_IPV6: number[][] = [
  v6("fd00:ec2::254"), // AWS IMDS over IPv6
  v6("fd00:ec2::23"),  // AWS EKS Pod Identity agent over IPv6
];
const CLOUD_METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
]);

function sameBytes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function isCloudMetadataIpv4Bytes(bytes: number[]): boolean {
  return CLOUD_METADATA_IPV4.some((m) => sameBytes(m, bytes));
}

/**
 * True for a cloud metadata endpoint, given a URL hostname (with or
 * without IPv6 brackets) or a resolved address. IPv6 addresses that embed
 * an IPv4 address (mapped, compatible, translated, NAT64, 6to4, Teredo)
 * count as that IPv4 address, using the same embedding table as the
 * private-range check.
 */
export function isCloudMetadataHost(host: string): boolean {
  let lower = host.toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]")) lower = lower.slice(1, -1);
  if (lower.endsWith(".")) lower = lower.slice(0, -1);
  if (CLOUD_METADATA_HOSTNAMES.has(lower)) return true;
  const v4 = ipv4ToBytes(lower);
  if (v4) return isCloudMetadataIpv4Bytes(v4);
  const bytes = ipv6ToBytes(lower);
  if (!bytes) return false;
  if (CLOUD_METADATA_IPV6.some((m) => sameBytes(m, bytes))) return true;
  return IPV4_EMBEDDING_RANGES.some(([prefix, bits, embedded]) =>
    inPrefix(bytes, prefix, bits) && embedded(bytes).some(isCloudMetadataIpv4Bytes));
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
  const refuseMetadata = (): void => {
    if (isCloudMetadataHost(parsed.hostname)) {
      throw new Error(
        `Refusing cloud metadata endpoint ${parsed.hostname} — blocked even with private network access on.`,
      );
    }
  };
  if (opts.allowPrivate) {
    refuseMetadata();
    return parsed;
  }

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
  // Metadata hostnames that are not private spellings (metadata.goog).
  refuseMetadata();
  return parsed;
}
