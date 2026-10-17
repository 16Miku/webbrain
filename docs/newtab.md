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
   `wbNewtabHandoff:<tabId>` (one key per tab, so different tabs cannot overwrite each
   other; within a tab the box is locked synchronously at submit and stays disabled until the
   panel has claimed the task, so a second submit cannot replace it either) and opens the panel for that tab (Chrome
   `sidePanel.setOptions` + `open({tabId})`; Firefox `sidebarAction.open()`). If the
   panel fails to open, the page removes its own record again, so a failed submit can
   never be picked up and sent later when the panel is opened by hand.
2. It then sends `WB_NEWTAB_PANEL_OPENED`. `background.js` accepts it only from the
   extension's own `newtab/index.html` tab, on Chrome adds the tab to the
   WebBrain group/`panelTabs` as the install page does. Records that are never claimed
   are removed when their tab closes, and any older than three minutes are swept each time
   the background starts and on every submit.
3. `src/ui/newtab-handoff.js` (identical in both extensions) in the side panel claims
   the record for the tab it is showing. It must be ≤ 4000 characters, mode
   `ask`/`act`, addressed to that tab, and ≤ 30 s old (plus however long the panel's
   own startup took, up to two minutes). Claimed and stale records are removed.
   Nothing is claimed until the panel has finished restoring its chat (`start()`);
   after that it is tried on `storage.onChanged`, when the panel becomes visible, after
   a tab switch and after the visible-state refresh.
   - **Ask** is filled in and sent. If a run is already active in that tab it is
     queued behind it, like pressing Send. If the panel declines to send (plan review
     pending, a refresh in progress) the text stays in the composer.
   - **Act** is filled in with the panel switched to Act, and never sent.
   - Neither mode ever overwrites what is already in the composer (the user's own
     draft, an unconfirmed Act task, a declined Ask). The new task is added below it
     for review and, in that case, an Ask is not sent automatically.
   - A later hand-off is held back (retried every 150 ms, for up to about 30 s) while an
     earlier Ask's text is still in the composer waiting for its send to commit, so one
     task can never replace the other. The record stays in storage meanwhile.

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
