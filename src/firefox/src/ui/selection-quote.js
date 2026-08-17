function normalizedSelectionText(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
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
