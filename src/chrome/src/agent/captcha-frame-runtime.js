// Shared, page-facing helpers for frame-aware CAPTCHA detection and token
// injection. This file is mirrored in the Firefox tree; keep both copies
// byte-identical so the two extension builds make the same decisions.

const TYPE_ALIASES = new Map([
  ['recaptchav2', 'recaptcha_v2'],
  ['recaptcha_v2', 'recaptcha_v2'],
  ['recaptcha_enterprise', 'recaptcha_v2_enterprise'],
  ['recaptcha_v2_enterprise', 'recaptcha_v2_enterprise'],
  ['recaptchav3', 'recaptcha_v3'],
  ['recaptcha_v3', 'recaptcha_v3'],
  ['recaptcha_v3_enterprise', 'recaptcha_v3_enterprise'],
  ['cloudflare', 'turnstile'],
  ['cf_turnstile', 'turnstile'],
  ['turnstile', 'turnstile'],
  ['hcaptcha', 'hcaptcha'],
  ['image', 'image_to_text'],
  ['image_to_text', 'image_to_text'],
]);

export function normalizeCaptchaType(type) {
  const value = String(type || '').trim().toLowerCase();
  return TYPE_ALIASES.get(value) || value;
}

export function captchaWebsiteUrl(frameUrl, topLevelUrl = '') {
  return /^https?:\/\//i.test(String(frameUrl || ''))
    ? String(frameUrl)
    : String(topLevelUrl || '');
}

function recaptchaTypeDetails(type, isEnterprise) {
  const normalized = normalizeCaptchaType(type);
  const match = normalized.match(/^recaptcha_v([23])(_enterprise)?$/);
  if (!match) return null;
  const enterpriseInType = !!match[2];
  return {
    baseType: `recaptcha_v${match[1]}`,
    enterprise: enterpriseInType ? true : (isEnterprise == null ? null : !!isEnterprise),
    invalid: enterpriseInType && isEnterprise === false,
  };
}

export function captchaTypesMatch(left, right, leftIsEnterprise = null, rightIsEnterprise = null) {
  const leftRecaptcha = recaptchaTypeDetails(left, leftIsEnterprise);
  const rightRecaptcha = recaptchaTypeDetails(right, rightIsEnterprise);
  if (leftRecaptcha || rightRecaptcha) {
    if (!leftRecaptcha || !rightRecaptcha || leftRecaptcha.invalid || rightRecaptcha.invalid) return false;
    if (leftRecaptcha.baseType !== rightRecaptcha.baseType) return false;
    return leftRecaptcha.enterprise == null
      || rightRecaptcha.enterprise == null
      || leftRecaptcha.enterprise === rightRecaptcha.enterprise;
  }
  return normalizeCaptchaType(left) === normalizeCaptchaType(right);
}

