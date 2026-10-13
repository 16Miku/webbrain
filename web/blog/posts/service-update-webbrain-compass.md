---
title: >
  Service update: WebBrain Compass restored after upstream Novita hiccups
slug: service-update-webbrain-compass
sortOrder: -350
date: 2026-10-14
readTime: 2 min read
description: >
  A brief status update regarding temporary WebBrain Compass disruptions caused by an infrastructure issue at Novita, now resolved.
excerpt: >
  Intermittent errors affecting WebBrain Compass have been resolved following an upstream infrastructure issue with Novita. Service is back to normal.
titleTag: >
  Service Update: WebBrain Compass Restored - WebBrain Blog
ogTitle: >
  Service update: WebBrain Compass restored
ogDescription: >
  WebBrain Compass is fully operational again after temporary hiccups with our infrastructure provider, Novita.
twitterTitle: >
  Service update: WebBrain Compass restored
twitterDescription: >
  Temporary WebBrain Compass connection issues due to upstream Novita errors have been resolved.
keywords:
  - WebBrain Compass
  - service update
  - Novita
  - system status
author: Emre Sokullu
authorUrl: https://emresokullu.com
lede: >
  If you ran into connection errors or timeouts with WebBrain Compass over the last couple of days, you were not alone. An upstream issue with Novita, our infrastructure provider for hosted inference, caused intermittent hiccups for Compass traffic. The underlying problem has been identified and cleared, and Compass is back to steady, normal operation.
---

## What happened

WebBrain Compass is our hosted routing service, designed to let users test and run WebBrain out of the box without needing local GPU hardware or their own API keys. The inference backing this service is hosted on Novita's infrastructure.

Earlier this week, Novita experienced an upstream platform error that led to sporadic connection drops, degraded response times, and failed inferences for requests routed through Compass. While not a total blackout, it meant several sessions failed mid-turn or could not connect to the remote worker.

## Current status

Novita resolved the incident, and our telemetry confirms that request success rates, error counts, and response latencies have returned to baseline. All WebBrain Compass endpoints are healthy.

If you bring your own API key (via OpenRouter, Anthropic, OpenAI, etc.) or run WebBrain entirely with a local model through Ollama, LM Studio, or vLLM, your setup runs locally or connects directly to your chosen provider, so you were never impacted by this incident.

Thanks for your patience while this got sorted out. If you notice any lingering issues, please let us know on [GitHub](https://github.com/webbrain-one/webbrain/issues) or reach out in Discord.

Tags: #WebBrain #Compass #Novita #ServiceUpdate #Status
