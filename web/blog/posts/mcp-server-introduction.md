---
title: >
  WebBrain MCP: Give Claude Code, OpenCode, and Codex access to your real browser session
slug: mcp-server-introduction
sortOrder: 90
date: 2026-08-08
readTime: 10 min read
description: >
  The WebBrain MCP server lets any MCP-capable coding agent — Claude Code, OpenCode, Codex, Cursor — delegate browser tasks to your real, already-authenticated browser. No headless login dances, no cookie transfers. Just ask your agent to fill out a form, check a dashboard, or read a page behind SSO, and it runs in the browser you actually use.
excerpt: >
  The WebBrain MCP server bridges Claude Code, OpenCode, and Codex to your real, already-signed-in browser. No headless login walls. No cookie transfers. Just ask your coding agent to interact with any page you're logged into.
titleTag: >
  WebBrain MCP: Claude Code + OpenCode + Codex in your real browser — WebBrain Blog
ogTitle: >
  WebBrain MCP: Claude Code, OpenCode, Codex in your real browser
ogDescription: >
  The WebBrain MCP server lets any MCP-capable agent delegate browser tasks to your real, authenticated Chrome or Firefox session. No headless login walls.
twitterTitle: >
  WebBrain MCP: Claude Code, OpenCode, Codex in your real browser
twitterDescription: >
  Give your coding agent the ability to interact with any page you're already logged into — Stripe, Gmail, GitHub, banking. Just ask.
keywords:
  - WebBrain
  - MCP
  - Model Context Protocol
  - Claude Code
  - OpenCode
  - Codex
  - Cursor
  - browser agent
  - automation
  - authentication
  - headless browser
  - local LLM
  - Chrome extension
  - Firefox extension
html: true
lede: >
  We built the WebBrain MCP server so that any MCP-capable coding agent — Claude Code, OpenCode, Codex, Cursor — can delegate browser tasks to the user's real, already-authenticated browser session. Instead of spinning up a headless browser that starts logged out of everything, the agent hands a goal to WebBrain running in the user's own Chrome or Firefox, and the extension carries it out in the tab the user is already looking at. This post explains how it works, how it differs from other browser MCP approaches, and how to wire it up to your agent of choice.
---

<figure>
  <img src="/assets/mcp-diagram.png" alt="Claude Code, OpenCode, Codex — each connected via stdio to the WebBrain MCP server, which connects over WebSocket to the WebBrain browser extension, which controls the user's authenticated browser tabs.">
  <figcaption>The WebBrain MCP server sits between your coding agent and your browser. The extension runs in your real session — already logged in, cookies present, MFA passed.</figcaption>
</figure>

## Why an MCP server for browser automation?

A headless browser automation tool starts fresh every time. No cookies. No signed-in sessions. No MFA tokens. The first useful page hits you with a login wall, and you either hardcode credentials into a script or manually replay cookies after every restart.

WebBrain is different by design. It runs as a **browser extension** — Chrome (MV3) or Firefox (MV2) — with an embedded agent loop living inside the user's own browser profile. You are already signed in to GitHub, your banking portal, your Stripe dashboard, your internal admin tools. The extension can reach them with the user's full permissions, exactly as if a human were clicking.

The MCP server exposes that capability to any MCP client:

```
Claude Code ──stdio──▶ webbrain-mcp ──ws://127.0.0.1:17374──▶ WebBrain extension ──▶ your tabs
```

The MCP client (Claude Code, OpenCode, Codex, Cursor) launches `npx -y @webbrain/mcp-server` as a child process. That process hosts a local WebSocket listener on `127.0.0.1:17374`. The WebBrain extension dials **out** to that listener — Manifest V3 extensions can't listen on sockets, so the direction is fixed. Once handshaken, the MCP client sends a task; the extension runs it in the browser; the result flows back through the same channel.

## How it differs from headless browser MCP tools

Other browser MCP servers in the ecosystem typically wrap a **headless Chromium** via Playwright or similar. That approach has tradeoffs:

| | **WebBrain MCP** | **Headless browser MCP** |
|---|---|---|
| **Authentication** | Your real browser session — already signed in, MFA passed | Fresh browser — login walls on the first useful page |
| **Cookie management** | None needed — uses existing session cookies | Manual export/replay, or credential injection in code |
| **MFA** | Works as-is — your browser already passed it | Cannot pass MFA programmatically |
| **Tool surface** | 5 task-level tools (delegation pattern) | 8–12 primitive tools (navigate, click, type, screenshot…) |
| **Safety model** | Ask/Act/Dev modes, per-action permission gate | Trust boundary at the MCP client only |
| **Local models** | Full local provider support (llama.cpp, vLLM, Ollama, LM Studio) | Depends on the agent framework wrapping the MCP server |
| **Cross-origin frames** | Extension injects into iframes directly (Stripe widgets, embedded forms) | Blocked by same-origin policy unless explicitly handled |

The key architectural difference is **trust boundary placement**. Headless tools expose granular browser primitives (`click`, `type`, `navigate`, `screenshot`) through MCP — that's the whole surface area. WebBrain deliberately does **not**. It exposes five **task-level** tools instead:

| Tool | Purpose |
|---|---|
| `webbrain_run` | Delegate a browser task. `mode='ask'` is read-only; `mode='act'` can click and type, gated by in-browser approval. |
| `webbrain_status` | Poll a run, or list every run. |
| `webbrain_respond` | Answer a run sitting at `needs_user_input`. |
| `webbrain_abort` | Stop a run. Actions already taken are not undone. |
| `webbrain_connection` | Report whether the extension is attached, and how to fix it if not. |

