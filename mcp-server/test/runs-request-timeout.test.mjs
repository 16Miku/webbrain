import assert from "node:assert/strict";
import test from "node:test";

process.env.WEBBRAIN_POLL_INTERVAL_MS = "5";

const { awaitSettled, startRun } = await import("../dist/runs.js");
const { BridgeError } = await import("../dist/bridge.js");

test("startRun forwards its caller-supplied run ID and command budget", async () => {
  let observed;
  const bridge = {
    async request(action, payload, requestTimeoutMs) {
      observed = { action, payload, requestTimeoutMs };
      return { runId: payload.runId, status: "running" };
    },
  };

  const result = await startRun(
    bridge,
    { runId: "recoverable-start", task: "do work", mode: "ask" },
    25,
  );

  assert.equal(result.runId, "recoverable-start");
  assert.deepEqual(observed, {
    action: "cloud_run",
    payload: { runId: "recoverable-start", task: "do work", mode: "ask" },
    requestTimeoutMs: 25,
  });
});

test("startRun rejects API mutation permission in ask mode before dispatch", async () => {
  let dispatched = false;
  const bridge = {
    async request() {
      dispatched = true;
    },
  };

  await assert.rejects(
    () =>
      startRun(bridge, {
        task: "read the page",
        mode: "ask",
        apiMutationsAllowed: true,
      }),
    /requires mode 'act'/,
  );
  assert.equal(dispatched, false);
});

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

test("a disconnected status request preserves recovery access to the run", async () => {
  const bridge = {
    async request() {
      throw new BridgeError(
        "extension disconnected mid-command",
        undefined,
        "COMMAND_INTERRUPTED",
      );
    },
  };

  const result = await awaitSettled(bridge, "interrupted-run", { timeoutMs: 5_000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.snapshot.runId, "interrupted-run");
  assert.equal(result.snapshot.status, "running");
});
