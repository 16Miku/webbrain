// Declines cookie-consent banners with DuckDuckGo's autoconsent (vendored,
// regex-hardened, MPL-2.0; see vendor/autoconsent/README.md). This is the
// background half: it decides where the content half runs, answers its
// init/eval requests, and tells the agent what happened. docs/cookie-banners.md
// has the user-facing behavior.
//
// Why it is shaped this way:
// - No static content script is registered. The CAPTCHA callback bridge once ran
//   on every site in every frame and broke hCaptcha/Turnstile pages, so these
//   scripts are injected per navigation, only into tabs the setting covers:
//   tabs an Act/Dev run is driving ('agent', the default) or every tab
//   ('everywhere').
// - The content half runs in the extension's isolated world. Page JavaScript
//   is touched only by autoconsent's fixed eval snippets, one call at a time,
//   in frames this host injected.
// - CAPTCHA and bot-challenge frames are never injected or eval'd.
// - A subframe is injected only when a rule names that frame's URL. A few
//   frame rules have no URL pattern and would otherwise run in every iframe.
// - Banners the bundled rules miss can get a WebBrain rule in
//   cookie-banner-rules.js; it is sent with the bundled ones.

import { evalSnippets, filterCompactRules } from '../../vendor/autoconsent/autoconsent.esm.js';
import { cookieBannerRulesFor } from './cookie-banner-rules.js';

export const COOKIE_BANNER_SETTING_KEY = 'cookieBanners';
export const COOKIE_BANNER_MODES = Object.freeze(['off', 'agent', 'everywhere']);
export const DEFAULT_COOKIE_BANNER_MODE = 'agent';

export const COOKIE_BANNER_CONTENT_MESSAGE = 'webbrain-autoconsent';
export const COOKIE_BANNER_BACKGROUND_MESSAGE = 'webbrain-autoconsent-bg';
export const COOKIE_BANNER_STATUS_MESSAGE = 'webbrain-cookie-banner-status';

const CONTENT_FILES = Object.freeze([
  'src/content/autoconsent-bridge.js',
]);
const RULES_FILE = 'vendor/autoconsent/compact-rules.json';
const ACTION_MODES = new Set(['act', 'dev']);

// Opt out only. On a banner no rule knows, autoconsent's heuristic looks for a
// popup with cookie wording and clicks its reject button; 'reject' is the only
// heuristic level that never accepts or merely dismisses. It runs in the top
// frame only, and banners it does not recognize fall back to the prompt
// guidance in adapters.js.
const AUTOCONSENT_CONFIG = Object.freeze({
  enabled: true,
  autoAction: 'optOut',
  disabledCmps: [],
  enablePrehide: true,
  enableCosmeticRules: true,
  enableGeneratedRules: true,
  enableHeuristicDetection: false,
  enablePopupMutationObserver: false,
  heuristicMode: 'reject',
  detectRetries: 20,
  isMainWorld: false,
  prehideTimeout: 2000,
  visualTest: false,
  logs: {
    lifecycle: false, rulesteps: false, detectionsteps: false, evals: false,
    errors: false, messages: false, waits: false,
  },
});

