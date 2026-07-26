import { URL_FAMILY_TOOLS, bucketArgsKey } from './loop-bucket.js';

/**
 * Browser-free loop detection used by Agent and the unit tests.
 *
 * Catches the agent stuck repeating an ineffective action or oscillating
 * between two calls. Cheap, runs after every tool execution. On first
 * detection we soft-nudge by injecting a [LOOP DETECTED] note into the
 * tool result the model sees. On second detection within the same loop,
 * we hard-stop the run with a clear final message.
 *
 * This module is deliberately browser-free so both extension builds and the
 * unit suite exercise the same production class. Subclasses supply the
 * browser-specific pieces: _isBrowserMutationTool() classifies tools, and
 * _clearPageLoopState() may be extended to clear related page-scoped state
 * alongside the detector's own maps.
 */
export class LoopDetector {
  constructor() {
    // Per-tab ring buffer of recent tool calls + nudge count.
    this.recentCalls = new Map(); // tabId -> [{ key, name, ts }]
    this.loopNudges = new Map();  // tabId -> consecutive-nudge counter
    this.healthyCallsSinceLoop = new Map(); // tabId -> count of clean calls since last nudge
    this.failedActionLoops = new Map(); // tabId -> Map(stable failure scope -> count)
    // Last few normalized URLs each tab arrived at during the active run.
    // Deliberately NOT cleared by _clearLoopState: it gates those intra-run
    // resets, so it must survive them until the outer run boundary.
    this.recentNavUrls = new Map(); // tabId -> [normalized URL, ...]
    // A model can walk ref_1, ref_2, … forever while every call looks unique
    // to the exact-argument loop detector. Track that semantic read pattern.
    this.axReadStates = new Map(); // tabId -> { total, suspicious, nextPage, seenPages, warned }
    // Scroll calls can keep returning success even when no pane moved. Track
    // repeated dead-end attempts separately so changing the amount or
    // interleaving reads cannot evade the generic loop detector.
    this.noProgressScrolls = new Map(); // tabId -> { key, count }
    // Separate buffer for coordinate-based click attempts. The general loop
    // detector keys on JSON.stringify(args), so when the model interleaves
    // execute_js with different code strings between clicks, the same
    // (x,y) click never accumulates to the threshold inside its window.
    // This buffer tracks ONLY coord clicks and survives any amount of
    // unrelated noise between them, catching the "click missing its target,
    // model retries forever" failure mode in 2-3 attempts instead of never.
    this.recentCoordClicks = new Map(); // tabId -> [{ key, ts }]
    // Verification overlays often allocate fresh accessibility ref ids every
    // time they are dismissed and reopened. Track their semantic identity
    // separately so ref churn and interleaved close/Continue calls cannot
    // disguise the same challenge loop.
    this.verificationChallengeStates = new Map(); // tabId -> { key, active, reopenCount }
  }

  /**
   * Whether `toolName` mutates browser/page state, which gates the stricter
   * failed-action loop counters. Browser-neutral by default; each Agent build
   * overrides it with that build's real tool surface.
   */
  _isBrowserMutationTool(_toolName) {
    return false;
  }

  _isToolResultErroredForLoop(name, _args, result) {
    if (!result || typeof result !== 'object') return false;
    if (result.error || result.success === false || result.noProgress) return true;
    const status = Number(result.status);
    return URL_FAMILY_TOOLS.has(name) && Number.isFinite(status) && status >= 400;
  }

  _fetchUsesHttpByteRange(args) {
    if (!args?.headers || typeof args.headers !== 'object') return false;
    for (const [name, value] of Object.entries(args.headers)) {
      if (String(name).toLowerCase() === 'range' && /^\s*bytes\s*=/i.test(String(value || ''))) {
        return true;
      }
    }
    return false;
  }

