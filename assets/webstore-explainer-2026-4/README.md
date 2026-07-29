# Web Store explainer visuals 2026 — v4 (typographic)

Same gallery and copy as v3 (`../webstore-explainer-2026-3`), retypeset. No product
icon and no "WebBrain" corner wordmark on any slide — the Web Store shows both beside
the listing. The hero keeps a small mono "WEBBRAIN" kicker as the only brand mark.

Type system:
- Display (headlines, prices, stat numerals) — **Instrument Serif** 400
- UI (body, subs, panel text) — **Instrument Sans** 400–700
- Labels (eyebrows, chips, URLs, buttons) — **Geist Mono** 600, uppercase, wide tracking

Fonts are vendored in `fonts/` and inlined as base64 at render time, so output no longer
depends on what is installed locally. All three are OFL 1.1; license texts sit beside them
in `fonts/OFL-*.txt` and must stay with the binaries. Latin subsets only, 68 KB total.

The mock agent panel on 02 still reads "WebBrain is acting" — that is depicted product UI,
not slide branding. Say so if you want it neutralised too.

v2/v3 are untouched and still use the old sans stack; the four versions are independent
copies, so a copy change needs applying in each.

Files (1280×800):
- 01-hero.png: Mono kicker + serif tagline hero
- 02-tell-the-browser.png: Flight-search command front and center as chat input, browser acting on it
- 03-ask-any-page.png: Ask mode, cropped to the answer panel
- 04-any-llm.png: Model picker, cropped to the provider dropdown
- 05-plan-before-act.png: Plan review with Approve/Adjust before actions run
- 06-launch-offer.png: WebBrain Cloud $5/mo (reg. $8), Save 35%
- 07-social-proof.png: 500+ GitHub stars, 20+ contributors, MIT — repo bar with contributor avatars

Light-background alternates of the two dark slides (originals kept, use whichever fits the gallery):
- 01-hero-light.png
- 05-plan-before-act-light.png

Both come from the same `hero(light)` / `planScene(light)` functions, so edits apply to
dark and light together. In the light plan card the panel goes white and the accent green
darkens for contrast against white button text.

Star/contributor counts are hardcoded in `proofScene()`; bump them there when they go stale (544 stars at last render, 2026-07-29). The avatar initials are decorative, not real contributor handles.

Slide 07 is appended after the offer to keep the existing filenames stable. If proof-then-price reads better, swap the last two entries in the `scenes` array and rename the two PNGs.

Regenerate:

```bash
node assets/webstore-explainer-2026-4/render.mjs
```
