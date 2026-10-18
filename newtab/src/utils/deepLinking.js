/**
 * Hash routing for the settings modal, e.g. #settings/background/source.
 * (Upstream also routed marketplace items; WebBrain's new tab has no
 * marketplace, so only the settings tab remains.)
 */

import { TAB_TYPES } from '../components/Elements/MainModal/constants/tabConfig';

export const parseDeepLink = (hash = window.location.hash) => {
  if (!hash || hash === '#') {
    return null;
  }

  const [tab, section, subSection] = hash.slice(1).split('/');
  if (tab !== TAB_TYPES.SETTINGS) {
    return null;
  }

  return { tab, section: section || undefined, subSection: subSection || undefined };
};

export const createDeepLink = (tab, options = {}) => {
  const parts = [tab, options.section, options.subSection].filter(Boolean);
  return `#${parts.join('/')}`;
};

/**
 * @param {string} hash - The hash to set
 * @param {boolean} pushToHistory - If true, adds to browser history (default: true)
 */
export const updateHash = (hash, pushToHistory = true) => {
  if (window.history.pushState) {
    if (pushToHistory) {
      window.history.pushState(null, null, hash);
    } else {
      window.history.replaceState(null, null, hash);
    }
  } else {
    window.location.hash = hash;
  }
};

export const onHashChange = (callback) => {
  const handler = () => {
    const deepLink = parseDeepLink();
    if (deepLink) {
      callback(deepLink);
    }
  };

  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
};

export const shouldAutoOpenModal = () => parseDeepLink() !== null;
