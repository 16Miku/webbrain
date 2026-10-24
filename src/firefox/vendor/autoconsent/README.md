# autoconsent (vendored)

DuckDuckGo's [autoconsent](https://github.com/duckduckgo/autoconsent) declines
cookie-consent banners. WebBrain uses it for the "Cookie banners" setting; see
`docs/cookie-banners.md`.

- Package: `@duckduckgo/autoconsent@16.61.0` (npm integrity `sha512-XRHCE4J9Q3tpF6TgbCilKDemBQsAWHBFR9S93UEwCnFA9jP54FTENz8nYez8/zyxh2O3O3r/K/gI8+DwtE4p6Q==`)
- Source: https://github.com/duckduckgo/autoconsent/tree/v16.61.0
- License: Mozilla Public License 2.0 (`LICENSE` here, and `LICENSES/MPL-2.0.txt` at the repository root)

These files are copied from the npm package **unmodified**. Do not edit them:
under the MPL an edited copy stays MPL-licensed and its changes must be
published. WebBrain's own code that drives them lives outside this folder
(`src/content/autoconsent-bridge.js`, `src/agent/cookie-banner-host.js`, and
WebBrain's own rules in `src/agent/cookie-banner-rules.js`) and is under
WebBrain's license, GPL-3.0-or-later; MPL-2.0 allows that combination
(section 3.3).

To update, change the version in `scripts/update-autoconsent.mjs` and run
`node scripts/update-autoconsent.mjs`. `node scripts/update-autoconsent.mjs --check`
verifies these copies against the hashes below.

| File | SHA-256 |
|---|---|
| `autoconsent.playwright.js` | `acf22263a6e8d6e0485e162ac9c78974a148afb8051c4f67328dbb004f929484` |
| `autoconsent.esm.js` | `47bed6a4229c7011c4656d9c1378a32c1a01aae0d59e1f10c180dbec1ba5285b` |
| `compact-rules.json` | `bc3e27b8e5a529be4db748ac8940f1ade9c848aeb3dce6cdd4807b9e03390647` |
| `LICENSE` | `fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85` |
