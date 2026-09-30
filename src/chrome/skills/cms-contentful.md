# Contentful content (API-first)

Entries, localized fields, links, drafts and publication in existing Contentful content models via CMA.

```webbrain-skill
{
  "summary": "Entries, localized fields, links, drafts and publication in existing Contentful content models via CMA.",
  "modes": [
    "ask",
    "act",
    "dev"
  ],
  "intents": [
    "cms_content_management",
    "contentful_content"
  ]
}
```

## API-first decision and permission boundary

Use this recipe only for the user's content task on an identified CMS, including
custom domains confirmed by observed admin UI and official API evidence. Prefer
`fetch_url` after read-only discovery when the API supports every required field,
the site/account and target are known, usable authentication and CMS rights exist,
the task authorizes the change, WebBrain API mutation permission is active, and
the run is Act/Dev. Do not wait for the editor to fail.

If only WebBrain mutation permission is missing, request `/allow-api` once.
Reuse prior valid permission (conversation or persistent setting); after refusal,
do not ask again for the same request: use the permitted editor route. Task
authorization, `/allow-api`, and CMS credentials/roles are separate conditions.
Ask is read-only even with prior API approval. All POST/PUT/PATCH/DELETE requests
through `fetch_url` remain gated, including read-only GraphQL/query POSTs. Do not
encode a mutation in GET, use private endpoints, `execute_js`, or another tool to
bypass a denial. Describe consequential requests with secrets omitted.

Manage existing content models only. No schema/model changes, plugin or theme
installation, site design/settings, users/roles, app grants, payments, orders,
customers, subscriber mail, bulk releases or deployments. A content task does not
authorize enabling API writes or creating credentials. Explain missing setup and
use an existing permitted UI surface first.

## Tools, secrets and trace limits

This is an instruction-only recipe, with no new tools, OAuth flow, token signer,
credential store or auth broker. `fetch_url` accepts `url`, `method`, string-valued
`headers` and a serialized JSON `body`. It runs in the extension background;
cookies attach only within the active tab's registrable domain and still obey
browser cookie rules. That is not proof of session authorization on an API.
Do not copy cookies or scrape localStorage/network tokens. Origin/Referer are
browser-controlled: merely putting them in headers does not guarantee success.

Use HTTPS at the verified API origin, including its site/project binding. Never
send auth to a guessed host, user-content URL, HTTP downgrade or redirect target.
The tool rejects redirects before following them; rediscover the canonical root
without secrets rather than forwarding headers. Existing opaque same-origin
`replayRequestId` material is usable only when the runtime actually offers it and
its captured operation fits this task; it is not a general auth mechanism.

Tokens/nonces typed in chat, placed in tool arguments, or returned by a discovery
request can enter the configured model conversation and enabled raw traces.
There is no guaranteed secret injection/redaction path for arbitrary CMS headers.
Never store secrets in skill text, scratchpad, memory, URLs or summaries. With
Strict Secret Handling, if browser-managed cookies or an already available opaque
mechanism cannot complete the request, use UI. Do not automatically ask to disable
that setting. All examples below contain placeholders, never usable credentials.

`fetch_url` returns bounded `json`/`text` strings, not a parsed object; read all
necessary fields using exact `nextOffset` continuation on **GET reads**. Never
repeat a write just to paginate its response: read the returned record through
the documented read/query route instead.
Generic response headers such as ETag and Retry-After are not exposed (only safe
range/length metadata). Use version fields in JSON when offered; if a required
header-only precondition is inaccessible, use the editor instead of inventing it.

## Scope and API/auth prerequisites

Use Content Management API (CMA), `https://api.contentful.com`, or
`https://api.eu.contentful.com` for the verified EU region. Root per task:
`/spaces/<SPACE_ID>/environments/<ENVIRONMENT_ID>`. Explicitly resolve any
environment alias before mutation; do not assume `master`. Delivery API
(`cdn.contentful.com`) and Preview API (`preview.contentful.com`) are read-only
and their API keys cannot mutate CMA content.