This is not a limitation — it's a safety decision. WebBrain's capability × origin permission gate runs inside the extension's agent loop (`_executeToolBatch`), not inside the MCP tool execution path. A headless MCP tool calling `click` directly bypasses every approval prompt the product is built on. Delegating a goal instead keeps the trust boundary in the browser, where the human is.

## Setup: register the MCP server

The server is published on npm as `@webbrain/mcp-server`. Add it to your MCP client's configuration:

### Claude Code

```bash
claude mcp add webbrain -- npx -y @webbrain/mcp-server
```

### OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "webbrain": {
      "type": "local",
      "command": ["npx", "-y", "@webbrain/mcp-server"]
    }
  }
}
```

### Codex (or any `mcp.json` consumer)

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

### Cursor

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

After adding the config, restart the MCP client. On startup, it spawns `npx -y @webbrain/mcp-server` as a child process. That process binds to `127.0.0.1:17374` and waits for the extension to connect.

## Connecting the browser extension

The MCP server alone is not enough — you need the WebBrain extension installed and pointed at it:

1. Install the [WebBrain extension](https://webbrain.one) in Chrome or Firefox and open your browser.
2. In **WebBrain → Settings → General → Advanced → Cloud bridge**, set the URL to `ws://127.0.0.1:17374/extension` and enable it.
3. Restart your MCP client (or just restart the MCP server process) and ask the client to call `webbrain_connection` to verify.

The extension holds exactly one outbound bridge socket. Pointing it here means it is *not* pointed at WebBrain Cloud (port `17373`) or the LM Studio plugin (port `17375`). Switch it under **Settings → General → Advanced → Cloud bridge** when you need to change destinations.

<div class="callout">
**Network binding is loopback-only.** The listener binds `127.0.0.1` only. Anything that can reach this port can drive your signed-in browser — never expose it to a network or container bridge. The shipping extension sends no shared secret, so treat the port as trusted-local.
</div>

## Example usage

Once configured, the MCP client sees the five WebBrain tools in its tool list. You interact with them naturally:

> "Open my Stripe dashboard and list last week's failed payments with amounts and customer emails."

The agent calls:

```
webbrain_run(
  task: "open the Stripe dashboard and list last week's failed payments with amounts and customer emails",
  mode: "ask"
)
```

The extension receives the task, navigates the already-authenticated dashboard, reads the results, and returns a summary. `mode='ask'` is read-only — it cannot click, type, or submit. For interaction, use `mode='act'`, which requires in-browser approval for consequential actions via the capability × origin permission gate.

If a run stops with status `needs_user_input`, the extension is asking a clarifying question. Answer it with `webbrain_respond`, passing the `run_id` and `clarify_id` from the snapshot.

## Configuration variables

All environment-driven, set these before launching the MCP server if you need non-default behavior:

| Variable | Default | Meaning |
|---|---|---|
| `WEBBRAIN_BRIDGE_PORT` | `17374` | Port the extension connects to. |
| `WEBBRAIN_BRIDGE_PATH` | `/extension` | Path segment; must match the URL in Settings. |
| `WEBBRAIN_COMMAND_TIMEOUT_MS` | `30000` | Per-command reply timeout. |
| `WEBBRAIN_RUN_TIMEOUT_MS` | `300000` | Default ceiling for `webbrain_run` polling. |
| `WEBBRAIN_POLL_INTERVAL_MS` | `1000` | Status poll interval. |

## When to use this vs. a headless MCP server

Choose WebBrain MCP when:

- You need to interact with **sites you're already authenticated to** (banking, SaaS dashboards, admin panels, email)
- **MFA** is involved and you can't programmatically log in
- You want **explicit safety modes** (read-only first, then gated interactive mode)
- You want **local-first execution** with your own LLMs — no API calls leave your machine
- You need the extension to handle **cross-origin iframes** (Stripe checkout widgets, embedded forms)

Choose a headless browser MCP server when:

- You're building **automated web workflows in code** (scraping, testing, scheduled form submissions)
- You can **handle authentication programmatically** (known credentials, no MFA)
- You need **tight integration with a Python agent framework** (LangChain, AutoGPT, etc.)
- You're comfortable with the login-wall workaround and managing session state yourself

They are not mutually exclusive. A headless browser MCP server handles programmatic scraping fine. WebBrain MCP handles authenticated, interactive tasks that need your real browser session.

## Security model

The extension runs with `<all_urls>` host permissions. The full threat model is in [`docs/security-model.md`](https://github.com/webbrain-one/webbrain/blob/main/docs/security-model.md). Key points:

- **Ask mode is read-only** — only semantic read tools (`get_accessibility_tree`, `read_page`, `extract_data`, etc.) are available. No clicks, no typing, no navigation.
- **Act mode requires per-action approval** — every consequential tool (click, type, navigate, execute_js, network, download) goes through a deterministic `(capability, host)` permission gate. You choose Allow/Always/Deny per origin.
- **Plan-before-Act** — an optional structured planner runs before any browser tools execute, and the side panel renders an editable review card for approval.
- **Loop detection** — three independent detectors (general repeat, coordinate click, navigation) stop the agent if it's stuck repeating actions.
- **Prompt injection defense** — page-derived content is wrapped in `<untrusted_page_content>` markers so the model treats it as data, not instructions.

The bridge itself is loopback-only. Connections from HTTP(S) pages and non-extension browser origins are rejected before they can replace the extension socket. Accepted connections must present the extension's `hello` frame with `client: "webbrain-extension"`.

Tags: #MCP #ModelContextProtocol #ClaudeCode #OpenCode #Codex #Cursor #BrowserAgent #Automation #LocalLLM
