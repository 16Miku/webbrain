# Vision mode

In vision mode an Act run sees the tab only as screenshots and acts with the mouse and keyboard at coordinates. There is no accessibility tree, no `ref_id` and no CSS selector in the model's view. The run starts from a full frame of the viewport; after every action WebBrain sends only what changed on screen (a patch), a new full frame when most of the screen changed, or a one-line "no visible change".

The accessibility-tree path stays available (Settings → Advanced → **Vision mode** → Off) and is used automatically when the model cannot take images.

## The setting

Settings → Advanced:

- **Vision mode** (storage key `visionMode`): **On** (default) or **Off**. On applies to Act runs whose model receives screenshots directly (`provider.supportsVision`). A separate describe-only vision model cannot aim clicks, so a text-only model keeps the accessibility tree. Ask and Dev are unchanged.
- **Vision screenshot size** (`visionQuality`): **Economy**, **Balanced** (default) or **Sharp**. It caps the model-facing image (Economy: long edge 1024 px / 0.6 MP; Balanced: 1440 px / 1.05 MP; Sharp: the provider's own limit). The model can always `zoom` for detail.

A run decides once, when it starts (`_beginVisionRun` snapshots both settings), like lean mode. The resolved state is recorded in the trace's runtime config as `vision_mode_setting` and `vision_mode`. The `Agent` class default is `off`, so embedders and unit tests opt in explicitly; `background.js` applies the stored setting, whose default is `on`.

One thing ends vision mode inside a run: a site workflow whose completion is proved against the app-owned element inventory (`requiresLedger` in `adapter-workflow.js`, form and publish jobs of some adapters) cannot be certified from screenshots. Once the planner or a live adoption selects one, `resolveVisionMode` answers `workflow_needs_element_inventory` and the next step gets the tree tools and the tree prompt (the loop rebuilds the system prompt when the vision state flips).

## Tools

A vision run gets its tier's Act tools with the DOM-targeting ones replaced (`VISION_REMOVED_TOOLS` in `vision-tools.js`):

| Removed | Added |
|---|---|
| `get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`, `set_checked`, `hover`, `drag_drop`, `inspect_viewport`, `get_interactive_elements`, `click`, `scroll`, `browser_batch`, `wait_for_element`, `find_text`, `verify_form`, `iframe_*`, `get_frames`, `get_shadow_dom`, `shadow_dom_query`, `promote_iframe`, `carousel_navigate`, `upload_file`, `download_resource_from_page`, `gmail_count_results` | `click_at`, `scroll_at`, `hover_at`, `drag_at`, `zoom`, `take_screenshot`, `wait` |

`type_text` stays with a vision schema (`text`, `clear`; it types into the focused field). Everything that does not name a DOM target is kept: `press_keys`, `navigate`, `go_back`/`go_forward`, `read_page`, `read_pdf`, `extract_data`, `fetch_url`, downloads, scheduling, `scratchpad_write`, `progress_*`, `clarify`, `done`, skills and the CAPTCHA tools. `read_page` is the cheap way to get exact long text; screenshots are the primary view.

| Tool | What it does |
|---|---|
| `click_at({x, y, image?, button?, clicks?})` | A real mouse click at the point. `clicks:2` double-clicks, `clicks:3` selects a line, `button:"right"` opens a context menu. |
| `scroll_at({direction, amount?, x?, y?})` | Mouse-wheel scrolling of whatever is under the point (page, pane, list, map), in steps of ~100 CSS px. |
| `hover_at({x, y})` | Moves the pointer without clicking (hover menus, tooltips). |
| `drag_at({start_x, start_y, end_x, end_y})` | Press, move and release (sliders, reordering, selecting). |
| `zoom({x, y, width, height})` | Returns the rectangle as a sharper image `z<n>` (up to 2 image px per CSS px). |
| `take_screenshot()` | A fresh full frame. |
| `wait({seconds})` | Waits 0.2–10 s; the screen update follows. |

The vision prompt (`buildVisionActPrompt`, used through `getVisionActPrompt` in `tools.js`) replaces the tier's tree-centred Act prompt and reuses the shared sensitive-data and plan-to-execution sections verbatim. The universal cookie-banner / paywall / PDF guidance is given in vision terms (`visionUniversalPreamble`: `click_at "Reject all"`, look at the updated screen, `read_pdf` instead of paging a PDF with screenshots), and site adapter notes, written for the element tools, arrive with one line saying that `click_ax`, `set_field`, refs, selectors and the tree are not available and their facts about the site apply to `click_at`, `type_text`, `press_keys` and `scroll_at` (`VISION_SITE_NOTES_PREFACE`).

## Images and coordinates

Every image is labeled with an id: `f<n>` for a full frame, `p<n>` for a patch, `z<n>` for a zoom. The model gives a point in the pixels of the image it read it from and names that image with `image` when it is a patch or zoom; with no `image` the point is read from the current screen (latest frame plus its patches). `VisionSession` (`vision-session.js`) keeps each image's map to the frame and the frame's map to CSS pixels, so the model never rescales anything.

Gemini, Qwen3-VL, GLM-4.xV and InternVL point in relative 0..1000 coordinates; for them the tools and prompt say so and the session converts (`coordinates: 'normalized'`). Every other model uses image pixels. An `image` value that is not an exact id (`"z2.png"`, `"zoom z2"`) is refused (`unknown_image`) instead of being read as the current screen.

A point is refused before any dispatch when:

- its image belongs to an earlier frame (`stale_image`), or the area around it changed in a later patch (`stale_area`);
- it lies outside the image;
- it is the second or later coordinate action of one model turn and the live screen changed near it after the earlier action, or the screen could not be re-captured to check (`_visionStabilityBlock`, checked right before dispatch, after every gate; a `drag_at` is checked at both ends against one capture);
- the run has no frame of its own yet (`no_frame`).

A refused point also stops the rest of the model's batch: the calls after it (a `type_text`, say) were planned on that point.

Every run starts on a frame it captured itself: `_beginVisionRun` retires the previous run's screen, so if the first capture fails the model is told so, earlier screenshots leave the request, and coordinates are refused until `take_screenshot` succeeds. Image ids and epochs continue across sessions of one conversation (another model, a restarted worker), and the current screen is the last full frame in the history by position.

### Capture, retina and zoom

`vision-budget.js` picks the image size per provider family (`detectVisionProfile`), as the largest size the provider accepts **unchanged**: every vision API shrinks larger images before the model sees them, and the model then answers in the shrunk image's pixels.

| Profile | Limits | Format |
|---|---|---|
| Anthropic | long edge ≤ 1568, ≤ 1.15 MP | WebP |
| OpenAI | ≤ 2048, short edge ≤ 768 | WebP |
| Gemini | ≤ 1536, ≤ 1.2 MP; 0..1000 points | WebP |
| Qwen2/2.5-VL, UI-TARS | ≤ 1.0 MP, multiples of 28 (so `smart_resize` is the identity) | JPEG |
| Qwen3-VL / Qwen3.5+ | ≤ 1.05 MP, multiples of 32; 0..1000 points | JPEG |
| GLM-4.xV, InternVL | ≤ 1280, ≤ 1.0 MP, multiples of 28; 0..1000 points | JPEG |
| Local (llama.cpp, Ollama, LM Studio, WebGPU) | ≤ 1280, ≤ 1.0 MP, multiples of 28 | JPEG (llama.cpp cannot decode WebP) |

An image never has more pixels than the CSS viewport: a retina capture is downscaled locally, and `zoom` is the path to fine detail. WebP is ~30% smaller than JPEG for UI screenshots, so uploads are faster; providers bill images by pixels, so the token cost is the same.

Chrome captures with CDP `Page.captureScreenshot`. Two properties of that call drive the implementation (verified in `test/vision-pipeline-browser.mjs`):

- **Clip coordinates are document coordinates.** A clip at `0,0` on a scrolled page captures the unrendered top of the document, a blank frame. The clip starts at the visual viewport's page offset (`Page.getLayoutMetrics`).
- **The clip is in device-independent pixels**, CSS pixels times the browser zoom (`Page.getLayoutMetrics().cssVisualViewport.zoom`), and **the output is clip × scale × device scale factor.** With the DPR (device scale factor × zoom) divided out of the scale, the image comes back at the planned size; whatever size actually comes back is resampled to the plan (`rasterizeFrame`), so emulated DPRs and compositor quirks cannot change the coordinate map. The legacy auto-screenshot clip (`_viewportCaptureClip`) applies the same zoom factor.

Firefox captures with `tabs.captureTab`, whose `scale` is image pixels per CSS pixel (no DPR factor) and whose `rect` is page-relative. The rect is always the visual viewport: without one Firefox captures the whole content area, classic scrollbars included.

Screenshot redaction maps element boxes into the captured visual-viewport box (page space), so a field next to a scrollbar is still covered.

### Diffs

After a batch WebBrain waits until two consecutive captures match (bounded, ~1 s; a micro change between them, a few 16 px cells such as a blinking caret, a clock or a spinner, counts as a match, `isMicroScreenChange`, since it never stops), then compares the new frame with what the model has seen (`vision-diff.js`): 16 px cells, a per-pixel threshold that ignores encoder noise and caret blinks, nearby changes merged, at most 4 padded regions. `planFrameUpdate` sends:

- **nothing but a one-line note** when nothing changed: "no visible change" is also the clearest signal that a click missed;
- **patches** for local changes (typing, a menu, a toast). For a provider with an image grid (28 px for Qwen2/2.5-VL, UI-TARS, GLM-4.xV, InternVL and local servers; 32 px for Qwen3-VL) each patch is grown to multiples of the grid, like frames and zooms, so the server never resizes it and its pixels map 1:1 to the frame;
- **a new frame** when more than 45% changed, the patch chain is 6 long, patches would cost ≥ 70% of a frame, or the URL, viewport size or DPR changed.

The "seen" buffer copies only patched regions, so changes below the threshold accumulate until they are sent instead of drifting forever.

Only the current frame, its patches and zooms stay in the model request (`pruneVisionImages`); older images become a short placeholder. Screen updates are app-owned user turns (`webbrainAppOwned`), never mistaken for a new request.

A capture, encoding or input failure never ends the run: a screen update that cannot be prepared becomes a one-line note and the next update is a full frame; a vision tool that fails returns a tool error (an unknown outcome once input may have gone out).

## Page feedback in a vision run

The page monitor (`content/page-monitor.js`) and page feedback (`agent/page-feedback.js`) watch the page between decisions as in a tree run. A vision run changes what they show the model and when they set a decision aside:

- **No tree text reaches the model.** The pre-decision capture still binds keyboard input to the focused field, but its tree text is not added to the conversation; feedback messages carry the events and the URL without a page dump, and applying feedback skips the accessibility-tree read altogether.
- **Page churn does not supersede screenshot points.** `click_at`, `hover_at` and `drag_at` are `vision_point` calls and `scroll_at` a `scroll` call (`page-feedback-policy.js`), so automatic page activity while the model was thinking (a ticker, a live timeline, a spinner) keeps the decision. The pixels around the point are compared with the model's frame right before dispatch (`_visionStabilityBlock`, mandatory once anything changed), and the monitor rebases the prepared operation over passive or unattributed churn only while the element under the point is the prepared one and has not moved (`rebaseVisionPreparation`; a wheel binds no element). A person's input, a navigation or another document still voids it.
- **Typing rides on its click.** `type_text` and `press_keys` right after a `click_at` of the same response are checked by focus: the element focused at the clicked point must be a text field (`_visionFocusFollowsClick`, the probe's `focus` reading). The page reacting to that focus (a hint, a composer expanding) no longer blocks the typing.
- **The wheel stays the agent's.** Every CDP wheel notch passes the fence, and the monitor counts the wheel events those commands own, so a notch the browser delivers after the next one was fenced is not taken for a person's scroll.
- **A set-aside decision is remade on the current screen** (`_visionObserveNow`: a patch, a new frame or "no visible change"), never on tree text.
- **An unchanged screen is not sent again before a decision.** When the only news is automatic churn, or a viewport change of no known origin (the debugger infobar appearing when a run starts), one capture is compared with what the model last saw; within a micro change no message and no image are added (`_visionScreenUnchanged`), and such a resize does not hold the decision for the idle wait. A person's input is always reported, with a fresh look.

### Latency

With an instant model the MV3 fixture's four steps (click and type, send, scroll, done) took about 15 s before these changes and about 7.5 s after:

- the settle wait ends on micro changes instead of running its full ~1 s on every step with a caret or a clock on screen;
- the forced re-observation after page churn and the tree read in feedback are gone (one screen update per step);
- in Chrome the file-chooser guard's 500 ms settle doubles as the quiet window for a new tab (`watchOpenedTabs` sees tabs as they are created) instead of a further 900 ms poll; a tab the click opens later is still rerouted into the run's tab (`_visionPlatformLateTab`): the watch stays armed for 4 s, a tab that opens while the update's screen settles is rerouted and the screen read again, and one that opens while the model decides is rerouted before the next update;
- the first frame is taken after a cookie-banner decline in progress has finished, so it does not show a banner about to disappear.

## Input dispatch and safety

`click_at` is rewritten into an ordinary coordinate `click` (`translateVisionClick`) before the batch pipeline runs, so the permission gate, the submit probe and every hard guard (recipient, deletion, money, credentials, publishing) inspect it like any other click. Only the final dispatch differs:

- **Chrome**: trusted CDP pointer events at exactly the point (`_visionDispatchClick`), with the coordinate path's dispatch-time protections kept: a native `<select>` is focused for `type_text` instead of opening an OS popup no screenshot can show, the file-chooser guard, the recipient dispatch binding, `target=_blank` redirection into the run tab (also for a tab opened after the click returned, see Latency) and click-progress annotation. The legacy coordinate path's semantic re-targeting and nearby-input redirect are skipped: a vision click lands where the model pointed. Iframes, including cross-origin ones, receive the events natively.
- **Firefox**: no CDP, so `content.js` `visionInput` dispatches a synthetic pointer sequence at the exact point with real client coordinates, reproducing a press's focus (and its caret: a click in a text field or editable text puts the caret under the pointer) and a click's activation, moving off the element the pointer was last over the way a mouse does (out and leave events, so a hover menu that closes on mouseleave closes; a wheel moves the pointer to its point first and goes where the browser would send it: the nearest scroller that can still move that way, an exhausted one passing it on unless its `overscroll-behavior` keeps it, never a page locked with `overflow: hidden`, and from a frame that cannot scroll to the page around it), selecting the word under the pointer for a double click and its line (a textarea's line, a whole input, the text block) for a triple click, and entering same-origin iframes. The click runs inside the same native file-chooser guard as every agent click (`clickWithoutNativeFilePicker`), and the agent settles that guard afterwards, so a chooser opened a moment later is caught too. Dispatched events reach a disabled control's listeners, unlike a person's click (or `el.click()`), so a click or drag that would press a disabled control, disabled by its fieldset included, is refused before anything is sent (`disabled_control`). A drag gives every move and the release in the coordinates of the document under the point, so a slider in a same-origin frame reads one consistent path; its press focuses what it lands on and starts what a person's press would, since synthetic events alone neither move a native slider nor select text: on an `<input type=range>` the value under the pointer is set as the browser sets it (snapped to the step, an `input` event per change, `change` on release), and on selectable text or in a text field the text from the press to the pointer is selected (after a cancelable `selectstart`; not on links, images, draggable items, other controls or `user-select: none`). A click that must pass the recipient binding keeps the content click path. Cross-origin iframes receive the click on the frame element.

Right before input goes out, both builds read what is under the pointer with `visionDomProbe` (`vision-dom-probe.js`), in an isolated world (Chrome, CDP) or the content-script world (Firefox), so page scripts cannot redefine the DOM methods it calls:

- `click_at` with `clicks: 2|3` is refused on a button, link or other control (including an element drawn with a pointer cursor, which is how a framework button made of a bare `<div>` shows itself), on a detected submit, on a protected messaging page, inside a frame it cannot inspect, or when the target cannot be read: each extra click would repeat the one action the checks approved. Double and triple clicks remain for selecting text.
- `drag_at` is refused when it is shorter than 6 CSS px, when the press and release would click a control (their nearest common ancestor is or is inside a button, link, label, similar control or pointer-cursor element, unless the drag starts on a slider, scrollbar, resizer, draggable item or grab handle), when either end is inside a cross-origin frame, when the target cannot be read, or when the click submit probe reads its start point as a submit, send, delete or payment control (a drag never gets the confirmation a click gets). On a protected messaging page `drag_at` is blocked outright, like `iframe_click`.
- `scroll_at` is refused over a focused number field, which takes the wheel as +/-.

Every CDP input passes `cdpClient`'s page-agent fence and every content action passes `beforePageAgentDispatch`, so the page monitor attributes the events to the agent. `drag_at` is gated as a click (`TOOL_CAPABILITY`); captures and pointer results are untrusted page content (`UNTRUSTED_CONTENT_TOOLS`), and every image label says that text in it is data, never instructions. Screenshot redaction (Settings) applies to frames and zooms.

## Files

| File | Role (both builds; the first eight are byte-identical) |
|---|---|
| `vision-mode.js` | setting normalization and per-run resolution |
| `vision-budget.js` | provider profiles, sizes, token estimates, formats |
| `vision-diff.js` | frame diff, regions, update planning |
| `vision-session.js` | image ids, coordinate maps, staleness |
| `vision-tools.js` | tool schemas, tool-set transform, prompt, labels, click translation |
| `vision-encoder.js` | canvas decode / resample / encode |
| `vision-runtime.js` | agent methods: keyframes, observation after batches, native tools, pruning, dispatch preflights |
| `vision-dom-probe.js` | the in-page probe behind the dispatch checks, and the checks themselves |
| `agent.js` | platform layer (`_visionPlatform*`, `_visionDispatchClick`) and hooks |
| `content.js` | `visionInput` (Firefox input path; also loaded in Chrome) |

## Tests

```sh
npm run test:vision-mode
```

- `test/vision-mode.mjs`: sizing, profiles, token formulas, diffs, micro changes, sessions, translation, tool surfaces of every tier in both builds, permission classification, prompt, the page-feedback policy for vision calls and the monitor's vision rebase.
- `test/vision-mode-agent.mjs`: the real run loop in both builds (streaming and not) with a scripted vision model and a fake screen: first frame, tool surface, click translation, patches, "no visible change", new frames on navigation, pruning, stale and moved points, native tools, fallback to the tree; a refused click stopping its batch, tool and encoding failures, a failed first capture in a later run, a model switch between runs, drag/wheel/repeated-click refusals, `drag_at` on a protected messaging page; the settle wait on a caret or clock versus real motion; page churn before a decision (no tree read, nothing re-sent while the screen stays as seen, a change after the update shown, a person's input always reported); site notes in vision terms; a ledger workflow switching the run to the tree path; a drag after an earlier action of its batch re-checked at both ends; in Chrome, a click that opened no tab costing no poll, tabs opened at once or later being rerouted, and a late-tab watch staying armed past an update and rerouting a tab opened while the screen settled.
- `test/monitor-vision-wheel.mjs`: the real page monitor in Chromium: two wheel notches fenced before their events arrive stay the agent's (a third, unfenced one is a person's), page churn does not void a prepared wheel, a person's click does.
- `test/vision-pipeline-browser.mjs`: Chromium at DPR 1/2/3 on a scrolled page: planned size, exact mapping, trusted clicks, diff regions, WebP vs JPEG; the Firefox content input path (caret placement, word and line selection, pointer transitions, wheel routing, drags in a same-origin frame, native range inputs, text selection, disabled controls, the file-chooser guard); the DOM probe on buttons, labelled text fields, focused number fields, selects, link cards, sliders and same-/cross-origin frames.
- `test/quality/vision-mode-mv3.mjs` (`--dpr=2`, `--zoom=1.25`, `--scroll=100`, combinable): the installed MV3 extension with a loopback model that reads the frame labels and fills and submits a form with `click_at` and `type_text` (sent together in one response), scrolls with `scroll_at` and follows a `target=_blank` link; two colored markers (viewport-fixed and in the document) must appear in the first frame exactly where the label's scale puts them. The page reacts to the click's focus and a ticker changes it every 250 ms: typing must land on the first try, the wheel must scroll the page, the link's tab must become the run's tab with no extra tab left, no request may carry tree text, and until the link navigates every decision gets exactly one screen update and no browser-state message.

The older MV3 quality fixtures script an accessibility-tree model (they answer with `ref_id`s read from `get_accessibility_tree`) under model names that WebBrain recognizes as vision-capable, so they seed `visionMode: 'off'` with their other settings. A new fixture that scripts tree tools needs the same line.

## Limits

- File uploads (`upload_file`) and page-resource downloads by selector are not offered in vision mode; switch it off for those tasks. A click that would open a native file chooser is blocked in both builds and reported in those terms (`visionFilePickerBlockedResult`).
- Closed shadow roots and canvas apps are reachable by pointer, but a native `<select>` popup is never visible in a screenshot: such a field is focused and `type_text` picks the option.
- HTML5 drag and drop driven only by `dataTransfer` may not react to synthetic or CDP pointer drags.
- A drag is not shown to the submit, money or publishing checks; it is refused when it would click a control, but a custom "slide to confirm" widget is only as safe as the page makes it.
- Firefox input is synthetic (`isTrusted: false`); pages that require trusted events need Chrome.
