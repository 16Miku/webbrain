<p align="center">
  <img src="assets/logo-mark.png" alt="WebBrain logo" width="92">
</p>

<h1 align="center">WebBrain</h1>

<p align="center">
  Open-source AI browser agent for chatting with pages, automating tasks, and running multi-step workflows with your choice of LLM.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb"><img src="https://img.shields.io/badge/Chrome-Install-4285F4?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="Install WebBrain from the Chrome Web Store"></a>
  <a href="https://addons.mozilla.org/en-US/firefox/addon/webbrain/"><img src="https://img.shields.io/badge/Firefox-Install-FF7139?style=for-the-badge&amp;logo=firefoxbrowser&amp;logoColor=white" alt="Install WebBrain from Firefox Browser Add-ons"></a>
  <a href="https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo"><img src="https://img.shields.io/badge/Edge-Install-0A84FF?style=for-the-badge&amp;logo=microsoftedge&amp;logoColor=white" alt="Install WebBrain from Microsoft Edge Add-ons"></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="docs/">Docs</a> ·
  <a href="https://webbrain.one">Website</a> ·
  <a href="LICENSE">MIT License</a>
</p>

![WebBrain reading a page, filling in a form, and fetching a file](assets/webbrain-demo.gif)

WebBrain is a browser extension that puts an AI agent in a side panel next to
your tabs. Ask it about the page you're on, or hand it a task and let it click,
type, and navigate its way through. It runs on the model you choose — a local
llama.cpp or Ollama server, a frontier cloud API, or the managed default that
needs no setup at all.

## Install

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb),
[Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/webbrain/), or
[Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo).

<details>
<summary><b>Or load it from source</b></summary>

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

**Chrome** — open `chrome://extensions/`, enable **Developer mode** (top
right), click **Load unpacked**, and select the `webbrain/src/chrome` folder.

