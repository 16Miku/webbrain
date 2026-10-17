/**
 * Offline stand-in for a site icon: a rounded square with the site's first
 * letter on a colour derived from its host. Upstream Mue loaded
 * icon.horse/icon/<host> for every link, which tells a third party every site
 * the user has bookmarked each time a tab opens.
 */
const PALETTE = ['#3b6ea8', '#2f8f83', '#a85a3b', '#7a4fa3', '#a38a2f', '#b0425b', '#4a7f3a', '#456b8f'];

export function quickLinkTile(rawUrl, name = '') {
  let host;
  try {
    host = new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    host = String(rawUrl || '');
  }
  const label = (name || host || '?').trim();
  const letter = (Array.from(label)[0] || '?').toUpperCase().replace(/[&<>"']/g, '?');
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const colour = PALETTE[hash % PALETTE.length];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="${colour}"/>` +
    `<text x="32" y="43" font-family="sans-serif" font-size="32" font-weight="600" ` +
    `text-anchor="middle" fill="#fff">${letter}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
