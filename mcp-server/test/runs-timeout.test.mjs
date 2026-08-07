import assert from "node:assert/strict";
import test from "node:test";

// Load runs.ts with a poll interval much longer than the requested run timeout.
// Before the deadline cap, this 20ms timeout blocked for the full 500ms poll.
process.env.WEBBRAIN_POLL_INTERVAL_MS = "500";

const { awaitSettled } = await import("../dist/runs.js");

test("awaitSettled never sleeps past the requested deadline", async () => {
  const bridge = {
    async request() {
      return { runId: "deadline-run", status: "running" };
    },
  };

  const startedAt = Date.now();
  const result = await awaitSettled(bridge, "deadline-run", { timeoutMs: 20 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  assert.equal(result.snapshot.status, "running");
  assert.ok(elapsedMs < 250, `20ms timeout took ${elapsedMs}ms`);
});
