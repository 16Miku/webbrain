# Joomla content (API-first)

```webbrain-skill
{
  "summary": "Joomla articles and categories through Web Services.",
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

- [Web Services: auth, article create/read/PATCH](https://manual.joomla.org/docs/general-concepts/webservices/)
- [Core Web Services endpoints](https://docs.joomla.org/J4.x:Joomla_Core_APIs)
- [Access control](https://manual.joomla.org/docs/general-concepts/acl/)
- [Workflows](https://manual.joomla.org/docs/general-concepts/workflows/)
- [State, checkout and language fields](https://manual.joomla.org/docs/general-concepts/table/advanced-table/)
