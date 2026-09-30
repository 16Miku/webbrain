# Ghost content (API-first)

Posts, pages, tags, drafts and web publication through the official Ghost Admin API.

```webbrain-skill
{
  "summary": "Posts, pages, tags, drafts and web publication through the official Ghost Admin API.",
  "modes": [
    "ask",
    "act",
    "dev"
  ],
  "intents": [
    "cms_content_management",
    "ghost_content"
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

Use for Ghost posts, pages and tags on an existing publication. The public Content
API is read-only; a Content API key cannot authorize Admin writes. Discover the
**admin** domain (which may differ from the public custom domain) and any install
subdirectory. Root: `https://<ADMIN_HOST>/<OPTIONAL_BASE>/ghost/api/admin/`.
Use a site-compatible `Accept-Version: v<MAJOR>.<MINOR>` and JSON content type;
the version is negotiated by header, not an invented versioned path.

Ghost documents session cookies with matching Origin or Referer CSRF checks, and
integration/staff keys used to sign short-lived JWTs (`Authorization: Ghost
<EXISTING_JWT>`). An Admin key in `id:secret` form is **not** a bearer/JWT token.
WebBrain has no JWT signer; do not implement one in the page or expose a long-lived
key. Use an existing authorized session only if its cookie and required origin
really work with current tools. Background fetch cannot promise the session's
Origin/Referer. If it fails, use Ghost Admin; do not create a session by collecting
password/2FA through this recipe. A user-supplied, already signed, still-valid JWT
is conditional on the secret policy and the integration/staff role's rights.

## Discover and read

1. Confirm site identity with the observed admin and documented `GET site/`.
   Read the correct `GET posts/<ID>/` or `GET pages/<ID>/`; never convert a page
   into a post. Request `formats=lexical,html` where supported and include the
   relations needed for the task. Collections support `filter`, `page`, `limit`.
2. Record `id`, `updated_at`, status, visibility, canonical URL, authors, tags,
   feature media, excerpt and the native body. Read `GET tags/` and match existing
   tag IDs by name/slug/visibility, including internal `#` tags. Never use a name
   shortcut that would silently create an unintended new tag.
3. Confirm staff/integration rights for the target operation without test writes.
   Ghost has no universal per-post locale input: preserve the publication's
   language and any existing multilingual content conventions; do not change
   site language settings or fabricate a `locale` field.

## Draft, update and publish

- Create a post with `POST posts/`, body `{"posts":[{"title":"<TITLE>",
  "status":"draft","lexical":"<SERIALIZED_VALID_LEXICAL_JSON>"}]}` plus the
  validated required content/relations. Pages use `POST pages/` and `pages` as
  the envelope. Save the returned ID and verify the draft via GET.
- `PUT posts/<ID>/` with `{"posts":[{"title":"<NEW_TITLE>",
  "updated_at":"<LAST_READ_UPDATED_AT>"}]}` changes that post's title. Use
  `pages/<ID>/` and a `pages` envelope for a page. Keep existing status unless
  the requested operation changes it. Editing a published object may update
  live content immediately: a “draft update” must not silently change it.
- A collision means re-read and reconcile; do not substitute the current clock
  for `updated_at`. Tag/author arrays are replacement relations: merge the user's
  intended change with the full existing arrays before sending either array.
- Preserve native Lexical JSON (including cards, embeds and media). `source=html`
  performs a potentially lossy conversion; do not use it to round-trip an existing
  Lexical body. Use a verified native representation or the editor if fidelity
  cannot be preserved. Title-only updates must omit the body, not blank it.
- New tags: only within the task, after exact lookup, `POST tags/` with a `tags`
  array; update existing tags via `PUT tags/<TAG_ID>/`. Tags have no draft lifecycle;
  use their editor for new taxonomy where a non-public staging step is needed.
- For requested **web-only** publication, GET the verified draft again, then
  `PUT posts/<ID>/` with `{"posts":[{"updated_at":"<LATEST_UPDATED_AT>",
  "status":"published"}]}` (or the page equivalent). Do not add `newsletter`,
  `email_segment`, send-email or email-only parameters. Do not publish a draft
  already configured for email-only delivery without resolving that conflict.
  Newsletter sending is a distinct operation outside this skill.
- GET the same object, confirm content/status/visibility and its `url`; public
  visibility can differ for members-only content. Do not change its access level.

## Ghost-specific recovery and editor

After uncertain create, inspect the expected slug through the Admin collection
filter, retaining exact title/type and creation window; Ghost may normalize slugs.
Do not assume that a matching public page means your draft was created. No general
create idempotency key is promised. On an expired JWT or session/CSRF failure,
stop and use the observed Ghost editor. Preserve the post/page ID and existing
cards, tags and authors; use an available native card/editor mode rather than
flattening the article into plain text.

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

- [Admin API, authentication, permissions and version header](https://docs.ghost.org/admin-api)
- [Read posts and formats](https://docs.ghost.org/admin-api/posts/overview)
- [Create posts, Lexical and relation semantics](https://docs.ghost.org/admin-api/posts/creating-a-post)
- [Updates and collision detection](https://docs.ghost.org/admin-api/posts/updating-a-post)
- [Web publication](https://docs.ghost.org/admin-api/posts/publishing-a-post)
- [Email is separate](https://docs.ghost.org/admin-api/posts/sending-a-post)
- [Pages](https://docs.ghost.org/admin-api/pages/overview)
