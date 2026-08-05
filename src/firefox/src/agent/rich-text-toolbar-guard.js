const CSS_NAMED_COLOR_KEYWORDS = new Set(`
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood
  cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
  darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue
  firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
  hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
  lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid
  mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
  paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown
  royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow
  springgreen steelblue tan teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen
  currentcolor
`.trim().split(/\s+/));

export const RICH_TEXT_TOOLBAR_GUARDED_TOOLS = new Set([
  'click', 'click_ax', 'type_text', 'type_ax', 'set_checked', 'set_field',
  'press_keys', 'iframe_click', 'iframe_type',
]);

export const RICH_TEXT_TOOLBAR_FOCUSED_TARGET_TOOLS = new Set(['press_keys']);
export const DISPATCH_BINDING_TOOLS = new Set([
  'click', 'press_keys', 'type_text', 'iframe_click', 'iframe_type',
]);

export function richTextToolbarDispatchBindingReady(toolName, args = {}, binding = null) {
  if (!binding || typeof binding !== 'object') return false;
  if (toolName === 'type_text' && typeof args?.selector === 'string' && args.selector.trim()) {
    return !!binding.token || Number(binding.backendNodeId) > 0;
  }
  return !!binding.token;
}

export function richTextToolbarUsesFocusedTarget(toolName, args = {}) {
  return RICH_TEXT_TOOLBAR_FOCUSED_TARGET_TOOLS.has(toolName)
    || (toolName === 'type_text' && !args?.selector && args?.index == null);
}

export function richTextToolbarEffectiveClear(toolName, args = {}) {
  return toolName === 'set_field' ? args?.clear !== false : args?.clear === true;
}

export function normalizeRichTextToolbarAudit(raw, extractJson = value => value) {
  const value = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!value || typeof value !== 'object') return null;
  const regionKinds = new Set(['rich_text_toolbar', 'editor_body', 'ordinary_form_field', 'uncertain']);
  const targetKinds = new Set([
    'font_size', 'font_family', 'style_preset', 'color', 'link',
    'other_formatting', 'editor_body', 'ordinary_input', 'uncertain',
  ]);
  const regionKind = String(value.regionKind || value.region_kind || '').trim().toLowerCase();
  const targetKind = String(value.targetKind || value.target_kind || '').trim().toLowerCase();
  const confidence = Math.max(0, Math.min(1, Number(value.confidence)));
  if (!regionKinds.has(regionKind) || !targetKinds.has(targetKind) || !Number.isFinite(confidence)) return null;
  return { regionKind, targetKind, confidence };
}

