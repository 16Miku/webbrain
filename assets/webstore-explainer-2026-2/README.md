# Web Store explainer visuals 2026 — v2 (narrative arc)

Gallery restructured per feedback: hero → flow slides cropped to relevant UI → launch offer. Dense text removed.

Files (1280×800):
- 01-hero.png: Logo + tagline hero
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
node assets/webstore-explainer-2026-2/render.mjs
```
