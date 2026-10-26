/**
 * Markdown link sanitizer for the WebBrain sidepanel.
 *
 * Extracted from sidepanel.js so the security-critical sanitization logic
 * can be unit-tested in isolation. KEEP THIS FILE PURE JS — no chrome.* /
 * browser.* / DOM imports — so test/run.js can load it under Node.
 *
 * Threat model: the assistant text rendered into the sidepanel is
 * LLM output, and the LLM reads attacker-controlled page content (a
 * malicious page can prompt-inject the model into emitting arbitrary
 * markdown). The sidepanel renders that text via innerHTML in the
 * chrome-extension:// origin (full extension privileges), so a single
 * `[x](javascript:…)` or `[x](" onmouseover="…)` link would be RCE-grade.
 *
 * Defenses:
 *   1. URL scheme allowlist — only http(s), mailto, and relative URLs
 *      (#/...) produce an <a>. Anything else renders as plain text.
 *   2. Attribute escaping — `"` and `'` in the href are escaped so the
 *      URL can't break out of the href attribute and inject onXxx=.
 *   3. rel="noopener noreferrer" on every target=_blank link.
 *
 * The link-extraction regex matches one level of balanced parens in the
 * URL so links like https://en.wikipedia.org/wiki/Foo_(bar) round-trip.
 * Deeper nesting still truncates at the first unbalanced ')' — acceptable
 * for chat markdown.
 */

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

const MD_LINK_RE = /\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g;

/**
 * Sanitize a single markdown link. Returns either a safe <a> string or
 * the bare label text when the URL is unsafe / unrecognized.
 */
export function sanitizeLink(label, href) {
  const trimmed = String(href || '').trim();
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.\-]*):/i);
  let safeHref;
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (!SAFE_SCHEMES.has(scheme)) return label;
    safeHref = trimmed;
  } else if (trimmed.startsWith('#') || trimmed.startsWith('/')) {
    safeHref = trimmed;
  } else {
    return label;
  }
  const attrEscapedHref = safeHref.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return `<a href="${attrEscapedHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/**
 * Replace every markdown link in `text` with the sanitized HTML output of
 * sanitizeLink. Non-link text is passed through unchanged.
 */
export function sanitizeMarkdownLinks(text) {
  return String(text == null ? '' : text).replace(MD_LINK_RE, (_m, label, href, offset, source) => {
    const link = sanitizeLink(label, href);
    // Markdown images stay links, without even an indirect favicon request.
    if (source[offset - 1] !== '!') return link;
    return link.startsWith('<a ') ? link.replace(/^<a /, '<a data-no-favicon="true" ')
      : `<span data-no-favicon="true">${label}</span>`;
  });
}

// Image syntax is inert even before streaming has supplied its closing bracket
// or parenthesis. Track balanced delimiters instead of assuming a URL following
// an unfinished image is ordinary prose. Ranges include labels as well as URLs.
export function markdownImageRanges(text) {
  const source = String(text ?? '');
  const ranges = [];
  let cursor = 0;
  const balancedEnd = (start, open, close) => {
    let depth = 1;
    for (let index = start + 1; index < source.length; index++) {
      if (source[index] === '\\') { index++; continue; }
      if (source[index] === open) depth++;
      else if (source[index] === close && --depth === 0) return index + 1;
    }
    return source.length;
  };
  while ((cursor = source.indexOf('![', cursor)) !== -1) {
    const start = cursor;
    let end = balancedEnd(cursor + 1, '[', ']');
    if (source[end] === '(') end = balancedEnd(end, '(', ')');
    else if (source[end] === '[') end = balancedEnd(end, '[', ']');
    ranges.push([start, end]);
    cursor = Math.max(end, start + 2);
  }
  return ranges;
}

// Input is already HTML-escaped, with fixed Markdown markup added. Only text
// nodes are linkified: existing anchors, code and generated attributes stay intact.
export function linkifyPlainUrls(html, precedingText = '') {
  const source = String(html ?? '');
  const protectedTags = new Set(['a', 'code', 'pre']);
  let protectedDepth = 0;
  // Ignore generated tags while retaining offsets and syntax across inline
  // formatting. Literal code or existing links cannot start image syntax in
  // adjacent prose. Restored DOM text supplies earlier siblings as context.
  const imageContext = source.replace(/<[^>]*>|[^<]+|</g, token => {
    if (token.startsWith('<')) {
      const tag = /^<(\/?)([a-z][\w-]*)\b/i.exec(token);
      if (tag && protectedTags.has(tag[2].toLowerCase())) {
        protectedDepth = Math.max(0, protectedDepth + (tag[1] ? -1 : 1));
      }
      return ' '.repeat(token.length);
    }
    return protectedDepth ? ' '.repeat(token.length) : token;
  });
  const imageRanges = markdownImageRanges(precedingText + imageContext);
  protectedDepth = 0;
  return source.replace(/<[^>]*>|[^<]+|</g, (token, tokenOffset) => {
    if (token.startsWith('<')) {
      const tag = /^<(\/?)([a-z][\w-]*)\b/i.exec(token);
      if (tag && protectedTags.has(tag[2].toLowerCase())) {
        protectedDepth = Math.max(0, protectedDepth + (tag[1] ? -1 : 1));
      }
      return token;
    }
    if (protectedDepth) return token;
    return token.replace(/\bhttps?:\/\/(?:(?!&(?:lt|gt|quot|apos|#39|#34);)[^\s<>"'`])+/gi, (candidate, offset, source) => {
      const absoluteOffset = precedingText.length + tokenOffset + offset;
      if (imageRanges.some(([start, end]) => absoluteOffset >= start && absoluteOffset < end)) return candidate;
      // Do not turn a URL embedded in another scheme or word into a new link.
      if (offset && /[\w@:/]/.test(source[offset - 1])) return candidate;
      let end = candidate.length;
      const emphasis = /(?:^|[\s(\[{>])(\*{1,3})(?=\S|$)[^*\n]*$/.exec(source.slice(0, offset))?.[1];
      let closedEmphasis = false;
      const pairs = { ')': '(', ']': '[', '}': '{' };
      const balance = { '(': 0, '[': 0, '{': 0 };
      for (const character of candidate) {
        if (Object.hasOwn(balance, character)) balance[character]++;
        else if (pairs[character]) balance[pairs[character]]--;
      }
      while (end) {
        const last = candidate[end - 1];
        if (!closedEmphasis && emphasis && candidate.slice(0, end).endsWith(emphasis)) {
          end -= emphasis.length;
          closedEmphasis = true;
          continue;
        }
        if (last === ';' && /&(?:amp|#\d+|#x[\da-f]+);$/i.test(candidate.slice(0, end))) break;
        if (/[.,!?;:]/.test(last)) { end--; continue; }
        const opening = pairs[last];
        if (opening && balance[opening] < 0) { balance[opening]++; end--; continue; }
        break;
      }
      const href = candidate.slice(0, end);
      try {
        const parsed = new URL(href.replace(/&amp;/g, '&'));
        if (!parsed.hostname || !['http:', 'https:'].includes(parsed.protocol)) return candidate;
      } catch { return candidate; }
      return sanitizeLink(href, href) + candidate.slice(end);
    });
  });
}
