/* global chrome */
/**
 * The new tab is opt-in.
 *
 * An extension cannot switch its `chrome_url_overrides.newtab` on and off while it
 * runs - the manifest declares it for as long as the extension is installed. So the
 * page is always what the browser opens for a new tab, and this gate decides, before
 * anything heavy loads, whether to show it or hand the tab over to the browser's own
 * new tab page. The choice is `newTabEnabled` in extension storage, written by the
 * last step of the side panel's onboarding and by Settings -> General. Anything but
 * `true` (never asked, declined, an older profile) hands the tab over.
 *
 * `chrome://newtab` is this very override, so the tab is sent to the page the browser
 * shows for it instead:
 *   - Chrome and other Chromium browsers: `chrome://new-tab-page/` (checked on Chromium
 *     with the extension loaded).
 *   - Microsoft Edge: `chrome-search://local-ntp/local-ntp.html`; Edge does not serve
 *     `chrome://new-tab-page/` (reported in the Chromium Extensions group, not checked here).
 *   - Firefox: there is no way. `tabs.update` rejects `about:home` and `about:newtab`
 *     ("Illegal URL") and script navigation to them is denied (checked on Firefox 141), so the
 *     Firefox manifest does not declare the override at all and this page is never its new tab.
 */
export const NEWTAB_ENABLED_KEY = 'newTabEnabled';
export const CHROME_DEFAULT_NEWTAB = 'chrome://new-tab-page/';
export const EDGE_DEFAULT_NEWTAB = 'chrome-search://local-ntp/local-ntp.html';

const isEdge = (env) => {
  const nav = env.navigator;
  if (!nav) return false;
  if (nav.userAgentData?.brands?.some((b) => /microsoft edge/i.test(b?.brand || ''))) return true;
  return /\bEdg(e|A|iOS)?\//.test(nav.userAgent || '');
};

const handoverTarget = (env) => {
  // Firefox (the only host with `browser.sidebarAction`) cannot load any page of its own.
  if (typeof env.browser !== 'undefined' && typeof env.browser?.sidebarAction?.open === 'function') return null;
  if (typeof env.chrome === 'undefined' || !env.chrome?.runtime?.id) return null;
  return { api: env.chrome, url: isEdge(env) ? EDGE_DEFAULT_NEWTAB : CHROME_DEFAULT_NEWTAB };
};

/**
 * Resolves true when the WebBrain new tab should render, false when this tab was handed to
 * the browser's own new tab page. It fails towards rendering: with no extension APIs (a dev
 * preview), a browser that cannot hand the tab over, unreadable storage or a tab that cannot be
 * redirected the user still gets a page, never a blank tab.
 */
export async function shouldShowWebBrainNewTab(env = globalThis) {
  const target = handoverTarget(env);
  if (!target) return true;
  try {
    const stored = await target.api.storage.local.get(NEWTAB_ENABLED_KEY);
    if (stored?.[NEWTAB_ENABLED_KEY] === true) return true;
  } catch {
    return true;
  }
  try {
    const tab = await target.api.tabs.getCurrent();
    if (!tab || tab.id == null) return true;
    await target.api.tabs.update(tab.id, { url: target.url });
    return false;
  } catch {
    return true;
  }
}
