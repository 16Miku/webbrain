# Wix content (API-first)

```webbrain-skill
{
  "summary": "Wix Blog drafts, posts, categories, tags and publication.",
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

- [REST API authentication](https://dev.wix.com/docs/api-reference/articles/rest-authentication/rest-api-authentication)
- [Draft API, roles and limits](https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/introduction)
- [Create draft](https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/create-draft-post)
- [Update draft](https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/update-draft-post)
- [Publish draft and post mapping](https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/publish-draft-post)
- [Blog business flow, categories and tags](https://dev.wix.com/docs/api-reference/business-solutions/blog/blog-business-flow)
- [API key site binding](https://dev.wix.com/docs/develop-websites-sdk/code-your-site/authorization/make-rest-api-calls-with-an-api-key)
