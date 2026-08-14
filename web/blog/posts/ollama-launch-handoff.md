---
title: >
  WebBrain now has an Ollama launch handoff
slug: ollama-launch-handoff
sortOrder: -10
date: 2026-07-02
readTime: 4 min read
description: >
  A new Ollama launch handoff can configure WebBrain for a local Ollama model from one terminal command. The integration is not upstream in Ollama yet, but it is available today from the esokullu/ollama branch while we work toward official integration.
excerpt: >
  WebBrain can now be configured from an Ollama launch command: choose a local model, open the WebBrain handoff page, confirm the browser prompt, and the extension switches to Ollama automatically. It is not in upstream Ollama yet, but you can try it from the branch today.
titleTag: >
  WebBrain Ollama launch handoff announcement - WebBrain Blog
ogTitle: >
  WebBrain now has an Ollama launch handoff
ogDescription: >
  Try the new WebBrain handoff from an Ollama fork branch while we work toward upstream Ollama integration.
twitterTitle: >
  WebBrain now has an Ollama launch handoff
twitterDescription: >
  One command can hand a local Ollama model to WebBrain and make it active in the browser extension.
keywords:
  - WebBrain
  - Ollama
  - local LLM
  - browser agent
  - open source
  - Chrome extension
  - Firefox extension
  - Ollama launch
html: true
lede: >
  We have a first working WebBrain handoff for **Ollama launch**. From a local Ollama build, you can run one command, pick a model, approve a WebBrain browser prompt, and WebBrain will switch its local provider to that Ollama model. This is not integrated into upstream Ollama yet. For now, you can install it from the [codex/ollama-webbrain-launch-handoff branch of esokullu/ollama](https://github.com/esokullu/ollama/tree/codex/ollama-webbrain-launch-handoff). We hope Ollama will integrate it upstream.
---

<figure>
  <img src="/assets/webbrain-ollama-heart.png" alt="WebBrain logo, a heart, and the Ollama logo for the launch handoff announcement">
  <figcaption>WebBrain can now receive local Ollama setup details from an Ollama launch command.</figcaption>
</figure>

## What the handoff does

WebBrain already supports Ollama as a local OpenAI-compatible provider. The new handoff removes the settings-page friction around that setup.

Instead of opening WebBrain settings, typing a local base URL, picking a model, and checking the context window by hand, Ollama can open a WebBrain launch URL with the right values already attached:

- the selected Ollama model
- the local OpenAI-compatible base URL, such as `http://127.0.0.1:11434/v1`
- the detected context window
- a source marker so WebBrain knows this came from Ollama

WebBrain then asks for one browser confirmation before updating the local Ollama provider and making it active.

## Try it from the branch

The integration is not part of official upstream Ollama builds at the time of this post. To try it now, build from the branch:

```bash
git clone https://github.com/esokullu/ollama.git
cd ollama
git switch codex/ollama-webbrain-launch-handoff
cmake -S . -B build -G Ninja -DOLLAMA_MLX_BACKENDS=
cmake --build build --parallel 8
```

Start Ollama with browser-extension origins allowed. This is needed because WebBrain runs from a `chrome-extension://` or `moz-extension://` origin, and Ollama protects its local HTTP API with an origin allowlist:

```bash
OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ./ollama serve
```

Then, in another terminal:

```bash
./ollama launch webbrain --model qwen3.5:9b
```

You should see output like this:

```text
Opening WebBrain Ollama setup:
  https://webbrain.one/launch/ollama?baseUrl=http%3A%2F%2F127.0.0.1%3A11434%2Fv1&contextWindow=262144&model=qwen3.5%3A9b&source=ollama

Confirm the WebBrain prompt in your browser to use qwen3.5:9b via Ollama.
```

## What it looks like

The launch URL opens WebBrain and asks whether to configure the extension for the selected Ollama model.

<figure>
  <img src="/assets/ollama-webbrain-confirm.png" alt="WebBrain confirmation dialog for configuring the qwen3.5:9b Ollama model">
  <figcaption>WebBrain receives the model, provider URL, and context window from the Ollama launch handoff.</figcaption>
</figure>

After confirmation, WebBrain shows a success message on the page.

<figure>
  <img src="/assets/ollama-webbrain-configured.png" alt="WebBrain configured success message after accepting the Ollama handoff">
  <figcaption>The extension confirms that the Ollama model is configured and ready.</figcaption>
</figure>

Open the WebBrain panel and the active provider is now `Ollama (Local)`.

<figure>
  <img src="/assets/ollama-webbrain-panel-thinking.png" alt="WebBrain side panel using the Ollama local provider while responding">
  <figcaption>WebBrain uses the local Ollama provider from the side panel.</figcaption>
</figure>

And then the model responds from your local Ollama server.

<figure>
  <img src="/assets/ollama-webbrain-response.png" alt="WebBrain side panel showing a response from the local qwen3.5:9b Ollama model">
  <figcaption>A local Ollama model answers inside WebBrain after the handoff.</figcaption>
</figure>

## Why this matters

Local browser agents should feel local all the way down. If you already have Ollama models installed, WebBrain should not make you copy provider URLs or manually match model names. The handoff makes Ollama the place where you choose the model and WebBrain the place where you use it in the browser.

This is also a better open-source loop: Ollama serves the model, WebBrain controls the browser, and the user keeps both pieces inspectable and self-hostable.

The current implementation lives on the [codex/ollama-webbrain-launch-handoff branch](https://github.com/esokullu/ollama/tree/codex/ollama-webbrain-launch-handoff). We hope it can make its way into Ollama proper so WebBrain setup becomes a normal `ollama launch webbrain --model ...` path for everyone.
