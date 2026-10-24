// The agent's side of automatic cookie-banner declining (cookie-banner-host.js
// does the work). Called before screenshots and model calls: it lets a decline
// in progress finish, then tells the model about declines it might otherwise
// see as a banner in an earlier screenshot and try to click.
//
// The note is trusted runtime text: the CMP name comes from WebBrain's bundled
// rules, never from the page. Model-facing text stays English (see
// docs/localization.md, "Agent-emitted copy").

export function cookieBannerNoteText(notes = []) {
  const parts = notes.slice(0, 4).map(({ cmp, cosmetic }) => {
    const which = cmp ? `the ${cmp} cookie banner` : 'a cookie banner';
    return cosmetic ? `hid ${which}` : `declined ${which}`;
  });
  if (!parts.length) return '';
  return `[Cookie banners: WebBrain automatically ${parts.join(' and ')} on this page. `
    + 'If an earlier screenshot shows it, it is gone now; do not look for it or click it.]';
}

export async function settleCookieBannersForTurn(host, tabId, messages) {
  if (!host || typeof host.prepareTurn !== 'function' || !Array.isArray(messages)) return false;
  let notes = [];
  try {
    notes = await host.prepareTurn(tabId);
  } catch {
    return false;
  }
  const text = Array.isArray(notes) ? cookieBannerNoteText(notes) : '';
  if (!text) return false;
  // Same shape as the navigation notices the agent already pushes mid-run.
  messages.push({ role: 'user', content: text });
  return true;
}