Use an existing personal/OAuth management access token in
`Authorization: Bearer <CMA_TOKEN>`; the token's user must already have access to
the space/environment/content type and the operation (including publish rights).
Use `Content-Type: application/vnd.contentful.management.v1+json`.
The app.contentful.com browser session is not a CMA credential. Do not create a
token, consent to OAuth, change a role or configure a new environment. Strict
Secret Handling requires UI if no already available opaque auth path works.

## Discover and read

1. Confirm space/environment/region. GET the environment's `/content_types` and
   `/content_types/<TYPE_ID>` for existing field definitions, validations,
   required/localized flags and reference target restrictions. Do not create,
   activate or modify a model to make content fit.
2. GET `/locales` for configured language codes and fallback/default rules; only
   manage entry values in these locales, never the locale configuration itself.
3. GET `/entries/<ENTRY_ID>` through CMA. It returns localized and unpublished
   fields; read the **complete** `fields` and applicable `metadata` before a PUT.
   Capture `sys.id`, `sys.contentType`, `sys.version`, publication/archive fields,
   and locale publishing metadata when available. Resolve referenced entries and
   assets as needed without assuming every reference is already published.
4. Match taxonomy/reference names to existing entry IDs or metadata tag/concept
   IDs in their actual model. Do not confuse editorial taxonomy entries with
   Contentful metadata tags or taxonomy configuration. Creating a new editorial
   taxonomy entry requires task scope and an existing type; schema/configuration
   changes are outside this recipe.

## Draft, update and publish

New entries are drafts. Use `POST /entries` with
`X-Contentful-Content-Type: <TYPE_ID>` and fields keyed by the actual locale:

```json
{"fields":{"title":{"en-US":"<TITLE>"},"body":{"en-US":{"nodeType":"document","data":{},"content":[]}}}}
```

This example assumes title and Rich Text body fields and `en-US`; substitute the
real schema/locales and complete Rich Text nodes before writing. Do not invent
fields. Save the returned entry ID/version. An alternative documented create is
`PUT /entries/<CHOSEN_ID>` with the content-type header: preselect a unique ID,
record it, and check it after uncertain responses instead of selecting a new ID.

Update the same entry with `PUT /entries/<ENTRY_ID>` and
`X-Contentful-Version: <LAST_READ_SYS_VERSION>`. CMA PUT does **not** merge the
entry: send all retained writable `fields` and `metadata`, changing only the
requested fields/locales. Never include read-only `sys` as writable content.
Alternatively use documented JSON Patch with its content type and version header;
operations on an unset field need the complete field subobject at an existing
parent path. Do not use JSON Patch as a reason to skip reading the record.

On a version mismatch/409, GET again and reconcile concurrent changes. Do not
blindly substitute the newer version header and resend an old full body. Normal
updates to published entries leave the existing published version available while
recording pending edits; do not unpublish to make a draft. Re-read the saved entry
and verify its complete locale/link data before deciding to publish.

For requested entry-level publication, `PUT /entries/<ENTRY_ID>/published` with
the **newly read** `X-Contentful-Version`. Required fields/linked assets may block
publication; report them instead of publishing unrelated records automatically.
Publication includes all pending entry changes, not only the field just edited;
verify that scope. Locale-based publication is plan/setup dependent (currently
Premium/Enterprise) and uses documented `add.fields` locale selection. Do not
promise single-locale publication on an entry-level space; use UI or clarify the
broader effect before proceeding. Never change publishing mode or buy a plan.

Rich Text is a JSON document with embedded entry/asset link nodes. Preserve node
types, marks, data, links and all other locales; a localized plain string is not a
replacement for a Rich Text document. Link values use `sys.type:Link`, `linkType`
and `id`; keep their target types and order. Use UI for unsupported custom editors
whose native representation cannot be preserved through CMA.

