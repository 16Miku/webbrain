# Repeated navigation without page progress

The navigation loop guard distinguishes a new browser document from useful
page progress. A verified link can reload the same page with fresh accessibility
references and a new one-use acceptance key. Repeating read, scroll and click
must not consume the entire agent budget in that state.

The guard compares bounded root accessibility observations after a verified
link navigation. It requires the actual control label and href, an independently
reported URL-only effect, and the same page content and semantic route. A second
unchanged return asks the agent to inspect the blocker; a fourth stops retries
and requests an honest handoff. Re-reading or successfully scrolling between
attempts does not establish navigation progress.

Only this retry identity collapses explicit nonce parameters with long hex
values. Navigation, permissions, recipient binding, query and hash freshness
continue using the full URL. Different search/page/hash views, changed content,
successful field writes and new native chat deltas remain progress. Partial,
subtree and conversation accessibility reads cannot assert an unchanged whole
page. Fresh documents still discard stale targets and failure counters; a new
run discards semantic retry history too.

`test/semantic-page-retry.mjs` replays a sanitized real thirty-tool signup rules
loop in both production browser agents and standalone detectors. It verifies
bounded recovery and the progress boundaries above. Public rules text, synthetic
URLs, synthetic references and synthetic opaque values are used; no account or
personal data is present. This corrects the product's retry behavior and does
not establish that an external site's acceptance endpoint can advance.
