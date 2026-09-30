# WordPress REST API

```webbrain-skill
{"summary":"Create, edit, and publish WordPress posts, pages, REST-enabled content types and their categories/tags through the authorized REST API before editor fallback.","modes":["act","dev"],"intents":["wordpress_content","wordpress_publish","wordpress_draft","wordpress_taxonomy"]}
```

Use this recipe for the user's requested WordPress content work in Act/Dev.
It covers posts, pages, REST-enabled custom post types, and their categories,
tags, or registered taxonomies. It does not authorize settings, plugins, users,
commerce, or unrelated mutations. Loading this skill grants no permission and
adds no tools. Use the existing `fetch_url`; do not build an authentication
bridge, install an authentication plugin, or create an application password.

## Eligibility and permission

Prefer the REST API before editing the UI when the required fields are supported,
the current signed-in session works, and API mutations are already authorized
by the current WebBrain permission state. An existing conversation, run, or
persistent API grant is sufficient: do not ask again. The user's requested
outcome still bounds every write; permission to use APIs is not permission to
publish a draft the user only asked to prepare. Ask mode must not mutate.

If read-only discovery confirms a viable API route but mutations are not
authorized, ask once for `/allow-api`. Do not issue a trial write or repeat the
request after refusal. Use the editor if the user declines, prefers the UI, or
the API is unsuitable. A revoked grant supersedes an earlier permission note.
Before a write, describe the destination, method, and intended payload without
credentials. Do not use GET URLs to create or publish content.

**Strict secret handling overrides this recipe.** When it is enabled, use the
editor without fetching a REST nonce or constructing credential-bearing tool
arguments. Do not automatically ask the user to turn the setting off.
This is an instruction-only integration: outside strict mode, the REST nonce
returned by `fetch_url` and the `X-WP-Nonce` header in subsequent tool arguments
can enter the configured LLM conversation and, when recording is enabled,
local traces. Never copy the nonce into a URL, final answer, scratchpad, skill
text, memory, or scheduled instructions.

## Discover the site, session, and content type

1. Start from the actual WordPress admin tab and intended site. Preserve its
   installation/subsite path (for example `/blog/`) and the current `post_type`
   and `post=<id>`. A saved draft or auto-draft already has an ID: reuse it.
   Before API editing, reconcile unsaved UI changes with the saved record and
   the requested edit. If they cannot be read/preserved, continue in the editor.
2. Discover the REST root from the site's API link or API index using read-only
   `fetch_url`. On a known WordPress installation, try its `wp-json/` index;
   if unavailable, its `?rest_route=/` index. Do not assume root installation,
   pretty permalinks, or that HTTP 200 alone proves a working REST API. Confirm
   WordPress JSON, namespaces, and routes. With query-form roots, append the
   route inside `rest_route` and keep other parameters separate, e.g.
   `/blog/?rest_route=/wp/v2/types&context=edit`; do not append to the whole URL.
3. Use only the same HTTPS origin as the intended admin site for this cookie
   recipe. `fetch_url` uses the current tab's session cookies for eligible
   requests, but browsers/site policy can still prevent authentication. Never
   forward a nonce or cookies to another origin or follow a login redirect as
   proof of authentication. A cross-origin REST root needs a different supported
   auth flow; fall back to the UI here.
4. With strict mode off, GET the current installation's
   `wp-admin/admin-ajax.php?action=rest-nonce`. WordPress core provides this to
   logged-in sessions. The trimmed response must be a nonce, not empty, `0`,
   `-1`, a login page, or an error. Send it only in `X-WP-Nonce` on subsequent
   requests to that site's discovered REST root. Cookies alone are insufficient.
5. Confirm the session with an authenticated read such as
   `wp/v2/users/me?context=edit`; check the user and relevant capabilities.
   GET `wp/v2/types/<post_type>?context=edit` and the API index route schema to
   resolve `rest_namespace`, `rest_base`, supported write methods and fields.
   Confirm create/edit/publish capabilities for the requested operation; for an
   existing ID, GET its item with `context=edit`. Never test access by creating
   disposable content. A page maps to `pages`, while custom types may use another
   namespace/base: never silently replace them with `posts`.
6. Check all requested fields before writing: title, content/block markup,
   excerpt, slug, parent, author, dates, status, featured media, and any relevant
   custom fields. Preserve fields outside the requested change by omitting them.
   If required builder data/meta is not exposed, a custom controller does not
   support the recipe, or the role cannot perform the work, use the editor.

Keep reads bounded with `_fields` where practical. A truncated `fetch_url`
result is incomplete evidence: read its remaining window or narrow the fields
before interpreting JSON, verifying long content, or concluding that no match
exists. Do not resend a mutation just to obtain another response window.

## Resolve categories and tags

Read `wp/v2/taxonomies?type=<post_type>&context=edit` and its route schema.
Use each supported taxonomy's actual namespace/base and the corresponding item
field; do not send `categories`/`tags` to pages or custom types that lack them.
Search the applicable term collection, inspect exact name/slug (and parent for
hierarchical categories), and reuse numeric IDs. Search is not exact matching;
read further pages if needed. Preserve existing term assignments unless the user
requested replacement/removal; arrays replace the whole assignment, so additions
must include the existing IDs. Create a missing term only when required by the
requested categorization and permitted by the user's role. On `term_exists`,
read and validate the existing term. On an uncertain term write, search/reconcile
before retrying. Do not change unrelated taxonomy definitions.