export function applyCaptchaFrameVisibility(candidates, frameContexts, navigationFrames) {
  const contextsByFrameId = new Map();
  for (const context of Array.isArray(frameContexts) ? frameContexts : []) {
    if (Number.isInteger(context?.frameId)) contextsByFrameId.set(context.frameId, context);
  }
  const navigationByFrameId = new Map();
  for (const frame of Array.isArray(navigationFrames) ? navigationFrames : []) {
    if (Number.isInteger(frame?.frameId)) navigationByFrameId.set(frame.frameId, frame);
  }

  const uniqueMatch = (items) => items.length === 1 ? items[0] : null;
  const httpOrigin = (value) => {
    try {
      const parsed = new URL(String(value || ''));
      return /^https?:$/.test(parsed.protocol) ? parsed.origin : '';
    } catch (_) {
      return '';
    }
  };
  const findEmbeddingFrame = (frameId, parentFrameId) => {
    const parentContext = contextsByFrameId.get(parentFrameId);
    if (!parentContext) return null;
    const childFrames = Array.isArray(parentContext.childFrames) ? parentContext.childFrames : [];
    if (!childFrames.length) return null;

    const childContext = contextsByFrameId.get(frameId);
    const navigation = navigationByFrameId.get(frameId);
    const frameName = String(childContext?.frameName || '');
    const frameUrls = new Set([
      childContext?.frameUrl,
      navigation?.url,
    ].filter(Boolean).map(String));
    const urlMatches = childFrames.filter(child =>
      frameUrls.has(String(child?.loadedUrl || '')) || frameUrls.has(String(child?.url || ''))
    );
    if (frameName) {
      const exact = uniqueMatch(urlMatches.filter(child => String(child?.name || '') === frameName));
      if (exact) return exact;
    }
    const byUrl = uniqueMatch(urlMatches);
    if (byUrl) return byUrl;
    if (frameName) {
      const byName = uniqueMatch(childFrames.filter(child => String(child?.name || '') === frameName));
      if (byName) return byName;
    }
    const frameOrigins = new Set([...frameUrls].map(httpOrigin).filter(Boolean));
    if (frameOrigins.size) {
      const byOrigin = uniqueMatch(childFrames.filter(child =>
        [child?.loadedUrl, child?.url].some(url => frameOrigins.has(httpOrigin(url)))
      ));
      if (byOrigin) return byOrigin;
    }
    return childFrames.length === 1 ? childFrames[0] : null;
  };

  const visibilityByFrameId = new Map();
  const frameIsVisible = (frameId, visiting = new Set()) => {
    if (visibilityByFrameId.has(frameId)) return visibilityByFrameId.get(frameId);
    if (!Number.isInteger(frameId) || visiting.has(frameId)) return false;
    const navigation = navigationByFrameId.get(frameId);
    const parentFrameId = navigation?.parentFrameId;
    if (frameId === 0 || parentFrameId === -1) {
      visibilityByFrameId.set(frameId, true);
      return true;
    }
    if (!Number.isInteger(parentFrameId)) {
      visibilityByFrameId.set(frameId, false);
      return false;
    }
    visiting.add(frameId);
    const parentVisible = frameIsVisible(parentFrameId, visiting);
    visiting.delete(frameId);
    const embeddingFrame = parentVisible ? findEmbeddingFrame(frameId, parentFrameId) : null;
    // A unique origin match covers common cross-origin redirects whose iframe
    // keeps its original src. When multiple embedding elements are still
    // indistinguishable, visibility is unknown; fail closed so an internally
    // visible widget inside a hidden iframe is not promoted into the paid-task
    // ranking tier.
    const visible = parentVisible
      && embeddingFrame?.visible === true;
    visibilityByFrameId.set(frameId, visible);
    return visible;
  };
  const dialogAssociationByFrameId = new Map();
  const frameIsDialogAssociated = (frameId, visiting = new Set()) => {
    if (dialogAssociationByFrameId.has(frameId)) {
      return dialogAssociationByFrameId.get(frameId);
    }
    if (!Number.isInteger(frameId) || frameId === 0 || visiting.has(frameId)) {
      return false;
    }
    const parentFrameId = navigationByFrameId.get(frameId)?.parentFrameId;
    if (!Number.isInteger(parentFrameId) || parentFrameId === -1) return false;
    const embeddingFrame = findEmbeddingFrame(frameId, parentFrameId);
    visiting.add(frameId);
    const associated = embeddingFrame?.dialogAssociated === true
      || frameIsDialogAssociated(parentFrameId, visiting);
    visiting.delete(frameId);
    dialogAssociationByFrameId.set(frameId, associated);
    return associated;
  };

  const sourceCandidates = Array.isArray(candidates) ? candidates : [];
  const pathIsStrictAncestor = (sourcePath, targetPath) => {
    const source = Array.isArray(sourcePath) ? sourcePath : [];
    const target = Array.isArray(targetPath) ? targetPath : [];
    if (source.length >= target.length) return false;
    return source.every((segment, index) =>
      Number(segment?.index) === Number(target[index]?.index)
    );
  };
  const ancestorDistance = (source, target) => {
    if (!Number.isInteger(source?.frameId) || !Number.isInteger(target?.frameId)) return null;
    const sourcePath = Array.isArray(source.framePath) ? source.framePath : [];
    const targetPath = Array.isArray(target.framePath) ? target.framePath : [];
    if (source.frameId === target.frameId) {
      if (!pathIsStrictAncestor(sourcePath, targetPath)) return null;
      return targetPath.length - sourcePath.length;
    }
    // A candidate reached through an inherited-origin framePath lives below
    // its injectable frameId. Treating that base frame as its location would
    // let metadata leak sideways into a sibling browser frame.
    if (sourcePath.length) return null;
    let currentFrameId = target.frameId;
    let distance = targetPath.length;
    const visited = new Set();
    while (Number.isInteger(currentFrameId) && !visited.has(currentFrameId)) {
      visited.add(currentFrameId);
      const parentFrameId = navigationByFrameId.get(currentFrameId)?.parentFrameId;
      if (!Number.isInteger(parentFrameId) || parentFrameId === -1) return null;
      distance += 1;
      if (parentFrameId === source.frameId) return distance;
      currentFrameId = parentFrameId;
    }
    return null;
  };
  const reconcileAncestorLoader = (candidate) => {
    if (!candidate?.websiteKey
        || !/^recaptcha_v[23](?:_enterprise)?$/.test(String(candidate.type || ''))
        || candidate.detectedVia === 'script') {
      return candidate;
    }
    const matchingLoaders = sourceCandidates
      .filter(source =>
        source !== candidate
        && source?.detectedVia === 'script'
        && source?.websiteKey === candidate.websiteKey
        && /^recaptcha_v3(?:_enterprise)?$/.test(String(source.type || ''))
      )
      .map(source => ({ source, distance: ancestorDistance(source, candidate) }))
      .filter(entry => entry.distance != null)
      .sort((left, right) => left.distance - right.distance);
    if (!matchingLoaders.length) return candidate;
    const nearestDistance = matchingLoaders[0].distance;
    const nearest = matchingLoaders.filter(entry => entry.distance === nearestDistance);
    const signatures = new Set(nearest.map(({ source }) => JSON.stringify([
      source.type,
      source.isEnterprise === true,
      source.pageAction || null,
    ])));
    if (signatures.size > 1) {
      return {
        ...candidate,
        parameterConflicts: [...new Set([
          ...(Array.isArray(candidate.parameterConflicts) ? candidate.parameterConflicts : []),
          'ancestorLoader',
        ])],
      };
    }
    const loader = nearest[0].source;
    const pageAction = candidate.pageAction || loader.pageAction || null;
    return {
      ...candidate,
      type: loader.type,
      isEnterprise: loader.isEnterprise === true || /_enterprise$/.test(loader.type),
      normalCheckbox: false,
      ...(pageAction ? { pageAction } : {}),
      ...(!pageAction && loader.note ? { note: loader.note } : {}),
      ancestorLoaderFrameId: loader.frameId,
    };
  };
  const isHttpUrl = value => /^https?:\/\//i.test(String(value || ''));
  const nearestHttpUrl = (candidate) => {
    if (isHttpUrl(candidate?.frameUrl)) return String(candidate.frameUrl);
    const framePath = Array.isArray(candidate?.framePath) ? candidate.framePath : [];
    for (let index = framePath.length - 2; index >= 0; index -= 1) {
      if (isHttpUrl(framePath[index]?.frameUrl)) return String(framePath[index].frameUrl);
    }
    const baseFrameUrl = contextsByFrameId.get(candidate?.frameId)?.frameUrl
      || navigationByFrameId.get(candidate?.frameId)?.url;
    if (isHttpUrl(baseFrameUrl)) return String(baseFrameUrl);
    let currentFrameId = candidate?.frameId;
    const visited = new Set();
    while (Number.isInteger(currentFrameId) && !visited.has(currentFrameId)) {
      visited.add(currentFrameId);
      const parentFrameId = navigationByFrameId.get(currentFrameId)?.parentFrameId;
      if (!Number.isInteger(parentFrameId) || parentFrameId === -1) break;
      const parentUrl = contextsByFrameId.get(parentFrameId)?.frameUrl
        || navigationByFrameId.get(parentFrameId)?.url;
      if (isHttpUrl(parentUrl)) return String(parentUrl);
      currentFrameId = parentFrameId;
    }
    return null;
  };

  return sourceCandidates.map(rawCandidate => {
    const candidate = reconcileAncestorLoader(rawCandidate);
    const frameVisible = frameIsVisible(candidate?.frameId)
      && candidate?.frameVisibleWithinAnchor !== false;
    return {
      ...candidate,
      frameVisible,
      websiteURL: nearestHttpUrl(candidate),
      dialogAssociated: candidate?.dialogAssociated === true
        || frameIsDialogAssociated(candidate?.frameId),
      visible: candidate?.visible === true && frameVisible,
      normalCheckbox: candidate?.normalCheckbox === true && candidate?.visible === true && frameVisible,
    };
  });
}

