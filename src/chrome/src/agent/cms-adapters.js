// Routing hints only: a URL match never establishes CMS identity, credentials,
// content-task authorization, or API mutation permission.
const CMS_NOTES = `
- Only for the user's content task on an observed CMS: verify official API target/model/fields, existing auth and rights. Prefer fetch_url when task scope and API permission allow, before editor failure. Ask stays read-only, including query POSTs. Request /allow-api once only for an otherwise usable API; reuse grants/respect refusal.
- Dashboard cookies are not tokens. Use verified origins; never forward auth across redirects. Arguments/results may expose tokens to model/traces. Strict Secret Handling without safe existing auth means UI; no token scraping, new grants or setup.
- Preserve ID/type/locale/native content/relations and live state. Draft first; reconcile uncertain writes before retry/UI. Read back fields/state and distinguish CMS publication from website visibility. No site-wide publish/deploy/email. Use an observed editor/Code/Text fallback, refresh refs and avoid iframe loops.`;

function route(test) {
  return (url) => {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && test(u);
  };
}

const definitions = [
  ['ghost', route(u => /\/ghost\//.test(u.pathname) || u.pathname === '/ghost'),
    'Ghost: use the verified admin domain /ghost/api/admin/ with a compatible Accept-Version. Session auth needs matching Origin/Referer; background fetch cannot promise that. No JWT signer is provided. Keep posts/pages separate, preserve Lexical and updated_at; publish to the web without newsletter parameters.'],
  ['drupal', route(u => /\/(?:admin\/content|node\/(?:add|\d+\/edit))(?:\/|$)/.test(u.pathname)),
    'Drupal: discover /jsonapi links, bundle UUIDs and negotiated language. Cookie writes need X-CSRF-Token from /session/token; JSON:API may be read-only. Preserve body format and taxonomy UUIDs; moderation may require a supported transition instead of status=true.'],
  ['joomla', route(u => /\/administrator(?:\/index\.php)?\/?$/.test(u.pathname) && ['com_content', 'com_categories'].includes(u.searchParams.get('option'))),
    'Joomla: /api/index.php/v1/content/articles and content/categories need an existing X-Joomla-Token and ACL rights, not just the administrator cookie. Keep catid/language, full articletext and access; use state=0 for a new unpublished article. Workflow-controlled publishing may need the editor.'],
  // The shared root host also serves marketing pages, which need no CMS notes.
  ['webflow', route(u => u.hostname.endsWith('.design.webflow.com') ||
    (['webflow.com', 'www.webflow.com'].includes(u.hostname) &&
      /^\/(?:dashboard(?:\/|$)|design\/[^/]+(?:\/|$))/.test(u.pathname))),
    'Webflow: Data API https://api.webflow.com/v2 needs a site/OAuth token with cms:read/write. Read collection fields and CMS locale IDs; create staged isDraft=true, update the same item, then publish only that verified item. Preserve references and rich-text components; never publish the whole site.'],
  ['shopify', route(u => (u.hostname === 'admin.shopify.com' && /^\/store\//.test(u.pathname)) || (u.hostname.endsWith('.myshopify.com') && /^\/admin(?:\/|$)/.test(u.pathname))),
    'Shopify: use the verified shop .myshopify.com Admin GraphQL endpoint with a supported dated version and X-Shopify-Access-Token. Storefront API/cookies are insufficient. Both query and mutation POSTs are gated. Articles/pages support isPublished=false; blogs have no draft flag. Check errors and userErrors.'],
  ['wix', route(u => ['manage.wix.com', 'editor.wix.com', 'editor.wixstudio.com'].includes(u.hostname)),
    'Wix Blog: https://www.wixapis.com/blog/v3 uses an existing authorized app/user token or API key plus wix-site-id, with Manage Blog. Keep draftPostId/postId, richContent, categoryIds/tagIds and language; publish the verified draft, not the entire site. Dashboard cookies are insufficient.'],
  ['strapi', route(u => /\/admin\/content-manager(?:\/|$)/.test(u.pathname)),
    'Strapi: verify major version and Content API auth separately from admin login. In v5 use /api/<pluralApiId>/<documentId>, locale and explicit status=draft; REST writes otherwise publish. Populate needed relations/components. If Draft & Publish is off, use UI instead of public creation.'],
  ['contentful', route(u => ['app.contentful.com', 'app.eu.contentful.com'].includes(u.hostname) && /^\/spaces\//.test(u.pathname)),
    'Contentful: CMA api.contentful.com (or verified EU origin), space/environment, management bearer token and role rights are required; Delivery/Preview tokens cannot write. Read all locales/fields before PUT, preserve links, use X-Contentful-Version, and publish the same entry only after validation.'],
  ['sanity', route(u => u.hostname.endsWith('.sanity.studio')),
    'Sanity: confirm project/dataset/schema and dated API version at <project>.api.sanity.io. Use existing write bearer auth; custom Studio cookies may not reach that origin. Read exact draft/published IDs with raw perspective; patch with ifRevisionID and publish via documented Actions with revision guards. Preserve Portable Text and references.'],
];

export const CMS_ADAPTERS = definitions.map(([name, matches, hint]) => ({
  name: `cms-${name}`,
  category: 'general',
  matches,
  notes: `${CMS_NOTES}\n- ${hint}`,
}));
