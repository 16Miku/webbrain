# New tab page

WebBrain replaces the browser's new tab page with a Mue-derived page that has a
single WebBrain box. Source: `newtab/`. Built output: `src/{chrome,firefox}/newtab/`
(committed). Build with `npm run build:newtab`.

## The box

| Mode | What happens |
|------|--------------|
| Ask | The text is handed to the side panel and **sent** (Ask is read-only). |
| Act | The panel opens in Act with the text **pre-filled and not sent**. The user presses Enter there, so Act stays explicit and reviewable. |
| Search | A URL is opened (http/https only); anything else goes to the browser's default search engine via `chrome.search.query` / `browser.search.search`. Hidden if the API is missing. |

No search engine is hard-coded and nothing is sent to WebBrain's servers by the page.

## Hand-off

1. In the submit handler (no `await` before it, to keep the user gesture) the page
   writes `{id, tabId, text, mode, createdAt}` to extension storage key
   `wbNewtabHandoff` and opens the panel for that tab (Chrome
   `sidePanel.setOptions` + `open({tabId})`; Firefox `sidebarAction.open()`).
2. It then sends `WB_NEWTAB_PANEL_OPENED`. `background.js` accepts it only from the
   extension's own `newtab/index.html` tab, and on Chrome adds the tab to the
   WebBrain group/`panelTabs` as the install page does.
3. `src/ui/newtab-handoff.js` (identical in both extensions) in the side panel claims
   the record: it must be ≤ 30 s old, ≤ 4000 characters, mode `ask`/`act`, and
   addressed to the tab the panel is showing. Claimed and stale records are removed.
   It runs at panel start and on `storage.onChanged`.

The text is user-typed, so it enters the panel exactly like typing in the composer;
it is never treated as page content.

## Things to know

- The page reads recent chats from the `webbrain_chat_history` IndexedDB read-only and
  never creates it. Off by default.
- Chrome shows a "change it back" prompt for new-tab overrides and users cannot be
  opted out by the extension; mention the override in the store listing.
- The `search` permission is new for both browsers.
- Photo credits and the Mue notice are shown under Settings → Credits.
- Tests: `test/newtab.mjs` (`npm run test:newtab`).
