# Vendored mp4box.js

- Package: `mp4box`
- Version: `2.4.1`
- Upstream: <https://github.com/gpac/mp4box.js>
- Files: `dist/mp4box.all.mjs`, `dist/styp-9TIZZDLN.mjs` and
  `dist/rolldown-runtime-w6R9maHv.mjs` from the published npm package,
  unmodified (the entry file imports the other two by these names)
- SHA-256:
  - `mp4box.all.mjs`: `34fa8fd681e8b63998ca9e4c3b477830dd11310c8aaedc37ecb8f49c5452d259`
  - `styp-9TIZZDLN.mjs`: `ae15acb79233251b72af7f7cc9f47e7f47cadb209206753b7000b502a2391049`
  - `rolldown-runtime-w6R9maHv.mjs`: `183552fe973134bce551888434b581d5a2cb695a82d8907e2cd9d2b61e12ce24`
- License: BSD-3-Clause (see `LICENSE`)

WebBrain uses `createFile` and `MP4BoxBuffer` only to parse generated MP4
clips: their sample tables, edit lists and codec configuration. The joined file
is written by `src/agent/video-join.js`. The dependency is bundled with the
extension; no executable code is fetched at runtime.