**Firefox** — open `about:debugging#/runtime/this-firefox`, click **Load
Temporary Add-on**, and select `src/firefox/manifest.json`. Temporary add-ons
are removed when Firefox restarts; permanent installation requires signing via
[addons.mozilla.org](https://addons.mozilla.org).

</details>

## Use it

Click the WebBrain icon to open the side panel, then type something like:

- "Summarize this page"
- "Find all links about pricing"
- "Fill in the search box with 'AI agents' and click Search"
- "Navigate to github.com and find trending repositories"

Three modes control what the agent is allowed to do:

| Mode | What it can do |
|---|---|
| **Ask** | Read-only. Reads the page, answers questions, fetches URLs. |
| **Act** | Clicks, types, navigates, uploads, downloads, fills forms. |
| **Dev** | Adds page source, styles, console, network, and reversible page edits. |

## Pick a model

**WebBrain Cloud 1.0** is the default and needs no API key or local setup.

**Local models** need no API key either. Point WebBrain at any OpenAI-compatible
server:

```bash
llama-server -m your-model.gguf --port 8080          # llama.cpp
ollama serve                                          # Ollama  → :11434/v1
vllm serve your-model --port 8000                     # vLLM    → :8000/v1
python -m sglang.launch_server --model-path your-model --port 30000
```

LM Studio (`:1234/v1`), Jan (`:1337/v1`), and LocalAI (`:8080/v1`) work the same
way. Load a model with **at least a 16k-token context window** — 8k works only
with the Compact tier, and 4k is too small for the system prompt plus tool
schemas. WebBrain auto-detects the real window for llama.cpp, Ollama, and LM
Studio, and auto-compacts the conversation as it fills up. There is also a
preview `ollama launch webbrain --model <model>` handoff. Details:
[providers and models](docs/providers-and-models.md#local-providers).

**Cloud APIs** — OpenAI, Anthropic Claude, Google Gemini, Azure OpenAI, AWS
Bedrock, Mistral, DeepSeek, xAI Grok, MiniMax, Kimi, Qwen, z.ai GLM, Groq,
Together, Cloudflare, Nvidia NIM, Hugging Face, Fireworks, OpenRouter, and more.
Settings ships **103 built-in provider cards** with base URLs and default models
pre-filled — see the [full catalog](docs/providers-and-models.md#extended-provider-catalog).

## Features

- **Reads any page** — text, links, forms, tables, PDFs, and interactive
  elements, via the accessibility tree rather than brittle selectors
- **Acts on it** — click, type, scroll, navigate, upload, download, and verify
  forms, with per-site permission prompts before consequential actions
- **Plan before Act** — Act and Dev can generate a structured plan, show it for
  approval, and pin the approved plan to the scratchpad before any tool runs
- **Multi-step agent** — autonomous tool-use loop, configurable up to 195 steps
  (default 130), with a Continue button when it hits the limit
- **Saved workflows** — turn a successful run into a reusable, value-free
  workflow you can re-run, export, and share
- **Scheduled tasks and watches** — `/schedule` for later, `/watch` to poll a
  page and act when a condition is met
- **Skills** — trusted instructions and tools that load only when relevant
- **Smart context** — token-aware auto-compaction, tool-result limits, and
  emergency overflow recovery
- **Per-tab conversations** — each tab keeps its own history; optional local
  user memory for stated preferences
- **Reading-first side panel** — streaming Ask replies, floating controls that
  keep your question in view as answers grow, copy buttons, a page-inspection
  banner, and a stop button that works mid-run
- **Deterministic by default** — temperature `0.15` for browser-control
  decisions, `0.3` for Ask, `0` for vision screenshot descriptions

## Agent tools

WebBrain separates **tier** from **mode**. Tier (`compact`, `mid`, `full`) is a
per-provider setting controlling how many tools a model sees — Compact suits
small local models, Full unlocks hover, drag-drop, frames, and shadow DOM. Mode
(`ask`, `act`, `dev`) controls what the user is allowing.

The full tool-by-tier matrix, WebMCP notes, and Dev-mode diagnostics are in
[agent tools](docs/agent-tools.md).

## Slash commands

Type `/help` in the panel for full signatures and flags. The most useful ones:

| Command | What it does |
|---------|--------------|
| `/ask` · `/act` · `/dev` · `/plan` | Switch mode before sending |
| `/schedule [prompt]` | Create a scheduled task |
| `/watch [--keep] [--secs <30-120>] [--long \| --short] <condition and action> [/beep]` | Poll the current page and act when a condition is met |
| `/workflow --save <name>` | Compile the last successful run into a reusable workflow |
| `/memory --add <text>` | Save a user preference |
| `/screenshot [--full-page]` | Capture the tab, or the full scrollable page |
| `/record [--transcribe]` | Record the current tab, optionally saving a transcript |
| `/export [--traces \| --config]` | Download the conversation, tool chain, or a Settings snapshot |
| `/compact` · `/reset` · `/verbose` | Compact context, clear the conversation, toggle tool detail |
| `/allow-api` | Per-conversation override letting `fetch_url` mutate when the UI is failing |

`/watch` runs its first check immediately, then polls every 60 seconds
(`--secs` accepts 30–120). Relative conditions like "when a new commit appears"
establish a baseline on the first check; `--keep` keeps the watch running and
suppresses repeated alerts for the same stable event key.

Full reference, including `/dangerously-skip-permissions` and the run-capture
suffixes: [slash commands](docs/slash-commands.md).

## Keyboard Shortcuts

Chrome side panel shortcuts work when the WebBrain side panel has focus.

| Shortcut | What it does |
|----------|--------------|
| `Ctrl+/` or `Cmd+/` | Focus the input |
| `Ctrl+Shift+A` or `Cmd+Shift+A` | Switch to Ask mode |
| `Ctrl+Shift+X` or `Cmd+Shift+X` | Switch to Act mode |
| `Ctrl+Shift+D` or `Cmd+Shift+D` | Switch to Dev mode |
| `Escape` | Stop the active run, unless it is only dismissing slash-command autocomplete |
| `Escape` twice | Stop an active recording from WebBrain or browser pages |

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | System overview, turn flow, subsystems |
| [Agent tools](docs/agent-tools.md) | Tiers, modes, and the full tool matrix |
| [Slash commands](docs/slash-commands.md) | Every command and flag |
| [Providers and models](docs/providers-and-models.md) | All 103 provider cards, local setup, tiers |
| [Skills](docs/skills.md) | Bundled skills, importing, skill tools |
| [Security model](docs/security-model.md) | Permissions, credentials, trust boundaries |
| [Prompt-injection defense](docs/prompt-injection-defense.md) | Defense layers and known gaps |
| [Privacy and data flow](docs/privacy-and-data-flow.md) | What leaves the browser, and what doesn't |
| [Accessibility tree and refs](docs/accessibility-tree-and-refs.md) | How pages are read and targeted |
| [Site adapters](docs/site-adapters.md) | Per-site guidance |
| [Export and workflow formats](docs/export-and-workflow-formats.md) | `webbrain-config/1`, `webbrain-workflow/1` |
| [Adding a tool](docs/adding-a-tool.md) · [Localization](docs/localization.md) · [Test scenarios](docs/test-scenarios.md) | Contributor guides |

Also available in [中文](docs/zh-CN/) and [Français](docs/fr/).

## Repository layout

```
src/chrome/     Manifest V3 build — service worker, chrome.scripting, sidePanel
src/firefox/    Manifest V2 build — background page, executeScript, sidebar_action
docs/           Design and reference docs (en, zh-CN, fr)
lmstudio-plugin/  fetch_url + research_url as a standalone LM Studio plugin
web/            Landing site and docs site
test/           Node test suite, LLM scenario benchmarks, security corpora
```

Nearly all agent code is shared between the two builds. See
[architecture](docs/architecture.md#chrome-vs-firefox-key-differences) for where
they diverge.

## Known issues

**Firefox is meaningfully weaker than Chrome.** Firefox has no equivalent to the
Chrome DevTools Protocol via `chrome.debugger`, so the Firefox build has no
shadow-DOM piercing, no real trusted mouse events (some React/Vue handlers won't
fire), no closed-shadow-root traversal, no `resolveSelector` retry budget, no
SPA-navigation-aware retry, and no CDP screenshots (it falls back to
`tabs.captureVisibleTab`, active tabs only). Site adapters, vision detection,
loop detection, the auto-screenshot loop, and the Compact prompt/tool set *are*
mirrored to Firefox. Some single-page apps may also fail to trigger
content-script re-injection after client-side navigation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To add a tool, follow the checklist in
[adding a tool](docs/adding-a-tool.md). To add a provider, subclass
`BaseLLMProvider`, implement `chat()` (and optionally `chatStream()`), and
register it in `providers/manager.js` — mirroring both changes to
`src/chrome/` and `src/firefox/`. All providers normalize to
`{ content, toolCalls, usage }`; details in
[providers and models](docs/providers-and-models.md#adding-a-provider).

Recent changes are in [CHANGELOG.md](CHANGELOG.md).

## LM Studio plugin

`fetch_url` and `research_url` also ship as a standalone
[LM Studio](https://lmstudio.ai) plugin at
[`webbrain/web-tools`](https://lmstudio.ai/webbrain/web-tools), for web-fetching
tool-use inside LM Studio chats without the browser extension. Pure Node, no
headless browser.

```bash
lms clone webbrain/web-tools
```

Source: [`lmstudio-plugin/`](lmstudio-plugin/).

## Star History

<a href="https://www.star-history.com/?repos=webbrain-one%2Fwebbrain&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=webbrain-one/webbrain&type=date&theme=dark&legend=top-left&sealed_token=pEVOa2e14jxSLxQdCH2zPHJpjdCUYgWImET-_h_dgTuQYqEzR3f5pOzIyYGKN_gFHT-oZqKTM_yZfWHwwMtmM0Jb5YZvGgyuF6cF-w4vHVDdkJoUirCJjQ" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=webbrain-one/webbrain&type=date&legend=top-left&sealed_token=pEVOa2e14jxSLxQdCH2zPHJpjdCUYgWImET-_h_dgTuQYqEzR3f5pOzIyYGKN_gFHT-oZqKTM_yZfWHwwMtmM0Jb5YZvGgyuF6cF-w4vHVDdkJoUirCJjQ" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=webbrain-one/webbrain&type=date&legend=top-left&sealed_token=pEVOa2e14jxSLxQdCH2zPHJpjdCUYgWImET-_h_dgTuQYqEzR3f5pOzIyYGKN_gFHT-oZqKTM_yZfWHwwMtmM0Jb5YZvGgyuF6cF-w4vHVDdkJoUirCJjQ" />
 </picture>
</a>

## Contributors

<a href="https://github.com/webbrain-one/webbrain/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=webbrain-one/webbrain" />
</a>

## Citation

```bibtex
@software{webbrain2026,
  author = {Sokullu, Emre},
  title = {WebBrain: Open-source AI browser agent for chatting with pages},
  year = {2026},
  publisher = {GitHub},
  url = {https://github.com/webbrain-one/webbrain}
}
```

## License

MIT — built by [Emre Sokullu](https://emresokullu.com)
