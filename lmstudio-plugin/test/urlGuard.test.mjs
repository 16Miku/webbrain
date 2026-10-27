import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  assertSafeUrl,
  isPrivateIpv4,
  isPrivateIpv6,
} from "../dist/util/urlGuard.js";
import { safeFetch } from "../dist/util/safeFetch.js";

// [address, why it reaches a private host]
const PRIVATE_IPV6 = [
  ["::1", "loopback"],
  ["0:0:0:0:0:0:0:1", "loopback, uncompressed"],
  ["::", "unspecified"],
  ["::ffff:127.0.0.1", "IPv4-mapped loopback, dotted"],
  ["::ffff:7f00:1", "IPv4-mapped loopback, hex (WHATWG form)"],
  ["::FFFF:7F00:0001", "IPv4-mapped loopback, upper-case and padded"],
  ["0:0:0:0:0:ffff:7f00:1", "IPv4-mapped loopback, uncompressed"],
  ["::ffff:a9fe:a9fe", "IPv4-mapped cloud metadata"],
  ["::ffff:a00:1", "IPv4-mapped 10.0.0.1"],
  ["::ffff:ac10:1", "IPv4-mapped 172.16.0.1"],
  ["::ffff:c0a8:101", "IPv4-mapped 192.168.1.1"],
  ["::ffff:0:0", "IPv4-mapped 0.0.0.0"],
  ["::ffff:0:7f00:1", "IPv4-translated loopback"],
  ["::7f00:1", "IPv4-compatible loopback"],
  ["::127.0.0.1", "IPv4-compatible loopback, dotted"],
  ["64:ff9b::7f00:1", "NAT64 loopback"],
  ["64:ff9b::169.254.169.254", "NAT64 cloud metadata"],
  ["2002:7f00:1::", "6to4 loopback"],
  ["2002:a9fe:a9fe::1", "6to4 cloud metadata"],
  ["2001:0:4136:e378::80ff:fffe", "Teredo client 127.0.0.1"],
  ["2001:0:a9fe:a9fe::f7f7:f7f7", "Teredo server 169.254.169.254"],
  ["fe80::1", "link-local"],
  ["febf:ffff::1", "link-local, top of /10"],
  ["fe80::1%eth0", "link-local with zone id"],
  ["fc00::1", "unique-local"],
  ["fd12:3456:789a::1", "unique-local"],
  ["fec0::1", "site-local"],
  ["ff02::1", "multicast"],
];

const PUBLIC_IPV6 = [
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "::ffff:8.8.8.8",
  "::ffff:808:808",
  "64:ff9b::808:808",
  "2002:808:808::1",
  "2001:0:4136:e378:8000:63bf:3fff:fdd2",
];

const PRIVATE_IPV4 = [
  "0.0.0.0",
  "0.1.2.3",
  "10.1.2.3",
  "100.64.0.1",
  "100.127.255.255",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.0.1",
  "224.0.0.1",
  "255.255.255.255",
];

const PUBLIC_IPV4 = [
  "1.1.1.1",
  "8.8.8.8",
  "100.63.255.255",
  "100.128.0.1",
  "172.15.255.255",
  "172.32.0.1",
  "192.0.2.1",
];

test("isPrivateIpv6 classifies by address bytes, not spelling", () => {
  for (const [address, why] of PRIVATE_IPV6) {
    assert.equal(isPrivateIpv6(address), true, `${address} (${why})`);
  }
  for (const address of PUBLIC_IPV6) {
    assert.equal(isPrivateIpv6(address), false, address);
  }
});

test("isPrivateIpv4 covers this-host, CGNAT /10, multicast and reserved", () => {
  for (const address of PRIVATE_IPV4) {
    assert.equal(isPrivateIpv4(address), true, address);
  }
  for (const address of PUBLIC_IPV4) {
    assert.equal(isPrivateIpv4(address), false, address);
  }
});

test("assertSafeUrl refuses every spelling of a private IP host", () => {
  const hosts = [
    ...PRIVATE_IPV6
      .filter(([address]) => !address.includes("%"))
      .map(([address]) => `[${address}]`),
    ...PRIVATE_IPV4,
    "127.1",
    "2130706433",
    "0x7f.0.0.1",
    "0",
  ];
  for (const host of hosts) {
    assert.throws(
      () => assertSafeUrl(`http://${host}:8080/`),
      /Refusing private/,
      host,
    );
  }
});

test("assertSafeUrl still allows public IP hosts", () => {
  for (const host of [...PUBLIC_IPV6.map((a) => `[${a}]`), ...PUBLIC_IPV4]) {
    assert.doesNotThrow(() => assertSafeUrl(`http://${host}/`), host);
  }
});

test("safeFetch does not reach loopback through IPv4-mapped or unspecified hosts", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end("local secret");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    for (const host of ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "0.0.0.0", "[::]"]) {
      await assert.rejects(
        safeFetch(`http://${host}:${port}/`),
        /Refusing private/,
        host,
      );
    }
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});

test("safeFetch's DNS layer classifies literal IPs itself", async () => {
  // Disable the sync guard so only the resolver-side check is left.
  const guard = createRequire(import.meta.url)("../dist/util/urlGuard.js");
  const original = guard.assertSafeUrl;
  guard.assertSafeUrl = (url) => new URL(url);
  try {
    for (const host of ["[::ffff:7f00:1]", "[64:ff9b::a9fe:a9fe]", "0.0.0.0"]) {
      await assert.rejects(
        safeFetch(`http://${host}:9/`),
        /Refusing private/,
        host,
      );
    }
  } finally {
    guard.assertSafeUrl = original;
  }
});
