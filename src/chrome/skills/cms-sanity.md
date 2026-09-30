# Sanity content (API-first)

```webbrain-skill
{
  "summary": "Sanity documents, Portable Text, drafts and publication.",
  "modes": [
    "ask",
    "act",
    "dev"
  ],
  "intents": [
    "cms_content_management",
    "sanity_content"
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

Use the project's non-CDN API:
`https://<PROJECT_ID>.api.sanity.io/v2025-02-19` (or a verified supported later
dated version), with the exact dataset and existing schema. Do not use the
read-cache `apicdn.sanity.io` host for writes or confuse document Actions with
paid AI Agent Actions. The reviewed Actions workflow requires 2025-02-19 or later;
do not use `vX` or today's date as an unverified API contract.

Requests require existing authenticated read/write access to the dataset and
document type, commonly a scoped bearer token (`Authorization: Bearer <TOKEN>`).
Sanity also supports user session authentication in supported browser contexts,
subject to cookie/CORS configuration; an arbitrarily hosted Studio cookie is not
automatically available to `<PROJECT>.api.sanity.io`. Background `fetch_url`
only attaches same-registrable-domain cookies, and cannot create a sanctioned
Studio SDK session or CORS grant. Use only a verified existing auth route; do not
scrape Studio tokens, install a client, change CORS, or add roles. Private datasets
and drafts need authorized reads; public published GROQ access proves no write
right. With Strict Secret Handling, use Studio when secure opaque auth is absent.

## Discover and read

1. Confirm Studio workspace, project ID, dataset, API version, schema types and
   required fields from existing trusted project information and the observed
   editor. Content Lake is schemaless at storage level: sample documents are not
   a complete schema, and mutations do not guarantee Studio validation. If the
   schema cannot be established, edit through Studio instead of guessing fields.
2. GET `/data/doc/<DATASET>/<ID>` for an exact document, or URL-encoded GET
   `/data/query/<DATASET>?query=<GROQ>&perspective=raw` for exact IDs. `raw` exposes
   distinct draft/published documents when authorized; default published
   perspective can hide a draft. Record `_id`, `_type`, `_rev`, `_updatedAt`,
   the full content, reference targets and any schema-specific language field.
3. Published ID `<ID>` and draft `drafts.<ID>` belong to the same logical item.
   Read both before editing/publishing. A `versions.<RELEASE>.<ID>` document is
   release-scoped and cannot be treated as a normal draft; releases are outside
   this task. Do not publish an entire release as an item workaround.
4. Resolve taxonomy documents and assets by their exact `_id`/`_type`; preserve
   `_ref`, `_weak`, array `_key` values, order and cross-dataset project/dataset
   bindings. Language may be a field or a separate linked document: follow the
   existing schema, never invent a universal locale parameter or alter i18n setup.

## Draft, update and publish

Choose a unique stable logical ID and record `drafts.<ID>` **before** creation.
The documented Mutation endpoint is `POST /data/mutate/<DATASET>`; a draft create
body is:

```json
{"mutations":[{"create":{"_id":"drafts.<UNIQUE_ID>","_type":"<EXISTING_TYPE>","title":"<TITLE>"}}]}
```

Include actual schema-required content, not just the illustrative title. A create
collision must trigger a read/reconciliation, not `createOrReplace`. GET the exact
draft and check all fields. Where using the official Actions create workflow,
verify its version-specific input; do not mix older client-only `attributes`
examples with the current HTTP `document` form.

For an existing draft, a targeted mutation is:

```json
{"mutations":[{"patch":{"id":"drafts.<ID>","ifRevisionID":"<LAST_READ_REV>","set":{"title":"<NEW_TITLE>"}}}]}
```

Keep `ifRevisionID` spelling and use the exact `_rev`; a revision mismatch is a
conflict to reconcile. Never use `createOrReplace` to overwrite a draft you have
not fully read. If only a published version exists, use the documented Actions
`sanity.action.document.version.create` with `publishedId:<ID>`, `baseId:<ID>`,
`versionId:drafts.<ID>` to stage its existing content (after checking current
support), then re-read. Do not unpublish the original or copy only title/body.
Preserve live status: patching the published ID directly changes live Content Lake.

Publish only the same verified draft through
`POST /data/actions/<DATASET>` with this JSON body:

```json
{"actions":[{"actionType":"sanity.action.document.publish","draftId":"drafts.<ID>","publishedId":"<ID>","ifDraftRevisionId":"<DRAFT_REV>","ifPublishedRevisionId":"<PUBLISHED_REV>"}]}
```

Include the published revision guard when a published document exists; omit it
for a genuinely new item after verifying absence. Re-read both immediately before
publishing. Actions publish promotes draft contents and removes that draft; verify
the resulting published document, not just the transaction response. Do not use
a manual copy/delete sequence to emulate unsupported publication. Preserve
transaction IDs for reconciliation; this is not a blanket idempotency guarantee.

Portable Text is structured blocks/spans/marks with stable `_key` and `markDefs`,
plus custom blocks/assets. Keep them intact, along with slug objects, references
and localized objects. A string/HTML body is not equivalent. Match taxonomy to
existing reference IDs; creating a new taxonomy document uses its existing schema
and draft lifecycle only when task-authorized. No schema generation or AI Actions.

## Sanity-specific recovery and editor

After timeout, query the deterministic draft/published pair with `perspective=raw`
on the non-CDN origin and inspect `_rev`/content and any known transaction/history.
No arbitrary candidate selection and no new random ID for a retry. Re-read on
409; authenticated 401/403 is not a reason to change dataset visibility/CORS.
Use bounded verification for eventual query visibility, never repeated publishes.
If draftActions are disabled by schema or a custom publish action has required
business logic, use the observed Studio document action instead of bypassing it.
Keep workspace/dataset/document/language in its observed editor URL and refresh
refs after switching. Publishing to Content Lake does not deploy a consuming site.

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

- [HTTP authentication](https://www.sanity.io/docs/http-auth)
- [Query API](https://www.sanity.io/docs/http-reference/query)
- [Mutation API](https://www.sanity.io/docs/http-reference/mutation)
- [Actions HTTP reference](https://www.sanity.io/docs/http-reference/actions)
- [Draft/version and publish action workflow](https://www.sanity.io/docs/content-lake/dispatch-actions)
- [Transactions](https://www.sanity.io/docs/content-lake/transactions)
- [Revision conditions](https://www.sanity.io/plugins/javascript-api-client)
- [Portable Text](https://www.sanity.io/docs/portable-text)
