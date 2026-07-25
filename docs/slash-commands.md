# Slash Commands

WebBrain accepts slash commands as the first thing on a line in the input box.
Type `/help` in the panel to see complete usage signatures and flag
descriptions. Typing a canonical command followed by a space opens autocomplete
for its available flags.

## Reference

| Command | What it does |
|---------|--------------|
| `/help` | Show the list of available commands |
| `/ask` | Switch to Ask mode before sending |
| `/act` | Switch to Act mode before sending |
| `/dev` | Switch to Dev mode before sending |
| `/plan` | Switch to Ask mode with planning intent |
| `/schedule [prompt]` | Create a scheduled task, optionally prefilling its prompt |
| `/schedule --list` | Show scheduled tasks |
| `/watch [--keep] [--secs <30-120>] [--long \| --short] <condition and action> [/beep]` | Poll the current page for a condition; stop after the first match unless `--keep` is set, and optionally play a background alert |
| `/progress` | Show the current progress ledger |
| `/scratchpad` | Show the current scratchpad |
| `/scratchpad --append <text>` | Append text to the current scratchpad |
| `/scratchpad --clear` | Clear the current scratchpad |
| `/memory` | Show saved user memory |
| `/memory --add <text>` | Save a user preference to memory |
| `/memory --forget <id>` | Forget a saved memory by ID |
| `/workflow` | List saved workflows and their IDs |
| `/workflow --save <name>` | Compile the latest successful traced run into a reusable, value-free workflow |
| `/workflow --run <id>` | Run a saved workflow in Act mode, collecting any runtime parameters locally |
| `/workflow --delete <id>` | Delete a saved workflow |
| `/workflow --export <id>` | Download a sanitized portable `webbrain-workflow/1` JSON file |
| `/workflow --import --file` | Import a portable workflow file as a new local saved workflow |
| `/allow-api` | **Per-conversation API mutation override.** See [below](#allow-api). |
| `/dangerously-skip-permissions` | **Global permission-prompt bypass.** Turns off `Ask before consequential actions` without opening Settings. WebBrain will act without per-site prompts until you re-enable the setting. |
| `/compact` | Force context compaction for the current conversation |
| `/verbose` | Toggle verbose/compact tool display |
| `/reset` | Clear the conversation and all per-conversation flags |
| `/screenshot [--full-page]` | Capture the visible tab, or the full scrollable page with `--full-page` (Chrome only) |
| `/record [--full-screen] [--hide-recording-indicator] [--transcribe]` | Record the current tab, or a selected screen/window with `--full-screen` (Chrome only); add `--hide-recording-indicator` to hide the banner or `--transcribe` to save a transcript after stop |
| `/export [--traces \| --config]` | Download version-stamped conversation Markdown, export the version-stamped tool chain with `--traces`, or export a Settings snapshot with `--config` |
| `/import <json>` | Import a Settings snapshot pasted inline |
| `/import --file` | Choose and import a Settings snapshot JSON file |
| `/profile` | Toggle profile auto-fill on/off without opening Settings |
| `/vision` | Toggle vision mode (screenshot understanding) on the active provider |

## `/watch`

`/watch` performs its first check immediately and then polls every 60 seconds by
default. `--secs` accepts 30–120 seconds.

Relative conditions such as "when a new commit appears" establish a baseline on
the first check; absolute conditions such as "when CI is green" can match
immediately.

A trailing `/beep` enables the watch-only alert tool; `--short` and `--long`
select its tone. Alerts play only after a verified successful action, and
`--keep` suppresses repeated alerts for the same stable event key. If a model
verifies the action but omits the optional alert tool, the watch records the
warning and completes or continues without sound.

Polls run in dedicated inactive tabs, so leaving the initiating page does not
navigate it back to the watched URL, and the helper tab is closed when the watch
ends. Transient poll failures are tolerated; three consecutive failures stop the
watch.

## `/allow-api`

`/allow-api` lifts the UI-first restriction for the current conversation so the
agent may use POST/PUT/PATCH/DELETE via `fetch_url` when the UI is failing. A
badge appears while it is active, and it clears on `/reset`.

The default UI-first rule exists because API actions are invisible (you don't
see what's being sent), often require separate auth tokens you may not have
configured, and can have a much larger blast radius than a visible mis-click.
Only use `/allow-api` when you've decided you want that tradeoff for a specific
job. See [security model](security-model.md#allow-api-flag).

## Run-capture suffixes

These are intentionally omitted from `/help` and autocomplete.

Append `/record [--save-as <filename>]` to the end of a normal prompt to start
recording the current tab immediately before the run, then stop and save the
WebM when that run settles (Chrome only).

Append `/screenshot [--save-as <filename>]` to save viewport screenshots
immediately before and after the run (Chrome and Firefox). For example,
`Test the checkout /screenshot --save-as checkout.png` saves
`checkout-before.png` and `checkout-after.png`; without `--save-as`, WebBrain
uses timestamped filenames.

If the run opens another tab, WebBrain reactivates the originating run tab
before saving the after screenshot. If the recording or initial screenshot
cannot be started and saved, the run is not sent. Standalone `/record` and
`/screenshot` keep their existing behavior.

## Exports, snapshots, and workflows

Full schemas and privacy properties for every export live in
[export and workflow formats](export-and-workflow-formats.md). The short
version:

- **Settings snapshots** use `webbrain-config/1` and include all portable
  Settings values, including provider, vision, transcription, and CapSolver API
  keys, profile data, user memory, custom skills, and permission choices. **The
  JSON is plaintext and should be stored securely.** Device-bound Cloud Sync
  sessions/device IDs, conversations, traces, scheduled jobs, usage counters,
  and accumulated spend are not exported.
- **Saved workflows** use a separate `webbrain-workflow/1` schema; they are not
  raw trace replays. Historical `ref_id` values, action CSS selectors,
  coordinates, query strings, fragments, and typed field values are excluded.
  Typed values become runtime parameters, and each action is bound to the
  recorded origin and URL family. At run time WebBrain resolves a fresh
  accessibility-tree target and executes through the normal Act permission,
  submit-confirmation, and verification gates. Ambiguous targets fail closed. If
  an action may already have happened but its result is unknown, replay stops
  instead of retrying it. Runtime parameter values are not saved to the
  workflow, conversation, user memory, replay trace, or Agent fallback prompt;
  they are still delivered to the target page by the requested browser action.
  The original opt-in source trace remains separate and can contain raw tool
  arguments until the user deletes that trace.
- If replay starts outside the saved origin or URL family, deterministic replay
  hands control to the Agent with the sanitized start scope so normal
  navigation, permission, and verification rules can recover the workflow
  instead of ending it immediately.
- **Portable workflow files** contain the raw sanitized `webbrain-workflow/1`
  definition and are limited to 1 MiB. Export re-normalizes the definition
  before download. Import normalizes it again, assigns a fresh local ID and
  timestamps, and never overwrites an existing workflow, so the same file can
  safely move between Chrome, Firefox, and WebBrain Cloud.
