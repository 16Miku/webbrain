# Contentful content (API-first)

```webbrain-skill
{
  "summary": "Contentful entries, locales, links and CMA publication.",
  "modes": [
    "ask",
    "act",
    "dev"
  ],
  "intents": [
    "cms_content_management",
    "contentful_content"
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

Use Content Management API (CMA), `https://api.contentful.com`, or
`https://api.eu.contentful.com` for the verified EU region. Root per task:
`/spaces/<SPACE_ID>/environments/<ENVIRONMENT_ID>`. Explicitly resolve any
environment alias before mutation; do not assume `master`. Delivery API
(`cdn.contentful.com`) and Preview API (`preview.contentful.com`) are read-only
and their API keys cannot mutate CMA content.

Use an existing personal/OAuth management access token in
`Authorization: Bearer <CMA_TOKEN>`; the token's user must already have access to
the space/environment/content type and the operation (including publish rights).
Use `Content-Type: application/vnd.contentful.management.v1+json`.
The app.contentful.com browser session is not a CMA credential. Do not create a
token, consent to OAuth, change a role or configure a new environment. Strict
Secret Handling requires UI if no already available opaque auth path works.

## Discover and read

1. Confirm space/environment/region. GET the environment's `/content_types` and
   `/content_types/<TYPE_ID>` for existing field definitions, validations,
   required/localized flags and reference target restrictions. Do not create,
   activate or modify a model to make content fit.
2. GET `/locales` for configured language codes and fallback/default rules; only
   manage entry values in these locales, never the locale configuration itself.
3. GET `/entries/<ENTRY_ID>` through CMA. It returns localized and unpublished
   fields; read the **complete** `fields` and applicable `metadata` before a PUT.
   Capture `sys.id`, `sys.contentType`, `sys.version`, publication/archive fields,
   and locale publishing metadata when available. Resolve referenced entries and
   assets as needed without assuming every reference is already published.
4. Match taxonomy/reference names to existing entry IDs or metadata tag/concept
   IDs in their actual model. Do not confuse editorial taxonomy entries with
   Contentful metadata tags or taxonomy configuration. Creating a new editorial
   taxonomy entry requires task scope and an existing type; schema/configuration
   changes are outside this recipe.

## Draft, update and publish

New entries are drafts. Use `POST /entries` with
`X-Contentful-Content-Type: <TYPE_ID>` and fields keyed by the actual locale:

```json
{"fields":{"title":{"en-US":"<TITLE>"},"body":{"en-US":{"nodeType":"document","data":{},"content":[]}}}}
```

This example assumes title and Rich Text body fields and `en-US`; substitute the
real schema/locales and complete Rich Text nodes before writing. Do not invent
fields. Save the returned entry ID/version. An alternative documented create is
`PUT /entries/<CHOSEN_ID>` with the content-type header: preselect a unique ID,
record it, and check it after uncertain responses instead of selecting a new ID.

Update the same entry with `PUT /entries/<ENTRY_ID>` and
`X-Contentful-Version: <LAST_READ_SYS_VERSION>`. CMA PUT does **not** merge the
entry: send all retained writable `fields` and `metadata`, changing only the
requested fields/locales. Never include read-only `sys` as writable content.
Alternatively use documented JSON Patch with its content type and version header;
operations on an unset field need the complete field subobject at an existing
parent path. Do not use JSON Patch as a reason to skip reading the record.

On a version mismatch/409, GET again and reconcile concurrent changes. Do not
blindly substitute the newer version header and resend an old full body. Normal
updates to published entries leave the existing published version available while
recording pending edits; do not unpublish to make a draft. Re-read the saved entry
and verify its complete locale/link data before deciding to publish.

For requested entry-level publication, `PUT /entries/<ENTRY_ID>/published` with
the **newly read** `X-Contentful-Version`. Required fields/linked assets may block
publication; report them instead of publishing unrelated records automatically.
Publication includes all pending entry changes, not only the field just edited;
verify that scope. Locale-based publication is plan/setup dependent (currently
Premium/Enterprise) and uses documented `add.fields` locale selection. Do not
promise single-locale publication on an entry-level space; use UI or clarify the
broader effect before proceeding. Never change publishing mode or buy a plan.

Rich Text is a JSON document with embedded entry/asset link nodes. Preserve node
types, marks, data, links and all other locales; a localized plain string is not a
replacement for a Rich Text document. Link values use `sys.type:Link`, `linkType`
and `id`; keep their target types and order. Use UI for unsupported custom editors
whose native representation cannot be preserved through CMA.

## Contentful-specific recovery and editor

Reconcile timeouts by the known/chosen ID and version/publication state. If a
random create ID was lost, query a unique field within the content type and locale
and creation window; multiple matches require clarification. `sys.publishedAt`
alone can describe an older publication: compare `sys.publishedVersion` and
`sys.version` (ordinary entry-level published-with-no-changes has
`version == publishedVersion + 1`), or locale `fieldStatus` when applicable.
Check the delivered intended version and public URL separately. Rate-limit headers
are not exposed by `fetch_url`; use bounded later reads, no uncertain write loop.
Fallback to the observed entry editor retaining space, environment, ID and locale.
Do not trigger a front-end deployment or a release/bulk publish.

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

- [CMA overview, auth, full replacements and version locking](https://www.contentful.com/developers/docs/references/content-management-api/overview/)
- [Entries and locale publishing](https://www.contentful.com/developers/docs/references/content-management-api/entries/)
- [Create draft entry](https://www.contentful.com/developers/docs/references/content-management-api/entries/create-an-entry/)
- [Publish an entry](https://www.contentful.com/developers/docs/references/content-management-api/entries/publish-an-entry/)
- [Content types](https://www.contentful.com/developers/docs/references/content-management-api/content-types/)
- [Locales](https://www.contentful.com/developers/docs/references/content-management-api/locales/)
- [Authentication distinctions](https://www.contentful.com/developers/docs/references/authentication/)