  _findTextMatchLoopIdentity(result) {
    if (result?.success !== true || result?.verified === false || !result?.rect || typeof result.rect !== 'object') return '';
    const rect = result.rect;
    const pageX = typeof rect.pageX === 'number' ? rect.pageX : NaN;
    const pageY = typeof rect.pageY === 'number' ? rect.pageY : NaN;
    const viewportX = typeof rect.x === 'number' ? rect.x : NaN;
    const viewportY = typeof rect.y === 'number' ? rect.y : NaN;
    const width = typeof rect.width === 'number' ? rect.width : NaN;
    const height = typeof rect.height === 'number' ? rect.height : NaN;
    const x = Number.isFinite(pageX) ? pageX : viewportX;
    const y = Number.isFinite(pageY) ? pageY : viewportY;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return '';
    let selectionIdentity = 'document';
    if (result.selectionSource === 'text_control') {
      const selectionStart = result.selectionStart;
      const selectionEnd = result.selectionEnd;
      if (
        !Number.isInteger(selectionStart)
        || !Number.isInteger(selectionEnd)
        || selectionStart < 0
        || selectionEnd <= selectionStart
      ) return '';
      selectionIdentity = `text_control:${selectionStart}:${selectionEnd}`;
    }
    const rectIdentity = [x, y, width, height]
      .map(value => Math.round(value * 2) / 2)
      .join(',');
    return `${selectionIdentity}|${rectIdentity}`;
  }

  _noteHealthyLoopCall(tabId) {
    // Do not reset the nudge counter immediately: one healthy call between
    // two stuck actions must not launder the surrounding loop.
    const healthy = (this.healthyCallsSinceLoop.get(tabId) || 0) + 1;
    this.healthyCallsSinceLoop.set(tabId, healthy);
    if (healthy >= 2) {
      this.loopNudges.delete(tabId);
      this.healthyCallsSinceLoop.delete(tabId);
    }
    return { kind: 'none' };
  }

  _loopCallKey(name, args, result) {
    if (result?.nonRetryableScope) {
      // Definitive platform/permission failures keep one identity across
      // tools and URL variants, so changing fetch strategies cannot evade
      // the stop condition.
      return `nonretryable|${String(result.nonRetryableScope).slice(0, 240)}|err`;
    }
    const checkboxState = result?.checkboxState;
    if (
      checkboxState
      && typeof checkboxState.desiredChecked === 'boolean'
      && typeof checkboxState.actualChecked === 'boolean'
      && checkboxState.desiredChecked !== checkboxState.actualChecked
    ) {
      const identity = String(
        checkboxState.identity
        || result.checkboxIdentity
        || result.ref_id
        || '',
      ).trim().slice(0, 240);
      if (identity) {
        return `checkbox|${identity}|desired:${checkboxState.desiredChecked}|actual:${checkboxState.actualChecked}`;
      }
    }
    // URL-family tools (fetch_url, research_url, …) bucket by resource
    // identity so the agent can't escape loop detection by fetching the
    // same logical file via 8 different API endpoints. See loop-bucket.js.
    const errored = this._isToolResultErroredForLoop(name, args, result);
    const argsHash = bucketArgsKey(name, args);
    if (name === 'find_text' && !errored) {
      const matchIdentity = this._findTextMatchLoopIdentity(result);
      if (matchIdentity) return `${name}|${argsHash}|match:${matchIdentity}`;
    }
    return `${name}|${argsHash}|${errored ? 'err' : 'ok'}`;
  }

  _recordCall(tabId, name, args, result) {
    const key = this._loopCallKey(name, args, result);
    const buf = this.recentCalls.get(tabId) || [];
    buf.push({ key, name, ts: Date.now() });
    if (buf.length > 6) buf.shift();
    this.recentCalls.set(tabId, buf);
    return { buf, key };
  }

  _detectLoop(buf, activeKey = null) {
    if (!buf || buf.length < 3) return null;
    // 1. Same key 3+ times in the window.
    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    for (const [key, n] of counts) {
      if (n >= 3 && (!activeKey || key === activeKey)) {
        return { type: 'repeat', key, name: key.split('|')[0], count: n };
      }
    }
    // 2. ABAB oscillation in the last 4.
    if (buf.length >= 4) {
      const last4 = buf.slice(-4);
      if (
        last4[0].key === last4[2].key
        && last4[1].key === last4[3].key
        && last4[0].key !== last4[1].key
      ) {
        return { type: 'oscillation', a: last4[0].name, b: last4[1].name };
      }
    }
    return null;
  }

