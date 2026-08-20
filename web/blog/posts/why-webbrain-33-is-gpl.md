---
title: >
  Why WebBrain 33.0.0 is GPL
slug: why-webbrain-33-is-gpl
sortOrder: -210
date: 2026-08-20
readTime: 2 min read
description: >
  WebBrain 33.0.0 ships under GPL-3.0-or-later because the extension bundles the Xapian/libzim WebAssembly runtime for full-text Wikipedia ZIM search. Releases before 33.0.0 remain MIT.
excerpt: >
  33.0.0 is GPL because full-text Wikipedia search in the extension needs a GPL runtime in the package. Earlier tags stay MIT.
titleTag: >
  Why WebBrain 33.0.0 is GPL - WebBrain Blog
ogTitle: >
  Why WebBrain 33.0.0 is GPL
ogDescription: >
  We relicensed 33.0.0 to GPL-3.0-or-later after bundling the Xapian/libzim Wasm runtime for offline Wikipedia search. Older releases stay MIT.
twitterTitle: >
  Why WebBrain 33.0.0 is GPL
twitterDescription: >
  Full-text Wikipedia ZIM search needs a GPL runtime in the Chrome and Firefox packages. That is why 33.0.0 is GPL.
keywords:
  - WebBrain
  - GPL
  - GPL-3.0
  - open source license
  - Xapian
  - libzim
  - Wikipedia offline
  - Apocalypse Mode
author: Emre Sokullu
authorUrl: https://emresokullu.com
lede: >
  **WebBrain 33.0.0 is GPL-3.0-or-later.** Tagged releases before that stay MIT.
---

Apocalypse Mode's Wikipedia reader needed real full-text search over ZIM archives, not just title lookup. The working way to query the Xapian index inside those files, in a browser, is [libzim](https://github.com/openzim/libzim) compiled to WebAssembly. That runtime is GPL. Once it is bundled and wired into the Chrome and Firefox packages, the combined work has to ship under compatible GPL terms. A settings toggle that hides Apocalypse Mode does not change the license of what was distributed.

GPL-3.0-or-later is the version because javascript-libzim is GPL-3.0-or-later while libzim and Xapian are GPL-2.0-or-later, and "or later" lets both move up. GPL-3.0 also stays compatible with Apache-2.0 libraries we already ship.

The MCP server and LM Studio plugin remain MIT. Third-party files keep their own notices. Each 33.x release publishes corresponding source for the bundled Wasm. The longer record is in the [licensing decision](https://github.com/webbrain-one/webbrain/blob/main/docs/offline-rag-licensing.md).
