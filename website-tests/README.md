# Website tests

This self-contained suite lives in the repository's root-level `website-tests/`
directory. Its `.env`, account configuration, harness, scenarios, tests, guide,
profiles and report artifacts live here.

The opt-in runner tests WebBrain using an explicitly selected local browser or
WebBrain Cloud session. Account A performs the task; account B independently
observes receipts or shared access. B may use a different backend and needs no
WebBrain extension/provider when it is a local DOM observer.

The harness changes no product guards. Local tasks enter the installed
extension's normal `chat_start`/`continue_start` protocol; Cloud tasks use the
documented run API. Helpers only prepare observation, navigate an explicitly
selected observer, read evidence, or perform configured human interventions.

The directory is organized as follows (private files and generated directories
are ignored):

```text
website-tests/
  .env                         # private settings
  .env.example                 # tracked placeholders
  .env.authenticated.json      # private accounts and mutation scope
  config.example.json          # tracked configuration template
  package.json                 # commands for this suite
  README.md
  cli.mjs, config.mjs, ...      # harness, scenarios and harness tests
  backends/                    # local browser and Cloud adapters
  artifacts/                   # private reports, ledgers and fixture evidence
  profiles/                    # optional dedicated logged-in test profiles
```

## Install and configure

Use Node 22+ and install the repository's existing Playwright dependencies once.
From the repository root:

```powershell
npm install
npx playwright install chromium
Set-Location website-tests
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
if (-not (Test-Path -LiteralPath .env.authenticated.json)) { Copy-Item config.example.json .env.authenticated.json }
```

Both populated files are ignored by this directory's `.gitignore`. The current
worktree already has placeholder copies ready to edit. Set backend/session/provider choices
in `.env`, and account identities, exact recipients, test folders, and permitted
actions in `.env.authenticated.json`. Credentials in JSON must use `env:NAME`
references. Process environment values take precedence over `.env` values.

Leave `WBTEST_TARGET=fixtures` for deterministic development. A default `run`
executes only the owned installed-extension file-transfer fixture. It neither
selects a logged-in browser nor sends anything to a real website.

For live X, for example, set `WBTEST_TARGET=live`,
`WBTEST_SCENARIOS=x-post-lifecycle`, `WBTEST_LIVE_MUTATIONS=true`, and
`WBTEST_ALLOWED_ACTIONS=compose,edit,upload,post,navigation,delete`. Replace the
X account placeholder in private JSON. Authorization covers exactly the chosen
account and uniquely marked disposable resources; it is not an account-wide
permission. Once configured, the harness does not repeatedly ask for that grant.
WebBrain's own host/capability permissions still apply: grant the required test
host/actions through its normal UI during setup. Pending approvals are reported
as pending input; the harness never disables or automatically approves them.

`allowedRecipients` must contain the actual delivery identity: email address,
E.164 phone, or Telegram peer ID. A contact display label alone is insufficient.
`allowedDestinations` must contain the exact disposable Drive folder URL.

## Commands

Run these from `website-tests/`. All relative configuration/report/profile paths
resolve from this directory.

```powershell
npm run cli -- help
npm run list -- --target live
npm run dry-run -- --target live --sites x,gmail
npm run setup -- --role A
npm run setup -- --role B
npm run doctor -- --role A
npm run doctor -- --role B
npm run run -- --target live --scenario x-post-lifecycle
npm run run -- --target fixtures --scenario fixture-shared-guards
npm run summarize -- --report artifacts/RUN_DIRECTORY
npm run reconcile -- --report artifacts/RUN_DIRECTORY
npm run cleanup -- --report artifacts/RUN_DIRECTORY
```

Use `--env FILE`/`--config FILE` to select another private configuration in this
directory. The repository-root aliases `npm run authenticated -- COMMAND`,
`npm run test:authenticated` and `npm run test:authenticated:installed` delegate
to this suite and use the same `.env` and artifact paths.
`--backend local|cloud` overrides the role selected by `--role` (A by default); configure B independently.
`--sites` or `--scenario` select cases without rewriting scripts. Runs are
serial because accounts, drafts, and conversations are shared mutable state.
Repetitions, per-request/run time, polling and run count are bounded. The suite
deadline stops new dispatches; an in-flight bounded observation/request or
owned-run Stop may finish afterward. Cloud polling timeouts do not imply that
the remote run has stopped: reconcile that existing run before further work.
Exit codes are 0 for verified success, 1 for failure, and 2 for blocked,
unsupported or pending-input outcomes. A dry run performs no network requests.

