import { isLikelyMastodonHost, isMastodonPageUrl } from '../adapters.js';
import { sanitizeText as sanitizeSharedText } from '../text-sanitize.js';

const sanitizeText = (value, max = 500) => sanitizeSharedText(value, max, { collapseWhitespace: true });

const MASTODON_APP_PATH_RE = /^\/(?:home|deck|web|notifications|explore|public|public\/local|settings|lists|publish|start|get-started|get-started\/profile|getting-started)(?:\/|$)/i;
const DOMAIN_RE = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\b/ig;
// An accessibility tree line names an element's role and label:
// `button "Follow" [ref_12]`.
const AX_LABEL_RE = /\b(button|link|menuitem|textbox|combobox|searchbox)\s+"((?:[^"\\]|\\.){1,160})"/g;
const AX_FIELD_ROLES = new Set(['textbox', 'combobox', 'searchbox']);

function normalizedHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

function normalizeDomain(value) {
  const domain = normalizedHostname(value);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return '';
  if (domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) return '';
  return domain;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return /^https?:$/i.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function mastodonAccountFromUrl(value) {
  const url = safeUrl(value);
  if (!url) return null;
  const host = normalizedHostname(url.hostname);
  const path = safeDecode(url.pathname);
  let match = path.match(/^\/@([A-Za-z0-9_]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?:\/\d+)?\/?$/);
  if (match) {
    return { username: match[1], domain: normalizeDomain(match[2]), acct: `${match[1]}@${normalizeDomain(match[2])}` };
  }
  match = path.match(/^\/@([A-Za-z0-9_]+)(?:\/\d+)?\/?$/);
  if (match && host) return { username: match[1], domain: host, acct: `${match[1]}@${host}` };
  match = path.match(/^\/users\/([A-Za-z0-9_]+)(?:\/statuses\/[A-Za-z0-9._:-]+)?\/?$/);
  if (match && host) return { username: match[1], domain: host, acct: `${match[1]}@${host}` };
  return null;
}

function mastodonAccountFromUri(value) {
  const raw = String(value || '').trim();
  const acct = raw.match(/^acct:([A-Za-z0-9_]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/i);
  if (acct) return { username: acct[1], domain: normalizeDomain(acct[2]), acct: `${acct[1]}@${normalizeDomain(acct[2])}` };
  return mastodonAccountFromUrl(raw);
}

function mastodonInteractionRoute(url) {
  return !!url && /^\/(?:interact|authorize_interaction)\/?$/i.test(safeDecode(url.pathname))
    && !!mastodonAccountFromUri(url.searchParams.get('uri'));
}

// The instance a page belongs to when that page is the user's own: an
// instance's app routes, its remote interaction routes, or a remote account's
// profile shown on it.
export function inferMastodonHomeDomainFromUrl(value) {
  const url = safeUrl(value);
  if (!url) return '';
  const host = normalizedHostname(url.hostname);
  const path = safeDecode(url.pathname);
  if (!host) return '';
  if (MASTODON_APP_PATH_RE.test(path) && isLikelyMastodonHost(host)) return host;
  if (mastodonInteractionRoute(url)) return host;
  if (/^\/@[A-Za-z0-9_]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/\d+)?\/?$/i.test(path)) return host;
  return '';
}

// The web domains a request mentions, apart from the servers of the accounts
// it names (@user@host handles and profile links): the candidates for the
// user's own server. Which of them the request names as that server is read
// by a model, in any language.
export function mastodonTaskDomains(text = '') {
  const raw = String(text || '');
  const accountDomains = new Set();
  for (const match of raw.matchAll(/[A-Za-z0-9_.+-]@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) accountDomains.add(normalizeDomain(match[1]));
  for (const match of raw.matchAll(/https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})\/(?:@|users\/)[A-Za-z0-9_]/gi)) {
    accountDomains.add(normalizeDomain(match[1]));
  }
  const domains = new Set();
  for (const match of raw.matchAll(DOMAIN_RE)) {
    const domain = normalizeDomain(match[1]);
    if (domain && !accountDomains.has(domain)) domains.add(domain);
  }
  return [...domains].slice(0, 8);
}

// The one domain a model read the request as naming the user's own server
// (`readHome(domain)` gives "home" or another answer), or '' when none or
// several are.
export function inferMastodonHomeDomainFromTask(text = '', readHome = () => null) {
  const homes = mastodonTaskDomains(text).filter(domain => readHome(domain) === 'home');
  return homes.length === 1 ? homes[0] : '';
}

