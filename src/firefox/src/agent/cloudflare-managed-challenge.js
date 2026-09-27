// Shared, browser-neutral state transitions for Cloudflare interstitial
// Challenge Pages. This file is mirrored in the Firefox tree; keep both
// copies byte-identical.

export const CLOUDFLARE_MITIGATED_HEADER = 'cf-mitigated';
export const CLOUDFLARE_MITIGATED_CHALLENGE = 'challenge';

export function cloudflareChallengeDocumentKey(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return `${parsed.origin}${parsed.pathname}`.slice(0, 1000);
  } catch {
    return '';
  }
}

export function isCloudflareChallengePlatformUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return /^\/cdn-cgi\/challenge-platform(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function responseHeaderValue(headers, name) {
  const target = String(name || '').toLowerCase();
  for (const header of Array.isArray(headers) ? headers : []) {
    if (String(header?.name || '').toLowerCase() !== target) continue;
    return String(header?.value || '').trim().toLowerCase();
  }
  return '';
}

export function cloudflareChallengeResponseTransition(current, details, now = Date.now()) {
  if (details?.type !== 'main_frame' || !Number.isInteger(details?.tabId) || details.tabId < 0) {
    return { state: current || null, changed: false, kind: 'ignored' };
  }
  const challenged = responseHeaderValue(
    details.responseHeaders,
    CLOUDFLARE_MITIGATED_HEADER,
  ) === CLOUDFLARE_MITIGATED_CHALLENGE;
  if (!challenged) {
    return current
      ? { state: null, changed: true, kind: 'cleared_by_response' }
      : { state: null, changed: false, kind: 'unchanged' };
  }
  const documentKey = cloudflareChallengeDocumentKey(details.url);
  if (!documentKey) return { state: current || null, changed: false, kind: 'ignored' };
  return {
    state: {
      active: true,
      documentKey,
      detectedAt: current?.documentKey === documentKey
        ? Number(current.detectedAt) || now
        : now,
      lastResponseAt: now,
      lastChallengePlatformActivityAt: current?.documentKey === documentKey
        ? Number(current.lastChallengePlatformActivityAt) || 0
        : 0,
    },
    changed: true,
    kind: current?.active ? 'retained_by_response' : 'armed_by_response',
  };
}

export function cloudflareChallengePlatformTransition(current, details, now = Date.now()) {
  if (
    !current?.active
    || !Number.isInteger(details?.tabId)
    || details.tabId < 0
    || !isCloudflareChallengePlatformUrl(details.url)
  ) {
    return { state: current || null, changed: false, kind: 'ignored' };
  }
  return {
    state: {
      ...current,
      lastChallengePlatformActivityAt: now,
    },
    changed: true,
    kind: 'retained_by_platform_activity',
  };
}

export function cloudflareChallengeNavigationTransition(current, details) {
  if (!current?.active || details?.frameId !== 0) {
    return { state: current || null, changed: false, kind: 'ignored' };
  }
  const documentKey = cloudflareChallengeDocumentKey(details.url);
  if (!documentKey || documentKey === current.documentKey) {
    return { state: current, changed: false, kind: 'unchanged' };
  }
  return { state: null, changed: true, kind: 'cleared_by_navigation' };
}

export function cloudflareManagedChallengeStorageKey(tabId) {
  return `cloudflareManagedChallenge:${tabId}`;
}

export function normalizeCloudflareManagedChallengeState(value) {
  if (!value?.active) return null;
  const documentKey = cloudflareChallengeDocumentKey(value.documentKey);
  if (!documentKey) return null;
  return {
    active: true,
    documentKey,
    detectedAt: Math.max(0, Number(value.detectedAt) || 0),
    lastResponseAt: Math.max(0, Number(value.lastResponseAt) || 0),
    lastChallengePlatformActivityAt: Math.max(
      0,
      Number(value.lastChallengePlatformActivityAt) || 0,
    ),
  };
}

export function cloudflareManagedChallengeGateState(signal) {
  const normalized = normalizeCloudflareManagedChallengeState(signal);
  if (!normalized) return null;
  const publicGate = {
    status: 'manual_required',
    cloudflareManagedChallenge: true,
    challengeDialog: { label: 'Cloudflare managed challenge interstitial' },
    diagnostics: {
      vendors: ['cloudflare'],
      frames: [],
      responseHeaderSignal: true,
      challengePlatformActivity: normalized.lastChallengePlatformActivityAt > 0,
    },
  };
  return {
    key: `${normalized.documentKey}\ncloudflare managed challenge interstitial`,
    status: 'manual_required',
    cloudflareManagedChallenge: true,
    cloudflareSignal: normalized,
    publicGate,
  };
}
