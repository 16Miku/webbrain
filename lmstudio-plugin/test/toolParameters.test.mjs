/**
 * Tool arguments are parsed by the zod bundled with @lmstudio/sdk, not only
 * by the one this plugin imports: `tool()` wraps our per-field schemas in its
 * own `z.object(...)`, and LM Studio's plugin host turns that object into the
 * JSON schema the model sees. Both copies must be the same zod major. With
 * zod 4 fields inside the SDK's zod 3 object, every call failed with
 * "keyValidator._parse is not a function" and the model was shown tools with
 * no parameters at all.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

import { main } from "../dist/index.js";
import { sharedBridge } from "../dist/util/bridgeClient.js";

// Resolve zod-to-json-schema from the SDK's own location, so the conversion
// below uses the copy LM Studio's plugin host uses for tool definitions.
const require = createRequire(import.meta.url);
const { zodToJsonSchema } = createRequire(require.resolve("@lmstudio/sdk"))(
  "zod-to-json-schema",
);

// One valid call per registered tool, touching each validator it declares.
const VALID_ARGS = {
  fetch_url: {
    url: "https://example.com/data.json",
    method: "POST",
    headers: { accept: "application/json" },
    body: "{}",
    timeout: 5000,
    maxChars: 1000,
    compact: false,
  },
  research_url: { url: "https://example.com/post", timeout: 5000, maxChars: 1000, compact: true },
  browser_task: { task: "List unread messages.", mode: "act", timeout: 60_000, allowApiMutations: false },
  browser_status: { runId: "run-1" },
  browser_respond: { runId: "run-1", clarifyId: "clarify-1", answer: "work account", timeout: 5000 },
  browser_abort: { runId: "run-1" },
};

const INVALID_ARGS = {
  fetch_url: { url: "not a url" },
  research_url: { url: "https://example.com/post", timeout: "soon" },
  browser_task: { task: "List unread messages.", mode: "delete" },
  browser_status: { runId: 42 },
  browser_respond: { runId: "run-1", clarifyId: "clarify-1", answer: "" },
  browser_abort: {},
};

let tools;

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

before(async () => {
  process.env.WEBBRAIN_BRIDGE_PORT = String(await freePort());
  let toolsProvider;
  const context = {
    withConfigSchematics() {
      return context;
    },
    withToolsProvider(provider) {
      toolsProvider = provider;
      return context;
    },
  };
  await main(context);
  tools = new Map((await toolsProvider()).map((registeredTool) => [registeredTool.name, registeredTool]));
});

after(async () => {
  await sharedBridge().stop();
});

test("valid arguments pass the SDK's parameter check", () => {
  for (const [name, registeredTool] of tools) {
    assert.ok(VALID_ARGS[name], `add a VALID_ARGS entry for ${name}`);
    assert.doesNotThrow(() => registeredTool.checkParameters(VALID_ARGS[name]), name);
  }
});

test("invalid arguments are rejected with the SDK's readable error", () => {
  for (const [name, registeredTool] of tools) {
    assert.ok(INVALID_ARGS[name], `add an INVALID_ARGS entry for ${name}`);
    const expected = new RegExp(`Failed to parse arguments for tool "${name}"`);
    assert.throws(() => registeredTool.checkParameters(INVALID_ARGS[name]), expected);
    // The plugin host calls implementation() directly; it parses the same way.
    assert.throws(() => registeredTool.implementation(INVALID_ARGS[name], {}), expected);
  }
});

test("the tool definition sent to the model lists every parameter", () => {
  for (const [name, registeredTool] of tools) {
    const schema = zodToJsonSchema(registeredTool.parametersSchema);
    assert.deepEqual(
      Object.keys(schema.properties ?? {}),
      Object.keys(registeredTool.parametersSchema.shape),
      name,
    );
  }
  const fetchSchema = zodToJsonSchema(tools.get("fetch_url").parametersSchema);
  assert.deepEqual(fetchSchema.required, ["url"]);
  assert.equal(fetchSchema.properties.url.format, "uri");
  assert.equal(fetchSchema.properties.url.description, "Absolute http(s) URL to fetch.");
});