## Contentful-specific recovery and editor

Reconcile timeouts by the known/chosen ID and version/publication state. If a
random create ID was lost, query a unique field within the content type and locale
and creation window; multiple matches require clarification. `sys.publishedAt`
alone can describe an older publication: compare `sys.publishedVersion` and
`sys.version` (ordinary entry-level published-with-no-changes has
`version == publishedVersion + 1`), or locale `fieldStatus` when applicable.
Check the delivered intended version and public URL separately. Rate-limit headers
are not exposed by `fetch_url`; use bounded later reads, no uncertain write loop.
Fallback to the observed entry editor retaining space, environment, ID and locale.
Do not trigger a front-end deployment or a release/bulk publish.

## Recovery, verification and UI fallback

Keep a non-secret operation receipt: API origin, site/project scope, content type,
locale, record ID (and draft/published mapping), revision, intended fields and
whether a mutation was dispatched. Read before editing; change only requested
fields and preserve all others and their relations. A partial/truncated read is
not enough to replace rich content. Never silently drop unsupported fields or
convert rich text lossily. Do not demote/unpublish a live record to simplify an
edit. If the API has no safe draft route, use UI instead of direct public create.

A timeout or disconnected response can follow a successful write. Do not blindly
repeat create/publish, even with a new ID. Investigate the known ID first; otherwise
use the service's bounded exact queries plus type, locale, parent, slug and time.
Multiple candidates are ambiguous: ask for the target, never pick one randomly.
Resume the existing draft/partial update. Use a documented idempotency mechanism
only where the endpoint supports it; do not invent an Idempotency-Key header.
Reconcile partial success **before** moving to UI. Stop repeated 401/403 requests;
explain missing auth/rights. Re-read on revision conflicts; never force overwrite.
For 429/temporary failures, follow service guidance with bounded backoff; when
headers are not exposed report that limit, and do not retry an uncertain mutation
until its outcome is reconciled. Compact cannot wait/schedule: report partial and
let the user resume later when waiting is necessary.

After create/update, read the same record through its supported read/query API.
Verify type, all requested fields, language, relationships/taxonomy, rich content
and draft status. A draft-only task
stops here. Publish only the same verified content when the user requested it;
account for live effects of edits and pending changes already in the draft.
After publish, re-read the publication state and, where possible, inspect the
actual target URL for the intended content. HTTP success alone proves neither
content correctness nor publication. Report “published in CMS” separately from
“visible on the website,” especially for headless sites. Never trigger a deploy,
site-wide publish or subscriber email to make content appear.

When the API cannot carry required fields or safe auth, open the **observed** CMS
editor for this same record. Preserve ID/type, language, content, taxonomy and
required URL parameters. Try an existing Code/Text or standard editor surface if
iframe/canvas access fails; refresh AX refs after switching. Do not repeatedly
read an inaccessible editor. A guessed URL/editor parameter is not proof that an
alternative exists or a save/publish worked. Verify persisted content and status
after UI actions too. If neither route is usable, report the existing partial
record and precise blocker without claiming completion.

## Official sources (reviewed 2026-09-30)

- [CMA overview, auth, full replacements and version locking](https://www.contentful.com/developers/docs/references/content-management-api/overview/)
- [Entries and locale publishing](https://www.contentful.com/developers/docs/references/content-management-api/entries/)
- [Create draft entry](https://www.contentful.com/developers/docs/references/content-management-api/entries/create-an-entry/)
- [Publish an entry](https://www.contentful.com/developers/docs/references/content-management-api/entries/publish-an-entry/)
- [Content types](https://www.contentful.com/developers/docs/references/content-management-api/content-types/)
- [Locales](https://www.contentful.com/developers/docs/references/content-management-api/locales/)
- [Authentication distinctions](https://www.contentful.com/developers/docs/references/authentication/)
