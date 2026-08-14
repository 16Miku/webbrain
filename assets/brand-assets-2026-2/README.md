# WebBrain brand assets 2026 — v2

A non-destructive, typography-led refresh of the existing social card, store promos,
and banner set. The original top-level files remain unchanged.

Type system:

- Display headlines — **Instrument Serif** 400
- Brand and supporting copy — **Instrument Sans** 400–700
- Metadata, feature labels, and URLs — **Geist Mono** 500–600

All fonts are vendored and inlined at render time, so output is independent of locally
installed fonts. The OFL 1.1 license texts live beside the font files.

Every PNG is rendered at 2× its target dimensions and then downsampled with the browser
canvas's high-quality image smoothing. This keeps the required output dimensions while
giving small wordmarks and supporting text cleaner antialiasing.

Files:

- `webbrain-social-card.png` — 1280×640
- `webbrain-social-card-300x188.png` — 300×188 thumbnail derivative, retypeset rather than downscaled
- `store-promo-1400x560.png` — 1400×560 store marquee
- `store-promo-440x280.png` — 440×280 small store tile
- `banners/webbrain-banner-en.png` — 2560×800 English horizontal banner
- `banners/webbrain-banner-tr.png` — 2560×800 Turkish horizontal banner
- `banners/webbrain-banner-vertical-en.png` — 1280×2560 English vertical banner
- `website/og-image.png` — 1200×630 website social card; mirrored byte-for-byte to
  `web/og-image.png` and `web/twitter-image.png`

The typography direction was first checked with one AI style-transfer concept, then
implemented as deterministic HTML/CSS so the shipped assets preserve exact copy,
dimensions, logo artwork, and language-specific characters.

Regenerate from the repository root:

```bash
node assets/brand-assets-2026-2/render.mjs
```

The render command also refreshes the two website social-image files so metadata previews
cannot drift away from this source set.
