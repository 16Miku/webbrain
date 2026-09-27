# Coupon merchant data

`coupon-domains.provenance.json` is the reviewed evidence manifest behind the
Chrome and Firefox `coupon-domains.js` snapshots. The extension never contacts
coupon directories at runtime.

## Sources

- **CouponFollow:** the fixed numeric and A-Z pages under
  `https://couponfollow.com/site/browse/{0,a-z}/all`.
- **CouponSwift:** the 50 initial merchant `websiteUrl` records server-rendered
  by `https://www.couponswift.com/stores`. The updater intentionally does not
  call the site's load-more action or fetch individual merchant pages.
- **Maintainer-vetted:** the regional storefronts in
  `scripts/update-coupon-domains.mjs`.

Each domain records per-source `firstSeen`, `lastSeen`, and `active` evidence.
Source metadata includes its URL, evidence tier, and current domain count.
Inactive evidence remains in the manifest for review history, but only domains
with at least one active source are emitted to the extension snapshots.

## Commands

Refresh from the bounded network sources:

```sh
npm run update:coupon-domains -- --as-of YYYY-MM-DD
```

Verify the manifest and both generated modules deterministically without any
network requests:

```sh
npm run update:coupon-domains -- --check
```

The updater rejects unexpected hosts, routes, content types, response sizes,
source counts, public/private suffixes, and snapshot churn. An intentional
large source migration requires the explicit `--allow-large-churn` flag and
should explain the resulting diff in its pull request.

`--bootstrap-from-snapshot` exists only for the initial provenance migration.
It refuses to run after the manifest exists.

The monthly `coupon-domain-refresh.yml` workflow runs the refresh and tests,
then opens or updates a draft pull request on
`automation/coupon-domain-refresh`. It never pushes generated data directly to
`main`.
