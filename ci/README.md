# WebBrain Cloud E2E

`ci/` runs catalogued browser-agent scenarios in a fresh WebBrain Cloud
incognito browser. Each scenario produces a structured result, exported trace,
deterministic rubric, optional `.webm` recording, and a suite summary.

The suite intentionally limits public-site coverage to read-only tasks.
State-changing scenarios use the resettable Gnippets challenge lab owned by this
project; they never touch production members or content.

## Packs

| Pack | Coverage |
|---|---|
| `cloud-smoke` | Ask-mode Wikipedia and NYTimes reads, a short YouTube download, plus the isolated disposable-email, Turnstile, and OTP signup chain |
| `public-readonly` | Wikipedia navigation, linked-page reasoning, table extraction |
| `gnippets-readonly` | Public Gnippets developer/skill discovery |
| `gnippets-spa` | Hydration, auth, prompt-injection resistance, search races, optimistic rollback, Shadow DOM, iframe, virtual list, modal portal, persistence |
| `gnippets-captcha` | Standalone authorized Turnstile solve on the owned challenge lab |

## Run locally

```powershell
$env:WEBBRAIN_API_KEY = "..."
$env:GNIPPETS_E2E_CONTROL_TOKEN = "..."
$env:CAPSOLVER_API_KEY = "..." # required by cloud-smoke signup and gnippets-captcha
npm run ci:e2e -- --pack cloud-smoke --no-video
```

Useful commands:

```powershell
npm run ci:e2e:dry
npm run ci:e2e -- --scenario gnippets-spa-dom-gauntlet --no-video
npm run test:ci
```

Optional configuration:

- `WEBBRAIN_BASE_URL` defaults to `https://webbrain.cloud`.
- `GNIPPETS_BASE_URL` defaults to `https://gnippets.com`.
- `--concurrency N` defaults to 2.

Artifacts are written beneath `ci/artifacts/<timestamp>/` and ignored by Git.
The GitHub Actions workflow uploads that directory even when a scenario fails.

## Gnippets deployment

The sibling Gnippets app must explicitly enable its challenge lab:

```dotenv
GNIPPETS_E2E_ENABLED=true
GNIPPETS_E2E_CONTROL_TOKEN=replace-with-a-long-random-secret
GNIPPETS_E2E_TTL_SECONDS=3600
```

The control token is used only for create/inspect/delete lifecycle calls. The
browser receives a high-entropy run capability URL. State is file-backed,
expires automatically, and is separate from the application database.

The signup checkpoint sends a real six-digit OTP to the supplied inbox after
Turnstile succeeds, but stores only hashes and expiring fixture state. Its CI
artifacts are intentionally sanitized: no video, raw trace, disposable inbox
credentials, password, message body, or OTP is uploaded. The sanitized trace
retains only the Mail.tm request origin, first path segment, method, and matching
response success/status needed to prove that the disposable-account and inbox
APIs were actually exercised successfully.

## Rubric

Scenarios are graded from three independent signals:

1. WebBrain run status and schema-valid `done_json` output.
2. Expected structured-result values and final host.
3. For Gnippets challenge runs, server-observed events such as
   `login_succeeded`, `post_created`, or `captcha_solved`.

Failures include a `stuck_at` stage (`setup`, `planning`, `navigation`,
`execution`, `user_handoff`, `verification`, `artifact_capture`, or `cleanup`) so the
summary answers both “what passed?” and “where did it stop?”.
