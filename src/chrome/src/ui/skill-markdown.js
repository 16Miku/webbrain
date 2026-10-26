/**
 * Small, dependency-free Markdown formatter for read-only skill previews and
 * saved chat history. All source HTML is escaped before fixed markup is added.
 */

import { escapeHtml } from './utils.js';
import { sanitizeMarkdownLinks, linkifyPlainUrls } from './markdown-link.js';
import { createMarkdownPlaceholders, renderMarkdownHeadings, renderMarkdownTables, replaceMarkdownCodeFences } from './markdown-render.js';

function renderEmphasis(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function renderInlineMarkdown(value, placeholders) {
  let text = sanitizeMarkdownLinks(value);
  text = linkifyPlainUrls(text);

  // Link destinations can legitimately contain `*`. Protect the complete
  // sanitized anchor while applying emphasis only to its visible label.
  text = text.replace(
    /(<a\b[^>]*>)([\s\S]*?)(<\/a>)/g,
    (_match, open, label, close) => placeholders.add(`${open}${/^https?:\/\/\S+$/i.test(label) ? label : renderEmphasis(label)}${close}`),
  );

  return renderEmphasis(text);
}

export function renderSkillMarkdown(content) {
  let text = String(content || '');
  const placeholders = createMarkdownPlaceholders(text);
  text = replaceMarkdownCodeFences(text, (_info, code) => placeholders.add(`<pre><code>${escapeHtml(code)}</code></pre>`, code));
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => placeholders.add(`<code>${escapeHtml(code)}</code>`, code));

  text = escapeHtml(text);

  text = renderMarkdownTables(text);

  text = text.replace(/(?:^[ \t]*&gt;[^\r\n]*(?:\r?\n|$))+/gm, (block) => {
    const quote = block.trimEnd().split(/\r?\n/)
      .map((line) => line.replace(/^[ \t]*&gt;[ \t]?/, ''))
      .join('\n');
    return `${placeholders.add(`<blockquote>${renderInlineMarkdown(quote, placeholders).replace(/\n/g, '<br>')}</blockquote>`)}\n`;
  });

  // Pull list markers out before parsing emphasis so a `*` bullet cannot be
  // paired with an emphasis marker later in the same item.
  const extractLists = (input, pattern, tag, markerPattern) => input.replace(pattern, (block) => {
    const items = block.trimEnd().split(/\r?\n/)
      .map((line) => line.replace(markerPattern, '').trim());
    return `${placeholders.add(`<${tag}>${items.map((item) => `<li>${renderInlineMarkdown(item, placeholders)}</li>`).join('')}</${tag}>`)}\n`;
  });
  text = extractLists(text, /(?:^[ \t]*[-+*][ \t]+[^\r\n]*(?:\r?\n|$))+/gm, 'ul', /^[ \t]*[-+*][ \t]+/);
  text = extractLists(text, /(?:^[ \t]*\d+\.[ \t]+[^\r\n]*(?:\r?\n|$))+/gm, 'ol', /^[ \t]*\d+\.[ \t]+/);

  text = renderInlineMarkdown(renderMarkdownHeadings(text), placeholders).replace(/\n/g, '<br>');
  return placeholders.restore(text);
}
