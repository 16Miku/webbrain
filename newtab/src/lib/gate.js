/* global chrome, browser */
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
 * Neither browser lets an extension load its default new tab by that name
 * (`chrome://newtab` is this very override, `about:newtab` is a privileged URL in
 * Firefox), so the tab is sent to the page the browser shows for it instead.
 */
export const NEWTAB_ENABLED_KEY = 'newTabEnabled';
export const CHROME_DEFAULT_NEWTAB = 'chrome://new-tab-page/';
export const FIREFOX_DEFAULT_NEWTAB = 'about:home';

const extensionApi = (env) => {
  if (typeof env.browser !== 'undefined' && typeof env.browser?.sidebarAction?.open === 'function') {
    return { api: env.browser, url: FIREFOX_DEFAULT_NEWTAB };
  }
  if (typeof env.chrome !== 'undefined' && env.chrome?.runtime?.id) {
    return { api: env.chrome, url: CHROME_DEFAULT_NEWTAB };
  }
  return null;
};

/**
 * Resolves true when the WebBrain new tab should render, false when this tab was handed to
 * the browser's own new tab page. It fails towards rendering: with no extension APIs (a dev
 * preview), unreadable storage or a tab that cannot be redirected the user still gets a page,
 * never a blank tab.
 */
export async function shouldShowWebBrainNewTab(env = globalThis) {
  const ext = extensionApi(env);
  if (!ext) return true;
  try {
    const stored = await ext.api.storage.local.get(NEWTAB_ENABLED_KEY);
    if (stored?.[NEWTAB_ENABLED_KEY] === true) return true;
  } catch {
    return true;
  }
  try {
    const tab = await ext.api.tabs.getCurrent();
    if (!tab || tab.id == null) return true;
    await ext.api.tabs.update(tab.id, { url: ext.url });
    return false;
  } catch {
    return true;
  }
}
