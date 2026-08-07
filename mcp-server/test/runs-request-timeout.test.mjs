import assert from "node:assert/strict";
import test from "node:test";

process.env.WEBBRAIN_POLL_INTERVAL_MS = "5";

const { awaitSettled } = await import("../dist/runs.js");
const { BridgeError } = await import("../dist/bridge.js");

test("awaitSettled bounds each status request by the remaining run budget", async () => {
  let observedRequestTimeout;
  const bridge = {
    async request(_action, _payload, requestTimeoutMs) {
      observedRequestTimeout = requestTimeoutMs;
      const delayMs = (requestTimeoutMs ?? 500) + 5;
      return await new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("status response stalled")), delayMs);
      });
    },
  };

  const startedAt = Date.now();
  const result = await awaitSettled(bridge, "stalled-run", { timeoutMs: 40 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  assert.equal(result.snapshot.status, "running");
  assert.ok(observedRequestTimeout > 0 && observedRequestTimeout < 40);
  assert.ok(elapsedMs < 250, `40ms timeout took ${elapsedMs}ms`);
});

test("a command timeout returns the run ID instead of losing recovery access", async () => {
  const bridge = {
    async request() {
      throw new BridgeError("status command timed out", undefined, "COMMAND_TIMEOUT");
    },
  };

  const result = await awaitSettled(bridge, "recoverable-run", { timeoutMs: 5_000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.snapshot.runId, "recoverable-run");
  assert.equal(result.snapshot.status, "running");
});
