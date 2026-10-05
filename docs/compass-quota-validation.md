# Compass quota validation — 2026-10-05

Both repositories were clean before implementation. No applicable `AGENTS.md` was found in either repository or its ancestor directories. Implementation and validation were completed locally before preparing the PRs. No deployment, social publication, or purchase was performed.

## Passing checks

| Check | Result |
| --- | --- |
| Cloud `composer run test:promotions` | Passed accounting/concurrency, write durability, and real HTTP/CLI integration |
| Cloud weekly usage | Passed, including `$0.375` and legacy usage aliases |
| Cloud Plus, portal subscription recovery, renewal notices | Passed |
| Cloud PHP syntax | Passed for service, promotion trait, routes, and both new CLI scripts |
| Extension `npm run test:compass-quota` | 15 tests passed across Chrome and Firefox |
| Extension `npm run test:compass-quota:ui` | 392 assertions passed in Chromium and Firefox, all 23 supported locales |
| Extension billing/payment notice | Passed in both builds |
| Extension runtime lifecycle suite | 218 tests and 14 UI/content lifecycle checks passed |
| Extension provider limits | Passed |
| Extension cloud bridge approval/conversation isolation/run outcomes | 34 tests passed |
| Extension unpacked-build safety | 4 tests passed |
| Final focused legacy quota, recovery, and journal checks | 31 tests passed |
| Extension `npm run build:all` | Chrome and Firefox unpacked builds succeeded |
| `git diff --check` | Passed in both repos |

The cloud suite uses independent concurrent PHP processes against the same file lock. It covers repeated submissions, competing device/post/profile claims, approval retries mixed with consumption, no second grant across platforms, corrected rejection revisions, partial spending, weekly carryover, permanent ineligibility after award, redemption, corruption handling, paid usage, and real metered-session reporting. Reset checks cover Sunday 23:59:59 UTC, Monday 00:00 UTC, and a local Monday before the UTC boundary. The HTTP test launches an isolated local PHP server with external billing/model credentials disabled, exercises the public routes, and runs the actual reviewer CLI against that same usage store.

The extension tests use actual provider errors, agent chat/stream entry points, persisted/evicted run journals, reconnect responses, and structured card routing without a trailing Subscribe URL. The browser fixtures render the shipped quota controller and browser-specific styles, test all three choices, edited copy and composers, pending/rejected/corrected/approved/redeemed claims, restored card/form state, a simulated checkout return, provider selection, and explicit continuation. Keyboard tests exercise Tab through the choices and Enter into the claim form. All locales were checked for unresolved translation placeholders and horizontal overflow at **280 px**; awarded cards were also captured at **420 px**. English and Arabic screenshots were visually inspected.

Browser fixtures simulate extension APIs and review/checkout results. They do not sign in to social sites, complete a real checkout, or certify a store-published extension. Production smoke tests are listed in the rollout checklist.

## Review fixes

All three review findings were addressed. Store writes now sync a temporary file on the same filesystem and atomically replace the JSON under a stable `USAGE_PATH.lock`; existing empty, whitespace-only, or invalid stores fail closed. Regression tests inject partial writes, sync/replace failures, and kill actual writer processes immediately before and after replacement. They verify restart behavior, preserved lifetime awards/indexes, and exactly one grant when a committed approval is retried.

Metered usage now requires the billing tier resolved at admission, including streamed usage and visual sidecars. The paid-admission regression drops the billing table mid-request and verifies neither model nor visual usage debits promotional credit. UI submissions invalidate older refresh results/errors, including across a locale remount. Browser regressions verify pending state survives delayed draft responses, stale network errors, and a remount during submission; a failed submission after remount re-enables the form. Refreshes also retain keyboard focus and deliberately empty edited copy.

After these fixes, the promotion suites, PHP syntax, weekly usage, Plus, portal recovery, renewal notices, stats endpoint, 15 extension quota tests, 392 rendered UI assertions, billing notice checks, and both extension builds were rerun and passed. `git diff --check` passed in both repos. The standard tool-request-shape check still fails at its existing local-model assertion before reaching the changed accounting calls; the complete check passes when its service instances use an isolated root without the local `.env` (the actual `.env` was untouched). The earlier full-suite failures below remain recorded; the aggregate suites were not rerun after these focused fixes.

## Existing failures

- **Extension `npm test`:** the final run reached the legacy `test/run.js` suite: **2,425 passed, 1 failed** out of 2,426. The failing test is `extended provider catalog is complete, mirrored, safe, and excluded-provider clean`; its expected catalog omits existing `freebuff2api`. The unchanged HEAD test reproduces that failure. Earlier chained suites passed; checks chained after this failing legacy suite were not executed by `npm test`. Two source-extraction assertions affected by the expanded quota renderer were updated and now pass.
- **Cloud `composer check`:** the native Windows checkout gives `tests/apache-health-guard.sh` CRLF line endings, and Bash rejects its `set -u` / function syntax. The aggregate check stops there with exit 2. This shell script was not changed.
- **Cloud PHP checks run separately:** `tool-request-shape.php` fails its default-upstream-model assertion because the existing local `.env` sets `UPSTREAM_MODEL_ID=stepfun/step-3.7-flash`, while the test expects the constructor's GPT-5.6 Luna Pro default. The unchanged HEAD service/test reproduces this failure.
- **Cloud PHP checks run separately:** `pii-scrubber-cli.php` fails its overlapping-run assertion. The unchanged HEAD service, CLI, and test reproduce the same failure on this host. The cause was not changed or resolved by this implementation.

All other PHP checks in the Composer check list passed when run individually. Test cases that intentionally exercise missing billing configuration, invalid test credentials, or corrupt improvement payloads emit expected diagnostic lines while passing.

## Local artifacts and rollout

Browser screenshots are generated in `%TEMP%/webbrain-compass-review` (override with `QUOTA_UI_OUTPUT`). The complete aggregate extension logs are `%TEMP%/webbrain-compass-npm-test-final.log`; the cloud aggregate log is `%TEMP%/webbrain-cloud-compass-check.log`. Unpacked artifacts are `build/chrome` and `build/firefox`.

Local cloud configuration has no `WEEKLY_FREE_USD` process or `.env` override, so the inspected effective value is `0.375`. Production was not inspected or activated. Follow [the rollout checklist](compass-quota-rollout.md): backend compatibility pinned at `0.75`, both extensions, then live-worker override verification and activation at `0.375`. Reassess the actual consumption report after two complete UTC weeks.
