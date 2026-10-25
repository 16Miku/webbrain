// What is under a viewport point, for vision-mode dispatch checks: a double
// click that would repeat a button's action, a drag that is really a click,
// a wheel over a focused number field, a native <select>, an embedded frame
// whose content cannot be inspected. Shared verbatim by both builds.
//
// visionDomProbe runs inside the page (Chrome: an isolated world through CDP;
// Firefox: tabs.executeScript in the content-script world, so page scripts
// cannot redefine the DOM methods it calls). It is serialized with
// toString(), so it must stay self-contained: no imports, no outer names.

/**
 * @param {{points: {x:number,y:number}[], pair?: boolean, focusSelect?: boolean}} request
 *   points are CSS pixels of the top-level viewport. `pair` asks what a
 *   press at points[0] and a release at points[1] would click. `focusSelect`
 *   focuses a native <select> under points[0] (a click on it is answered
 *   with type_text instead of an OS popup no screenshot can show).
 */
export function visionDomProbe(request) {
  const CLICKABLE = [
    'a[href]', 'area[href]', 'button', 'summary', 'label', 'select', 'option', '[onclick]',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]', '[role="tab"]', '[role="checkbox"]', '[role="radio"]',
    '[role="switch"]', '[role="option"]',
    'input[type="submit"]', 'input[type="button"]', 'input[type="reset"]', 'input[type="image"]',
    'input[type="checkbox"]', 'input[type="radio"]', 'input[type="file"]', 'input[type="color"]',
  ].join(',');
  // A click inside a text field only places the caret, even when a <label>
  // or link wraps the field, so the walk up stops there.
  const TEXT_ENTRY = [
    'textarea', '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    'input:not([type])', 'input[type="text"]', 'input[type="search"]', 'input[type="email"]',
    'input[type="url"]', 'input[type="tel"]', 'input[type="password"]', 'input[type="number"]',
    'input[type="date"]', 'input[type="datetime-local"]', 'input[type="time"]', 'input[type="month"]',
    'input[type="week"]', 'input[type="range"]',
  ].join(',');
  const req = request && typeof request === 'object' ? request : {};
  // Composed parent: through shadow roots to their host and out of
  // same-origin frames to the frame element.
  const up = node => {
    if (!node) return null;
    if (node.nodeType === 9) {
      try { return (node.defaultView && node.defaultView.frameElement) || null; } catch (e) { return null; }
    }
    const parent = node.parentNode;
    if (parent && parent.nodeType === 11) return parent.host || null;
    return parent || null;
  };
  const hit = (x, y) => {
    let doc = document;
    let cx = x;
    let cy = y;
    for (let depth = 0; depth < 8; depth++) {
      let el = doc.elementFromPoint(cx, cy);
      for (let i = 0; el && el.shadowRoot && i < 8; i++) {
        const inner = el.shadowRoot.elementFromPoint(cx, cy);
        if (!inner || inner === el) break;
        el = inner;
      }
      if (!el) return { el: null, opaque: false };
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'IFRAME' || tag === 'FRAME' || tag === 'OBJECT' || tag === 'EMBED') {
        let inner = null;
        try { inner = el.contentDocument; } catch (e) { inner = null; }
        if (inner && inner.documentElement && (tag === 'IFRAME' || tag === 'FRAME')) {
          const rect = el.getBoundingClientRect();
          cx -= rect.left + (el.clientLeft || 0);
          cy -= rect.top + (el.clientTop || 0);
          doc = inner;
          continue;
        }
        // A cross-origin frame (or plugin): its content is not inspectable.
        return { el, opaque: true };
      }
      return { el, opaque: false };
    }
    return { el: null, opaque: false };
  };
  const clickableOf = node => {
    for (let n = node, i = 0; n && i < 256; n = up(n), i++) {
      if (n.nodeType === 1 && typeof n.matches === 'function') {
        try {
          if (n.matches(CLICKABLE)) return n;
          if (n.matches(TEXT_ENTRY)) return null;
        } catch (e) { /* invalid in this document */ }
      }
    }
    return null;
  };
  const points = Array.isArray(req.points) ? req.points.slice(0, 2) : [];
  const found = points.map(point => hit(Number(point && point.x), Number(point && point.y)));
  const infos = found.map((item, index) => {
    const el = item.el;
    if (!el) return { found: false };
    const control = clickableOf(el);
    const info = {
      found: true,
      tag: String(el.tagName || '').toLowerCase(),
      clickable: !!control,
      opaqueFrame: item.opaque === true,
    };
    const role = el.getAttribute ? el.getAttribute('role') : '';
    if (role) info.role = String(role).slice(0, 32);
    if (control) info.control = String(control.tagName || '').toLowerCase();
    if (typeof el.matches === 'function' && el.matches('input[type="number"]')) {
      const root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
      info.focusedNumberInput = !!root && root.activeElement === el;
    }
    const select = el.closest ? el.closest('select') : null;
    if (select && !select.multiple && !(select.size > 1)) {
      const options = Array.from(select.options || []).slice(0, 60).map(option => String(option.text || '').trim());
      const current = select.options && select.options[select.selectedIndex]
        ? String(select.options[select.selectedIndex].text || '').trim() : '';
      info.select = { current, options };
      if (index === 0 && req.focusSelect === true) {
        try { select.focus(); } catch (e) { /* focus is best effort */ }
      }
    }
    return info;
  });
  const result = { points: infos };
  if (req.pair === true && found.length === 2) {
    if (!found[0].el || !found[1].el) {
      result.pair = { known: false };
    } else {
      // The click a press and release produce goes to their nearest common
      // ancestor; it activates a control when that ancestor is (inside) one.
      const ancestors = new Set();
      for (let n = found[1].el, i = 0; n && i < 256; n = up(n), i++) ancestors.add(n);
      let common = null;
      for (let n = found[0].el, i = 0; n && i < 256; n = up(n), i++) {
        if (ancestors.has(n)) { common = n; break; }
      }
      const control = common ? clickableOf(common) : null;
      result.pair = { known: true, clickEquivalent: !!control };
      if (control) result.pair.control = String(control.tagName || '').toLowerCase();
    }
  }
  return result;
}

