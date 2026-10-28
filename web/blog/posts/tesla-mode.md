---
title: >
  Introducing Tesla mode: WebBrain on vision alone
slug: tesla-mode
sortOrder: -430
date: 2026-10-28
readTime: 3 min read
description: >
  Vision mode is now Tesla mode. Like a Tesla that drives on cameras alone, WebBrain's Act runs see the page only as screenshots and act with the mouse and keyboard. Turn it off and WebBrain works more like Waymo, adding the page's accessibility tree.
excerpt: >
  Vision mode has a new name. With Tesla mode on, Act runs see the page only through screenshots, like a car that drives on cameras alone. Turn it off and WebBrain works more like Waymo, reading the page's structure too.
titleTag: >
  Introducing Tesla Mode - WebBrain Blog
ogTitle: >
  Introducing Tesla mode
ogDescription: >
  WebBrain's vision mode is now Tesla mode: screenshots in, mouse and keyboard out. Turn it off and it works more like Waymo, with the accessibility tree as an extra sensor.
twitterTitle: >
  Introducing Tesla mode in WebBrain
twitterDescription: >
  Vision only, like a Tesla on cameras. Turn it off for the Waymo approach: screenshots plus the page's accessibility tree.
keywords:
  - WebBrain
  - Tesla mode
  - vision mode
  - browser agent
  - computer use
  - screenshots
  - accessibility tree
  - vision language model
author: Emre Sokullu
authorUrl: https://emresokullu.com
lede: >
  **Vision mode has a new name: Tesla mode.** How it works doesn't change. The new name just explains what it does better than "vision" ever did.
---

## Two ways to drive

There are two well-known ways to build a self-driving car. Tesla bet on cameras: the car looks at the road the way a person does and works out everything else from the pictures. Waymo stacks sensors: lidar, radar and cameras, plus detailed maps, so the car never depends on one kind of input.

A browser agent has the same choice to make.

With **Tesla mode** on, an Act run sees the tab only as screenshots. There is no accessibility tree, no element reference and no CSS selector in the model's view. It clicks, types, scrolls and drags at screen coordinates, the way you would with a mouse and keyboard.

With Tesla mode **off**, WebBrain works more like Waymo. The agent reads the page's accessibility tree, targets elements by reference and selector, and uses screenshots as one more input when it needs them.

## Why vision only

- **It works where the page structure is missing or misleading.** Canvas editors, maps, charts, games and custom widgets often show up as an empty box in the accessibility tree. On screen they are perfectly clear.
- **It sees what you see.** If a cookie banner covers a button, the model sees the banner, not a button that looks clickable in the DOM.
- **Models are good at it now.** Current vision models point accurately enough to hit small buttons and links. WebBrain maps their answers back to the page for you, through retina displays, browser zoom, and models that answer in 0–1000 coordinates.
- **It stays cheap.** A run starts from one full screenshot. After each action WebBrain sends only the part of the screen that changed, a new full frame when most of it did, or a one-line "no visible change". The model can zoom into small text whenever it needs to.

## When Waymo wins

Vision alone is not always enough, and WebBrain already switches to the accessibility tree on its own for a few steps when only the page structure can do the job:

- uploading a file, because the native file chooser opens outside the page, where screenshots can't reach it;
- site workflows whose completion has to be proved against the page's own list of elements;
- reading a whole conversation, where WebBrain has to confirm it reached the last message;
- WhatsApp Web and Telegram, where WebBrain checks who a chat is with through the page structure.

Once that need has passed, the run goes back to vision on a fresh screenshot.

You may also want to turn Tesla mode off yourself: when you use a small local model that reads text much better than pixels, or when you want the most precise element targeting on a site with long forms. If your model doesn't take images at all, WebBrain falls back to the accessibility tree automatically.

## How to use it

Tesla mode is **Auto** by default, so every Act run whose model accepts images already uses it. To change that, open **Settings → Advanced → Tesla mode** and pick **Auto** or **Off**. **Vision screenshot size**, next to it, trades detail for tokens: Economy, Balanced or Sharp.

Your settings carry over: if you had turned Vision mode off, Tesla mode is off too. Ask and Dev runs are unchanged, because Tesla mode only applies to Act.

Pick the car that suits the road. We'd love to hear which one you drive with.

Tesla and Waymo are trademarks of their respective owners. WebBrain is not affiliated with either company; the names are only an analogy.

Tags: #WebBrain #TeslaMode #BrowserAgent #ComputerUse #VisionModels #AccessibilityTree
