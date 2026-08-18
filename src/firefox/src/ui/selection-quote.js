const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const QUOTE_CHROME_TAGS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SCRIPT', 'STYLE', 'TEMPLATE']);
const QUOTE_CHROME_CLASSES = new Set(['code-block-header', 'code-copy-btn', 'code-lang', 'msg-copy-btn']);

function normalizedSelectionText(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
}

function classListContains(node, className) {
  if (node?.classList?.contains?.(className)) return true;
  const classNameValue = typeof node?.className === 'string' ? node.className : '';
  return classNameValue.split(/\s+/).includes(className);
}

export function isSelectionQuoteChrome(node) {
  if (!node || node.nodeType !== ELEMENT_NODE) return false;
  if (QUOTE_CHROME_TAGS.has(String(node.tagName || '').toUpperCase())) return true;
  for (const className of QUOTE_CHROME_CLASSES) {
    if (classListContains(node, className)) return true;
  }
  return false;
}

function collectSelectionQuoteText(node) {
  if (!node) return '';
  if (node.nodeType === TEXT_NODE) return String(node.nodeValue ?? node.textContent ?? '');
  if (node.nodeType !== ELEMENT_NODE) return '';
  if (isSelectionQuoteChrome(node)) return '';
  if (String(node.tagName || '').toUpperCase() === 'BR') return '\n';
  let text = '';
  for (const child of node.childNodes || []) text += collectSelectionQuoteText(child);
  return text;
}

export function selectionTextFromContents(root) {
  return normalizedSelectionText(collectSelectionQuoteText(root));
}

export function selectionTextFromRange(range) {
  if (!range) return '';
  if (typeof range.cloneContents === 'function') {
    return selectionTextFromContents(range.cloneContents());
  }
  return normalizedSelectionText(range.toString?.() || '');
}

export function buildSelectionQuote(text) {
  const selection = normalizedSelectionText(text);
  if (!selection) return '';
  return `${selection.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
}

export function buildSelectionComposerDraft(selectionText, draft = '') {
  const quote = buildSelectionQuote(selectionText);
  const existingDraft = String(draft == null ? '' : draft);
  if (!quote || existingDraft.startsWith(quote)) return existingDraft;
  return `${quote}${existingDraft}`;
}

export function selectionIsQuoteable({ startTextElement, endTextElement, text } = {}) {
  // A range spanning two bubbles has no unambiguous answer boundary.
  return Boolean(
    startTextElement
      && startTextElement === endTextElement
      && normalizedSelectionText(text),
  );
}