## Local browsers and manual login

Set `WBTEST_ACTOR_PROFILE=profiles/actor` and
`WBTEST_OBSERVER_PROFILE=profiles/observer` for ignored dedicated profiles here, or set `WBTEST_ACTOR_CDP_URL` to an explicitly enabled debugging endpoint.
Do not configure both. A dedicated profile retains logins between runs. Setup
opens WebBrain settings and configured sites; log in manually, including QR,
OTP and MFA, and press Enter in the terminal when finished. No password/login
automation or challenge bypass is implemented.

An arbitrary already-open personal browser cannot always be attached. Chrome
136+ restricts debugging its default user-data directory; use a dedicated
non-default profile with debugging intentionally enabled. See
[Chrome's debugging changes](https://developer.chrome.com/blog/remote-debugging-port).
For automated unpacked loading, use Playwright's bundled Chromium: current
branded Chrome/Edge have removed the needed side-loading switches. See
[Playwright extension guidance](https://playwright.dev/docs/chrome-extensions).
`WBTEST_ACTOR_EXECUTABLE` is available for compatible explicitly chosen builds;
unsupported loading is reported rather than bypassed.

The runner refuses standard Chrome/Edge profile directory launches and does not
copy cookies, delete profile locks, restart unrelated browsers or change security
settings. Dedicated profiles launched by the runner close on exit; CDP sessions
detach and existing pages stay open. Remote CDP requires an explicit
`trustRemoteCdp:true` private role configuration. CDP endpoints must not contain
embedded credentials.

Doctor reports actual installed version, selected provider/model and a runtime
fingerprint of four named installed files. This fingerprint is not a Git commit
attestation or a claim that every extension file was hashed. Local
`expectedVersion` pins the extension version; `expectedBuild` pins that reported
fingerprint. A DOM-only observer reports no extension build.

Account identity must be visible or mechanically readable from exact native
account UI. For WhatsApp/Telegram, expose your own profile phone and the intended
peer details before preflight. Operator-reviewed identity/recipient selector
bindings can accommodate another UI layout; their values still must match.
Missing identity metadata blocks the case instead of guessing the account.

## WebBrain Cloud

Set A's backend to `cloud`, `WEBBRAIN_API_KEY` in the private environment, and
`WBTEST_ACTOR_SESSION_ID` to the exact normal persistent session. B can use a
local observer or independently configured Cloud credentials/session. No
arbitrary ready session is selected.

To explicitly create a named persistent test session:

```powershell
npm run setup -- --backend cloud --role A --name webbrain-qa-actor
```

Omit A's session ID only for that explicit setup command. Selection is saved in
`session-A.private.json` in private artifacts; put its ID in `.env`. Setup and
close preserve the persistent session. Sessions and runs are billable; limits
apply, and ambiguous creation is never retried automatically. If setup loses
its response, the private setup ledger retains its request ID/name/time. Select
the matching session from your Cloud dashboard, then reconcile it without
creating another session:

```powershell
npm run reconcile-setup -- --backend cloud --role A --request-id SAVED_REQUEST_ID --session-id CONFIRMED_SESSION_ID
```

This checks the original name, creation time and normal profile. Run doctor
with that explicitly configured session afterward. Both selected and
harness-created persistent sessions remain available; session deletion is an
explicit operator action through the Cloud dashboard. Workflow cleanup never
deletes a session.

Readiness requires both `status=ready` and `runtime_ready=true`. The public API
does not attest a runtime build/version; doctor reports unknown and configured
strict Cloud build pins block. Existing-session provider/model selection and
introspection are not exposed here: configure them through normal Cloud browser
Settings and leave the role provider/model pins empty. Requested Cloud pins
report unsupported rather than being silently ignored. Repository HEAD is never reported as the Cloud
build. Configure `manualActorIdentityVerified:true` only after checking A's
actual login in the chosen browser; the string `"false"` is not confirmation.

Cloud REST has no documented DOM/control endpoint. A separate logged-in local
B can independently prove incoming mail/messages and shared access in the
separate receiver stages. Every A stage requires explicit actor-tab manual
evidence, including sends, replies and cleanup, so captured message/thread IDs
belong to A's account. Without it, preflight reports unsupported before dispatch.
Automated active steering/checkpoints are also unsupported on REST alone.
Finished-run `/messages` continuation is not active-run steering.

For manual verification set `manualEvidenceFile` to an ignored private JSON
file and run in an interactive terminal. A noninteractive CLI with no manual
observer callback is blocked before any actor task. Each checkpoint writes a private
requirement file with the exact run marker, stage, expected body/account/resource.
Observe the actual browser and append evidence to `{ "observations": [...] }`.
Rows use the same `webbrain-authenticated-evidence/1` schema as DOM observations,
`source:"manual-confirmed-private"`, `confirmedByOperator:true`, a timestamp in
`confirmedAt`, the exact `site`, `stage`, `marker`, `url`, account
`identity:{matched:true,actual:...}`, and phase-specific evidence. Composer
proof needs one exact marked unsent composer; item proof needs exact body,
author, recipient and canonical ID; deletion needs exact-resource removal proof.
A placeholder-only template is in `manual-evidence.example.json`.
The schema and graders are in `sites.mjs` and `scenarios.mjs`.
Model output is not manual evidence. Reports identify this verification layer.

Cloud upload verifies dummy-file bytes and uses a browser path only when
`browser_ready` is exactly true. Downloads are verified by independent bytes and
SHA-256, not by filenames or the agent's claimed checksum.

## Scenario matrix

| Scenario | Actions and independent checks | Known boundaries |
|---|---|---|
| `x-post-lifecycle` | Compose, atomic replacement, saved draft, PNG, post, refresh, exact deletion | Saved state needs native evidence; live selectors unverified |
| `bluesky-post-lifecycle` | Compose/replace, PNG, publish, refresh, exact deletion | Saved drafts not claimed for the current web client |
| `mastodon-post-lifecycle` | Compose/replace, PNG, publish, refresh, exact deletion | Explicit instance; current account setting controls confirmation/direct delete |
| `whatsapp-conversation` | Bound contact, exact text/file, B incoming receipts, individual cleanup | Positive own-account/peer identity and stable message IDs required |
| `telegram-conversation` | Bound peer, exact text/file, B incoming receipts | Row disappearance cannot prove deletion; cleanup stays pending without exact proof |
| `gmail-test-thread` | Draft/replacement/reopen, attachment, B receipt, reply, forward, individual Trash | Full From/To and immutable message/thread IDs required |
| `protonmail-test-thread` | Same test-thread lifecycle through native UI | UI/editor layout may require explicit selector bindings |
| `drive-file-lifecycle` | Own folder, upload, rename, Viewer share, B access, A download/hash, exact Trash | B download is not claimed; inaccessible file/resource bytes block verification |

All live selectors are provisional until exercised against the selected real
accounts. The driver never swaps a live failure for a fixture success. An
unsupported feature is not an empty successful test.

DOM observers open only an exact marked mail subject and expose its own header
details. They refuse wrong accounts, multiple candidates and prefix matches;
they do not click send/delete controls. `{marker}` in an explicit observer URL
is substituted for the current unique run marker, useful for a marked search.

## Monitoring and recovery

Configure interventions by `scenario-id:stage-id` in private JSON. Each needs a
selector/state checkpoint and the explicit operator action. For example:

```json
{
  "interventions": {
    "x-post-lifecycle:replace-body": {
      "kind": "scroll",
      "checkpoint": { "selector": "[data-testid=tweetTextarea_0]", "state": "visible" },
      "selector": "[data-testid=tweetTextarea_0]"
    }
  }
}
```

This example is a configuration pattern, not a verified current X selector.
Available actions include native click/type/scroll/selection/navigation,
draft changes, steering/narrowing, Stop, draft-only Stop/Continue, upload cancel
through its explicit cancel control, and waiting for a prearranged passive update
via `updateCheckpoint`. No arbitrary timed sleep triggers the intervention.
Steer/narrow/cancel needs an explicit `expectedBody` containing `{marker}`.
Corrections update the body expected by the paired receipt. Cancellation is
limited to an unsent compose/edit stage, with `expectedPhase:"composer"` and
`finishAfterStage:true`; consequential stages cannot be downgraded to draft
success. Post-publication correction/replacement is covered by the owned
shared-guard fixture; a general live replacement intervention is not claimed.
Recorded checkpoints show when input occurred; an unchanged expected-body
workflow must still end with the originally authorized content.

Descriptors from `list` document broader recovery scenarios. Provider/observation
fault injection and uncertain post-dispatch recovery are exercised in owned
fixtures, not injected into personal-account traffic. A configured Cloud
intervention without a controller blocks before starting a run. Post-dispatch
Stop/Continue remains a fixture case; live automatic Continue is restricted to
unsent draft stages.

## Reconciliation, cleanup and privacy

Every attempt is written before dispatch. Independently owned canonical IDs
remain journaled when attachment quality or duplicate-effect checks fail. IDs and exact independently observed
resource ownership are saved immediately. A lost acknowledgement, failed proof,
or unfinished cleanup leaves a pending ledger and blocks another suite for the
same configured scope. Shared private execution locks also bind the selected
profile/CDP endpoint/Cloud session independently of permissions, account scope,
worktree and artifact directory. A changed allowlist cannot acquire the same
browser concurrently. Keep the original configuration for recovery. Session locks live in the primary
checkout's `website-tests/artifacts/.env.session-locks/` so linked worktrees also
coordinate pending effects; individual reports stay in this checkout's
`website-tests/artifacts/`. The suite writes no durable session-lock files to
OS temporary storage.
Do not solve that condition by rerunning or changing the account configuration.

Inspect the report and run `reconcile`. If a Cloud creation response was lost,
select the matching dashboard run explicitly:

```powershell
npm run reconcile -- --report RUN_DIRECTORY --request-id RECORDED_REQUEST_ID --run-id CONFIRMED_RUN_ID
```

Local shutdown saves exact terminal extension receipts in the private ledger
before closing actor tabs. Recovery can use those receipts after the live tab
journal has been deleted, and still requires independent effect evidence. If a
receipt cannot be saved or the run is still active, shutdown retains the browser
and its tabs for reconciliation.

Reconciliation reads existing runs/effects and never resends. An ambiguous Cloud
upload can be reconciled by its recorded byte hash and exact server filename;
use `--remote-name CONFIRMED_SERVER_FILENAME` if its upload response was lost. Cleanup operates
only on recorded immutable IDs, markers, accounts and conversation/thread scope.
It cannot empty an inbox/chat/folder, delete by position, or touch pre-existing
data. Missing ownership/absence proof leaves visible pending cleanup.

Artifacts default to ignored `artifacts/`. Summary JSON/Markdown
contain statuses, stages, runtime/observation timings, dispatch counts, and
content-free diagnostic events where the runtime exposes them; failure categories distinguish authentication/authorization, setup/backend,
verification/site layout and behavioral evidence. A missing selector is not
conclusive proof of a product regression. Reports contain no task bodies, credentials or unrelated
messages. Private ledger/checkpoint/fixture logs have restricted file modes where
the OS supports them. Windows directory ACLs still govern access. Raw live-page
screenshots/traces are not automatically saved because they may include unrelated
private content. The backend's explicit trace-export method is available to a
caller handling those private artifacts deliberately.

## Verification

```powershell
npm test
npm run test:installed
npm run run -- --target fixtures --scenario fixture-file-transfer
npm run run -- --target fixtures --scenario fixture-stop-continue-recovery
```

Deterministic tests cover configuration/scope, ownership, ambiguity, strict Cloud
readiness, bounded polling, journals, continuation, checksums, privacy and cleanup.
DOM fixtures test the eight real observers and the complete planner/runner/grader
pipeline. Installed smoke exercises normal MV3 Ask through an actual accessibility
read and proves that CDP detachment preserves Chrome. Installed fixture packs use
scripted loopback providers and owned websites; they do not certify live accounts.
Doctor separately reports local native account-identity checks for the selected
sites. Cloud doctor cannot inspect login identities and reports the manual
observation requirement. Noninteractive local setup returns pending input.
Live cases are intentionally absent from both this directory's `npm test` and
the repository's ordinary test/CI runs.

## Results verified during implementation

After relocation, the root alias passed 230 harness/layout tests with zero
failures (one opt-in smoke skipped). Running `npm run test:installed` inside
this directory passed all 34 checks, and `npm run run -- --target fixtures
--scenario fixture-file-transfer` passed with its report under `artifacts/`.

Before the directory move on 2026-10-12, the harness test command passed 226 tests with zero failures
and one opt-in installed smoke skipped. The installed check command
passed all 34 checks, including that real smoke. The six CLI fixture packs
listed below passed. The installed extension reported version 40.4.1 and the
four-file runtime fingerprint
`e516ebbc51e7780e0da851348b35539253ceb4df88343fe8ba7c7c830dab6581`.
Repository source revision was
`6c451849f5bff6be88a92c3fd442375537ad8f84`; harness changes were uncommitted.

| Path | Evidence | Status |
|---|---|---|
| Harness configuration, backends, journals, grading and recovery | Deterministic tests including mocked documented Cloud responses | Verified locally |
| Eight website observers and planner/runner integration | Owned Chromium DOM fixtures; seven complete cleanups, Telegram intentionally pending | Verified fixture behavior |
| Installed local WebBrain | Real MV3 Ask, real accessibility read, installed four-file fingerprint, CDP detach preserving Chrome | Verified locally, version 40.4.1 |
| Installed shared guards, chat intervention, Stop/Continue, transfers, Mastodon confirmation/direct delete | Six existing owned MV3 fixture packs through CLI | Verified locally |
| Authenticated local website flows | Needs explicitly selected logged-in test accounts and scopes | Unverified; no external mutations made |
| Deployed Cloud flows, mixed actor/observer accounts | Needs API keys, explicit ready persistent sessions and manual actor evidence | Unverified; API contract tested with mocks |
| Firefox attachment, REST-only active intervention, opaque mail iframes | Not supported by this driver | Unsupported |

Example sanitized report shape (illustrative, not live-site evidence):

```json
{
  "schema": "authenticated-summary/1",
  "target": "live",
  "counts": { "passed": 0, "failed": 0, "blocked": 0, "unsupported": 1, "needs_user_input": 0 },
  "results": [{ "scenario": "x-post-lifecycle", "backend": "cloud", "status": "unsupported", "stage": "preflight", "code": "cloud_private_phase_requires_manual_evidence", "cleanup": "not_started" }]
}
```

Observer copies of received mail/messages are read-only in this initial suite.
Actor cleanup targets its individually recorded test items; receiver-side
cleanup needs a separately authorized WebBrain actor/controller and is not
claimed. Telegram does not expose dependable exact-message deletion proof to
this observer, so a row disappearing leaves cleanup pending rather than passing.
Drive uses an existing explicitly allowlisted test folder, renames the created
file, and verifies its bytes; creating folders or editing document contents is
not part of this initial file scenario.

## Adding a website

Add one site definition/read-only identity and evidence extraction in
`sites.mjs`, and concrete natural-language stages in
`scenarios.mjs`. Give destructive stages a captured immutable resource key.
Add owned DOM examples in `sites.test.mjs` and a complete pipeline example in
`runner-integration.test.mjs`; then add placeholders and a row to this matrix.
Re-use these two execution adapters and the shared repository
`../ci/lib/webbrain-client.mjs`. Owned installed-extension fixture packs remain
shared under `../test/quality/`; the launcher supplies repository source paths
and directs their evidence into this suite's ignored `artifacts/`.
A site-specific observer may prepare a read-only view, but it must never perform
the task's send/post/share/upload/delete action. Missing identity, native IDs,
receipts or browser capabilities must remain explicit blocked/unsupported cases.
