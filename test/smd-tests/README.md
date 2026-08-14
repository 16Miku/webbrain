# SocialMediaDownloader regression suite

On-demand Playwright suite that checks whether `social-media-downloader.js` still works on Facebook, Instagram, X, LinkedIn, Reddit, and Pinterest. Run it whenever you suspect a site changed; the report tells you exactly which assertion broke so you (or Claude in a follow-up session) can update the matching site profile.

## Setup

From this folder (`smd-tests`):

    pip install -r requirements.txt
    python -m playwright install chromium

That's it. Make sure `social-media-downloader.js` sits next to `test_smd.py` (or in the parent folder).

## Running

    python test_smd.py                    # all sites
    python test_smd.py --site reddit      # one site
    python test_smd.py --js PATH          # explicit script path
    python test_smd.py --update-baseline  # save current counts as baseline

Reports land in `%USERPROFILE%\smd-test-reports\` on Windows or `~/smd-test-reports/` on Mac/Linux:

- `smd_report_YYYY-MM-DD_HHMMSS.md` — each run, timestamped
- `latest.md` — mirror of the most recent run
- `screenshots/` — captured only for failed tests

Exit code is non-zero if any test fails.

## How it reuses your logged-in sessions

The runner picks the best available attach strategy automatically:

**1. CDP attach (best)** — if you launched Chrome with the debug port enabled, the suite drives your actual Chrome window. Your existing tabs are not touched; tests open a new tab and close it at the end. To enable:

    start-chrome-debug.bat       # Windows  (close all Chrome first)
    ./start-chrome-debug.sh      # macOS / Linux

**2. Cookie injection (default if Chrome wasn't launched with the debug port)** — the runner uses `browser_cookie3` to read cookies from your default Chrome profile (yes, while Chrome is open — Chrome's SQLite uses WAL mode and allows concurrent reads). Those cookies are injected into a fresh bundled Chromium so it behaves as you, logged into every site. You don't need to close Chrome, you don't need a separate profile, you don't need `--setup`.

**3. Dedicated test profile (last resort)** — used only if `browser_cookie3` isn't installed and CDP isn't reachable. Run `python test_smd.py --setup` to log into sites in `~/smd-test-profile` once.

If the runner falls back to (3) when you expected (2), it'll be because Chrome stored its cookies somewhere browser_cookie3 doesn't look (rare — non-default profile, portable Chrome, Chromium variants). On Windows, `browser_cookie3` decrypts DPAPI-encrypted cookies as your user account, so it Just Works.

## What each test asserts

| Site | Without login | With login |
|---|---|---|
| Pinterest | profile=pinterest, ≥10 pinimg URLs, ≥1 upgraded to /originals/ | (same) |
| Reddit | profile=reddit, ≥3 redd.it URLs | (same) |
| Instagram | profile=instagram | + focused cdninstagram/fbcdn URL (auto mode is intentionally single-item) |
| X/Twitter | profile=twitter | + ≥1 twimg URL with name=orig |
| Facebook | profile=facebook | + click into single photo, main-mode returns 1–5 URLs (no avatar leak) |
| LinkedIn | profile=linkedin | + ≥1 licdn URL after avatar exclusion |

### v4 advanced tests (`sites_advanced.py`)

These exercise the new HLS/MSE/YouTube paths against synthetic fixtures
(`page.route` mocks every fetch), so they pass regardless of whether
you're logged in or which sites the wider network is blocking.

| Test | Asserts |
|---|---|
| `hls_aes128_decryption` | Encrypted single-segment HLS playlist with `METHOD=AES-128` decrypts back to the original plaintext via WebCrypto AES-CBC. |
| `mse_recorder` | `armMseRecorder()` patches `SourceBuffer.prototype.appendBuffer` such that bytes fed by a real `MediaSource` are captured into the in-page buffer log, even when the MP4 parser later rejects them. Also checks the `MediaSource` URL is tagged via `URL.createObjectURL`. |
| `mse_autoarm_on_social_host` | When SMD loads on a `*.facebook.com` (or other auto-arm host), the recorder arms and the prototype patches are flagged WITHOUT a manual `armMseRecorder()` call. This is what makes the document_start content_script registration work end-to-end. |
| `mse_noautoarm_off_social_host` | The inverse: on a non-social host the recorder does NOT auto-arm. Catches regressions where the host regex accidentally widens. |
| `youtube_progressive_parser` | Parses a fake watch page's `ytInitialPlayerResponse`; surfaces `formats[].url` and direct `adaptiveFormats[].url` entries but skips `signatureCipher` ones (base.js decoding is out of scope). |
| `recommendation_builder` | Drives `_buildRecommendation` with synthetic inputs for each of the 5 fail-mode `kind`s (`youtube_video`, `mse_capture_available`, `mse_capture_empty`, `unsupported_site`, `empty_result`) and 2 healthy cases that should return null. Spot-checks the messages mention the right external tool (`yt-dlp` / `gallery-dl` / `saveMse()`). |

## Baseline tracking

After your first clean run:

    python test_smd.py --update-baseline

Future reports show `baseline → current (delta%)` for each site. A drop of >50% triggers a `WARNING` marker — usually a CDN host changed or a selector went stale.

## When a test fails

The report includes:

- which assertion failed
- which selectors were in play
- a screenshot of the page state
- where to look in `SITE_PROFILES` near the top of `social-media-downloader.js`

Paste the failing section back into a new Cowork chat with the script attached if you'd like Claude to fix it.

## Caveats

- **Reddit.** Works here even though Claude in Chrome blocks reddit.com — Playwright doesn't go through that extension.
- **Bot detection.** Cookie-injection mode looks more like a clean browser than your real Chrome, so X/Facebook occasionally throw a Cloudflare challenge. If you hit one, use the CDP path (`start-chrome-debug.bat`) instead.
- **Non-default Chrome profile.** `browser_cookie3` reads from Chrome's default profile location. If your `esokullu@gmail.com` session is in a different Chrome profile, results in mode (2) may be partial. Use mode (1) for full fidelity.
- **Network flakiness.** Each test has a 30s navigation timeout. Re-run a single site with `--site <name>` if you hit a transient hiccup.

## Privacy / git hygiene

Your cookies, screenshots, reports, and any test profile live OUTSIDE the repo by default (in `~/`). A suggested `.gitignore` is in the parent README. The baseline file (`baseline.json`) contains only URL counts — safe to commit.
