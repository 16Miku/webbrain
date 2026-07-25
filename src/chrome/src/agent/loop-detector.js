import { URL_FAMILY_TOOLS, bucketArgsKey } from './loop-bucket.js';

/**
 * Browser-free loop detection used by Agent and the unit tests.
 *
 * Subclasses may override _clearPageLoopState() to clear related page-scoped
 * state alongside the detector's own maps.
 */
export class LoopDetector {
  constructor({ isBrowserMutationTool = () => false } = {}) {
    this._loopMutationTool = isBrowserMutationTool;
    this.recentCalls = new Map();
    this.loopNudges = new Map();
    this.healthyCallsSinceLoop = new Map();
    this.failedActionLoops = new Map();
    this.recentNavUrls = new Map();
    this.axReadStates = new Map();
    this.noProgressScrolls = new Map();
    this.recentCoordClicks = new Map();
  }

  _isBrowserMutationTool(toolName) {
    return this._loopMutationTool(toolName);
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
    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    for (const [key, n] of counts) {
      if (n >= 3 && (!activeKey || key === activeKey)) {
        return { type: 'repeat', key, name: key.split('|')[0], count: n };
      }
    }
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

  _clearPageLoopState(tabId) {
    this.failedActionLoops.delete(tabId);
    this.axReadStates.delete(tabId);
    this.noProgressScrolls.delete(tabId);
    this.recentCoordClicks.delete(tabId);
  }

  _clearLoopState(tabId) {
    this.recentCalls.delete(tabId);
    this.loopNudges.delete(tabId);
    this.healthyCallsSinceLoop.delete(tabId);
    this._clearPageLoopState(tabId);
  }

  _clearRunLoopState(tabId) {
    this.recentNavUrls.delete(tabId);
    this._clearLoopState(tabId);
  }

  _normalizeUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      return u.origin + u.pathname + u.search + u.hash;
    } catch (e) { return url; }
  }

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

    const origin = result?.originElement;
    if (origin && typeof origin === 'object') {
      const rect = origin.rect || {};
      const text = String(origin.text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      return `${direction}|origin:${String(result?.origin || '')}:${String(origin.tag || '')}:${String(origin.role || '')}:${Math.round(Number(rect.x) || 0)},${Math.round(Number(rect.y) || 0)},${Math.round(Number(rect.w) || 0)},${Math.round(Number(rect.h) || 0)}:${text}`;
    }
    return `${direction}|auto`;
  }

  _checkNoProgressScroll(tabId, name, args, result) {
    if (name !== 'scroll') {
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

  _checkLoop(tabId, toolName, toolArgs, toolResult) {
    if (toolResult?.pageUrlChanged === true && !this._noteNavArrival(tabId, toolResult.currentUrl)) {
      this._clearLoopState(tabId);
    }
    if (
      toolName === 'find_text'
      && toolResult?.success === true
      && !this._findTextMatchLoopIdentity(toolResult)
    ) {
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
