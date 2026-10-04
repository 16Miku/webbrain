# Strapi content (API-first)

```webbrain-skill
{
  "summary": "Strapi content, relations, locales and draft/publication.",
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

- [REST endpoints and v5 identities](https://docs.strapi.io/cms/api/rest)
- [Explicit draft/published write semantics](https://docs.strapi.io/cms/api/rest/status)
- [Locale](https://docs.strapi.io/cms/api/rest/locale)
- [Populate and select](https://docs.strapi.io/cms/api/rest/populate-select)
- [Relations](https://docs.strapi.io/cms/api/rest/relations)
- [API token rights](https://docs.strapi.io/cms/features/api-tokens)
- [Draft & Publish](https://docs.strapi.io/cms/features/draft-and-publish)
- [v4 REST reference](https://docs-v4.strapi.io/dev-docs/api/rest)