function candidateSummary(candidate) {
  return {
    frameId: Number.isInteger(candidate?.frameId) ? candidate.frameId : null,
    ...(Array.isArray(candidate?.framePath) && candidate.framePath.length
      ? { framePath: candidate.framePath }
      : {}),
    framePathIndexes: Array.isArray(candidate?.framePath)
      ? candidate.framePath.map(segment => Number(segment?.index))
      : [],
    frameUrl: candidate?.frameUrl || '',
    websiteURL: candidate?.websiteURL || null,
    type: candidate?.type || '',
    websiteKey: candidate?.websiteKey || null,
    visible: candidate?.visible === true,
    normalCheckbox: candidate?.normalCheckbox === true,
    challengeFrame: candidate?.challengeFrame === true,
    dialogAssociated: candidate?.dialogAssociated === true,
    frameVisible: candidate?.frameVisible !== false,
    isInvisible: candidate?.isInvisible === true,
    isEnterprise: candidate?.isEnterprise === true,
    pageAction: candidate?.pageAction || null,
    enterprisePayload: candidate?.enterprisePayload || null,
    recaptchaDataSValue: candidate?.recaptchaDataSValue || null,
    explicitWebsiteKey: candidate?.explicitWebsiteKey === true,
    callbackName: candidate?.callbackName || null,
    responseTokenPresent: candidate?.responseTokenPresent === true,
    responseFieldId: candidate?.responseFieldId || null,
    responseFieldIndex: Number.isInteger(candidate?.responseFieldIndex)
      ? candidate.responseFieldIndex
      : null,
    alsoResponseFieldId: candidate?.alsoResponseFieldId || null,
    alsoResponseFieldIndex: Number.isInteger(candidate?.alsoResponseFieldIndex)
      ? candidate.alsoResponseFieldIndex
      : null,
    documentTimeOrigin: Number.isFinite(candidate?.documentTimeOrigin)
      ? candidate.documentTimeOrigin
      : null,
    ancestorLoaderFrameId: Number.isInteger(candidate?.ancestorLoaderFrameId)
      ? candidate.ancestorLoaderFrameId
      : null,
    parameterConflicts: Array.isArray(candidate?.parameterConflicts)
      ? candidate.parameterConflicts
      : [],
    detectedVia: candidate?.detectedVia || null,
  };
}

function candidateScore(candidate) {
  // Priority is tiered so no combination of secondary signals can make a
  // generic visible/background integration outrank an active challenge
  // frame or visible checkbox.
  const activeChallengeFrame = candidate?.challengeFrame
    && candidate?.visible === true
    && candidate?.frameVisible !== false;
  const primary = (candidate?.normalCheckbox && candidate?.visible) || activeChallengeFrame;
  const tier = primary ? 3 : (candidate?.visible ? 2 : 1);
  let score = tier * 1000;
  if (candidate?.normalCheckbox && candidate?.visible) score += 120;
  else if (candidate?.visible) score += 60;
  if (activeChallengeFrame) score += 35;
  if (candidate?.responseField) score += 12;
  if (candidate?.detectedVia === 'host') score += 8;
  if (candidate?.websiteKey) score += 4;
  if (candidate?.isInvisible) score -= 3;
  return score;
}

export function selectCaptchaCandidate(candidates, constraints = {}) {
  const unique = [];
  const fingerprintIndexes = new Map();
  const taskParameterFields = [
    'isInvisible',
    'isEnterprise',
    'pageAction',
    'enterprisePayload',
    'recaptchaDataSValue',
  ];
  const hasParameterValue = value =>
    value !== undefined && value !== null && value !== '';
  const taskParameterApplies = (field, type) =>
    field !== 'isInvisible' || !/^recaptcha_v3(?:_|$)/.test(type);
  const stableParameterValue = value => {
    if (Array.isArray(value)) {
      return `[${value.map(stableParameterValue).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${stableParameterValue(value[key])}`
      ).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    if (!raw?.type) continue;
    const candidate = {
      ...raw,
      type: normalizeCaptchaType(raw.type),
      frameUrl: String(raw.frameUrl || ''),
      websiteKey: raw.websiteKey || null,
    };
    const fingerprint = [
      Number.isInteger(candidate.frameId) ? candidate.frameId : '',
      candidate.frameUrl,
      candidate.type,
      candidate.websiteKey || '',
      stableParameterValue(Array.isArray(candidate.framePath) ? candidate.framePath : []),
      candidate.responseFieldId || (
        Number.isInteger(candidate.responseFieldIndex)
          ? `response-field-${candidate.responseFieldIndex}`
          : (candidate.alsoResponseFieldId || (
            Number.isInteger(candidate.alsoResponseFieldIndex)
              ? `also-response-field-${candidate.alsoResponseFieldIndex}`
              : ''
          ))
      ),
    ].join('|');
    if (fingerprintIndexes.has(fingerprint)) {
      const index = fingerprintIndexes.get(fingerprint);
      const previous = unique[index];
      const preferred = candidateScore(candidate) > candidateScore(previous) ? candidate : previous;
      const fallback = preferred === candidate ? previous : candidate;
      const parameterConflicts = new Set([
        ...(Array.isArray(previous.parameterConflicts) ? previous.parameterConflicts : []),
        ...(Array.isArray(candidate.parameterConflicts) ? candidate.parameterConflicts : []),
      ]);
      const merged = {
        ...fallback,
        ...preferred,
        visible: previous.visible === true || candidate.visible === true,
        normalCheckbox: previous.normalCheckbox === true || candidate.normalCheckbox === true,
        challengeFrame: previous.challengeFrame === true || candidate.challengeFrame === true,
        dialogAssociated: previous.dialogAssociated === true || candidate.dialogAssociated === true,
        responseField: previous.responseField === true || candidate.responseField === true,
        responseTokenPresent: previous.responseTokenPresent === true
          || candidate.responseTokenPresent === true,
      };
      for (const field of taskParameterFields) {
        const previousValue = previous[field];
        const candidateValue = candidate[field];
        if (taskParameterApplies(field, candidate.type)
            && hasParameterValue(previousValue)
            && hasParameterValue(candidateValue)
            && stableParameterValue(previousValue) !== stableParameterValue(candidateValue)) {
          parameterConflicts.add(field);
        }
        merged[field] = hasParameterValue(previousValue)
          ? previousValue
          : (hasParameterValue(candidateValue) ? candidateValue : null);
      }
      merged.parameterConflicts = [...parameterConflicts].sort();
      unique[index] = merged;
      continue;
    }
    fingerprintIndexes.set(fingerprint, unique.length);
    unique.push(candidate);
  }

  let pool = unique;
  const requestedFrameId = Number.isInteger(constraints.frameId) ? constraints.frameId : null;
  if (requestedFrameId != null) {
    pool = pool.filter(candidate => candidate.frameId === requestedFrameId);
    if (!pool.length) {
      return {
        selected: null,
        ambiguous: false,
        error: `No CAPTCHA candidate was found in frameId ${requestedFrameId}.`,
        candidates: unique.map(candidateSummary),
      };
    }
  }
  const hasRequestedFramePath = Array.isArray(constraints.framePath);
  const requestedFramePath = hasRequestedFramePath
    ? constraints.framePath.map(value => Number(value))
    : [];
  if (hasRequestedFramePath) {
    if (requestedFramePath.some(value => !Number.isInteger(value) || value < 0)) {
      return {
        selected: null,
        ambiguous: false,
        error: 'framePath must be an array of non-negative iframe indexes.',
        candidates: unique.map(candidateSummary),
      };
    }
    pool = pool.filter(candidate => {
      const candidatePath = Array.isArray(candidate.framePath)
        ? candidate.framePath.map(segment => Number(segment?.index))
        : [];
      return candidatePath.length === requestedFramePath.length
        && candidatePath.every((value, index) => value === requestedFramePath[index]);
    });
    if (!pool.length) {
      return {
        selected: null,
        ambiguous: false,
        error: `No CAPTCHA candidate was found at framePath [${requestedFramePath.join(', ')}].`,
        candidates: unique.map(candidateSummary),
      };
    }
  }
  const requestedFrameUrl = String(constraints.frameUrl || '');
  const requestedWebsiteKey = String(constraints.websiteKey || '');
  const requestedType = normalizeCaptchaType(constraints.type);
  if (requestedFrameUrl) {
    pool = pool.filter(candidate => candidate.frameUrl === requestedFrameUrl);
    if (!pool.length) {
      return {
        selected: null,
        ambiguous: false,
        error: `No CAPTCHA candidate was found in the exact frame URL ${requestedFrameUrl}.`,
        candidates: unique.map(candidateSummary),
      };
    }
  }
  if (requestedWebsiteKey) {
    const exactKeyMatches = pool.filter(candidate => candidate.websiteKey === requestedWebsiteKey);
    const explicitTurnstileFallbacks = requestedType === 'turnstile'
      ? pool
        .filter(candidate =>
          candidate.type === 'turnstile_challenge' && !candidate.websiteKey
        )
        .map(candidate => ({
          ...candidate,
          type: 'turnstile',
          websiteKey: requestedWebsiteKey,
          explicitWebsiteKey: true,
        }))
      : [];
    pool = exactKeyMatches.length ? exactKeyMatches : explicitTurnstileFallbacks;
    if (!pool.length) {
      return {
        selected: null,
        ambiguous: false,
        error: 'No detected CAPTCHA candidate matched the supplied websiteKey.',
        candidates: unique.map(candidateSummary),
      };
    }
  }
  if (!pool.length) {
    return { selected: null, ambiguous: false, error: null, candidates: [] };
  }

  const ranked = pool
    .map(candidate => ({ candidate, score: candidateScore(candidate) }))
    .sort((left, right) => right.score - left.score);
  const topScore = ranked[0].score;
  const top = ranked.filter(entry => entry.score === topScore);
  if (top.length > 1) {
    const summaries = top.map(entry => candidateSummary(entry.candidate));
    const uniqueCount = selector => new Set(summaries.map(selector)).size;
    const discriminators = [];
    if (uniqueCount(candidate => candidate.frameUrl) > 1) discriminators.push('frameUrl');
    if (uniqueCount(candidate => candidate.websiteKey) > 1) discriminators.push('websiteKey');
    if (uniqueCount(candidate => candidate.frameId) > 1) discriminators.push('frameId');
    if (uniqueCount(candidate => JSON.stringify(candidate.framePathIndexes)) > 1) {
      discriminators.push('framePath');
    }
    const finalDiscriminator = discriminators.pop();
    const discriminatorText = finalDiscriminator
      ? discriminators.length === 0
        ? finalDiscriminator
        : discriminators.length === 1
          ? `${discriminators[0]} or ${finalDiscriminator}`
          : `${discriminators.join(', ')}, or ${finalDiscriminator}`
      : null;
    return {
      selected: null,
      ambiguous: true,
      error: discriminatorText
        ? `Multiple CAPTCHA candidates are equally active. Pass an exact ${discriminatorText} from the candidates to select one.`
        : 'Multiple CAPTCHA candidates are equally active and expose no unique frame discriminator. Wait for one widget to become inactive before retrying.',
      candidates: summaries,
    };
  }
  const selectedConflicts = Array.isArray(top[0].candidate.parameterConflicts)
    ? top[0].candidate.parameterConflicts
    : [];
  if (selectedConflicts.length) {
    return {
      selected: null,
      ambiguous: true,
      error: `Conflicting CAPTCHA task parameters were detected for the same frame, type, and site key: ${selectedConflicts.join(', ')}. Wait for the stale widget to disappear or reload the page before retrying.`,
      candidates: [candidateSummary(top[0].candidate)],
    };
  }

  const selected = {
    ...top[0].candidate,
    selectionScore: topScore,
    selectionReason: selectedReason(top[0].candidate, constraints),
  };
  return {
    selected,
    ambiguous: false,
    error: null,
    candidates: unique.map(candidateSummary),
  };
}

