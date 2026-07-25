// CapSolver REST client + page-side detect/inject helpers.
//
// We do not bundle the CapSolver browser extension. Instead we talk directly
// to https://api.capsolver.com:
//   POST /createTask     → { taskId } | { errorId, errorCode, errorDescription }
//   POST /getTaskResult  → { status: "ready"|"processing", solution? }
//   POST /getBalance     → { balance, packages }
//
// Coverage today: reCAPTCHA v2 (checkbox/invisible), reCAPTCHA v3, both of
// those in their Enterprise flavour, hCaptcha, Cloudflare Turnstile, plain
// image-to-text. Other types CapSolver supports (FunCaptcha, AWS WAF,
// GeeTest, datadome) are not auto-detected here yet — the agent can still
// drive them by passing an explicit `type` to solve_captcha and the right
// `taskTypeOverride`.

const API_BASE = 'https://api.capsolver.com';
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 120_000;
const DEFAULT_APP_ID = 'B7E57F27-0AD3-434D-A5B7-CF9EE7D093EE'; // CapSolver public affiliate id; used only to identify the integration.

// ─── REST ──────────────────────────────────────────────────────────────

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CapSolver ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try { return await res.json(); } catch {
    throw new Error(`CapSolver ${path} returned invalid JSON.`);
  }
}

// Wrap a CapSolver error response in a friendlier message.
//
// Two failure classes look nearly identical on the wire but need opposite
// responses from the model, so we key off the *description* rather than the
// error code — CapSolver reuses ERROR_INVALID_TASK_DATA and
// ERROR_WRONG_CAPTCHA_TYPE for both:
//
//   1. Refused sitekey. CapSolver won't farm public TEST/DEMO keys (Google's
//      recaptcha demo, hcaptcha.com/demo) because no genuine token would come
//      back. Description reads like "We don't support this service." The fix
//      is to try the flow on a real production site.
//   2. Bad task configuration. Description reads like "Invalid input: check
//      captcha type or parameters" — you get this when the task type doesn't
//      match the widget, e.g. a plain ReCaptchaV2TaskProxyLess against an
//      Enterprise sitekey. The fix is to correct `type`/`isEnterprise`.
//
// Blaming (2) on a demo key is actively harmful: the model gives up and moves
// to another site instead of retrying with the right task type. Match the
// demo phrasing narrowly for the same reason — an earlier bare /test/ matched
// the "test" inside "latest" and mislabelled ordinary parameter errors.
const CAPSOLVER_TASK_CONFIG_RE = /invalid input|check captcha type|wrong captcha type/i;
const CAPSOLVER_DEMO_KEY_RE = /\btest\s*(?:site\s*)?key\b|\bdemo\b|unsupported|don['’]?t[\s_]support|not[\s_]support/i;

function capsolverError(prefix, body) {
  const desc = body.errorDescription || body.errorCode || 'unknown error';
  if (CAPSOLVER_TASK_CONFIG_RE.test(desc)) {
    return new Error(
      `${prefix}: ${desc}. CapSolver rejected the task configuration, not the sitekey — most often the task type doesn't match the widget (a plain reCAPTCHA task against an Enterprise sitekey, or a v2 task against a v3 key). Re-check the detected type and pass \`type\` / \`isEnterprise\` explicitly.`
    );
  }
  if (CAPSOLVER_DEMO_KEY_RE.test(desc)) {
    return new Error(
      `${prefix}: ${desc}. This usually means CapSolver refused the sitekey — most often because it is a public TEST/DEMO key (Google's recaptcha demo, hcaptcha.com/demo, etc.) that no captcha-solving service will farm. Try the same flow on a real production site.`
    );
  }
  return new Error(`${prefix}: ${desc}`);
}

export async function getBalance(apiKey) {
  if (!apiKey) throw new Error('No CapSolver API key configured.');
  const res = await postJson('/getBalance', { clientKey: apiKey });
  if (!res || typeof res !== 'object') throw new Error('CapSolver getBalance returned unexpected response.');
  if (res.errorId) throw capsolverError('CapSolver', res);
  return { balance: res.balance ?? 0, packages: res.packages || [] };
}

async function createTask(apiKey, task) {
  const res = await postJson('/createTask', {
    clientKey: apiKey,
    appId: DEFAULT_APP_ID,
    task,
  });
  if (!res || typeof res !== 'object') throw new Error('CapSolver createTask returned unexpected response.');
  if (res.errorId) throw capsolverError('CapSolver createTask', res);
  if (!res.taskId) throw new Error('CapSolver createTask returned no taskId.');
  return res.taskId;
}

async function pollTaskResult(apiKey, taskId, { timeoutMs = POLL_TIMEOUT_MS } = {}) {
  const effectiveTimeout = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : POLL_TIMEOUT_MS;
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    const res = await postJson('/getTaskResult', { clientKey: apiKey, taskId });
    if (!res || typeof res !== 'object') throw new Error('CapSolver getTaskResult returned unexpected response.');
    if (res.errorId) throw capsolverError('CapSolver getTaskResult', res);
    if (res.status === 'ready') return res.solution || {};
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`CapSolver: timed out after ${Math.round(timeoutMs / 1000)}s waiting for solution.`);
}

