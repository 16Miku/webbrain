/**
 * WebBrain Companion banner at the bottom of the new tab.
 *
 * Invites the user to install WebBrain Companion, the tray app that serves their Claude,
 * ChatGPT, Google, Grok and Kimi subscriptions to WebBrain on 127.0.0.1. Whether to show it is
 * decided from extension storage alone: the page makes no request to the companion's port or
 * to webbrain.one for it. It goes away for good once the user dismisses it, and is not shown
 * while WebBrain already has a Companion provider with a model saved (the providers manager in
 * src/{chrome,firefox}/src/providers/manager.js keeps them under `providers`, keyed by id;
 * a duplicated card carries `duplicateOf`).
 */
export const COMPANION_PROMO_DISMISSED_KEY = 'wbNewtabCompanionPromoDismissed';
export const COMPANION_PAGE = 'https://www.webbrain.one/companion/';
const COMPANION_PROVIDER_ID = 'webbrain_companion';
// Languages the companion page is translated into (web/companion/<code>/); the rest get English.
const COMPANION_PAGE_LOCALES = new Set(
  'ar bn de es fa fr he hi id ja ko ms nl pt ru th tl tr uk vi zh'.split(' '),
);

// The plans the demo cycles through. `logo` names a mark in assets/providers (picked up by
// CompanionPromo.jsx), drawn on a `tile` background; `color` tints the packets and highlights;
// `left` is the share of the plan still available, drawn as the meter under the mark.
export const DEMO_PLANS = [
  {
    name: 'Claude Max',
    logo: 'anthropic',
    tile: '#d97757',
    color: '#d97757',
    left: 64,
  },
  {
    name: 'ChatGPT Pro',
    logo: 'openai',
    tile: '#0d0d0d',
    color: '#10a37f',
    left: 57,
  },
  {
    name: 'Google AI Pro',
    logo: 'gemini',
    tile: '#ffffff',
    color: '#3186ff',
    left: 71,
  },
  {
    name: 'SuperGrok',
    logo: 'xai',
    tile: '#0d0d0d',
    color: '#9ca3af',
    left: 38,
  },
  { name: 'Kimi', logo: 'kimi', tile: '#ffffff', color: '#027aff', left: 83 },
];

export function companionPageUrl(locale) {
  const code = String(locale || '')
    .slice(0, 2)
    .toLowerCase();
  return COMPANION_PAGE_LOCALES.has(code) ? `${COMPANION_PAGE}${code}/` : COMPANION_PAGE;
}

/** True when WebBrain has a Companion provider with a model chosen, i.e. it is already set up. */
export function hasCompanionProvider(providers) {
  if (!providers || typeof providers !== 'object') return false;
  return Object.entries(providers).some(
    ([id, config]) =>
      (config?.duplicateOf || id) === COMPANION_PROVIDER_ID &&
      typeof config?.model === 'string' &&
      config.model.trim() !== '',
  );
}

/** Extension storage on either browser, or null in a plain preview page. */
export function promoStorage(env = globalThis) {
  const area =
    (typeof env.browser !== 'undefined' && env.browser?.storage?.local) ||
    (typeof env.chrome !== 'undefined' && env.chrome?.storage?.local) ||
    null;
  return area && typeof area.get === 'function' && typeof area.set === 'function' ? area : null;
}

/** Resolves whether to show the banner. Never throws; storage that cannot be read hides it. */
export async function shouldShowCompanionPromo(storage = promoStorage()) {
  // A plain preview page (vite dev) has no extension storage; show it there so it can be worked on.
  if (!storage) return true;
  try {
    const stored = (await storage.get([COMPANION_PROMO_DISMISSED_KEY, 'providers'])) || {};
    return !stored[COMPANION_PROMO_DISMISSED_KEY] && !hasCompanionProvider(stored.providers);
  } catch {
    return false;
  }
}

/** Hide the banner on every new tab from now on. */
export async function dismissCompanionPromo(storage = promoStorage()) {
  try {
    await storage?.set({ [COMPANION_PROMO_DISMISSED_KEY]: Date.now() });
  } catch {
    // The banner is already gone from this tab; the next tab may show it again.
  }
}
