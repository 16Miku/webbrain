# WebBrain new tab

The new tab page shipped inside the WebBrain extension. It is a fork of
[Mue](https://github.com/mue/mue) (BSD-3-Clause; see `UPSTREAM.txt` for the exact
commit and `LICENSE.mue-bsd-3-clause`), stripped of everything that talked to Mue's
servers and extended with a WebBrain task box.

This directory is the **source**. The built page is committed at
`src/chrome/newtab/` and `src/firefox/newtab/` (identical copies), because the store
zips are built from git HEAD.

## Build (needed for AMO source review)

Requires Node 20+ and npm.

```sh
npm --prefix newtab ci
npm --prefix newtab run build     # writes src/chrome/newtab and src/firefox/newtab
```

From the repo root: `npm run build:newtab`. Then `npm run test:newtab`.

Do not edit the generated folders by hand.

## What was changed from Mue

- Removed: Sentry, stats, marketplace, weather, quotes, welcome flow, Mue photo/API
  requests, Google Fonts, favicon lookups through third-party services.
- Backgrounds are bundled (`src/assets/offline-images`) or user-supplied.
- All state lives in `localStorage` under the `wbnt:` prefix
  (`src/lib/storage-namespace.js`) so it can never read or overwrite WebBrain's own
  keys on the same extension origin.
- Language follows the WebBrain setting (`wbLocale`); WebBrain strings are in
  `src/lib/wb-strings.js` (all 23 WebBrain locales).
- `src/features/agent/`: the task box (Ask / Act / Search) and optional recent chats.

See `docs/newtab.md` for the hand-off to the side panel and the security rules.
