/** Value-free, run-scoped page monitoring. Keep the Firefox copy byte-identical. */
(() => {
  const previousMonitor = window.__wbPageMonitor;
  const recoveryOnly = window.__wbPageMonitorRecoveryOnly === true;
  delete window.__wbPageMonitorRecoveryOnly;
  if (previousMonitor && !previousMonitor.disposed
      && (recoveryOnly || previousMonitor.active === true)) return;
  previousMonitor?.dispose?.();
  const api = globalThis.browser || globalThis.chrome;
  // randomUUID is secure-context-only; related data frames and HTTP pages
  // still provide getRandomValues for unpredictable document/action tokens.
  const randomToken = () => crypto.randomUUID?.()
    || Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const documentToken = randomToken();
  const listeners = [];
  const operations = new Map();
  const modelSnapshots = new Map();
  const MODEL_SNAPSHOT_MS = 120000;
  const MODEL_TARGET_LIMIT = 512;
  const MODEL_SCAN_LIMIT = 2048;
  const MODEL_PUBLIC_MAX = 12000;
  const MODEL_EVIDENCE_MAX = 2000;
  const agentLayoutHistory = [];
  const nativeTargets = new Set();
  // Weak references keep disconnected fields from outliving the DOM until their batch is sampled.
  const controlReferences = new Set();
  let signatures = new WeakMap();
  let controlSignatures = new WeakMap();
  let textSignatures = new WeakMap();
  let popoverTurns = new WeakMap();
  let roots = new WeakSet();
  let animationAttribution = new WeakMap();
  let active = false, disposed = false, runToken = '', seq = 0, revision = 0, interventionRevision = 0;
  let observer = null, layoutObserver = null, domTimer = null, scrollTimer = null, controlTimer = null, lastUserAt = 0;
  let pointerHeld = false, composing = false, localOperation = null, controlIterator = null;
  let preparedOperationCursor = 0;
  let requestGeneration = 0, unreported = 0, interventionUnreported = 0, pendingDOM = null;
  let interventionDiagnostic = '';
  let lastViewport = '';
  let agentResize = null;
  let lastFeedbackDelivery = Promise.resolve();
  let agentTurn = null, userTurn = null, lastUserTarget = null;
  let identityPreparationCapture = null;
  let matchedEvents = new WeakMap();
  const activePointers = new Set();
  const fenceAttribute = 'data-webbrain-page-revision';
  const nativeMarkerAttribute = 'data-webbrain-native-action';
  const nativeMarkerMask = (1n << 64n) - 1n;
  const nativeMarkerRotate = (value, bits) => ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & nativeMarkerMask;
  function nativeMarkerSignature(secret, data) {
    if (!/^[a-f\d]{32}$/i.test(secret || '')) return '';
    const key = Uint8Array.from(secret.match(/.{2}/g), byte => parseInt(byte, 16));
    const read64 = offset => {
      let value = 0n;
      for (let index = 0; index < 8; index++) value |= BigInt(key[offset + index]) << BigInt(index * 8);
      return value;
    };
    const k0 = read64(0), k1 = read64(8);
    const rotate = nativeMarkerRotate;
    let v0 = 0x736f6d6570736575n ^ k0, v1 = 0x646f72616e646f6dn ^ k1;
    let v2 = 0x6c7967656e657261n ^ k0, v3 = 0x7465646279746573n ^ k1;
    const round = () => {
      v0 = (v0 + v1) & nativeMarkerMask; v1 = rotate(v1, 13); v1 ^= v0; v0 = rotate(v0, 32);
      v2 = (v2 + v3) & nativeMarkerMask; v3 = rotate(v3, 16); v3 ^= v2;
      v0 = (v0 + v3) & nativeMarkerMask; v3 = rotate(v3, 21); v3 ^= v0;
      v2 = (v2 + v1) & nativeMarkerMask; v1 = rotate(v1, 17); v1 ^= v2; v2 = rotate(v2, 32);
    };
    const bytes = new TextEncoder().encode(JSON.stringify([data.documentToken, data.runToken, data.operationId, data.revision,
      data.kind, data.sequence, data.navigationCandidate === true]));
    let offset = 0;
    while (offset + 8 <= bytes.length) {
      let block = 0n;
      for (let index = 0; index < 8; index++) block |= BigInt(bytes[offset + index]) << BigInt(index * 8);
      v3 ^= block; round(); round(); v0 ^= block; offset += 8;
    }
    let tail = BigInt(bytes.length) << 56n;
    for (let index = 0; offset + index < bytes.length; index++) tail |= BigInt(bytes[offset + index]) << BigInt(index * 8);
    v3 ^= tail; round(); round(); v0 ^= tail; v2 ^= 0xffn;
    round(); round(); round(); round();
    return (v0 ^ v1 ^ v2 ^ v3).toString(16).padStart(16, '0');
  }
  const publishRevision = () => {
    const value = `${documentToken}:${revision}`;
    if (active && document.documentElement?.getAttribute(fenceAttribute) !== value) document.documentElement?.setAttribute(fenceAttribute, value);
  };
  const compact = (value, max = 120) => String(value || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
  const editable = el => !!el?.closest?.('input,textarea,[contenteditable]:not([contenteditable="false"])');
  // Owned references survive reinjection in the isolated content-script world.
  // Page-controlled IDs and attributes cannot establish extension ownership.
  const decorations = window.__wbPageMonitorDecorations ??= new WeakSet();
  const registerDecoration = el => {
    if (el?.nodeType === 1 && el.ownerDocument === document && el !== document.body && el !== document.documentElement) decorations.add(el);
    return el;
  };
  const ignored = el => {
    if (!el || el.nodeType !== 1 || /^(SCRIPT|STYLE|LINK|META|HEAD)$/.test(el.tagName)) return true;
    for (let node = el; node; node = node.parentElement || node.getRootNode?.().host) {
      // Reparenting the page under a real indicator cannot silence the page.
      if (node === document.body || node === document.documentElement) return false;
      if (decorations.has(node)) return true;
    }
    return false;
  };
  const visible = el => {
    if (ignored(el)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || el.getClientRects().length === 0) return false;
    for (let ancestor = el.parentElement || el.getRootNode?.().host; ancestor; ancestor = ancestor.parentElement || ancestor.getRootNode?.().host) {
      if (getComputedStyle(ancestor).opacity === '0') return false;
    }
    return true;
  };
  const elementFor = event => event.composedPath?.().find(node => node instanceof Element) || event.target;
  const targetName = el => {
    if (ignored(el)) return '';
    // Never include editable contents, input values, key names or selections.
    return compact(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`
      + (el.getAttribute('role') ? ` [${el.getAttribute('role')}]` : ''));
  };
  const send = event => {
    if (!active || disposed) return;
    publishRevision();
    const feedback = { ...event, runToken, documentToken, seq: ++seq, revision };
    const pending = event.source !== 'agent';
    const intervention = pending && (event.kind !== 'dom' || event.source !== 'page');
    const owner = runToken;
    if (pending) unreported++;
    if (intervention) {
      interventionRevision++; interventionUnreported++;
      if (!(event.kind === 'dom' && event.source === 'unknown' && interventionDiagnostic.startsWith('dom.'))) {
        const kind = ['dom', 'activity', 'input', 'click', 'selection', 'scroll', 'navigation', 'resize'].includes(event.kind) ? event.kind : 'other';
        const source = ['user', 'page', 'unknown'].includes(event.source) ? event.source : 'other';
        interventionDiagnostic = `feedback.${kind}.${source}`;
      }
    }
    try {
      const delivery = Promise.resolve(api.runtime.sendMessage({ target: 'background', action: 'page_feedback', feedback }))
        .then(() => { if (owner === runToken) {
          if (pending) unreported = Math.max(0, unreported - 1);
          if (intervention) interventionUnreported = Math.max(0, interventionUnreported - 1);
        } })
        .catch(() => stop());
      if (pending) lastFeedbackDelivery = delivery;
      return delivery;
    } catch { stop(); }
  };
  const currentViewport = () => ({ width: window.innerWidth, height: window.innerHeight,
    visualWidth: window.visualViewport?.width ?? window.innerWidth, visualHeight: window.visualViewport?.height ?? window.innerHeight,
    scale: window.visualViewport?.scale ?? 1, offsetX: window.visualViewport?.offsetLeft ?? 0, offsetY: window.visualViewport?.offsetTop ?? 0 });
  function flushAgentResize(source, expected = agentResize) {
    if (!expected || agentResize !== expected) return Promise.resolve();
    clearTimeout(expected.timer); agentResize = null;
    return Promise.allSettled(expected.events.map(viewport => send({ kind: 'resize', source, target: 'viewport', viewport })));
  }
  function beginAgentResize(params) {
    if (!active || params.runToken !== runToken || typeof params.operationId !== 'string' || !params.operationId) return false;
    if (agentResize) void flushAgentResize('unknown');
    const marker = { runToken, operationId: params.operationId, userAt: lastUserAt, events: [], timer: null };
    marker.timer = setTimeout(() => { void flushAgentResize('unknown', marker); }, 5000);
    agentResize = marker;
    return true;
  }
  async function finishAgentResize(params) {
    const marker = agentResize;
    if (!marker || marker.runToken !== runToken || params.runToken !== runToken || marker.operationId !== params.operationId) {
      return { ready: false };
    }
    const finalViewport = marker.events.at(-1);
    const expected = params.expectedViewport;
    const attributed = marker.userAt === lastUserAt && finalViewport
      && Number.isFinite(expected?.width) && Number.isFinite(expected?.height)
      && finalViewport.width === expected.width && finalViewport.height === expected.height;
    await flushAgentResize(attributed ? 'agent' : 'unknown', marker);
    return { ready: true, attributed: !!attributed };
  }
  const interact = (kind, el, { completeGesture = false, ...extra } = {}) => {
    const isIgnored = ignored(el);
    if (!active || (isIgnored && !completeGesture)) return;
    lastUserAt = Date.now(); lastUserTarget = isIgnored ? null : el; revision++;
    const marker = {}; userTurn = marker;
    setTimeout(() => { if (userTurn === marker) userTurn = null; }, 0);
    send({ kind, source: 'user', target: targetName(el), interacting: pointerHeld || composing, ...extra });
  };
  const resolveTarget = params => {
    let el = params.element instanceof Element ? params.element : params.ref_id ? window.__wb_ax_lookup?.(params.ref_id) : null;
    if (params.nativeTarget) {
      const find = root => {
        const marked = root.querySelector(`[data-webbrain-native-target="${CSS.escape(params.nativeTarget)}"]`);
        if (marked) return marked;
        for (const candidate of root.querySelectorAll('*')) {
          if (candidate.shadowRoot) { const found = find(candidate.shadowRoot); if (found) return found; }
        }
      };
      el = find(document) || el;
      if (el) nativeTargets.add(el);
    }
    try { if (!el && params.selector) el = queryOpenTargets(params.selector).elements[0] || null; } catch {}
    if (!el && Number.isFinite(params.x) && Number.isFinite(params.y)) el = document.elementFromPoint(params.x, params.y);
    if (!el && params.textMatch) {
      const matches = [...document.querySelectorAll('button,a,input,select,[role="button"],[role="link"]')]
        .filter(node => (node.getAttribute('aria-label') || node.textContent || '').trim() === params.textMatch);
      if (matches.length === 1) el = matches[0];
    }
    return el;
  };
  function queryOpenTargets(selector) {
    const elements = [], roots = [document];
    let scanned = 0, rootCount = 0;
    try {
      while (roots.length) {
        const root = roots.pop();
        if (++rootCount > 64) return { elements, complete: false };
        for (const element of root.querySelectorAll(selector)) {
          elements.push(element);
          if (elements.length > 1) return { elements, complete: true };
        }
        const nodes = root.querySelectorAll('*');
        scanned += nodes.length;
        if (scanned > 65536) return { elements, complete: false };
        for (let index = nodes.length - 1; index >= 0; index--) {
          const shadow = nodes[index].shadowRoot;
          if (shadow?.mode === 'open') roots.push(shadow);
        }
      }
      return { elements, complete: true };
    } catch { return { elements: [], complete: false }; }
  }
  function deepElementFromPoint(x, y) {
    let hit = document.elementFromPoint(x, y);
    for (let depth = 0; depth < 24 && hit?.shadowRoot?.mode === 'open'; depth++) {
      const next = hit.shadowRoot.elementFromPoint?.(x, y) || hit.shadowRoot.elementsFromPoint?.(x, y)?.[0];
      if (!next || next === hit) break;
      hit = next;
    }
    return hit;
  }
  const kindFor = tool => {
    if (/type|field|key/.test(tool)) return 'input';
    if (/scroll/.test(tool)) return 'scroll';
    if (/click|checked|hover|drag|upload/.test(tool)) return 'click';
    return 'dom';
  };
  const prune = () => {
    for (const [id, op] of operations) if (op.until < Date.now()) operations.delete(id);
  };
  const related = (a, b) => !!a && !!b && (a === b
    || (a !== document.body && a !== document.documentElement && a.contains?.(b)));
  function layoutAgentOperation(op, el, shift) {
    if (!op?.dispatched || Date.now() > Math.max(op.until, op.layoutUntil || 0)
        || !Number.isFinite(op.userAt) || lastUserAt > op.userAt) return false;
    const target = op.target || (op.focused ? op.focusTarget : null);
    if (!target) return false;
    // A layout shift is attributable only when its source is the operation's
    // target, part of that target, or an ancestor that moves the target.
    if (related(target, el) || related(el, target)) return true;
    // Editing a target can move a following sibling. Associate only the
    // matching displacement from a recent, expected input on that target.
    if ((op.layoutCauses || []).some(cause => layoutCauseMatches(cause, el, shift))) return true;
    // Scroll operations may change layout inside their actual scroll box.
    // Ignore document-wide ancestors so an unrelated page shift is not claimed.
    for (const region of op.scrollAncestors || []) {
      if (!region?.isConnected || region === document.body || region === document.documentElement) continue;
      const style = getComputedStyle(region);
      const scrollableX = /^(auto|scroll|overlay)$/.test(style.overflowX) && region.scrollWidth > region.clientWidth + 1;
      const scrollableY = /^(auto|scroll|overlay)$/.test(style.overflowY) && region.scrollHeight > region.clientHeight + 1;
      if ((scrollableX || scrollableY) && related(region, el)) return true;
    }
    return false;
  }
  function layoutAgentUserAt(el, shift) {
    if (!(el instanceof Element)) return undefined;
    if (agentTurn && lastUserAt <= agentTurn.userAt && localOperation?.operationId) {
      const op = operations.get(localOperation.operationId);
      if (layoutAgentOperation(op, el, shift)) return op.userAt;
    }
    for (const op of operations.values()) if (layoutAgentOperation(op, el, shift)) return op.userAt;
    pruneAgentLayoutHistory();
    const cause = agentLayoutHistory.find(entry => lastUserAt <= entry.userAt && layoutCauseMatches(entry, el, shift));
    if (cause) return cause.userAt;
    return undefined;
  }
  function pruneAgentLayoutHistory() {
    const now = Date.now();
    for (let i = agentLayoutHistory.length - 1; i >= 0; i--) if (agentLayoutHistory[i].until < now) agentLayoutHistory.splice(i, 1);
  }
  function layoutCauseMatches(cause, el, shift) {
    if (Date.now() > cause.until || cause.parent !== el.parentElement || !shift?.previousRect || !shift?.currentRect) return false;
    const sourceTopDelta = shift.currentRect.y - shift.previousRect.y;
    return Math.abs(sourceTopDelta) > 2 && Math.sign(sourceTopDelta) === Math.sign(cause.heightDelta)
      && Math.abs(sourceTopDelta) <= Math.abs(cause.heightDelta) + 8;
  }
  function rememberAgentLayout(op) {
    if (!op?.target) return;
    pruneAgentLayoutHistory();
    const before = op.layoutRect || op.targetRectAtDispatch, after = rectFor(op.target);
    if (before && after && Math.abs(after.height - before.height) > 2) {
      const causes = op.layoutCauses ||= [];
      const cause = { parent: op.target.parentElement, heightDelta: after.height - before.height,
        userAt: op.userAt, until: Date.now() + 3000 };
      causes.push(cause);
      agentLayoutHistory.push(cause);
      if (agentLayoutHistory.length > 256) agentLayoutHistory.splice(0, agentLayoutHistory.length - 256);
      if (causes.length > 8) causes.splice(0, causes.length - 8);
    }
    if (after) op.layoutRect = after;
    op.layoutUntil = Date.now() + 3000;
  }
  const rectFor = el => {
    if (!(el instanceof Element) || !el.isConnected) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  };
  function coordinatePreparationShifted(op) {
    if (!op?.coordinateSensitive || op.layoutInvalidated || op.dispatched || op.preparedRevision !== revision) return false;
    const target = op.coordinateTarget;
    const currentHit = document.elementFromPoint(op.coordinatePoint.x, op.coordinatePoint.y);
    const previousRect = op.coordinateRect, currentRect = rectFor(target);
    const initialHit = op.coordinateHit;
    const sameHit = initialHit && currentHit && (initialHit === currentHit
      || (initialHit !== document.body && initialHit !== document.documentElement && initialHit.contains?.(currentHit)));
    const hitChanged = !initialHit || !sameHit;
    const rectChanged = op.coordinateTargetAtPoint && (!target?.isConnected || !previousRect || !currentRect
      || ['x', 'y', 'width', 'height'].some(key => Math.abs(previousRect[key] - currentRect[key]) > 2));
    if (!hitChanged && !rectChanged) return false;
    op.layoutInvalidated = true;
    revision++; publishRevision();
    const source = layoutAgentUserAt(target || currentHit) !== undefined ? 'agent' : 'page';
    send({ kind: 'dom', source, target: targetName(target || currentHit) });
    return true;
  }
  function expected(kind, el, event, nativeMarkerOnly = false) {
    let activatedNativeMarker = false;
    const markerNode = event?.composedPath?.().find(node => node instanceof Element && node.hasAttribute(nativeMarkerAttribute))
      || (el?.hasAttribute?.(nativeMarkerAttribute) ? el : null);
    const marker = markerNode?.getAttribute(nativeMarkerAttribute);
    if (marker && event?.isTrusted === true) {
      try {
        const data = JSON.parse(marker);
        const op = operations.get(data.operationId);
        const markerTarget = op && (markerNode === op.target || markerNode === op.focusTarget);
        const nextSequence = Number.isSafeInteger(data.sequence) && data.sequence === (op?.nativeSequence || 0) + 1;
        const allowedEvent = data.kind === 'input'
          ? ['keydown', 'beforeinput', 'input', 'change', 'compositionstart', 'compositionend'].includes(event.type)
          : data.kind === 'click' ? ['pointerover', 'mouseover', 'pointermove', 'pointerdown', 'mousedown', 'click'].includes(event.type) : false;
        const fresh = op && data.revision === op.preparedRevision && op.preparedRevision === revision
          && !domTimer && !unreported && lastUserAt <= op.userAt;
        const signed = op && nativeMarkerSignature(op.nativeSecret, data) === data.signature;
        if (data.documentToken === documentToken && data.runToken === runToken && op && markerTarget && nextSequence
            && fresh && signed && allowedEvent && ['input', 'click'].includes(data.kind)) {
          // The capability is bound to the isolated-world prepared node and consumed once.
          op.nativeSequence = data.sequence;
          markerNode.removeAttribute(nativeMarkerAttribute);
          dispatch({ operationId: data.operationId, kind: data.kind, runToken, navigationCandidate: data.navigationCandidate === true });
          activatedNativeMarker = true;
          const markerTurn = { userAt: op.userAt };
          agentTurn = markerTurn;
          setTimeout(() => { if (agentTurn === markerTurn) agentTurn = null; }, 0);
        }
      } catch { /* Page markers are hints; malformed ones grant no expectation. */ }
    }
    if (nativeMarkerOnly && !activatedNativeMarker) return null;
    if (event && matchedEvents.has(event)) return matchedEvents.get(event);
    prune();
    const match = op => {
      if (event && !event.isTrusted && !op.synchronous) return null;
      if (event) {
        const keyboardClick = kind === 'click' && event.type === 'click' && event.isTrusted === true && op.keyboardClickTarget
          && related(op.keyboardClickTarget, el);
        const submitClick = kind === 'click' && event.detail === 0 && op.submitTarget && related(op.submitTarget, el);
        if (op.eventTypes && !op.eventTypes.has(event.type) && !keyboardClick && !submitClick) return null;
        // One native dispatch owns one occurrence of each input phase. A later
        // human action on the same target must not fit that expectation again.
        if (!op.synchronous && event.type !== 'pointermove' && op.seenEvents?.has(event.type)) return null;
        op.seenEvents?.add(event.type); matchedEvents.set(event, op);
      }
      return op;
    };
    for (const op of operations.values()) {
      // Keep late scroll/blur commits attributable without claiming a fresh
      // physical key or pointer sequence after the action already returned.
      if (op.finished && kind !== 'scroll' && !(kind === 'input' && event?.type === 'change')) continue;
      // Preparation can focus only the field that was already identified for
      // this input action. A page script moving focus elsewhere stays visible.
      if (kind === 'focus' && op.focusEligible && op.focusTarget === el && lastUserAt <= op.userAt) {
        const found = match(op); if (found) return found;
      }
      if (!op.dispatched) continue;
      if (lastUserAt > op.userAt) continue;
      // Keyboard-activated clicks can report detail=1 in Firefox. Do not let
      // the temporary click expectation absorb a physical pointer sequence.
      if (kind === 'click' && op.keyboardClickTarget && event && event.type !== 'click') continue;
      // Moving agent focus commits the previous field's native change event.
      if (kind === 'input' && event?.type === 'change' && op.blurTarget === el) { const found = match(op); if (found) return found; }
      if (kind === 'scroll' && op.blurTarget === el && editable(el)) { const found = match(op); if (found) return found; }
      if (!op.kinds.has(kind)) continue;
      if (['wheel', 'touchmove'].includes(event?.type) && !op.nativeWheel) continue;
      const target = op.target || (op.focused ? document.activeElement : null);
      if (kind === 'click' && event?.type === 'click' && event?.isTrusted === true
          && ((event.detail === 0 && op.submitTarget && related(op.submitTarget, el))
            || (op.keyboardClickTarget && related(op.keyboardClickTarget, el)))) {
        const found = match(op); if (found) return found;
      }
      if (kind === 'scroll' && op.scrollAncestors?.has(el)) { const found = match(op); if (found) return found; }
      if (kind === 'scroll' && op.windowScroll && (el === document.documentElement || el === document.body)) { const found = match(op); if (found) return found; }
      if (related(target, el)) { const found = match(op); if (found) return found; }
      if (event && Number.isFinite(op.x) && Number.isFinite(op.y)
          && Math.abs(event.clientX - op.x) <= 2 && Math.abs(event.clientY - op.y) <= 2) { const found = match(op); if (found) return found; }
    }
    return null;
  }
  function textSignature(node) {
    const text = node.textContent || '', cached = textSignatures.get(node);
    if (cached?.text === text) return cached.signature;
    // Keep the fingerprint fixed-size while covering the entire text, including
    // equal-length middle/suffix edits. Unchanged nodes avoid rehashing on layout reads.
    let hash = 0, power = 1;
    for (let i = 0; i < text.length; i++) {
      hash = (Math.imul(hash, 16777619) + text.charCodeAt(i)) >>> 0;
      power = Math.imul(power, 16777619) >>> 0;
    }
    const value = [text.length, hash, power];
    textSignatures.set(node, { text, signature: value });
    return value;
  }
  function deepActiveElement() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }
  function controlValueFingerprint(el) {
    let controlValue = null;
    if ((el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT'
        && !['password', 'file', 'hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image'].includes(el.type)))) {
      const value = el.value || '', samples = Math.min(value.length, 8192);
      let first = 0x811c9dc5, second = 0x9e3779b9;
      // Hash locally only; feedback contains a generic target and never the value or typed keys.
      for (let index = 0; index < samples; index++) {
        const code = value.charCodeAt(samples === value.length ? index : Math.floor(index * value.length / samples));
        first = Math.imul(first ^ code, 16777619) >>> 0;
        second = Math.imul(second ^ (code + index), 2246822519) >>> 0;
      }
      controlValue = [value.length, first, second];
    }
    return controlValue;
  }
  function controlState(el) {
    return JSON.stringify([el.getAttribute('value'), el.selected === true, el.defaultSelected === true,
      Number.isInteger(el.selectedIndex) ? el.selectedIndex : null, el.checked === true,
      el.disabled === true, el.readOnly === true, el.required === true, el.validity?.valid !== false,
      controlValueFingerprint(el)]);
  }
  function trackControl(el) {
    if (!/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName) || controlSignatures.has(el)) return;
    controlReferences.add(new WeakRef(el));
    controlSignatures.set(el, controlState(el));
  }
  function refreshControl(el) {
    if (/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName)) {
      trackControl(el);
      controlSignatures.set(el, controlState(el));
    }
    if (el.tagName === 'SELECT') {
      for (const option of el.options || []) {
        trackControl(option);
        controlSignatures.set(option, controlState(option));
        signatures.set(option, signature(option));
      }
    }
    const current = signature(el);
    signatures.set(el, current);
    // A value setter produces input/change events without a DOM mutation.
    // Keep the periodic sampler aligned with the event already consumed here;
    // immutable inference bindings still retain their original field state.
    for (const op of operations.values())
      if (!op.dispatched && op.target === el && op.until >= Date.now()) op.preparedTargetSignature = current;
  }
  function signature(el) {
    if (ignored(el)) return '';
    trackControl(el);
    const shown = visible(el);
    const rect = shown ? el.getBoundingClientRect() : {};
    const content = editable(el) ? '' : [...el.childNodes, ...(el.shadowRoot?.childNodes || [])].filter(node => node.nodeType === 3)
      .map(textSignature).reduce(([size, hash], [length, part, power]) =>
        [size + length, (Math.imul(hash, power) + part) >>> 0], [0, 0]);
    const controlValue = controlValueFingerprint(el);
    return JSON.stringify([shown, content, el.children.length + (el.shadowRoot?.children.length || 0), el.getAttribute('role'), el.getAttribute('aria-modal'), el.getAttribute('aria-label'),
      el.getAttribute('id'), el.getAttribute('for'), el.getAttribute('form'), el.getAttribute('name'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('alt'),
      el.getAttribute('aria-labelledby'), el.getAttribute('aria-required'), el.getAttribute('aria-readonly'),
      el.getAttribute('contenteditable'), el.getAttribute('tabindex'), el.getAttribute('onclick'), el.getAttribute('required'),
      el.getAttribute('aria-expanded'), el.getAttribute('aria-selected'), el.getAttribute('aria-checked'), el.getAttribute('data-selected'),
      el.getAttribute('aria-valuenow'), el.getAttribute('aria-valuetext'),
      el.getAttribute('aria-pressed'),
      el.getAttribute('type'),
      el.getAttribute('href'), el.getAttribute('target'), el.getAttribute('download'), el.getAttribute('action'), el.getAttribute('method'),
      el.getAttribute('formaction'), el.getAttribute('formmethod'), el.getAttribute('formtarget'),
      el.hasAttribute('novalidate'), el.hasAttribute('formnovalidate'),
      el.getAttribute('popover'), popoverOpen(el),
      el.selected === true, el.defaultSelected === true,
      Number.isInteger(el.selectedIndex) ? el.selectedIndex : null,
      el.getAttribute('aria-hidden'), el.hasAttribute('open'), el.inert === true,
      el.getAttribute('aria-disabled'), el.getAttribute('value'), controlValue, el.disabled === true, el.readOnly === true, el.checked === true, el.validity?.valid !== false, Math.round((rect.width || 0) / 8), Math.round((rect.height || 0) / 8),
      Math.round(((rect.x || 0) + window.scrollX) / 8), Math.round(((rect.y || 0) + window.scrollY) / 8)]);
  }
  const passiveRebaseTools = new Set(['click', 'click_ax', 'type', 'type_ax', 'type_text', 'set_field', 'set_checked',
    'press_keys', 'hover', 'upload_file', 'iframe_click', 'iframe_type', 'input', 'focus']);
  const bindingParent = node => node?.parentElement || node?.getRootNode?.().host || null;
  function labelBinding(el) {
    const labels = new Set(el.labels || []);
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      for (const id of (el.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) {
        const node = el.getRootNode?.().getElementById?.(id) || document.getElementById(id);
        if (!node) return null;
        labels.add(node);
      }
    }
    return [...labels].map(node => ({ node, value: JSON.stringify([signature(node), node.textContent]) }));
  }
  function preparedBinding(target) {
    if (!(target instanceof Element) || !target.isConnected || target.ownerDocument !== document) return null;
    const nodes = [], ancestors = [];
    let scope = target.form || target.closest('form,dialog,[role="dialog"],[role="alertdialog"],[role="region"],[role="group"],article,[role="article"],[role="listitem"]');
    if (!scope) {
      // Include the composer containing both field and action when no semantic
      // form/dialog exists. A page-wide ancestor would also bind unrelated feeds.
      let parent = bindingParent(target);
      scope = parent && parent !== document.body && parent !== document.documentElement ? parent : target;
      for (let depth = 0; parent && depth < 4 && parent !== document.body && parent !== document.documentElement; depth++, parent = bindingParent(parent)) {
        if (parent.querySelector('input,textarea,[contenteditable]:not([contenteditable="false"])')) { scope = parent; break; }
      }
    }
    for (let ancestor = bindingParent(target); ancestor; ancestor = bindingParent(ancestor)) {
      if (ancestors.length >= 24) return null;
      const labels = labelBinding(ancestor);
      if (!labels) return null;
      ancestors.push({ node: ancestor, value: JSON.stringify([signature(ancestor), labels.map(label => label.value)]) });
      nodes.push(...labels);
    }
    // Recipient/conversation headings can sit outside a composer form. Bind
    // their identity and text without binding every counter in a live feed.
    const headings = document.querySelectorAll('h1,h2,h3,[role="heading"],[aria-current]');
    if (headings.length > 64) return null;
    for (const node of headings) nodes.push({ node, value: JSON.stringify([signature(node), node.textContent]) });
    if (target.form) for (const node of target.form.elements) {
      if (nodes.length >= 256) return null;
      if (node.tagName === 'INPUT' && node.type === 'file' && node.files?.length > 32) return null;
      nodes.push({ node, value: JSON.stringify([signature(node), controlState(node), node.value]),
        ...(node.tagName === 'INPUT' && node.type === 'file' ? { files: [...node.files || []] } : {}) });
    }
    const stack = [scope];
    while (stack.length) {
      const node = stack.pop();
      if (nodes.length >= 256) return null;
      if (node.nodeType === 1) {
        if (ignored(node)) continue;
        const labels = labelBinding(node);
        if (!labels) return null;
        if (node.tagName === 'INPUT' && node.type === 'file' && node.files?.length > 32) return null;
        // Exact values remain private in the isolated monitor and never enter
        // feedback/guards. Sampling could miss a middle edit in a long value.
        nodes.push({ node, value: JSON.stringify([signature(node), controlState(node),
          /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(node.tagName) ? node.value : null,
          node.getAttribute('aria-describedby'), labels.map(label => label.value)]),
          ...(node.tagName === 'INPUT' && node.type === 'file' ? { files: [...node.files || []] } : {}) }, ...labels);
        const children = node.childNodes, shadowChildren = node.shadowRoot?.childNodes || [];
        if (children.length + shadowChildren.length + stack.length + nodes.length > 256) return null;
        for (let index = shadowChildren.length - 1; index >= 0; index--) stack.push(shadowChildren[index]);
        for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
      } else if (node.nodeType === 3) nodes.push({ node, value: node.data });
    }
    const rect = target.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { target, scope, ancestors, nodes, hit, context: JSON.stringify([location.href, document.baseURI,
      currentViewport(), window.scrollX, window.scrollY]) };
  }
  function samePreparedBinding(before, after) {
    if (!before || !after || before.target !== after.target || before.scope !== after.scope || before.hit !== after.hit || before.context !== after.context) return false;
    return ['ancestors', 'nodes'].every(key => before[key].length === after[key].length
      && before[key].every((item, index) => item.node === after[key][index].node && item.value === after[key][index].value
        && (!item.files || (item.files.length === after[key][index].files?.length
          && item.files.every((file, fileIndex) => file === after[key][index].files[fileIndex])))));
  }
  // Model snapshots bind an action's meaning, not unrelated text/counts in
  // its surrounding page. These exact values stay private in this realm.
  const modelControlSelector = 'button,a[href],input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),'
    + '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="textbox"],'
    + '[role="combobox"],[role="listbox"],[role="option"],[role="slider"],[role="spinbutton"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]';
  const entityOwnerSelector = 'dialog,[role="dialog"],[role="alertdialog"],[role="region"],article,[role="article"],[role="listitem"]';
  const navigationOwnerSelector = 'nav,[role="navigation"],header,[role="banner"],[role="tablist"]';
  const modelEntityIdentityAttributes = ['data-recipient', 'data-conversation', 'data-thread', 'data-chat', 'data-channel',
    'data-resource', 'data-entity', 'data-record', 'data-post', 'data-item', 'data-message', 'data-user', 'data-account'];
  const modelEntityIdentitySelector = modelEntityIdentityAttributes.flatMap(attribute => [attribute,
    `${attribute}-id`, `${attribute}-key`, `${attribute}-name`]).map(attribute => `[${attribute}]`).join(',');
  const modelActionTools = new Set([...passiveRebaseTools].filter(tool => !tool.startsWith('iframe_')));
  const modelFocusTools = new Set(['type_text', 'press_keys', 'input', 'focus']);
  const decorativeEventNames = new WeakMap();
  function hasDecorativeEventHandler(node) {
    const nativePrototype = Object.getPrototypeOf(node);
    let eventNames = decorativeEventNames.get(nativePrototype);
    if (!eventNames) {
      const names = new Set();
      for (let prototype = nativePrototype; prototype; prototype = Object.getPrototypeOf(prototype)) {
        for (const name of Object.getOwnPropertyNames(prototype)) if (/^on[a-z]/i.test(name)) names.add(name);
      }
      eventNames = [...names];
      decorativeEventNames.set(nativePrototype, eventNames);
    }
    try {
      return [...eventNames, ...Object.getOwnPropertyNames(node).filter(name => /^on[a-z]/i.test(name))]
        .some(name => typeof node[name] === 'function');
    } catch { return true; }
  }
  function isReadonlyPreparationDecoration(node) {
    if (!(node instanceof SVGElement) || node.localName !== 'svg' || node.getAttribute('aria-hidden') !== 'true') return false;
    const nodes = [node, ...node.querySelectorAll('*')];
    return nodes.length <= 128 && nodes.every(current => current instanceof SVGElement && !current.shadowRoot
      && !current.matches(modelControlSelector + ',' + modelEntityIdentitySelector)
      && !current.matches('a,title,desc,[href],[tabindex],[contenteditable],[aria-label],[aria-labelledby],[aria-describedby],[data-action],[data-target],[data-command],[data-operation]')
      && !current.hasAttribute('xlink:href') && !current.textContent.trim()
      && (!current.hasAttribute('role') || ['img', 'presentation', 'none'].includes(current.getAttribute('role')))
      && ![...current.attributes].some(attribute => /^on/i.test(attribute.name)) && !hasDecorativeEventHandler(current));
  }
  function modelHit(target, action, hit) {
    if (target !== action || hit === target || !(hit instanceof SVGElement)) return hit;
    const svg = hit.closest('svg[aria-hidden="true"]');
    if (!svg || !svg.isConnected || svg.ownerDocument !== document || !target.contains(svg)) return hit;
    const nodes = [svg, ...svg.querySelectorAll('*')];
    if (nodes.length > 128) return hit;
    const path = [];
    for (let parent = svg.parentElement; parent && parent !== action; parent = parent.parentElement) {
      path.push(parent);
      if (path.length + nodes.length > 128) return hit;
    }
    if (nodes.some(node => !(node instanceof SVGElement))) return hit;
    nodes.push(...path);
    for (const node of nodes) {
      if (node.closest(modelControlSelector) !== action
          || node.matches(modelEntityIdentitySelector)
          || node.matches('a,title,desc,[href],[tabindex],[aria-label],[aria-labelledby],[aria-describedby],[data-action],[data-target],[data-command],[data-operation]')
          || node.hasAttribute('xlink:href')
          || (node.hasAttribute('role') && !['img','presentation','none'].includes(node.getAttribute('role')))
          || [...node.attributes].some(attribute => /^on/i.test(attribute.name))
          || hasDecorativeEventHandler(node)) return hit;
    }
    // Capture qualification while the original child is connected. A later
    // decorative replacement can compare against this same original action;
    // overlays, handlers, names and interactive descendants never normalize.
    return target;
  }
  const semanticAttributes = ['id', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-modal', 'aria-current',
    'aria-required', 'aria-readonly', 'aria-disabled', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed',
    'aria-valuenow', 'aria-valuetext', 'aria-hidden', 'contenteditable', 'tabindex', 'name', 'placeholder', 'title', 'alt',
    'for', 'form', 'type', 'href', 'target', 'download', 'action', 'method', 'enctype', 'accept', 'multiple',
    'formaction', 'formmethod', 'formenctype', 'formtarget', 'novalidate', 'formnovalidate', 'required', 'readonly',
    'disabled', 'open', 'inert', 'popover', 'onclick', 'data-selected', 'src', 'srcset', 'sizes', 'media'];
  const modelIdentityDataAttributePattern = /^data-(?:(?:recipient|conversation|thread|chat|channel|resource|entity|record|post|item|message|user|account)(?:-(?:id|key|name|type))?|id|key|uuid|target|action|command|operation|selected|active|current|state|status|testid)$/;
  function plainDescriptionTypeIsInert(node) {
    const type = node.getAttribute('type');
    if (type === null) return true;
    // These HTML text containers have no native type-dependent behavior. A
    // custom descriptor still passes the complete noninteractive subtree check.
    return node.namespaceURI === 'http://www.w3.org/1999/xhtml' && !node.hasAttribute('is')
      && /^(?:div|span|[a-z][a-z0-9._]*-[a-z0-9._-]+)$/.test(node.localName)
      && type.length <= 64 && /^[a-zA-Z0-9_-]*$/.test(type);
  }
  function redundantButtonDescription(el) {
    // Only independently named native buttons can ignore a plain description
    // that repeats that exact name. Referenced identities and controls remain
    // meaningful, including hidden descendants and native event handlers.
    if (el?.tagName !== 'BUTTON' || el.shadowRoot || !el.isConnected || el.ownerDocument !== document
        || (el.getAttribute('role') && el.getAttribute('role') !== 'button')) return null;
    const authored = el.getAttribute('aria-label');
    if (typeof authored !== 'string' || authored.length > 128 || !authored.trim()) return null;
    const ids = (el.getAttribute('aria-describedby') || '').trim().split(/\s+/).filter(Boolean);
    if (ids.length !== 1 || ids[0].length > 128 || /[\u0000-\u0020\u007f]/.test(ids[0])) return null;
    try {
      const matches = el.getRootNode().querySelectorAll(`[id="${CSS.escape(ids[0])}"]`);
      if (matches.length === 0) return { node: null }; // No current description; later targets are checked again.
      if (matches.length !== 1) return null;
      const root = matches[0];
      if (root === el || root.contains(el) || !root.isConnected || root.ownerDocument !== document) return null;
      const control = root.closest(modelControlSelector);
      if (control && control !== el) return null;
      const boundaries = 'main,[role="main"],aside,[role="complementary"],section,form,[role="form"],'+entityOwnerSelector+','+navigationOwnerSelector+','+modelEntityIdentitySelector;
      const boundary = root.closest(boundaries);
      if (boundary && boundary !== el.closest(boundaries) && !boundary.contains(el)) return null;
      const pending = [root]; let visited = 0, text = '';
      while (pending.length) {
        if (++visited > 128) return null;
        const node = pending.pop();
        if (node.nodeType === 3) {
          text += node.data;
          if (text.length > 512) return null;
          continue;
        }
        if (node.nodeType === 8) continue; // Nonrendered comments still consume the traversal bound.
        if (!(node instanceof Element) || node.shadowRoot || node.isContentEditable
            || node.matches(modelControlSelector+','+modelEntityIdentitySelector)
            || node.matches('script,style,template,slot,img,svg,canvas,video,audio,iframe,object,embed,'
              +'[href],[xlink\\:href],[tabindex],[contenteditable],[aria-label],[aria-labelledby],[aria-describedby],'
              +'[aria-details],[aria-live],[title],[alt],[placeholder],[name],[value],[form],'
              +'[data-action],[data-target],[data-command],[data-operation],[popover]')
            || !plainDescriptionTypeIsInert(node)
            || semanticAttributes.some(attribute => !['id','role','aria-hidden','type'].includes(attribute) && node.hasAttribute(attribute))
            || [...node.attributes].some(attribute => modelIdentityDataAttributePattern.test(attribute.name))
            || (node.hasAttribute('role') && !['tooltip','presentation','none'].includes(node.getAttribute('role')))
            || [...node.attributes].some(attribute => /^on/i.test(attribute.name))
            || hasDecorativeEventHandler(node)) return null;
        if (pending.length + visited + node.childNodes.length > 128) return null;
        pending.push(...[...node.childNodes].reverse());
      }
      if (text.trim() !== authored.trim()) return null;
      // A nested duplicate contributes neither new text nor new child identity.
      // Bound the original button's other descendants, not just its name.
      if (el.contains(root) && el.querySelectorAll('*').length > 256) return null;
      return { node: root };
    } catch { return null; }
  }
  function ownedNativeButtonWrapper(el) {
    // A plain wrapper may repeat its sole native button's existing duplicate
    // description. Its identity, type, focus/state attributes stay fully bound.
    if (!(el instanceof Element) || el.tagName === 'BUTTON' || !el.isConnected || el.ownerDocument !== document
        || el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || el.hasAttribute('is') || el.shadowRoot
        || el.isContentEditable || el.tabIndex >= 0
        || el.matches(modelControlSelector+','+entityOwnerSelector+','+navigationOwnerSelector+','+modelEntityIdentitySelector)
        || el.matches('main,[role="main"],aside,[role="complementary"],section,form,[role="form"],fieldset,label,'
          +'[aria-label],[aria-labelledby],[aria-details],[aria-live],[title],[alt],[placeholder],[name],[value],[href],'
          +'[contenteditable],[data-action],[data-target],[data-command],[data-operation]')
        || (el.hasAttribute('role') && !['none','presentation'].includes(el.getAttribute('role')))
        || [...el.attributes].some(attribute => modelIdentityDataAttributePattern.test(attribute.name) || /^on/i.test(attribute.name))
        || hasDecorativeEventHandler(el)) return null;
    const descendants = el.querySelectorAll('*');
    if (descendants.length > 256 || [...descendants].some(node => node.shadowRoot)) return null;
    const controls = [...descendants].filter(node => node.matches(modelControlSelector));
    if (controls.length !== 1 || controls[0].tagName !== 'BUTTON') return null;
    const button = controls[0], description = redundantButtonDescription(button);
    const pending = [...el.childNodes].reverse(); let visited = 0, text = '';
    while (pending.length) {
      if (++visited > 256) return null;
      const node = pending.pop();
      if (node === button || node === description?.node) continue;
      if (node.nodeType === 3) { text += node.data; if (text.length > 512 || node.data.trim()) return null; continue; }
      if (node.nodeType === 8) continue;
      if (!(node instanceof Element) || node.shadowRoot || node.isContentEditable || node.tabIndex >= 0
          || node.matches(modelControlSelector+','+entityOwnerSelector+','+navigationOwnerSelector+','+modelEntityIdentitySelector)
          || node.matches('main,[role="main"],aside,[role="complementary"],section,form,[role="form"],fieldset,label,'
            +'slot,script,style,template,img,svg,canvas,video,audio,iframe,object,embed,[href],[xlink\\:href],'
            +'[contenteditable],[aria-label],[aria-labelledby],[aria-describedby],[aria-details],[aria-live],[title],'
            +'[alt],[placeholder],[name],[value],[form],[data-action],[data-target],[data-command],[data-operation]')
          || (node.hasAttribute('role') && !['none','presentation'].includes(node.getAttribute('role')))
          || [...node.attributes].some(attribute => modelIdentityDataAttributePattern.test(attribute.name) || /^on/i.test(attribute.name))
          || hasDecorativeEventHandler(node)) return null;
      if (pending.length + visited + node.childNodes.length > 256) return null;
      pending.push(...[...node.childNodes].reverse());
    }
    return { button, description };
  }
  function redundantOwnedButtonWrapperDescription(el) {
    const owned = ownedNativeButtonWrapper(el);
    // Reuse the native button's exact canonical-or-absent description proof.
    // Every later mounted node is fully checked again before it can normalize.
    return owned?.description && (el.getAttribute('aria-describedby') || '').trim()
      === (owned.button.getAttribute('aria-describedby') || '').trim() ? owned.description : null;
  }
  function redundantDescriptionBinding(el) {
    return redundantButtonDescription(el) || redundantOwnedButtonWrapperDescription(el);
  }
  function buttonTextWithoutDescription(el, description) {
    if (!description || !el.contains(description)) return el.textContent;
    const pending = [...el.childNodes].reverse(); let text = '';
    while (pending.length) {
      const node = pending.pop();
      if (node === description) continue;
      if (node.nodeType === 3) text += node.data;
      else pending.push(...[...node.childNodes].reverse());
    }
    return text;
  }
  function modelSemantic(el, { text = false, directText = false, control = false, observedName = false, nameOnly = false, structuralFile = false } = {}) {
    const style = getComputedStyle(el);
    const redundantDescription = redundantDescriptionBinding(el);
    let accessibleName = null;
    if (text) {
      // The selected target retains the name the model actually observed.
      // Other form controls use authored labels below: the AX formatter's
      // inferred preceding-sibling label may be an unrelated live counter.
      if (observedName && typeof window.__wb_ax_name === 'function') accessibleName = window.__wb_ax_name(el);
      else accessibleName = [el.getAttribute('aria-label'), el.getAttribute('alt'), el.getAttribute('title'),
        [...el.querySelectorAll('img,svg title,[aria-label]')].map(node => [node.getAttribute('alt'), node.getAttribute('aria-label'), node.textContent])];
    }
    return JSON.stringify([el.tagName, semanticAttributes.map(name => name === 'aria-describedby' && redundantDescription ? null : el.getAttribute(name)),
      [...el.attributes].filter(attribute => modelIdentityDataAttributePattern.test(attribute.name))
        .map(attribute => [attribute.name, attribute.value]).sort(([left], [right]) => left.localeCompare(right)),
      structuralFile ? null : style.display, structuralFile ? null : style.visibility,
      structuralFile ? null : Number(style.opacity) === 0, structuralFile ? null : style.contentVisibility, el.inert === true, popoverOpen(el),
      text && !nameOnly ? buttonTextWithoutDescription(el, redundantDescription?.node) : directText ? [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.data) : null,
      accessibleName, control ? controlState(el) : null,
      control && /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName) ? el.value : null,
      control && el.isContentEditable ? el.innerHTML : null,
      el instanceof HTMLImageElement ? el.currentSrc : null]);
  }
  function modelLabels(el) {
    const labels = new Set(el.labels || []);
    const redundantDescription = redundantDescriptionBinding(el);
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      for (const id of (el.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) {
        const root = el.getRootNode();
        const matches = root.querySelectorAll?.(`[id="${CSS.escape(id)}"]`);
        // Dangling ARIA references name no current label. Their attributes
        // remain bound, and a label appearing later changes the footprint.
        // Ambiguous references cannot establish an exact action context.
        if (!matches?.length) continue;
        if (matches.length !== 1) return null;
        if (attribute === 'aria-describedby' && matches[0] === redundantDescription?.node) continue;
        labels.add(matches[0]);
      }
    }
    return [...labels].map(node => ({ node, value: modelSemantic(node, { text: true }) }));
  }
  function currentConversationContext(target) {
    if (!target.closest('footer') || typeof window.__wb_get_message_conversation_context !== 'function') return null;
    try {
      const context = window.__wb_get_message_conversation_context(target);
      if (!context || typeof context.signature !== 'string' || context.signature.length > 8192
          || !Array.isArray(context.contextNodes) || context.contextNodes.length > 32
          || !Array.isArray(context.labelledByNodes) || context.labelledByNodes.length > 32
          || !Array.isArray(context.aliases) || context.aliases.length > 8
          || context.aliases.some(alias => typeof alias !== 'string' || alias.length > 256)) return null;
      const nodes = [context.carrier, context.header, context.pane, context.footer, context.composer,
        ...context.contextNodes, ...context.labelledByNodes];
      if (nodes.some(node => !(node instanceof Element) || node.ownerDocument !== document || !node.isConnected)
          || context.header.tagName !== 'HEADER' || context.footer.tagName !== 'FOOTER'
          || context.pane === document.body || context.pane === document.documentElement
          || !context.header.contains(context.carrier) || !context.footer.contains(target)
          || !context.footer.contains(context.composer) || !context.pane.contains(context.header)
          || !context.pane.contains(context.footer)) return null;
      return context;
    } catch { return null; }
  }
  function navigationTextMatchesName(control) {
    if (!control.matches('button,a[href],[role="button"],[role="link"]')
        || !['', 'button', 'link'].includes(control.getAttribute('role') || '')
        || typeof window.__wb_ax_name !== 'function') return false;
    const pending = [...control.childNodes], text = [];
    let visited = 0;
    while (pending.length) {
      if (++visited > 256) return false;
      const node = pending.pop();
      if (node.nodeType === 3) { text.push(node.data); continue; }
      if (!(node instanceof Element) || ignored(node) || node.getAttribute('aria-hidden') === 'true') continue;
      const style = getComputedStyle(node);
      if (style.display === 'none' || ['hidden','collapse'].includes(style.visibility)
          || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') continue;
      if (node.shadowRoot) return false;
      pending.push(...node.childNodes);
    }
    const renderedText = text.reverse().join('').replace(/\s+/g, ' ').trim();
    return !renderedText || renderedText === window.__wb_ax_name(control).replace(/\s+/g, ' ').trim();
  }
  function unexposedDecoration(node, control) {
    const hidden = node.closest('[aria-hidden="true"]');
    if (!hidden || hidden === control || !control.contains(hidden)) return null;
    const labels = modelLabels(control);
    // An explicitly referenced hidden label still names or describes the
    // control. It cannot be treated as unexposed decorative content.
    if (!labels || labels.some(label => label.node === node || label.node.contains(node))) return false;
    const nodes = [node, ...node.querySelectorAll('*')];
    for (let parent = node.parentElement; parent && parent !== control; parent = parent.parentElement) {
      nodes.push(parent);
      if (nodes.length > 128) return false;
    }
    if (nodes.length > 128) return false;
    return nodes.every(current => !current.shadowRoot
      && current.closest(modelControlSelector) === control && !current.matches(modelEntityIdentitySelector)
      && !current.matches('a,[href],[tabindex],[contenteditable],[aria-labelledby],[aria-describedby],[data-action],[data-target],[data-command],[data-operation]')
      && !current.hasAttribute('xlink:href')
      && (!current.hasAttribute('role') || ['img', 'presentation', 'none'].includes(current.getAttribute('role')))
      && ![...current.attributes].some(attribute => /^on/i.test(attribute.name))
      && !hasDecorativeEventHandler(current));
  }
  function bindCollateralImage(node, addNode, visualImages) {
    const named = ['aria-label', 'aria-labelledby', 'aria-describedby', 'title', 'alt']
      .some(attribute => (attribute !== 'aria-describedby' || !redundantDescriptionBinding(node))
        && node.getAttribute(attribute)?.trim());
    if (!addNode(node, { text: named, fullTextRequired: named })) return false;
    const sources = node.parentElement?.tagName === 'PICTURE' ? [...node.parentElement.querySelectorAll('source')] : [];
    if (sources.length > 8 || sources.some(source => !addNode(source))) return false;
    if (!named && visible(node) && !node.closest('[aria-hidden="true"]')) visualImages?.add(node);
    return true;
  }
  function dialogTextIsCovered(owner, boundTextNodes, addNode, identities, form, namedNavigationControls = null, visualImages = null) {
    const authoredLabel = node => ['aria-label', 'aria-labelledby', 'aria-describedby', 'title', 'alt']
      .some(attribute => (attribute !== 'aria-describedby' || !redundantDescriptionBinding(node))
        && node.getAttribute(attribute)?.trim());
    const readOnlyIdentityDisplay = node => node.matches('[role="textbox"][aria-readonly="true"]')
      && !node.isContentEditable && !node.matches('input,textarea,select,a,button')
      && !node.hasAttribute('onclick') && (!node.hasAttribute('tabindex') || node.tabIndex < 0)
      && !node.querySelector(modelControlSelector)
      && ![...node.querySelectorAll('*')].some(child => child.hasAttribute('onclick') || child.tabIndex >= 0);
    const collectedIdentities = new Set();
    const addIdentity = node => {
      const pending = [node];
      while (pending.length) {
        const current = pending.pop();
        if (collectedIdentities.has(current)) continue;
        if (collectedIdentities.size >= 256 || current.shadowRoot || current.closest('aside,[role="complementary"]')
            || (current.closest('form,[role="form"]') && current.closest('form,[role="form"]') !== form)
            || current.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
            || current.querySelector('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
            || [...current.querySelectorAll(modelControlSelector)].some(control => !boundTextNodes.has(control))
            || !addNode(current, { text: true, fullTextRequired: true })) return false;
        identities.add(current); collectedIdentities.add(current);
        const labels = modelLabels(current);
        if (!labels || labels.length + pending.length + collectedIdentities.size > 256) return false;
        pending.push(...labels.map(label => label.node));
      }
      return true;
    };
    const redundantDescriptions = new Set([...boundTextNodes].map(node => redundantButtonDescription(node)?.node).filter(Boolean));
    const stack = [...owner.childNodes];
    let visited = 0;
    while (stack.length) {
      if (++visited > 256) return false;
      const node = stack.pop();
      if (node.nodeType === 3) {
        if (node.data.trim()) {
          const parent = node.parentElement;
          // Plain recipient/account text needs the same complete observation
          // as authored labels. Do not borrow text from an excluded control,
          // another form/sidebar, or a wrapper containing editable values.
          if (parent !== owner && (parent.closest(modelControlSelector)
              || parent.closest('aside,[role="complementary"]')
              || (parent.closest('form,[role="form"]') && parent.closest('form,[role="form"]') !== form)
              || parent.querySelector('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
              || !addNode(parent, { directText: true }))) return false;
          identities.add(parent);
        }
        continue;
      }
      if (!(node instanceof Element) || ignored(node)) continue;
      if (redundantDescriptions.has(node)) continue; // Only the fully checked duplicate subtree of a bound button.
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.opacity === '0' || style.contentVisibility === 'hidden') continue;
      // A zero-size/display:contents wrapper can still expose destination
      // text. Shadow subtrees have no complete text binding here.
      if (node.shadowRoot) return false;
      if (boundTextNodes.has(node)) continue;
      if (node.matches(modelEntityIdentitySelector) || node.matches(entityOwnerSelector)
          || node.matches(modelControlSelector)) return false;
      // Bind the same plain wrapper before any tooltip appears. Normalizing
      // duplicate text never exempts its original type, identity or focus/state.
      if (ownedNativeButtonWrapper(node) && !addNode(node)) return false;
      // Some composers expose the current account only through its avatar.
      // Bind its original node and selected resource without inventing a name
      // or allowing an image to establish the action's semantic owner.
      if (node instanceof HTMLImageElement && !bindCollateralImage(node, addNode, visualImages)) return false;
      if (authoredLabel(node)) {
        // Account avatars and other authored labels are meaningful context.
        // Bind their complete subtree and expose the current rendered identity
        // in the same model observation rather than silently omitting it.
        if (!addIdentity(node)) return false;
        continue;
      }
      if (visited + stack.length + node.childNodes.length > 256) return false;
      stack.push(...node.childNodes);
    }
    // Raw textContent cannot detect which nested audience label is rendered.
    // Bind descendant semantics for controls and referenced full-text labels,
    // including label roots outside the dialog. Editable descendants keep
    // their existing value continuation instead of acquiring extra bindings.
    for (const root of boundTextNodes) {
      if (!owner.contains(root) && root.matches(modelControlSelector)
          && (!readOnlyIdentityDisplay(root) || !addIdentity(root))) return false;
      // Authored wrappers can conceal nested account labels. Their reference
      // chains are collected when admitted, even for roots already visited.
      const descendants = root.querySelectorAll('*');
      if (root.shadowRoot || descendants.length > 256) return false;
      const redundantDescription = redundantButtonDescription(root)?.node;
      for (const child of descendants) {
        if (redundantDescription && (child === redundantDescription || redundantDescription.contains(child))) continue;
        if (ignored(child)) continue;
        const decoration = unexposedDecoration(child, root);
        if (decoration !== false && modelHit(root, root, child) === root && child instanceof SVGElement) continue;
        if (decoration !== null) {
          // Keep exact hidden semantics bound. Hidden controls, identities or
          // native event handlers cannot gain a decorative exemption, even
          // when they have no authored label of their own.
          if (!decoration || (!namedNavigationControls?.has(root) && !addNode(child))) return false;
          continue;
        }
        const readOnlyDisplay = readOnlyIdentityDisplay(child);
        if (child.shadowRoot || ((child.matches(modelEntityIdentitySelector) || child.matches(entityOwnerSelector)
            || child.matches(modelControlSelector)) && !boundTextNodes.has(child) && !readOnlyDisplay)) return false;
        // An ARIA textbox can be a read-only destination display. Only real
        // editable DOM hosts need the native value-continuation exemption.
        if (!child.isContentEditable && !child.closest('input,textarea,select')) {
          const style = getComputedStyle(child);
          if ((authoredLabel(child) || readOnlyDisplay) && style.display !== 'none' && style.opacity !== '0' && style.contentVisibility !== 'hidden') {
            if (!addIdentity(child)) return false;
          } else if (!namedNavigationControls?.has(root) && !addNode(child)) return false;
        }
      }
    }
    return true;
  }
  function readonlyPreparationMatches(snapshot, target = snapshot?.target, owner = snapshot?.owner) {
    if (!snapshot || snapshot.schema !== 'webbrain.readonly-identity-preparation/1' || snapshot.readonly !== true
        || typeof owner !== 'string' || !owner || owner.length > 1000 || snapshot.owner !== owner
        || typeof snapshot.token !== 'string' || !snapshot.token || snapshot.token.length > 100
        || typeof snapshot.documentToken !== 'string' || !snapshot.documentToken || snapshot.documentToken.length > 100
        || typeof snapshot.phase !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(snapshot.phase)
        || typeof snapshot.signature !== 'string' || snapshot.signature.length > 8192
        || !Array.isArray(snapshot.allowedTools) || snapshot.allowedTools.length !== 1 || snapshot.allowedTools[0] !== 'click_ax'
        || !Array.isArray(snapshot.nodes) || !snapshot.nodes.length || snapshot.nodes.length > 32
        || !Array.isArray(snapshot.identities) || !snapshot.identities.length || snapshot.identities.length > 8
        || snapshot.target !== target || !(target instanceof Element)
        || !(snapshot.action instanceof Element) || !(snapshot.scope instanceof Element)
        || snapshot.scope === document.body || snapshot.scope === document.documentElement
        || snapshot.action.parentElement !== snapshot.scope
        || !(snapshot.action === target || snapshot.action.contains(target))
        || !snapshot.nodes.includes(target) || !snapshot.nodes.includes(snapshot.action)
        || snapshot.identities.some(node => !snapshot.nodes.includes(node))) return false;
    const nodes = [target, snapshot.action, snapshot.scope, ...snapshot.nodes, ...snapshot.identities];
    if (nodes.some(node => !(node instanceof Element) || node.ownerDocument !== document || !node.isConnected || !visible(node))
        || target.closest('form,[role="form"],footer,input,textarea,select,[contenteditable]:not([contenteditable="false"])')
        || snapshot.action.form || snapshot.action.hasAttribute('href')
        || snapshot.action.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[type="submit"],[type="image"]')
        || !['', 'button'].includes(snapshot.action.getAttribute('role') || '')) return false;
    try { return window.__wb_readonly_identity_preparation_matches?.(snapshot) === true; }
    catch { return false; }
  }
  function nativeInlinePostOwner(action) {
    // X's home composer has no form, dialog or page-purpose heading. Its
    // native editor/publish pair and matching local/navigation account links
    // establish a bounded owner; the live timeline never becomes its context.
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(location.hostname)
        || !/^\/home\/?$/.test(location.pathname)
        || action.closest('form,[role="form"],'+entityOwnerSelector)) return null;
    const main = action.closest('main,[role="main"]');
    if (!main || [...document.querySelectorAll('main,[role="main"]')].filter(visible).length !== 1) return null;
    const rendered = node => {
      if (!visible(node)) return false;
      for (let current = node; current; current = bindingParent(current)) {
        const style = getComputedStyle(current);
        if (current.inert || current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true'
            || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
            || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
      }
      return true;
    };
    const accountKey = link => {
      if (!(link instanceof HTMLAnchorElement) || !rendered(link)) return '';
      try {
        const url = new URL(link.getAttribute('href') || '', location.href);
        const handle = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1] || '';
        return url.origin === location.origin && !url.search && !url.hash && !url.username && !url.password
          && handle && !/^(home|explore|notifications|messages|search|settings|compose|i)$/i.test(handle)
          ? handle.toLowerCase() : '';
      } catch { return ''; }
    };
    const navigationLinks = [...document.querySelectorAll('a[data-testid="AppTabBar_Profile_Link"][href]')]
      .filter(link => rendered(link) && link.closest('nav,[role="navigation"]'));
    if (navigationLinks.length !== 1 || !accountKey(navigationLinks[0])) return null;
    for (let owner = bindingParent(action), depth = 0; owner && owner !== main && depth < 32;
      owner = bindingParent(owner), depth++) {
      if (owner === document.body || owner === document.documentElement || owner.shadowRoot
          || owner.matches('form,[role="form"],'+entityOwnerSelector)) return null;
      const descendants = owner.querySelectorAll('*');
      if (descendants.length > 256 || owner.querySelectorAll(modelControlSelector).length > 64) return null;
      const editors = [...owner.querySelectorAll('[contenteditable]:not([contenteditable="false"]),input:not([type="hidden"]):not([type="file"]),textarea')];
      const publishers = [...owner.querySelectorAll('[data-testid="tweetButtonInline"]')];
      if (!editors.length || !publishers.length) continue;
      const editor = editors[0], publisher = publishers[0];
      if (editors.length !== 1 || publishers.length !== 1 || !editor.isContentEditable
          || editor.getAttribute('role') !== 'textbox' || editor.getAttribute('data-testid') !== 'tweetTextarea_0'
          || publisher.tagName !== 'BUTTON' || publisher.type !== 'button' || publisher.form
          || !rendered(editor) || !rendered(publisher)) return null;
      const accountLinks = [...owner.querySelectorAll('a[href]')].filter(link => accountKey(link));
      if (!accountLinks.length) continue;
      if (accountLinks.length !== 1 || accountKey(accountLinks[0]) !== accountKey(navigationLinks[0])) return null;
      return { owner, editor, publisher, accountLinks: [accountLinks[0], navigationLinks[0]] };
    }
    return null;
  }
  function mainActionOwner(action) {
    const main = action.closest('main,[role="main"]');
    if (!main || main === action || main === document.body || main === document.documentElement || !visible(main)) return null;
    const mains = document.querySelectorAll('main,[role="main"]');
    if (mains.length > 64 || [...mains].some(other => other !== main && visible(other))) return null;
    // A native primary landmark can own a form-less page action. Walk a
    // bounded page, rather than requiring every passive descendant to fit
    // the tiny-editor fallback. All current material controls remain bound.
    const nodes = [], walker = document.createTreeWalker(main, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (nodes.length >= 2048) return null;
      nodes.push(node);
    }
    const local = node => node.closest('main,[role="main"]') === main
      && !node.closest('aside,nav,[role="navigation"],[role="complementary"]');
    const activeNode = (node, structuralFile = false) => {
      for (let current = structuralFile ? bindingParent(node) : node; current && current !== main; current = bindingParent(current)) {
        const style = getComputedStyle(current);
        if (current.inert || current.getAttribute('aria-hidden') === 'true' || style.display === 'none'
            || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
      }
      return true;
    };
    const headings = nodes.filter(node => local(node) && visible(node) && activeNode(node)
      && node.matches('h1,h2,h3,h4,h5,h6,[role="heading"],[aria-current]'));
    const controls = nodes.filter(node => local(node) && node.matches(modelControlSelector)
      && activeNode(node, node.matches('input[type="file"]')));
    const identities = nodes.filter(node => local(node) && visible(node) && activeNode(node) && node.matches(modelEntityIdentitySelector));
    const owners = nodes.filter(node => local(node) && activeNode(node) && node.matches(entityOwnerSelector + ',form,[role="form"]'));
    // A main heading already supplies ownership. Its own account imagery is
    // still material collateral; another entity, feed item, form or navigation
    // must not turn all page imagery into the action's current account proof.
    const images = nodes.filter(node => node instanceof HTMLImageElement && local(node) && activeNode(node)
      && !node.closest(entityOwnerSelector + ',form,[role="form"],input,textarea,[contenteditable]:not([contenteditable="false"])'));
    const ownedHeadings = headings.filter(node => !action.contains(node)
      && !node.closest(entityOwnerSelector + ',form,[role="form"]'));
    const primary = ownedHeadings.filter(node => node.matches('h1,[role="heading"][aria-level="1"]'));
    const purpose = primary.length ? primary : ownedHeadings;
    if (purpose.length !== 1 || !purpose[0].textContent.trim() || headings.length > 32
        || controls.length > 64 || identities.length > 64 || owners.length > 64 || images.length > 64) return null;
    return { main, headings, controls, identities, owners, images };
  }
  function actionFootprint(target, readonlyPreparation = null) {
    if (readonlyPreparation && !readonlyPreparationMatches(readonlyPreparation, target)) return null;
    const structuralFile = target instanceof Element && target.tagName === 'INPUT' && target.type === 'file';
    if (!(target instanceof Element) || target.ownerDocument !== document || !target.isConnected
        || (!structuralFile && !visible(target)) || ignored(target)) return null;
    for (let node = target; node; node = bindingParent(node)) {
      const root = node.getRootNode();
      if (root instanceof ShadowRoot && root.mode !== 'open') return null;
    }
    const action = readonlyPreparation?.action || (target.matches(modelControlSelector) ? target : target.closest(modelControlSelector));
    if (!action || (!structuralFile && !visible(action))) return null;
    const form = action.form || target.closest('form,[role="form"]');
    const ownerBase = form || action;
    const conversation = currentConversationContext(target);
    if (conversation && form && !conversation.footer.contains(form)) return null;
    let owner = readonlyPreparation?.scope || conversation?.pane || (ownerBase.matches(entityOwnerSelector) ? ownerBase : ownerBase.closest(entityOwnerSelector));
    const namedSemanticScope = node => {
      if (!(node instanceof Element) || node === action || node.matches(modelControlSelector)
          || !node.matches('form,[role="form"],section,[role="region"]')) return false;
      if (String(node.getAttribute('aria-label') || '').trim()) return true;
      const ids = (node.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
      const labels = ids.length ? modelLabels(node) : null;
      // A dangling reference must not borrow a name from contained draft or
      // button text. Exact, complete current associated labels are observed
      // separately before this semantic scope can certify an action.
      return !!labels && ids.every(id => labels.some(label => label.node.id === id))
        && labels.some(label => ids.includes(label.node.id) && String(window.__wb_ax_name?.(label.node) || label.node.textContent || '').trim());
    };
    if (!owner && !conversation && !readonlyPreparation) {
      const semanticScope = form || action.closest('section,[role="form"]');
      if (namedSemanticScope(semanticScope)) owner = semanticScope;
    }
    let navigationOwner = false;
    let nativeFileSection = null;
    let mainOwner = null;
    let inlinePostOwner = null;
    if (!owner && !form && !conversation && !structuralFile) {
      inlinePostOwner = nativeInlinePostOwner(action);
      if (inlinePostOwner) owner = inlinePostOwner.owner;
    }
    if (!owner && !form && !conversation) {
      const section = action.closest('section'), purpose = window.__wb_ax_section_purpose?.(section);
      if (section && purpose && section.querySelectorAll('*').length <= 256
          && section.querySelectorAll(modelControlSelector).length <= 64) {
        const files = [...section.querySelectorAll('input[type="file"]')];
        const sections = [...document.querySelectorAll('section')];
        const distinctPurpose = sections.length <= 64 && !sections.some(other => other !== section
          && other.querySelector('input[type="file"]') && window.__wb_ax_section_purpose?.(other)?.text === purpose.text);
        if (files.length === 1 && !files[0].disabled && !files[0].closest('fieldset[disabled]') && distinctPurpose) {
          owner = section; nativeFileSection = purpose;
        }
      }
    }
    if (!owner && !form) {
      const navigation = action.closest(navigationOwnerSelector);
      // These are actual local landmarks, not an arbitrary control relabeled
      // as its own owner. They require complete observed context below.
      if (navigation && navigation !== action) { owner = navigation; navigationOwner = true; }
    }
    if (!owner && !form && !conversation && !structuralFile) {
      mainOwner = mainActionOwner(action);
      if (mainOwner) owner = mainOwner.main;
    }
    let unstructuredOwner = false;
    let meaningfulOwner = !!conversation || !!readonlyPreparation;
    if (!owner && form && [...form.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],'+modelEntityIdentitySelector)]
      .some(node => node.closest('form,[role="form"]') === form && !node.closest(entityOwnerSelector)
        && !node.closest('aside,nav,[role="navigation"],[role="complementary"]'))) owner = form;
    if (!owner) {
      // A tiny toolbar is not a composer owner. Find the bounded container
      // that includes its editor and action, with a heading outside the form
      // when one is present. Otherwise retain the conservative heading fence.
      let parent = bindingParent(ownerBase), fallback = null;
      for (let depth = 0; parent && depth < 6 && parent !== document.body && parent !== document.documentElement;
        depth++, parent = bindingParent(parent)) {
        if (parent.querySelectorAll('*').length > 256 || parent.querySelectorAll(modelControlSelector).length > 64) break;
        const editor = parent.querySelector('input:not([type="file"]):not([type="hidden"]),textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
        if (!form && !editor) continue;
        if (form && parent.querySelectorAll('form,[role="form"]').length > 1) break;
        fallback ||= parent;
        const outsideHeading = [...parent.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
          .some(node => !node.closest('form,[role="form"]') && !node.closest('aside,nav,[role="navigation"],[role="complementary"]'));
        if (outsideHeading) { owner = parent; unstructuredOwner = true; meaningfulOwner = true; break; }
      }
      if (!owner) { owner = fallback; unstructuredOwner = true; }
    }
    if (!owner && form && [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
      .some(node => visible(node) && !node.closest('form,[role="form"],'+entityOwnerSelector)
        && !node.closest('aside,nav,[role="navigation"],[role="complementary"]'))) {
      // Ordinary forms often sit directly below a page heading without a
      // wrapper/region. Bind the form and its controls, plus every heading
      // below, instead of including unrelated body counters in its owner.
      owner = form; unstructuredOwner = true; meaningfulOwner = true;
    }
    const nodes = [], ancestors = [], boundTextNodes = new Set(), dialogIdentities = new Set(), namedNavigationControls = new Set(), visualImages = new Set();
    let uncoveredLabel = false;
    const addNode = (node, options = {}) => {
      const previous = nodes.find(item => item.node === node);
      if (previous) {
        // A form/owner may already have an attribute-only binding. Plain
        // destination text must strengthen it without aggregating editor data
        // or downgrading an existing complete label/control binding.
        if (options.directText && !boundTextNodes.has(node)) previous.value = modelSemantic(node, { directText: true });
        return !options.fullTextRequired || boundTextNodes.has(node);
      }
      if (nodes.length >= 256 || (node.tagName === 'INPUT' && node.type === 'file' && node.files?.length > 32)) return false;
      if (node instanceof HTMLImageElement && [node.currentSrc, node.getAttribute('src'), node.getAttribute('srcset'), node.getAttribute('sizes')]
        .some(value => String(value || '').length > 8192)) return false;
      const labels = modelLabels(node);
      if (!labels) return false;
      nodes.push({ node, value: modelSemantic(node, options),
        ...(node.tagName === 'INPUT' && node.type === 'file' ? { files: [...node.files || []] } : {}) });
      if (options.text) boundTextNodes.add(node);
      for (const label of labels) {
        if (nodes.length >= 256) return false;
        if (!nodes.some(item => item.node === label.node)) {
          nodes.push(label); boundTextNodes.add(label.node);
        } else if (!boundTextNodes.has(label.node)) uncoveredLabel = true;
      }
      return true;
    };
    if (!addNode(target, { text: true, control: true, observedName: !structuralFile, structuralFile })
        || !addNode(action, { text: true, control: true, observedName: !structuralFile, structuralFile })) return null;
    for (let ancestor = bindingParent(target); ancestor; ancestor = bindingParent(ancestor)) {
      if (ancestors.length >= 64) return null;
      const labels = modelLabels(ancestor);
      if (!labels) return null;
      const style = getComputedStyle(ancestor);
      if (ancestor.inert || ancestor.getAttribute('aria-hidden') === 'true' || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
          || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return null;
      ancestors.push({ node: ancestor, value: modelSemantic(ancestor) });
      for (const label of labels) if (!addNode(label.node, { text: true })) return null;
    }
    if (form) {
      if (!addNode(form)) return null;
      const controls = form.elements ? [...form.elements] : [...form.querySelectorAll(modelControlSelector)];
      for (const control of controls) if (!addNode(control, { text: true, control: true })) return null;
    }
    if (readonlyPreparation) {
      // An adapter may prove a read-only identity-preparation control outside
      // an ordinary semantic landmark. Bind its original current pins and
      // expose its actual identities; no model flag or button name is proof.
      if (!addNode(owner)) return null;
      for (const node of readonlyPreparation.nodes) if (!addNode(node,
        readonlyPreparation.identities.includes(node) ? { text: true } : {})) return null;
      for (const node of readonlyPreparation.identities) dialogIdentities.add(node);
    } else if (conversation) {
      // Reuse the recipient guard's exact local conversation proof. Its
      // matcher is re-run for every comparison; history and sidebar controls
      // are outside this footprint, including when their counters update.
      for (const node of new Set([conversation.carrier, conversation.header, conversation.pane,
        conversation.footer, conversation.composer, ...conversation.contextNodes])) {
        if (!addNode(node, node === conversation.carrier || node === conversation.composer
          ? { text: true, control: true, observedName: true } : {})) return null;
      }
      for (const node of conversation.labelledByNodes) if (!addNode(node, { text: true })) return null;
      const controls = conversation.footer.querySelectorAll(modelControlSelector);
      if (controls.length > 64) return null;
      for (const control of controls) if (!addNode(control, { text: true, control: true })) return null;
    } else if (mainOwner) {
      if (!addNode(owner, { directText: true })) return null;
      for (const node of mainOwner.owners) if (!addNode(node, { directText: true })) return null;
      for (const node of mainOwner.headings) if (!addNode(node, { text: true })) return null;
      for (const node of mainOwner.identities) if (!addNode(node, { text: true, control: true })) return null;
      for (const node of mainOwner.controls) if (!addNode(node, { text: true, control: true })) return null;
      for (const image of mainOwner.images) {
        if (!bindCollateralImage(image, addNode, visualImages)) return null;
        if (boundTextNodes.has(image)) {
          dialogIdentities.add(image);
          for (const label of modelLabels(image) || []) dialogIdentities.add(label.node);
        }
      }
      meaningfulOwner = !uncoveredLabel;
    } else if (owner) {
      if (!addNode(owner, { directText: true })) return null;
      if (nativeFileSection) {
        if (!addNode(nativeFileSection.node, { text: true })) return null;
        dialogIdentities.add(nativeFileSection.node);
      }
      const belongs = (node, allowNavigation = false) => {
        const closest = node.closest(entityOwnerSelector);
        const relatedForm = node.closest('form,[role="form"]');
        return (!closest || closest === owner || closest.contains(owner))
          && (!relatedForm || relatedForm === form)
          && !node.closest(allowNavigation === true || inlinePostOwner ? 'aside,[role="complementary"]'
            : 'aside,nav,[role="navigation"],[role="complementary"]');
      };
      const headings = [...owner.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],[aria-current]')]
        .filter(node => belongs(node, navigationOwner));
      if (headings.length > 32) return null;
      for (const heading of headings) if (!addNode(heading, { text: true })) return null;
      const identities = [...owner.querySelectorAll(modelEntityIdentitySelector)].filter(node => belongs(node, navigationOwner));
      if (identities.length > 64) return null;
      for (const identity of identities) if (!addNode(identity, { text: true, control: true })) return null;
      meaningfulOwner ||= headings.length > 0 || identities.length > 0 || owner.matches(modelEntityIdentitySelector);
      if (meaningfulOwner) {
        const images = [...owner.querySelectorAll('img')].filter(node => belongs(node, navigationOwner)
          && !node.closest('input,textarea,[contenteditable]:not([contenteditable="false"])')
          && visible(node));
        if (images.length > 64) return null;
        for (const image of images) {
          if (!bindCollateralImage(image, addNode, visualImages)) return null;
          if (boundTextNodes.has(image)) {
            dialogIdentities.add(image);
            for (const label of modelLabels(image) || []) dialogIdentities.add(label.node);
          }
        }
      }
      // Recipients and attachment/caption editors may live next to the form.
      // Bind every local control, excluding a separate entity, form or sidebar.
      const headingFreeDialog = !meaningfulOwner && owner.matches('dialog,[role="dialog"],[role="alertdialog"]');
      const headingFreeNamedScope = !meaningfulOwner && namedSemanticScope(owner);
      for (const control of owner.querySelectorAll(modelControlSelector)) {
        if (!belongs(control, headingFreeDialog || headingFreeNamedScope || navigationOwner)) continue;
        // Other authored navigation names stay bound exactly as observed.
        // Their non-name badge/icon text does not become account identity.
        // The target, selected items, fields and declared entities retain
        // their full text/value bindings; all outside control text is covered.
        const nameOnly = navigationOwner && control !== action && !control.contains(target)
          && !control.matches('input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),[aria-current],[aria-selected],[aria-pressed],[data-selected],'+modelEntityIdentitySelector)
          && !!(control.getAttribute('aria-label') || control.getAttribute('aria-labelledby') || control.getAttribute('title'))
          && navigationTextMatchesName(control);
        if (!addNode(control, { text: true, control: true, observedName: nameOnly, nameOnly })) return null;
        if (nameOnly) namedNavigationControls.add(control);
      }
      // A heading-free dialog can supply a boundary when all local labels,
      // text and controls are bound and identities are completely observed.
      if (headingFreeNamedScope) {
        dialogIdentities.add(owner);
        for (const label of modelLabels(owner) || []) dialogIdentities.add(label.node);
      }
      if (inlinePostOwner) {
        meaningfulOwner = dialogTextIsCovered(owner, boundTextNodes, addNode, dialogIdentities, form, null, visualImages) && !uncoveredLabel;
        // Bind the external signed-in identity only after the complete local
        // coverage check; unrelated navigation controls are not composer data.
        for (const link of inlinePostOwner.accountLinks) if (!addNode(link, { text: true, control: true })) return null;
      } else if (navigationOwner) meaningfulOwner = dialogTextIsCovered(owner, boundTextNodes, addNode, dialogIdentities, form, namedNavigationControls, visualImages) && !uncoveredLabel;
      else if (nativeFileSection) meaningfulOwner = dialogTextIsCovered(owner, boundTextNodes, addNode, dialogIdentities, form, null, visualImages) && !uncoveredLabel;
      else meaningfulOwner ||= (headingFreeDialog || headingFreeNamedScope)
        && dialogTextIsCovered(owner, boundTextNodes, addNode, dialogIdentities, form, null, visualImages) && !uncoveredLabel;
    }
    // An arbitrary container/toolbar with no entity anchor cannot establish
    // the recipient or item. Such targets retain strict legacy dispatch only.
    if (!owner || !meaningfulOwner) return null;
    if (!conversation && (!owner || unstructuredOwner || nativeFileSection)) {
      // Without an explicit entity boundary, an outside conversation heading
      // may identify the recipient. Never infer that a small form/toolbar owns
      // it; broad heading binding is a conservative fallback for these pages.
      const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],[aria-current]');
      if (headings.length > 64) return null;
      for (const heading of headings) if (!addNode(heading, { text: true })) return null;
    }
    const rect = structuralFile ? null : target.getBoundingClientRect();
    const rawHit = structuralFile ? null : deepElementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!structuralFile && (!rawHit || !(target === rawHit || target.contains(rawHit) || (action.contains(target) && action.contains(rawHit))))) return null;
    const hit = structuralFile ? null : modelHit(target, action, rawHit);
    return { model: true, structuralFile, target, scope: owner || form || action, ancestors, nodes, hit,
      dialogIdentities,
      visualImages,
      ...(inlinePostOwner ? { observedAccountLinks: inlinePostOwner.accountLinks } : {}),
      ...(mainOwner ? { observedMainControls: mainOwner.controls.filter(node => visible(node)) } : {}),
      ...(conversation ? { conversationCarrier: conversation.carrier, conversationComposer: conversation.composer } : {}),
      context: JSON.stringify([location.href, document.baseURI, currentViewport(), window.scrollX, window.scrollY,
        rect ? [rect.left, rect.top, rect.width, rect.height] : null,
        ...(conversation ? [[conversation.signature, conversation.aliases]] : []),
        ...(readonlyPreparation ? [[readonlyPreparation.owner, readonlyPreparation.token,
          readonlyPreparation.phase, readonlyPreparation.signature]] : [])]),
      ...(readonlyPreparation ? { readonlyPreparation } : {}) };
  }
  function operationBinding(op, target = op?.preparedBinding?.target) {
    return op?.preparedBinding?.model === true ? actionFootprint(target, op.preparedBinding.readonlyPreparation) : preparedBinding(target);
  }
  function inputContinuationValue(item, target) {
    if (item.node !== target) return item.value;
    const value = JSON.parse(item.value);
    if (value[11]) {
      const state = JSON.parse(value[11]);
      // Native input can change the selected value and validity of its own
      // field. Names, default values, disabled/read-only state and recipients
      // remain part of the immutable context.
      for (const index of [1, 3, 4, 8, 9]) state[index] = null;
      value[11] = JSON.stringify(state);
    }
    value[12] = null;
    if (target.isContentEditable) { value[9] = null; value[13] = null; }
    return JSON.stringify(value);
  }
  function inputContinuationBindingMatches(op, after) {
    const before = op?.preparedBinding;
    if (!op?.dispatched || op.kind !== 'input' || before?.model !== true || !after
        || before.target !== after.target || before.scope !== after.scope || before.hit !== after.hit || before.context !== after.context) return false;
    return ['ancestors', 'nodes'].every(key => before[key].length === after[key].length
      && before[key].every((item, index) => {
        const current = after[key][index];
        return item.node === current.node
          && (key === 'nodes' ? inputContinuationValue(item, before.target) === inputContinuationValue(current, before.target) : item.value === current.value)
          && (!item.files || (item.files.length === current.files?.length && item.files.every((file, fileIndex) => file === current.files[fileIndex])));
      }));
  }
  function operationBindingMatches(op, target = op?.preparedBinding?.target) {
    const current = operationBinding(op, target);
    return samePreparedBinding(op?.preparedBinding, current) || inputContinuationBindingMatches(op, current);
  }
  function modelTarget(params = {}) {
    if (!modelActionTools.has(params.tool) || Number.isFinite(params.x) || Number.isFinite(params.y)
        || (params.frameId != null && Number(params.frameId) !== 0)) return null;
    const focused = !params.ref_id && !params.selector && !params.nativeTarget && !params.textMatch
      && modelFocusTools.has(params.tool);
    const resolved = focused ? deepActiveElement()
      : resolveTarget({ ...params, textMatch: params.textMatch || (params.tool === 'click' ? params.text : undefined) });
    if (!(resolved instanceof Element)) return null;
    if (params.selector) {
      try { const query = queryOpenTargets(params.selector); if (!query.complete || query.elements.length !== 1 || query.elements[0] !== resolved) return null; }
      catch { return null; }
    }
    if (!focused && !params.ref_id && !params.selector && !params.nativeTarget && !params.textMatch
        && !(params.tool === 'click' && params.text)) return null;
    return resolved;
  }
  function modelCandidateIdentity(target) {
    // The uncertified fallback preserves original node identity without
    // retaining arbitrarily large page subtrees during the bounded scan.
    const value = /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(target.tagName) ? target.value : null;
    if (target.attributes.length > 64 || sampleDescendants(target, 64).exceeded
        || target.textContent.length > 8192 || String(value || '').length > 8192
        || [...target.attributes].some(attribute => attribute.value.length > 8192)) return null;
    const identity = JSON.stringify([target.tagName, [...target.attributes].map(attribute => [attribute.name, attribute.value])
      .sort(([left], [right]) => left.localeCompare(right)), target.textContent,
      value]);
    return { value: identity, parent: bindingParent(target), form: target.form || target.closest('form,[role="form"]') };
  }
  function modelBindingResult(params = {}) {
    const snapshot = modelSnapshots.get(params.snapshotToken || params.expectedModelSnapshot);
    if (!active || !snapshot || snapshot.until < Date.now() || snapshot.runToken !== runToken
        || params.runToken !== runToken || snapshot.interventionRevision !== interventionRevision
        || snapshot.userAt !== lastUserAt || interventionUnreported || (pendingDOM && pendingDOM.source !== 'page')) return {};
    const target = modelTarget(params);
    if (!target) return params.ref_id && snapshot.refs.has(params.ref_id) ? {} : { reason: 'target_unresolved' };
    const before = snapshot.targets.get(target), previous = snapshot.uncertified.get(target);
    if (!before && !previous) return { reason: 'target_uncovered' };
    if (params.ref_id && snapshot.hasRefs && snapshot.refs.get(params.ref_id) !== target) return {};
    if (!params.ref_id && !params.selector && !params.nativeTarget && !params.textMatch && modelFocusTools.has(params.tool)
        && snapshot.focusTarget !== target) return {};
    if (before?.readonlyPreparation && params.tool !== 'click_ax') return {};
    if (before) return samePreparedBinding(before, actionFootprint(target, before.readonlyPreparation)) ? { binding: before } : {};
    const current = modelCandidateIdentity(target);
    return current && previous.value === current.value && previous.parent === current.parent && previous.form === current.form
      ? { uncertified: true } : {};
  }
  function modelBinding(params = {}) {
    return modelBindingResult(params).binding || null;
  }
  function captureModel(params = {}) {
    if (!active || params.runToken !== runToken) return { ready: false, runToken, documentToken };
    flushPendingMutations(); sampleFormControls();
    const authority = Object.freeze({ runToken, documentToken, owner: params.nativeChatOwner,
      userAt: lastUserAt, interventionRevision });
    identityPreparationCapture = authority;
    try { return captureCurrentModel(params, authority); }
    finally { if (identityPreparationCapture === authority) identityPreparationCapture = null; }
  }
  function currentIdentityPreparationCapture(authority, owner) {
    return !!authority && authority === identityPreparationCapture && active && !disposed
      && authority.runToken === runToken && authority.documentToken === documentToken
      && authority.userAt === lastUserAt && authority.interventionRevision === interventionRevision
      && typeof owner === 'string' && owner.length > 0 && owner.length <= 1000 && authority.owner === owner;
  }
  function captureCurrentModel(params, authority) {
    let readonlyPreparation = null;
    if (typeof params.nativeChatOwner === 'string' && params.nativeChatOwner.length <= 1000) {
      try {
        const candidate = window.__wb_get_readonly_identity_preparation?.(params.nativeChatOwner, null, authority);
        if (readonlyPreparationMatches(candidate, candidate?.target, params.nativeChatOwner)) readonlyPreparation = candidate;
      } catch { /* Unsupported adapters retain the ordinary certificate. */ }
    }
    const nativeReadTarget = typeof params.nativeChatOwner === 'string' && params.nativeChatOwner.length <= 1000
      ? window.__wb_native_chat_read_target?.(params.nativeChatOwner) : null;
    const priorityTarget = readonlyPreparation?.target || nativeReadTarget?.target || (params.actionTarget && typeof params.actionTarget === 'object'
      ? modelTarget(params.actionTarget) : null);
    const observationRoot = /^ref_[A-Za-z0-9_-]+$/.test(params.observationRef || '')
      ? window.__wb_ax_lookup?.(params.observationRef) : null;
    const validObservationRoot = observationRoot instanceof Element && observationRoot.ownerDocument === document
      && observationRoot.isConnected && window.__wb_ax_lookup?.(params.observationRef) === observationRoot;
    let page, observationScopeCaptured = false;
    const observedRefs = [];
    if (params.includeTree === true) {
      try {
        if (typeof window.__generateAccessibilityTree !== 'function') throw new Error('unavailable');
        const boundedTreeText = (tree, limit, offset = 0) => {
          const content = tree.pageContent, suffix = '\n[observation truncated]';
          const end = content.length <= limit ? content.length : Math.max(0, content.lastIndexOf('\n', limit - suffix.length));
          // Trust only complete formatter-owned units retained in this exact
          // prefix, never bracket tokens inside page-controlled text fields.
          for (const record of window.__wb_ax_observed_refs?.(tree, end) || [])
            observedRefs.push({ ref: record.ref, end: offset + record.end });
          return content.length <= limit ? content : content.slice(0, end) + suffix;
        };
        // Reserve space for the requested owner's current identity evidence.
        // AX omits some visible generic wrappers (for example recipient chips).
        const contextual = priorityTarget || validObservationRoot;
        const tree = window.__generateAccessibilityTree('visible', 15, contextual ? 4000 : 6000);
        if (!tree || tree.error || typeof tree.pageContent !== 'string') throw new Error('unavailable');
        page = { success: true, ...tree, pageContent: boundedTreeText(tree, contextual ? 4000 : 6000), url: location.href };
        if (validObservationRoot) {
          const scoped = window.__generateAccessibilityTree('visible', 15, priorityTarget ? 3000 : 6000, params.observationRef);
          if (scoped && !scoped.error && typeof scoped.pageContent === 'string') {
            const prefix = '\n\n[CURRENT REQUESTED OBSERVATION SCOPE]\n';
            page.pageContent += prefix + boundedTreeText(scoped, priorityTarget ? 3000 : 6000, page.pageContent.length + prefix.length);
            observationScopeCaptured = true;
          }
        }
        if (priorityTarget) {
          const scope = actionFootprint(priorityTarget, readonlyPreparation)?.scope || priorityTarget.closest(entityOwnerSelector) || priorityTarget;
          const scopeRef = window.__wb_ax_ref?.(scope);
          if (!scopeRef) throw new Error('unavailable');
          const scoped = window.__generateAccessibilityTree('visible', 15, scope === priorityTarget ? 4000 : 3000, scopeRef);
          if (!scoped || scoped.error || typeof scoped.pageContent !== 'string') throw new Error('unavailable');
          const prefix = '\n\n[CURRENT REQUESTED ACTION CONTEXT]\n';
          page.pageContent += prefix + boundedTreeText(scoped, scope === priorityTarget ? 4000 : 3000, page.pageContent.length + prefix.length);
          if (scope !== priorityTarget) {
            const targetRef = window.__wb_ax_ref?.(priorityTarget);
            if (!targetRef) throw new Error('unavailable');
            const targetTree = window.__generateAccessibilityTree('visible', 15, 1000, targetRef);
            // Hidden file controls can have a structural certificate while
            // their visible owner is the only AX observation available.
            if (!targetTree?.error && typeof targetTree?.pageContent === 'string') {
              const targetPrefix = '\n[CURRENT EXACT ACTION TARGET]\n';
              page.pageContent += targetPrefix + boundedTreeText(targetTree, 1000, page.pageContent.length + targetPrefix.length);
            }
          }
        }
        // The Agent sends this complete object through its 16k serializer.
        // Fit it before interpreting printed refs, never after certification.
        while (JSON.stringify(page).length > 16000 && page.pageContent.includes('\n')) {
          page.pageContent = page.pageContent.slice(0, page.pageContent.lastIndexOf('\n'));
        }
        if (JSON.stringify(page).length > 16000) throw new Error('observation too large');
      } catch { return { ready: false, runToken, documentToken, reason: 'observation_unavailable' }; }
    }
    const targets = new Map(), uncertified = new WeakMap(), refs = new Map(), seen = new Set(), publicNodes = new Set();
    if (page) for (const { ref, end } of observedRefs) {
      if (end > page.pageContent.length) continue;
      const node = window.__wb_ax_lookup?.(ref);
      if (node instanceof Element) { refs.set(ref, node); publicNodes.add(node); }
    }
    let evidenceLength = 0;
    const exposedEditableNames = new WeakMap();
    const exposedCompleteLabels = new WeakSet();
    const collateralMainControls = new WeakSet();
    let collateralHeaderExposed = false;
    const exposeIdentity = (node, { authoredEditableName = false, completeLabel = false, accountLink = false } = {}) => {
      if (publicNodes.has(node) && !authoredEditableName && !completeLabel && !accountLink) return true;
      if (completeLabel && exposedCompleteLabels.has(node)) return true;
      // Emit only current rendered page labels. Editable contents, input
      // values, data identities and private control/file state stay private.
      if (!visible(node) || (!authoredEditableName && node.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))
          || node.closest('[aria-hidden="true"]')) return false;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const parts = [];
      let visited = 0, textNode;
      while (!authoredEditableName && (textNode = walker.nextNode())) {
        if (visited++ >= 128) return false;
        const parent = textNode.parentElement;
        if (parent && visible(parent) && !ignored(parent) && !parent.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[aria-hidden="true"]')) {
          const part = textNode.data.replace(/\s+/g, ' ').trim();
          if (part) parts.push(part);
          if (parts.join(' ').length > 512) return false;
        }
      }
      const rendered = parts.join(' ');
      const authored = String(node.getAttribute('aria-label') || node.getAttribute('title')
        || (authoredEditableName ? node.getAttribute('placeholder') : node.getAttribute('alt')) || '')
        .replace(/\s+/g, ' ').trim();
      // A reference-only carrier may have no own text. Its full referenced
      // labels are exposed separately before the footprint is certified.
      const referencedName = completeLabel && node.getAttribute('aria-labelledby')
        ? String(window.__wb_ax_name?.(node) || '').replace(/\s+/g, ' ').trim() : '';
      const name = accountLink ? new URL(node.getAttribute('href'), location.href).href : authored || rendered || referencedName;
      if (!name || authored.length > 512) return false;
      if (authoredEditableName && exposedEditableNames.get(node) === authored) return true;
      const ref = window.__wb_ax_ref?.(node);
      if (!ref || window.__wb_ax_lookup?.(ref) !== node) return false;
      const header = evidenceLength ? '' : '\n\n[CURRENT VISIBLE ACTION IDENTITY]\n';
      const line = header + `visible identity ${JSON.stringify(name)} [${ref}]`
        + (authored && rendered && authored !== rendered ? ` text=${JSON.stringify(rendered)}` : '') + '\n';
      if (evidenceLength + line.length > MODEL_EVIDENCE_MAX || page.pageContent.length + line.length > MODEL_PUBLIC_MAX
          || JSON.stringify({ ...page, pageContent: page.pageContent + line }).length > 16000) return false;
      page.pageContent += line;
      evidenceLength += line.length;
      refs.set(ref, node); publicNodes.add(node);
      if (authoredEditableName) exposedEditableNames.set(node, authored);
      if (completeLabel) exposedCompleteLabels.add(node);
      return true;
    };
    const exposeMainControl = node => {
      if (publicNodes.has(node) || collateralMainControls.has(node)) return true;
      const editable = node.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
      if (exposeIdentity(node, { authoredEditableName: editable })) return true;
      // A rendered but genuinely unnamed collateral control still belongs to
      // the page action. Describe its structure without revealing its value.
      // Named/associated-label failures and observation limits stay failures.
      if (!visible(node) || node.closest('[aria-hidden="true"]') || node.labels?.length
          || ['aria-label', 'title', 'placeholder', 'alt', 'aria-labelledby', 'aria-describedby']
            .some(attribute => String(node.getAttribute(attribute) || '').trim())
          || (!editable && node.textContent.trim())) return false;
      const role = node.getAttribute('role') || '', type = /^(INPUT|BUTTON)$/.test(node.tagName) ? node.type : '';
      if (role.length > 128 || type.length > 128) return false;
      const ref = window.__wb_ax_ref?.(node);
      if (!ref || window.__wb_ax_lookup?.(ref) !== node) return false;
      const header = collateralHeaderExposed ? '' : '\n\n[CURRENT VISIBLE COLLATERAL CONTROL]\n';
      const line = header + `visible collateral ${node.tagName.toLowerCase()} role=${JSON.stringify(role)} type=${JSON.stringify(type)}`
        + (editable ? ' editable=true' : '') + (node.readOnly === true ? ' readonly=true' : '')
        + (node.disabled === true ? ' disabled=true' : '') + ` name-unavailable=true direct-action=false [${ref}] state-values-omitted\n`;
      if (evidenceLength + line.length > MODEL_EVIDENCE_MAX || page.pageContent.length + line.length > MODEL_PUBLIC_MAX
          || JSON.stringify({ ...page, pageContent: page.pageContent + line }).length > 16000) return false;
      page.pageContent += line; evidenceLength += line.length; collateralHeaderExposed = true;
      refs.set(ref, node); collateralMainControls.add(node);
      // Do not add it to publicNodes: inventory-only refs cannot authorize a
      // direct action or acquire an uncertified fallback during the scan.
      return true;
    };
    const exposeVisualImage = node => {
      if (!visible(node) || node.closest('[aria-hidden="true"]')) return false;
      const ref = window.__wb_ax_ref?.(node);
      if (!ref || window.__wb_ax_lookup?.(ref) !== node) return false;
      const header = evidenceLength ? '' : '\n\n[CURRENT VISIBLE ACTION IDENTITY]\n';
      const line = header + `visible image name-unavailable=true direct-action=false [${ref}] resource-values-omitted\n`;
      if (exposedCompleteLabels.has(node)) return true;
      if (evidenceLength + line.length > MODEL_EVIDENCE_MAX || page.pageContent.length + line.length > MODEL_PUBLIC_MAX
          || JSON.stringify({ ...page, pageContent: page.pageContent + line }).length > 16000) return false;
      page.pageContent += line; evidenceLength += line.length; exposedCompleteLabels.add(node);
      refs.set(ref, node);
      return true;
    };
    const observedFootprint = footprint => {
      if (!page) return true;
      if (!footprint.structuralFile && !publicNodes.has(footprint.target)) return false;
      if (footprint.conversationComposer) {
        const composer = footprint.conversationComposer;
        const authored = String(composer.getAttribute('aria-label') || composer.getAttribute('title')
          || composer.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
        // The private recipient proof may bind a destination label omitted
        // from a large AX tree. Expose only that complete authored label,
        // never editor contents, before certifying the footer action.
        if (authored && (!publicNodes.has(composer) || authored.length > 120)) {
          if (!exposeIdentity(composer, { authoredEditableName: true })) return false;
        } else if (!publicNodes.has(composer)) return false;
      }
      if (footprint.observedMainControls?.some(node => !exposeMainControl(node))) return false;
      if (footprint.observedAccountLinks?.some(node => !exposeIdentity(node, { completeLabel: true, accountLink: true }))) return false;
      if ([...footprint.visualImages || []].some(node => !exposeVisualImage(node))) return false;
      const evidence = footprint.nodes.filter(item => item.node !== footprint.target
        && (item.node === footprint.conversationCarrier
          || footprint.dialogIdentities?.has(item.node)
          || item.node.matches('h1,h2,h3,h4,h5,h6,[role="heading"],[aria-current],'+modelEntityIdentitySelector))
        && (footprint.dialogIdentities?.has(item.node) || visible(item.node)));
      return evidence.every(item => exposeIdentity(item.node, { completeLabel: footprint.dialogIdentities?.has(item.node) }))
        && (publicNodes.has(footprint.scope) || evidence.some(item => publicNodes.has(item.node)));
    };
    const captureTarget = node => {
      if (!(node instanceof Element) || ignored(node) || seen.has(node) || seen.size >= MODEL_SCAN_LIMIT) return;
      seen.add(node);
      const footprint = targets.size < MODEL_TARGET_LIMIT ? actionFootprint(node, node === readonlyPreparation?.target ? readonlyPreparation : null) : null;
      if (footprint && !observedFootprint(footprint)) return;
      if (!footprint && page && !publicNodes.has(node)) return;
      if (footprint) targets.set(node, footprint);
      else {
        const identity = modelCandidateIdentity(node);
        if (identity) uncertified.set(node, identity);
      }
    };
    // Recovery observes this target's current semantic owner in the same task
    // and seeds its original identity before a large page consumes the budget.
    // The rejected previous model call never receives this fresh certificate.
    if (priorityTarget) captureTarget(priorityTarget);
    // The model-visible AX targets are captured before the general DOM scan,
    // so a deep page's earlier decorative nodes do not consume their budget.
    if (page) for (const node of publicNodes) captureTarget(node);
    else if (window.__wbElementMap) for (const ref of Object.keys(window.__wbElementMap).slice(0, MODEL_SCAN_LIMIT)) {
      const node = window.__wb_ax_lookup?.(ref);
      if (node instanceof Element) { refs.set(ref, node); captureTarget(node); }
    }
    const stack = [document.documentElement];
    let scanned = 0;
    while (stack.length && scanned++ < MODEL_SCAN_LIMIT && seen.size < MODEL_SCAN_LIMIT) {
      const node = stack.pop();
      if (!(node instanceof Element) || ignored(node)) continue;
      captureTarget(node);
      const children = [...node.children, ...(node.shadowRoot?.children || [])];
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
    }
    const snapshotToken = randomToken();
    if (!active || params.runToken !== runToken || (readonlyPreparation
        && !readonlyPreparationMatches(readonlyPreparation, readonlyPreparation.target, params.nativeChatOwner)) || (nativeReadTarget
        && window.__wb_native_chat_read_target_matches?.(nativeReadTarget) !== true)) {
      return { ready: false, runToken, documentToken, reason: 'context_changed' };
    }
    const focusTarget = deepActiveElement();
    const focusedTargetAvailable = targets.has(focusTarget);
    // Metadata-only tests/integration use an existing AX lookup without a new
    // tree. Record those refs lazily only when they resolve to an original node.
    modelSnapshots.set(snapshotToken, { runToken, until: Date.now() + MODEL_SNAPSHOT_MS, targets, uncertified, refs,
      hasRefs: !!page || !!window.__wbElementMap, focusTarget, userAt: lastUserAt, interventionRevision });
    for (const [key, snapshot] of modelSnapshots) if (snapshot.until < Date.now()) modelSnapshots.delete(key);
    while (modelSnapshots.size > 2) modelSnapshots.delete(modelSnapshots.keys().next().value);
    return { ready: true, runToken, documentToken, snapshotToken, targetCount: targets.size, focusedTargetAvailable,
      ...(params.observationRef ? { observationScopeCaptured } : {}),
      ...(page ? { page } : {}) };
  }
  function preparedBindingChanged(op, { allowFocusRebind = false } = {}) {
    if (op?.allowPassiveRebase === true && op.preparedBinding?.model === true && op.focusBound
        && !allowFocusRebind && deepActiveElement() !== op.focusTarget) return true;
    return op?.allowPassiveRebase === true && !!op.preparedBinding
      && (!op.dispatched || (op.preparedBinding.model === true && (op.kind === 'input' || op.pointerPreparationOnly === true)))
      && !operationBindingMatches(op);
  }
  function rebasePassivePreparation(op, params = {}) {
    const continuingInput = op?.dispatched && op.kind === 'input' && op.preparedBinding?.model === true;
    const continuingPreparation = op?.dispatched && op.pointerPreparationOnly === true && op.preparedBinding?.model === true;
    if (!active || !op || op.allowPassiveRebase !== true || (op.dispatched && !continuingInput && !continuingPreparation) || op.coordinateSensitive || op.layoutInvalidated
        || op.until < Date.now() || lastUserAt > op.userAt || interventionUnreported
        || op.preparedInterventionRevision !== interventionRevision
        || (pendingDOM && pendingDOM.source !== 'page')
        || (params.documentToken && params.documentToken !== documentToken)) return false;
    const independentNavigation = op.tool === 'navigate';
    if (independentNavigation) {
      if (op.preparedPageContext !== JSON.stringify([location.href, document.baseURI, currentViewport(), window.scrollX, window.scrollY])) return false;
    } else {
      if (op.selector) {
        try { const query = queryOpenTargets(op.selector); if (!query.complete || query.elements.length !== 1) return false; } catch { return false; }
      }
      if (!passiveRebaseTools.has(op.modelBindingTool || op.tool) || !op.preparedBinding
          || (params.element && params.element !== op.preparedBinding.target)
          || (!op.tabFocusRebound && !(params.rebindFocus === true && op.tabFocusRebindAllowed)
            && (resolveTarget(op) || (op.focusEligible ? deepActiveElement() : null)) !== op.preparedBinding.target)
          || (continuingInput && !(params.rebindFocus === true && op.tabFocusRebindAllowed) && deepActiveElement() !== op.focusTarget)
          || !operationBindingMatches(op)) return false;
    }
    // Do not suppress feedback. Flush it for the agent while rebasing only this
    // exact, freshly revalidated operation over unrelated passive mutations.
    if (domTimer) {
      clearTimeout(domTimer); domTimer = null;
      const observation = pendingDOM; pendingDOM = null;
      if (observation) send(observation);
    }
    op.preparedRevision = revision;
    return true;
  }
  function seed(root, budget = { remaining: 600 }) {
    const nodes = root.querySelectorAll?.('*') || [];
    for (const el of nodes) {
      // Keep a baseline for every control; periodic reads rotate through them in bounded batches.
      trackControl(el);
      if (budget.remaining > 0) { budget.remaining--; signatures.set(el, signature(el)); }
      // Root discovery is cheap and must not share the layout-measurement cap.
      if (el.shadowRoot && !ignored(el)) observeRoot(el.shadowRoot, budget);
    }
  }
  function sampleFormControls(...targets) {
    const extraTargets = targets.flat().filter(el => el instanceof Element);
    if (!active || (!controlReferences.size && !extraTargets.length)) return;
    const sampled = new Set();
    const records = [];
    let inspected = 0;
    while (inspected < 200) {
      controlIterator ||= controlReferences.values();
      const next = controlIterator.next();
      if (next.done) { controlIterator = null; break; }
      inspected++;
      const reference = next.value;
      const el = reference.deref();
      if (!el || !el.isConnected) { controlReferences.delete(reference); continue; }
      sampled.add(el);
      if (!ignored(el)) records.push({ type: 'control', target: el });
    }
    for (const el of extraTargets) {
      if (sampled.has(el) || !el.isConnected || !/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName) || ignored(el)) continue;
      sampled.add(el);
      const previous = controlSignatures.get(el)
        ?? [...operations.values()].find(op => op.target === el && op.controlStateAtPrepare !== undefined)?.controlStateAtPrepare;
      if (previous !== undefined && controlState(el) !== previous) records.push({ type: 'control', target: el });
    }
    if (records.length) onMutations(records);
  }
  function samplePreparedTargets(onlyOperation) {
    if (!active) return;
    const now = Date.now();
    const candidates = onlyOperation ? [onlyOperation] : [...operations.values()]
      .filter(op => !op.dispatched && op.target && op.preparedTargetSignature !== undefined && op.until >= now);
    if (!onlyOperation && candidates.length > 128) {
      const start = preparedOperationCursor % candidates.length;
      const batch = Array.from({ length: 128 }, (_, index) => candidates[(start + index) % candidates.length]);
      preparedOperationCursor = (start + batch.length) % candidates.length;
      candidates.splice(0, candidates.length, ...batch);
    }
    const changedTargets = new Set();
    for (const op of candidates) {
      if (!op || op.dispatched || !op.target || op.preparedTargetSignature === undefined) continue;
      const current = signature(op.target);
      if (current === op.preparedTargetSignature) continue;
      op.preparedTargetSignature = current;
      changedTargets.add(op.target);
    }
    if (changedTargets.size) onMutations([...changedTargets].map(target => ({ type: 'prepared-style', target })));
  }
  function flushPendingMutations(onlyOperation) {
    if (!active || !observer) return;
    const records = observer.takeRecords();
    if (records.length) onMutations(records);
    samplePreparedTargets(onlyOperation);
  }
  function sampleDescendants(root, limit = 100) {
    const nodes = [];
    const stack = [];
    const pushChildren = parent => {
      const length = parent?.children?.length || 0;
      if (length) stack.push({ parent, index: 0, length });
    };
    pushChildren(root);
    pushChildren(root?.shadowRoot);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.length) { stack.pop(); continue; }
      const node = frame.parent.children[frame.index++];
      if (nodes.length === limit) return { nodes, exceeded: true };
      nodes.push(node);
      pushChildren(node);
      // Inherited host styles and CSS variables can alter visible descendants
      // inside an open shadow root without changing the host's own signature.
      pushChildren(node.shadowRoot);
    }
    return { nodes, exceeded: false };
  }
  function observeRoot(root, budget) {
    if (!root || roots.has(root) || !observer) return;
    roots.add(root);
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true,
      attributeFilter: ['role', 'aria-modal', 'aria-label', 'id', 'for', 'form', 'name', 'placeholder', 'title', 'alt', 'aria-labelledby', 'rel', 'media', 'data-selected',
        'aria-required', 'aria-readonly', 'contenteditable', 'tabindex', 'onclick', 'required',
        'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed', 'aria-disabled',
        'type', 'href', 'target', 'download', 'action', 'method', 'formaction', 'formmethod', 'formtarget', 'novalidate', 'formnovalidate',
        'aria-valuenow', 'aria-valuetext', 'aria-hidden', 'hidden', 'disabled', 'readonly', 'checked', 'selected', 'open', 'popover', 'inert', 'class', 'style'] });
    for (const name of ['animationend', 'animationcancel', 'transitionend', 'transitioncancel'])
      listen(root, name, checkSettledAnimation);
    listen(root, 'beforetoggle', event => {
      const el = elementFor(event);
      if (ignored(el) || !el.hasAttribute('popover') || !('popover' in el)) return;
      const mark = { observer, oldState: event.oldState, newState: event.newState, notified: false,
        agentUserAt: agentTurn && lastUserAt <= agentTurn.userAt ? agentTurn.userAt : undefined };
      popoverTurns.set(el, mark);
      // Check after page handlers can cancel opening, but before an action can
      // dispatch in the next task. Retain exact attribution for the later toggle.
      queueMicrotask(() => {
        if (!active || observer !== mark.observer || popoverTurns.get(el) !== mark || event.defaultPrevented
            || popoverOpen(el) !== (mark.newState === 'open')) return;
        mark.notified = true;
        onMutations([{ type: 'popover', target: el, stateChanged: mark.oldState !== mark.newState, agentUserAt: mark.agentUserAt }]);
      });
    });
    listen(root, 'toggle', event => {
      const el = elementFor(event);
      if (ignored(el) || !el.hasAttribute('popover') || !('popover' in el)
          || popoverOpen(el) !== (event.newState === 'open')) return;
      const mark = popoverTurns.get(el);
      if (mark?.observer === observer && mark.newState === event.newState && mark.notified) return;
      onMutations([{ type: 'popover', target: el, stateChanged: event.oldState !== event.newState }]);
    });
    seed(root, budget);
  }
  function popoverOpen(el) {
    return el.hasAttribute('popover') && 'popover' in el && el.matches(':popover-open');
  }
  function subtreeChanged(record, el) {
    const changedNodes = [...record.addedNodes, ...record.removedNodes];
    const meaningful = node => {
      // Text identity is not an interactive target; its content is compared by
      // the parent's signature, including direct text in a shadow root.
      if (node.nodeType === 3) return false;
      if (node.nodeType !== 1 || ignored(node)) return false;
      if (visible(node) || signatures.get(node)?.startsWith('[true')) return true;
      return [...node.querySelectorAll('*')].slice(0, 200).some(child => !ignored(child)
        && (visible(child) || signatures.get(child)?.startsWith('[true')));
    };
    if (changedNodes.some(meaningful)) return true;
    // Removed prepared targets also matter when their old geometry was outside
    // the bounded signature seed, including targets inside an open shadow root.
    return [...record.removedNodes].some(node => !ignored(node.nodeType === 1 ? node : el)
      && [...operations.values()].some(op => {
        for (let target = op.target; target; target = target.getRootNode?.().host) {
          if (node === target || node.contains?.(target)) return true;
        }
        return false;
      }));
  }
  function hasVisibleAriaLabelledbyConsumer(el, previousId = '') {
    const ids = new Set();
    if (previousId) ids.add(previousId);
    for (let node = el; node; node = node.parentElement || node.getRootNode?.().host) {
      if (node.id) ids.add(node.id);
    }
    if (!ids.size) return false;
    let consumers;
    try { consumers = document.querySelectorAll('[aria-labelledby]'); } catch { return false; }
    for (const consumer of consumers) {
      if (ignored(consumer) || !visible(consumer)) continue;
      const references = (consumer.getAttribute('aria-labelledby') || '').trim().split(/\s+/);
      if (references.some(id => ids.has(id))) return true;
    }
    return false;
  }
  function hasVisibleNativeLabelConsumer(el, previousFor = '') {
    let label = null;
    for (let node = el; node; node = node.parentElement || node.getRootNode?.().host) {
      if (node.tagName === 'LABEL') { label = node; break; }
    }
    if (!label) return false;
    const visibleControl = control => control instanceof Element && !ignored(control) && visible(control);
    if (visibleControl(label.control)) return true;
    if (label !== el || !previousFor) return false;
    const root = label.getRootNode?.();
    const priorControl = root?.getElementById?.(previousFor)
      || (root === document ? document.getElementById(previousFor) : null);
    return visibleControl(priorControl);
  }
  const descendantTextNameRoles = new Set([
    'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'row', 'gridcell', 'cell', 'listitem',
  ]);
  const nonImplicitSubmitInputTypes = new Set([
    'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden', 'color', 'range',
  ]);
  function hasVisibleTextNameConsumer(el) {
    for (let node = el.parentElement || el.getRootNode?.().host; node; node = node.parentElement || node.getRootNode?.().host) {
      if (!visible(node)) continue;
      const tag = node.tagName, role = (node.getAttribute('role') || '').toLowerCase();
      if (['BUTTON', 'A', 'SUMMARY', 'LI'].includes(tag) || /^H[1-6]$/.test(tag) || descendantTextNameRoles.has(role)) return true;
    }
    return false;
  }
  function stylesheetNode(node) {
    if (!(node instanceof Element)) return false;
    return node.tagName === 'STYLE' || (node.tagName === 'LINK'
      && (node.getAttribute('rel') || '').split(/\s+/).some(token => token.toLowerCase() === 'stylesheet'));
  }
  function stylesheetMutation(record) {
    const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    if (record.type === 'attributes') {
      return stylesheetNode(target) || (target?.tagName === 'LINK' && record.attributeName === 'rel'
        && (record.oldValue || '').split(/\s+/).some(token => token.toLowerCase() === 'stylesheet')) ? [target] : [];
    }
    if (record.type === 'characterData') {
      const style = stylesheetNode(target) ? target : stylesheetNode(target?.parentElement) ? target.parentElement : null;
      return style ? [style] : [];
    }
    if (record.type !== 'childList') return [];
    const stylesheets = stylesheetNode(target) ? [target] : [];
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      const style = stylesheetNode(node) ? node : node.nodeType === 3 && stylesheetNode(node.parentElement) ? node.parentElement : null;
      if (style && !stylesheets.includes(style)) stylesheets.push(style);
    }
    return stylesheets;
  }
  function baseNavigationMutation(record, el) {
    if (record.type === 'attributes' && el?.tagName === 'BASE' && ['href', 'target'].includes(record.attributeName))
      return record.oldValue !== el.getAttribute(record.attributeName);
    return record.type === 'childList' && [...record.addedNodes, ...record.removedNodes]
      .some(node => node.nodeType === 1 && node.tagName === 'BASE');
  }
  function runningAnimations(el) {
    try {
      const animations = el?.getAnimations?.();
      return (Array.isArray(animations) ? animations : []).filter(animation => animation.playState === 'running');
    } catch { return []; }
  }
  function deferAnimationCheck(record, el) {
    const animations = runningAnimations(el);
    if (!animations.length) return false;
    const agentUserAt = Number.isFinite(record.agentUserAt) ? record.agentUserAt
      : agentTurn && lastUserAt <= agentTurn.userAt ? agentTurn.userAt : undefined;
    if (Number.isFinite(agentUserAt)) for (const animation of animations) {
      const target = animation.effect?.target;
      animationAttribution.set(target instanceof Element ? target : el, agentUserAt);
    }
    return true;
  }
  function checkSettledAnimation(event) {
    const el = event.target;
    if (!active || !(el instanceof Element) || ignored(el)) return;
    const finiteAnimationRunning = runningAnimations(el).some(animation =>
      animation.effect?.getComputedTiming?.().iterations !== Infinity);
    if (finiteAnimationRunning) return;
    const agentUserAt = animationAttribution.get(el);
    animationAttribution.delete(el);
    onMutations([{ type: 'animation-settled', target: el, ...(Number.isFinite(agentUserAt) ? { agentUserAt } : {}) }]);
  }
  function onMutations(records) {
    if (!active) return;
    let changed = false, attributed = false, source = 'page', target = '';
    let diagnosticRecord = null;
    const diagnostic = el => {
      const op = operations.get(localOperation?.operationId), ownTarget = op?.target;
      const type = ['childList', 'characterData', 'attributes', 'layout', 'control', 'prepared-style', 'animation-settled', 'shadow', 'popover'].includes(diagnosticRecord?.type)
        ? diagnosticRecord.type : 'other';
      const attribute = diagnosticRecord?.type === 'attributes'
        ? ['class', 'style', 'hidden', 'aria-hidden', 'aria-label', 'aria-labelledby', 'contenteditable', 'role', 'tabindex', 'disabled', 'readonly', 'value', 'open', 'inert', 'selected'].includes(diagnosticRecord.attributeName)
          ? diagnosticRecord.attributeName : 'other'
        : '';
      const relation = el === document.body || el === document.documentElement ? 'document'
        : el === ownTarget ? 'target' : ownTarget?.contains?.(el) ? 'descendant'
          : el?.contains?.(ownTarget) ? 'ancestor'
            : op?.preparedBinding?.scope && ![document.body, document.documentElement].includes(op.preparedBinding.scope)
              && op.preparedBinding.scope.contains?.(el) ? 'scoped' : 'outside';
      return `dom.${type}.${relation}${attribute ? '.' + attribute : ''}`;
    };
    const noteChange = (el, agentUserAt) => {
      // Attribute the marked input/write's synchronous handlers to that dispatch.
      // Later DOM writes stay observable, including writes on the same target.
      if ((Number.isFinite(agentUserAt) && lastUserAt <= agentUserAt) || (agentTurn && lastUserAt <= agentTurn.userAt)) {
        attributed = true;
        const expectedAt = Number.isFinite(agentUserAt) ? agentUserAt : agentTurn?.userAt;
        for (const op of operations.values()) if (op.userAt === expectedAt && related(op.target, el)) rememberAgentLayout(op);
        return;
      }
      changed = true;
      target ||= targetName(el);
      if (userTurn || (Date.now() - lastUserAt < 1500 && related(lastUserTarget, el))) source = 'user';
      else if (source !== 'user' && [...operations.values()].some(op => op.dispatched && !op.finished && !op.pointerPreparationOnly && op.until >= Date.now())) {
        source = 'unknown'; interventionDiagnostic = diagnostic(el);
      }
    };
    const changes = [...records];
    for (const record of records) {
      diagnosticRecord = record;
      if (record.type !== 'popover' && record.type !== 'prepared-style'
          && (record.type !== 'attributes' || !['class', 'style', 'hidden', 'aria-hidden', 'open', 'inert', 'selected'].includes(record.attributeName))) continue;
      if (ignored(record.target)) continue;
      if (deferAnimationCheck(record, record.target)) continue;
      if (record.type === 'attributes' && record.attributeName === 'selected'
          && record.oldValue !== record.target.getAttribute('selected')) {
        const select = record.target.closest?.('select');
        if (select && !ignored(select)) noteChange(select, record.agentUserAt);
      }
      const sample = sampleDescendants(record.target);
      // A bounded layout sample cannot prove that inherited visibility left a
      // large subtree unchanged. Invalidate conservatively on an actual state
      // change, before the measurement cap can omit a late affected descendant.
      // Stop walking at the cap instead of materializing the whole subtree.
      if (sample.exceeded) {
        if (record.type === 'popover' || record.oldValue !== record.target.getAttribute(record.attributeName))
          noteChange(record.target, record.agentUserAt);
        continue;
      }
      for (const el of sample.nodes)
        changes.push({ type: 'layout', target: el, agentUserAt: record.agentUserAt });
    }
    let measured = 0;
    const seedBudget = { remaining: 600 };
    for (const record of changes) {
      diagnosticRecord = record;
      const el = record.target.nodeType === 1 ? record.target
        : record.target.host || record.target.parentElement || record.target.getRootNode?.().host;
      if (baseNavigationMutation(record, el)) { noteChange(document.documentElement, record.agentUserAt); continue; }
      const changedStylesheets = stylesheetMutation(record);
      if (changedStylesheets.length) {
        if (changedStylesheets.some(style => !decorations.has(style))) noteChange(document.documentElement, record.agentUserAt);
        continue;
      }
      const editableTextMutation = editable(el) && (record.type === 'characterData'
        || (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 3)));
      const accessibleNameContentMutation = ['characterData', 'childList'].includes(record.type);
      if (ignored(el)) continue;
      if (record.type === 'attributes' && record.attributeName === 'data-selected'
          && record.oldValue !== el.getAttribute('data-selected')) {
        const listbox = el.closest?.('[role="listbox"]');
        if (listbox && !ignored(listbox)) noteChange(listbox, record.agentUserAt);
      }
      // Native input already reports user edits, and agent input's synchronous
      // DOM writes are attributed to its dispatch. Keep those paths deduplicated
      // while observing independent page-script changes to editable text.
      if (editableTextMutation && (userTurn || (agentTurn && lastUserAt <= agentTurn.userAt))) {
        attributed ||= !!agentTurn && lastUserAt <= agentTurn.userAt;
        continue;
      }
      if (accessibleNameContentMutation && el.tagName === 'OPTION' && el.selected) {
        const select = el.closest('select');
        if (select && !ignored(select)) noteChange(select, record.agentUserAt);
      }
      if (record.type === 'attributes' && ['class', 'style'].includes(record.attributeName)
          && deferAnimationCheck(record, el)) continue;
      if (record.type === 'layout' && deferAnimationCheck(record, el)) continue;
      if (++measured > 300) {
        // The remaining records are intentionally uninspected. Invalidate the
        // prepared page conservatively so a later visible target cannot vanish
        // silently at the end of a large, same-task update.
        changed = true;
        if (source !== 'user') source = agentTurn && lastUserAt <= agentTurn.userAt ? 'agent' : 'unknown';
        if (source === 'unknown') interventionDiagnostic = 'dom.measurement_cap';
        target ||= targetName(el);
        break;
      }
      if (record.type === 'control') {
        const nextControl = controlState(el), previousControl = controlSignatures.get(el);
        controlSignatures.set(el, nextControl);
        signatures.set(el, signature(el));
        if (nextControl !== previousControl) noteChange(el, record.agentUserAt);
        continue;
      }
      const nativeLabelAssociationMutation = record.type === 'attributes'
        && record.attributeName === 'for' && el.tagName === 'LABEL';
      const hiddenAriaLabelIdMutation = record.type === 'attributes' && record.attributeName === 'id';
      const hiddenAccessibleNameChanged = !visible(el)
        && ((accessibleNameContentMutation && hasVisibleAriaLabelledbyConsumer(el))
          || (hiddenAriaLabelIdMutation && hasVisibleAriaLabelledbyConsumer(el, record.oldValue))
          || (accessibleNameContentMutation && hasVisibleTextNameConsumer(el))
          || ((accessibleNameContentMutation || nativeLabelAssociationMutation)
            && hasVisibleNativeLabelConsumer(el, nativeLabelAssociationMutation ? record.oldValue : '')));
      let identityChanged = (record.type === 'popover' && record.stateChanged)
        || record.type === 'prepared-style'
        || (record.type === 'layout' && record.layoutChanged)
        || editableTextMutation || hiddenAccessibleNameChanged
        || (record.type === 'shadow' && (visible(el) || signatures.get(el)?.startsWith('[true')));
      if (record.type === 'childList') {
        identityChanged ||= subtreeChanged(record, el);
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || ignored(node)) continue;
          if (seedBudget.remaining > 0) { seedBudget.remaining--; signatures.set(node, signature(node)); }
          seed(node, seedBudget);
          if (node.shadowRoot) observeRoot(node.shadowRoot, seedBudget);
        }
        if ([...record.addedNodes, ...record.removedNodes].every(node => node.nodeType === 1 && ignored(node))) {
          signatures.set(el, signature(el)); continue;
        }
      }
      const next = signature(el), previous = signatures.get(el);
      signatures.set(el, next);
      if (/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName)) controlSignatures.set(el, controlState(el));
      if (!identityChanged && (next === previous || (!visible(el) && !previous?.startsWith('[true')))) continue;
      noteChange(el, record.agentUserAt);
    }
    if (!changed && !attributed) return;
    // Keep sampling baselines aligned with changes the DOM observer already
    // consumed, including attributed agent writes. Otherwise the later CSSOM
    // sample re-reports those writes after their synchronous attribution ends.
    // Immutable prepared/model bindings remain unchanged and still fence stale
    // targets at dispatch.
    for (const op of operations.values())
      if (!op.dispatched && op.target && op.until >= Date.now()) op.preparedTargetSignature = signature(op.target);
    if (!changed) return;
    if (source !== 'page' && source !== 'agent') interventionRevision++;
    revision++; publishRevision();
    clearTimeout(domTimer);
    pendingDOM = { kind: 'dom', source, target };
    domTimer = setTimeout(() => { domTimer = null; const observation = pendingDOM; pendingDOM = null; send(observation); }, 150);
  }
  function observeLayoutShifts() {
    if (typeof PerformanceObserver !== 'function'
        || !PerformanceObserver.supportedEntryTypes?.includes('layout-shift')) return;
    try {
      layoutObserver = new PerformanceObserver(list => {
        if (!active) return;
        const records = [];
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput || !Array.isArray(entry.sources)) continue;
          for (const source of entry.sources) {
            const el = source.node instanceof Element ? source.node : source.node?.parentElement;
            if (!el || ignored(el) || !visible(el) || el.getAnimations?.().some(animation => animation.playState === 'running')) continue;
            const oldRect = source.previousRect, newRect = source.currentRect;
            if (!oldRect || !newRect || !['x', 'y', 'width', 'height'].some(key => Math.abs(oldRect[key] - newRect[key]) > 2)) continue;
            const agentUserAt = layoutAgentUserAt(el, { previousRect: source.previousRect, currentRect: source.currentRect, entry });
            records.push({ type: 'layout', target: el, layoutChanged: true, agentUserAt });
            if (records.length >= 32) break;
          }
          if (records.length >= 32) break;
        }
        if (records.length) onMutations(records);
      });
      layoutObserver.observe({ type: 'layout-shift', buffered: false });
    } catch { layoutObserver?.disconnect(); layoutObserver = null; }
  }
  function listen(target, name, handler, passive = true) {
    target.addEventListener(name, handler, { capture: true, passive });
    listeners.push(() => target.removeEventListener(name, handler, true));
  }
  function start(state) {
    if (disposed || !state?.active || state.documentToken !== documentToken) return;
    if (active && runToken === state.runToken) return;
    stop();
    active = true; runToken = state.runToken; seq = 0; revision = 0; interventionRevision = 0; interventionDiagnostic = ''; publishRevision();
    observer = new MutationObserver(onMutations);
    observeRoot(document);
    controlTimer = setInterval(() => { sampleFormControls(); samplePreparedTargets(); }, 250);
    observeLayoutShifts();
    listen(document, 'webbrain-shadow-root-attached', event => {
      const path = event.composedPath();
      if (path.some(node => node instanceof Element && ignored(node))) return;
      const host = elementFor(event), root = host?.shadowRoot;
      if (!host?.isConnected || !root || roots.has(root)) return;
      observeRoot(root);
      onMutations([{ type: 'shadow', target: host }]);
    });
    listen(window, 'webbrain-agent-dom-dispatch', event => {
      try {
        const guard = JSON.parse(String(event.detail));
        const op = operations.get(guard.operationId);
        const phase = ['focus', 'click', 'input'].includes(guard.dispatchPhase) ? guard.dispatchPhase : 'dom';
        const phaseKind = phase === 'input' ? 'input' : phase === 'dom' ? 'dom' : 'click';
        const actionPhase = phase !== 'dom';
        const phaseAlreadyConsumed = phase === 'dom'
          ? op?.domDispatchConsumed === true
          : op?.domDispatchConsumed === true || op?.domDispatchPhases?.has(phase) === true;
        event.stopImmediatePropagation();
        flushPendingMutations(op);
        sampleFormControls(op?.target);
        if (!active || guard.runToken !== runToken || guard.documentToken !== documentToken || guard.revision !== revision
            || !op || phaseAlreadyConsumed || op.kind !== phaseKind
            || (phase === 'input' && elementFor(event) !== op.target && elementFor(event) !== op.focusTarget)
            || op.preparedRevision !== revision || domTimer || unreported || lastUserAt > op.userAt) {
          event.preventDefault(); return;
        }
        if (actionPhase) {
          op.domDispatchPhases ||= new Set();
          op.domDispatchPhases.add(phase);
          if (!op.dispatched) dispatch({ operationId: op.operationId, kind: phaseKind, runToken });
          if (phase === 'input') op.synchronous = true;
        } else op.domDispatchConsumed = true;
        const marker = { userAt: lastUserAt }; agentTurn = marker;
        setTimeout(() => { if (phase === 'input') op.synchronous = false; if (agentTurn === marker) agentTurn = null; }, 0);
      } catch { event.stopImmediatePropagation(); event.preventDefault(); /* Only a current prepared operation can mark a DOM write. */ }
    }, false);
    listen(document, 'webbrain-agent-scroll-dispatch', event => {
      try {
        const guard = JSON.parse(String(event.detail));
        if (guard.documentToken !== documentToken || guard.revision !== revision || !operations.has(guard.operationId)
            || domTimer || unreported) { event.preventDefault(); return; }
        const el = elementFor(event);
        const prepared = operations.get(guard.operationId);
        // Only this current, privately fenced selector scroll is preparation.
        // It cannot erase an earlier input or any queued intervention.
        const selectorPreparationOnly = active && guard.runToken === runToken
          && !!guard.nativeSecret && guard.nativeSecret === prepared.nativeSecret
          && prepared.kind === 'scroll' && !prepared.dispatched && !prepared.consequentialInputPending
          && prepared.allowPassiveRebase === true && passiveRebaseTools.has(prepared.modelBindingTool || prepared.tool)
          && prepared.preparedBinding?.model === true && !prepared.modelBindingInvalid
          && prepared.preparedRevision === revision && prepared.preparedInterventionRevision === interventionRevision
          && prepared.userAt === lastUserAt && prepared.until >= Date.now()
          && !prepared.layoutInvalidated && !prepared.nativeWheel && !interventionUnreported
          && prepared.target === el && prepared.preparedBinding.target === el && operationBindingMatches(prepared, el);
        dispatch({ operationId: guard.operationId, kind: 'scroll', scrollIntoView: true, runToken }, selectorPreparationOnly);
        const op = operations.get(guard.operationId);
        op.target = el; op.scrollAncestors.clear();
        for (let node = el?.parentElement || el?.getRootNode?.().host; node; node = node.parentElement || node.getRootNode?.().host) op.scrollAncestors.add(node);
      } catch { event.preventDefault(); }
    }, false);
    const noteAgentTurn = event => {
      const el = elementFor(event);
      const op = expected(['input', 'beforeinput', 'change', 'keydown'].includes(event.type) ? 'input' : 'click', el, event);
      if (!op) return;
      if (event.type === 'keydown') op.tabFocusRebindAllowed = event.key === 'Tab';
      if (['input', 'beforeinput', 'change'].includes(event.type)) rememberAgentLayout(op);
      const marker = { userAt: op.userAt };
      agentTurn = marker;
      const enterFormSubmit = event.type === 'keydown' && event.key === 'Enter' && op.kind === 'input'
        && !el?.isContentEditable && !!el?.form
        && ((el.tagName === 'INPUT' && !nonImplicitSubmitInputTypes.has(el.type))
          || el.matches?.('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]'));
      if (event.type === 'keydown' && !enterFormSubmit) {
        const key = event.key === 'Spacebar' ? ' ' : event.key;
        const keyboardClickTarget = event.composedPath().find(node => node instanceof Element && (
          (key === 'Enter' && node.matches('a[href],area[href]'))
          || (['Enter', ' '].includes(key) && node.matches('button,summary,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"]'))
          || (key === ' ' && node.matches('input[type="checkbox"],input[type="radio"]'))
        ));
        if (keyboardClickTarget) { op.keyboardClickTarget = keyboardClickTarget; op.kinds.add('click'); }
      }
      const keyboardClick = event.type === 'click' && event.isTrusted === true && op.keyboardClickTarget
        && related(op.keyboardClickTarget, el);
      if ((op.navigationCandidate && ['click', 'pointerdown'].includes(event.type)) || enterFormSubmit || keyboardClick) {
        const path = event.composedPath();
        const link = enterFormSubmit ? null : path.find(node => node instanceof Element && node.matches('a[href],area[href]'));
        let submitter = path.find(node => node instanceof Element
          && node.matches('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]') && node.form);
        const form = submitter?.form || (enterFormSubmit ? el.form : null);
        if (enterFormSubmit && form && !submitter) {
          submitter = [...form.elements].find(node => !node.disabled && node.matches?.(
            'button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]')) || null;
        }
        if (enterFormSubmit && submitter) { op.submitTarget = submitter; op.kinds.add('click'); }
        const formMethod = submitter?.hasAttribute('formmethod') ? submitter.formMethod : form?.method;
        const navigationFormGet = !link && !!form && String(formMethod || 'get').toLowerCase() === 'get';
        const formTarget = submitter?.getAttribute('formtarget') || form?.getAttribute('target');
        const baseTarget = document.querySelector('base[target]')?.getAttribute('target') || '';
        const navigationTarget = String((link ? link.getAttribute('target') : formTarget) || baseTarget || '');
        const normalizedTarget = navigationTarget.toLowerCase();
        let navigationUrl = '';
        try {
          const rawUrl = link?.href || (form ? (submitter?.hasAttribute('formaction') ? submitter.formAction : form.action) : '');
          const destination = new URL(rawUrl, document.baseURI);
          if (navigationFormGet) { destination.search = ''; destination.hash = ''; }
          if (['http:', 'https:'].includes(destination.protocol) && !destination.username && !destination.password
              && destination.href.length <= 2000) navigationUrl = destination.href;
        } catch { /* Non-web and malformed targets are not navigation correlations. */ }
        send({ kind: 'activity', source: 'agent', operation: enterFormSubmit ? 'submit' : 'click',
          ...(navigationUrl ? { navigationUrl } : {}),
          ...(navigationUrl && navigationFormGet ? { navigationFormGet: true } : {}),
          ...(['_top', '_parent', '_self', '_blank'].includes(normalizedTarget)
            ? { navigationTarget: normalizedTarget }
            : navigationTarget ? { navigationTargetName: compact(navigationTarget, 256) } : {}) });
      }
      // Native listeners have microtask checkpoints between callbacks. Keep this
      // exact input's attribution through its page handlers, until the next task.
      setTimeout(() => { if (agentTurn === marker) agentTurn = null; }, 0);
    };
    for (const name of ['pointerover', 'mouseover']) listen(document, name, event => {
      if (event.isTrusted) expected('click', elementFor(event), event, true);
    });
    for (const name of ['click', 'input', 'beforeinput', 'change', 'keydown', 'pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup'])
      listen(document, name, noteAgentTurn);
    listen(document, 'pointerdown', event => {
      const el = elementFor(event);
      if (!event.isTrusted || ignored(el) || expected('click', el, event)) return;
      activePointers.add(event.pointerId);
      pointerHeld = true; interact('activity', el);
    });
    listen(document, 'pointermove', event => {
      if (activePointers.has(event.pointerId) && event.isTrusted) {
        if (!event.buttons) activePointers.delete(event.pointerId);
        pointerHeld = activePointers.size > 0;
        interact('activity', elementFor(event));
      }
    });
    for (const name of ['pointerup', 'pointercancel']) listen(document, name, event => {
      if (!activePointers.has(event.pointerId) || !event.isTrusted) return;
      activePointers.delete(event.pointerId);
      pointerHeld = activePointers.size > 0;
      interact('activity', elementFor(event), { completeGesture: activePointers.size === 0 });
    });
    listen(document, 'click', event => {
      const el = elementFor(event);
      if (!event.isTrusted || expected('click', el, event)) return;
      interact('click', el);
    });
    listen(document, 'focusin', event => {
      const el = elementFor(event);
      if (!event.isTrusted || ignored(el) || deepActiveElement() !== el || expected('focus', el, event)) return;
      if (agentTurn && lastUserAt <= agentTurn.userAt) return;
      // The pointer/key that led to a same-turn focus is already reported.
      if (userTurn) return;
      revision++; publishRevision();
      send({ kind: 'activity', source: 'page', target: targetName(el) });
    });
    for (const name of ['beforeinput', 'input', 'change']) listen(document, name, event => {
      const el = elementFor(event);
      const expectedInput = expected('input', el, event);
      const expectedClick = !expectedInput && el.matches?.('input[type="checkbox"],input[type="radio"],select,option')
        ? expected('click', el, event) : null;
      const localInput = !event.isTrusted && agentTurn && lastUserAt <= agentTurn.userAt
        && localOperation?.started && operations.get(localOperation.operationId)?.target === el;
      if (ignored(el)) return;
      if (expectedInput || expectedClick || localInput) { refreshControl(el); return; }
      if (event.isTrusted) interact('input', el);
      else { revision++; send({ kind: 'input', source: 'page', target: targetName(el) }); }
      refreshControl(el);
    });
    listen(document, 'compositionstart', event => {
      const el = elementFor(event);
      if (event.isTrusted && !expected('input', el, event)) { composing = true; interact('activity', el); }
    });
    listen(document, 'compositionend', event => {
      const el = elementFor(event);
      if (event.isTrusted && !expected('input', el, event)) { composing = false; interact('input', el); }
    });
    listen(document, 'keydown', event => {
      const el = elementFor(event);
      if (!event.isTrusted || expected('input', el, event)) return;
      // Modifier-only presses do not activate page shortcuts. Other trusted
      // keydowns can change page state even when no DOM mutation follows; key
      // values are used only for this local filter and never enter feedback.
      if (!['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Hyper', 'Super']
        .includes(event.key)) interact('activity', el);
    });
    for (const name of ['wheel', 'touchmove']) listen(document, name, event => {
      const el = elementFor(event);
      if (event.isTrusted && !expected('scroll', el, event)) interact('activity', el);
    });
    lastViewport = JSON.stringify(currentViewport());
    const onResize = () => {
      const current = currentViewport(), key = JSON.stringify(current);
      if (!active || key === lastViewport) return;
      lastViewport = key; revision++; publishRevision();
      if (agentResize?.runToken === runToken && agentResize.events.length < 16) {
        agentResize.events.push(current);
        return;
      }
      if (agentResize) void flushAgentResize('unknown');
      send({ kind: 'resize', source: window === window.top ? 'unknown' : 'page', target: 'viewport', viewport: current });
    };
    listen(window, 'resize', onResize);
    if (window.visualViewport) {
      listen(window.visualViewport, 'resize', onResize);
      listen(window.visualViewport, 'scroll', onResize);
    }
    listen(document, 'scroll', event => {
      const el = event.target === document ? document.documentElement : event.target;
      if (ignored(el)) return;
      const agentScroll = expected('scroll', el);
      if (agentScroll) {
        // Page scroll handlers can synchronously append lazy content. Carry the
        // exact scroll's attribution through the MutationObserver checkpoint.
        const marker = { userAt: agentScroll.userAt };
        agentTurn = marker;
        setTimeout(() => { if (agentTurn === marker) agentTurn = null; }, 0);
        return;
      }
      const source = Date.now() - lastUserAt < 1000 ? 'user' : 'unknown';
      const viewport = { x: el === document.documentElement ? scrollX : el.scrollLeft,
        y: el === document.documentElement ? scrollY : el.scrollTop };
      // Invalidate coordinates immediately, then coalesce the final position.
      revision++;
      send({ kind: 'scroll', source, target: targetName(el), viewport });
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if (expected('scroll', el)) return;
        send({ kind: 'scroll', source, target: targetName(el), viewport: {
          x: el === document.documentElement ? scrollX : el.scrollLeft,
          y: el === document.documentElement ? scrollY : el.scrollTop } });
      }, 100);
    });
    listen(document, 'selectionchange', () => {
      if (Date.now() - lastUserAt < 1000 && !editable(document.activeElement)) interact('selection', document.activeElement || document.body);
    });
    listen(window, 'blur', () => {
      if (pointerHeld || composing) { activePointers.clear(); pointerHeld = false; composing = false; interact('activity', document.body, { interacting: false }); }
    });
    listen(window, 'pagehide', () => stop());
  }
  function stop() {
    active = false; runToken = ''; activePointers.clear(); pointerHeld = false; composing = false;
    clearTimeout(agentResize?.timer); agentResize = null;
    lastUserAt = 0; lastViewport = ''; userTurn = null; lastUserTarget = null; matchedEvents = new WeakMap(); controlIterator = null; preparedOperationCursor = 0;
    document.documentElement?.removeAttribute(fenceAttribute);
    for (const el of nativeTargets) {
      el.removeAttribute?.('data-webbrain-native-action');
      el.removeAttribute?.('data-webbrain-native-target');
    }
    nativeTargets.clear();
    observer?.disconnect(); observer = null;
    layoutObserver?.disconnect(); layoutObserver = null;
    clearTimeout(domTimer); clearTimeout(scrollTimer); clearInterval(controlTimer); domTimer = null; scrollTimer = null; controlTimer = null; unreported = 0; interventionUnreported = 0; interventionRevision = 0; pendingDOM = null; lastFeedbackDelivery = Promise.resolve();
    listeners.splice(0).forEach(remove => remove());
    operations.clear(); modelSnapshots.clear(); localOperation = null; agentTurn = null;
    animationAttribution = new WeakMap();
    agentLayoutHistory.length = 0;
    roots = new WeakSet(); signatures = new WeakMap(); controlSignatures = new WeakMap(); textSignatures = new WeakMap(); popoverTurns = new WeakMap(); controlReferences.clear(); controlIterator = null;
  }
  async function requestState() {
    const generation = ++requestGeneration;
    try {
      const state = await api.runtime.sendMessage({ target: 'background', action: 'get_page_monitor_state', documentToken,
        frameName: compact(window.name.slice(0, 256), 256) });
      if (generation === requestGeneration && !disposed) {
        if (state?.active) start(state);
        else stop();
      }
    } catch { stop(); }
  }
  function prepare(params) {
    const expected = params.expectedModelSnapshot !== undefined;
    if (!active || params.runToken !== runToken) return expected ? { modelBindingValid: false } : {};
    flushPendingMutations();
    prune();
    const previous = operations.get(params.operationId);
    // A content preflight can start the transport without sending input.
    // Its later native prepare must retain the first inference's proof until
    // an actual action was dispatched, even if the owner omits the snapshot.
    const inherited = !expected && previous?.preparedBinding?.model === true && !previous.dispatched;
    const target = resolveTarget(params);
    const focusEligible = kindFor(params.tool) === 'input' || modelFocusTools.has(params.tool);
    const focusTarget = target || (focusEligible ? deepActiveElement() : null);
    const coordinateSensitive = Number.isFinite(params.x) && Number.isFinite(params.y);
    const coordinateHit = coordinateSensitive ? document.elementFromPoint(params.x, params.y) : null;
    const coordinateTarget = coordinateSensitive ? target || coordinateHit : null;
    const coordinateTargetAtPoint = !target || !coordinateHit || target === coordinateHit || target.contains?.(coordinateHit);
    const operationTarget = target || focusTarget;
    const certified = expected ? modelBinding(params) : inherited
      && previous.runToken === runToken && previous.until >= Date.now()
      && previous.preparedInterventionRevision === interventionRevision && lastUserAt === previous.userAt
      && !interventionUnreported && (!pendingDOM || pendingDOM.source === 'page')
      && !previous.modelBindingInvalid && !previous.layoutInvalidated
      && operationTarget === previous.preparedBinding.target
      && samePreparedBinding(previous.preparedBinding, actionFootprint(operationTarget, previous.preparedBinding.readonlyPreparation)) ? previous.preparedBinding : null;
    const proofRequired = expected || inherited;
    const allowPassiveRebase = inherited ? previous.allowPassiveRebase === true : params.allowPassiveRebase === true;
    const controlStateAtPrepare = operationTarget && /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(operationTarget.tagName)
      ? controlState(operationTarget) : undefined;
    operations.set(params.operationId, { ...params, target: operationTarget, focusTarget, focusEligible, controlStateAtPrepare,
      focusBound: inherited ? previous.focusBound : !!certified && modelFocusTools.has(params.tool)
        && !params.ref_id && !params.selector && !params.nativeTarget && !params.textMatch,
      ...(inherited ? { expectedModelSnapshot: previous.expectedModelSnapshot,
        modelBindingTool: previous.modelBindingTool || previous.tool } : {}),
      allowPassiveRebase: allowPassiveRebase && (!proofRequired || !!certified),
      modelBindingInvalid: proofRequired && !certified,
      preparedTargetSignature: operationTarget ? signature(operationTarget) : undefined, kinds: new Set(),
      preparedBinding: proofRequired ? certified : allowPassiveRebase && operationTarget ? preparedBinding(operationTarget) : null,
      preparedInterventionRevision: interventionRevision,
      preparedPageContext: JSON.stringify([location.href, document.baseURI, currentViewport(), window.scrollX, window.scrollY]),
      coordinateSensitive, coordinateTarget, coordinateHit, coordinateTargetAtPoint,
      coordinatePoint: coordinateSensitive ? { x: params.x, y: params.y } : null,
      coordinateRect: rectFor(coordinateTarget),
      until: Date.now() + 30000, dispatched: false, pointerPreparationOnly: false, selectorPreparationOnly: false, consequentialInputPending: false, userAt: lastUserAt, preparedRevision: revision });
    return proofRequired ? { modelBindingValid: !!certified } : {};
  }
  // The second argument is private producer provenance, never message/model params.
  function dispatch(params, selectorPreparationOnly = false) {
    if (!active || (params.runToken && params.runToken !== runToken)) return;
    const op = operations.get(params.operationId) || { operationId: params.operationId, userAt: lastUserAt };
    if (params.fenceOnly && !op.nativeSecret) op.nativeSecret = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    op.blurTarget ??= document.activeElement;
    op.target = resolveTarget(params) || (params.kind === 'input' ? op.focusTarget || deepActiveElement() : op.target);
    if (params.kind === 'input' && !op.focusTarget) op.focusTarget = op.target;
    if (params.kind === 'focus') { op.focusTarget = op.target; op.focusEligible = !!op.target; }
    op.x = params.x; op.y = params.y;
    if (!params.release || !op.seenEvents) op.seenEvents = new Set();
    if (!params.release) op.eventTypes = Array.isArray(params.eventTypes) ? new Set(params.eventTypes) : null;
    op.focused = params.kind === 'input'; op.kind = params.kind;
    op.nativeWheel = params.nativeWheel === true;
    // Only certified, unheld pointer movement is preparation. Once this same
    // operation has consequential input, later movement cannot downgrade it.
    const consequentialInputPending = op.consequentialInputPending === true
      || (op.dispatched && !op.finished && op.pointerPreparationOnly !== true && op.selectorPreparationOnly !== true);
    op.selectorPreparationOnly = selectorPreparationOnly === true;
    const movementEvents = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'];
    op.pointerPreparationOnly = !consequentialInputPending && params.pointerPreparationOnly === true
      && !params.fenceOnly && !params.release && params.kind === 'click' && params.navigationCandidate === false
      && passiveRebaseTools.has(op.modelBindingTool || op.tool) && op.allowPassiveRebase === true
      && op.preparedBinding?.model === true
      && !op.modelBindingInvalid && op.preparedBinding.target === op.target
      && Array.isArray(params.eventTypes) && params.eventTypes.length === movementEvents.length
      && movementEvents.every(type => params.eventTypes.includes(type));
    // History is monotonic until fresh prepare, even across finish/fence calls.
    op.consequentialInputPending = consequentialInputPending
      || (!params.fenceOnly && !op.pointerPreparationOnly && !op.selectorPreparationOnly);
    if (!params.release) op.navigationCandidate = params.kind === 'click' && params.navigationCandidate !== false;
    op.scrollAncestors = params.addScrollTarget ? op.scrollAncestors || new Set() : new Set();
    if (params.scrollIntoView || params.nativeWheel || ['input', 'click'].includes(params.kind)) {
      if (params.addScrollTarget && op.target) op.scrollAncestors.add(op.target);
      for (let node = op.target?.parentElement || op.target?.getRootNode?.().host; node; node = node.parentElement || node.getRootNode?.().host) op.scrollAncestors.add(node);
    }
    op.windowScroll = params.scrollIntoView || (params.kind === 'scroll' && !op.target) || ['input', 'click'].includes(params.kind);
    op.kinds = new Set([params.kind, 'dom', ...(params.kind === 'input' ? ['selection'] : []), 'scroll']);
    op.until = Date.now() + (params.fenceOnly ? 30000 : 1500); op.dispatched = !params.fenceOnly; op.finished = false;
    if (op.dispatched && op.target) {
      op.targetRectAtDispatch = rectFor(op.target);
      op.targetParentAtDispatch = op.target.parentElement;
      op.layoutRect ||= op.targetRectAtDispatch;
    }
    operations.set(op.operationId, op);
  }
  function activatePreparedDispatch(params = {}) {
    const op = operations.get(params.operationId);
    flushPendingMutations(op);
    sampleFormControls(op?.target);
    const layoutChanged = coordinatePreparationShifted(op);
    const bindingChanged = preparedBindingChanged(op);
    const rebased = !layoutChanged && rebasePassivePreparation(op, params);
    if (!active || !op || op.modelBindingInvalid || layoutChanged || bindingChanged || (!rebased && (domTimer || unreported))
        || (params.element && op.target !== params.element)
        || lastUserAt > op.userAt
        || (Number.isFinite(op.preparedRevision) && op.preparedRevision !== revision)) {
      const error = new Error('Browser changed during action preparation. Re-observe before acting.');
      error.code = 'page_feedback_pending';
      error.dispatched = false;
      throw error;
    }
    dispatch({ ...params, runToken });
    publishRevision();
    return { ready: true, operationId: op.operationId, revision };
  }
  function validateNativeDispatch(params = {}) {
    const op = operations.get(params.operationId);
    flushPendingMutations(op);
    sampleFormControls(op?.target);
    const currentFocus = deepActiveElement();
    const rebindingFocus = params.rebindFocus === true;
    const fileAssignment = op?.target?.tagName === 'INPUT' && op.target.type === 'file';
    // A companion validates once before writing its marker and again before
    // the native key. Revalidating the same consumed Tab rebind is safe only
    // while its native sequence and exact deeply focused node remain current.
    const focusRebindAvailable = rebindingFocus && (op?.tabFocusRebindAllowed === true
      || (op?.tabFocusRebound === true && op.tabFocusRebindSequence === op.nativeSequence && currentFocus === op.focusTarget));
    if (op?.kind === 'input' && !fileAssignment && (rebindingFocus
      ? !(op.nativeSequence > 0) || !focusRebindAvailable || !currentFocus || currentFocus === document.body || currentFocus === document.documentElement
      : currentFocus !== op.focusTarget)) return false;
    const shifted = coordinatePreparationShifted(op);
    const bindingChanged = preparedBindingChanged(op, { allowFocusRebind: focusRebindAvailable });
    const preparedRevision = op?.preparedRevision;
    const suppliedRevisionMatches = Number(params.revision) === preparedRevision;
    const rebased = suppliedRevisionMatches && !shifted && rebasePassivePreparation(op, params);
    if (!active || params.runToken !== runToken || params.documentToken !== documentToken || !op || op.modelBindingInvalid || shifted || bindingChanged
        || !suppliedRevisionMatches || op.preparedRevision !== revision
        || (!rebased && (domTimer || unreported)) || lastUserAt > op.userAt) return false;
    if (params.rebindFocus === true) {
      op.target = currentFocus;
      op.focusTarget = currentFocus;
      op.tabFocusRebindAllowed = false;
      op.tabFocusRebound = true;
      op.tabFocusRebindSequence = op.nativeSequence;
    }
    return true;
  }
  function withPreparedDispatch(operationId, callback) {
    const op = operations.get(operationId);
    if (!op?.dispatched || typeof callback !== 'function') return callback?.();
    const previous = op.synchronous;
    op.synchronous = true;
    try { return callback(); }
    finally {
      op.synchronous = previous;
      // Native editing can move following siblings; record the causal size
      // change now, before the browser reports its layout shift asynchronously.
      rememberAgentLayout(op);
    }
  }
  const localMutations = new Set(['click', 'click_ax', 'type', 'type_ax', 'set_field', 'set_checked', 'press_keys', 'scroll',
    'hover', 'drag_drop', 'patch_element', 'revert_patch', 'highlight_element', 'execute_js',
    'ax_prepare_field_for_trusted_type', 'ax_resolve_two_rects', 'ax_resolve_rect']);
  function beginContentAction(action, params = {}) {
    // Internal DraftJS paste is the same ref-bound input operation as type_ax.
    // Keep its focus and synchronous editor changes inside the normal input owner.
    if (action === 'ax_paste_draft') action = 'type_ax';
    if (!active || !localMutations.has(action)
        || (action === 'ax_resolve_rect' && params.observeOnly === true && params.forClickFallback === true)) return () => {};
    const operationId = `local-${randomToken()}`;
    const previous = localOperation;
    const target = resolveTarget({ ...params, textMatch: action === 'click' ? params.text : undefined })
      || (kindFor(action) === 'input' ? deepActiveElement() : null);
    const approved = [...operations.values()].reverse().find(op => op.allowPassiveRebase === true && !op.dispatched
      && op.preparedBinding?.target === target && op.until >= Date.now()
      && op.preparedInterventionRevision === interventionRevision && lastUserAt <= op.userAt && !interventionUnreported
      && (!pendingDOM || pendingDOM.source === 'page')
      && samePreparedBinding(op.preparedBinding, operationBinding(op, target)));
    prepare({ selector: params.selector, ref_id: params.ref_id, x: params.x, y: params.y,
      textMatch: action === 'click' ? params.text : undefined, tool: action, operationId, runToken,
      ...(params.expectedModelSnapshot !== undefined || approved?.expectedModelSnapshot !== undefined
        ? { expectedModelSnapshot: params.expectedModelSnapshot ?? approved.expectedModelSnapshot } : {}),
      allowPassiveRebase: params.allowPassiveRebase === true || !!approved });
    if (approved?.preparedBinding?.model === true) {
      const local = operations.get(operationId);
      if (local) {
        local.preparedBinding = approved.preparedBinding;
        local.modelBindingTool = approved.modelBindingTool || approved.tool;
        local.expectedModelSnapshot = approved.expectedModelSnapshot;
        local.focusBound = approved.focusBound;
        local.modelBindingInvalid = false;
        local.allowPassiveRebase = true;
      }
    }
    localOperation = { operationId, kind: kindFor(action), userAt: lastUserAt, revision,
      navigationCandidate: ['click', 'click_ax', 'set_checked'].includes(action),
      scrollIntoView: /^ax_resolve|ax_prepare_field/.test(action) };
    // Do not mark a BiDi preparation probe as actual input.
    if (!params._bidiPrepare) beforeLocalDispatch({ preparation: true });
    return () => {
      const op = operations.get(operationId);
      if (op) { op.until = Date.now() + 200; op.finished = true; }
      localOperation = previous;
    };
  }
  function beforeLocalDispatch({ preparation = false, kind, target } = {}) {
    if (!active || !localOperation) return;
    const operation = operations.get(localOperation.operationId);
    flushPendingMutations(operation);
    sampleFormControls(operation?.target);
    const layoutChanged = coordinatePreparationShifted(operation);
    const bindingChanged = preparedBindingChanged(operation);
    const rebased = !layoutChanged && rebasePassivePreparation(operation, { element: target });
    if (rebased) localOperation.revision = operation.preparedRevision;
    if (operation?.modelBindingInvalid || layoutChanged || bindingChanged || (!rebased && (domTimer || unreported)) || lastUserAt > localOperation.userAt || revision !== localOperation.revision) {
      const error = new Error('Browser changed during action preparation. Re-observe before acting.');
      error.code = 'page_feedback_pending'; error.dispatched = localOperation.started === true; throw error;
    }
    if (!preparation) {
      localOperation.started = true;
      const marker = { userAt: lastUserAt }; agentTurn = marker;
      setTimeout(() => { if (agentTurn === marker) agentTurn = null; }, 0);
    }
    dispatch({ ...localOperation, kind: kind || localOperation.kind, element: target,
      scrollIntoView: localOperation.scrollIntoView || (kind === 'scroll' && !!target),
      addScrollTarget: kind === 'scroll' && !!target,
      navigationCandidate: !preparation && localOperation.navigationCandidate,
      fenceOnly: preparation, runToken });
  }
  function withLocalDispatch(callback) {
    beforeLocalDispatch();
    const op = operations.get(localOperation?.operationId);
    if (!op) return callback();
    // One synchronous native edit can emit repeated input phases (multiline
    // execCommand). Attribute only its target until the command returns, never
    // across an asynchronous preparation or settling wait.
    const previous = op.synchronous;
    op.synchronous = true;
    try { return callback(); }
    finally { op.synchronous = previous; }
  }
  function captureLocalInputObservation(target) {
    const owner = localOperation, op = operations.get(owner?.operationId);
    const token = runToken, stamp = documentToken, userAt = lastUserAt;
    const invalidation = () => {
      if (!active) return 'monitor_inactive';
      if (runToken !== token) return 'run_changed';
      if (documentToken !== stamp) return 'document_changed';
      if (!owner || !op || localOperation !== owner || operations.get(owner.operationId) !== op) return 'operation_changed';
      if (owner.started !== true || !op.dispatched || op.finished || op.kind !== 'input') return 'operation_inactive';
      if (!(op.until >= Date.now())) return 'operation_expired';
      if (op.target !== target || !target?.isConnected || target.ownerDocument !== document) return 'target_changed';
      if (lastUserAt !== userAt) return 'user_intervention';
      if (op.modelBindingInvalid) return 'model_binding_invalid';
      if (deepActiveElement() !== target) return 'focus_changed';
      return '';
    };
    // This certifies the exact current native draft, not delivery or unrelated
    // page state. Global intervention/revision debt remains unchanged and still
    // fences every later dispatch against its own fresh model observation.
    // The caller separately verifies the exact native peer/node scope and text.
    const verify = () => {
      verify.reason = invalidation();
      verify.diagnostic = verify.reason === 'unknown_intervention' ? interventionDiagnostic : '';
      if (verify.reason) return false;
      flushPendingMutations(op); sampleFormControls(op.target);
      const selection = target.getRootNode?.().getSelection?.() || window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      verify.reason = invalidation() || (!range || !target.contains(range.startContainer) || !target.contains(range.endContainer) ? 'selection_changed' : '');
      verify.diagnostic = verify.reason === 'unknown_intervention' ? interventionDiagnostic : '';
      return !verify.reason;
    };
    return verify;
  }
  const onMessage = (msg, _sender, respond) => {
    if (disposed || msg?.target !== 'content') return;
    if (msg.action === 'page_monitor_state') {
      if (msg.active) {
        void requestState().then(() => respond({ ready: true, active, documentToken, runToken: active ? runToken : '' }));
        return true;
      }
      else if (!msg.runToken || msg.runToken === runToken) { requestGeneration++; stop(); respond({ ready: true }); }
    } else if (msg.action === 'page_monitor_capture_model') { respond(captureModel(msg.params || {})); }
    else if (msg.action === 'page_monitor_validate_model') {
      const params = msg.params || {};
      flushPendingMutations(); sampleFormControls();
      const result = modelBindingResult(params);
      respond({ ready: !!result.binding, ...(result.uncertified ? { uncertified: true } : {}),
        ...(result.reason ? { reason: result.reason } : {}), runToken, documentToken, snapshotToken: params.snapshotToken });
    }
    else if (msg.action === 'page_monitor_prepare') { respond({ ready: true, ...prepare(msg.params || {}) }); }
    else if (msg.action === 'page_monitor_resize_begin') { respond({ ready: beginAgentResize(msg.params || {}) }); }
    else if (msg.action === 'page_monitor_resize_finish') {
      void finishAgentResize(msg.params || {}).then(respond, () => respond({ ready: false })); return true;
    }
    else if (msg.action === 'page_monitor_validate') {
      const ready = validateNativeDispatch(msg.params || {});
      respond({ ready, ...(ready ? { revision } : {}) });
    }
    else if (msg.action === 'page_monitor_dispatch') {
      const params = msg.params || {};
      const prepared = operations.get(params.operationId);
      if (!params.release) { flushPendingMutations(prepared); sampleFormControls(prepared?.target); }
      const layoutChanged = !params.release && active && coordinatePreparationShifted(prepared);
      const bindingChanged = !params.release && preparedBindingChanged(prepared);
      const rebased = !params.release && !layoutChanged && rebasePassivePreparation(prepared, params);
      if (!params.release && active && (prepared?.modelBindingInvalid || layoutChanged || bindingChanged || (!rebased && (domTimer || unreported)) || (prepared && prepared.preparedRevision !== revision)
          || (params.documentToken && (params.documentToken !== documentToken || (!rebased && params.documentRevision !== revision))))) {
        // Content-free veto facts only; the existing dispatch predicate above is unchanged.
        const preparationVeto = {
          modelBindingInvalid: prepared?.modelBindingInvalid === true,
          layoutChanged: layoutChanged === true, preparedBindingChanged: bindingChanged === true,
          passiveRebased: rebased === true, pendingFeedback: !!(domTimer || unreported),
          revisionChanged: !!prepared && prepared.preparedRevision !== revision,
          documentChanged: !!params.documentToken && params.documentToken !== documentToken,
          documentRevisionChanged: !!params.documentToken && !rebased && params.documentRevision !== revision,
        };
        if (domTimer) {
          clearTimeout(domTimer); domTimer = null; const observation = pendingDOM; pendingDOM = null;
          if (observation) send(observation);
        }
        void lastFeedbackDelivery.then(() => respond({ ready: false, pageFeedbackPending: true, preparationVeto }));
        return true;
      }
      dispatch(params); publishRevision();
      respond({ ready: true, ...(active && params.runToken === runToken ? { guard: {
        documentToken, revision, operationId: params.operationId, runToken,
        navigationCandidate: params.navigationCandidate !== false,
        ...(operations.get(params.operationId)?.nativeSecret ? { nativeSecret: operations.get(params.operationId).nativeSecret } : {}),
      } } : {}) });
    }
    else if (msg.action === 'page_monitor_finish') {
      const params = msg.params || {};
      const op = operations.get(params.operationId);
      if (Object.prototype.hasOwnProperty.call(params, 'documentToken')
          && (!active || params.runToken !== runToken || params.documentToken !== documentToken || !op)) {
        respond({ ready: false }); return;
      }
      if (op) { op.until = Date.now() + 200; op.finished = true; }
      respond({ ready: true });
    }
  };
  api.runtime.onMessage.addListener(onMessage);
  window.__wbPageMonitor = { beginContentAction, beforeLocalDispatch, withLocalDispatch, captureLocalInputObservation, dispatch: params => dispatch(params), activatePreparedDispatch, withPreparedDispatch, registerDecoration, isReadonlyPreparationDecoration, currentIdentityPreparationCapture,
    get active() { return active; },
    get disposed() { return disposed; },
    dispose() { disposed = true; requestGeneration++; stop(); api.runtime.onMessage.removeListener?.(onMessage); } };
  void requestState();
  // A document restored from BFCache needs a fresh run/document handshake.
  window.addEventListener('pageshow', () => { if (!disposed && !active) void requestState(); });
})();
