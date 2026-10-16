import { applyCaptchaFrameVisibility } from './captcha-frame-runtime.js';

// The names of CAPTCHA products, which pages show untranslated in every
// language. Whether any other dialog asks the person to prove they are human
// is read from its title by a model, in any language (the page_blocker
// question, answered `human_check`): `read(title)` gives a reading the agent
// holds, and the scans that run in the page take those readings as
// `challengeReadings` and report the titles nobody has read yet.
export const CAPTCHA_CHALLENGE_LABEL_PATTERN_SOURCE = String.raw`\b(?:re|h|fun)?captcha\b`;
const CHALLENGE_DIALOG_RE = new RegExp(CAPTCHA_CHALLENGE_LABEL_PATTERN_SOURCE, 'i');
export const CHALLENGE_TITLE_READING = 'human_check';

export function captchaChallengeMatcherOptions(challengeReadings = null) {
  return {
    challengeLabelPatternSource: CAPTCHA_CHALLENGE_LABEL_PATTERN_SOURCE,
    ...(challengeReadings && typeof challengeReadings === 'object' ? { challengeReadings } : {}),
  };
}

function matchesChallengeLabel(value) {
  return CHALLENGE_DIALOG_RE.test(String(value || ''));
}

// A dialog's title as the readings key it: spaces collapsed, at most 200
// characters, and neither a space nor half of a surrogate pair at its end
// once cut, so the page and the agent key a long title alike. The scans
// that run in the page and captcha-frame-runtime.js keep the same rule.
export function challengeTitleText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[\ud800-\udbff]$/, '').trim();
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
  // Only the quoted name immediately after the role is a label. A nameless
  // textbox can still contain quoted value/placeholder attributes.
  if (!/^\s*[\w-]+\s+"/.test(input)) return '';
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

// The titles of an accessibility tree's dialogs: each dialog's own name and
// the names of the headings inside it. Labels outside editable contents that
// name a CAPTCHA product count on their own; titles and static field names
// count once a model read them as asking to prove the person is human.
function challengeDialogEntries(pageContent) {
  const lines = String(pageContent || '').split(/\r?\n/);
  const dialogs = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const dialogMatch = line.match(/^(\s*)(?:dialog|alertdialog)(?=\s|$)/i);
    if (!dialogMatch) continue;
    const dialogIndent = dialogMatch[1].length;
    const labels = [];
    let editableIndent = null;
    const ownLabel = parseSerializedTreeLabel(line);
    if (ownLabel) labels.push({ label: ownLabel, title: true });
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const childLine = lines[childIndex];
      if (!childLine.trim()) continue;
      const childIndent = childLine.match(/^\s*/)?.[0].length || 0;
      if (childIndent <= dialogIndent) break;
      if (editableIndent != null && childIndent > editableIndent) continue;
      editableIndent = null;
      if (/^\s*(?:textbox|searchbox|combobox)(?=\s|$)/i.test(childLine)
          || /\bcontenteditable=(?:true|"(?:true|plaintext-only)")/i.test(childLine)) {
        // The field's name is separate from its authored value/descendants.
        // Read its meaning rather than treating a mention of CAPTCHA as proof:
        // an editor labelled "CAPTCHA article body" is not an answer field.
        if (/^\s*(?:textbox|searchbox|combobox)(?=\s|$)/i.test(childLine)) {
          const fieldLabel = parseSerializedTreeLabel(childLine);
          if (fieldLabel) labels.push({ label: fieldLabel, title: false, field: true });
        }
        editableIndent = childIndent;
        continue;
      }
      const childLabel = parseSerializedTreeLabel(childLine);
      if (childLabel) labels.push({ label: childLabel, title: /^\s*heading(?=\s|$)/i.test(childLine) });
    }
    // Authored bodies were excluded above. An answer field does not erase
    // the independent static first-line title of an unnamed dialog.
    if (!labels.some(entry => entry.title)) {
      const firstStaticLabel = labels.find(entry => !entry.field);
      if (firstStaticLabel) firstStaticLabel.title = true;
    }
    dialogs.push(labels);
  }
  return dialogs;
}

