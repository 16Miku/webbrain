# Strapi content (API-first)

Existing Strapi content types, relations and supported Draft & Publish through the Content API.

```webbrain-skill
{
  "summary": "Existing Strapi content types, relations and supported Draft & Publish through the Content API.",
  "modes": [
    "ask",
    "act",
    "dev"
  ],
  "intents": [
    "cms_content_management",
    "strapi_content"
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

Use the **Content API**, not undocumented admin Content Manager endpoints. Confirm
the installed Strapi major version, actual API prefix/origin and existing model.
This recipe's concrete operations are Strapi 5 REST, normally
`https://<CMS_HOST>/api/<pluralApiId>` and `/api/<singularApiId>` for single types.
v5 uses `documentId` and flat `data` fields; v4 uses numeric IDs, nested attributes
and different publication semantics. Do not send a v5 body to v4; use verified
version-specific docs or UI for unsupported older behavior.

Use an existing scoped Content API token or authorized Users & Permissions JWT in
`Authorization: Bearer <TOKEN>`. Admin login/token and Content API roles are
different. Content types are private by default; read/create/update and relation
find rights must already exist. Do not change Public role rights, create a token,
call login to collect passwords, or use private admin endpoints. A read-only API
token cannot write. Custom auth middleware requires a documented existing setup.

## Discover and read

1. Confirm environment and exact plural/singular API IDs using the observed
   content manager, an already exposed official OpenAPI specification or trusted
   model information. Do not assume a generic Content API endpoint exposes every
   schema/required field. If the model cannot be established, use UI.
2. Check Draft & Publish and i18n for this specific type. If Draft & Publish is
   disabled, records have no safe draft lifecycle: use UI for new content instead
   of silently creating a public record. Do not enable the feature yourself.
3. GET `/api/<pluralApiId>/<DOCUMENT_ID>?status=draft&locale=<LANG>` and separately
   `status=published` if a live version exists. Use explicit `populate` for needed
   relations, media, components and dynamic zones, recursively where necessary.
   The default response omits these; even `populate=*` is not arbitrary deep
   population. Read related types with the necessary find permissions.
4. Preserve `documentId`, locale, `updatedAt`, published state, component IDs,
   dynamic-zone `__component` values and relation targets. The integer `id` of one
   locale/version row is not the logical document identity used by v5 URLs.

## Draft, update and publish

The REST API defaults to **published on writes**, unlike server-side Document
Service. Create a collection draft using
`POST /api/<pluralApiId>?status=draft&locale=<LANG>` with
`{"data":{"<TITLE_FIELD>":"<TITLE>","<BODY_FIELD>":"<SCHEMA_VALID_VALUE>"}}`.
Use actual model field names/types, all required fields and the confirmed locale.
Capture its `documentId`, then GET `status=draft` to verify `publishedAt:null`.

Update the same draft with
`PUT /api/<pluralApiId>/<DOCUMENT_ID>?status=draft&locale=<LANG>` and a `data`
object containing only intended changes. Single types use
`PUT /api/<singularApiId>?status=draft&locale=<LANG>`; read first because this route
can create when absent. Never POST a second collection document to “update” it.
Updating a draft leaves its already published counterpart in place.

Once the same draft is verified and publication is requested, use
`PUT /api/<pluralApiId>/<DOCUMENT_ID>?status=published&locale=<LANG>` with
`{"data":{}}` to publish the draft as-is under current v5 semantics (the single
type equivalent omits the documentId). Do not manually write `publishedAt` or
invent `/publish`; the server-side Document Service is not a browser HTTP tool.
Read the explicit published and draft versions afterward. A draft's null
`publishedAt` alone does not prove the whole document is unpublished.

Compare freshly read `updatedAt` and any site-provided version control before
writing; standard REST does not promise an atomic compare-and-swap token. If
there is a concurrent edit, reconcile or use UI instead of force-overwriting.
Do not modify a live record through the default published path when only a draft
edit was requested.

Relations use the documented `connect`/`disconnect` or replacement `set` syntax
with verified document IDs and locale context. `set` replaces relations: do not
drop existing members. Map taxonomy labels through the relevant existing type;
do not create taxonomy models. Content creation for an existing taxonomy type
follows its own required fields and draft support, only when task-authorized.
Preserve repeatable component IDs and dynamic-zone order. A rich-text field may
be Markdown or Blocks JSON, not interchangeable HTML. Use UI if full structured
content cannot be read and edited without loss.

## Strapi-specific recovery and editor

No general create idempotency key is guaranteed. Find a timed-out create using
known documentId or bounded `filters` by exact unique slug, locale and type; never
guess a documentId from an integer row ID. For uncertain publish, compare both
draft and published versions before retry. Treat inaccessible populated fields as
missing permission, not empty values. UI fallback uses the observed Content
Manager record and keeps the same document/locale. CMS publication may merely
update an API consumed by a separate front-end; do not trigger its deployment.

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

- [REST endpoints and v5 identities](https://docs.strapi.io/cms/api/rest)
- [Explicit draft/published write semantics](https://docs.strapi.io/cms/api/rest/status)
- [Locale](https://docs.strapi.io/cms/api/rest/locale)
- [Populate and select](https://docs.strapi.io/cms/api/rest/populate-select)
- [Relations](https://docs.strapi.io/cms/api/rest/relations)
- [API token rights](https://docs.strapi.io/cms/features/api-tokens)
- [Draft & Publish](https://docs.strapi.io/cms/features/draft-and-publish)
- [v4 REST reference](https://docs-v4.strapi.io/dev-docs/api/rest)
