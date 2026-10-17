/* global chrome, browser */
/**
 * New tab -> WebBrain side panel handoff.
 *
 * The task is passed through extension storage (not a runtime message) because
 * the side panel usually is not loaded yet when the user submits. The panel
 * reads it on start-up (ui/newtab-handoff.js in each extension), checks it is fresh and
 * addressed to its own tab, and then:
 *   - Ask: fills the composer and sends (Ask is read-only);
 *   - Act: fills the composer and switches to Act but does NOT send, so the
 *     user always confirms an Act run in the panel.
 */
export const HANDOFF_KEY = 'wbNewtabHandoff';
export const MAX_TASK_LENGTH = 4000;

const hasFirefoxSidebar = () =>
  typeof browser !== 'undefined' && typeof browser?.sidebarAction?.open === 'function';

const extApi = () => {
  if (hasFirefoxSidebar()) return browser;
  return typeof chrome !== 'undefined' && chrome?.runtime?.id ? chrome : null;
};

// sidePanel.open() must run inside the click's synchronous turn, so the tab id
// has to be known before the user submits.
let currentTab = null;
export async function primeCurrentTab() {
  try {
    currentTab = (await extApi()?.tabs?.getCurrent?.()) ?? null;
  } catch {
    currentTab = null;
  }
  return currentTab;
}

export function buildHandoff({ text, mode, tabId, now = Date.now() }) {
  return {
    id: `nt-${now}-${Math.random().toString(36).slice(2, 8)}`,
    tabId,
    text: String(text).slice(0, MAX_TASK_LENGTH),
    mode: mode === 'act' ? 'act' : 'ask',
    createdAt: now,
  };
}

/**
 * Call directly from the submit handler (no await before it) so the browser
 * still sees the user gesture. Resolves true once the panel has been asked to
 * open and the task is stored.
 */
export function submitTask({ text, mode }, api = extApi(), tab = currentTab) {
  if (!api || tab?.id == null) return Promise.reject(new Error('Extension API unavailable'));
  const firefox = hasFirefoxSidebar();
  if (!firefox && !api.sidePanel?.open) return Promise.reject(new Error('Side panel API unavailable'));

  const handoff = buildHandoff({ text, mode, tabId: tab.id });
  const stored = Promise.resolve(api.storage.local.set({ [HANDOFF_KEY]: handoff }));

  let opened;
  try {
    if (firefox) {
      opened = api.sidebarAction.open();
    } else {
      Promise.resolve(
        api.sidePanel.setOptions({ tabId: tab.id, path: 'src/ui/sidepanel.html', enabled: true }),
      ).catch(() => {});
      opened = api.sidePanel.open({ tabId: tab.id });
    }
  } catch (error) {
    opened = Promise.reject(error);
  }

  return Promise.all([stored, opened]).then(
    () => {
      Promise.resolve(api.runtime.sendMessage({ type: 'WB_NEWTAB_PANEL_OPENED', tabId: tab.id })).catch(() => {});
      return true;
    },
    async (error) => {
      // The panel did not open, so the user is told it failed. Take the task back
      // out of storage, otherwise opening the panel by hand within the next 30 s
      // would pick it up and send it as if the submit had worked.
      await stored.catch(() => {});
      await discardHandoff(api, handoff.id);
      throw error;
    },
  );
}

/** Removes the stored hand-off, but only if it is still the one we wrote. */
export async function discardHandoff(api, id) {
  try {
    const current = (await api.storage.local.get(HANDOFF_KEY))?.[HANDOFF_KEY];
    if (!current || current.id === id) await api.storage.local.remove(HANDOFF_KEY);
  } catch {
    // best effort: the panel also drops anything older than 30 s
  }
}

export function canSearch(api = extApi()) {
  return hasFirefoxSidebar() ? typeof api?.search?.search === 'function' : typeof api?.search?.query === 'function';
}

const SAFE_URL_SCHEMES = new Set(['http:', 'https:']);

/** Returns a navigable http(s) URL if the text is one, otherwise null. */
export function toNavigableUrl(input) {
  const value = String(input || '').trim();
  if (!value || /\s/.test(value)) return null;
  try {
    const direct = new URL(value);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      return SAFE_URL_SCHEMES.has(direct.protocol) ? direct.href : null;
    }
  } catch {
    // not an absolute URL; try as a bare host below
  }
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,})(:\d+)?([/?#]\S*)?$/i.test(value)) {
    try {
      const url = new URL(`https://${value}`);
      return SAFE_URL_SCHEMES.has(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Search with the browser's own default engine; never a hard-coded one. */
export async function runSearch(text, api = extApi(), nav = (url) => window.location.assign(url)) {
  const url = toNavigableUrl(text);
  if (url) {
    nav(url);
    return true;
  }
  if (hasFirefoxSidebar() && api?.search?.search) {
    await api.search.search({ query: text, disposition: 'CURRENT_TAB' });
    return true;
  }
  if (api?.search?.query) {
    await api.search.query({ text, disposition: 'CURRENT_TAB' });
    return true;
  }
  throw new Error('Search API unavailable');
}