function selectedReason(candidate, constraints) {
  if (candidate.explicitWebsiteKey) return 'explicit site key for detected Turnstile challenge';
  if (Array.isArray(constraints.framePath)) return 'exact framePath match';
  if (Number.isInteger(constraints.frameId)) return 'exact frameId match';
  if (constraints.frameUrl) return 'exact frameUrl match';
  if (constraints.websiteKey) return 'exact websiteKey match';
  if (candidate.normalCheckbox && candidate.visible) return 'visible checkbox challenge';
  if (candidate.visible && candidate.challengeFrame && candidate.frameVisible !== false) return 'visible challenge frame';
  if (candidate.visible) return 'visible CAPTCHA widget';
  if (candidate.challengeFrame && candidate.frameVisible !== false) return 'challenge frame candidate';
  return 'only detected CAPTCHA candidate';
}

// This function is serialized and executed in the web page. It must not
// reference module-scope values.
export function detectCaptchaCandidatesInPage(scope = null) {
  const candidates = [];
  const pageWindow = scope?.window
    || (typeof window !== 'undefined' ? window : null);
  const pageDocument = scope?.document
    || (typeof document !== 'undefined' ? document : null);
  const pageLocation = pageWindow?.location
    || (typeof location !== 'undefined' ? location : null);
  const frameUrl = pageLocation ? String(pageLocation.href || '') : '';
  if (!pageDocument) {
    return {
      candidates,
      frameContext: { frameUrl, frameName: '', childFrames: [] },
    };
  }
  const challengeFrame = /(?:captcha|challenge|checkpoint|security[-_/ ]?verif)/i.test(frameUrl);
  const responseField = !!pageDocument.querySelector(
    'textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"], '
      + 'textarea[name="h-captcha-response"], input[name="h-captcha-response"], '
      + 'textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]'
  );
  const V3_NO_ACTION_NOTE = 'reCAPTCHA v3 detected, but the page never exposed an action name. solve_captcha needs pageAction — read it from the grecaptcha.execute(...) call in the site JS, or infer it from the form (login, submit, checkout).';
  let documentTimeOrigin = null;
  try {
    const value = Number(pageWindow?.performance?.timeOrigin);
    if (Number.isFinite(value) && value > 0) documentTimeOrigin = value;
  } catch (_) {}

  const urlParam = (urlStr, name) => {
    try {
      const url = new URL(urlStr, frameUrl || 'https://dummy.host');
      const queryValue = url.searchParams.get(name);
      if (queryValue != null) return queryValue;
      const fragment = String(url.hash || '').replace(/^#/, '');
      return fragment ? new URLSearchParams(fragment).get(name) : null;
    } catch (_) {
      return null;
    }
  };
  const visibleElement = (element) => {
    if (!element) return false;
    try {
      const style = typeof pageWindow?.getComputedStyle === 'function'
        ? pageWindow.getComputedStyle(element)
        : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
      if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
      if (typeof element.getBoundingClientRect === 'function') {
        const rect = element.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const viewportWidth = typeof pageWindow?.innerWidth === 'number' ? pageWindow.innerWidth : rect.right;
        const viewportHeight = typeof pageWindow?.innerHeight === 'number' ? pageWindow.innerHeight : rect.bottom;
        if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= viewportHeight || rect.left >= viewportWidth) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  };
  const challengeDialogRe = /\b(?:(?:re|h|fun)?captcha|security verification|human verification|verify (?:that )?you(?:'|\u2019)re (?:a )?human|verify (?:that )?you are (?:a )?human|are you (?:a )?human|robot check|challenge verification)\b/i;
  const challengeDialogs = Array.from(
    pageDocument.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]')
  ).filter((element) => {
    if (!visibleElement(element)) return false;
    let labelledBy = '';
    try {
      labelledBy = String(element.getAttribute?.('aria-labelledby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map(id => pageDocument.getElementById?.(id)?.textContent || '')
        .join(' ');
    } catch (_) {}
    return [
      element.getAttribute?.('aria-label'),
      labelledBy,
      element.querySelector?.('h1, h2, h3, [role="heading"]')?.textContent,
      element.getAttribute?.('title'),
      element.innerText,
      element.textContent,
    ].some(value => challengeDialogRe.test(String(value || '')));
  });
  const elementInChallengeDialog = (element) => {
    if (!element) return false;
    return challengeDialogs.some((dialog) => {
      if (dialog === element) return true;
      try {
        if (typeof dialog.contains === 'function' && dialog.contains(element)) return true;
      } catch (_) {}
      let ancestor = element.parentElement || null;
      for (let depth = 0; ancestor && depth < 20; depth += 1) {
        if (ancestor === dialog) return true;
        ancestor = ancestor.parentElement || null;
      }
      return false;
    });
  };
  const add = (candidate, associationElement = null) => {
    if (!candidate?.type) return;
    const {
      responseFieldDialogAssociated,
      alsoResponseFieldDialogAssociated,
      alsoResponseTokenPresent,
      ...serializableCandidate
    } = candidate;
    candidates.push({
      ...serializableCandidate,
      frameUrl,
      challengeFrame,
      responseField,
      responseTokenPresent: candidate.responseTokenPresent === true
        || alsoResponseTokenPresent === true,
      documentTimeOrigin,
      dialogAssociated: candidate.dialogAssociated === true
        || responseFieldDialogAssociated === true
        || alsoResponseFieldDialogAssociated === true
        || elementInChallengeDialog(associationElement),
    });
  };
  const scriptElements = Array.from(pageDocument.querySelectorAll('script[src]'));
  const scriptRecords = scriptElements.map((element) => {
    try { return { element, url: element.src || '' }; } catch (_) { return { element, url: '' }; }
  }).filter(record => record.url);
  const scriptUrls = scriptRecords.map(record => record.url);
  const responseFieldIdentity = (widget, name, fallbackIndex, widgetCount) => {
    const selector = `textarea[name="${name}"], input[name="${name}"]`;
    const fields = Array.from(pageDocument.querySelectorAll(selector));
    let field = null;
    try { field = widget?.querySelector?.(selector) || null; } catch (_) {}
    let ancestor = widget?.parentElement || null;
    for (let depth = 0; !field && ancestor && depth < 4; depth += 1) {
      let contained = [];
      try { contained = Array.from(ancestor.querySelectorAll(selector)); } catch (_) {}
      if (contained.length === 1) field = contained[0];
      ancestor = ancestor.parentElement;
    }
    if (!field
        && fields.length === widgetCount
        && Number.isInteger(fallbackIndex)
        && fallbackIndex >= 0
        && fallbackIndex < fields.length) {
      field = fields[fallbackIndex];
    }
    if (!field) return {};
    const responseFieldIndex = fields.indexOf(field);
    let responseFieldId = '';
    try { responseFieldId = String(field.id || field.getAttribute?.('id') || ''); } catch (_) {}
    let responseTokenPresent = false;
    try { responseTokenPresent = String(field.value || '').trim().length > 0; } catch (_) {}
    return {
      ...(responseFieldId ? { responseFieldId } : {}),
      ...(responseFieldIndex >= 0 ? { responseFieldIndex } : {}),
      responseTokenPresent,
      ...(elementInChallengeDialog(field) ? { responseFieldDialogAssociated: true } : {}),
    };
  };
  const alsoResponseFieldIdentity = (widget, name, fallbackIndex, widgetCount) => {
    const identity = responseFieldIdentity(widget, name, fallbackIndex, widgetCount);
    return {
      ...(identity.responseFieldId ? { alsoResponseFieldId: identity.responseFieldId } : {}),
      ...(Number.isInteger(identity.responseFieldIndex)
        ? { alsoResponseFieldIndex: identity.responseFieldIndex }
        : {}),
      alsoResponseTokenPresent: identity.responseTokenPresent === true,
      ...(identity.responseFieldDialogAssociated
        ? { alsoResponseFieldDialogAssociated: true }
        : {}),
    };
  };
  const recaptchaResponseInChallengeDialog = Array.from(pageDocument.querySelectorAll(
    'textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"]'
  )).some(elementInChallengeDialog);

  const hcaptchaHosts = Array.from(pageDocument.querySelectorAll(
    '.h-captcha[data-sitekey], div[data-hcaptcha-widget-id]'
  ));
  for (const [widgetIndex, host] of hcaptchaHosts.entries()) {
    const websiteKey = host.getAttribute('data-sitekey') || host.getAttribute('data-hcaptcha-sitekey');
    if (!websiteKey) continue;
    const isInvisible = host.getAttribute('data-size') === 'invisible';
    add({
      type: 'hcaptcha',
      websiteKey,
      isInvisible,
      visible: visibleElement(host) && !isInvisible,
      normalCheckbox: visibleElement(host) && !isInvisible,
      callbackName: host.getAttribute('data-callback') || null,
      ...responseFieldIdentity(host, 'h-captcha-response', widgetIndex, hcaptchaHosts.length),
      ...alsoResponseFieldIdentity(host, 'g-recaptcha-response', widgetIndex, hcaptchaHosts.length),
      detectedVia: 'host',
    }, host);
  }

  const turnstileHosts = Array.from(pageDocument.querySelectorAll(
    '.cf-turnstile[data-sitekey], [data-turnstile-sitekey]'
  ));
  for (const [widgetIndex, host] of turnstileHosts.entries()) {
    const websiteKey = host.getAttribute('data-sitekey') || host.getAttribute('data-turnstile-sitekey');
    if (!websiteKey) continue;
    add({
      type: 'turnstile',
      websiteKey,
      visible: visibleElement(host),
      normalCheckbox: false,
      callbackName: host.getAttribute('data-callback') || null,
      ...responseFieldIdentity(host, 'cf-turnstile-response', widgetIndex, turnstileHosts.length),
      detectedVia: 'host',
    }, host);
  }

  const recaptchaHosts = Array.from(pageDocument.querySelectorAll(
    '.g-recaptcha[data-sitekey], div[id^="g-recaptcha"][data-sitekey], [data-recaptcha-sitekey]'
  ));
  for (const [widgetIndex, host] of recaptchaHosts.entries()) {
    const websiteKey = host.getAttribute('data-sitekey') || host.getAttribute('data-recaptcha-sitekey');
    if (!websiteKey) continue;
    const isInvisible = host.getAttribute('data-size') === 'invisible';
    const action = host.getAttribute('data-action') || host.getAttribute('data-recaptcha-action') || null;
    const hasClassicScript = scriptUrls.some(url => /recaptcha\/api\.js/i.test(url));
    const hasEnterpriseScript = scriptUrls.some(url => /recaptcha\/enterprise(?:\.js|\/)/i.test(url));
    const isEnterprise = host.getAttribute('data-enterprise') === 'true'
      || host.getAttribute('data-sitekey-type') === 'enterprise'
      || host.querySelector('iframe[src*="recaptcha/enterprise"]') != null
      || (!hasClassicScript && hasEnterpriseScript);
    const version = host.getAttribute('data-version') || (host.classList.contains('g-recaptcha-v3') ? 'v3' : null);
    const renderScript = scriptUrls.find(url =>
      /recaptcha\/(api|enterprise)\.js/i.test(url) && urlParam(url, 'render') === websiteKey
    ) || null;
    const isV3 = version === 'v3' || !!renderScript || (!!action && !isInvisible);
    const pageAction = action || (isV3 && renderScript
      ? (urlParam(renderScript, 'action') || urlParam(renderScript, 'pageAction') || urlParam(renderScript, 'page_action'))
      : null);
    const enterpriseS = host.getAttribute('data-s') || null;
    const visible = visibleElement(host) && !isInvisible;
    add({
      type: isV3
        ? (isEnterprise ? 'recaptcha_v3_enterprise' : 'recaptcha_v3')
        : (isEnterprise ? 'recaptcha_v2_enterprise' : 'recaptcha_v2'),
      websiteKey,
      isInvisible,
      isEnterprise,
      visible,
      normalCheckbox: visible && !isV3,
      callbackName: host.getAttribute('data-callback') || null,
      ...(pageAction ? { pageAction } : (isV3 ? { note: V3_NO_ACTION_NOTE } : {})),
      ...(enterpriseS
        ? (isEnterprise ? { enterprisePayload: { s: enterpriseS } } : { recaptchaDataSValue: enterpriseS })
        : {}),
      ...responseFieldIdentity(host, 'g-recaptcha-response', widgetIndex, recaptchaHosts.length),
      detectedVia: 'host',
    }, host);
  }

  const allIframeElements = Array.from(pageDocument.querySelectorAll('iframe'));
  const iframeElements = allIframeElements.filter(element => {
    try { return !!element.src; } catch (_) { return false; }
  });
  const iframeUrls = iframeElements.map(element => {
    try { return { element, url: element.src || '' }; } catch (_) { return { element, url: '' }; }
  }).filter(item => item.url);
  const hcaptchaFrames = iframeUrls.filter(({ url }) => /hcaptcha\.com/i.test(url));
  const turnstileFrames = iframeUrls.filter(({ url }) =>
    /challenges\.cloudflare\.com\/turnstile/i.test(url)
  );
  const recaptchaFrames = iframeUrls.filter(({ url }) =>
    /recaptcha\/(api2|enterprise)\/anchor/i.test(url)
  );

  for (const { element, url } of iframeUrls) {
    if (/hcaptcha\.com/i.test(url)) {
      const websiteKey = urlParam(url, 'sitekey');
      if (websiteKey) {
        add({
          type: 'hcaptcha',
          websiteKey,
          visible: visibleElement(element),
          normalCheckbox: visibleElement(element),
          ...responseFieldIdentity(
            element,
            'h-captcha-response',
            hcaptchaFrames.findIndex(frame => frame.element === element),
            hcaptchaFrames.length,
          ),
          ...alsoResponseFieldIdentity(
            element,
            'g-recaptcha-response',
            hcaptchaFrames.findIndex(frame => frame.element === element),
            hcaptchaFrames.length,
          ),
          detectedVia: 'url',
        }, element);
      }
      continue;
    }
    if (/challenges\.cloudflare\.com\/turnstile/i.test(url)) {
      const websiteKey = urlParam(url, 'sitekey');
      if (websiteKey) {
        add({
          type: 'turnstile',
          websiteKey,
          visible: visibleElement(element),
          normalCheckbox: false,
          ...responseFieldIdentity(
            element,
            'cf-turnstile-response',
            turnstileFrames.findIndex(frame => frame.element === element),
            turnstileFrames.length,
          ),
          detectedVia: 'url',
        }, element);
      }
      continue;
    }
    if (!/recaptcha\/(api2|enterprise)\/anchor/i.test(url)) continue;
    const websiteKey = urlParam(url, 'k');
    if (!websiteKey) continue;
    const isEnterprise = /recaptcha\/enterprise/i.test(url);
    const isInvisible = urlParam(url, 'size') === 'invisible';
    const matchingV3Script = scriptUrls.find(scriptUrl => urlParam(scriptUrl, 'render') === websiteKey) || null;
    const isV3 = !!matchingV3Script;
    const pageAction = isV3
      ? (urlParam(matchingV3Script, 'action') || urlParam(matchingV3Script, 'pageAction') || urlParam(matchingV3Script, 'page_action'))
      : (urlParam(url, 'sa') || null);
    const sValue = urlParam(url, 's');
    const visible = visibleElement(element) && !isInvisible;
    add({
      type: isV3
        ? (isEnterprise ? 'recaptcha_v3_enterprise' : 'recaptcha_v3')
        : (isEnterprise ? 'recaptcha_v2_enterprise' : 'recaptcha_v2'),
      websiteKey,
      isInvisible,
      isEnterprise,
      visible,
      normalCheckbox: visible && !isV3,
      ...(pageAction ? { pageAction } : (isV3 ? { note: V3_NO_ACTION_NOTE } : {})),
      ...(sValue
        ? (isEnterprise ? { enterprisePayload: { s: sValue } } : { recaptchaDataSValue: sValue })
        : {}),
      ...responseFieldIdentity(
        element,
        'g-recaptcha-response',
        recaptchaFrames.findIndex(frame => frame.element === element),
        recaptchaFrames.length,
      ),
      detectedVia: 'url',
    }, element);
  }

  for (const { element, url } of scriptRecords) {
    if (!/recaptcha\/(api\.js|enterprise\.js)/i.test(url)) continue;
    const websiteKey = urlParam(url, 'render');
    if (!websiteKey || websiteKey === 'explicit') continue;
    const isEnterprise = /recaptcha\/enterprise/i.test(url);
    const pageAction = urlParam(url, 'action') || urlParam(url, 'pageAction') || urlParam(url, 'page_action');
    add({
      type: isEnterprise ? 'recaptcha_v3_enterprise' : 'recaptcha_v3',
      websiteKey,
      isInvisible: true,
      isEnterprise,
      visible: false,
      normalCheckbox: false,
      dialogAssociated: recaptchaResponseInChallengeDialog,
      ...(pageAction ? { pageAction } : { note: V3_NO_ACTION_NOTE }),
      detectedVia: 'script',
    }, element);
  }

  const hasDetectedTurnstile = candidates.some(candidate => candidate.type === 'turnstile');
  if (!hasDetectedTurnstile && (
    pageDocument.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')
    || pageDocument.querySelector('iframe[src*="challenges.cloudflare.com"]')
  )) {
    add({
      type: 'turnstile_challenge',
      websiteKey: null,
      visible: true,
      normalCheckbox: false,
      note: 'Cloudflare interstitial detected but no sitekey was exposed in the DOM. Pass websiteKey explicitly if you have it.',
      detectedVia: 'script',
    });
  }
  const childFrames = allIframeElements.map((element, index) => {
    let url = '';
    let loadedUrl = '';
    let name = '';
    try { url = String(element.src || ''); } catch (_) {}
    try { loadedUrl = String(element.contentWindow?.location?.href || ''); } catch (_) {}
    try { name = String(element.name || element.getAttribute?.('name') || ''); } catch (_) {}
    return {
      index,
      url,
      loadedUrl,
      name,
      visible: visibleElement(element),
      dialogAssociated: elementInChallengeDialog(element),
    };
  });
  let frameName = '';
  try { frameName = pageWindow ? String(pageWindow.name || '') : ''; } catch (_) {}
  return {
    candidates,
    frameContext: {
      frameUrl,
      frameName,
      childFrames,
    },
  };
}

// This function is also serialized into a page context. Keep it self-contained.
export function injectCaptchaTokenInPage(payload, scope = null) {
  const fieldName = payload?.fieldName;
  const alsoSet = payload?.alsoSet || null;
  const token = payload?.token;
  const target = payload?.target || {};
  const frameWindow = scope?.window
    || (typeof window !== 'undefined' ? window : null);
  const frameDocument = scope?.document
    || (typeof document !== 'undefined' ? document : null);
  const frameLocation = frameWindow?.location
    || (typeof location !== 'undefined' ? location : null);
  const frameUrl = frameLocation ? String(frameLocation.href || '') : '';
  if (!fieldName || !token) {
    return { success: false, fieldUpdated: false, error: 'fieldName and token required', frameUrl };
  }
  if (!frameDocument || !frameWindow) {
    return { success: false, fieldUpdated: false, error: 'target frame document is unavailable', frameUrl };
  }
  if (!Number.isInteger(target.frameId) || !target.frameUrl || !target.websiteKey) {
    return {
      success: false,
      fieldUpdated: false,
      targetRequired: true,
      error: 'A selected CAPTCHA frame identity, URL, and site key are required for token injection.',
      frameUrl,
    };
  }
  let currentDocumentTimeOrigin = null;
  try {
    const value = Number(frameWindow.performance?.timeOrigin);
    if (Number.isFinite(value) && value > 0) currentDocumentTimeOrigin = value;
  } catch (_) {}
  const targetHasDocumentIdentity = Number.isFinite(target.documentTimeOrigin);
  const currentHasDocumentIdentity = Number.isFinite(currentDocumentTimeOrigin);
  if (targetHasDocumentIdentity
      && currentHasDocumentIdentity
      && target.documentTimeOrigin !== currentDocumentTimeOrigin) {
    return {
      success: false,
      fieldUpdated: false,
      skipped: true,
      staleTarget: true,
      error: 'target frame navigated to a different document',
      frameUrl,
    };
  }
  const sameStableUrl = (left, right) => {
    try {
      const leftUrl = new URL(left);
      const rightUrl = new URL(right);
      return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname;
    } catch (_) {
      return false;
    }
  };
  const sameDocumentIdentity = targetHasDocumentIdentity
    && currentHasDocumentIdentity
    && target.documentTimeOrigin === currentDocumentTimeOrigin;
  if (target.frameUrl
      && frameUrl !== target.frameUrl
      && !sameDocumentIdentity
      && !sameStableUrl(frameUrl, target.frameUrl)) {
    return {
      success: false,
      fieldUpdated: false,
      skipped: true,
      staleTarget: true,
      error: 'frame URL did not match target document',
      frameUrl,
    };
  }

  const urlHasKey = (urlStr, key) => {
    try {
      const url = new URL(urlStr, frameUrl || 'https://dummy.host');
      const fragment = String(url.hash || '').replace(/^#/, '');
      const fragmentParams = fragment ? new URLSearchParams(fragment) : null;
      return ['k', 'render', 'sitekey'].some(name =>
        url.searchParams.get(name) === key || fragmentParams?.get(name) === key
      );
    } catch (_) {
      return false;
    }
  };
  const frameHasSiteKey = (key) => {
    if (!key) return false;
    for (const element of Array.from(frameDocument.querySelectorAll(
      '[data-sitekey], [data-recaptcha-sitekey], [data-hcaptcha-sitekey], [data-turnstile-sitekey]'
    ))) {
      if ([
        element.getAttribute('data-sitekey'),
        element.getAttribute('data-recaptcha-sitekey'),
        element.getAttribute('data-hcaptcha-sitekey'),
        element.getAttribute('data-turnstile-sitekey'),
      ].includes(key)) return true;
    }
    for (const element of Array.from(frameDocument.querySelectorAll('iframe[src], script[src]'))) {
      try { if (element.src && urlHasKey(element.src, key)) return true; } catch (_) {}
    }
    return false;
  };
  const siteKeyMatched = frameHasSiteKey(target.websiteKey);
  const explicitTurnstileTarget = target.explicitWebsiteKey === true
    && target.type === 'turnstile';
  const challengeMarkerMatched = explicitTurnstileTarget && !!(
    frameDocument.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')
    || frameDocument.querySelector('iframe[src*="challenges.cloudflare.com"]')
  );
  if (!siteKeyMatched && !challengeMarkerMatched) {
    return {
      success: false,
      fieldUpdated: false,
      staleTarget: true,
      error: explicitTurnstileTarget
        ? 'The selected Turnstile challenge marker is no longer present in the target frame.'
        : 'The selected CAPTCHA site key is no longer present in the target frame.',
      frameUrl,
    };
  }

  const resolveResponseField = (name, primary) => {
    const fields = Array.from(frameDocument.querySelectorAll(
      `textarea[name="${name}"], input[name="${name}"]`
    ));
    const selectedFieldId = primary ? target.responseFieldId : target.alsoResponseFieldId;
    const selectedFieldIndex = primary
      ? target.responseFieldIndex
      : target.alsoResponseFieldIndex;
    if (selectedFieldId) {
      const exact = fields.find(element => {
        try {
          return String(element.id || element.getAttribute?.('id') || '') === selectedFieldId;
        } catch (_) {
          return false;
        }
      });
      if (exact) return { element: exact };
      return {
        error: 'The selected CAPTCHA response field ID is no longer present in the target frame.',
        staleTarget: true,
      };
    }
    if (Number.isInteger(selectedFieldIndex)) {
      if (fields[selectedFieldIndex]) {
        return { element: fields[selectedFieldIndex] };
      }
      return {
        error: 'The selected CAPTCHA response field is no longer present in the target frame.',
        staleTarget: true,
      };
    }
    if (fields.length === 1) return { element: fields[0] };
    if (fields.length > 1) {
      return {
        error: 'Multiple CAPTCHA response fields matched without a selected widget identity.',
        ambiguousResponseField: true,
      };
    }
    return { element: null };
  };
  const requestedFields = [
    { name: fieldName, primary: true },
    ...(alsoSet ? [{ name: alsoSet, primary: false }] : []),
  ];
  const resolvedFields = requestedFields.map(field => ({
    ...field,
    ...resolveResponseField(field.name, field.primary),
  }));
  const unresolvedField = resolvedFields.find(field => field.primary && field.error);
  if (unresolvedField) {
    return {
      success: false,
      fieldUpdated: false,
      staleTarget: unresolvedField.staleTarget === true,
      ambiguousResponseField: unresolvedField.ambiguousResponseField === true,
      error: unresolvedField.error,
      frameUrl,
    };
  }
  const skippedFields = resolvedFields.filter(field => !field.primary && field.error);
  const injectableFields = resolvedFields.filter(field => !field.error);

  const setOn = (name, existingElement) => {
    let element = existingElement;
    if (!element) {
      element = frameDocument.createElement('textarea');
      element.name = name;
      element.style.display = 'none';
      (frameDocument.body || frameDocument.documentElement).appendChild(element);
    }
    try {
      const TextAreaElement = frameWindow.HTMLTextAreaElement
        || (typeof HTMLTextAreaElement !== 'undefined' ? HTMLTextAreaElement : null);
      const InputElement = frameWindow.HTMLInputElement
        || (typeof HTMLInputElement !== 'undefined' ? HTMLInputElement : null);
      const prototype = element.tagName === 'TEXTAREA'
        ? TextAreaElement?.prototype
        : InputElement?.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, token);
      else element.value = token;
    } catch (_) {
      element.value = token;
    }
    element.textContent = token;
    const PageEvent = frameWindow.Event
      || (typeof Event !== 'undefined' ? Event : null);
    if (PageEvent) {
      element.dispatchEvent(new PageEvent('input', { bubbles: true }));
      element.dispatchEvent(new PageEvent('change', { bubbles: true }));
    }
    return element;
  };
  for (const field of injectableFields) {
    setOn(field.name, field.element);
  }
  const fieldsTouched = injectableFields.length;

  const pageWindow = frameWindow.wrappedJSObject || frameWindow;
  const callbacks = [];
  const addCallback = (fn, source) => {
    if (typeof fn !== 'function') return;
    if (callbacks.some(entry => entry.fn === fn)) return;
    callbacks.push({ fn, source });
  };
  const resolveNamedCallback = (name) => {
    if (!name) return null;
    try {
      return String(name).split('.').reduce((value, part) => value?.[part], pageWindow);
    } catch (_) {
      return null;
    }
  };
  const callbackHint = payload?.callbackHint || null;
  if (callbackHint) {
    addCallback(resolveNamedCallback(callbackHint), `data-callback:${callbackHint}`);
  }
  if (!callbacks.length) {
    for (const host of Array.from(frameDocument.querySelectorAll(
      '.g-recaptcha[data-callback], .h-captcha[data-callback], .cf-turnstile[data-callback], '
        + '[data-recaptcha-sitekey][data-callback], [data-hcaptcha-sitekey][data-callback], '
        + '[data-turnstile-sitekey][data-callback]'
    ))) {
      const hostKey = host.getAttribute('data-sitekey') || host.getAttribute('data-recaptcha-sitekey')
        || host.getAttribute('data-hcaptcha-sitekey') || host.getAttribute('data-turnstile-sitekey');
      if (target.websiteKey && hostKey !== target.websiteKey) continue;
      const callbackName = host.getAttribute('data-callback');
      addCallback(resolveNamedCallback(callbackName), `data-callback:${callbackName}`);
    }
  }

  const collectGoogleCallbacks = () => {
    let clients;
    try { clients = pageWindow?.___grecaptcha_cfg?.clients; } catch (_) { return; }
    if (!clients || typeof clients !== 'object') return;
    let clientValues;
    try { clientValues = Object.values(clients); } catch (_) { return; }
    for (const client of clientValues) {
      let containsKey = !target.websiteKey;
      const clientCallbacks = [];
      const seen = new Set();
      const walk = (value, depth, propertyName = '') => {
        if (depth > 8 || value == null) return;
        if (typeof value === 'string') {
          if (value === target.websiteKey) containsKey = true;
          return;
        }
        if (typeof value === 'function') {
          if (/callback/i.test(propertyName)) clientCallbacks.push(value);
          return;
        }
        if (typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        let entries;
        try { entries = Object.entries(value); } catch (_) { return; }
        for (const [key, child] of entries) walk(child, depth + 1, key);
      };
      walk(client, 0);
      if (containsKey) {
        for (const callback of clientCallbacks) addCallback(callback, 'grecaptcha-client');
      }
    }
  };
  if (!callbacks.length) collectGoogleCallbacks();

  let calledCallback = false;
  let callbackSource = null;
  let callbackError = null;
  if (callbacks.length === 1) {
    try {
      callbacks[0].fn.call(pageWindow, token);
      calledCallback = true;
      callbackSource = callbacks[0].source;
    } catch (error) {
      callbackError = error?.message || String(error);
    }
  }

  return {
    success: true,
    fieldUpdated: true,
    fieldsUpdated: injectableFields.map(field => field.name),
    fieldsTouched,
    compatibilityFieldSkipped: skippedFields.length > 0,
    compatibilityFieldError: skippedFields[0]?.error || null,
    responseFieldId: target.responseFieldId || null,
    responseFieldIndex: Number.isInteger(target.responseFieldIndex)
      ? target.responseFieldIndex
      : null,
    alsoResponseFieldId: target.alsoResponseFieldId || null,
    alsoResponseFieldIndex: Number.isInteger(target.alsoResponseFieldIndex)
      ? target.alsoResponseFieldIndex
      : null,
    calledCallback,
    callbackSource,
    callbackAmbiguous: callbacks.length > 1,
    callbackCandidates: callbacks.length,
    callbackError,
    siteKeyMatched,
    challengeMarkerMatched,
    frameUrl,
  };
}
