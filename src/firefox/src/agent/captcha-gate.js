const CHALLENGE_DIALOG_RE = /\b(?:(?:re|h|fun)?captcha|security verification|human verification|verify (?:that )?you(?:'|\u2019)re (?:a )?human|verify (?:that )?you are (?:a )?human|are you (?:a )?human|robot check|challenge verification)\b/i;
const CHALLENGE_FAILURE_RE = /\b(?:verification (?:failed|error|unsuccessful|expired|timed out)|could not verify|unable to verify)\b/i;
const CHALLENGE_CONTEXT_RE = /\b(?:(?:re|h|fun)?captcha|human|robot|challenge)\b/i;

function matchesChallengeLabel(value, allowGenericFailure = false) {
  const text = String(value || '');
  return CHALLENGE_DIALOG_RE.test(text)
    || (
      CHALLENGE_FAILURE_RE.test(text)
      && (allowGenericFailure || CHALLENGE_CONTEXT_RE.test(text))
    );
}

function normalizeChallengeLabel(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 160);
}

function parseSerializedTreeLabel(line) {
  const input = String(line || '');
  const start = input.indexOf('"');
  if (start < 0) return '';
  let escaped = false;
  const maxEnd = Math.min(input.length, start + 1002);
  for (let index = start + 1; index < maxEnd; index += 1) {
    const char = input[index];
    if (char === '"' && !escaped) {
      try {
        const parsed = JSON.parse(input.slice(start, index + 1));
        return typeof parsed === 'string' ? parsed.trim().slice(0, 200) : '';
      } catch {
        return '';
      }
    }
    if (char === '\\' && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  return '';
}

export function detectChallengeDialog(pageContent, options = null) {
  const allowGenericFailure = options?.allowGenericFailure === true;
  const lines = String(pageContent || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const dialogMatch = line.match(/^(\s*)(?:dialog|alertdialog)(?=\s|$)/i);
    if (!dialogMatch) continue;
    const dialogIndent = dialogMatch[1].length;
    const ownLabel = parseSerializedTreeLabel(line);
    if (ownLabel && matchesChallengeLabel(ownLabel, allowGenericFailure)) {
      return {
        label: ownLabel,
        normalizedLabel: normalizeChallengeLabel(ownLabel),
      };
    }
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const childLine = lines[childIndex];
      if (!childLine.trim()) continue;
      const childIndent = childLine.match(/^\s*/)?.[0].length || 0;
      if (childIndent <= dialogIndent) break;
      const childLabel = parseSerializedTreeLabel(childLine);
      if (!childLabel || !matchesChallengeLabel(childLabel, allowGenericFailure)) continue;
      return {
        label: childLabel,
        normalizedLabel: normalizeChallengeLabel(childLabel),
      };
    }
  }
  return null;
}

// Serialized into the page for a lightweight, read-only preflight before
// model-authored mutations. Keep this function self-contained.
export function detectChallengeDialogInPage(options = null) {
  const includeFrameContext = options?.includeFrameContext === true;
  const allowGenericFailure = options?.allowGenericFailure === true;
  const pageWindow = typeof window !== 'undefined' ? window : null;
  const pageLocation = pageWindow?.location
    || (typeof location !== 'undefined' ? location : null);
  const frameUrl = pageLocation ? String(pageLocation.href || '') : '';
  let frameName = '';
  try {
    frameName = pageWindow ? String(pageWindow.name || '') : '';
  } catch {}
  if (typeof document === 'undefined' || !document?.querySelectorAll) {
    return includeFrameContext
      ? { challenge: null, frameContext: { frameUrl, frameName, childFrames: [] } }
      : null;
  }
  const challengeRe = /\b(?:(?:re|h|fun)?captcha|security verification|human verification|verify (?:that )?you(?:'|\u2019)re (?:a )?human|verify (?:that )?you are (?:a )?human|are you (?:a )?human|robot check|challenge verification)\b/i;
  const challengeFailureRe = /\b(?:verification (?:failed|error|unsuccessful|expired|timed out)|could not verify|unable to verify)\b/i;
  const challengeContextRe = /\b(?:(?:re|h|fun)?captcha|human|robot|challenge)\b/i;
  const matchesChallenge = value => {
    const text = String(value || '');
    return challengeRe.test(text)
      || (
        challengeFailureRe.test(text)
        && (allowGenericFailure || challengeContextRe.test(text))
      );
  };
  const visible = (element) => {
    try {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number'
        ? window.innerWidth
        : (typeof innerWidth === 'number' ? innerWidth : rect.right);
      const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number'
        ? window.innerHeight
        : (typeof innerHeight === 'number' ? innerHeight : rect.bottom);
      return rect.bottom > 0
        && rect.right > 0
        && rect.top < viewportHeight
        && rect.left < viewportWidth;
    } catch {
      return false;
    }
  };
  const childFrames = Array.from(document.querySelectorAll('iframe')).map((element, index) => {
    let loadedUrl = '';
    try {
      loadedUrl = String(element.contentWindow?.location?.href || '');
    } catch {}
    return {
      index,
      url: String(element.getAttribute?.('src') || element.src || ''),
      loadedUrl,
      name: String(element.getAttribute?.('name') || element.name || ''),
      visible: visible(element),
    };
  });
  const finish = challenge => includeFrameContext
    ? {
        challenge,
        frameContext: {
          frameUrl,
          frameName,
          childFrames,
        },
      }
    : challenge;
  for (const element of document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]')) {
    if (!visible(element)) continue;
    let labelledBy = '';
    try {
      labelledBy = String(element.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map(id => document.getElementById(id)?.textContent || '')
        .join(' ');
    } catch {}
    const values = [
      element.getAttribute?.('aria-label'),
      labelledBy,
      element.querySelector?.('h1, h2, h3, [role="heading"]')?.textContent,
      element.getAttribute?.('title'),
      element.innerText,
      element.textContent,
    ];
    for (const value of values) {
      const text = String(value || '');
      if (!matchesChallenge(text)) continue;
      // Return the dialog's full label, not the matched keyword, so the gate
      // key built here matches the one built from the accessibility-tree
      // dialog name and the same challenge is never keyed two ways.
      const line = text.split(/\r?\n/).find(entry => matchesChallenge(entry)) || text;
      const label = line.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (label) return finish({ label });
    }
  }
  return finish(null);
}

export function captchaChallengeKey(pageUrl, normalizedLabel) {
  let normalizedUrl = String(pageUrl || '').trim();
  try {
    const parsed = new URL(normalizedUrl);
    parsed.hash = '';
    normalizedUrl = parsed.href;
  } catch {
    normalizedUrl = normalizedUrl.split('#')[0];
  }
  return `${normalizedUrl}\n${normalizeChallengeLabel(normalizedLabel)}`;
}

export function sanitizeCaptchaFrameUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.origin}${parsed.pathname}`;
    }
    if (parsed.protocol === 'about:') return `${parsed.protocol}${parsed.pathname}`;
    return `${parsed.protocol}//`;
  } catch {
    return raw.split(/[?#]/)[0].slice(0, 300);
  }
}

export function captchaVendorFromUrl(value) {
  const url = String(value || '').toLowerCase();
  if (!url) return 'unknown';
  if (/arkoselabs|funcaptcha|fc-api/.test(url)) return 'arkose';
  if (/recaptcha|google\.com\/recaptcha|recaptcha\.net/.test(url)) return 'recaptcha';
  if (/hcaptcha/.test(url)) return 'hcaptcha';
  if (/challenges\.cloudflare|turnstile/.test(url)) return 'turnstile';
  if (/geetest/.test(url)) return 'geetest';
  if (/datadome/.test(url)) return 'datadome';
  if (/mtcaptcha/.test(url)) return 'mtcaptcha';
  if (/awswaf|aws-waf|captcha\.aws/.test(url)) return 'aws_waf';
  if (/perimeterx|px-captcha/.test(url)) return 'perimeterx';
  return 'unknown';
}

export function buildCaptchaDiagnostics({
  candidates = [],
  frameContexts = [],
  navigationFrames = [],
} = {}) {
  const rows = [];
  const seen = new Set();
  const addFrame = ({ frameId = null, parentFrameId = null, frameUrl = '', source, visible = null }) => {
    const sanitizedUrl = sanitizeCaptchaFrameUrl(frameUrl);
    if (!sanitizedUrl) return;
    const vendor = captchaVendorFromUrl(frameUrl);
    const key = `${frameId ?? ''}|${parentFrameId ?? ''}|${sanitizedUrl}|${source}`;
    if (seen.has(key) || rows.length >= 40) return;
    seen.add(key);
    rows.push({
      frameId: Number.isInteger(frameId) ? frameId : null,
      ...(Number.isInteger(parentFrameId) ? { parentFrameId } : {}),
      frameUrl: sanitizedUrl,
      vendor,
      source,
      ...(typeof visible === 'boolean' ? { visible } : {}),
    });
  };

  for (const frame of navigationFrames || []) {
    addFrame({
      frameId: frame?.frameId,
      parentFrameId: frame?.parentFrameId,
      frameUrl: frame?.url,
      source: 'navigation',
    });
  }
  for (const context of frameContexts || []) {
    addFrame({
      frameId: context?.frameId,
      frameUrl: context?.frameUrl,
      source: 'document',
    });
    for (const child of context?.childFrames || []) {
      addFrame({
        frameUrl: child?.loadedUrl || child?.url,
        source: 'embedded',
        visible: child?.visible,
      });
    }
  }
  for (const candidate of candidates || []) {
    addFrame({
      frameId: candidate?.frameId,
      frameUrl: candidate?.frameUrl,
      source: 'candidate',
      visible: candidate?.visible,
    });
  }

  const candidateTypes = [...new Set(
    (candidates || []).map(candidate => String(candidate?.type || '').trim()).filter(Boolean)
  )].sort();
  const candidateVendors = candidateTypes.map((type) => {
    if (type.startsWith('recaptcha')) return 'recaptcha';
    if (type === 'hcaptcha') return 'hcaptcha';
    if (type === 'turnstile' || type === 'cloudflare' || type === 'cf_turnstile') return 'turnstile';
    return 'unknown';
  });
  const vendors = [...new Set(
    [...rows.map(row => row.vendor), ...candidateVendors].filter(vendor => vendor !== 'unknown')
  )].sort();
  return {
    vendors,
    candidateTypes,
    supportedCandidateCount: Array.isArray(candidates) ? candidates.length : 0,
    frames: rows,
  };
}