export function detectChallengeDialog(pageContent, read = null) {
  const readsAsChallenge = label => typeof read === 'function'
    && read(challengeTitleText(label)) === CHALLENGE_TITLE_READING;
  for (const labels of challengeDialogEntries(pageContent)) {
    const match = labels.find(({ label, title, field }) => field
      ? readsAsChallenge(label)
      : matchesChallengeLabel(label) || (title && readsAsChallenge(label)));
    if (match) {
      return {
        label: match.label,
        normalizedLabel: normalizeChallengeLabel(match.label),
      };
    }
  }
  return null;
}

// The dialog titles of an accessibility tree that a model has to read before
// detectChallengeDialog can tell whether they ask to prove the person is
// human. Titles naming a CAPTCHA product need no reading; field names do,
// because an editor may be labelled for an article about CAPTCHA.
export function challengeDialogTitles(pageContent, limit = 12) {
  const titles = new Set();
  for (const labels of challengeDialogEntries(pageContent)) {
    if (labels.some(({ label, field }) => !field && matchesChallengeLabel(label))) continue;
    for (const { label, title, field } of labels) {
      const text = challengeTitleText(label);
      if ((title || field) && text) titles.add(text);
    }
  }
  // Keep a CAPTCHA answer name inside the bounded semantic batch even when
  // a registration form has many ordinary named fields. This priority does
  // not make a field name positive evidence without its human-check reading.
  return [...titles].sort((left, right) => Number(matchesChallengeLabel(right)) - Number(matchesChallengeLabel(left)))
    .slice(0, limit);
}

