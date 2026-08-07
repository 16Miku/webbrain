import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import WebSocket from "ws";

import {
  browserRespond,
  browserStatus,
  browserTask,
} from "../dist/tools/browserTask.js";
import { main } from "../dist/index.js";
import { sharedBridge } from "../dist/util/bridgeClient.js";

let socket;
let toolsProvider;
const received = [];

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

function reply(message, result) {
  socket.send(JSON.stringify({ id: message.id, ok: true, result }));
}

before(async () => {
  process.env.WEBBRAIN_BRIDGE_PORT = String(await freePort());
  const context = {
    withToolsProvider(provider) {
      toolsProvider = provider;
      return context;
    },
  };
  await main(context);

  const bridge = sharedBridge();

  socket = new WebSocket(bridge.url);
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    received.push(message);

    if (message.action === "cloud_run") {
      reply(message, {
        runId: "clarify-run",
        status: "needs_user_input",
        pendingInput: { question: "Which account?", clarifyId: "clarify-1" },
      });
      return;
    }
    if (message.action === "cloud_respond") {
      reply(message, { runId: message.payload.runId, status: "running" });
      return;
    }
    if (message.action === "cloud_status") {
      reply(message, {
        runId: message.payload.runId,
        status: "completed",
        result: `result for ${message.payload.runId}`,
      });
    }
  });
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", client: "webbrain-extension" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
});

after(async () => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.close();
    await once(socket, "close");
  }
  await sharedBridge().stop();
});

test("plugin initialization starts the bridge and registers browser recovery tools", async () => {
  assert.equal(typeof toolsProvider, "function");
  const tools = await toolsProvider();
  const names = tools.map((registeredTool) => registeredTool.name);
  assert.ok(names.includes("browser_status"));
  assert.ok(names.includes("browser_respond"));
  assert.equal(sharedBridge().isConnected(), true);
});

test("browser_status polls an existing run and returns its result", async () => {
  const result = await browserStatus("finished-run");
  assert.equal(result.ok, true);
  assert.equal(result.runId, "finished-run");
  assert.equal(result.status, "completed");
  assert.equal(result.text, "result for finished-run");
});

test("browser_task tells the model how to answer a paused run", async () => {
  const result = await browserTask({ task: "Open the requested account", timeout: 5_000 });
  assert.equal(result.needsUserInput, true);
  assert.equal(result.runId, "clarify-run");
  assert.equal(result.clarifyId, "clarify-1");
  assert.match(result.hint, /browser_respond/);
});

test("browser_respond forwards IDs and the user's answer, then returns completion", async () => {
  const result = await browserRespond({
    runId: "clarify-run",
    clarifyId: "clarify-1",
    answer: "The work account",
    timeout: 5_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "result for clarify-run");
  const response = received.find((message) => message.action === "cloud_respond");
  assert.deepEqual(response.payload, {
    runId: "clarify-run",
    clarifyId: "clarify-1",
    answer: "The work account",
  });
});

test("a replacement socket receives nothing until it sends a valid hello", async () => {
  const rogue = new WebSocket(sharedBridge().url);
  let receivedCommands = 0;
  rogue.on("message", () => {
    receivedCommands += 1;
  });
  await once(rogue, "open");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sharedBridge().isConnected(), false);
  await assert.rejects(
    () => sharedBridge().request("cloud_run", { task: "private task", mode: "ask" }),
    /No WebBrain browser extension is connected/,
  );
  assert.equal(receivedCommands, 0);

  rogue.close();
  await once(rogue, "close");
});
