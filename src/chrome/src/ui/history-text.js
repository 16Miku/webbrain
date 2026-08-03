/**
 * Serialize rendered chat DOM back to readable Markdown for durable history.
 *
 * textContent intentionally ignores visual structure such as <br> and block
 * boundaries, while semantic elements such as <strong> have already consumed
 * their Markdown markers. Walking the DOM preserves both forms of structure.
 * Keep this module DOM-global-free so its traversal can be unit-tested in Node.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE']);

export function historyTextFromElement(root, { markdown = true } = {}) {
  if (!root) return '';
  let output = '';

  const trimTrailingHorizontalSpace = () => {
    output = output.replace(/[ \t]+$/g, '');
  };

  const appendHardBreak = () => {
    trimTrailingHorizontalSpace();
    output += '\n';
  };

  const ensureBreak = () => {
    trimTrailingHorizontalSpace();
    if (output && !output.endsWith('\n')) output += '\n';
  };

  const visit = (node, isRoot = false, inPre = false) => {
    if (!node) return;
    if (node.nodeType === TEXT_NODE) {
      output += String(node.nodeValue ?? node.textContent ?? '');
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;

    const tagName = String(node.tagName || '').toUpperCase();
    if (SKIPPED_TAGS.has(tagName)) return;
    if (node.classList?.contains?.('code-block-header')) return;
    if (tagName === 'BR') {
      // Every rendered <br> represents a source newline, including consecutive
      // <br>s used for blank lines. Do not deduplicate these hard breaks.
      appendHardBreak();
      return;
    }
    if (tagName === 'HR') {
      ensureBreak();
      output += '---';
      appendHardBreak();
      return;
    }

    if (markdown && /^H[1-6]$/.test(tagName)) {
      ensureBreak();
      output += `${'#'.repeat(Number(tagName.slice(1)))} `;
      for (const child of Array.from(node.childNodes || [])) visit(child);
      ensureBreak();
      return;
    }
    if (markdown && tagName === 'PRE') {
      const language = String(node.parentElement?.querySelector?.('.code-lang')?.textContent || '').trim();
      ensureBreak();
      output += `\`\`\`${language}\n`;
      for (const child of Array.from(node.childNodes || [])) visit(child, false, true);
      ensureBreak();
      output += '```';
      return;
    }
    if (markdown && tagName === 'CODE' && !inPre) {
      output += '`';
      for (const child of Array.from(node.childNodes || [])) visit(child);
      output += '`';
      return;
    }
    if (markdown && (tagName === 'STRONG' || tagName === 'B')) {
      output += '**';
      for (const child of Array.from(node.childNodes || [])) visit(child, false, inPre);
      output += '**';
      return;
    }
    if (markdown && (tagName === 'EM' || tagName === 'I')) {
      output += '*';
      for (const child of Array.from(node.childNodes || [])) visit(child, false, inPre);
      output += '*';
      return;
    }
    if (markdown && tagName === 'A') {
      const href = String(node.getAttribute?.('href') || '');
      if (href) output += '[';
      for (const child of Array.from(node.childNodes || [])) visit(child, false, inPre);
      if (href) output += `](${href})`;
      return;
    }

    const isBlock = !isRoot && BLOCK_TAGS.has(tagName);
    const isRenderedCodeBlock = markdown && node.classList?.contains?.('code-block-wrapper');
    if (isBlock) ensureBreak();
    for (const child of Array.from(node.childNodes || [])) visit(child, false, inPre);
    // formatMarkdown leaves the source newline after a fenced block as a
    // sibling <br>. Do not also synthesize a block-boundary newline here.
    if (isBlock && !isRenderedCodeBlock) ensureBreak();
  };

  visit(root, true);
  return output;
}
