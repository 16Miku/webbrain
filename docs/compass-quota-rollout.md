# Compass weekly allowance and sharing reward rollout

Implementation spans `webbrain2` and sibling `webbrain-cloud`. The constructor default and example configuration are now **$0.375 per UTC week**, resetting Monday at **00:00 UTC**. Production activation is a separate rollout step; no production deployment was performed during implementation or PR preparation.

## Release order

1. **Backend compatibility first.** Back up the entire usage JSON while the service is stopped or while holding its store lock. Keep `WEEKLY_FREE_USD=0.75` explicitly set in the active backend environment before releasing this backend. The new constructor default would otherwise reduce the allowance immediately. Keep that temporary override through the extension release. Ship the additive usage fields, `/usage` (`/v1/usage` alias), promotion endpoints, persistent ledger, review CLI, and telemetry first. Verify a free-quota 402 still includes the device-linked `subscribe_url`, and paid/payment-failure responses still point to the existing upgrade/account flows. Confirm the CLI and web workers resolve the same `USAGE_PATH`, and that all workers share the same filesystem lock.
2. **Extension next.** Ship both Chrome and Firefox together. Check the three quota choices, narrow panels, keyboard focus, claim submission/status, restored conversations, and a return from checkout. Confirm an approval or provider switch leaves browser actions stopped until the explicit Continue/Retry button is selected. Confirm pending claims say manual review, approved/redeemed devices have no offer to earn again, and existing payment recovery and Plus upgrades still work. Confirm the backend returns promotion state before enabling the new experience to users.
3. **Allowance reduction last.** After the new recovery choices are available in both stores, change the active `WEEKLY_FREE_USD` override to **0.375**. Check environment variables in the actual web-worker/service/container configuration as well as `.env`: exported variables take precedence over `.env`. Reload workers as required by the hosting setup. Query `/usage` from the running service with the extension's `X-WebBrain-Device-Id`; both `base_weekly_allowance_usd` and `weekly_limit_usd` must be `0.375`, and `next_reset_at` must be the next Monday 00:00 UTC. Verify an exhausted free device's 402 reports the same amount. Do not rely on the example file or a CLI process with a different environment.
4. **Observe for 14 full days after activation.** Record the UTC activation time, active amount, extension versions, and expected review staffing. Review the report daily and reassess the amount after two full UTC weeks. If recovery choices are unavailable or the allowance proves too small, restore the override to `0.75` while leaving the backend ledger and extension controls in place. A rollback must preserve lifetime awards and remaining balances.

Local configuration inspected on 2026-10-05: neither the process environment nor the local cloud `.env` sets `WEEKLY_FREE_USD`; the effective local value is `0.375`. The production environment was not accessed or changed.

The backend now uses a stable **`USAGE_PATH.lock`** and atomically replaces the usage JSON. For the first upgrade from the old in-place writer, stop and drain **all** old web workers and review/report CLI processes before starting the new version; do not mix the two lock protocols. Confirm the store owner can create the lock and temporary files and replace the JSON on the same filesystem. Never remove the lock file while any worker is running. Keep the `0.75` override throughout this backend migration and the extension release.

## Manual review

Run as the usage-store owner on the backend host:

```sh
php scripts/review-social-claims.php list
php scripts/review-social-claims.php approve CLAIM_ID --revision=1 --author=x:123456789 --verified
php scripts/review-social-claims.php reject CLAIM_ID --revision=1 --reason="Please include your generated WebBrain link in the public post."
```

Before using `--verified`, open the listed `post_url` and verify all of these:

- It is a public X, LinkedIn, or Bluesky post about WebBrain, viewable outside the author's private audience.
- It includes the **exact generated `share_url`** listed for that claim, including its random identifier. Follow a platform short link if needed to verify its destination.
- You have identified the author using a stable canonical identity: `x:NUMERIC_USER_ID`, `linkedin:STABLE_MEMBER_ID`, or `bluesky:did:plc:...` / `bluesky:did:web:...`. Use the actual stable account identifier every time; handles, vanity profile URLs, and display names are insufficient.

No positive sentiment, follower count, engagement, or multiple posts/platforms are required. The user publishes the post themselves. LinkedIn opens its link-sharing composer; the editable text can be copied into it. X and Bluesky composers receive the edited text.