// ─── Task builders ─────────────────────────────────────────────────────
//
// Each builder takes the params the agent / detector gathered from the page
// and returns the task object CapSolver's createTask endpoint expects. We
// default to the "proxyless" task types so the user doesn't need to BYO
// proxy — that's the simplest path and what virtually every reCAPTCHA /
// hCaptcha / Turnstile setup actually needs.
//
// `enterprisePayload` is accepted but deliberately absent from the
// solve_captcha schema (same as on the hCaptcha branch): it carries the
// site-specific `s` token some Enterprise deployments require, which a model
// has no way to obtain from the page. It stays here so callers that do have
// one can pass it through.

// Type aliases the model or the detector may hand us. Kept as sets rather
// than inline `||` chains so buildTask and captchaParamError below can't
// drift apart on which spellings count as v3.
const RECAPTCHA_V2_TYPES = new Set(['recaptcha_v2', 'recaptchav2', 'recaptcha_v2_enterprise', 'recaptcha_enterprise']);
const RECAPTCHA_V3_TYPES = new Set(['recaptcha_v3', 'recaptchav3', 'recaptcha_v3_enterprise']);

// Validate the params CapSolver would reject before we spend a request on
// them. Exported so agent.js can run it *before* it flags the tool call as
// dispatched — a missing pageAction is a local argument error, not an
// external side effect. Returns an error string, or null when the params
// are usable.
export function captchaParamError(params) {
  const t = String(params?.type || '').toLowerCase();
  if (!t) return 'solve_captcha: type is required.';
  if (RECAPTCHA_V3_TYPES.has(t) && !(params.pageAction || params.action)) {
    return `solve_captcha: ${params.type} requires a \`pageAction\` (e.g. "login", "submit"). reCAPTCHA v3 scores the action name, so CapSolver cannot mint a usable token without it — pass \`pageAction\` explicitly.`;
  }
  return null;
}

function buildTask({ type, websiteURL, websiteKey, ...rest }) {
  const t = String(type || '').toLowerCase();
  const isEnterprise = !!rest.isEnterprise || t.includes('enterprise');
  if (RECAPTCHA_V2_TYPES.has(t)) {
    return {
      type: isEnterprise ? 'ReCaptchaV2EnterpriseTaskProxyLess' : 'ReCaptchaV2TaskProxyLess',
      websiteURL,
      websiteKey,
      ...(rest.isInvisible != null ? { isInvisible: !!rest.isInvisible } : {}),
      ...(rest.enterprisePayload ? { enterprisePayload: rest.enterprisePayload } : {}),
      ...(rest.userAgent ? { userAgent: rest.userAgent } : {}),
    };
  }
  if (RECAPTCHA_V3_TYPES.has(t)) {
    const pageAction = rest.pageAction || rest.action;
    return {
      type: isEnterprise ? 'ReCaptchaV3EnterpriseTaskProxyLess' : 'ReCaptchaV3TaskProxyLess',
      websiteURL,
      websiteKey,
      pageAction,
      ...(rest.minScore ? { minScore: rest.minScore } : {}),
      ...(rest.enterprisePayload ? { enterprisePayload: rest.enterprisePayload } : {}),
    };
  }
  if (t === 'hcaptcha') {
    return {
      type: 'HCaptchaTaskProxyLess',
      websiteURL,
      websiteKey,
      ...(rest.isInvisible != null ? { isInvisible: !!rest.isInvisible } : {}),
      ...(rest.enterprisePayload ? { enterprisePayload: rest.enterprisePayload } : {}),
      ...(rest.userAgent ? { userAgent: rest.userAgent } : {}),
    };
  }
  if (t === 'turnstile' || t === 'cloudflare' || t === 'cf_turnstile') {
    return {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL,
      websiteKey,
      ...(rest.metadata ? { metadata: rest.metadata } : {}),
    };
  }
  if (t === 'image_to_text' || t === 'image') {
    return {
      type: 'ImageToTextTask',
      body: rest.body, // base64 png/jpg, no data: prefix
      ...(rest.module ? { module: rest.module } : {}),
      ...(rest.case != null ? { case: !!rest.case } : {}),
    };
  }
  throw new Error(`solve_captcha: unsupported type "${type}".`);
}

