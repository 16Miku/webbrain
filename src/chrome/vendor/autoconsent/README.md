# autoconsent (vendored)

DuckDuckGo's [autoconsent](https://github.com/duckduckgo/autoconsent) declines
cookie-consent banners. WebBrain uses it for the "Cookie banners" setting; see
`docs/cookie-banners.md`.

- Package: `@duckduckgo/autoconsent@16.61.0` (npm integrity `sha512-XRHCE4J9Q3tpF6TgbCilKDemBQsAWHBFR9S93UEwCnFA9jP54FTENz8nYez8/zyxh2O3O3r/K/gI8+DwtE4p6Q==`)
- Source: https://github.com/duckduckgo/autoconsent/tree/v16.61.0
- License: Mozilla Public License 2.0 (`LICENSE` here, and `LICENSES/MPL-2.0.txt` at the repository root)

The JavaScript bundles carry one reproducible WebBrain patch: remove the
redundant 'des cookies' / 'de cookies' acknowledgement-regex alternatives
that cause exponential backtracking. The optional articles already cover
those phrases. The patch is in 'scripts/update-autoconsent.mjs'; upstream
and patched hashes are recorded in 'vendor-manifest.json'.
These modified files remain MPL-2.0 and their complete source is published
here. Rules and license text are copied unmodified. WebBrain's own code lives outside this folder
(`src/content/autoconsent-bridge.js`, `src/agent/cookie-banner-host.js`, and
WebBrain's own rules in `src/agent/cookie-banner-rules.js`) and is under
WebBrain's license, GPL-3.0-or-later; MPL-2.0 allows that combination
(section 3.3).

To update, change the version in `scripts/update-autoconsent.mjs` and run
`node scripts/update-autoconsent.mjs`. `node scripts/update-autoconsent.mjs --check`
verifies these copies against the hashes below.

| File | SHA-256 |
|---|---|
| `autoconsent.playwright.js` | `c86e87c111ce52e627fa335a79a2190a48b45ebe3eb12831dd0e712c627046c1` |
| `autoconsent.esm.js` | `96c2c07d6e224e96076815abb218178cb5883c27bc0690ae5613ca9d3d223b15` |
| `compact-rules.json` | `bc3e27b8e5a529be4db748ac8940f1ade9c848aeb3dce6cdd4807b9e03390647` |
| `LICENSE` | `fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85` |
