# Ghost content (API-first)

```webbrain-skill
{
  "summary": "Ghost posts, pages and tags: draft, edit, verify, publish.",
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

For the user's content task on this confirmed CMS, prefer the official API before
editor failure only when target/model/fields, existing auth, CMS rights, task
scope, WebBrain mutation permission and Act/Dev mode all permit it. Confirm custom
domains from observed admin/API evidence. Request `/allow-api` once if it is the
remaining blocker; reuse valid grants and respect refusal. It grants neither CMS
credentials nor roles. Ask stays read-only, including GraphQL/query POSTs.
Never bypass a gate through GET mutations, private endpoints or another tool.

Existing content models only: no schemas, plugins/themes, site design/settings,
users/roles, app grants, commerce/customer data, email, bulk releases or deploys.
A content task does not authorize credential creation or enabling API writes.

## Tools, secrets and trace limits

Use existing `fetch_url`: string-valued headers and serialized JSON body, with
bounded `json`/`text` result strings. GET reads support exact `nextOffset`
continuation; never replay a mutation to recover a truncated response. Use its
documented read/query route. ETag/Retry-After are not exposed: use available JSON
versions, or UI when a required precondition cannot be obtained.

Background cookies follow only the active tab's registrable domain; dashboard
login does not prove API auth. Origin/Referer remain browser-controlled. Use the
verified HTTPS API origin and site binding; rejected redirects require discovery
without secrets. Never forward auth to guessed/user-content/redirect hosts.
No OAuth, signer, broker, credential store or token scraping is supplied. Opaque
`replayRequestId` is usable only if already offered for a compatible same-origin
operation, never as a general auth route.

Tokens/nonces in chat, arguments or discovery results can reach the model and raw
traces; arbitrary CMS headers have no guaranteed opaque injection/redaction.
Never put secrets in skills, scratchpad, memory, URLs or summaries. With
Strict Secret Handling, use UI if existing browser/opaque auth cannot work;
never ask to disable it. Describe requests without secrets. Examples are placeholders.

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

Keep a non-secret receipt: origin/site, type, locale, ID/draft mapping, revision,
intended fields and whether a mutation was dispatched. Read complete required
content first; preserve native rich text, media, relations and untouched fields.
Never demote/unpublish live content to edit it. New content needs a safe draft
path; otherwise use UI, not direct public creation.

Timeout/partial success can follow a committed write. Reconcile the known ID or
exact scoped type/locale/parent/slug/time matches before retrying or switching to
UI. Resume the existing draft; ambiguous matches need clarification. Never invent
idempotency headers or retry with a new ID. Stop repeated 401/403s. Re-read and
reconcile version conflicts. Use bounded service backoff for 429/temporary errors,
without replaying uncertain writes; do not fabricate unavailable response headers.
Compact cannot wait/schedule: report partial progress for a later user resume.

Read back the same record through its supported API, verifying requested fields,
type, locale, rich content, relations and state. Draft-only tasks stop there.
Publish only that verified content when requested, accounting for all pending
draft changes and live effects. Re-read publication state and check the target
URL where possible. HTTP success is insufficient; report CMS publication and
website visibility separately. Never trigger deploy/site-wide publish/email.

For unsupported fields/auth/workflows, use the observed editor for the same record,
preserving ID/type/locale, content/taxonomy and required URL parameters. After an
inaccessible iframe/canvas, try an observed Code/Text/standard editor and refresh
AX refs; do not loop or guess editor URLs. Verify UI saves too. If both routes
fail, report the existing partial record and blocker without claiming completion.

## Official sources (reviewed 2026-09-30)

- [Admin API, authentication, permissions and version header](https://docs.ghost.org/admin-api)
- [Read posts and formats](https://docs.ghost.org/admin-api/posts/overview)
- [Create posts, Lexical and relation semantics](https://docs.ghost.org/admin-api/posts/creating-a-post)
- [Updates and collision detection](https://docs.ghost.org/admin-api/posts/updating-a-post)
- [Web publication](https://docs.ghost.org/admin-api/posts/publishing-a-post)
- [Email is separate](https://docs.ghost.org/admin-api/posts/sending-a-post)
- [Pages](https://docs.ghost.org/admin-api/pages/overview)