export function extractMastodonRemoteAccountFromContext(url = '', pageContent = '') {
  const current = mastodonAccountFromUrl(url);
  if (current) return current;
  const text = String(pageContent || '');
  const acct = text.match(/@([A-Za-z0-9_]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  if (acct) return { username: acct[1], domain: normalizeDomain(acct[2]), acct: `${acct[1]}@${normalizeDomain(acct[2])}` };
  const href = text.match(/https?:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/(?:@|users\/)[A-Za-z0-9_][^\s")<]*/i);
  return href ? mastodonAccountFromUrl(href[0]) : null;
}

// The labels of a page's controls and fields, as its accessibility tree text
// names them, for the follow_state readings.
export function mastodonPageLabels(pageContent = '') {
  const controls = new Set();
  const fields = new Set();
  for (const match of String(pageContent || '').matchAll(AX_LABEL_RE)) {
    const label = match[2].replace(/\\(["\\])/g, '$1').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    (AX_FIELD_ROLES.has(match[1]) ? fields : controls).add(label);
  }
  return { controls: [...controls].slice(0, 60), fields: [...fields].slice(0, 12) };
}

// A Mastodon page's follow state. `readFollow(label)` is a model's reading of
// a control or field label (follow_state: follow, following, home_server or
// other), `readHome(domain)` its reading of a domain the request mentions
// (home_instance). An unread label or domain says nothing.
export function analyzeMastodonPage({ url = '', pageContent = '', taskText = '', previous = null,
  readFollow = () => null, readHome = () => null } = {}) {
  const text = String(pageContent || '');
  const parsedUrl = safeUrl(url);
  const currentHome = inferMastodonHomeDomainFromUrl(url);
  const taskHome = inferMastodonHomeDomainFromTask(taskText, readHome);
  const homeDomain = currentHome || taskHome || previous?.homeDomain || '';
  const remoteAccount = extractMastodonRemoteAccountFromContext(url, text) || previous?.remoteAccount || null;
  const { controls, fields } = mastodonPageLabels(text);
  const controlReadings = controls.map(label => readFollow(label));
  const hasFollowButton = controlReadings.includes('follow');
  const hasFollowedState = controlReadings.includes('following');
  const hasHomeDomainField = fields.some(label => readFollow(label) === 'home_server');
  const hasRemoteFollowPrompt = hasHomeDomainField || mastodonInteractionRoute(parsedUrl);
  const onHomeInstance = !!homeDomain && !!parsedUrl && normalizedHostname(parsedUrl.hostname) === homeDomain;
  const onHomeInstanceProfile = !!(onHomeInstance && remoteAccount && /\/@[A-Za-z0-9_]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i.test(safeDecode(parsedUrl?.pathname || '')));
  const needsHandoff = !!(homeDomain && hasRemoteFollowPrompt);
  const canMarkProcessed = !!(hasFollowedState || (onHomeInstanceProfile && !hasFollowButton && !hasRemoteFollowPrompt));

  return {
    site: 'mastodon',
    url: sanitizeText(url, 500),
    homeDomain,
    remoteAccount,
    hasRemoteFollowPrompt,
    hasHomeDomainField,
    hasFollowButton,
    hasFollowedState,
    onHomeInstance,
    onHomeInstanceProfile,
    needsHandoff,
    canMarkProcessed,
    observedAt: Date.now(),
  };
}

export { isMastodonPageUrl };

export function mastodonHandoffInstruction(state = {}) {
  const domain = normalizeDomain(state.homeDomain);
  if (!domain || !state.needsHandoff) return '';
  const account = state.remoteAccount?.acct ? ` for ${state.remoteAccount.acct}` : '';
  return `[MASTODON REMOTE FOLLOW HANDOFF: A recoverable remote-follow/sign-in prompt is visible${account}. Enter exactly "${domain}" as the Mastodon home server/domain (domain only; no https://, no profile URL), submit/continue, then finish the follow on ${domain} with the account's own follow control there. Do not mark the row processed until ${domain} shows the account as followed.]`;
}

export function mastodonProgressGuard(items = [], state = {}) {
  if (!state || state.site !== 'mastodon') return null;
  if (!Array.isArray(items) || !items.length) return null;
  const blocked = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const action = sanitizeText(item.action, 80).toLowerCase();
    if (action && action !== 'follow') continue;
    const status = sanitizeText(item.status, 40).toLowerCase();
    if (state.needsHandoff && ['processed', 'skipped', 'failed'].includes(status)) {
      blocked.push(item.id || item.label || '(missing id)');
      continue;
    }
    if (status === 'processed' && !state.canMarkProcessed && (state.hasRemoteFollowPrompt || state.remoteAccount)) {
      blocked.push(item.id || item.label || '(missing id)');
    }
  }
  if (!blocked.length) return null;
  const handoff = state.homeDomain
    ? `Enter "${state.homeDomain}" in the Mastodon home-server prompt and complete the follow there before closing the row.`
    : 'Find the signed-in Mastodon home instance and complete the remote-follow handoff before closing the row.';
  return {
    blocked: true,
    blockedMastodonHandoff: !!state.needsHandoff,
    ids: blocked.slice(0, 8),
    error: `progress_update blocked for Mastodon follow row(s): ${blocked.slice(0, 8).join(', ')}. Clicking Follow on the remote instance is not enough. ${handoff} Mark processed only after a visible followed state is observed; use partial/failed done only for unrecoverable errors.`,
  };
}