  /**
   * Clear the state that is only meaningful for the page currently loaded in
   * `tabId` — ref ids, coordinates, scroll surfaces, and per-target failure
   * counters all stop describing reality once the page is replaced. Subclasses
   * extend this (via super) to drop their own page-scoped state alongside it.
   */
  _clearPageLoopState(tabId) {
    this.failedActionLoops.delete(tabId);
    this.axReadStates.delete(tabId);
    this.noProgressScrolls.delete(tabId);
    this.recentCoordClicks.delete(tabId);
  }

  _checkVerificationChallengeLoop(tabId, { pageUrl = '', dialogLabel = '' } = {}) {
    const normalizedLabel = String(dialogLabel || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .slice(0, 160);
    const previous = this.verificationChallengeStates.get(tabId);

    if (!normalizedLabel) {
      if (previous?.active) {
        this.verificationChallengeStates.set(tabId, { ...previous, active: false });
      }
      return { kind: 'none' };
    }

    const key = `${this._normalizeUrl(pageUrl)}\n${normalizedLabel}`;
    if (!previous || previous.key !== key) {
      this.verificationChallengeStates.set(tabId, { key, active: true, reopenCount: 0 });
      return { kind: 'none' };
    }
    if (previous.active) return { kind: 'none' };

    const reopenCount = previous.reopenCount + 1;
    this.verificationChallengeStates.set(tabId, { key, active: true, reopenCount });
    if (reopenCount >= 2) {
      return {
        kind: 'stop',
        message: 'Stopped: the same verification dialog was dismissed and reopened repeatedly on the same page. Do not close it or resubmit the form again. Use the CAPTCHA solver when supported, or ask the user to complete the verification manually.',
      };
    }
    return {
      kind: 'nudge',
      warning: '[VERIFICATION DIALOG REOPENED: The same verification challenge returned on the same page. Do not dismiss or close it and do not click Continue/Submit again. Use solve_captcha once if supported; otherwise ask the user to complete it manually.]',
    };
  }

  /**
   * Clear everything the detector accumulated for `tabId` except the nav
   * arrival history, which must outlive intra-run resets so navigation
   * ping-pong is still catchable. See _clearRunLoopState for the run boundary.
   */
  _clearLoopState(tabId) {
    this.recentCalls.delete(tabId);
    this.loopNudges.delete(tabId);
    this.healthyCallsSinceLoop.delete(tabId);
    this._clearPageLoopState(tabId);
  }

  /**
   * Run-boundary reset. Only here is the nav arrival history discarded, since
   * a new run may legitimately revisit URLs the previous run already saw.
   */
  _clearRunLoopState(tabId) {
    this.recentNavUrls.delete(tabId);
    this._clearLoopState(tabId);
    this.verificationChallengeStates.delete(tabId);
  }

  /**
   * Normalize URLs for navigation-change checks. Keep query and hash so
   * history entries that differ only by search params or anchors still count as
   * successful back/forward movement.
   */
  _normalizeUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      return u.origin + u.pathname + u.search + u.hash;
    } catch (e) { return url; }
  }

  /**
   * Record that `tabId` arrived at `url` and report whether that URL was
   * already seen in the last few arrivals. A first visit is page-state
   * progress and justifies resetting loop counters; a quick revisit is the
   * signature of a navigation loop and must leave them intact.
   */
  _noteNavArrival(tabId, url) {
    const normalized = this._normalizeUrl(url);
    if (!normalized) return false;
    const seen = this.recentNavUrls.get(tabId) || [];
    const revisited = seen.includes(normalized);
    seen.push(normalized);
    if (seen.length > 5) seen.shift();
    this.recentNavUrls.set(tabId, seen);
    return revisited;
  }

  _isRecentNavUrl(tabId, url) {
    const normalized = this._normalizeUrl(url);
    return !!normalized && (this.recentNavUrls.get(tabId) || []).includes(normalized);
  }

  _checkAccessibilityReadLoop(tabId, name, args, result) {
    if (name !== 'get_accessibility_tree') {
      this.axReadStates.delete(tabId);
      return { kind: 'none' };
    }

    const previous = this.axReadStates.get(tabId) || {
      total: 0,
      suspicious: 0,
      nextPage: null,
      seenPages: new Set(),
      warned: false,
    };
    const page = Number(args?.page || 1);
    const hasRef = typeof args?.ref_id === 'string' && args.ref_id.trim() !== '';
    const sequentialPage = !hasRef
      && previous.total > 0
      && Number.isFinite(previous.nextPage)
      && page === previous.nextPage
      && !previous.seenPages.has(page);
    const repeatedRootOrPage = !hasRef && previous.total > 0 && !sequentialPage;
    const content = String(result?.pageContent || '').trim();
    const meaningfulLines = content ? content.split(/\r?\n/).filter(line => line.trim()).length : 0;
    const suspicious = hasRef || repeatedRootOrPage || (hasRef && meaningfulLines <= 1);

    const state = {
      total: previous.total + 1,
      suspicious: previous.suspicious + (suspicious ? 1 : 0),
      nextPage: Number.isFinite(Number(result?.nextPage)) ? Number(result.nextPage) : null,
      seenPages: new Set(previous.seenPages),
      warned: previous.warned,
    };
    state.seenPages.add(page);
    this.axReadStates.set(tabId, state);

    // A root read followed by the exact returned nextPage can legitimately span
    // large applications. Keep the consecutive-read cap for every other AX
    // pattern, but do not stop a valid sequential pagination step.
    if (state.suspicious >= 6 || (state.total >= 12 && (state.suspicious > 0 || !sequentialPage))) {
      this.axReadStates.delete(tabId);
      return {
        kind: 'stop',
        message: 'Stopped: I kept reading accessibility-tree nodes without taking an action or changing approach. The tree is not meant to be enumerated ref-by-ref. Use an element already found, request the returned nextPage, switch to read_page/extract_data, or ask for help.',
      };
    }
    if (!state.warned && state.suspicious >= 3) {
      state.warned = true;
      return {
        kind: 'nudge',
        warning: '[ACCESSIBILITY READ LOOP: Stop enumerating sibling or generic ref_ids. If the result has hasMore/nextPage, request exactly that page. If the needed textbox/button is already visible, use set_field, type_ax, or click_ax now. Otherwise switch once to read_page/extract_data or finish with what you have. Do not call another arbitrary ref_id subtree.]',
      };
    }
    return { kind: 'none' };
  }

  _noProgressScrollKey(args = {}, result = {}) {
    const direction = String(args?.direction || '').trim().toLowerCase() || 'unspecified';
    const refId = String(args?.ref_id || '').trim();
    if (refId) return `${direction}|ref:${refId}`;

    const x = Number(args?.x);
    const y = Number(args?.y);
    if (args?.x != null && args?.y != null && Number.isFinite(x) && Number.isFinite(y)) {
      return `${direction}|xy:${Math.round(x)},${Math.round(y)}`;
    }

    // For implicit scrolling, distinguish panes using the element that
    // supplied the runtime's last-interaction origin. This avoids combining
    // no-movement results from two different panes while deliberately
    // ignoring `amount`, which is not a meaningful recovery at a hard edge.
    const origin = result?.originElement;
    if (origin && typeof origin === 'object') {
      const rect = origin.rect || {};
      const text = String(origin.text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      return `${direction}|origin:${String(result?.origin || '')}:${String(origin.tag || '')}:${String(origin.role || '')}:${Math.round(Number(rect.x) || 0)},${Math.round(Number(rect.y) || 0)},${Math.round(Number(rect.w) || 0)},${Math.round(Number(rect.h) || 0)}:${text}`;
    }
    return `${direction}|auto`;
  }

  _checkNoProgressScroll(tabId, name, args, result) {
    // Preserve a dead-scroll streak across reads or other unrelated calls;
    // only a successful scroll or a different scroll target/direction proves
    // that this particular recovery path changed.
    if (name !== 'scroll') {
      // Accessibility refs and coordinate targets are document-scoped. A
      // successful navigation can reuse the same ref_id/coordinates for a
      // completely different page, so it must break the old scroll streak.
      if (result?.pageUrlChanged === true) this.noProgressScrolls.delete(tabId);
      return { kind: 'none' };
    }
    if (result?.moved !== false) {
      this.noProgressScrolls.delete(tabId);
      return { kind: 'none' };
    }

    const key = this._noProgressScrollKey(args, result);
    const previous = this.noProgressScrolls.get(tabId);
    const count = previous?.key === key ? previous.count + 1 : 1;
    this.noProgressScrolls.set(tabId, { key, count });

    if (count >= 3) {
      this.noProgressScrolls.delete(tabId);
      return {
        kind: 'stop',
        message: 'Stopped: I repeated the same scroll direction on the same target three times, but the page or pane did not move. That scroll surface is already at its limit. Re-read the current view, choose a different pane or direction, act on an element already visible, or ask for help.',
      };
    }
    if (count >= 2) {
      return {
        kind: 'nudge',
        warning: '[NO-PROGRESS SCROLL: The same target did not move twice. Do not repeat this scroll direction or merely change the amount. Re-read the current view, use the opposite direction or a different ref_id/x/y pane, act on an element already visible, or finish.]',
      };
    }
    return { kind: 'none' };
  }

  /**
   * Issue #189 — mutation API observer shortcutter. When _checkLoop flags a
   * repeated click (e.g. "Next Page" clicked 3x), check whether each click
   * fired the same background XHR/fetch (captured by the webRequest
   * listener in background.js). If so, surface the URL/method so the model
   * can call fetch_url directly instead of clicking again.
   *
   * Strict matching only: same tab, exact url+method repeated, and request
   * must land within WINDOW_MS after the click that triggered it. No fuzzy
   * param-pattern matching.
   */
  _detectApiShortcut(tabId, loop, buf) {
    if (loop.type !== 'repeat') return null;
    if (!['click', 'click_ax'].includes(loop.name)) return null;
    const apiRequests = globalThis.__webbrainApiRequests?.get(tabId);
    if (!apiRequests || apiRequests.length === 0) return null;

    const clickTimes = buf.filter(e => e.key === loop.key).map(e => e.ts);
    if (clickTimes.length < 2) return null;

    const WINDOW_MS = 3000;
    let candidate = null;
    let matches = 0;
    const usedRequestIndexes = new Set();
    for (const clickTs of clickTimes) {
      const hitIndex = apiRequests.findIndex((r, idx) =>
        !usedRequestIndexes.has(idx)
        && r.ts >= clickTs
        && r.ts <= clickTs + WINDOW_MS
        && (!candidate || (r.url === candidate.url && String(r.method || '').toUpperCase() === candidate.method))
      );
      if (hitIndex < 0) continue;
      const hit = apiRequests[hitIndex];
      if (!hit) continue;
      if (!candidate) {
        candidate = {
          url: hit.url,
          method: String(hit.method || '').toUpperCase(),
          replayRequestId: hit.replayRequestId,
        };
      }
      usedRequestIndexes.add(hitIndex);
      matches++;
    }
    if (!candidate || matches < 2) return null;
    return {
      url: candidate.url,
      method: candidate.method,
      occurrences: matches,
      replayRequestId: candidate.replayRequestId,
    };
  }

  /**
   * Coordinate-click loop detector. Buckets to nearest 5px so a click that
   * drifts by a pixel or two between attempts still hashes the same. Window
   * of 8 — generous, since the goal is to survive interleaved noise like
   * execute_js / type_text / read_page calls between coord retries.
   *
   * Returns 'nudge' on the 3rd repeat and 'stop' on the 5th. Gives the
   * agent more room to retry on pages with loading states or animations.
   */
  _checkCoordClickLoop(tabId, x, y) {
    const bx = Math.round(x / 5) * 5;
    const by = Math.round(y / 5) * 5;
    const key = `${bx},${by}`;
    const buf = this.recentCoordClicks.get(tabId) || [];
    buf.push({ key, ts: Date.now() });
    if (buf.length > 12) buf.shift();
    this.recentCoordClicks.set(tabId, buf);

    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    const n = counts.get(key) || 0;
    if (n >= 8) return { kind: 'stop', x: bx, y: by };
    if (n >= 5) return { kind: 'nudge', x: bx, y: by };
    return { kind: 'none' };
  }

  /**
   * Run loop detection on a freshly recorded call. Returns one of:
   *   { kind: 'none' }
   *   { kind: 'nudge', warning: string }   // soft warning to inject into tool result
   *   { kind: 'stop',  message: string }   // hard stop, abort the run
   */
  _checkLoop(tabId, toolName, toolArgs, toolResult) {
    // A navigation result is authoritative page-state evidence. Clear before
    // recording this call so same-looking controls on the new page start at
    // attempt one instead of inheriting an old third-strike counter. Arriving
    // back on a recently seen URL is the exception: a click/go_back ping-pong
    // would otherwise reset the detector on every hop and never be caught.
    if (toolResult?.pageUrlChanged === true && !this._noteNavArrival(tabId, toolResult.currentUrl)) {
      this._clearLoopState(tabId);
    }
    if (
      toolName === 'find_text'
      && toolResult?.success === true
      && !this._findTextMatchLoopIdentity(toolResult)
    ) {
      // A cross-origin frame match can be selected by window.find while its
      // range is unavailable to the top document. Successful same-query calls
      // intentionally advance to the next match, so an unlocated match is not
      // safe evidence of a repeat loop.
      return this._noteHealthyLoopCall(tabId);
    }
    const { buf, key } = this._recordCall(tabId, toolName, toolArgs, toolResult);
    if (this._isBrowserMutationTool(toolName)) {
      const normalizeFailureScope = value => String(value).slice(0, 320);
      const defaultFailureScope = normalizeFailureScope(`${toolName}|${bucketArgsKey(toolName, toolArgs)}`);
      const failureScope = normalizeFailureScope(toolResult?.failureScope || defaultFailureScope);
      const equivalentFailureScopes = new Set([failureScope, defaultFailureScope]);
      if ((toolName === 'set_field' || toolName === 'type_ax') && typeof toolArgs?.ref_id === 'string') {
        equivalentFailureScopes.add(normalizeFailureScope(`field-value:${toolArgs.ref_id}`));
      }
      if (toolName === 'click' && typeof toolArgs?.text === 'string') {
        equivalentFailureScopes.add(normalizeFailureScope(`ambiguous-click:${toolArgs.text.trim().toLowerCase()}`));
      }
      const failures = this.failedActionLoops.get(tabId) || new Map();
      if (this._isToolResultErroredForLoop(toolName, toolArgs, toolResult)) {
        const attempts = (failures.get(failureScope) || 0) + 1;
        failures.set(failureScope, attempts);
        if (failures.size > 32) failures.delete(failures.keys().next().value);
        this.failedActionLoops.set(tabId, failures);
        if (attempts >= 3) {
          this._clearLoopState(tabId);
          return {
            kind: 'stop',
            message: `Stopped: ${toolName} failed or made no progress three times for the same target. Repeating it or switching to a precomputed fallback cannot make progress without fresh page evidence.`,
          };
        }
        if (attempts === 2) {
          return {
            kind: 'nudge',
            warning: `[FAILED ACTION LOOP: ${toolName} has failed or made no progress twice for the same target. Do not retry it or use a queued fallback. Re-read the page/tree and choose a new action from current evidence.]`,
          };
        }
      } else if (toolResult?.success === true && toolResult?.verified !== false) {
        for (const scope of equivalentFailureScopes) failures.delete(scope);
        if (failures.size) this.failedActionLoops.set(tabId, failures);
        else this.failedActionLoops.delete(tabId);
      }
    }
    if (toolResult?.nonRetryable) {
      const repeats = buf.filter(entry => entry.key === key).length;
      if (repeats >= 2) {
        this._clearLoopState(tabId);
        return {
          kind: 'stop',
          message: toolResult.stopMessage || `Stopped: ${toolName} hit the same non-retryable failure twice. Retrying or switching to an equivalent tool will not make progress.`,
        };
      }
    }
    if (key.startsWith('checkbox|')) {
      const repeats = buf.filter(entry => entry.key === key).length;
      if (repeats >= 3) {
        this._clearLoopState(tabId);
        return {
          kind: 'stop',
          message: 'Stopped: the same checkbox is still in the wrong checked state after three attempts. Changing tools or arguments does not change that semantic state. Re-read the form or ask the user instead of toggling it again.',
        };
      }
      if (repeats >= 2) {
        return {
          kind: 'nudge',
          warning: '[CHECKBOX STATE UNCHANGED: The same checkbox is still in the wrong checked state. Do not toggle it again and do not evade this by switching tools. Call set_checked(ref_id, desiredState) once; if its trusted selector-backed attempt also fails, re-read the form or ask the user.]',
        };
      }
    }
    const loop = this._detectLoop(buf, key);
    if (loop?.type === 'oscillation' && loop.a === 'find_text' && loop.b === 'find_text') {
      // Alternating match positions is normal when a finite page search wraps.
      return this._noteHealthyLoopCall(tabId);
    }
    if (!loop) {
      return this._noteHealthyLoopCall(tabId);
    }

    const method = String(toolArgs?.method || 'GET').toUpperCase();
    if (
      loop.type === 'repeat'
      && URL_FAMILY_TOOLS.has(toolName)
      && method === 'GET'
      && this._isToolResultErroredForLoop(toolName, toolArgs, toolResult)
    ) {
      this._clearLoopState(tabId);
      const rangedFetch = toolName === 'fetch_url' && this._fetchUsesHttpByteRange(toolArgs);
      return {
        kind: 'stop',
        message: rangedFetch
          ? 'Stopped: fetch_url failed three times while probing HTTP byte ranges for the same read-only resource. Use find or semantic offset:nextOffset pagination in a new run, or ask for a partial answer from the evidence already collected.'
          : `Stopped: ${loop.name} failed three times for the same read-only resource. Repeating it or changing URL variants will not make progress. Please give a different instruction or inspect the page manually.`,
      };
    }

    // Any new loop detection resets the healthy-streak counter.
    this.healthyCallsSinceLoop.delete(tabId);
    const nudges = (this.loopNudges.get(tabId) || 0) + 1;
    this.loopNudges.set(tabId, nudges);

    if (nudges >= 8) {
      this._clearLoopState(tabId);
      const desc = loop.type === 'repeat'
        ? `the same call to ${loop.name}`
        : `between ${loop.a} and ${loop.b}`;
      return {
        kind: 'stop',
        message: `Stopped: I detected I was looping on ${desc} without making progress after multiple warnings. Please tell me what's blocking, give me a different instruction, or take a look at the page yourself.`,
      };
    }

    let warning;
    if (loop.type === 'repeat') {
      const shortcut = this._detectApiShortcut(tabId, loop, buf);
      const rangedFetch = toolName === 'fetch_url'
        && method === 'GET'
        && this._fetchUsesHttpByteRange(toolArgs);
      warning = rangedFetch
        ? '[LOOP DETECTED: You are repeatedly probing the same resource with HTTP byte ranges. Stop guessing byte offsets or file size. Use fetch_url({url, find:"literal"}) to search the full decoded response, continue semantic text pagination with offset:nextOffset, or answer now with the evidence already collected. Do not send another Range header for this resource.]'
        : shortcut
        ? `[LOOP DETECTED + API SHORTCUT FOUND: You've called ${loop.name} ${loop.count} times. Each click triggered the same background request pattern: ${shortcut.method} ${shortcut.url}. Instead of clicking again, consider fetch_url({url: "${shortcut.url}", method: "${shortcut.method}"${shortcut.replayRequestId ? `, replayRequestId: "${shortcut.replayRequestId}"` : ''}}) with the same method; follow the UI/API mutation policy for mutating methods.]`
        : `[LOOP DETECTED: You've just called ${loop.name} ${loop.count} times with the same arguments and the same outcome. The current approach is NOT working. Try something fundamentally different: a different selector, a different tool, scroll to find a different element, or re-read the page/tree to see what's actually on screen. DO NOT repeat this exact call again — try a creative alternative.]`;
    } else {
      warning = `[LOOP DETECTED: You're oscillating between ${loop.a} and ${loop.b} without making progress. Stop. Re-read the page/tree to see what's actually happening, then try a completely different approach.]`;
    }
    return { kind: 'nudge', warning };
  }
}
