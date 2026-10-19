---
title: >
  The biggest challenge of developing WebBrain
slug: biggest-challenge-of-developing-webbrain
sortOrder: -410
date: 2026-10-19
readTime: 2 min read
description: >
  Model diversity and ever-changing websites: why building a browser agent that works with every LLM, big or small, across multiple browsers is WebBrain's hardest problem.
excerpt: >
  We get asked about our hardest problem often. The answer is twofold: supporting every model — tiny ones included — and coping with websites that never stop changing.
titleTag: >
  The Biggest Challenge of Developing WebBrain - WebBrain Blog
ogTitle: >
  The biggest challenge of developing WebBrain
ogDescription: >
  Unlike Claude for Chrome, WebBrain has to work with every model — big, small, and tiny — across multiple browsers, on websites that keep evolving. That is the challenge.
twitterTitle: >
  The biggest challenge of developing WebBrain
twitterDescription: >
  Supporting all models, tiny ones included, across multiple browsers — on sites that change every few weeks — is our hardest problem.
keywords:
  - WebBrain
  - browser agent
  - model diversity
  - tiny models
  - LLM quirks
  - cross-browser
  - web automation
  - challenge
author: Emre Sokullu
authorUrl: https://emresokullu.com
lede: >
  **One question we get asked frequently: what is the biggest challenge of developing WebBrain?** The answer has two parts, and they compound each other.
---

The first part is model diversity. Unlike Claude for Chrome, which is tuned for one model and one browser, WebBrain has to make sure we work with all models — big and small, including tiny ones. That is the challenge on its own. Each LLM has its own quirks: some over-reason, some skip steps, some hallucinate CSS selectors that look plausible but do not exist. So we try to make it work with them all, in multiple browsers.

The second part is that websites evolve continuously. You cannot just write an exception rule for a site and expect it to hold for months. If you are lucky, it works for a few weeks before a redesign, a renamed class, or a new consent dialog breaks it. Any agent hard-coded for today's web is already aging.

That is the challenge: every model you add multiplies the quirks, and every week of uptime erodes the assumptions. It is a moving target on both axes.

But we love it. And we will continue.

Tags: #WebBrain #BrowserAgent #TinyModels #LLMQuirks #CrossBrowser #WebAutomation
