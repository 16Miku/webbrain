# Joomla content (API-first)

Articles, categories and supported publication-state changes through Joomla Web Services.

```webbrain-skill
{
  "summary": "Articles, categories and supported publication-state changes through Joomla Web Services.",
  "modes": [
    "ask",
    "act",
    "dev"
  ],
  "intents": [
    "cms_content_management",
    "joomla_content"
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

Use the installed Joomla version's official Web Services API (Joomla 4+ family,
current documentation includes 6.1). The normal root is
`https://<SITE>/<OPTIONAL_BASE>/api/index.php/v1`. Verify it against the observed
installation; API availability depends on enabled Web Services and authentication
plugins. Do not install/enable them. This covers `com_content` articles and their
categories, not arbitrary extensions or site pages assembled from menu/modules.

Use an existing `X-Joomla-Token: <API_TOKEN>`, with
`Accept: application/vnd.api+json` and `Content-Type: application/json`.
The account needs `core.login.api` plus relevant create/edit/edit-state ACL rights
for the content/category. An administrator cookie or form CSRF token is not the
documented Web Services token. Browser login alone is insufficient; do not fetch
or generate a profile API key to bootstrap access. Strict Secret Handling may
therefore require the administrator UI. Do not grant Super User privileges.

## Discover and read

1. Confirm site/version, API root and current rights from existing setup and a
   bounded authenticated `GET content/articles`. GET `content/articles/<ID>`
   for the target; retain the numeric ID, article type, version/modified data,
   `state`, `catid`, `language`, `access`, `featured`, publication dates and fields.
2. GET `content/categories` (and a specific category by ID) to map category names
   to IDs, parent hierarchy and language. This is the `com_content` category tree;
   do not substitute a similarly named category from another extension.
3. Confirm required form fields and text filtering for this site. Joomla creation
   accepts `articletext`, while documented PATCH uses `introtext` and `fulltext`.
   Keep the read-more split, images, URLs, metadata and custom fields. Do not assume
   a title/body-only replacement preserves a complete article.
4. Preserve the existing language code (`*` means all languages, not the user's
   current UI language), translated article associations and access level.
   Determine whether content workflows control publishing; API state changes
   are conditional on that workflow, installed version and ACL.

## Draft, update and publish

Create one unpublished article using `POST content/articles`:

```json
{"title":"<TITLE>","alias":"<UNIQUE_ALIAS>","articletext":"<COMPLETE_HTML>","catid":42,"language":"<LANG_OR_*>","state":0}
```

`42` is an example category ID: replace it with a verified ID and include all
site-required fields. Confirm that state 0 is actually accepted as unpublished
under this site's workflow before creation; otherwise use the editor. Save the
returned article ID and read it back, checking it did not default to published.

For an existing record, use `PATCH content/articles/<ID>` with only requested
fields. A body edit uses `{"id":123,"introtext":"<INTRO_HTML>",
"fulltext":"<REMAINING_HTML>"}`; `123` is the existing target, not a new ID.
Do not send an empty `fulltext` when only the intro is changing. Keep `state`
unchanged for an ordinary edit; published article changes may be live immediately.

Use available version/modified/checkout information to detect concurrent edits.
The generic API does not document a universal compare-and-swap header; fresh
read/compare is not an atomic lock. Respect a checked-out article or conflict;
do not check it in, force unlock, or overwrite another editor's work. Fall back
to the editor if necessary revision guarantees cannot be met.

Publish only the verified article with `PATCH content/articles/<ID>` and
`{"state":1}` **when supported** by its workflow and `core.edit.state` ACL.
If workflows require transitions not exposed by the installed documented API,
use that article's visible workflow action. Do not invent a `/publish` endpoint.
Never set live content to state 0 as a convenience or change archive/trash state.

Category edits use `PATCH content/categories/<CATEGORY_ID>` after reading it;
new categories, only if requested and no existing match, use
`POST content/categories` with verified `title`, `alias`, `extension:com_content`,
parent and language. Require a supported unpublished category state or use UI;
do not create a public taxonomy structure merely to finish an article.

## Joomla-specific recovery and editor

No general create idempotency key or atomic revision guard is assumed. Reconcile
timeouts via the known article ID or a bounded category/alias/title/language lookup.
Check JSON:API `errors` as well as HTTP status. Open the observed Articles edit
link in `/administrator/`, keeping `option=com_content`, edit task, `id` and any
language/context parameters. Use the existing editor's Code/Source toggle only
if observed. Re-read saved intro/full text and state. A published article may still
be invisible because of menu routing, category/access settings or publish dates;
report those facts without changing site configuration.

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

- [Web Services: auth, article create/read/PATCH](https://manual.joomla.org/docs/general-concepts/webservices/)
- [Core Web Services endpoints](https://docs.joomla.org/J4.x:Joomla_Core_APIs)
- [Access control](https://manual.joomla.org/docs/general-concepts/acl/)
- [Workflows](https://manual.joomla.org/docs/general-concepts/workflows/)
- [State, checkout and language fields](https://manual.joomla.org/docs/general-concepts/table/advanced-table/)
