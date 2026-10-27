import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { after, before, test } from "node:test";

import { main, readNetworkOptions } from "../dist/index.js";
import { fetchUrl } from "../dist/tools/fetchUrl.js";
import { researchUrl } from "../dist/tools/researchUrl.js";
import { assertSafeUrl, isCloudMetadataHost } from "../dist/util/urlGuard.js";
import { safeFetch } from "../dist/util/safeFetch.js";
import { sharedBridge } from "../dist/util/bridgeClient.js";

let toolsProvider;
let configSchematicsSet;
let server;
let origin;
let requests = 0;

async function freePort() {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  probe.close();
  await once(probe, "close");
  return port;
}

// Mirrors LM Studio's ToolsProviderController: it parses the chat's stored
// plugin config, sent over the wire as { fields: [{ key, value }] }.
function controller(fields) {
  return {
    getPluginConfig: (schematics) => schematics.parse({ fields }),
  };
}

before(async () => {
  process.env.WEBBRAIN_BRIDGE_PORT = String(await freePort());
  const context = {
    withConfigSchematics(schematics) {
      configSchematicsSet = schematics;
      return context;
    },
    withToolsProvider(provider) {
      toolsProvider = provider;
      return context;
    },
  };
  await main(context);

  server = createServer((req, res) => {
    requests += 1;
    if (req.url === "/to-metadata") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<html><head><title>Router</title></head><body><main>" +
        "Local admin page. ".repeat(10) +
        "</main></body></html>",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await sharedBridge().stop();
});

test("private network access is a user plugin setting that defaults to off", () => {
  assert.ok(configSchematicsSet, "main() registers the plugin config schematics");
  assert.equal(configSchematicsSet.parse({ fields: [] }).get("allowPrivateNetwork"), false);
  assert.deepEqual(readNetworkOptions(controller([])), { allowPrivate: false });
  assert.deepEqual(
    readNetworkOptions(controller([{ key: "allowPrivateNetwork", value: true }])),
    { allowPrivate: true },
  );
  assert.deepEqual(
    readNetworkOptions({
      getPluginConfig() {
        throw new Error("config unavailable");
      },
    }),
    { allowPrivate: false },
  );
});

test("the HTTP tools do not offer allowPrivate to the model", async () => {
  const tools = await toolsProvider(controller([{ key: "allowPrivateNetwork", value: true }]));
  for (const name of ["fetch_url", "research_url"]) {
    const registered = tools.find((registeredTool) => registeredTool.name === name);
    assert.ok(registered, name);
    assert.equal("allowPrivate" in registered.parametersSchema.shape, false, name);
  }
});

test("a model-sent allowPrivate cannot reach a loopback service", async () => {
  requests = 0;
  // fetchUrl/researchUrl take the model's arguments as-is; a stray flag there is ignored.
  const fetched = await fetchUrl({ url: `${origin}/`, allowPrivate: true });
  assert.equal(fetched.success, false);
  assert.match(fetched.error, /private network access is off/);

  const researched = await researchUrl({ url: `${origin}/`, allowPrivate: true });
  assert.equal(researched.success, false);
  assert.match(researched.error, /private network access is off/);

  assert.equal(requests, 0);
});

test("the user's setting opens loopback targets to both HTTP tools", async () => {
  const network = readNetworkOptions(controller([{ key: "allowPrivateNetwork", value: true }]));

  const fetched = await fetchUrl({ url: `${origin}/` }, network);
  assert.equal(fetched.success, true);
  assert.equal(fetched.title, "Router");

  const researched = await researchUrl({ url: `${origin}/` }, network);
  assert.equal(researched.success, true);
  assert.match(researched.text, /Local admin page/);
});

test("cloud metadata endpoints stay blocked with private network access on", async () => {
  requests = 0;
  const network = { allowPrivate: true };
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://2852039166/latest/meta-data/",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://169.254.170.2/v2/credentials/",
    "http://100.100.100.200/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
  ]) {
    const result = await fetchUrl({ url }, network);
    assert.equal(result.success, false, url);
    assert.match(result.error, /cloud metadata endpoint/, url);
  }

  const researched = await researchUrl(
    { url: "http://169.254.169.254/latest/meta-data/" },
    network,
  );
  assert.equal(researched.success, false);
  assert.match(researched.error, /cloud metadata endpoint/);

  const redirected = await fetchUrl({ url: `${origin}/to-metadata` }, network);
  assert.equal(redirected.success, false);
  assert.match(redirected.error, /cloud metadata endpoint/);
  assert.equal(requests, 1);
});

test("cloud metadata endpoints are matched on address bytes, in every IPv6 form that embeds them", () => {
  const blocked = [
    "169.254.169.254",
    "[::ffff:a9fe:a9fe]",         // IPv4-mapped (WHATWG form)
    "[::ffff:169.254.169.254]",   // IPv4-mapped, dotted
    "[0:0:0:0:0:ffff:a9fe:a9fe]", // IPv4-mapped, uncompressed
    "[::a9fe:a9fe]",              // IPv4-compatible
    "[::ffff:0:a9fe:a9fe]",       // IPv4-translated
    "[64:ff9b::a9fe:a9fe]",       // NAT64
    "[64:ff9b::169.254.169.254]", // NAT64, dotted
    "[2002:a9fe:a9fe::1]",        // 6to4
    "[2001:0:a9fe:a9fe::f7f7:f7f7]", // Teredo server
    "[::ffff:6464:64c8]",         // mapped Alibaba 100.100.100.200
    "[fd00:ec2:0:0:0:0:0:254]",   // AWS IPv6, uncompressed
    "[FD00:EC2::23]",             // AWS EKS IPv6, upper-case
    "metadata.google.internal.",  // trailing dot
  ];
  for (const host of blocked) {
    assert.equal(isCloudMetadataHost(host), true, host);
    assert.throws(() => assertSafeUrl(`http://${host}/`, { allowPrivate: true }), /cloud metadata/, host);
  }
  for (const host of ["8.8.8.8", "[::ffff:808:808]", "[64:ff9b::808:808]", "[2002:808:808::1]",
    "169.254.169.253", "[fd00:ec2::255]", "192.168.1.1", "[::1]"]) {
    assert.equal(isCloudMetadataHost(host), false, host);
    assert.doesNotThrow(() => assertSafeUrl(`http://${host}/`, { allowPrivate: true }), host);
  }
});

test("with the setting on, safeFetch's own literal-IP check lets loopback through but not metadata", async () => {
  requests = 0;
  const loopback = origin.replace("localhost", "127.0.0.1");
  const res = await safeFetch(`${loopback}/`, { allowPrivate: true });
  assert.equal(res.status, 200);
  await res.body?.cancel();
  assert.equal(requests, 1);
  await assert.rejects(safeFetch(`${loopback}/`), /private network access is off/);
  assert.equal(requests, 1, "still blocked with the setting off");
  await assert.rejects(
    safeFetch("http://[64:ff9b::a9fe:a9fe]/latest/meta-data/", { allowPrivate: true }),
    /cloud metadata/,
  );
});