// Hosts that serve CAPTCHA and bot-challenge frames. Matched as the host or
// any subdomain of it.
const CHALLENGE_HOST_SUFFIXES = Object.freeze([
  'hcaptcha.com',
  'recaptcha.net',
  'challenges.cloudflare.com',
  'arkoselabs.com',
  'funcaptcha.com',
  'geetest.com',
  'captcha-delivery.com',
  'captcha.awswaf.com',
  'token.awswaf.com',
  'friendlycaptcha.com',
  'frcapi.com',
  'mtcaptcha.com',
  'smartcaptcha.yandexcloud.net',
  'captcha.qcloud.com',
  'captcha.gtimg.com',
  'dun.163.com',
  'dun.163yun.com',
  'px-cloud.net',
  'px-cdn.net',
  'perimeterx.net',
  'keycaptcha.com',
]);
// Google serves reCAPTCHA frames from its own hosts, and Cloudflare serves its
// challenge platform under any site's own origin; match those by path.
const CHALLENGE_PATHS = Object.freeze([
  { host: /(^|\.)google\.[a-z.]+$/, path: /^\/recaptcha\// },
  { host: /(^|\.)gstatic\.com$/, path: /^\/recaptcha\// },
  { host: /./, path: /^\/cdn-cgi\/challenge-platform\// },
]);

// autoconsent's Sourcepoint handler is code, not a JSON rule, so its frame URL
// is not in compact-rules.json. Mirror its detectCmp() URL test here.
const SOURCEPOINT_FRAME_PATHS = new Set([
  '/index.html', '/privacy-manager/index.html', '/ccpa_pm/index.html', '/us_pm/index.html',
]);
const SOURCEPOINT_FRAME_PARAMS = ['message_id', 'requestUUID', 'consentUUID'];

// Settling: a page with no banner costs at most QUIET_MS after autoconsent
// starts on it (once its DOM is ready); a banner being declined may take until
// HANDLING_MAX_MS. autoconsent tries the rules first and the heuristic on its
// second pass, about half a second later, so QUIET_MS leaves room for both. A
// consent tool can stay in the page after the visitor answered it; when a rule
// matches but no banner shows within POPUP_GRACE_MS, the turn goes on
// (autoconsent keeps looking, and a banner that shows later is declined then).
const QUIET_MS = 1200;
const DOM_READY_MAX_MS = 2500;
const INIT_MAX_MS = 1500;
const POPUP_GRACE_MS = 1500;
const HANDLING_MAX_MS = 4000;
const POLL_MS = 100;
const NOTE_LIMIT = 4;

const TERMINAL_LIFECYCLES = new Set(['nothingDetected', 'optOutSucceeded', 'optOutFailed', 'done']);
const HANDLING_LIFECYCLES = new Set(['cmpDetected', 'openPopupDetected', 'runningOptOut']);
const READY_LIFECYCLES = new Set(['started', ...HANDLING_LIFECYCLES, ...TERMINAL_LIFECYCLES]);

export function normalizeCookieBannerMode(value) {
  return COOKIE_BANNER_MODES.includes(value) ? value : DEFAULT_COOKIE_BANNER_MODE;
}

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function isChallengeFrameUrl(value) {
  const url = parseHttpUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (CHALLENGE_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return true;
  return CHALLENGE_PATHS.some(rule => rule.host.test(host) && rule.path.test(url.pathname));
}

function isSourcepointFrameUrl(url) {
  const host = url.hostname.toLowerCase();
  if (host === 'ccpa-notice.sp-prod.net' || host === 'ccpa-pm.sp-prod.net') return true;
  return SOURCEPOINT_FRAME_PATHS.has(url.pathname)
    && SOURCEPOINT_FRAME_PARAMS.some(name => url.searchParams.has(name));
}

// Compact rule layout (autoconsent lib/encoding.ts): [minVersion, name,
// cosmetic, urlPattern, runContext, prehide, detectCmp, detectPopup, optOut,
// test, extra]. Only frame rules with a URL pattern target a specific iframe.
const COMPACT_URL_PATTERN = 3;

function urlSpecificFrameRules(ruleset) {
  return (ruleset?.r || []).filter(rule => typeof rule?.[COMPACT_URL_PATTERN] === 'string'
    && rule[COMPACT_URL_PATTERN] !== '');
}

function cleanCmpName(value) {
  const name = String(value || '').replace(/[^\w .:-]/g, '').trim().slice(0, 40);
  // Generated rules are named like "auto_GB_example.com_x1" and the heuristic
  // "HEURISTIC-REJECT"; neither names the banner, so say nothing then.
  return /^(auto_|heuristic)/i.test(name) ? '' : name;
}

export function createCookieBannerHost(api, options = {}) {
  const isRunActive = typeof options.isRunActive === 'function' ? options.isRunActive : () => false;
  const runMode = typeof options.runMode === 'function' ? options.runMode : () => 'ask';
  const contentFiles = options.absoluteFilePaths === true
    ? CONTENT_FILES.map(file => `/${file}`)
    : [...CONTENT_FILES];
  const loadRules = typeof options.loadRules === 'function'
    ? options.loadRules
    : async () => {
      const response = await fetch(api.runtime.getURL(RULES_FILE));
      if (!response.ok) throw new Error(`cookie-banner rules unavailable (${response.status})`);
      return response.json();
    };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const extensionOrigin = String(api.runtime?.getURL?.('') || '');

  let mode = normalizeCookieBannerMode(options.mode);
  let modeChanged = false;
  // The host owns its setting: it reads and watches storage itself, so the
  // background's shared settings listener stays untouched.
  const storageArea = api.storage?.local;
  const loadMode = typeof options.loadMode === 'function'
    ? options.loadMode
    : typeof storageArea?.get === 'function'
      ? async () => (await storageArea.get(COOKIE_BANNER_SETTING_KEY))?.[COOKIE_BANNER_SETTING_KEY]
      : null;
  // A navigation can wake the worker before storage answers; decide only once
  // the stored setting is known, so 'off' and 'everywhere' hold from the start.
  const modeReady = loadMode
    ? Promise.resolve().then(loadMode).then((value) => {
      if (!modeChanged) mode = normalizeCookieBannerMode(value);
    }).catch(() => {})
    : Promise.resolve();
  let rulesPromise = null;
  // tabId -> { frames: Map<frameId, FrameState>, notes: [] }
  const tabs = new Map();
  const waiters = new Map();

  function rules() {
    rulesPromise ??= Promise.resolve().then(loadRules).catch((error) => {
      rulesPromise = null;
      throw error;
    });
    return rulesPromise;
  }

  function tabState(tabId, create = false) {
    let state = tabs.get(tabId);
    if (!state && create) {
      state = { frames: new Map(), notes: [] };
      tabs.set(tabId, state);
    }
    return state || null;
  }

  function notify(tabId) {
    const list = waiters.get(tabId);
    if (!list) return;
    waiters.delete(tabId);
    for (const resolve of list) resolve();
  }

  function waitForActivity(tabId, ms) {
    return new Promise((resolve) => {
      const list = waiters.get(tabId) || [];
      const timer = setTimeout(() => {
        // Timed out: drop this waiter so idle tabs do not collect them.
        const current = waiters.get(tabId);
        const index = current ? current.indexOf(done) : -1;
        if (index >= 0) current.splice(index, 1);
        if (current && !current.length) waiters.delete(tabId);
        resolve();
      }, Math.max(0, ms));
      function done() {
        clearTimeout(timer);
        resolve();
      }
      list.push(done);
      waiters.set(tabId, list);
    });
  }

  function coversTab(tabId) {
    if (mode === 'off') return false;
    if (mode === 'everywhere') return true;
    try {
      return isRunActive(tabId) === true && ACTION_MODES.has(runMode(tabId));
    } catch {
      return false;
    }
  }

  async function frameEligible(url, frameId) {
    const parsed = parseHttpUrl(url);
    if (!parsed || isChallengeFrameUrl(parsed.href)) return false;
    if (frameId === 0) return true;
    if (isSourcepointFrameUrl(parsed)) return true;
    if (cookieBannerRulesFor(parsed.href, { mainFrame: false }).length) return true;
    try {
      const ruleset = filterCompactRules(await rules(), { url: parsed.href, mainFrame: false });
      return urlSpecificFrameRules(ruleset).length > 0;
    } catch {
      return false;
    }
  }

  // injectImmediately lets pre-hiding run before a banner paints. An engine
  // that rejects the option instead of ignoring it still gets the injection.
  async function executeScript(details) {
    try {
      return await api.scripting.executeScript({ ...details, injectImmediately: true });
    } catch (error) {
      if (!/injectImmediately/i.test(String(error?.message || error))) throw error;
      return api.scripting.executeScript(details);
    }
  }

  function newFrame(url, lifecycle) {
    return {
      url: String(url || ''), injectedAt: now(), initAt: 0, startedAt: 0, detectedAt: 0, lifecycle,
      detected: [], popup: '', result: null, done: false, failed: false, error: false,
    };
  }

  function markHandling(frame) {
    if (!frame.detectedAt) frame.detectedAt = now();
  }

  async function maybeInject(tabId, frameId, url) {
    await modeReady;
    if (!coversTab(tabId)) return;
    const state = tabState(tabId, true);
    // Reserve the frame first so a commit listener and a turn that both see
    // this document inject it once.
    if (state.frames.has(frameId)) return;
    const frame = newFrame(url, 'checking');
    state.frames.set(frameId, frame);
    const eligible = await frameEligible(url, frameId);
    if (tabState(tabId)?.frames.get(frameId) !== frame) return; // a newer document replaced it
    if (!eligible || !coversTab(tabId)) {
      state.frames.delete(frameId);
      notify(tabId);
      return;
    }
    frame.lifecycle = 'injecting';
    frame.injectedAt = now();
    try {
      await executeScript({ target: { tabId, frameIds: [frameId] }, files: contentFiles });
    } catch {
      // Restricted pages (the browser's own pages, store pages, PDF viewer)
      // refuse injection; there is nothing to wait for there.
      frame.failed = true;
    }
    notify(tabId);
  }

  function onCommitted(details = {}) {
    const { tabId, frameId, url } = details;
    if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(frameId)) return;
    if (frameId === 0) {
      // A new top-level document: earlier frames and undelivered notes belong
      // to the page that is gone.
      tabs.delete(tabId);
    } else {
      tabState(tabId)?.frames.delete(frameId);
    }
    maybeInject(tabId, frameId, url).catch(() => {});
  }

  function onRemoved(tabId) {
    tabs.delete(tabId);
    notify(tabId);
  }

  function send(tabId, frameId, msg) {
    try {
      const sent = api.tabs.sendMessage(tabId, { type: COOKIE_BANNER_BACKGROUND_MESSAGE, msg }, { frameId });
      sent?.catch?.(() => {});
    } catch {}
  }

  async function initResponse(tabId, frameId, frame, url) {
    await modeReady;
    const covered = coversTab(tabId) && await frameEligible(url, frameId);
    if (!covered) {
      // The setting changed, or the run ended, between injection and init.
      frame.failed = true;
      send(tabId, frameId, { type: 'initResp', config: { ...AUTOCONSENT_CONFIG, enabled: false }, rules: { autoconsent: [] } });
      notify(tabId);
      return;
    }
    const own = cookieBannerRulesFor(url, { mainFrame: frameId === 0 });
    let compact;
    try {
      compact = filterCompactRules(await rules(), { url, mainFrame: frameId === 0 });
      if (frameId !== 0) compact = { ...compact, r: urlSpecificFrameRules(compact) };
    } catch {
      // Without the bundled rules, WebBrain's own still apply.
      compact = null;
      if (!own.length) {
        frame.failed = true;
        send(tabId, frameId, { type: 'initResp', config: { ...AUTOCONSENT_CONFIG, enabled: false }, rules: { autoconsent: [] } });
        notify(tabId);
        return;
      }
    }
    send(tabId, frameId, {
      type: 'initResp',
      config: { ...AUTOCONSENT_CONFIG },
      rules: compact ? { autoconsent: own, compact } : { autoconsent: own },
    });
  }

  async function runEval(tabId, frameId, frame, url, msg) {
    const id = msg.id;
    const snippet = Object.prototype.hasOwnProperty.call(evalSnippets, msg.snippetId)
      ? evalSnippets[msg.snippetId] : null;
    let result = false;
    if (snippet && frame && !frame.failed && coversTab(tabId) && !isChallengeFrameUrl(url)) {
      try {
        const [injection] = await executeScript({
          target: { tabId, frameIds: [frameId] },
          world: 'MAIN',
          func: snippet,
        });
        result = injection?.result === undefined ? false : injection.result;
      } catch {
        result = false;
      }
    }
    send(tabId, frameId, { type: 'evalResp', id, result });
  }

  function recordNote(tabId, msg) {
    const state = tabState(tabId, true);
    if (!isRunActive(tabId)) return;
    const cmp = cleanCmpName(msg.cmp);
    const cosmetic = msg.isCosmetic === true;
    if (state.notes.some(note => note.cmp === cmp && note.cosmetic === cosmetic)) return;
    state.notes.push({ cmp, cosmetic, at: now() });
    if (state.notes.length > NOTE_LIMIT) state.notes.splice(0, state.notes.length - NOTE_LIMIT);
  }

  function onContentMessage(message, sender) {
    const tabId = sender?.tab?.id;
    const frameId = sender?.frameId;
    const msg = message?.msg;
    if (!Number.isInteger(tabId) || !Number.isInteger(frameId) || !msg || typeof msg.type !== 'string') return;
    const url = String(sender.url || msg.url || '');
    const state = tabState(tabId, true);
    let frame = state.frames.get(frameId);
    switch (msg.type) {
      case 'init':
        if (!frame) {
          // A frame this worker has no record of (it restarted between the
          // injection and this message). initResponse re-checks coverage.
          frame = newFrame(url, 'injecting');
          state.frames.set(frameId, frame);
        }
        frame.initAt = now();
        frame.lifecycle = 'waitingForInitResponse';
        initResponse(tabId, frameId, frame, url).catch(() => {});
        break;
      case 'eval':
        runEval(tabId, frameId, frame, url, msg).catch(() => {});
        return;
      case 'report': {
        if (!frame) {
          // The bridge resends its last report when it is injected again
          // after the worker restarted and lost its records.
          frame = newFrame(url, 'initialized');
          frame.initAt = now();
          state.frames.set(frameId, frame);
        }
        const lifecycle = String(msg.state?.lifecycle || '');
        if (lifecycle) frame.lifecycle = lifecycle;
        if (!frame.startedAt && READY_LIFECYCLES.has(lifecycle)) frame.startedAt = now();
        if (HANDLING_LIFECYCLES.has(lifecycle)) markHandling(frame);
        if (Array.isArray(msg.state?.detectedCmps) && msg.state.detectedCmps.length) {
          frame.detected = msg.state.detectedCmps.map(String).slice(0, 8);
          markHandling(frame);
        }
        break;
      }
      case 'cmpDetected':
        if (frame && msg.cmp) {
          frame.detected = [...new Set([...frame.detected, String(msg.cmp)])].slice(0, 8);
          markHandling(frame);
        }
        break;
      case 'popupFound':
        if (frame) {
          frame.popup = String(msg.cmp || '');
          markHandling(frame);
        }
        break;
      case 'optOutResult':
        if (frame) {
          frame.result = msg.result === true;
          if (!frame.result) frame.lifecycle = 'optOutFailed';
        }
        break;
      case 'autoconsentDone':
        if (frame) {
          frame.done = true;
          frame.lifecycle = 'done';
        }
        recordNote(tabId, msg);
        break;
      case 'autoconsentError':
        if (frame) frame.error = true;
        break;
      default:
        return;
    }
    notify(tabId);
  }

  // Every wait is bounded from when the frame got there, not from when a turn
  // asked, so a frame whose decline never finishes (it was removed, or the
  // banner never showed) holds one turn at most.
  function framePending(frame, t) {
    // autoconsentError only reports that several rules matched; the decline
    // the first of them started still runs, so it does not end the wait.
    if (frame.failed || frame.done || frame.result === false) return false;
    if (TERMINAL_LIFECYCLES.has(frame.lifecycle)) return false;
    if (frame.detectedAt) {
      const showing = Boolean(frame.popup) || frame.lifecycle === 'openPopupDetected' || frame.lifecycle === 'runningOptOut';
      return t - frame.detectedAt < (showing ? HANDLING_MAX_MS : POPUP_GRACE_MS);
    }
    if (!frame.initAt) return t - frame.injectedAt < INIT_MAX_MS;
    if (!frame.startedAt) return t - frame.injectedAt < DOM_READY_MAX_MS;
    return t - frame.startedAt < QUIET_MS;
  }

  async function settle(tabId, maxWaitMs = HANDLING_MAX_MS) {
    const deadline = now() + Math.max(0, Math.min(maxWaitMs, HANDLING_MAX_MS));
    for (;;) {
      const state = tabState(tabId);
      const t = now();
      if (!state || t >= deadline) return;
      if (![...state.frames.values()].some(frame => framePending(frame, t))) return;
      await waitForActivity(tabId, Math.min(POLL_MS, deadline - t));
    }
  }

  async function ensureInjected(tabId) {
    let frames = [];
    try {
      frames = await api.webNavigation.getAllFrames({ tabId }) || [];
    } catch {
      return;
    }
    const known = tabState(tabId)?.frames;
    const pending = [];
    for (const frame of frames) {
      if (!Number.isInteger(frame?.frameId) || known?.has(frame.frameId)) continue;
      pending.push(maybeInject(tabId, frame.frameId, frame.url));
    }
    await Promise.all(pending);
  }

  function takeNotes(tabId) {
    const state = tabState(tabId);
    if (!state?.notes.length) return [];
    const notes = state.notes.map(({ cmp, cosmetic }) => ({ cmp, cosmetic }));
    state.notes = [];
    return notes;
  }

  function onMessage(message, sender, sendResponse) {
    if (message?.type === COOKIE_BANNER_CONTENT_MESSAGE) {
      if (message.msg?.type === 'checkCoverage') {
        const tabId = sender?.tab?.id;
        const frame = tabState(tabId)?.frames.get(sender?.frameId);
        const covered = Boolean(frame && !frame.failed && coversTab(tabId)
          && !isChallengeFrameUrl(sender?.url));
        sendResponse(covered);
        if (!covered) refreshCoverage(tabId);
        return;
      }
      onContentMessage(message, sender);
      return;
    }
    if (message?.type === COOKIE_BANNER_STATUS_MESSAGE) {
      // Diagnostics for extension pages (settings, tests); never for pages.
      if (!extensionOrigin || !String(sender?.url || '').startsWith(extensionOrigin)) return;
      sendResponse(status(Number(message.tabId)));
    }
  }

  function status(tabId) {
    const state = tabState(tabId);
    return {
      mode,
      covered: coversTab(tabId),
      frames: state ? [...state.frames.entries()].map(([frameId, frame]) => ({
        frameId, url: frame.url, lifecycle: frame.lifecycle, detected: [...frame.detected],
        popup: frame.popup, result: frame.result, done: frame.done, failed: frame.failed,
      })) : [],
      pendingNotes: state ? state.notes.length : 0,
    };
  }

  function refreshCoverage(tabId) {
    if (coversTab(tabId)) return;
    const state = tabState(tabId);
    for (const frameId of state?.frames.keys() || []) send(tabId, frameId, { type: 'stop' });
    tabs.delete(tabId);
    notify(tabId);
  }

  function setMode(value) {
    modeChanged = true;
    mode = normalizeCookieBannerMode(value);
    for (const tabId of tabs.keys()) refreshCoverage(tabId);
    return mode;
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== 'local' || !changes?.[COOKIE_BANNER_SETTING_KEY]) return;
    setMode(changes[COOKIE_BANNER_SETTING_KEY].newValue);
  }

  let started = false;
  return {
    // Register listeners synchronously at worker start so events can wake it.
    start() {
      if (started) return;
      started = true;
      api.runtime.onMessage.addListener(onMessage);
      api.webNavigation?.onCommitted?.addListener?.(onCommitted);
      api.tabs?.onRemoved?.addListener?.(onRemoved);
      api.storage?.onChanged?.addListener?.(onStorageChanged);
    },
    setMode,
    refreshCoverage,
    get mode() {
      return mode;
    },
    // Before screenshots and model calls: make sure the current page has been
    // seen, let a decline in progress finish, and return declines to report.
    async prepareTurn(tabId, { maxWaitMs = HANDLING_MAX_MS } = {}) {
      await modeReady;
      if (!Number.isInteger(tabId) || !coversTab(tabId)) return [];
      await ensureInjected(tabId);
      await settle(tabId, maxWaitMs);
      return takeNotes(tabId);
    },
    status,
    // Exposed for tests.
    _onCommitted: onCommitted,
    _onMessage: onMessage,
    _settle: settle,
  };
}
