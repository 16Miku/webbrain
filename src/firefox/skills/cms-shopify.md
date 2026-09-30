# Shopify content (API-first)

Blogs, articles and store content pages through Shopify GraphQL Admin API; preserves draft and publication intent.

```webbrain-skill
{
  "summary": "Blogs, articles and store content pages through Shopify GraphQL Admin API; preserves draft and publication intent.",
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

- [GraphQL Admin API and authentication](https://shopify.dev/docs/api/admin-graphql)
- [API versioning](https://shopify.dev/docs/api/usage/versioning)
- [Article create](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/articleCreate)
- [Article update](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/articleUpdate)
- [Page create](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/pageCreate)
- [Page update](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/pageUpdate)
- [Blog create](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/blogCreate)
- [Blog update](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/blogUpdate)
- [Rate limits](https://shopify.dev/docs/api/usage/limits)
