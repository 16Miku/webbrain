# Drupal content (API-first)

Articles, pages, existing custom bundles and taxonomy through Drupal JSON:API.

```webbrain-skill
{
  "summary": "Articles, pages, existing custom bundles and taxonomy through Drupal JSON:API.",
  "modes": [
    "ask",
    "act",
    "dev"
  ],
  "intents": [
    "cms_content_management",
    "drupal_content"
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

Use core JSON:API on an existing Drupal site. Discover its actual root, normally
`https://<SITE>/<OPTIONAL_BASE>/jsonapi`, from observed site links and responses;
there is no generic `/v1` suffix. JSON:API may be disabled, read-only or customized.
Do not enable modules or change `/admin/config/services/jsonapi`. Public GET access
does not imply write rights: entity, bundle, field, text-format and moderation
permissions still apply to the current user.

An existing same-site session can work with cookie auth; mutable requests need
`X-CSRF-Token: <SESSION_TOKEN>` retrieved by `GET /session/token` at that same
installation. The token is session-bound and the read exposes it to model/trace;
under Strict Secret Handling use UI unless an existing opaque path works. Basic
or OAuth access is conditional on an already enabled auth provider and existing
authorized credential. Do not install Basic Auth/Simple OAuth or assume an admin
cookie works after moving to a different API domain. Use
`Accept` and `Content-Type: application/vnd.api+json`.

## Discover and read

1. GET the JSON:API root; follow its verified same-site resource links. Core uses
   `/node/article`, `/node/page`, `/node/<BUNDLE>` and
   `/taxonomy_term/<VOCABULARY>`, with resource types such as `node--article`.
   Do not infer custom fields/required fields from bundle names. Use existing
   records, the observed content form and documented site-specific schema.
2. GET `/jsonapi/node/<BUNDLE>/<UUID>` and relevant `include` relations. IDs are
   UUIDs, not the numeric node ID in the UI. Retain both when known so fallback
   opens the same node. Capture `changed`, revision metadata, moderation state,
   `langcode`, `status`, body/summary/format and relationship resource identifiers.
3. Negotiate the intended language through the site's existing mechanism (often
   a language prefix); verify returned `langcode` rather than assuming URL locale.
   Core can update an existing translation and create a new entity with a chosen
   language, but does not generically create additional translations of an entity.
   Use its UI for unsupported translation creation; do not install a module.
4. Lookup vocabulary terms with collection filters such as `filter[name]=<NAME>`;
   retain vocabulary/type and UUID. Paginate and disambiguate names/parents.

## Draft, update and publish

For an unmoderated article whose required fields have been confirmed, a create
request is `POST /jsonapi/node/article` with the following JSON body (substitute
the actual allowed format and language):

```json
{"data":{"type":"node--article","attributes":{"title":"<TITLE>","langcode":"<LANG>","status":false,"body":{"value":"<HTML>","format":"<ALLOWED_FORMAT>","summary":"<SUMMARY>"}}}}
```

Moderated bundles require their supported initial `moderation_state`, required
fields and workflow transitions; `status:false` alone is not a universal draft
contract. If no permitted safe unpublished path exists, use the content editor.
Save the returned UUID and node mapping, then GET it in the same language.

Update with `PATCH /jsonapi/node/<BUNDLE>/<UUID>` and
`{"data":{"type":"node--<BUNDLE>","id":"<UUID>","attributes":{
"title":"<NEW_TITLE>"}}}`. Omit unrelated attributes; preserve body `value`,
`summary` and text `format` when editing the body. Relationships use
`{"field_tags":{"data":[{"type":"taxonomy_term--<VOCAB>","id":"<TERM_UUID>"}]}}`
inside `data.relationships`; retain existing members if adding a term. Keep media
and paragraph/entity references rather than replacing them with labels or HTML.

Core does not promise a universal conditional PATCH version header. Compare
`changed`/revision on an immediate fresh read; this reduces but does not eliminate
a race. Use documented conditional requests only if the installed endpoint and
tool support them. Do not claim `changed` is an atomic lock; use UI when required
concurrency guarantees are unavailable. Stop/reconcile 409 conflicts.

For publication, PATCH the **same** verified UUID: `status:true` only for a bundle
that permits direct state changes; otherwise use an allowed moderation transition
on `moderation_state`. Do not force published status past workflow rights. Check
the published/default revision, not only a pending revision. An existing published
node must not be changed to `status:false` to save a draft. Taxonomy creation, if
explicitly needed, uses `POST /jsonapi/taxonomy_term/<VOCAB>` with the matching
`taxonomy_term--<VOCAB>` type and required attributes; use an existing term first
and UI if taxonomy offers no safe staging state.

## Drupal-specific recovery and editor

Core accepts a client-supplied UUID for creation: if deliberately using one,
record it before dispatch and check it after a timeout; never replace it to retry.
Otherwise query by the known bundle, language and exact identifying fields.
Use observed Content or `/node/<NUMERIC_ID>/edit` links for fallback, retaining
language and revision context. A visible CKEditor Source option may help only
if the installed editor offers it and can preserve embeds; do not enable plugins.
Read back aliases/status and verify the actual front-end URL separately from
JSON:API data, including moderation and access restrictions.

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

- [JSON:API core concepts and IDs](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/core-concepts)
- [Creating resources](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/creating-new-resources-post)
- [Updating resources](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/updating-existing-resources-patch)
- [Authentication and CSRF](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/what-jsonapi-doesnt-do)
- [Read-only mode and access control](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/security-considerations)
- [Translation limits](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/translations)
- [Revisions](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/revisions)