/** An expression that evaluates visionDomProbe(request) in a page. */
export function visionDomProbeExpression(request) {
  return `(${visionDomProbe.toString()})(${JSON.stringify(request || {})})`;
}

/** Minimum press-to-release distance (CSS px) for drag_at. */
export const VISION_MIN_DRAG_CSS_PX = 6;

/**
 * Dispatch checks shared by both builds. Each returns a no-dispatch result
 * to send back to the model, or null when the action may go ahead.
 */
export function visionMultiClickRefusal(probe, { clickCount = 1, recipientGuarded = false, submitDetected = false } = {}) {
  if (!(clickCount > 1)) return null;
  const point = probe?.points?.[0];
  const reason = recipientGuarded ? 'this is a protected messaging page'
    : submitDetected ? 'the point is a submit control'
      : !point || !point.found ? 'WebBrain could not check what is under the pointer'
        : point.opaqueFrame ? 'the point is inside an embedded frame WebBrain cannot inspect'
          : point.clickable ? `the point is on a ${point.control || 'control'}`
            : '';
  if (!reason) return null;
  return {
    success: false, dispatched: false, noDispatch: true, visionInputRefused: 'repeated_click',
    error: `Not dispatched: a ${clickCount === 2 ? 'double' : 'triple'} click was refused because ${reason}, where every extra click would repeat the control's action (for example submit twice). Use click_at with clicks: 1. Double and triple clicks are for selecting text.`,
  };
}

export function visionDragRefusal(probe, from, to) {
  const distance = Math.hypot((Number(to?.x) || 0) - (Number(from?.x) || 0), (Number(to?.y) || 0) - (Number(from?.y) || 0));
  const refuse = (code, reason) => ({
    success: false, dispatched: false, noDispatch: true, visionInputRefused: code,
    error: `Not dispatched: ${reason}`,
  });
  if (distance < VISION_MIN_DRAG_CSS_PX) {
    return refuse('drag_too_short', 'a drag this short is a click. Use click_at to click.');
  }
  if (!probe?.points || probe.points.length < 2 || !probe.pair) {
    return refuse('drag_unchecked', 'WebBrain could not check what is under the pointer. Take a screenshot and try again, or use click_at / scroll_at.');
  }
  if (probe.points.some(point => point?.opaqueFrame)) {
    return refuse('drag_opaque_frame', 'the drag starts or ends inside an embedded frame whose content WebBrain cannot inspect, so it could act as a click there. Use click_at or scroll_at instead.');
  }
  if (!probe.pair.known) {
    return refuse('drag_unchecked', 'there is nothing under one end of the drag. Choose points on the page.');
  }
  if (probe.pair.clickEquivalent) {
    return refuse('drag_is_click', `pressing and releasing there would click the ${probe.pair.control || 'control'} under both ends. Use click_at to click it; drag_at is for sliders, reordering and selecting.`);
  }
  return null;
}

export function visionWheelRefusal(probe) {
  const point = probe?.points?.[0];
  if (!point?.focusedNumberInput) return null;
  return {
    success: false, dispatched: false, noDispatch: true, visionInputRefused: 'wheel_number_input',
    error: 'Not dispatched: the point is over a focused number field, and the mouse wheel would change its value instead of scrolling. Scroll at another point, or press Escape / click elsewhere first.',
  };
}