The CLI refuses approval without verification attestation and the current revision. If a claim changed after listing, re-list it and review the new post. Post/profile duplicate checks, the lifetime device award, and the exact $0.50 grant happen in one exclusive usage-store transaction. Repeating a successful approval with the same identity and revision returns its existing result, including after all credit has been spent. A rejection contains a user-visible reason, releases the pending post reservation, and allows a corrected submission under the same opaque claim ID.

Supported links: X/Twitter status links (including mobile hostnames and photo/video suffixes); LinkedIn activity feed/update links and `posts/...-activity-ID-...` links; Bluesky `profile/HANDLE-OR-DID/post/RECORD` links. Query tracking and fragments are discarded. X is indexed by status ID, LinkedIn by activity ID, and Bluesky also gains its canonical DID/record index at approval. Reviewers must reject a syntactically valid URL whose actual public content fails the requirements.

## Accounting and compatibility

`socialPromotions` is a persistent top-level section of the existing usage JSON. It holds device claim IDs, claims/revisions, lifetime awards, post/profile indexes, pending-post reservations, balances, and counters. Weekly cleanup only removes `weeks`; it never removes the promotion ledger or awards. Maintain backups of the **whole file**, and keep it outside public web roots. A corrupt store fails closed for grants and consumption instead of resetting award history.

Readers and writers coordinate on the same stable lock file. A write is committed only by replacing the JSON after fully writing and syncing a temporary file; interruptions before replacement preserve the prior ledger, and interruptions after replacement are safe to retry. Temporary files left by a killed worker are never treated as the ledger. An existing empty store is corruption: restore a verified backup while workers are stopped instead of initializing fresh lifetime awards. Any rollback must retain the new locking protocol or stop and drain all workers before changing it.

Each weekly device entry keeps actual `usd` and a separate `promotionalSpentUsd`. The recurring allowance is consumed first. Only the newly metered excess debits the remaining reward, capped by the balance. Reward credit does not expire on Monday. Usage is never reduced to conceal promotional spending, and already incurred overshoot is not retroactively charged when a reward is later approved. Requests already admitted can finish above an allowance, as with the existing metered quota; concurrent completion cannot overdraft the promotion balance. Paid limits and upgrade behavior continue to use total metered cost.

Each request keeps the tier resolved at admission for model and visual usage recording, so a later billing outage or entitlement change cannot reclassify its promotional spending.

`/usage` and quota `usage` payloads add `base_weekly_allowance_usd`, `promotional_balance_usd`, `promotional_spent_usd`, `social_claim`, and `next_reset_at`. Existing weekly/daily aliases and billing URLs remain present. The UI formats fractional USD without turning `$0.375` into `$0.38` or `$0.37`. Public share links contain only random claim IDs, never the device GUID. Quota metadata crosses provider errors, the background event journal, terminal replay, and persisted quota-card datasets. Draft copy, selected platform, post URL, failed run mode, foreground behavior, and the Continue/Retry decision survive history restoration.

## Telemetry and the two-week decision

```sh
php scripts/report-social-promotion.php --days=14
```

The report contains quota-card views, checkout opens, server-recorded claim submissions and successful grants, explicit continuation after a reward, provider switches, and subscription conversions. A conversion is counted once when a device that opened checkout is observed with a paid entitlement on `/usage`; checkout opens alone do not count as conversions. Client counts are capped per device/day and are event totals rather than unique-person counts.

Metered consumption is recorded under the same store lock from actual completed token usage, including visual sidecars. Numeric samples use hashed device/session identifiers and retain 30 UTC days; no prompt, post body, or page content is added to these samples. The 14-day report shows free-session and free-device/week p50/p75/p90/p95 costs and the share exceeding $0.375. Calls without a session identifier contribute to `unattributed_usd`, so report that coverage gap. The first/last device-week buckets can be partial if the report starts midweek; use two complete UTC weeks for the final comparison. Lifetime claims/indexes are not subject to sample retention.

Reassess whether $0.375 covers useful completed sessions, how many device/weeks exhaust it, how often rewards lead to explicit continuation, how many users switch providers or subscribe, and how long pending reviews take. Use actual consumption distributions and recovery/conversion behavior to decide whether to keep or raise the allowance. Do not equate views or composer opens with published posts or successful tasks.

## Validation

See `compass-quota-validation.md` for executed checks, artifacts, and remaining environment-specific failures. Local browser fixtures simulate review and checkout return; no social posts, purchases, or production changes were made.