// Pick the right token-field name + injection strategy for each captcha
// type. The DOM convention is well-documented for the ones we auto-handle.
function solutionFor(type, solution) {
  const t = String(type || '').toLowerCase();
  // Covers every reCAPTCHA spelling — v2/v3, snake or camel, Enterprise or
  // not. They all return the token under the same solution key and inject
  // into the same field.
  if (t.startsWith('recaptcha')) {
    return { token: solution.gRecaptchaResponse, fieldName: 'g-recaptcha-response' };
  }
  if (t === 'hcaptcha') {
    // Both names exist in the wild — old hCaptcha forms use h-captcha-response,
    // some sites still listen on g-recaptcha-response for hCaptcha drop-ins.
    return { token: solution.gRecaptchaResponse, fieldName: 'h-captcha-response', alsoSet: 'g-recaptcha-response' };
  }
  if (t === 'turnstile' || t === 'cloudflare' || t === 'cf_turnstile') {
    return { token: solution.token, fieldName: 'cf-turnstile-response' };
  }
  if (t === 'image_to_text' || t === 'image') {
    return { token: solution.text, fieldName: null }; // caller types it in
  }
  return { token: null, fieldName: null };
}

// ─── solveCaptcha — the public entry point ────────────────────────────

export async function solveCaptcha(apiKey, params) {
  if (!apiKey) throw new Error('No CapSolver API key configured.');
  const paramError = captchaParamError(params);
  if (paramError) throw new Error(paramError);
  const task = buildTask(params);
  const taskId = await createTask(apiKey, task);
  const solution = await pollTaskResult(apiKey, taskId);
  const meta = solutionFor(params.type, solution);
  return { taskId, solution, ...meta };
}

// ─── Page-side detection ───────────────────────────────────────────────
//
// Runs in the page world via chrome.scripting.executeScript. Looks for the
// well-known DOM markers each provider drops in. Returns null when nothing
// is found so the caller can decide whether to error or fall back to
// asking the user.
//
// We intentionally inspect light DOM only — every major captcha widget
// renders its container element (the `data-sitekey` host) in the host
// page's light DOM, even if its UI lives inside a same-origin iframe.