export function richTextToolbarTextShape(text) {
  const value = String(text || '');
  const trimmed = value.trim();
  const normalized = trimmed.replace(/\s+/g, ' ').toLowerCase();
  const genericFontFamilies = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong',
  ]);
  const urlLike = !!trimmed && !/\s/.test(trimmed) && (
    /^https?:\/\/[^/?#\s]+(?:[/?#]\S*)?$/i.test(trimmed)
    || /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(trimmed)
    || /^tel:\+?[\d().-]{3,}$/i.test(trimmed)
    || /^www\.[^\s.]+\.[^\s]+$/i.test(trimmed)
    || /^\/(?!\/)\S*$/.test(trimmed)
    || /^\.\.?\/\S+$/.test(trimmed)
    || /^\?\S+$/.test(trimmed)
    || /^#\S*$/.test(trimmed)
    || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
    || /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#]\S*)?$/i.test(trimmed)
  );
  return {
    chars: value.length,
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    lines: value ? value.split(/\r?\n/).length : 0,
    numericPreset: /^\s*-?\d+(?:[.,]\d+)?(?:px|pt|em|rem|%)?\s*$/i.test(value),
    urlLike,
    colorLike: CSS_NAMED_COLOR_KEYWORDS.has(normalized)
      || /^\s*(?:#[0-9a-f]{3,8}|(?:rgb|hsl|hwb)a?\([^)]{1,80}\)|var\(--[\w-]+\))\s*$/i.test(value),
    genericFontFamily: genericFontFamilies.has(normalized),
    semanticStylePreset: /^(?:p|h[1-6]|pre|blockquote|code)$/i.test(trimmed),
  };
}

export function richTextToolbarPresetMatch(text, availableValues) {
  const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const attempted = normalize(text);
  if (!attempted || !Array.isArray(availableValues)) return false;
  return availableValues.slice(0, 40).some(value => normalize(value) === attempted);
}

export function richTextToolbarEditorIdentityMatches(expected, fieldMeta = {}, rect = {}) {
  if (!expected || typeof expected !== 'object') return false;
  const expectedTag = String(expected.tag || '').toLowerCase();
  const actualTag = String(fieldMeta.tag || '').toLowerCase();
  if (!expectedTag || expectedTag !== actualTag) return false;

  const expectedRole = String(expected.role || '').toLowerCase();
  const actualRole = String(fieldMeta.role || '').toLowerCase();
  if ((expectedRole || actualRole) && expectedRole !== actualRole) return false;

  const expectedId = String(expected.id || '');
  const actualId = String(fieldMeta.id || '');
  if ((expectedId || actualId) && (!expectedId || expectedId !== actualId)) return false;

  const expectedName = String(expected.name || '');
  const actualName = String(fieldMeta.name || '');
  if ((expectedName || actualName) && expectedName !== actualName) return false;

  const values = [
    expected.pageX, expected.pageY, expected.w, expected.h,
    rect.pageX, rect.pageY, rect.w, rect.h,
  ].map(Number);
  if (!values.every(Number.isFinite)) return false;
  const [expectedX, expectedY, expectedW, expectedH, actualX, actualY, actualW, actualH] = values;
  const sizeTolerance = Math.max(8, Math.round(Math.max(expectedW, expectedH, actualW, actualH) * 0.1));
  return Math.abs(expectedX - actualX) <= 8
    && Math.abs(expectedY - actualY) <= 8
    && Math.abs(expectedW - actualW) <= sizeTolerance
    && Math.abs(expectedH - actualH) <= sizeTolerance;
}

export function richTextToolbarEditorIdentityRecoverable(expected) {
  if (!expected || typeof expected !== 'object' || !String(expected.tag || '').trim()) return false;
  return [expected.pageX, expected.pageY, expected.w, expected.h]
    .map(Number)
    .every(Number.isFinite);
}

export function richTextToolbarRecoveryScopeMatches(expectedUrl, actualUrl) {
  const expected = String(expectedUrl || '');
  const actual = String(actualUrl || '');
  if (!expected || !actual) return false;
  try {
    const normalize = raw => new URL(raw).href;
    return normalize(expected) === normalize(actual);
  } catch {
    return expected === actual;
  }
}

export function richTextToolbarValueCompatible(targetKind, shape, candidate = {}) {
  if (!shape) return false;
  if (shape.chars === 0) return true;
  if (targetKind === 'font_size') return shape.numericPreset === true;
  if (targetKind === 'font_family') {
    const validShape = shape.lines === 1 && shape.words <= 8 && shape.chars <= 80
      && shape.numericPreset !== true && shape.urlLike !== true;
    return validShape && (shape.genericFontFamily === true || candidate.attemptedPresetMatch === true);
  }
  if (targetKind === 'style_preset') {
    const validShape = shape.lines === 1 && shape.words <= 6 && shape.chars <= 60 && shape.urlLike !== true;
    return validShape && (shape.semanticStylePreset === true || candidate.attemptedPresetMatch === true);
  }
  if (targetKind === 'color') return shape.colorLike === true || candidate.attemptedPresetMatch === true;
  if (targetKind === 'link') return shape.urlLike === true;
  if (targetKind === 'other_formatting') {
    const validShape = shape.lines === 1 && shape.words <= 4 && shape.chars <= 40
      && shape.urlLike !== true;
    return validShape && (shape.numericPreset === true || candidate.attemptedPresetMatch === true);
  }
  if (targetKind === 'uncertain') {
    return ['font_size', 'font_family', 'style_preset', 'color', 'link', 'other_formatting']
      .some(kind => richTextToolbarValueCompatible(kind, shape, candidate));
  }
  return false;
}

export function richTextToolbarDecision(candidate, audit) {
  const score = Number(candidate?.score) || 0;
  const reasons = new Set(Array.isArray(candidate?.reasons) ? candidate.reasons : []);
  const shape = candidate?.attemptedTextShape || null;
  if (audit?.confidence >= 0.7) {
    if (audit.regionKind === 'rich_text_toolbar') {
      const compatible = richTextToolbarValueCompatible(audit.targetKind, shape, candidate);
      return {
        wrongTarget: !compatible,
        source: compatible ? 'vision_shape_compatible' : 'vision_shape_mismatch',
        targetKind: audit.targetKind,
      };
    }
    if (audit.regionKind === 'editor_body' || audit.regionKind === 'ordinary_form_field') {
      return { wrongTarget: false, source: 'vision', targetKind: audit.targetKind };
    }
  }
  const numericCandidate = reasons.has('numeric_preset_value');
  const structurallyCompatible = !!shape && (numericCandidate
    ? (
        shape.chars === 0
        || shape.numericPreset === true
        || candidate?.attemptedPresetMatch === true
      )
    : (
        shape.chars === 0
        || candidate?.attemptedPresetMatch === true
        || shape.numericPreset === true
        || shape.genericFontFamily === true
        || shape.semanticStylePreset === true
        || shape.colorLike === true
        || shape.urlLike === true
      ));
  const strongStructural = score >= 4
    && !!shape
    && !structurallyCompatible
    && (
      reasons.has('numeric_preset_value')
      || reasons.has('semantic_toolbar')
      || reasons.has('dense_control_cluster')
    );
  return {
    wrongTarget: strongStructural,
    source: strongStructural ? 'structural_fallback' : 'uncertain',
    targetKind: audit?.targetKind || 'uncertain',
  };
}

function cleanString(value, max = 2048) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function cleanStrings(values) {
  return Array.isArray(values)
    ? [...new Set(values.filter(value => typeof value === 'string' && value).map(value => value.slice(0, 2048)))]
    : [];
}

export function normalizeRichTextToolbarObligation(raw, now = Date.now) {
  if (!raw || typeof raw !== 'object' || typeof raw.blockedAttemptedText !== 'string') return null;
  const rawIdentity = raw.associatedEditorIdentity;
  const associatedEditorIdentity = rawIdentity && typeof rawIdentity === 'object'
    ? {
        tag: cleanString(rawIdentity.tag, 80),
        id: cleanString(rawIdentity.id, 512) || null,
        name: cleanString(rawIdentity.name, 512) || null,
        role: cleanString(rawIdentity.role, 80) || null,
        pageX: Number(rawIdentity.pageX),
        pageY: Number(rawIdentity.pageY),
        w: Number(rawIdentity.w),
        h: Number(rawIdentity.h),
      }
    : null;
  return {
    toolName: cleanString(raw.toolName, 80),
    source: cleanString(raw.source, 80),
    recoveryOnly: raw.recoveryOnly === true,
    targetKind: cleanString(raw.targetKind, 80) || 'other_formatting',
    detectedAt: Number(raw.detectedAt) || now(),
    blockedAttemptedText: raw.blockedAttemptedText,
    blockedClear: raw.blockedClear === true,
    blockedToolbarRef: cleanString(raw.blockedToolbarRef, 512),
    blockedToolbarSelector: cleanString(raw.blockedToolbarSelector),
    associatedEditorRef: cleanString(raw.associatedEditorRef, 512),
    associatedEditorIdentity,
    recoveryTargetUnknown: raw.recoveryTargetUnknown === true,
    recoveryPageUrl: cleanString(raw.recoveryPageUrl, 4096),
    documentToken: cleanString(raw.documentToken, 512),
    pageUrl: cleanString(raw.pageUrl, 4096),
    frameId: Number.isInteger(raw.frameId) ? raw.frameId : null,
    frameScoped: raw.frameScoped === true || (Number.isInteger(raw.frameId) && raw.frameId !== 0),
    regionRef: cleanString(raw.regionRef, 512),
    regionKey: cleanString(raw.regionKey, 1024),
    blockedRefs: cleanStrings(raw.blockedRefs),
    blockedSelectors: cleanStrings(raw.blockedSelectors),
    blockedRegionRefs: cleanStrings(raw.blockedRegionRefs),
  };
}

function demoteObligationForNavigation(obligation) {
  return {
    ...obligation,
    recoveryOnly: true,
    recoveryTargetUnknown:
      !richTextToolbarEditorIdentityRecoverable(obligation.associatedEditorIdentity),
    associatedEditorRef: '',
    recoveryPageUrl: obligation.recoveryPageUrl || obligation.pageUrl || '',
    documentToken: '',
    pageUrl: '',
    frameId: null,
    regionRef: '',
    regionKey: '',
    blockedRefs: [],
    blockedSelectors: [],
    blockedRegionRefs: [],
  };
}

function obligationMatchesFrame(obligation, frameId) {
  return Number.isInteger(obligation.frameId)
    ? frameId === obligation.frameId
    : !Number.isInteger(frameId) || frameId === 0;
}

function obligationScopeMismatches(obligation, documentToken, pageUrl) {
  return (obligation.documentToken && documentToken && obligation.documentToken !== documentToken)
    || (obligation.pageUrl && pageUrl && obligation.pageUrl !== pageUrl);
}

function obligationKey(entry, { includeLiveFrame = true } = {}) {
  const identity = entry.associatedEditorIdentity;
  const tag = String(identity?.tag || '').toLowerCase();
  const role = String(identity?.role || '').toLowerCase();
  const id = String(identity?.id || '');
  const name = String(identity?.name || '');
  const editorKey = richTextToolbarEditorIdentityRecoverable(identity)
    ? ['identity', tag, role, id, name, identity.pageX, identity.pageY, identity.w, identity.h]
    : entry.associatedEditorRef
      ? ['ref', entry.associatedEditorRef]
      : null;
  const rawScopeUrl = String(entry.recoveryOnly === true
    ? (entry.recoveryPageUrl || entry.pageUrl || '')
    : (entry.pageUrl || entry.recoveryPageUrl || ''));
  let scopeKey = null;
  if (rawScopeUrl) {
    try { scopeKey = ['url', new URL(rawScopeUrl).href]; }
    catch { scopeKey = ['url', rawScopeUrl]; }
  } else if (entry.documentToken) {
    scopeKey = ['document', entry.documentToken];
  }
  const frameScoped = entry.frameScoped === true
    || (Number.isInteger(entry.frameId) && entry.frameId !== 0);
  const frameKey = includeLiveFrame && Number.isInteger(entry.frameId) && entry.frameId !== 0
    ? ['frame', entry.frameId]
    : ['frame-scope', frameScoped ? 'child' : 'top'];
  if (!editorKey || !scopeKey) return null;
  return JSON.stringify([
    entry.blockedAttemptedText,
    entry.blockedClear,
    editorKey,
    scopeKey,
    frameKey,
  ]);
}

function mergeObligation(existing, incoming) {
  return {
    ...existing,
    ...incoming,
    toolName: existing.toolName || incoming.toolName,
    source: existing.source || incoming.source,
    targetKind: existing.targetKind || incoming.targetKind,
    detectedAt: existing.detectedAt || incoming.detectedAt,
    blockedToolbarRef: existing.blockedToolbarRef || incoming.blockedToolbarRef,
    blockedToolbarSelector: existing.blockedToolbarSelector || incoming.blockedToolbarSelector,
    recoveryPageUrl: existing.recoveryOnly === true
      ? (existing.recoveryPageUrl || existing.pageUrl || '')
      : (existing.recoveryPageUrl || incoming.recoveryPageUrl || ''),
    blockedRefs: [...new Set([...(existing.blockedRefs || []), ...(incoming.blockedRefs || [])])],
    blockedSelectors: [...new Set([...(existing.blockedSelectors || []), ...(incoming.blockedSelectors || [])])],
    blockedRegionRefs: [...new Set([...(existing.blockedRegionRefs || []), ...(incoming.blockedRegionRefs || [])])],
  };
}

function retryBlock(obligation) {
  return {
    success: false,
    dispatched: false,
    noDispatch: true,
    wrongTarget: true,
    blockedToolbarRef: true,
    targetKind: obligation?.targetKind || 'other_formatting',
    recoveryRequired: 'editor_body',
    retryable: false,
    error: 'This target is inside the rich-text formatting toolbar detected during the previous text-entry attempt. Do not retry it through focus, coordinates, selectors, or toolbar text. Re-read the tree and click or focus the editor body, then enter the requested content there.',
  };
}

function recoveryMatch(obligation, { toolName, args, probe, fieldMeta }) {
  const recoveryTargetUnknown = obligation.recoveryTargetUnknown === true
    && !obligation.associatedEditorRef
    && !richTextToolbarEditorIdentityRecoverable(obligation.associatedEditorIdentity);
  if (
    !recoveryTargetUnknown
    && !obligation.associatedEditorRef
    && !richTextToolbarEditorIdentityRecoverable(obligation.associatedEditorIdentity)
  ) return null;

  const expectedEditorTag = String(obligation.associatedEditorIdentity?.tag || '').toLowerCase();
  const iframeBackedRecovery = toolName === 'iframe_type'
    && ['iframe', 'frame'].includes(expectedEditorTag);
  const sameFrame = iframeBackedRecovery
    ? Number.isInteger(probe.frameId) && probe.frameId !== 0
    : recoveryTargetUnknown
      ? true
      : obligation.recoveryOnly === true
        ? true
        : Number.isInteger(obligation.frameId)
          ? probe.frameId === obligation.frameId
          : !Number.isInteger(probe.frameId) || probe.frameId === 0;
  if (!sameFrame) return null;

  const liveDocument = String(probe.documentToken || '');
  const livePageUrl = String(probe.refScopeUrl || '');
  const liveRecoveryScopeUrl = iframeBackedRecovery
    ? String(probe.frameOwnerScopeUrl || probe.topFrameUrl || livePageUrl)
    : livePageUrl;
  if (
    (!iframeBackedRecovery && obligation.documentToken && liveDocument && obligation.documentToken !== liveDocument)
    || (obligation.pageUrl && liveRecoveryScopeUrl && obligation.pageUrl !== liveRecoveryScopeUrl)
  ) return null;

  const innerEditor = fieldMeta.contentEditable === true || fieldMeta.tag === 'textarea';
  const unknownRecoveryScopeMatches = obligation.recoveryOnly !== true
    || richTextToolbarRecoveryScopeMatches(obligation.recoveryPageUrl, liveRecoveryScopeUrl);
  const verifiedUnknownEditor = recoveryTargetUnknown
    && innerEditor
    && probe.toolbarContext !== true
    && !fieldMeta.toolbarCandidate
    && unknownRecoveryScopeMatches;
  const exactRef = !!probe.refId && probe.refId === obligation.associatedEditorRef;
  const matchingIdentity = richTextToolbarEditorIdentityMatches(
    obligation.associatedEditorIdentity,
    fieldMeta,
    probe.rect || {},
  );
  const matchingFrameOwner = iframeBackedRecovery && richTextToolbarEditorIdentityMatches(
    obligation.associatedEditorIdentity,
    probe.frameOwnerMeta || {},
    probe.frameOwnerRect || {},
  );
  const exactIdentity = !obligation.associatedEditorRef
    && (obligation.recoveryOnly !== true
      || richTextToolbarRecoveryScopeMatches(obligation.recoveryPageUrl, liveRecoveryScopeUrl))
    && matchingIdentity;
  const selectorScopeMatches = obligation.recoveryOnly !== true
    || richTextToolbarRecoveryScopeMatches(obligation.recoveryPageUrl, liveRecoveryScopeUrl);
  const exactSelector = ['type_text', 'iframe_type'].includes(toolName)
    && typeof args?.selector === 'string'
    && !!args.selector.trim()
    && selectorScopeMatches
    && matchingIdentity;
  const iframeScopeMatches = obligation.recoveryOnly === true
    ? selectorScopeMatches
    : !!liveRecoveryScopeUrl
      && richTextToolbarRecoveryScopeMatches(obligation.pageUrl, liveRecoveryScopeUrl);
  const exactIframeEditor = iframeBackedRecovery
    && innerEditor
    && matchingFrameOwner
    && iframeScopeMatches;
  if (!innerEditor || !(verifiedUnknownEditor || exactRef || exactIdentity || exactSelector || exactIframeEditor)) {
    return null;
  }
  return { exactSelector, exactIdentity, exactIframeEditor, verifiedUnknownEditor };
}

export class RichTextToolbarGuard {
  constructor({ now = Date.now } = {}) {
    this.ledger = new Map();
    this.now = now;
  }

  hasPending(tabId) {
    return this.obligations(tabId).length > 0;
  }

  obligations(tabId) {
    const obligations = this.ledger.get(tabId);
    return Array.isArray(obligations) ? obligations : [];
  }

  reset(tabId) {
    this.ledger.delete(tabId);
  }

  _demoteMatching(tabId, matches) {
    const obligations = this.obligations(tabId)
      .map(obligation => matches(obligation) ? demoteObligationForNavigation(obligation) : obligation);
    if (obligations.length === 0) this.reset(tabId);
    else this.ledger.set(tabId, obligations);
    return obligations;
  }

  navigate(tabId) {
    return this._demoteMatching(tabId, () => true);
  }

  persist(tabId) {
    const recoveryObligations = this.obligations(tabId)
      .map(obligation => normalizeRichTextToolbarObligation(obligation, this.now))
      .filter(Boolean);
    return recoveryObligations.length > 0 ? { recoveryObligations } : null;
  }

  restore(tabId, raw) {
    const obligations = (Array.isArray(raw?.recoveryObligations) ? raw.recoveryObligations : [])
      .map(obligation => normalizeRichTextToolbarObligation(obligation, this.now))
      .filter(Boolean);
    if (obligations.length === 0) return false;
    this.ledger.set(tabId, obligations);
    return true;
  }

  completionAction(tabId) {
    const primary = this.obligations(tabId)[0];
    if (!primary) return null;
    return {
      tool: primary.toolName || null,
      ref_id: primary.blockedToolbarRef || null,
      targetKind: primary.targetKind || 'other_formatting',
      source: primary.source || null,
      detectedAt: primary.detectedAt || this.now(),
      recoveryTargetUnknown: primary.recoveryTargetUnknown === true,
    };
  }

  needsFrameOwnerGeometry(tabId) {
    return this.obligations(tabId).some(obligation => (
      ['iframe', 'frame'].includes(String(obligation.associatedEditorIdentity?.tag || '').toLowerCase())
    ));
  }

  blockRef(tabId, toolName, args = {}, liveDocumentToken = '') {
    if (!['click_ax', 'type_ax', 'set_checked', 'set_field'].includes(toolName)) return null;
    const refId = typeof args?.ref_id === 'string' ? args.ref_id : '';
    if (!refId) return null;
    const obligations = this.obligations(tabId);
    const blockedMatches = obligations.filter(obligation => (
      obligation.blockedToolbarRef === refId || (obligation.blockedRefs || []).includes(refId)
    ));
    if (blockedMatches.length === 0) return null;
    const currentDocument = String(liveDocumentToken || '');
    if (!currentDocument) return null;
    const staleBlocked = new Set(blockedMatches.filter(obligation => (
      obligation.recoveryOnly !== true
      && obligation.documentToken
      && obligation.documentToken !== currentDocument
    )));
    if (staleBlocked.size > 0) {
      this._demoteMatching(tabId, obligation => staleBlocked.has(obligation));
    }
    const blocked = blockedMatches.find(obligation => !staleBlocked.has(obligation));
    if (!blocked) return null;
    return {
      success: false,
      dispatched: false,
      noDispatch: true,
      wrongTarget: true,
      blockedToolbarRef: true,
      targetKind: blocked.targetKind || 'other_formatting',
      recoveryRequired: 'editor_body',
      retryable: false,
      error: 'This ref belongs to the rich-text formatting toolbar detected during the previous text-entry attempt. Do not switch to another font, size, style, color, or link control in that toolbar. Re-read the tree and click or focus the editor body, then enter the requested content there.',
    };
  }

  evaluateProbe(tabId, toolName, args = {}, probe = {}) {
    const obligations = this.obligations(tabId);
    const frameObligations = obligations.filter(obligation => (
      obligation.recoveryOnly === true
        || obligationMatchesFrame(obligation, probe.frameId)
    ));
    if (frameObligations.length === 0) return { block: null, rememberScope: false, guarded: false };
    const liveDocument = String(probe.documentToken || '');
    const livePageUrl = String(probe.refScopeUrl || '');
    const staleObligations = new Set(frameObligations.filter(obligation => (
      obligation.recoveryOnly !== true
      && obligationScopeMismatches(obligation, liveDocument, livePageUrl)
    )));
    if (staleObligations.size > 0) {
      this._demoteMatching(tabId, obligation => staleObligations.has(obligation));
    }
    const scopedObligations = frameObligations.filter(obligation => !staleObligations.has(obligation));
    const iframeTool = toolName === 'iframe_click' || toolName === 'iframe_type';
    if (scopedObligations.length === 0) {
      return {
        block: null,
        rememberScope: !iframeTool && !!(liveDocument || livePageUrl),
        navigated: true,
        guarded: false,
      };
    }

    const selector = typeof args?.selector === 'string' ? args.selector.trim() : '';
    const targetRefs = [args?.ref_id, probe.refId]
      .filter(value => typeof value === 'string' && !!value);
    const probeRegionIds = [probe.toolbarRegionRef, probe.toolbarRegionKey]
      .filter(value => typeof value === 'string' && !!value);
    const matches = obligation => (
      (!!selector && (
        obligation.blockedToolbarSelector === selector
        || (obligation.blockedSelectors || []).includes(selector)
      ))
      || targetRefs.some(refId => (
        obligation.blockedToolbarRef === refId
        || (obligation.blockedRefs || []).includes(refId)
      ))
      || (probe.toolbarContext === true && [
        obligation.regionRef,
        obligation.regionKey,
        ...(obligation.blockedRegionRefs || []),
      ].filter(Boolean).some(regionId => probeRegionIds.includes(regionId)))
    );
    const matchedObligation = scopedObligations.find(matches);
    return {
      block: matchedObligation ? retryBlock(matchedObligation) : null,
      rememberScope: !iframeTool && !!(liveDocument || livePageUrl),
      guarded: true,
    };
  }

  recordWrongTarget(tabId, { toolName, args = {}, candidate = {}, decision = {}, identity = {} }) {
    const refId = typeof args?.ref_id === 'string' ? args.ref_id : '';
    const selector = typeof args?.selector === 'string' ? args.selector.trim() : '';
    const documentToken = String(identity.documentToken || '');
    const pageUrl = String(identity.refScopeUrl || '');
    let prior = this.obligations(tabId);
    const stalePrior = new Set(prior.filter(obligation => (
      obligation.recoveryOnly !== true
      && obligation.documentToken
      && documentToken
      && obligation.documentToken !== documentToken
      && obligationMatchesFrame(obligation, identity.frameId)
    )));
    if (stalePrior.size > 0) {
      prior = prior.map(obligation => (
        stalePrior.has(obligation) ? demoteObligationForNavigation(obligation) : obligation
      ));
    }

    const associatedEditorRef = candidate?.associatedEditorRef || '';
    const associatedEditorIdentity = candidate?.associatedEditorIdentity || null;
    const recoveryTargetUnknown = !associatedEditorRef
      && !richTextToolbarEditorIdentityRecoverable(associatedEditorIdentity);
    const relatedRefs = (candidate?.relatedRefs || [])
      .filter(relatedRef => typeof relatedRef === 'string' && /^ref_\d+$/.test(relatedRef));
    const obligation = {
      toolName,
      source: decision.source,
      recoveryOnly: false,
      targetKind: decision.targetKind && decision.targetKind !== 'uncertain'
        ? decision.targetKind
        : 'other_formatting',
      detectedAt: this.now(),
      blockedAttemptedText: typeof args?.text === 'string' ? args.text : undefined,
      blockedClear: richTextToolbarEffectiveClear(toolName, args),
      blockedToolbarRef: refId,
      blockedToolbarSelector: selector,
      associatedEditorRef,
      associatedEditorIdentity,
      recoveryTargetUnknown,
      recoveryPageUrl: '',
      documentToken,
      pageUrl,
      frameId: Number.isInteger(identity.frameId) ? identity.frameId : null,
      frameScoped: Number.isInteger(identity.frameId) && identity.frameId !== 0,
      regionRef: candidate?.regionRef || '',
      regionKey: candidate?.regionKey || '',
      blockedRefs: [...new Set([refId, ...relatedRefs].filter(Boolean))],
      blockedSelectors: selector ? [selector] : [],
      blockedRegionRefs: [...new Set([candidate?.regionRef, candidate?.regionKey].filter(Boolean))],
    };

    const nextKey = obligationKey(obligation);
    let duplicateIndex = nextKey
      ? prior.findIndex(entry => obligationKey(entry) === nextKey)
      : -1;
    if (duplicateIndex < 0) {
      const semanticKey = obligationKey(obligation, { includeLiveFrame: false });
      const recoveredMatches = semanticKey
        ? prior
            .map((entry, index) => ({ entry, index }))
            .filter(({ entry }) => entry.recoveryOnly === true
              && !Number.isInteger(entry.frameId)
              && obligationKey(entry, { includeLiveFrame: false }) === semanticKey)
        : [];
      if (recoveredMatches.length === 1) duplicateIndex = recoveredMatches[0].index;
    }
    const obligations = duplicateIndex >= 0
      ? prior.map((entry, index) => index === duplicateIndex ? mergeObligation(entry, obligation) : entry)
      : [...prior, obligation];
    this.ledger.set(tabId, obligations);
    return {
      obligation: duplicateIndex >= 0 ? obligations[duplicateIndex] : obligation,
      obligationCount: obligations.length,
      blockedRefCount: new Set(obligations.flatMap(entry => entry.blockedRefs || [])).size,
      hasExactRecoveryTarget: !!associatedEditorRef
        || richTextToolbarEditorIdentityRecoverable(associatedEditorIdentity),
    };
  }

  recover(tabId, { toolName, args = {}, result = {}, probe = {} }) {
    if (result?.success !== true || result?.verified !== true) return null;
    if (!['set_field', 'type_ax', 'type_text', 'iframe_type'].includes(toolName)) return null;
    const obligations = this.obligations(tabId);
    const recoveryClear = richTextToolbarEffectiveClear(toolName, args);
    for (let index = 0; index < obligations.length; index += 1) {
      const obligation = obligations[index];
      if (
        typeof obligation.blockedAttemptedText !== 'string'
        || typeof obligation.blockedClear !== 'boolean'
        || typeof args?.text !== 'string'
        || args.text !== obligation.blockedAttemptedText
        || recoveryClear !== obligation.blockedClear
      ) continue;
      const fieldMeta = probe.fieldMeta || result?.fieldMeta || {};
      const strategy = recoveryMatch(obligation, { toolName, args, probe, fieldMeta });
      if (!strategy) continue;
      const remaining = obligations.filter((_entry, entryIndex) => entryIndex !== index);
      if (remaining.length === 0) this.reset(tabId);
      else this.ledger.set(tabId, remaining);
      return { ...strategy, refId: probe.refId || null, remainingCount: remaining.length };
    }
    return null;
  }
}
