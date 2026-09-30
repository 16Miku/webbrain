# Sanity content (API-first)

Schema-preserving Content Lake documents, references, drafts and publication through official Mutation/Actions APIs.

```webbrain-skill
{
  "summary": "Schema-preserving Content Lake documents, references, drafts and publication through official Mutation/Actions APIs.",
  "modes": [
    "ask",
    "act",
    "dev"
  ],
  "intents": [
    "cms_content_management",
    "sanity_content"
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

Use the project's non-CDN API:
`https://<PROJECT_ID>.api.sanity.io/v2025-02-19` (or a verified supported later
dated version), with the exact dataset and existing schema. Do not use the
read-cache `apicdn.sanity.io` host for writes or confuse document Actions with
paid AI Agent Actions. The reviewed Actions workflow requires 2025-02-19 or later;
do not use `vX` or today's date as an unverified API contract.

Requests require existing authenticated read/write access to the dataset and
document type, commonly a scoped bearer token (`Authorization: Bearer <TOKEN>`).
Sanity also supports user session authentication in supported browser contexts,
subject to cookie/CORS configuration; an arbitrarily hosted Studio cookie is not
automatically available to `<PROJECT>.api.sanity.io`. Background `fetch_url`
only attaches same-registrable-domain cookies, and cannot create a sanctioned
Studio SDK session or CORS grant. Use only a verified existing auth route; do not
scrape Studio tokens, install a client, change CORS, or add roles. Private datasets
and drafts need authorized reads; public published GROQ access proves no write
right. With Strict Secret Handling, use Studio when secure opaque auth is absent.

## Discover and read

1. Confirm Studio workspace, project ID, dataset, API version, schema types and
   required fields from existing trusted project information and the observed
   editor. Content Lake is schemaless at storage level: sample documents are not
   a complete schema, and mutations do not guarantee Studio validation. If the
   schema cannot be established, edit through Studio instead of guessing fields.
2. GET `/data/doc/<DATASET>/<ID>` for an exact document, or URL-encoded GET
   `/data/query/<DATASET>?query=<GROQ>&perspective=raw` for exact IDs. `raw` exposes
   distinct draft/published documents when authorized; default published
   perspective can hide a draft. Record `_id`, `_type`, `_rev`, `_updatedAt`,
   the full content, reference targets and any schema-specific language field.
3. Published ID `<ID>` and draft `drafts.<ID>` belong to the same logical item.
   Read both before editing/publishing. A `versions.<RELEASE>.<ID>` document is
   release-scoped and cannot be treated as a normal draft; releases are outside
   this task. Do not publish an entire release as an item workaround.
4. Resolve taxonomy documents and assets by their exact `_id`/`_type`; preserve
   `_ref`, `_weak`, array `_key` values, order and cross-dataset project/dataset
   bindings. Language may be a field or a separate linked document: follow the
   existing schema, never invent a universal locale parameter or alter i18n setup.

## Draft, update and publish

Choose a unique stable logical ID and record `drafts.<ID>` **before** creation.
The documented Mutation endpoint is `POST /data/mutate/<DATASET>`; a draft create
body is:

```json
{"mutations":[{"create":{"_id":"drafts.<UNIQUE_ID>","_type":"<EXISTING_TYPE>","title":"<TITLE>"}}]}
```

Include actual schema-required content, not just the illustrative title. A create
collision must trigger a read/reconciliation, not `createOrReplace`. GET the exact
draft and check all fields. Where using the official Actions create workflow,
verify its version-specific input; do not mix older client-only `attributes`
examples with the current HTTP `document` form.

For an existing draft, a targeted mutation is:

```json
{"mutations":[{"patch":{"id":"drafts.<ID>","ifRevisionID":"<LAST_READ_REV>","set":{"title":"<NEW_TITLE>"}}}]}
```

Keep `ifRevisionID` spelling and use the exact `_rev`; a revision mismatch is a
conflict to reconcile. Never use `createOrReplace` to overwrite a draft you have
not fully read. If only a published version exists, use the documented Actions
`sanity.action.document.version.create` with `publishedId:<ID>`, `baseId:<ID>`,
`versionId:drafts.<ID>` to stage its existing content (after checking current
support), then re-read. Do not unpublish the original or copy only title/body.
Preserve live status: patching the published ID directly changes live Content Lake.

Publish only the same verified draft through
`POST /data/actions/<DATASET>` with this JSON body:

```json
{"actions":[{"actionType":"sanity.action.document.publish","draftId":"drafts.<ID>","publishedId":"<ID>","ifDraftRevisionId":"<DRAFT_REV>","ifPublishedRevisionId":"<PUBLISHED_REV>"}]}
```

Include the published revision guard when a published document exists; omit it
for a genuinely new item after verifying absence. Re-read both immediately before
publishing. Actions publish promotes draft contents and removes that draft; verify
the resulting published document, not just the transaction response. Do not use
a manual copy/delete sequence to emulate unsupported publication. Preserve
transaction IDs for reconciliation; this is not a blanket idempotency guarantee.

Portable Text is structured blocks/spans/marks with stable `_key` and `markDefs`,
plus custom blocks/assets. Keep them intact, along with slug objects, references
and localized objects. A string/HTML body is not equivalent. Match taxonomy to
existing reference IDs; creating a new taxonomy document uses its existing schema
and draft lifecycle only when task-authorized. No schema generation or AI Actions.

## Sanity-specific recovery and editor

After timeout, query the deterministic draft/published pair with `perspective=raw`
on the non-CDN origin and inspect `_rev`/content and any known transaction/history.
No arbitrary candidate selection and no new random ID for a retry. Re-read on
409; authenticated 401/403 is not a reason to change dataset visibility/CORS.
Use bounded verification for eventual query visibility, never repeated publishes.
If draftActions are disabled by schema or a custom publish action has required
business logic, use the observed Studio document action instead of bypassing it.
Keep workspace/dataset/document/language in its observed editor URL and refresh
refs after switching. Publishing to Content Lake does not deploy a consuming site.

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

- [HTTP authentication](https://www.sanity.io/docs/http-auth)
- [Query API](https://www.sanity.io/docs/http-reference/query)
- [Mutation API](https://www.sanity.io/docs/http-reference/mutation)
- [Actions HTTP reference](https://www.sanity.io/docs/http-reference/actions)
- [Draft/version and publish action workflow](https://www.sanity.io/docs/content-lake/dispatch-actions)
- [Transactions](https://www.sanity.io/docs/content-lake/transactions)
- [Revision conditions](https://www.sanity.io/plugins/javascript-api-client)
- [Portable Text](https://www.sanity.io/docs/portable-text)
