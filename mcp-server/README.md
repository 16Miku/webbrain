# WebBrain MCP Server

Give any MCP client — Claude Code, Codex, Cursor, OpenClaw — the ability to run tasks in **your real browser session**: already signed in, cookies present, MFA already passed.

That session is the whole point. A headless automation framework starts logged out of everything and hits a login wall on the first useful page. WebBrain is already inside the browser you use.

```
Claude Code ──stdio──▶ webbrain-mcp ──ws://127.0.0.1:17374──▶ WebBrain extension ──▶ your tabs
```

## Install

```bash
npm install -g @webbrain/mcp-server
```

Or run from a checkout:

```bash
cd mcp-server && npm install && npm run build
```

## Connect the browser

> **Chromium only.** Chrome, Edge, Brave, Opera, Vivaldi. The bridge runs from the extension's **offscreen document**, and the Firefox build has none — `cloud-bridge.js` and `cloud-runs.js` live only under `src/chrome/`. See [`src/firefox/ARCHITECTURE.md`](../src/firefox/ARCHITECTURE.md).

The MCP server hosts the listener; the extension dials out to it. A Manifest V3 extension cannot listen on a socket, so the direction is fixed.

1. Install the [WebBrain extension](https://webbrain.one) and open your browser.
2. In **WebBrain → Settings → Cloud bridge**, set the URL to `ws://127.0.0.1:17374/extension` and enable it.
3. Ask your MCP client to call `webbrain_connection` to confirm.

> **One bridge at a time.** The extension holds exactly one outbound bridge socket. Pointing it here means it is *not* pointed at WebBrain Cloud (`17373`) or the LM Studio plugin (`17375`). Switch by changing the URL in Settings.

## Register with a client

**Claude Code**

```bash
claude mcp add webbrain -- npx -y @webbrain/mcp-server
```

**Codex / Cursor / anything reading `mcp.json`**

```json
{
  "mcpServers": {
    "webbrain": {
      "command": "npx",
      "args": ["-y", "@webbrain/mcp-server"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `webbrain_run` | Delegate a task. `mode='ask'` is read-only; `mode='act'` can click and type, gated by in-browser approval. |
| `webbrain_status` | Poll a run, or list every run. |
| `webbrain_respond` | Answer a run sitting at `needs_user_input`. |
| `webbrain_abort` | Stop a run. Actions already taken are not undone. |
| `webbrain_connection` | Report whether the extension is attached, and how to fix it if not. |

### Example

> "Open my Stripe dashboard and list last week's failed payments."

```
webbrain_run(task: "open the Stripe dashboard and list last week's failed
             payments with amounts and customer emails", mode: "ask")
```

Read-only, in the tab you are already authenticated in. No API key, no headless login dance.

## Why task-level and not 50 browser tools

WebBrain exposes roughly fifty primitives internally — `click_ax`, `type_ax`, `extract_data`, `iframe_read` and so on. This server deliberately does **not** surface them.

**Safety.** WebBrain's capability × origin permission gate runs in the agent loop (`_executeToolBatch`), not inside `executeTool()`. An MCP layer calling primitives directly would sit *below* the gate and bypass every approval prompt the product is built on. Delegating a goal keeps the trust boundary in the browser, where the human is.

**Cost.** Driving a UI one primitive at a time over a socket costs a round trip and a slab of tokens per click. Handing over a goal costs one call.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WEBBRAIN_BRIDGE_PORT` | `17374` | Port the extension connects to. |
| `WEBBRAIN_BRIDGE_PATH` | `/extension` | Path segment; must match the URL in Settings. |
| `WEBBRAIN_COMMAND_TIMEOUT_MS` | `30000` | Per-command reply timeout. |
| `WEBBRAIN_RUN_TIMEOUT_MS` | `300000` | Default ceiling for `webbrain_run` polling. |
| `WEBBRAIN_POLL_INTERVAL_MS` | `1000` | Status poll interval. |

## Security notes

- The listener binds `127.0.0.1` only. Anything that can reach this port can drive your signed-in browser — never expose it to a network or a container bridge.
- Connections must present the extension's `hello` frame with `client: "webbrain-extension"`; anything else is closed. This is **not** authentication. The shipping extension sends no shared secret, so a local process could impersonate it. Treat the port as trusted-local, and see [`docs/security-model.md`](../docs/security-model.md).
- A `webbrain_run` timeout does **not** abort the run. A task that already submitted a form should not be silently killed — the browser keeps going and `webbrain_status` picks it back up.
- `allow_api_mutations` lifts WebBrain's UI-first rule and is off by default. The UI path is visible and stoppable; direct API mutations are neither.

## Tests

```bash
npm run build && node --test test/bridge.test.mjs
```

The suite stands up the real listener and connects a fake extension speaking the exact frames `src/chrome/src/offscreen/cloud-bridge.js` emits — handshake, id correlation under concurrency, error propagation, disconnect mid-command, and the poll/timeout/clarify paths. If the extension's wire format changes, these fail. That is intentional.

## License

MIT
