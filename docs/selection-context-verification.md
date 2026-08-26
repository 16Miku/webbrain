# Selection-context verification record

This record is the release checklist for the selected-text context contract. The
same Node suite exercises the mirrored Chrome and Firefox agent, UI, background,
locale, persistence, and trace paths; it is intentionally separate from the
visible transcript, which is not a provider request.

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

## Local run record

The latest local run is recorded as **2055 passed, 2 failed** in both mirrored
browser paths. The two failures are pre-existing repository checks unrelated to
this contract: the changelog test expects `33.2.2` while the repository contains
`33.2.1`, and the Opera-safe distribution archive is absent from the checkout.
No selection-context check failed.

Real extension smoke tests are **unavailable** in this Node-only run because no
Chrome or Firefox profile is attached. The browser-specific source parity and
model-payload tests are **passed** by the same run; an installed-extension smoke
run remains the final release check when browser profiles are available.
