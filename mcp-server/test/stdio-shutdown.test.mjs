import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

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

function waitForText(stream, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      stream.off("data", onData);
      reject(new Error(`Timed out waiting for ${pattern}; stderr was: ${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      stream.off("data", onData);
      resolve(output);
    };
    stream.on("data", onData);
  });
}

test("closing MCP stdin stops the bridge process", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: packageDir,
    env: { ...process.env, WEBBRAIN_BRIDGE_PORT: String(port) },
    stdio: ["pipe", "ignore", "pipe"],
  });

  try {
    await waitForText(child.stderr, /ready on stdio/, 7_000);
    const exited = once(child, "exit");
    child.stdin.end();

    const [code, signal] = await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("MCP process stayed alive after stdin EOF")), 2_000),
      ),
    ]);
    assert.equal(signal, null);
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
