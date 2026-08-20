import { applyDOMTranslations, t } from './i18n.js';

const GUIDES = {
  chrome: { name: 'Google Chrome', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
  edge: { name: 'Microsoft Edge', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
  brave: { name: 'Brave', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
  vivaldi: { name: 'Vivaldi', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
  opera: { name: 'Opera', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
  firefox: { name: 'Firefox', openKey: 'install.open_sidebar', failureKey: 'install.open_failed_firefox' },
  chromium: { name: 'Chromium', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
  unknown: { name: 'Browser', openKey: 'install.open_panel', failureKey: 'install.open_failed_chromium' },
};

function browserBrands(navigatorLike) {
  return (navigatorLike?.userAgentData?.brands || [])
    .map((entry) => String(entry?.brand || '').toLowerCase())
    .join(' ');
}

export async function detectBrowser(navigatorLike = globalThis.navigator) {
  try {
    if (await navigatorLike?.brave?.isBrave?.()) return 'brave';
  } catch {
    // Brave detection is an optional progressive enhancement.
  }

  const ua = String(navigatorLike?.userAgent || '');
  const brands = browserBrands(navigatorLike);
  if (/Firefox\//i.test(ua)) return 'firefox';
  if (/\bEdg(?:e|A|iOS)?\//i.test(ua) || brands.includes('microsoft edge')) return 'edge';
  if (/\bOPR\//i.test(ua) || brands.includes('opera')) return 'opera';
  if (/\bVivaldi\//i.test(ua) || brands.includes('vivaldi')) return 'vivaldi';
  if (brands.includes('google chrome')) return 'chrome';
  if (/\b(?:Chrome|Chromium)\//i.test(ua) || brands.includes('chromium')) return 'chromium';
  return 'unknown';
}

export function getBrowserGuide(browserKey) {
  return GUIDES[browserKey] || GUIDES.unknown;
}

export function selectInstallFeature(feature, { documentLike = globalThis.document } = {}) {
  const tabs = Array.from(documentLike?.querySelectorAll?.('[data-feature]') || []);
  const panels = Array.from(documentLike?.querySelectorAll?.('[data-feature-panel]') || []);
  if (!tabs.some((tab) => tab.dataset.feature === feature)) return false;

  for (const tab of tabs) {
    const selected = tab.dataset.feature === feature;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) {
    panel.hidden = panel.dataset.featurePanel !== feature;
  }
  return true;
}

export function initializeFeatureShowcase({ documentLike = globalThis.document } = {}) {
  const tabs = Array.from(documentLike?.querySelectorAll?.('[data-feature]') || []);
  if (tabs.length === 0) return false;

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      selectInstallFeature(tab.dataset.feature, { documentLike });
    });
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = Math.max(0, tabs.indexOf(tab));
      let nextIndex = currentIndex;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
      else nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      const nextTab = tabs[nextIndex];
      selectInstallFeature(nextTab.dataset.feature, { documentLike });
      nextTab.focus();
    });
  }
  return selectInstallFeature(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.feature || tabs[0].dataset.feature, { documentLike });
}

/**
 * Keep the open calls in the click handler's synchronous turn. Both Chrome's
 * sidePanel.open() and Firefox's sidebarAction.open() require a user gesture.
 */
export function openInstalledPanel({ build, tabId, chromeApi = globalThis.chrome, browserApi = globalThis.browser } = {}) {
  if (build === 'firefox') {
    if (!browserApi?.sidebarAction?.open) {
      throw new Error('Sidebar API unavailable');
    }
    return browserApi.sidebarAction.open();
  }

  if (tabId == null || !chromeApi?.sidePanel?.open) {
    throw new Error('Side panel API unavailable');
  }
  chromeApi.sidePanel.setOptions({
    tabId,
    path: 'src/ui/sidepanel.html',
    enabled: true,
  }).catch?.(() => {});
  return chromeApi.sidePanel.open({ tabId });
}

export function reportInstalledPanelOpened({
  build,
  tabId,
  chromeApi = globalThis.chrome,
  browserApi = globalThis.browser,
} = {}) {
  const runtime = build === 'firefox' ? browserApi?.runtime : chromeApi?.runtime;
  if (!runtime?.sendMessage || tabId == null) return Promise.resolve(false);
  return Promise.resolve(runtime.sendMessage({
    type: 'WB_INSTALL_PANEL_OPENED',
    tabId,
  })).then(() => true);
}

async function getInstallTab(build) {
  const tabs = build === 'firefox'
    ? globalThis.browser?.tabs
    : globalThis.chrome?.tabs;
  try {
    return await tabs?.getCurrent?.();
  } catch {
    return null;
  }
}

async function hydrateGuide() {
  applyDOMTranslations(document);
  initializeFeatureShowcase();

  const build = document.documentElement.dataset.build;
  const [browserKey, installTab] = await Promise.all([
    detectBrowser(),
    getInstallTab(build),
  ]);
  const guide = getBrowserGuide(browserKey);
  document.documentElement.dataset.browser = browserKey;
  document.getElementById('browser-label').textContent = t('install.browser.detected', { browser: guide.name });

  const openButton = document.getElementById('open-panel-button');
  const openLabel = document.getElementById('open-panel-label');
  const status = document.getElementById('open-panel-status');
  openLabel.textContent = t(guide.openKey);

  openButton.addEventListener('click', () => {
    openButton.classList.add('is-opening');
    openButton.disabled = true;
    openButton.setAttribute('aria-busy', 'true');
    status.classList.remove('is-error');
    status.textContent = '';

    let opening;
    try {
      opening = openInstalledPanel({ build, tabId: installTab?.id });
    } catch {
      opening = Promise.reject(new Error('Panel unavailable'));
    }

    Promise.resolve(opening).then(() => {
      openButton.classList.remove('is-opening');
      openButton.disabled = false;
      openButton.removeAttribute('aria-busy');
      status.textContent = '';
      reportInstalledPanelOpened({ build, tabId: installTab?.id }).catch(() => {});
    }).catch(() => {
      openButton.classList.remove('is-opening');
      openButton.disabled = false;
      openButton.removeAttribute('aria-busy');
      status.classList.add('is-error');
      status.textContent = t(guide.failureKey);
    });
  });
  openButton.disabled = false;

  if (build === 'firefox') {
    document.getElementById('shortcut-hint')?.remove();
  }
}

if (typeof document !== 'undefined') {
  hydrateGuide().catch(() => {
    const build = document.documentElement.dataset.build;
    const guide = getBrowserGuide(build === 'firefox' ? 'firefox' : 'unknown');
    const status = document.getElementById('open-panel-status');
    if (status) {
      status.classList.add('is-error');
      status.textContent = t(guide.failureKey);
    }
  });
}
