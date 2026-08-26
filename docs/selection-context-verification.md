# Selection-context verification record

This record is the release checklist for the selected-text context contract. The
same Node suite exercises the mirrored Chrome and Firefox agent, UI, background,
locale, persistence, and trace contract paths; it is intentionally separate from
the visible transcript, which is not a provider request. These are source-level
contract/integration checks, not a browser-automation run.

## Automated checks

Run from the repository root:

```sh
node test/run.js
```

The selection-context checks must cover:

- selection A → answer → selection B → “上述/这三者” follow-up;
- visible transcript versus the filtered provider payload;
- wrapped page/tool/attachment exclusion and prompt-injection regression;
- service-worker hydration, quota retry, tab isolation, retry, scoped
  compaction, explicit restore, and New conversation cleanup;
- Chrome/Firefox mirrored runtime trace metadata with no private scope text.

## Verification record (2026-08-26)

The shared Node suite run for this PR recorded **2055 passed, 2 failed** while
exercising both mirrored browser paths. The two failures are pre-existing
repository checks unrelated to this contract: the changelog test expects
`33.2.2` while the repository contains `33.2.1`, and the Opera-safe distribution
archive is absent from the checkout. No selection-context check failed.

Browser-specific result: Chrome mirrored agent/UI/background cases **passed**;
Firefox mirrored agent/UI/background cases **passed**. The shared model-payload,
persistence, and trace assertions also **passed** for both builds. The hosted
WebMCP E2E real-Chrome smoke is a separate required PR check and must pass for the
current head. A manual installed-extension smoke with attached Chrome and Firefox
profiles was not performed by this Node-only run and is not represented as a
passing browser-profile check.