// Serialized into the page for a lightweight, read-only preflight before
// model-authored mutations. Keep this function self-contained.
export function detectChallengeDialogInPage(options = null) {
  const includeFrameContext = options?.includeFrameContext === true;
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
  let challengeRe = null;
  try {
    const source = String(options?.challengeLabelPatternSource || '');
    if (source) challengeRe = new RegExp(source, 'i');
  } catch {}
  const matchesChallenge = value => {
    return challengeRe?.test(String(value || '')) === true;
  };
  // Titles a model read as asking to prove the person is human (the agent's
  // page_blocker readings), and the titles of visible dialogs nobody has read.
  const givenTitleReadings = options?.challengeReadings && typeof options.challengeReadings === 'object'
    ? options.challengeReadings : {};
  const titleReading = title => (Object.prototype.hasOwnProperty.call(givenTitleReadings, title)
    ? String(givenTitleReadings[title] || '') : '');
  // Keyed as challengeTitleText keys a title.
  const titleText = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    .replace(/[\ud800-\udbff]$/, '').trim();
  const unreadTitles = [];
  const visible = (element) => {
    try {
      const elementStyle = getComputedStyle(element);
      if (elementStyle.visibility === 'hidden' || elementStyle.visibility === 'collapse') return false;
      let current = element;
      for (let depth = 0; current && depth < 30; depth += 1) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || Number(style.opacity) === 0) return false;
        if (current.hidden || current.getAttribute?.('aria-hidden') === 'true') return false;
        current = current.parentElement
          || (typeof current.getRootNode === 'function' ? current.getRootNode()?.host : null)
          || null;
      }
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
  // User-authored editor contents are data, even when they discuss CAPTCHA.
  // Read static text nodes instead of an ancestor's aggregate innerText,
  // which includes contenteditable drafts and their headings.
  const editableSelector = 'input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]';
  const authored = element => !!element?.closest?.(editableSelector);
  const fieldLabelElements = new Set();
  const staticText = (element, onlyVisible = true, omitFieldLabels = true) => {
    if (!element || authored(element)) return '';
    // Small DOM stand-ins used by callers may expose only rendered text.
    if (!element.childNodes) return String(element.innerText || element.textContent || '');
    const text = [];
    let visited = 0;
    const renderedText = node => {
      try {
        const style = getComputedStyle(node.parentElement);
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        const range = (node.ownerDocument || document).createRange();
        range.selectNodeContents(node);
        // display:contents parents have no rectangle of their own, although
        // their text renders normally. Measure the text instead of its parent.
        return Array.from(range.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
      } catch { return visible(node.parentElement); }
    };
    const walk = (node, depth) => {
      if (++visited > 4000 || depth > 40) return;
      if (node.nodeType === 3) {
        if (!onlyVisible || renderedText(node)) text.push(node.textContent || '');
        return;
      }
      if (node.nodeType !== 1 || authored(node)
          || /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) return;
      if (omitFieldLabels && node !== element && fieldLabelElements.has(node)) return;
      const style = getComputedStyle(node);
      if (onlyVisible) {
        if (style.display === 'none' || Number(style.opacity) === 0
            || node.hidden || node.getAttribute?.('aria-hidden') === 'true') return;
      }
      // CSS determines rendered word boundaries. A block span separates
      // words; an inline div or a display:contents wrapper does not.
      const block = node.tagName === 'BR'
        || /^(?:block|flow-root|flex|grid|list-item|table)(?:$|[- ])/.test(style.display);
      if (block) text.push('\n');
      for (const child of node.childNodes || []) walk(child, depth + 1);
      if (block) text.push('\n');
    };
    walk(element, 0);
    return text.join('');
  };
  // This detector is serialized into the page, so it cannot call the exported
  // classifier below. Keep the vendor-specific routes aligned with it.
  const activeFrameVendor = (value) => {
    try {
      const parsed = new URL(String(value || ''));
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.toLowerCase();
      if (
        (/(^|\.)google\.com$/.test(host) || /(^|\.)recaptcha\.net$/.test(host))
        && /\/recaptcha\/(?:api2|enterprise)\/bframe(?:\/|$)/.test(path)
      ) return 'recaptcha';
      if (/(^|\.)hcaptcha\.com$/.test(host)) {
        const frame = new URLSearchParams(String(parsed.hash || '').replace(/^#/, '')).get('frame');
        if (frame === 'challenge') return 'hcaptcha';
      }
      if (
        /(^|\.)(?:arkoselabs|funcaptcha)\.com$/.test(host)
        && /\/fc\/gc(?:\/|$)/.test(path)
      ) return 'arkose';
    } catch {}
    return '';
  };
  const childFrames = Array.from(document.querySelectorAll('iframe')).map((element, index) => {
    let loadedUrl = '';
    try {
      loadedUrl = String(element.contentWindow?.location?.href || '');
    } catch {}
    const url = String(element.getAttribute?.('src') || element.src || '');
    const activeChallengeVendor = activeFrameVendor(loadedUrl || url);
    return {
      index,
      url,
      loadedUrl,
      name: String(element.getAttribute?.('name') || element.name || ''),
      visible: visible(element),
      ...(activeChallengeVendor ? { activeChallengeVendor } : {}),
    };
  });
  // A challenge dialog that exists in the DOM but is hidden or off-viewport
  // is positive evidence the challenge is inactive. Report it separately so
  // callers can distinguish "confirmed hidden" from "not found" — a dialog
  // this scan cannot see at all (closed shadow root, unreachable frame) must
  // not be treated as disproved.
  let hiddenChallenge = null;
  const finish = challenge => includeFrameContext
    ? {
        challenge,
        ...(hiddenChallenge ? { hiddenChallenge } : {}),
        ...(!challenge && unreadTitles.length ? {
          // A long form's ordinary field names must not crowd a possible
          // CAPTCHA answer name out of the bounded semantic reading batch.
          unreadTitles: [
            ...unreadTitles.filter(matchesChallenge),
            ...unreadTitles.filter(title => !matchesChallenge(title)),
          ].slice(0, 12),
        } : {}),
        frameContext: {
          frameUrl,
          frameName,
          childFrames,
        },
      }
    : challenge;
  // The accessibility tree pierces open shadow roots on some sites, where
  // frameworks (e.g. LinkedIn's interop shell) render whole dialogs that
  // document.querySelectorAll cannot see. Scan open shadow roots too so this
  // preflight can confirm the same dialogs the tree reports.
  const dialogSelector = 'dialog, [role="dialog"], [role="alertdialog"]';
  const dialogCandidates = [];
  const collectDialogs = (root, depth) => {
    try {
      for (const element of root.querySelectorAll(dialogSelector)) {
        if (dialogCandidates.length >= 200) break;
        dialogCandidates.push(element);
      }
    } catch {}
    if (depth >= 4) return;
    let descendants;
    try { descendants = root.querySelectorAll('*'); } catch { return; }
    for (const host of descendants) {
      if (host.shadowRoot) collectDialogs(host.shadowRoot, depth + 1);
    }
  };
  collectDialogs(document, 0);
  const dialogLabelledBy = (element, onlyVisible = true) => {
    try {
      const idRoot = (typeof element.getRootNode === 'function' && element.getRootNode()) || document;
      return String(element.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map(id => staticText((typeof idRoot.getElementById === 'function' ? idRoot : document)
          .getElementById(id), onlyVisible))
        .join(' ');
    } catch { return ''; }
  };
  // Names of answer fields are instructions a model must read, not proof
  // merely because the name mentions CAPTCHA. Never inspect field values.
  const dialogFieldLabels = (element, onlyVisible = true) => {
    const names = [];
    for (const field of element.querySelectorAll?.(editableSelector) || []) {
      if (authored(field.parentElement) || (onlyVisible && !visible(field))) continue;
      // A hidden dialog may have ordinary answer fields, but an explicitly
      // hidden solver response cannot claim its independent static title.
      if (!onlyVisible && (field.hidden || field.getAttribute?.('type') === 'hidden'
          || getComputedStyle(field).display === 'none')) continue;
      let labelledElements = [];
      let nativeLabels = [];
      try {
        const idRoot = field.getRootNode?.() || document;
        labelledElements = String(field.getAttribute?.('aria-labelledby') || '')
          .split(/\s+/).filter(Boolean)
          .map(id => (typeof idRoot.getElementById === 'function' ? idRoot : document).getElementById(id))
          .filter(Boolean);
        nativeLabels = Array.from(field.labels || []);
      } catch {}
      // Route associated label text through semantic field-name readings,
      // while independent dialog titles and headings retain their own text.
      for (const label of [...labelledElements, ...nativeLabels]) fieldLabelElements.add(label);
      const name = titleText(field.getAttribute?.('aria-label'))
        || titleText(labelledElements.map(label => staticText(label, false, false)).join(' '))
        || titleText(nativeLabels.map(label => staticText(label, false, false)).join(' '));
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  };
  // A dialog's title: its accessible name, else its first heading, else its
  // title attribute, else the first line of its static text. Answer inputs
  // and hidden solver responses do not remove an independent static title.
  const dialogTitle = (element, labelledBy = '', onlyVisibleHeadings = true) => {
    let heading = '';
    try {
      heading = Array.from(element.querySelectorAll?.('h1, h2, h3, [role="heading"]') || [])
        .filter(node => !authored(node) && (!onlyVisibleHeadings || visible(node)
          || getComputedStyle(node).display === 'contents'))
        .map(node => titleText(staticText(node, onlyVisibleHeadings)))
        .find(Boolean) || '';
    } catch {}
    const named = titleText(element.getAttribute?.('aria-label')) || titleText(labelledBy) || heading
      || titleText(element.getAttribute?.('title'));
    if (named) return named;
    return titleText(staticText(element, onlyVisibleHeadings).split(/\r?\n/).find(line => line.trim()));
  };
  const recordHiddenChallenge = (element) => {
    if (hiddenChallenge) return;
    try {
      const fieldLabels = dialogFieldLabels(element, false);
      const values = [
        element.getAttribute?.('aria-label'),
        dialogLabelledBy(element, false),
        element.getAttribute?.('title'),
        staticText(element, false),
        ...Array.from(element.querySelectorAll?.('h1, h2, h3, [role="heading"]') || [])
          .filter(heading => !authored(heading))
          .map(heading => staticText(heading, false)),
      ];
      for (const value of values) {
        const text = String(value || '');
        if (!matchesChallenge(text)) continue;
        const line = text.split(/\r?\n/).find(entry => matchesChallenge(entry)) || text;
        const label = line.replace(/\s+/g, ' ').trim().slice(0, 200);
        if (label) {
          hiddenChallenge = { label };
          return;
        }
      }
      const title = dialogTitle(element, dialogLabelledBy(element, false), false);
      const label = [title, ...fieldLabels].find(value => value && titleReading(value) === 'human_check');
      if (label) hiddenChallenge = { label };
    } catch {}
  };
  for (const element of dialogCandidates) {
    if (!visible(element)) {
      recordHiddenChallenge(element);
      continue;
    }
    // Accessible names may reference a hidden label; its text still names
    // the visible dialog. Editor-backed references remain excluded.
    const fieldLabels = dialogFieldLabels(element);
    const labelledBy = dialogLabelledBy(element, false);
    let renderedHeadings = '';
    try {
      renderedHeadings = Array.from(
        element.querySelectorAll?.('h1, h2, h3, [role="heading"]') || []
      )
        .filter(heading => !authored(heading) && (visible(heading)
          || getComputedStyle(heading).display === 'contents'))
        .map(heading => staticText(heading))
        .join(' ');
    } catch {}
    const values = [
      element.getAttribute?.('aria-label'),
      labelledBy,
      renderedHeadings,
      element.getAttribute?.('title'),
      staticText(element),
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
    // A title read as asking to prove the person is human is the challenge's
    // label, as the accessibility tree names the dialog.
    const title = dialogTitle(element, labelledBy);
    for (const label of [title, ...fieldLabels]) {
      if (!label) continue;
      const choice = titleReading(label);
      if (choice === 'human_check') return finish({ label });
      if (!choice && !unreadTitles.includes(label)) unreadTitles.push(label);
    }
  }
  const activeChallengeFrame = childFrames.find(frame =>
    frame.visible === true && frame.activeChallengeVendor
  );
  if (activeChallengeFrame) {
    const vendorLabel = activeChallengeFrame.activeChallengeVendor === 'recaptcha'
      ? 'reCAPTCHA'
      : activeChallengeFrame.activeChallengeVendor === 'hcaptcha'
        ? 'hCaptcha'
        : 'Arkose';
    return finish({
      label: `Visible ${vendorLabel} challenge frame`,
      languageNeutralFrame: true,
    });
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
  const addFrame = ({
    frameId = null,
    parentFrameId = null,
    frameUrl = '',
    source,
    visible = null,
    activeChallengeFrame = false,
  }) => {
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
      ...(activeChallengeFrame ? { activeChallengeFrame: true } : {}),
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
  const embeddedFrames = [];
  for (const context of frameContexts || []) {
    addFrame({
      frameId: context?.frameId,
      frameUrl: context?.frameUrl,
      source: 'document',
    });
    for (const child of context?.childFrames || []) {
      embeddedFrames.push({
        frameId: context?.frameId,
        frameUrl: child?.loadedUrl || child?.url,
        visible: child?.visible,
        activeChallengeFrame: child?.activeChallengeFrame === true,
      });
    }
  }
  const visibleEmbeddedFrames = applyCaptchaFrameVisibility(
    embeddedFrames,
    frameContexts,
    navigationFrames,
  );
  for (const frame of visibleEmbeddedFrames) {
    addFrame({
      frameId: frame?.frameId,
      frameUrl: frame?.frameUrl,
      source: 'embedded',
      visible: frame?.visible,
      activeChallengeFrame: frame?.activeChallengeFrame === true,
    });
  }
  for (const candidate of candidates || []) {
    addFrame({
      frameId: candidate?.frameId,
      frameUrl: candidate?.frameUrl,
      source: 'candidate',
      visible: candidate?.visible,
      activeChallengeFrame: candidate?.activeChallengeFrame === true,
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
