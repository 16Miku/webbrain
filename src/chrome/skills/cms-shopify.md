# Shopify content (API-first)

```webbrain-skill
{
  "summary": "Shopify blogs, articles and pages through Admin GraphQL.",
  "modes": [
    "ask",
    "act",
    "dev"
  ],
  "intents": [
    "cms_content_management",
    "shopify_content"
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

Use GraphQL **Admin** API for Blog, Article and Page, not Storefront API, products,
customers, orders or themes. Root:
`https://<VERIFIED_SHOP>.myshopify.com/admin/api/2026-07/graphql.json`.
`2026-07` is the stable version reviewed here; confirm the shop/app's supported
dated version and its exact schema. Never use `unstable` or assume an old API
version has these mutations. Store content availability depends on the Online
Store channel and shop plan/setup; do not add a channel or change plans.

An existing Admin app access token uses `X-Shopify-Access-Token: <TOKEN>` and
`Content-Type: application/json`. Content operations require the documented
read/write content scopes (current mutations accept `write_content` or
`write_online_store_pages`) and applicable staff rights. Dashboard cookies,
Storefront tokens and a custom storefront domain do not grant Admin API access.
Do not install an app, request expanded OAuth grants or build token exchange.

GraphQL queries and mutations both use POST; WebBrain gates both by HTTP method.
A bounded query selection and GraphQL cursor pagination recover large reads;
never repeat a mutation to obtain a truncated response.
Ask cannot use this API through `fetch_url`, even for a query; use the read-only
visible UI. In Act/Dev, if usable auth/setup is established but POST permission
is missing, request `/allow-api` once before discovery POST. Do not send mutation
text through GET or a read-only skill manifest. With Strict Secret Handling and
no existing opaque mechanism, use the content editor.

## Discover and read

1. Confirm shop identity and granted scopes from trusted existing setup and a
   bounded GraphQL query for `shop { id name myshopifyDomain }`. Schema errors are
   not permission to switch to private admin endpoints.
2. Query the exact `blog(id:)`, `article(id:)` or `page(id:)`, selecting required
   fields and version-supported publication fields. Retain GraphQL GIDs, handles,
   `updatedAt`, body, summary, author, image, tags, template suffix and blog GID.
   Paginate `blogs`, `articles` or `pages` when finding an ID; do not treat the
   first identical title as the target.
3. These content objects do not take a generic `locale` on article/page updates.
   Preserve the primary language and existing translations. Translation writes
   are a separate API/scope/workflow; if the requested locale cannot be safely
   handled with existing authorization, use the installed translation editor.

## Draft, update and publish

A concrete article draft request uses the following serialized JSON body:

```json
{"query":"mutation Draft($article: ArticleCreateInput!) { articleCreate(article: $article) { article { id title isPublished } userErrors { field message code } } }","variables":{"article":{"blogId":"gid://shopify/Blog/<BLOG_ID>","title":"<TITLE>","author":{"name":"<AUTHORIZED_BYLINE>"},"body":"<HTML>","isPublished":false}}}
```

Only submit after checking all required fields against the chosen version. Save
the returned GID and query it to verify the draft. Page creation uses
`pageCreate(page: PageCreateInput!)` with `title`, HTML `body` and
`isPublished:false`. Keep the returned page GID. Do not create a second object
to replace an already existing hidden page or article draft.

For changes, use `articleUpdate(id:<GID>, article:<ArticleUpdateInput>)` or
`pageUpdate(id:<GID>, page:<PageUpdateInput>)` and select `userErrors` plus the
updated object. Pass only requested input fields; preserve blog association,
handle, author, tags, summary, template and media unless asked to change them.
Tags are strings here, not category IDs: merge additions with the existing tags
array. Read `updatedAt` immediately before writing and reconcile changes; these
mutations do not expose a universal atomic version-precondition argument.

Publish the **same** validated article/page using its update mutation with
`isPublished:true` only when requested. Preserve scheduling/publish dates unless
the user asked to change them. Updating already published content can affect the
live store immediately; do not hide it as a draft workaround. A pending editorial
draft of a live object is not uniformly available through these inputs.

Blogs are content containers with `blogCreate`/`blogUpdate` mutations and fields
such as title/handle/template/comment policy. They have **no equivalent draft
flag**. Read/update an existing blog only within task scope and preserve its other
settings. For a new blog request, use the observed Admin UI to review the actual
visibility/creation consequences; never invent `isPublished:false` on Blog or
silently create a public container. Articles can be drafted in an existing blog.

HTML bodies must retain embedded media and structure. Metafields/custom content
need their actual supported definitions and APIs; do not drop them or manufacture
new definitions. Use the editor for unsupported fields or lossless-format limits.

## Shopify-specific recovery and editor

HTTP 200 can contain top-level GraphQL `errors` or mutation `userErrors`; inspect
both and then query the exact GID. No general idempotency guarantee applies to
these creates. After timeout, query the known GID or search/paginate exact handle,
blog and time before any retry. On throttling, use `extensions.cost.throttleStatus`
when returned, with bounded backoff; do not repeatedly submit uncertain mutations.
UI fallback stays in the observed Blog posts/Pages editor for the same GID's
record; retain store handle and editor URL. Verify `isPublished`, actual fields
and the storefront URL; a hidden/unavailable Online Store is not fixed by changing
shop settings. Never use product/publication APIs to publish editorial content.

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

- [GraphQL Admin API and authentication](https://shopify.dev/docs/api/admin-graphql)
- [API versioning](https://shopify.dev/docs/api/usage/versioning)
- [Article create](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/articleCreate)
- [Article update](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/articleUpdate)
- [Page create](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/pageCreate)
- [Page update](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/pageUpdate)
- [Blog create](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/blogCreate)
- [Blog update](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/blogUpdate)
- [Rate limits](https://shopify.dev/docs/api/usage/limits)
