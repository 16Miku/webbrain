# Wix content (API-first)

Wix Blog drafts, posts, categories, tags and publication with existing authorized API access.

```webbrain-skill
{
  "summary": "Wix Blog drafts, posts, categories, tags and publication with existing authorized API access.",
  "modes": [
    "ask",
    "act",
    "dev"
  ],
  "intents": [
    "cms_content_management",
    "wix_content"
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

Use Wix **Blog** REST API v3 at `https://www.wixapis.com/blog/v3`. It does not
manage arbitrary Wix Editor pages or CMS collection schemas. Confirm Wix Blog is
already installed for the intended site; do not install it or change site plans.
The documented Blog business flow supports draft creation/editing/publication and
category/tag management. Multilingual features depend on the site's existing
Multilingual installation and configured languages.

Use existing Wix app/user authorization (`Authorization: <TOKEN>`) or an already
authorized API key (`Authorization: <API_KEY>` with `wix-site-id: <SITE_ID>`).
Do not blindly add a Bearer prefix to the documented raw Wix header. Site API keys
must belong to the site's account and allow that site. Use the method's documented
identity and **Manage Blog** permission; a visitor/member token is not an admin
credential. Blog writers can publish their own posts; guest writers cannot.
Wix dashboard cookies on wix.com are not API authorization on wixapis.com.
Do not implement OAuth/elevation, provision a key or grant permissions.

## Discover and read

1. Establish the exact site ID, identity/role and language from existing setup
   and dashboard evidence. GET `/draft-posts` or the documented list route and
   `GET /draft-posts/<DRAFT_ID>` for the target. Published posts use
   `GET /posts/<POST_ID>`; a public post read is not proof of draft write access.
2. Request needed `fieldsets`, especially `RICH_CONTENT` and `URL`, because
   basic responses omit optional fields. Inspect `richContent`, title, slug,
   excerpt, member/byline, cover media, categoryIds, tagIds, relatedPostIds,
   language/translationId and any existing access restrictions. Do not manage
   subscriptions/pricing plans; preserve their content access references.
3. `GET /categories` and `GET /tags` identify existing taxonomy in the right
   language/site; paginate and map names to IDs. Wix can silently ignore unknown
   category IDs on create, so verify the returned arrays instead of trusting 2xx.

## Draft, update and publish

`POST /draft-posts` with a body such as:

```json
{"draftPost":{"title":"<TITLE>","memberId":"<EXISTING_AUTHORIZED_AUTHOR_ID>","language":"<LANG>","richContent":{"nodes":[]},"categoryIds":["<CATEGORY_ID>"],"tagIds":["<TAG_ID>"]}}
```

The empty nodes array illustrates the envelope, not a finished article: populate
validated Wix Rich Content nodes before submission. Third-party apps require
`memberId`; do not create a member or substitute another author's identity.
Save the returned draft ID and read back rich content/taxonomy/locale before any
publish. Respect the documented draft size limit (400 KB).

Use `PATCH /draft-posts/<DRAFT_ID>` with
`{"draftPost":{"title":"<NEW_TITLE>"}}` for a title-only edit. Check the chosen
API version's allowed fields; use its default UPDATE action, never a scheduling
action unless requested. Keep `editedDate`/other returned change metadata for an
immediate read/compare. These endpoints do not promise universal revision locking;
reconcile concurrent changes and use the editor when an atomic guard is needed.

When editing a published post, find its linked draft by the documented post/draft
mapping and existing ID. Do not create an unrelated new draft from a copied title.
If no editable draft is exposed through current API access, use that post's editor.
Preserve the published version while staging changes; do not unpublish to edit.

Only after verification and requested publication, call
`POST /draft-posts/<DRAFT_ID>/publish`. Store the returned `postId`, then GET that
post with the required rich-content/URL fields. Re-publishing an already published
draft updates its linked post; do not create a replacement post. Check its
publication/last-published information and actual content, then the target URL.

Wix `richContent` is structured JSON, not generic HTML. Keep node IDs, decorations,
embeds and media references intact; do not rebuild the whole document from plain
text. Preserve `language`/`translationId`; creating a translation is different
from relabeling an existing post. Use an observed translation workflow when the
requested multilingual operation is unsupported.

If explicitly required, taxonomy creation uses `POST /categories` with a
`category` object or `POST /tags` with a `tag` object (and their documented update
routes for existing IDs). Verify field names/required labels and language against
that endpoint; these are not blog drafts, so use UI if no safe staging path exists.
Never duplicate existing categories/tags or copy labels into ID arrays.

## Wix-specific recovery and editor

After uncertain create/publish, GET the draft and linked post before retrying.
Otherwise use bounded list/query filters for title/slug, author, language and
creation time; POST query endpoints are still API-gated. No universal idempotency
header is promised here. A 403 requires correcting access through the user or
falling back, not repeated calls. Use the observed dashboard Blog editor for the
same site/draft/post, refreshing refs after editor changes. Do not call Wix's
site-publisher API: blog publication is separate from publishing the whole site.
Restricted posts can be published yet unavailable anonymously; preserve access.

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

- [REST API authentication](https://dev.wix.com/docs/api-reference/articles/rest-authentication/rest-api-authentication)
- [Draft API, roles and limits](https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/introduction)
- [Create draft](https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/create-draft-post)
- [Update draft](https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/update-draft-post)
- [Publish draft and post mapping](https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/publish-draft-post)
- [Blog business flow, categories and tags](https://dev.wix.com/docs/api-reference/business-solutions/blog/blog-business-flow)
- [API key site binding](https://dev.wix.com/docs/develop-websites-sdk/code-your-site/authorization/make-rest-api-calls-with-an-api-key)
