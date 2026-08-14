const CHROME_WEB_STORE_DASHBOARD_RE = /^https:\/\/chrome\.google\.com\/webstore\/devconsole(?:[/?#]|$)/i;
const CHROME_WEB_STORE_GALLERY_RE = /^https:\/\/chromewebstore\.google\.com(?:[/?#]|$)/i;
const PROTECTED_DOM_TOOLS = new Set([
  'list_webmcp_tools', 'execute_webmcp_tool',
  'inject_css', 'remove_injected_css', 'execute_js', 'read_console',
  'inspect_network_requests', 'inspect_event_listeners',
  'verify_form', 'get_shadow_dom', 'shadow_dom_query', 'get_frames',
  'iframe_read', 'iframe_click', 'iframe_type', 'upload_file',
  'download_resource_from_page',
  'read_page', 'get_interactive_elements', 'get_accessibility_tree',
  'click_ax', 'set_checked', 'type_ax', 'set_field', 'click', 'type_text',
  'press_keys', 'scroll', 'extract_data', 'inspect_element_styles',
  'patch_element', 'revert_patch', 'highlight_element', 'hover', 'drag_drop',
  'wait_for_element', 'wait_for_stable', 'get_selection', 'find_text',
]);

export function isChromeProtectedPageDomTool(toolName) {
  return PROTECTED_DOM_TOOLS.has(String(toolName || ''));
}

export function chromeProtectedPageForUrl(url) {
  const value = String(url || '').trim();
  if (CHROME_WEB_STORE_DASHBOARD_RE.test(value)) return 'chrome-web-store-developer';
  if (CHROME_WEB_STORE_GALLERY_RE.test(value)) return 'chrome-web-store-gallery';
  return '';
}

export function chromeProtectedPageFailure(url, toolName = '') {
  const protectedPage = chromeProtectedPageForUrl(url);
  if (!protectedPage) return null;
  const name = String(toolName || 'DOM tool');
  const isGallery = protectedPage === 'chrome-web-store-gallery';
  const pageLabel = isGallery ? 'Chrome Web Store' : 'Chrome Web Store Developer Dashboard';
  const manualTarget = isGallery ? 'page' : 'dashboard';
  return {
    success: false,
    dispatched: false,
    noDispatch: true,
    errorCode: 'chrome_protected_page',
    nonRetryable: true,
    nonRetryableScope: `chrome-protected-page:${protectedPage}`,
    protectedPage,
    url: String(url || ''),
    ...(isGallery ? { recoveryTool: 'inspect_viewport' } : {}),
    error: `${name} cannot access the ${pageLabel} because Chrome blocks extension content scripts and debugger attachment on this protected page. Do not retry this or another DOM, fetch, or background-tab tool. Continue manually on the ${manualTarget}. A vision-enabled screenshot may be used once for read-only visual context, but cannot make ${manualTarget} controls interactive.`,
    stopMessage: `Stopped: Chrome protects the ${pageLabel} from extension DOM access. Repeating DOM reads, waits, clicks, typing, script injection, fetches, or debugger-based fallbacks cannot work. Continue manually on the ${manualTarget}.`,
  };
}
