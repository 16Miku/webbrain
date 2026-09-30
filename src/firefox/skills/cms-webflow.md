# Webflow content (API-first)

```webbrain-skill
{
  "summary": "Webflow collection items, references and item publication.",
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

- [Authorization](https://developers.webflow.com/data/reference/authorization)
- [Scopes](https://developers.webflow.com/data/reference/scopes)
- [Create staged item](https://developers.webflow.com/data/reference/cms/collection-items/staged-items/create-item)
- [Create items and locale choices](https://developers.webflow.com/data/docs/working-with-the-cms/create-items)
- [Update staged item](https://developers.webflow.com/data/reference/cms/collection-items/staged-items/update-item)
- [Publish items](https://developers.webflow.com/data/reference/cms/collection-items/staged-items/publish-item)
- [Components in rich text](https://developers.webflow.com/data/docs/working-with-the-cms/components-in-rich-text)
- [Rate limits](https://developers.webflow.com/data/reference/rate-limits)
