import assert from "node:assert/strict";
import dns from "node:dns";
import { once } from "node:events";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { after, afterEach, before, test } from "node:test";

import { readBodyCapped, safeFetch } from "../dist/util/safeFetch.js";

const originalLookup = dns.lookup;
const originalPromisesLookup = dns.promises.lookup;

let server;
let port;
const hits = [];

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, host: req.headers.host, body });
      if (req.url === "/start") {
        res.writeHead(302, { location: "/final" });
        res.end();
      } else if (req.url === "/final") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(gzipSync("hello pinned"));
      } else if (req.url === "/echo") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`${req.method} ${req.headers["content-type"]} ${body}`);
      } else if (req.url === "/slow") {
        // Never answers; the caller's signal has to end the request.
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("internal secret");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = server.address().port;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

afterEach(() => {
  dns.lookup = originalLookup;
  dns.promises.lookup = originalPromisesLookup;
  hits.length = 0;
});

/**
 * Answer each resolution of `hostname` with the next entry of `answers`
 * (the last one repeats), through both the callback and promise DNS
 * APIs — like an attacker's TTL=0 record that changes between queries.
 */
function fakeDns(hostname, answers) {
  let calls = 0;
  const next = () => answers[Math.min(calls++, answers.length - 1)];
  dns.lookup = function (host, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (host !== hostname) return originalLookup.call(this, host, options, callback);
    const addresses = next();
    process.nextTick(() => {
      if (options?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
  dns.promises.lookup = async (host, options) => {
    if (host !== hostname) return originalPromisesLookup(host, options);
    const addresses = next();
    return options?.all ? addresses : addresses[0];
  };
}

const PUBLIC = { address: "192.0.2.10", family: 4 }; // TEST-NET-1: public to the guard, never routed
const LOOPBACK = { address: "127.0.0.1", family: 4 };

test("a DNS answer that changes after the check cannot move the connection to a private address", async () => {
  fakeDns("rebind.example", [[PUBLIC], [LOOPBACK]]);

  // The connection may only use the answer that was validated (PUBLIC),
  // which is unroutable, so the request fails or times out. Before the
  // fix, fetch resolved the name again and reached the loopback server.
  await assert.rejects(
    safeFetch(`http://rebind.example:${port}/secret`, { signal: AbortSignal.timeout(1500) }),
  );
  assert.deepEqual(hits, []);
});

test("every address the connection could use is checked before connecting", async () => {
  fakeDns("mixed.example", [[PUBLIC, LOOPBACK]]);

  await assert.rejects(
    safeFetch(`http://mixed.example:${port}/secret`),
    /resolves to private IPv4 127\.0\.0\.1/,
  );
  assert.deepEqual(hits, []);
});

test("allowPrivate requests follow redirects and keep the fetch response shape", async () => {
  fakeDns("intranet.example", [[LOOPBACK]]);

  const res = await safeFetch(`http://intranet.example:${port}/start`, { allowPrivate: true });
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.equal(res.url, `http://intranet.example:${port}/final`);
  assert.equal(res.headers.get("content-type"), "text/plain");
  const { text, truncated } = await readBodyCapped(res, 1024);
  assert.equal(text, "hello pinned");
  assert.equal(truncated, false);
  assert.deepEqual(hits.map((hit) => [hit.url, hit.host]), [
    ["/start", `intranet.example:${port}`],
    ["/final", `intranet.example:${port}`],
  ]);

  const echo = await safeFetch(`http://intranet.example:${port}/echo`, {
    method: "post",
    body: "a=1",
    allowPrivate: true,
  });
  assert.equal(await echo.text(), "POST text/plain;charset=UTF-8 a=1");
});

test("aborting a pending request rejects with an AbortError", async () => {
  fakeDns("intranet.example", [[LOOPBACK]]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);

  await assert.rejects(
    safeFetch(`http://intranet.example:${port}/slow`, { allowPrivate: true, signal: controller.signal }),
    { name: "AbortError" },
  );
});
