# New tab page

WebBrain can show a Mue-derived new tab page with a single WebBrain box, **in the Chrome
(and Chromium) extension only**. It is opt-in: the last step of onboarding has a "Use WebBrain
as my new tab page" checkbox, ticked by default, next to "Help Improve WebBrain", and
Settings → General has the same switch (`newTabEnabled` in extension storage). Source:
`newtab/`. Built output: `src/chrome/newtab/` (committed). Build with `npm run build:newtab`.

## Opt-in

An extension cannot switch `chrome_url_overrides.newtab` on and off while it runs: the
manifest declares it for as long as the extension is installed. So the page is always what
the browser opens for a new tab, and its first script (`newtab/src/lib/gate.js`) decides,
before the app, Mue's stylesheet or any data is loaded, whether to show it:

- `newTabEnabled === true`: the page loads as described below.
- anything else (never asked, unticked, an older profile that never saw the onboarding step):
  the tab is sent to the browser's own new tab page. `chrome://newtab` is this very override, so
  that is `chrome://new-tab-page/` on Chrome and other Chromium browsers, and
  `chrome-search://local-ntp/local-ntp.html` on Microsoft Edge (which does not serve the former).
- if anything fails (no extension APIs, unreadable storage, the redirect is refused) the page
  is shown, so the user never gets a blank tab.

What this does **not** change: the manifest still declares the override, so Chrome still shows
its "this extension changed your new tab page" notice, and the Web Store review of the
override applies whether or not a user opted in. The address bar may not hold focus on an
opted-out tab for the instant before the redirect lands.

Checked: Chromium 141 with the real extension loaded (unset / off → `chrome://new-tab-page/`,
on → the WebBrain page). **Not checked:** Edge's `chrome-search://local-ntp/...` target (taken
from a report in the Chromium Extensions group) and other Chromium browsers (Brave, Opera,
Vivaldi may show a different default page).

### Firefox has no new tab page

Firefox cannot hand a tab to its own new tab page: on Firefox 141 `tabs.update` rejects both
`about:home` and `about:newtab` ("Illegal URL"), and navigating there from the page (location,
meta refresh, a link) is denied. A manifest override would therefore take the new tab over for
everyone with no way to opt out, so the Firefox manifest declares no override (and no `search`
permission), `src/firefox/newtab` does not exist, and the Firefox side panel and Settings have no
switch for it. The side panel's handoff module is still shared byte-for-byte with Chrome; it is
simply never triggered on Firefox.

## The box

| Mode | What happens |
|------|--------------|
| Ask | The text is handed to the side panel and **sent** (Ask is read-only). |
| Act | The panel opens in Act and the text is **sent immediately**, like Ask. The box shows a warning that Act starts working right away. If **Plan before Act** is on in WebBrain, the plan is still shown for approval before anything is done. |
| Search | A URL is opened (http/https only); anything else goes to the browser's default search engine via `chrome.search.query`. Hidden if the API is missing. |

No search engine is hard-coded and nothing is sent to WebBrain's servers by the page.

## Hand-off

1. In the submit handler (no `await` before it, to keep the user gesture) the page
   writes `{id, tabId, text, mode, createdAt}` to extension storage key
   `wbNewtabHandoff:<tabId>` (one key per tab, so different tabs cannot overwrite each
   other; within a tab the box is locked synchronously at submit and stays disabled until the
   panel has claimed the task, so a second submit cannot replace it either) and opens the panel for that tab (Chrome
   `sidePanel.setOptions` + `open({tabId})`). If the
   panel fails to open, the page removes its own record again, so a failed submit can
   never be picked up and sent later when the panel is opened by hand.
2. It then sends `WB_NEWTAB_PANEL_OPENED`. `background.js` accepts it only from the
   extension's own `newtab/index.html` tab, on Chrome adds the tab to the
   WebBrain group/`panelTabs` as the install page does. Records that are never claimed
   are removed when their tab closes and cleared when the browser starts (one written in the few
   seconds before a crash is left until the start after that; the panel ignores it meanwhile). There is no
   periodic sweep: storage has no compare-and-delete, so deleting a key from an earlier
   read could take a task written in between. A stale record is simply ignored by the
   panel and replaced by the next submission from that tab (the page's own lock outlasts
   the longest age the panel accepts, so a live task is never replaced).
3. `src/ui/newtab-handoff.js` (identical in both extensions) in the side panel claims
   the record for the tab it is showing. It must be ≤ 4000 characters, mode
   `ask`/`act`, addressed to that tab, and ≤ 30 s old (plus however long the panel's
   own startup took, up to two minutes). Claimed records are removed; stale ones are left
   for the page to replace (see above). A task the panel has to hand back (a send declined
   after a tab switch) is queued in `wbNewtabHandoff:retry:<tabId>`, which only the panel
   writes, and is delivered when that tab is shown again.
   Nothing is claimed until the panel has finished restoring its chat (`start()`);
   after that it is tried on `storage.onChanged`, when the panel becomes visible, after
   a tab switch and after the visible-state refresh.
   - **Ask** is filled in and sent. If a run is already active in that tab it is
     queued behind it, like pressing Send. If the panel declines to send (plan review
     pending, a refresh in progress) the text stays in the composer.
   - **Act** is sent the same way, with the panel switched to Act. It is queued behind an active run and, when Plan before Act is on, goes through plan review like any Act turn.
   - Neither mode ever overwrites what is already in the composer (the user's own
     draft, a declined send). The new task is added below it for review; the panel keeps
     the mode that draft was written in, and the combined text is not sent automatically
     in that case.
   - A later hand-off is held back (retried every 150 ms, for up to about 15 s) while an
     earlier Ask's text is still in the composer waiting for its send to commit, so one
     task can never replace the other. The record stays in storage meanwhile; after the
     15 s the polling stops, and the task is picked up as soon as that send settles (or the
     next time the panel is triggered).

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
