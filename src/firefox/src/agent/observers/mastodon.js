import { sanitizeText as sanitizeSharedText } from '../text-sanitize.js';

const sanitizeText = (value, max = 500) => sanitizeSharedText(value, max, { collapseWhitespace: true });

const MASTODON_APP_PATH_RE = /^\/(?:home|deck|web|notifications|explore|public|public\/local|settings|lists|publish|start|get-started|get-started\/profile|getting-started)(?:\/|$)/i;
const DOMAIN_RE = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\b/ig;
const EXPLICIT_HOME_RE = /\b(?:my|home|local|logged[-\s]?in|signed[-\s]?in|own)\s+(?:mastodon\s+)?(?:server|instance|domain|account|host)\s*(?:is|=|:|at|on)?\s*([a-z0-9.-]+\.[a-z]{2,})\b/i;
const EXPLICIT_FROM_RE = /\b(?:from|via|through|using)\s+(?:my\s+)?(?:mastodon\s+)?(?:server|instance|domain|account|host)?\s*([a-z0-9.-]+\.[a-z]{2,})\b/i;
const REMOTE_FOLLOW_PROMPT_RE = /\b(?:sign in to continue|copy and paste this url|enter your (?:mastodon )?(?:server|instance|domain)|home server|server domain|remote follow|authorize interaction|open this page in your home server)\b/i;
const HOME_DOMAIN_FIELD_RE = /\b(?:server|instance|domain|mastodon|fediverse)\b/i;
const FOLLOW_LABEL_RE = /\b(?:button|link)\s+"(?:Follow|Takip et)(?:\s|")/i;
const FOLLOWED_LABEL_RE = /\b(?:button|link)\s+"(?:Following|Unfollow|Takip ediliyor|Takibi b.rak)(?:\s|")/i;

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

export function inferMastodonHomeDomainFromUrl(value) {
  const url = safeUrl(value);
  if (!url) return '';
  const host = normalizedHostname(url.hostname);
  const path = safeDecode(url.pathname);
  if (!host) return '';
  if (MASTODON_APP_PATH_RE.test(path)) return host;
  if (/^\/(?:interact|authorize_interaction)\/?$/i.test(path) && mastodonAccountFromUri(url.searchParams.get('uri'))) return host;
  if (/^\/@[A-Za-z0-9_]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/\d+)?\/?$/i.test(path)) return host;
  return '';
}

export function inferMastodonHomeDomainFromTask(text = '') {
  const raw = String(text || '');
  const explicit = raw.match(EXPLICIT_HOME_RE) || raw.match(EXPLICIT_FROM_RE);
  const direct = normalizeDomain(explicit?.[1]);
  if (direct) return direct;
  const candidates = [];
  let match;
  while ((match = DOMAIN_RE.exec(raw)) !== null) {
    const domain = normalizeDomain(match[1]);
    if (!domain) continue;
    const before = raw.slice(Math.max(0, match.index - 48), match.index).toLowerCase();
    if (/\b(?:my|home|local|logged[-\s]?in|signed[-\s]?in|own|from|via|through|using)\b/.test(before)) candidates.push(domain);
  }
  return candidates.length === 1 ? candidates[0] : '';
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

export function analyzeMastodonPage({ url = '', pageContent = '', taskText = '', previous = null } = {}) {
  const text = String(pageContent || '');
  const currentHome = inferMastodonHomeDomainFromUrl(url);
  const taskHome = inferMastodonHomeDomainFromTask(taskText);
  const homeDomain = currentHome || taskHome || previous?.homeDomain || '';
  const remoteAccount = extractMastodonRemoteAccountFromContext(url, text) || previous?.remoteAccount || null;
  const hasRemoteFollowPrompt = REMOTE_FOLLOW_PROMPT_RE.test(text);
  const hasHomeDomainField = hasRemoteFollowPrompt || (HOME_DOMAIN_FIELD_RE.test(text) && /\b(?:input|textbox|combobox)\b/i.test(text));
  const hasFollowButton = FOLLOW_LABEL_RE.test(text);
  const hasFollowedState = FOLLOWED_LABEL_RE.test(text);
  const onHomeInstance = !!homeDomain && (() => {
    const parsed = safeUrl(url);
    return parsed ? normalizedHostname(parsed.hostname) === homeDomain : false;
  })();
  const onHomeInstanceProfile = !!(onHomeInstance && remoteAccount && /\/@[A-Za-z0-9_]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i.test(safeDecode(safeUrl(url)?.pathname || '')));
  const needsHandoff = !!(homeDomain && (hasRemoteFollowPrompt || hasHomeDomainField));
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

export function mastodonHandoffInstruction(state = {}) {
  const domain = normalizeDomain(state.homeDomain);
  if (!domain || !state.needsHandoff) return '';
  const account = state.remoteAccount?.acct ? ` for ${state.remoteAccount.acct}` : '';
  return `[MASTODON REMOTE FOLLOW HANDOFF: A recoverable remote-follow/sign-in prompt is visible${account}. Enter exactly "${domain}" as the Mastodon home server/domain (domain only; no https://, no profile URL), submit/continue, then finish the follow on ${domain} by clicking the final Follow/Takip et control. Do not mark the row processed until ${domain} shows Following/Takip ediliyor or another visible followed state.]`;
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
    ? `Enter "${state.homeDomain}" in the Mastodon home-server prompt and complete the final Follow/Takip et step before closing the row.`
    : 'Find the signed-in Mastodon home instance and complete the remote-follow handoff before closing the row.';
  return {
    blocked: true,
    blockedMastodonHandoff: !!state.needsHandoff,
    ids: blocked.slice(0, 8),
    error: `progress_update blocked for Mastodon follow row(s): ${blocked.slice(0, 8).join(', ')}. Clicking Follow on the remote instance is not enough. ${handoff} Mark processed only after a visible followed state is observed; use partial/failed done only for unrecoverable errors.`,
  };
}
