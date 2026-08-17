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
  return quote ? `${quote}${existingDraft.trim() ? existingDraft : ''}` : existingDraft;
}

export function selectionIsQuoteable({ startTextElement, endTextElement, text } = {}) {
  return Boolean(
    startTextElement
      && startTextElement === endTextElement
      && normalizedSelectionText(text),
  );
}
