/**
 * Config parsing tests.
 *
 * Regression guard for a real bug: a single `intFromEnv` helper applied a
 * port-shaped 1-65535 ceiling to every numeric setting, so exporting the
 * five-minute run timeout that the README documents as the DEFAULT
 * (`WEBBRAIN_RUN_TIMEOUT_MS=300000`) crashed the server at startup with
 * "must be a valid TCP port".
 *
 * Ports and durations are different types with different bounds. These tests
 * exist to keep them that way.
 *
 * Run: node --test test/config.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import test from "node:test";

/** ESM caches by URL, so a unique query string forces a fresh module + re-read of env. */
let seq = 0;
async function loadConfig(env) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await import(`../dist/config.js?case=${seq++}`);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CLEAN = {
  WEBBRAIN_BRIDGE_PORT: undefined,
  WEBBRAIN_BRIDGE_PATH: undefined,
  WEBBRAIN_COMMAND_TIMEOUT_MS: undefined,
  WEBBRAIN_RUN_TIMEOUT_MS: undefined,
  WEBBRAIN_POLL_INTERVAL_MS: undefined,
};

test("defaults are sane and the bridge URL is loopback", async () => {
  const { config, bridgeUrl } = await loadConfig(CLEAN);
  assert.equal(config.bridgePort, 17374, "must not collide with Cloud on 17373");
  assert.equal(config.bridgePath, "/extension");
  assert.equal(config.commandTimeoutMs, 30_000);
  assert.equal(config.defaultRunTimeoutMs, 300_000);
  assert.equal(config.pollIntervalMs, 1_000);
  assert.equal(bridgeUrl(), "ws://127.0.0.1:17374/extension");
});

test("durations above the 16-bit port ceiling are accepted", async () => {
  // The exact value the README documents. This threw before the fix.
  const { config } = await loadConfig({ ...CLEAN, WEBBRAIN_RUN_TIMEOUT_MS: "300000" });
  assert.equal(config.defaultRunTimeoutMs, 300_000);
});

test("every duration setting accepts a large value", async () => {
  const { config } = await loadConfig({
    ...CLEAN,
    WEBBRAIN_COMMAND_TIMEOUT_MS: "120000",
    WEBBRAIN_RUN_TIMEOUT_MS: "3600000",
    WEBBRAIN_POLL_INTERVAL_MS: "250000",
  });
  assert.equal(config.commandTimeoutMs, 120_000);
  assert.equal(config.defaultRunTimeoutMs, 3_600_000);
  assert.equal(config.pollIntervalMs, 250_000);
});

test("ports keep their 1-65535 bound", async () => {
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBBRAIN_BRIDGE_PORT: "70000" }),
    /must be a valid TCP port/,
  );
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBBRAIN_BRIDGE_PORT: "0" }),
    /must be a valid TCP port/,
  );
});

test("non-numeric and partially-numeric values are rejected outright", async () => {
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBBRAIN_BRIDGE_PORT: "abc" }),
    /must be an integer/,
  );
  // parseInt("8080abc") silently yields 8080; that is a typo, not a config.
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBBRAIN_BRIDGE_PORT: "8080abc" }),
    /must be an integer/,
  );
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBBRAIN_RUN_TIMEOUT_MS: "5s" }),
    /must be an integer/,
  );
});

test("non-positive durations are rejected", async () => {
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBBRAIN_POLL_INTERVAL_MS: "0" }),
    /positive duration in milliseconds/,
  );
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBBRAIN_COMMAND_TIMEOUT_MS: "-1" }),
    /positive duration in milliseconds/,
  );
});
