// Runs in the content script's isolated world. This is observation only: the
// independent completion judge still decides whether it establishes success.
export async function completionResultSnapshot(actionRef) {
  const target = window.__wbElementMap?.[actionRef]?.deref?.();
  if (!target?.isConnected || typeof window.__wb_ax_ref !== 'function') return null;
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const intersects = (a, b) => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  const visible = element => {
    if (!element?.isConnected) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.inert
          || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
          || Number(style.opacity) === 0) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && intersects(rect, viewport);
  };
  if (!visible(target)) return null;
  const editors = 'textarea,[contenteditable="true"],[contenteditable=""],[role="textbox"]';
  const visibleText = root => {
    const lines = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let node, count = 0;
    while ((node = walker.nextNode()) && count++ < 2000) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,noscript,textarea,input,select,[contenteditable="true"],[contenteditable=""],[role="textbox"]')
          || !visible(parent)) continue;
      const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      range.selectNodeContents(node);
      const shown = Array.from(range.getClientRects()).some(rect => {
        if (!intersects(rect, viewport) || !intersects(rect, root.getBoundingClientRect())) return false;
        for (let clip = parent; clip && clip !== root.parentElement; clip = clip.parentElement) {
          const style = getComputedStyle(clip);
          if (/(hidden|clip|auto|scroll)/.test(style.overflow + style.overflowX + style.overflowY)
              && !intersects(rect, clip.getBoundingClientRect())) return false;
        }
        return true;
      });
      // Separate sentences before credential redaction, so a warning about
      // passwords cannot erase the whole conversation's unrelated evidence.
      if (shown) lines.push(text.replace(/([.!?。！？])\s+/gu, '$1\n'));
    }
    range.detach?.();
    const text = lines.join('\n');
    return { text: text.slice(0, 6000), truncated: !!node || text.length > 6000 };
  };
  // Keep the bounded conversation including its header, stopping before the
  // whole page or another composer. A form alone contains no sent result.
  let candidate = null, candidateRoot = null;
  for (let root = target.parentElement, depth = 0; root && depth++ < 12; root = root.parentElement) {
    if (/^(BODY|HTML|MAIN)$/.test(root.tagName)) break;
    if (!visible(root)) continue;
    const rect = root.getBoundingClientRect();
    if (rect.width > innerWidth * .9 || rect.height > innerHeight * .98 || rect.height < 160) continue;
    const fields = Array.from(root.querySelectorAll(editors)).filter(visible);
    if (fields.length > 1) break;
    if (fields.length !== 1) continue;
    const observation = visibleText(root);
    if (observation.text.length < 4) continue;
    const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
    candidate = { identity: [location.href, performance.timeOrigin].join('|'),
      rect: { x, y, width: Math.min(innerWidth, rect.right) - x, height: Math.min(innerHeight, rect.bottom) - y },
      viewport: { width: innerWidth, height: innerHeight },
      scopeRef: String(window.__wb_ax_ref(root)), composerEmpty: !String(fields[0].value ?? fields[0].textContent ?? '').trim(), ...observation };
    candidateRoot = root;
  }
  if (!candidate || !globalThis.crypto?.subtle) return null;
  // Control values are deliberately omitted from the judge's text. Bind them
  // locally anyway: a non-empty bio or selected option can change while both
  // the visible result and composerEmpty stay the same. Only the digest leaves
  // this isolated world, and the runtime never sends it to the judge.
  const controls = candidateRoot.querySelectorAll('input,textarea,select,option,button,[contenteditable],[role]');
  if (controls.length > 1000) return null;
  const state = Array.from(controls, element => {
    const editable = element.getAttribute('contenteditable');
    const attributes = Array.from(element.attributes).filter(attribute => attribute.name.startsWith('aria-')
      || ['role', 'hidden', 'inert', 'disabled', 'readonly', 'required', 'type', 'name'].includes(attribute.name));
    return [element.tagName, String(window.__wb_ax_ref(element)), element.id, element.value,
      element.checked, element.indeterminate, element.disabled, element.readOnly, element.required,
      element.selected, element.selectedIndex,
      editable !== null && editable !== 'false' || element.getAttribute('role') === 'textbox' ? element.textContent : null,
      attributes.map(attribute => [attribute.name, attribute.value]).sort()];
  });
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(state)));
    candidate.controlFingerprint = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
  return candidate;
}

// Capture bytes may be at device scale or already normalized. Use the decoded
// image dimensions, never a guessed DPR, and refuse an invalid crop.
export function completionResultPixelRect(rect, viewport, width, height) {
  if (![rect?.x, rect?.y, rect?.width, rect?.height, viewport?.width, viewport?.height, width, height].every(Number.isFinite)
      || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0
      || width <= 0 || height <= 0 || rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height) return null;
  const x = Math.round(rect.x * width / viewport.width), y = Math.round(rect.y * height / viewport.height);
  const right = Math.round((rect.x + rect.width) * width / viewport.width), bottom = Math.round((rect.y + rect.height) * height / viewport.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