function detectCaptchaInPage() {
  // Helpers are declared inside the function, not at module scope: this whole
  // body is serialised into the page world by chrome.scripting.executeScript,
  // so it cannot close over anything outside itself.
  const V3_NO_ACTION_NOTE = 'reCAPTCHA v3 detected, but the page never exposed an action name. solve_captcha needs pageAction — read it from the grecaptcha.execute(...) call in the site JS, or infer it from the form (login, submit, checkout).';

  // reCAPTCHA v3 puts the action name in the loader script's query string.
  // Parse it with URL so percent-encoded action names come back decoded.
  const getUrlAction = (urlStr) => {
    try {
      const u = new URL(urlStr, 'https://dummy.host');
      const act = u.searchParams.get('action') || u.searchParams.get('pageAction') || u.searchParams.get('page_action');
      return act ? act.trim() : null;
    } catch {}
    return null;
  };

  // Helper: visit same-origin iframes too, since reCAPTCHA on many sites
  // is rendered inside a same-origin wrapper. Cross-origin frames are
  // skipped (their .contentDocument throws on access).
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try {
      const d = f.contentDocument;
      if (d) docs.push(d);
    } catch { /* cross-origin */ }
  }

  for (const d of docs) {
    // Order matters: check provider-specific widgets BEFORE the generic
    // reCAPTCHA fallback. Cloudflare Turnstile and hCaptcha widgets can
    // carry `data-sitekey` + `data-callback` too, and an earlier version
    // of this function caught them with `div[data-sitekey][data-callback]`
    // and misclassified them as reCAPTCHA → CapSolver got the wrong task
    // type and failed.

    // hCaptcha (.h-captcha[data-sitekey])
    const hcap = d.querySelector('.h-captcha[data-sitekey], div[data-hcaptcha-widget-id]');
    if (hcap) {
      const sitekey = hcap.getAttribute('data-sitekey') || hcap.getAttribute('data-hcaptcha-sitekey');
      if (sitekey) {
        const size = hcap.getAttribute('data-size');
        return {
          type: 'hcaptcha',
          websiteKey: sitekey,
          isInvisible: size === 'invisible',
        };
      }
    }
    // Cloudflare Turnstile (.cf-turnstile[data-sitekey])
    const turn = d.querySelector('.cf-turnstile[data-sitekey], [data-turnstile-sitekey]');
    if (turn) {
      const sitekey = turn.getAttribute('data-sitekey') || turn.getAttribute('data-turnstile-sitekey');
      if (sitekey) {
        return { type: 'turnstile', websiteKey: sitekey };
      }
    }
    // reCAPTCHA v2/v3, classic or Enterprise. `.g-recaptcha` is the documented
    // host class; `data-recaptcha-sitekey` is a wrapper convention several
    // form libraries use. Both are reCAPTCHA-specific, so this still doesn't
    // grab a bare `data-sitekey` belonging to another provider.
    const recap = d.querySelector('.g-recaptcha[data-sitekey], div[id^="g-recaptcha"][data-sitekey], [data-recaptcha-sitekey]');
    if (recap) {
      const sitekey = recap.getAttribute('data-sitekey') || recap.getAttribute('data-recaptcha-sitekey');
      if (sitekey) {
        const size = recap.getAttribute('data-size');
        const isInvisible = size === 'invisible';
        const action = recap.getAttribute('data-action') || recap.getAttribute('data-recaptcha-action') || null;
        // Script tags decide both version and edition. Look in the parent
        // document too: when the widget lives in a same-origin iframe the
        // loader tag usually stays in the top document.
        const scriptSrcs = [];
        for (const doc of (d === document ? [d] : [d, document])) {
          for (const s of doc.querySelectorAll('script[src]')) {
            try { if (s.src) scriptSrcs.push(s.src); } catch {}
          }
        }
        const hasClassicScript = scriptSrcs.some(s => s.includes('recaptcha/api.js'));
        const hasEnterpriseScript = scriptSrcs.some(s => s.includes('recaptcha/enterprise'));
        // data-enterprise / data-sitekey-type aren't Google attributes — they
        // are wrapper-library conventions (django-recaptcha, some Rails and
        // Vue helpers). Cheap to check, so we take them as hints before
        // falling back to which loader script the page pulled in.
        const isEnterprise = recap.getAttribute('data-enterprise') === 'true' ||
          recap.getAttribute('data-sitekey-type') === 'enterprise' ||
          recap.querySelector('iframe[src*="recaptcha/enterprise"]') != null ||
          (!hasClassicScript && hasEnterpriseScript);
        // Version, in order of reliability:
        //   1. an explicit wrapper-set data-version / .g-recaptcha-v3 marker
        //   2. a `render=<sitekey>` loader script — the v3 signature; v2 loads
        //      the script bare or with render=explicit
        //   3. data-action with no data-size=invisible
        // (3) alone is not enough in either direction: v2 invisible widgets
        // carry data-action too, and some v3 wrappers copy data-size onto
        // their host div. Without (2) both of those land on the wrong task
        // type and CapSolver rejects the key.
        const version = recap.getAttribute('data-version') || (recap.classList.contains('g-recaptcha-v3') ? 'v3' : null);
        const renderScript = scriptSrcs.find(s =>
          /recaptcha\/(api|enterprise)\.js/i.test(s) && s.includes(`render=${sitekey}`)) || null;
        const isV3 = version === 'v3' || !!renderScript || (!!action && !isInvisible);
        // v3 needs an action name to solve. Fall back to the loader script's
        // ?action= when the host element doesn't carry one, and say so
        // explicitly when neither does — solve_captcha refuses v3 without it.
        const pageAction = action || (isV3 && renderScript ? getUrlAction(renderScript) : null);
        return {
          type: isV3 ? (isEnterprise ? 'recaptcha_v3_enterprise' : 'recaptcha_v3') : (isEnterprise ? 'recaptcha_v2_enterprise' : 'recaptcha_v2'),
          websiteKey: sitekey,
          isInvisible,
          isEnterprise,
          ...(pageAction ? { pageAction } : (isV3 ? { note: V3_NO_ACTION_NOTE } : {})),
        };
      }
    }
    // Cloudflare "challenge platform" (the bare interstitial — no sitekey
    // exposed in DOM, just the script tag). Best we can report is presence;
    // solve_captcha will error if no key is provided.
    if (d.querySelector('script[src*="challenges.cloudflare.com/turnstile"]') ||
        d.querySelector('iframe[src*="challenges.cloudflare.com"]')) {
      return { type: 'turnstile_challenge', websiteKey: null, note: 'Cloudflare interstitial detected but no sitekey was exposed in the DOM. Pass websiteKey explicitly if you have it.' };
    }
  }

  // ── URL-string fallback ─────────────────────────────────────────────
  // The DOM-element checks above cover the vast majority of production
  // integrations (`<div class="h-captcha" data-sitekey="...">` etc.).
  // Some pages — notably the official hcaptcha.com/demo and a handful of
  // SPA integrations that mount the widget via JS — never put the sitekey
  // on a host element in the main DOM. The sitekey IS still leaking
  // through iframe `src=` and script `src=` URLs, though, because the
  // widget script fetches its iframe with a `?sitekey=` (hCaptcha,
  // Turnstile) or `?k=` (reCAPTCHA) query parameter. iframe.src and
  // script.src are readable across origins from the parent page, so we
  // can scrape them even when the widget renders cross-origin.
  // hCaptcha and Turnstile expose the same `?sitekey=` in either tag, so one
  // matcher serves both passes below.
  const nonRecaptchaFromUrl = (url) => {
    if (/hcaptcha\.com/i.test(url)) {
      const m = url.match(/[?&#][^?&#]*?sitekey=([a-zA-Z0-9_-]{6,})/);
      if (m) return { type: 'hcaptcha', websiteKey: m[1], detectedVia: 'url' };
    }
    if (/challenges\.cloudflare\.com\/turnstile/i.test(url)) {
      const m = url.match(/[?&#][^?&#]*?sitekey=([a-zA-Z0-9_-]{6,})/);
      if (m) return { type: 'turnstile', websiteKey: m[1], detectedVia: 'url' };
    }
    return null;
  };

  // Split by tag type because reCAPTCHA needs both halves to classify a
  // widget: the anchor iframe carries the sitekey, the loader script carries
  // the version and action. Iframes are scanned first — a rendered anchor
  // frame is a stronger signal that the widget is actually on this page than
  // a script tag, which may just be a loader the page never used.
  const iframeUrls = [];
  const scriptUrls = [];
  for (const el of document.querySelectorAll('iframe[src], script[src]')) {
    try {
      if (el.src) {
        if (el.tagName.toLowerCase() === 'iframe') iframeUrls.push(el.src);
        else scriptUrls.push(el.src);
      }
    } catch {}
  }
  for (const url of iframeUrls) {
    const other = nonRecaptchaFromUrl(url);
    if (other) return other;
    if (/recaptcha\/(api2|enterprise)\/anchor/i.test(url)) {
      const m = url.match(/[?&#]k=([a-zA-Z0-9_-]{6,})/);
      if (m) {
        const sitekey = m[1];
        const isEnterprise = /recaptcha\/enterprise/i.test(url);
        const isInvisible = /[?&#]size=invisible/i.test(url);
        // v3 renders an anchor frame too (the badge), and it always carries
        // size=invisible — so the frame alone can't tell v3 from an invisible
        // v2. A loader script rendering this exact sitekey settles it.
        const matchingV3Script = scriptUrls.find(s => s.includes(`render=${sitekey}`));
        if (matchingV3Script) {
          const pageAction = getUrlAction(matchingV3Script);
          return {
            type: isEnterprise ? 'recaptcha_v3_enterprise' : 'recaptcha_v3',
            websiteKey: sitekey,
            isEnterprise,
            ...(pageAction ? { pageAction } : { note: V3_NO_ACTION_NOTE }),
            detectedVia: 'url',
          };
        }
        return {
          type: isEnterprise ? 'recaptcha_v2_enterprise' : 'recaptcha_v2',
          websiteKey: sitekey,
          isInvisible,
          isEnterprise,
          detectedVia: 'url',
        };
      }
    }
  }
  for (const url of scriptUrls) {
    const other = nonRecaptchaFromUrl(url);
    if (other) return other;
    if (/recaptcha\/(api\.js|enterprise\.js)/i.test(url)) {
      const m = url.match(/[?&#]render=([a-zA-Z0-9_-]{6,})/);
      // render=explicit means the page renders a v2 widget by hand later —
      // it is not a sitekey.
      if (m && m[1] !== 'explicit') {
        const isEnterprise = /enterprise/i.test(url);
        const pageAction = getUrlAction(url);
        return {
          type: isEnterprise ? 'recaptcha_v3_enterprise' : 'recaptcha_v3',
          websiteKey: m[1],
          isEnterprise,
          ...(pageAction ? { pageAction } : { note: V3_NO_ACTION_NOTE }),
          detectedVia: 'url',
        };
      }
    }
  }
  return null;
}

export async function detectCaptcha(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    func: detectCaptchaInPage,
  });
  for (const r of results || []) {
    if (r?.result) return r.result;
  }
  return null;
}

// ─── Token injection ───────────────────────────────────────────────────

function injectTokenIntoPage({ fieldName, alsoSet, token, callbackHint }) {
  if (!fieldName || !token) return { success: false, error: 'no field/token' };
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch {}
  }
  const setOn = (d, name) => {
    let el = d.querySelector(`textarea[name="${name}"]`)
          || d.querySelector(`input[name="${name}"]`);
    if (!el) {
      // Some sites only render the response textarea after the user
      // engages the widget. Create one if missing so the submit handler
      // can pick it up.
      el = d.createElement('textarea');
      el.name = name;
      el.style.display = 'none';
      (d.body || d.documentElement).appendChild(el);
    }
    el.value = token;
    el.textContent = token;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el;
  };
  let touched = 0;
  for (const d of docs) {
    setOn(d, fieldName);
    touched++;
    if (alsoSet) setOn(d, alsoSet);
  }
  // Best-effort: trigger callback registered by the widget (reCAPTCHA
  // v2/v3 sites usually wire `data-callback="onCaptcha"` on the host
  // element; some hCaptcha sites do the same with `data-callback`).
  let calledCallback = false;
  for (const d of docs) {
    const host = d.querySelector('[data-callback]');
    const cbName = host?.getAttribute('data-callback');
    if (cbName) {
      try {
        const fn = (typeof window !== 'undefined' && typeof window[cbName] === 'function') ? window[cbName] : null;
        if (fn) { fn(token); calledCallback = true; }
      } catch { /* ignore */ }
    }
  }
  return { success: true, fieldsTouched: touched, calledCallback, callbackHint: callbackHint || null };
}

export async function injectToken(tabId, { fieldName, alsoSet, token, callbackHint }) {
  if (!fieldName || !token) return { success: false, error: 'fieldName and token required' };
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    args: [{ fieldName, alsoSet, token, callbackHint }],
    func: injectTokenIntoPage,
  });
  return results?.[0]?.result || { success: false, error: 'injection script returned no result' };
}
