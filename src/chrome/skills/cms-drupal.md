# Drupal content (API-first)

```webbrain-skill
{
  "summary": "Drupal nodes and taxonomy through authorized JSON:API.",
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

- [JSON:API core concepts and IDs](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/core-concepts)
- [Creating resources](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/creating-new-resources-post)
- [Updating resources](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/updating-existing-resources-patch)
- [Authentication and CSRF](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/what-jsonapi-doesnt-do)
- [Read-only mode and access control](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/security-considerations)
- [Translation limits](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/translations)
- [Revisions](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/revisions)
