# Compass quota validation — 2026-10-05

Both repositories were clean before implementation. No applicable `AGENTS.md` was found in either repository or its ancestor directories. Implementation and validation were completed locally before preparing the PRs. No deployment, social publication, or purchase was performed.

## Passing checks

| Check | Result |
| --- | --- |
| Cloud `composer run test:promotions` | Passed accounting/concurrency, write durability, and real HTTP/CLI integration |
| Cloud weekly usage | Passed, including `$0.375` and legacy usage aliases |
| Cloud Plus, portal subscription recovery, renewal notices | Passed |
| Cloud PHP syntax | Passed for service, promotion trait, routes, and both new CLI scripts |
| Extension `npm run test:compass-quota` | 19 tests passed across Chrome and Firefox |
| Extension `npm run test:compass-quota:ui` | 406 assertions passed in Chromium and Firefox, all 23 supported locales |
| Extension billing/payment notice | Passed in both builds |
| Extension runtime lifecycle suite | 218 tests and 14 UI/content lifecycle checks passed |
| Extension provider limits | Passed |
| Extension cloud bridge approval/conversation isolation/run outcomes | 34 tests passed |
| Extension unpacked-build safety | 4 tests passed |
| Final focused legacy quota, recovery, and journal checks | 31 tests passed |
| Extension `npm run build:all` | Chrome and Firefox unpacked builds succeeded |
| `git diff --check` | Passed in both repos |

The cloud suite uses independent concurrent PHP processes against the same file lock. It covers repeated submissions, competing device/post/profile claims, approval retries mixed with consumption, no second grant across platforms, corrected rejection revisions, partial spending, weekly carryover, permanent ineligibility after award, redemption, corruption handling, paid usage, and real metered-session reporting. Reset checks cover Sunday 23:59:59 UTC, Monday 00:00 UTC, and a local Monday before the UTC boundary. The HTTP test launches an isolated local PHP server with external billing/model credentials disabled, exercises the public routes and configured promotion body-size limit, and runs the actual reviewer CLI against that same usage store.

The extension tests use actual provider errors, agent chat/stream entry points, persisted/evicted run journals, reconnect responses, and structured card routing without a trailing Subscribe URL. The browser fixtures render the shipped quota controller and browser-specific styles, test all three choices, edited copy and composers, pending/rejected/corrected/approved/redeemed claims, restored card/form state, a simulated checkout return, provider selection, and explicit continuation. Keyboard tests exercise Tab through the choices and Enter into the claim form. All locales were checked for unresolved translation placeholders and horizontal overflow at **280 px**; awarded cards were also captured at **420 px**. English and Arabic screenshots were visually inspected.

Browser fixtures simulate extension APIs and review/checkout results. They do not sign in to social sites, complete a real checkout, or certify a store-published extension. Production smoke tests are listed in the rollout checklist.

## Review fixes

The initial three review findings were addressed. Store writes now sync a temporary file on the same filesystem and atomically replace the JSON under a stable `USAGE_PATH.lock`; existing empty, whitespace-only, or invalid stores fail closed. Regression tests inject partial writes, sync/replace failures, and kill actual writer processes immediately before and after replacement. They verify restart behavior, preserved lifetime awards/indexes, and exactly one grant when a committed approval is retried.

Metered usage now requires the billing tier resolved at admission, including streamed usage and visual sidecars. The paid-admission regression drops the billing table mid-request and verifies neither model nor visual usage debits promotional credit. UI submissions invalidate older refresh results/errors, including across a locale remount. Browser regressions verify pending state survives delayed draft responses, stale network errors, and a remount during submission; a failed submission after remount re-enables the form. Refreshes also retain keyboard focus and deliberately empty edited copy.

## PR review and complete validation

Ordinary quota reads now use a shared read lock without creating lifetime claims or rewriting the store; metering and expiring client telemetry also avoid allocating claims. Sharing explicitly creates the opaque identifier. Regressions rotate device headers across 50 direct usage reads and 20 real HTTP usage/malformed-chat requests and verify unchanged store bytes. Paid and Plus no-op reads, repeated conversion observations, and expired checkout activity are checked using store bytes and modification times. Both promotion POST handlers use the existing bounded JSON parser; oversized bodies with and without Content-Length are rejected before claim allocation. No-op exclusive transactions do not replace the ledger.

Both browsers emit one recovery signal on response-only quota failure. Quota updates also mark terminal journals, reconnect results, user-memory outcomes, badges, and Ask review prompts as unsuccessful; the conversation and single quota card remain available for explicit retry. Provider switching checks connection results, exceptions, and stale tests before reporting readiness. The rendered fixture server selects locales from a fixed allowlist, with malicious locale query regressions. The PDF browser test captures its Chrome tab ID at creation instead of rediscovering it by URL. GitHub CodeQL confirmed the fixture injection alert was fixed, and PDF/WebMCP CI passed after the first review fixes.

The full **npm test** passed, including **2,429 legacy tests** and **60 security checks**. Focused quota tests passed 19 cases, and the browser fixture passed 406 assertions across both engines and 23 locales. Both extension builds, payment notices, and real Chrome PDF/WebMCP tests passed; English and Arabic narrow-panel screenshots were inspected again.

The full cloud **composer check** and the real HTTP/review-CLI suite passed after the latest cloud fixes. Earlier validation blockers were resolved: shell fixtures use LF line endings, the default-model test uses an isolated root without a developer .env, the PII CLI recognizes absolute Windows lock paths, and stale provider/structured-error source assertions match the current behavior. The actual .env was untouched. Expected fault-case diagnostics remain in passing test logs.

Further review regressions verify that the pending claim button fetches status in both browsers, concurrent rotating device headers cannot exceed the global telemetry cap, dropped events do not rewrite the ledger, and exact checkout timestamps outside 30 days cannot convert. Linux PHP durability tests verify file-then-directory sync and safe approval retry after an injected directory-sync failure. The Linux social test could not run because that PHP installation lacks PDO SQLite; the complete cloud check and social/concurrency suite passed with Windows PHP. Windows PHP cannot sync directory handles, so production power-loss durability requires a POSIX filesystem with directory fsync.

Concurrent rotating session and device identifiers are bounded to 10,000 retained observations per consumption map. Overflow contributes to exact metered aggregates and disclosed report totals, while existing samples keep accumulating and expiration frees capacity. Regression tests cover concurrent capacity, exact overflow totals, unchanged weekly accounting, and retention. The extension branch includes current main and its upstream social-platform changes; the complete suite passes after integration.

Fresh Codex reviews and GitHub checks are recorded on each PR.

## Local artifacts and rollout

Browser screenshots are generated in `%TEMP%/webbrain-compass-review` (override with `QUOTA_UI_OUTPUT`). The latest complete extension log is `%TEMP%/webbrain-compass-review-npm-test.log`; the cloud aggregate log is `%TEMP%/webbrain-cloud-compass-review-check.log`. Unpacked artifacts are `build/chrome` and `build/firefox`.

Local cloud configuration has no `WEEKLY_FREE_USD` process or `.env` override, so the inspected effective value is `0.375`. Production was not inspected or activated. Follow [the rollout checklist](compass-quota-rollout.md): backend compatibility pinned at `0.75`, both extensions, then live-worker override verification and activation at `0.375`. Reassess the actual consumption report after two complete UTC weeks.
