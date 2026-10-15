// Serialized into one dispatched iframe. No page values are used as code.
export function completionFrameSnapshot() {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none'
          || style.visibility === 'hidden' || style.visibility === 'collapse' || parseFloat(style.opacity) === 0) return false;
    }
    return true;
  };
  const messages = [];
  for (const element of Array.from(document.querySelectorAll('[role=status],[role=alert],[aria-live],dialog[open],[role=dialog],[role=alertdialog]')).slice(0, 64)) {
    if (!visible(element)) continue;
    const text = String(element.innerText || '').trim().slice(0, 160);
    if (text && !messages.includes(text)) messages.push(text);
    if (messages.length >= 6) break;
  }
  const text = String(document.body?.innerText || '').slice(0, 4000);
  // An invalid field is marked in the page's structure. What the messages
  // say is read by the agent in any language, not matched here.
  const validationFailed = Array.from(document.querySelectorAll('[aria-invalid="true"]')).some(visible);
  const fields = Array.from(document.querySelectorAll('input,textarea,select,button,[contenteditable],[aria-invalid]')).slice(0, 1000)
    .map(element => [element.tagName, element.id, element.value, element.checked, element.disabled,
      element.isContentEditable ? element.textContent : '', element.getAttribute('aria-invalid')]);
  const fingerprint = text + JSON.stringify(fields);
  let hash = 2166136261;
  for (let index = 0; index < fingerprint.length; index++) hash = Math.imul(hash ^ fingerprint.charCodeAt(index), 16777619);
  return { url: location.href, identity: [location.href, performance.timeOrigin].join('|'),
    stamp: [fingerprint.length, hash].join('|'), messages, text, validationFailed };
}