## Write, verify, then publish the same record

- Existing record: GET its current editable state, then POST only the requested
  changes to the discovered item URL ending in its ID. Keep the existing status
  unless the user asked to change it; never demote an existing published item
  to a draft just to follow the new-content recipe. Changes to a published item
  are immediately public. If the user wants only an unpublished proposed edit,
  use an available draft/revision workflow instead of overwriting the live item.
- New record with no existing ID: create **once**, with `status: "draft"`, on
  the discovered collection. Keep the returned ID and item URL immediately.
  Apply the requested fields and resolved taxonomy IDs to this same record.
- GET the item with `context=edit`. Compare saved title/content, relevant fields,
  taxonomy IDs, and intended status. Server filtering, missing fields, or a
  truncated response is not verification. Resolve differences before publishing.
- Only if the user requested publication, POST `{"status":"publish"}` to
  the **same ID** after verification. Respect a requested schedule/private
  status instead. GET again and verify status and returned permalink; for
  public publication also read the live content. `pending`, `future`, and
  `draft` are not `publish`. Report the actual state and URL.
- Refresh/re-read the editor before further UI writes so a stale editor cannot
  overwrite the API result. Keep the same ID when switching surfaces.

## Failures and uncertain results

An HTTP error, login HTML, blocked REST route, missing session, or unsupported
field should trigger a bounded diagnosis and editor fallback, not a retry loop
or plugin installation. For `rest_cookie_invalid_nonce`, refresh the nonce at
most once and verify the session with a read before deciding whether to retry.
Do not retry a definite permission/capability refusal with another endpoint.

A timeout, connection loss, malformed/truncated response, or server error after
a write can mean the write **succeeded**. Reconcile before any further mutation
or creating content in the editor. For a known ID, GET that same item. After an
uncertain creation without an ID, inspect recent records of the same type,
including drafts/pending/published states within the current user's access;
compare author, time, title, content, slug, and taxonomy. A slug/search miss or
one empty page is not proof of no creation. Read candidate items and reuse the
matching ID. WordPress core does not promise an idempotency key for creation.
If the result remains ambiguous, report the uncertain partial outcome and ask
the user to resolve it; **do not create another record or blindly replay**.

When the API cannot complete the task and its write state is known, continue
with Gutenberg Options → Code editor (not a Code block), an existing
Classic/TinyMCE Text/Kod tab, or an observed page-builder switch to the standard
editor. Save/preserve content, markup, taxonomy, type, and ID; get fresh AX refs.
Only try `classic-editor` URLs when supported, preserving `post_type` and other
parameters. Do not install/activate a plugin or change site-wide editor settings
without explicit user authorization. Verify the saved/published outcome.

## Example fetch_url arguments

These are templates, not URLs or IDs to use blindly. Substitute the actual
same-origin `ADMIN_URL`, discovered `COLLECTION_URL`, `NONCE`, and the `ITEM_URL`
for the existing/returned ID. `ITEM_READ_URL` is that item URL with `context=edit`.
For a query-form root, examples are `/blog/?rest_route=/wp/v2/posts/42` and
`/blog/?rest_route=/wp/v2/posts/42&context=edit`; do not append `/42` after other
query parameters. The category/tag example applies only to a
type that supports both fields, after resolving IDs 7 and 12 on that site.

Read the session nonce (strict mode off):

```json
{"url":"ADMIN_URL/admin-ajax.php?action=rest-nonce","method":"GET"}
```

Create only when there is no existing record:

```json
{"url":"COLLECTION_URL","method":"POST","headers":{"X-WP-Nonce":"NONCE","Content-Type":"application/json"},"body":"{\"title\":\"Example title\",\"content\":\"<p>Example content.</p>\",\"status\":\"draft\",\"categories\":[7],\"tags\":[12]}"}
```

Update an existing draft instead of creating another (omitted fields survive):

```json
{"url":"ITEM_URL","method":"POST","headers":{"X-WP-Nonce":"NONCE","Content-Type":"application/json"},"body":"{\"content\":\"<p>Updated content.</p>\"}"}
```

Verify the saved record, including after an uncertain update:

```json
{"url":"ITEM_READ_URL","method":"GET","headers":{"X-WP-Nonce":"NONCE"}}
```

After content/taxonomy verification and only when publication is requested:

```json
{"url":"ITEM_URL","method":"POST","headers":{"X-WP-Nonce":"NONCE","Content-Type":"application/json"},"body":"{\"status\":\"publish\"}"}
```

Repeat the item GET to verify `status` and `link`, then read the public permalink.

## References

- [Cookie authentication and X-WP-Nonce](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/)
- [Core REST nonce action](https://developer.wordpress.org/reference/functions/wp_ajax_rest_nonce/)
- [API discovery](https://developer.wordpress.org/rest-api/using-the-rest-api/discovery/)
- [Posts and fields](https://developer.wordpress.org/rest-api/reference/posts/)
- [REST support for custom types and taxonomies](https://developer.wordpress.org/rest-api/extending-the-rest-api/adding-rest-api-support-for-custom-content-types/)
