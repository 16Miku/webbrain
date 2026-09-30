# Webflow content (API-first)

Collection items, references, locales, staged drafts and item publication through Webflow Data API v2.

```webbrain-skill
{
  "summary": "Collection items, references, locales, staged drafts and item publication through Webflow Data API v2.",
  "modes": [
    "ask",
    "act",
    "dev"
  ],
  "intents": [
    "cms_content_management",
    "webflow_content"
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

Use the stable Data API v2, `https://api.webflow.com/v2`, for content in existing
CMS collections. Do not use Designer/private editor endpoints or a v1/beta recipe
without checking its separate contract. A site token or existing OAuth access
token in `Authorization: Bearer <TOKEN>` needs `cms:read`, `cms:write`, and
`sites:read` for site discovery. Dashboard/custom-domain editor cookies do not
authenticate this API. Do not create a token, OAuth integration or new scopes.
API, CMS and localization availability/limits depend on the site's plan and setup.

## Discover and read

1. `GET /sites` and `GET /sites/<SITE_ID>` establish the authorized site, public
   domains and locale metadata. A custom public domain is not the API host.
2. `GET /sites/<SITE_ID>/collections`, then `GET /collections/<COLLECTION_ID>`
   for exact field slugs/types, required fields and reference target collections.
   Read `GET /collections/<COLLECTION_ID>/items/<ITEM_ID>` with the intended
   `cmsLocaleId` and inspect staged data and publication metadata. Read the live
   counterpart under `items/<ITEM_ID>/live` where available for comparison.
3. Map reference/multi-reference labels to existing item IDs in their target
   collections. Preserve their order/cardinality; do not recreate referenced
   categories. Record the site's CMS locale IDs, not only a display language tag.
   If the requested localization is unavailable, use UI or report the limitation.

## Draft, update and publish

Create through the staged endpoint, not `/items/live`. The v2 single-item request
to `POST /collections/<COLLECTION_ID>/items` takes a body like:

```json
{"isDraft":true,"isArchived":false,"fieldData":{"name":"<TITLE>","slug":"<SLUG>","<BODY_FIELD_SLUG>":"<VALID_RICH_TEXT_HTML>"}}
```

Include the endpoint's supported CMS locale selector after checking the site:
the current Create Items endpoint `/items/insert` accepts an `items` array
with `cmsLocaleIds` per entry. Verify this shape against the supported API; do not
substitute a legacy `/items/bulk` recipe. Do not mix singular/plural locale
fields or infer every locale should be created. Prefer a single verified target
locale and save its returned item ID and `cmsLocaleId`. Set `skipInvalidFiles=false`
when the chosen endpoint supports it to avoid silently dropping invalid media.

Update only the intended item using
`PATCH /collections/<COLLECTION_ID>/items/<ITEM_ID>` with changed `fieldData`
and `cmsLocaleId` in the JSON body (the GET locale selector is a query parameter).
Preserve unrelated fields, references, archive and live state. Staged updates do
not mean a live item was updated. For an already published item, `isDraft:true`
holds changes in draft while its live version stays published; it does not
unpublish the item. Use that state only for the requested staging intent.
`isDraft:false` queues changes for the next site publish, so never flip it
casually. Inspect current staged/live state before selecting a status operation.

Read `lastUpdated` and publication metadata again before writing. These timestamps
are not a documented atomic `If-Match` guard. If another editor changed the item,
reconcile; do not overwrite. Use an API precondition only if explicitly supported
and available through the tool, otherwise UI for workflows needing atomic locking.

Keep rich-text HTML, embedded `<wf-component>` instances and their valid component
IDs/property encoding intact. Preserve image/file references and metadata. Do not
flatten components or silently omit a collection field the API cannot represent.

For requested publication, GET and verify the staged item, then
`POST /collections/<COLLECTION_ID>/items/publish`, body
`{"itemIds":["<ITEM_ID>"]}` for a single locale. For localized publication use
the documented `items` form with each `id` and its explicit `cmsLocaleIds`, after
checking the endpoint schema. Publishing a draft sets `isDraft:false`; it does
not require separately queueing it for a site-wide publish. Inspect both
`publishedItemIds` and per-item `errors` (HTTP 202 can be partial), then read
staged/live objects and the intended public URL. Never call the site publish API.

## Webflow-specific recovery and editor

An uncertain create must be reconciled by ID, or paginated collection items
matched by exact slug/name, collection, locale and time; no generic idempotency
header is promised. A batch can partially succeed: keep each returned ID instead
of recreating the whole batch. For a 429, respect documented API rate guidance;
the tool cannot expose Retry-After, so do not fabricate it. If API access or a
custom field is unavailable, use the observed CMS collection item editor and
save/publish that same item only. A successful item publish is not permission
for Designer or site-wide changes; verify actual visibility independently.

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

- [Authorization](https://developers.webflow.com/data/reference/authorization)
- [Scopes](https://developers.webflow.com/data/reference/scopes)
- [Create staged item](https://developers.webflow.com/data/reference/cms/collection-items/staged-items/create-item)
- [Create items and locale choices](https://developers.webflow.com/data/docs/working-with-the-cms/create-items)
- [Update staged item](https://developers.webflow.com/data/reference/cms/collection-items/staged-items/update-item)
- [Publish items](https://developers.webflow.com/data/reference/cms/collection-items/staged-items/publish-item)
- [Components in rich text](https://developers.webflow.com/data/docs/working-with-the-cms/components-in-rich-text)
- [Rate limits](https://developers.webflow.com/data/reference/rate-limits)
