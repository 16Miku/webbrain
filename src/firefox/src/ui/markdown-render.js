/**
 * Small, dependency-free helpers for the sidepanel's chat Markdown output.
 * Highlighting always escapes source code before adding fixed token spans.
 */

const LANGUAGE_ALIASES = Object.freeze({
  js: 'javascript', javascript: 'javascript', jsx: 'javascript',
  ts: 'javascript', typescript: 'javascript', tsx: 'javascript',
  css: 'css', scss: 'css', less: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  json: 'json', jsonc: 'json',
  py: 'python', python: 'python',
  sh: 'shell', shell: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  c: 'clike', h: 'clike', cpp: 'clike', 'c++': 'clike',
  cs: 'clike', 'c#': 'clike', java: 'clike', kotlin: 'clike', kt: 'clike',
  go: 'clike', rust: 'clike', rs: 'clike', swift: 'clike',
  php: 'clike', ruby: 'clike', rb: 'clike',
});

const JS_KEYWORDS = new Set(('abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch throw try type typeof var void while with yield').split(' '));
const JS_CONSTANTS = new Set(('true false null undefined NaN Infinity').split(' '));
const JS_BUILTINS = new Set(('Array BigInt Boolean Date Error Intl JSON Map Math Number Object Promise Proxy Reflect RegExp Set String Symbol WeakMap WeakSet console document globalThis window').split(' '));
const PYTHON_KEYWORDS = new Set(('and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield').split(' '));
const PYTHON_BUILTINS = new Set(('bool bytes dict enumerate filter float int len list map max min open print range reversed set sorted str sum super tuple type zip').split(' '));
const SHELL_KEYWORDS = new Set(('case do done elif else esac export fi for function if in local readonly select then time until while').split(' '));
const CLIKE_KEYWORDS = new Set(('abstract alignas async await bool break byte case catch char class const constexpr continue default defer delete do double else enum explicit export extends extern false final finally float fn for foreach from func function go goto if implements import in inline int interface internal is let long match namespace new nil null nullptr operator override package private protected protocol public raise readonly ref return sealed short signed sizeof static struct super switch template this throw throws trait true try type typedef typeof union unsigned use using var virtual void volatile where while yield').split(' '));
const CLIKE_TYPES = new Set(('Array Boolean Error List Map Object Option Promise Result Set String Vec').split(' '));
const CSS_BUILTINS = new Set(('calc clamp currentColor inherit initial linear-gradient min max none radial-gradient repeat revert transparent unset url var').split(' '));

const JS_TOKENS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^\\`])*`|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\b(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)n?\b|\b[A-Za-z_$][\w$]*\b|===|!==|=>|\?\?|\?\.|\+\+|--|&&|\|\||[+\-*\/%=&|^!<>?:~]+|[{}\[\]();,.]/g;
const CSS_TOKENS = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|#[\da-fA-F]{3,8}\b|[.#][-_a-zA-Z][\w-]*|@[\w-]+|--[\w-]+|-?\d*\.?\d+(?:[a-zA-Z%]+)?|-?[_a-zA-Z][\w-]*|[{}[\]():;,>+~*=!]/g;
const MARKUP_TOKENS = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?[A-Za-z][^>]*>|&(?:#\d+|#x[\da-fA-F]+|[A-Za-z][\w]+);/gi;
const JSON_TOKENS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b|[{}[\],:]/g;
const PYTHON_TOKENS = /#[^\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|@[A-Za-z_][\w.]*|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?j?\b|\b[A-Za-z_]\w*\b|:=|==|!=|<=|>=|\*\*|\/\/|->|[-+*\/%=&|^~<>:]+|[{}\[\]();,.]/g;
const SHELL_TOKENS = /#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\$\{[^}]+\}|\$[A-Za-z_][\w]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|&&|\|\||<<|>>|;;|[-+*\/%=&|!<>]+|[{}\[\]();]/g;
const SQL_TOKENS = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|<>|!=|<=|>=|::|[-+*\/%=<>]+|[(),.;]/gi;
const YAML_TOKENS = /#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:''|[^'])*'|&[\w-]+|\*[\w-]+|![\w!-]+|-?\b\d+(?:\.\d+)?\b|\b(?:true|false|null|yes|no|on|off)\b|(?:^|\n)[ \t-]*[\w.-]+(?=\s*:)|[\[\]{},:|>]/gi;
const CLIKE_TOKENS = /^[ \t]*#[^\n]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\$[A-Za-z_]\w*|\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b[A-Za-z_]\w*\b|::|=>|->|===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|[-+*\/%=&|^!<>?:~]+|[{}\[\]();,.]/gm;

export function escapeCodeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

export function normalizeCodeLanguage(language) {
  return LANGUAGE_ALIASES[String(language || '').trim().toLowerCase()] || '';
}

export function codeFenceLanguage(infoString) {
  return String(infoString || '').trim().split(/\s+/, 1)[0] || '';
}

function fenceContainer(prefix, indentation = '') {
  const source = String(prefix);
  const quotePrefix = quotePrefixAt(source);
  let remainder = source;
  let listPrefix = '';
  let quoteDepth = 0;
  let overIndentedQuote = false;
  let lastListMarkerWidth = 0;
  let lastListPrefixWidth = 0;
  const listIndentGroups = [0];
  while (remainder) {
    const containerStartColumn = indentationColumns(source.slice(0, source.length - remainder.length));
    // Preserve a deeply indented quote only long enough to resolve a
    // continuation from an enclosing list; it is never a container itself.
    const quote = quoteMarkerAt(remainder, containerStartColumn, true);
    if (quote) {
      quoteDepth += 1;
      overIndentedQuote ||= quote.overIndented;
      listIndentGroups.push(0);
      remainder = remainder.slice(quote.length);
      continue;
    }
    const list = listPrefixAt(remainder, containerStartColumn);
    if (!list) break;
    listPrefix += list;
    lastListPrefixWidth = indentationColumnsAt(list, containerStartColumn) - containerStartColumn;
    lastListMarkerWidth = indentationColumnsAt(list.replace(/[ \t]+$/, ''), containerStartColumn) - containerStartColumn;
    const implicitListPadding = !/[ \t]$/.test(list) && remainder === list ? 1 : 0;
    listIndentGroups[listIndentGroups.length - 1] += indentationColumnsAt(list, containerStartColumn) - containerStartColumn
      + implicitListPadding;
    remainder = remainder.slice(list.length);
  }
  return {
    containerPrefix: source.slice(0, source.length - remainder.length),
    quotePrefix,
    quoteDepth,
    listPrefix,
    lastListMarkerWidth,
    lastListPrefixWidth,
    listIndentGroups,
    overIndentedQuote,
    leadingQuoteIndent: indentationColumns(source.match(/^[ \t]*(?=>)/)?.[0] || ''),
    rawPrefix: source,
    indentation: String(indentation),
  };
}

function indentationColumnsAt(value, startColumn = 0) {
  let columns = startColumn;
  for (const character of String(value)) {
    columns += character === '\t' ? 4 - (columns % 4) : 1;
  }
  return columns;
}

function indentationColumns(value) {
  return indentationColumnsAt(value);
}

function listPrefixAt(value, startColumn = 0) {
  const source = String(value);
  const marker = source.match(/^[ \t]*(?:[-+*]|\d{1,9}[.)])/);
  const leadingIndentation = marker?.[0].match(/^[ \t]*/)?.[0] || '';
  const next = source[marker?.[0].length];
  if (!marker
    || indentationColumnsAt(leadingIndentation, startColumn) - startColumn > 3
    || (next && !/^[ \t]$/.test(next))) return null;
  let offset = marker[0].length;
  let column = indentationColumnsAt(marker[0], startColumn);
  let paddingColumns = 0;
  while (/^[ \t]$/.test(value[offset] || '')) {
    const width = value[offset] === '\t' ? 4 - (column % 4) : 1;
    paddingColumns += width;
    column += width;
    offset += 1;
  }
  if (paddingColumns > 4 && source[marker[0].length] === '\t') {
    return `${source.slice(0, marker[0].length)} `;
  }
  return source.slice(0, marker[0].length + (paddingColumns <= 4 ? offset - marker[0].length : 1));
}

function quoteMarkerAt(value, startColumn = 0, allowOverIndentation = false) {
  let offset = 0;
  let column = startColumn;
  while (/^[ \t]$/.test(value[offset] || '')) {
    const width = value[offset] === '\t' ? 4 - (column % 4) : 1;
    if (!allowOverIndentation && column + width - startColumn > 3) break;
    column += width;
    offset += 1;
  }
  const marker = String(value).slice(offset).match(/^>[ \t]?/);
  if (!marker) return null;
  return {
    length: offset + marker[0].length,
    column: indentationColumnsAt(marker[0], column),
    overIndented: column - startColumn > 3,
  };
}

function quotePrefixAt(value, startColumn = 0) {
  const source = String(value);
  let offset = 0;
  let column = startColumn;
  while (offset < source.length) {
    const quote = quoteMarkerAt(source.slice(offset), column);
    if (!quote) break;
    offset += quote.length;
    column = quote.column;
  }
  return source.slice(0, offset);
}

function fenceIndentationColumns(container) {
  const startColumn = indentationColumns(container.rawPrefix);
  return indentationColumnsAt(container.indentation, startColumn) - startColumn;
}

function consumeIndentationColumns(line, columns, startColumn = 0) {
  let offset = 0;
  let consumed = 0;
  let column = startColumn;
  while (offset < line.length && consumed < columns && /^[ \t]$/.test(line[offset])) {
    if (line[offset] === '\t') {
      const tabWidth = 4 - (column % 4);
      if (consumed + tabWidth > columns) {
        return `${' '.repeat(consumed + tabWidth - columns)}${line.slice(offset + 1)}`;
      }
      consumed += tabWidth;
      column += tabWidth;
    } else {
      consumed += 1;
      column += 1;
    }
    offset += 1;
  }
  return consumed === columns ? line.slice(offset) : null;
}

function stripIndentationColumns(line, columns, startColumn = 0) {
  const stripped = consumeIndentationColumns(line, columns, startColumn);
  if (stripped != null) return stripped;
  return String(line).replace(/^[ \t]*/, '');
}

function stripContainerPrefix(line, container) {
  let remainder = String(line);
  let column = 0;
  for (let quoteIndex = 0; quoteIndex < container.quoteDepth; quoteIndex += 1) {
    if (!remainder.trim()) return '';
    const listIndent = container.listIndentGroups[quoteIndex];
    remainder = consumeIndentationColumns(remainder, listIndent, column);
    if (remainder == null) return null;
    column += listIndent;
    const quote = quoteMarkerAt(remainder, column);
    if (!quote) return null;
    column = quote.column;
    remainder = remainder.slice(quote.length);
  }
  if (!remainder.trim()) return '';
  return consumeIndentationColumns(remainder, container.listIndentGroups.at(-1), column);
}

function fenceIndentationInContainer(fence, container) {
  const indentation = fenceIndentationColumns(fence);
  if (fence.listPrefix) return indentation;
  return Math.max(0, indentation - container.listIndentGroups.at(-1));
}

function fenceCloserInContainer(opener, candidate) {
  if (!opener.quoteDepth && !opener.listPrefix) {
    return !candidate.quoteDepth && !candidate.listPrefix
      && indentationColumns(candidate.indentation) <= 3;
  }
  const remainder = stripContainerPrefix(`${candidate.rawPrefix}${candidate.indentation}x`, opener);
  const extraIndentation = remainder?.slice(0, -1);
  return remainder?.endsWith('x')
    && /^[ \t]*$/.test(extraIndentation)
    && indentationColumnsAt(extraIndentation, indentationColumns(opener.rawPrefix)) - indentationColumns(opener.rawPrefix) <= 3;
}

function isFenceCloser(opener, candidate, fence, info) {
  return fenceCloserInContainer(opener.container, candidate)
    && !info.trim()
    && fence[0] === opener.fence[0]
    && fence.length >= opener.fence.length;
}

function nestedFenceCloserIndex(matches, containers, closerIndexes, cache, startIndex, fence, container) {
  const key = `${fence[0]}:${fence.length}:${container.quoteDepth}:${container.listIndentGroups.join(',')}`;
  let compatible = cache.get(key);
  if (!compatible) {
    const nested = { fence, container };
    compatible = (closerIndexes.get(fence[0]) || []).filter(index => (
      isFenceCloser(nested, containers[index], matches[index].fence, matches[index].info)
    ));
    cache.set(key, compatible);
  }
  let low = 0;
  let high = compatible.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compatible[middle] <= startIndex) low = middle + 1;
    else high = middle;
  }
  return low < compatible.length ? compatible[low] : -1;
}

function outerFenceCloserAfterNested(
  source,
  matches,
  containers,
  closerIndexes,
  cache,
  startIndex,
  outer,
  noListScanPositions,
) {
  for (let index = startIndex + 1; index < matches.length; index += 1) {
    const match = matches[index];
    const container = containers[index];
    if (isFenceCloser(outer, container, match.fence, match.info)) return index;

    const validOpening = match.fence[0] !== '`' || !match.info.includes('`');
    if (!validOpening || !match.info.trim()) continue;
    const nestedContainer = (fenceIndentationColumns(container) > 3 || container.leadingQuoteIndent > 3 || container.overIndentedQuote)
      ? listContinuationContainer(source, match.index, match.prefix, match.indentation, noListScanPositions)
      : container;
    if (!nestedContainer) continue;
    const nestedCloserIndex = nestedFenceCloserIndex(
      matches,
      containers,
      closerIndexes,
      cache,
      index,
      match.fence,
      nestedContainer,
    );
    if (nestedCloserIndex >= 0) index = nestedCloserIndex;
  }
  return -1;
}

function listContinuationContainer(source, position, prefix, indentation, noListScanPositions) {
  const current = fenceContainer(prefix, indentation);
  const continuationIndent = Math.max(
    fenceIndentationColumns(current),
    current.leadingQuoteIndent,
  );
  const cacheKey = `${current.quoteDepth}:${continuationIndent}:${current.leadingQuoteIndent}`;
  const cached = noListScanPositions.get(cacheKey);
  if (cached?.container && position < cached.end) return cached.container;
  const cachedPosition = cached?.noList;
  const noList = () => {
    noListScanPositions.set(cacheKey, { noList: position });
    return null;
  };
  const foundList = container => {
    noListScanPositions.set(cacheKey, {
      container,
      end: unfinishedContainerEnd(source, position, container, new Map()),
    });
    return container;
  };
  let lineEnd = position;
  if (source[lineEnd - 1] === '\n') lineEnd -= 1;
  if (source[lineEnd - 1] === '\r') lineEnd -= 1;

  while (lineEnd > 0) {
    if (cachedPosition != null && lineEnd < cachedPosition) return null;
    const lineStart = source.lastIndexOf('\n', lineEnd - 1) + 1;
    const line = source.slice(lineStart, lineEnd);
    if (!line.trim()) {
      if (!lineStart) break;
      lineEnd = lineStart - 1;
      if (source[lineEnd] === '\n') lineEnd -= 1;
      if (source[lineEnd] === '\r') lineEnd -= 1;
      continue;
    }
    const precedingFence = parseFenceLine(line);
    if (precedingFence && fenceIndentationColumns(fenceContainer(precedingFence.prefix, precedingFence.indentation)) > 3) {
      return noList();
    }
    const precedingContainer = fenceContainer(line);
    const missingQuotes = current.quoteDepth - precedingContainer.quoteDepth;
    if (missingQuotes < 0 || (missingQuotes && !current.leadingQuoteIndent)) return noList();

    const quotePrefix = quotePrefixAt(line);
    const content = line.slice(quotePrefix.length);
    const sameQuoteContainer = precedingContainer.quoteDepth === current.quoteDepth
      && (!current.quoteDepth || Boolean(quotePrefix));
    const followsNonblankLine = lineStart > 0
      && Boolean(source.slice(source.lastIndexOf('\n', lineStart - 2) + 1, lineStart - 1).trim());
    const nonInterruptingOrderedMarker = followsNonblankLine && sameQuoteContainer
      && (/^[ \t]*\d{1,9}[.)][ \t]*$/.test(content)
        || (/^[ \t]*\d{1,9}[.)][ \t]/.test(content) && !/^[ \t]*1[.)][ \t]/.test(content)));
    if (precedingContainer.listPrefix && !nonInterruptingOrderedMarker) {
      let container = missingQuotes
        ? fenceContainer(`${precedingContainer.containerPrefix}${'> '.repeat(missingQuotes)}`)
        : precedingContainer;
      if (!missingQuotes) container = { ...container, rawPrefix: container.containerPrefix };
      const emptyListMarker = line.length === precedingContainer.containerPrefix.length;
      if (emptyListMarker) {
        container = { ...container, listIndentGroups: [...container.listIndentGroups] };
        if (container.lastListPrefixWidth > container.lastListMarkerWidth) {
          const group = container.listIndentGroups.length - 1;
          container.listIndentGroups[group] = container.listIndentGroups[group] - container.lastListPrefixWidth
            + container.lastListMarkerWidth + 1;
        }
      }
      const listIndent = container.listIndentGroups.at(-1);
      if (listIndent && continuationIndent >= listIndent && continuationIndent <= listIndent + 3) {
        return foundList(container);
      }
      return noList();
    }

    const lineIndentation = content.match(/^[ \t]*/)?.[0] || '';
    const lineStartColumn = indentationColumns(quotePrefix);
    const lineIndent = indentationColumnsAt(lineIndentation, lineStartColumn) - lineStartColumn;
    // A fenced continuation may be up to three columns deeper than ordinary
    // list content, so continue back to the enclosing list marker first.
    if (lineIndent < 2) {
      const thematicBreak = /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/.test(content);
      const lazyParagraph = sameQuoteContainer && !lineIndent
        && !thematicBreak
        && !/^(?:#{1,6}(?:\s|$)|(?:[-+*]|1[.)])[ \t]+\S|>|`{3,}|~{3,})/.test(content);
      if (lazyParagraph) {
        if (!lineStart) break;
        lineEnd = lineStart - 1;
        if (source[lineEnd] === '\n') lineEnd -= 1;
        if (source[lineEnd] === '\r') lineEnd -= 1;
        continue;
      }
      return noList();
    }

    if (!lineStart) break;
    lineEnd = lineStart - 1;
    if (source[lineEnd] === '\n') lineEnd -= 1;
    if (source[lineEnd] === '\r') lineEnd -= 1;
  }
  return noList();
}

function lineBelongsToContainer(line, container) {
  if (!container.quoteDepth && !container.listPrefix) return true;
  const content = stripContainerPrefix(line, container);
  return content != null && Boolean(content.trim());
}

function lineIsBlankInContainer(line, container) {
  if (!container.quoteDepth && !container.listPrefix) return !line.trim();
  return stripContainerPrefix(line, container) === '';
}

function lineHasExplicitContainerPrefix(line, container) {
  return Boolean(String(line).trim()) && stripContainerPrefix(line, container) === '';
}

function containerBoundaryKey(container) {
  return `${container.quoteDepth}:${container.leadingQuoteIndent}:${container.listPrefix}:${container.listIndentGroups.join(',')}`;
}

function unfinishedContainerEnd(source, start, container, boundaryCache) {
  if (!container.quoteDepth && !container.listPrefix) return source.length;
  const key = containerBoundaryKey(container);
  const cached = boundaryCache.get(key);
  if (cached && start >= cached.start && start <= cached.end) return cached.end;
  const remainder = source.slice(start);
  let offset = start;
  let pendingBlankStart = null;
  let end = source.length;
  for (const match of remainder.matchAll(/[^\r\n]*(?:\r?\n|$)/g)) {
    if (!match[0]) break;
    const line = match[0].replace(/\r?\n$/, '');
    if ((container.quoteDepth || container.listPrefix) && lineIsBlankInContainer(line, container)) {
      if (lineHasExplicitContainerPrefix(line, container)) {
        if (!container.quoteDepth) pendingBlankStart = null;
      }
      else if (pendingBlankStart == null) pendingBlankStart = offset;
      offset += match[0].length;
      continue;
    }
    if (!lineBelongsToContainer(line, container)) {
      end = pendingBlankStart ?? offset;
      break;
    }
    if (pendingBlankStart != null && container.quoteDepth) {
      end = pendingBlankStart;
      break;
    }
    pendingBlankStart = null;
    offset += match[0].length;
  }
  boundaryCache.set(key, { start, end });
  return end;
}

function normalizeContainerCode(code, prefixOrContainer, fenceIndentation = 0) {
  const container = typeof prefixOrContainer === 'object'
    ? prefixOrContainer
    : fenceContainer(prefixOrContainer);
  const { quoteDepth, listPrefix } = container;
  if (!quoteDepth && !listPrefix && !fenceIndentation) return code;

  const lines = String(code).split(/(\r?\n)/);
  for (let index = 0; index < lines.length; index += 2) {
    const normalized = stripContainerPrefix(lines[index], container);
    const line = normalized != null ? normalized : lines[index];
    lines[index] = fenceIndentation
      ? stripIndentationColumns(line, fenceIndentation, indentationColumns(container.rawPrefix))
      : line;
  }
  return lines.join('');
}

function parseFenceLine(line) {
  let offset = 0;
  while (offset < line.length) {
    const segment = line.slice(offset);
    const segmentStartColumn = indentationColumns(line.slice(0, offset));
    const quote = quoteMarkerAt(segment, segmentStartColumn, true);
    if (quote) {
      offset += quote.length;
      continue;
    }
    const list = listPrefixAt(segment, segmentStartColumn);
    if (!list) break;
    offset += list.length;
  }
  const prefix = line.slice(0, offset);
  const indentation = line.slice(offset).match(/^[ \t]*/)?.[0] || '';
  const fence = line.slice(offset + indentation.length).match(/^(`{3,}|~{3,})([^\r\n]*)$/);
  if (!fence) return null;
  return { prefix, indentation, fence: fence[1], info: fence[2] };
}

function markdownFenceLines(source) {
  const lines = [];
  for (const match of source.matchAll(/[^\r\n]*(?:\r?\n|$)/g)) {
    if (!match[0]) break;
    const raw = match[0];
    const parsed = parseFenceLine(raw.replace(/\r?\n$/, ''));
    if (parsed) lines.push({ ...parsed, index: match.index, raw });
  }
  return lines;
}

/** Replace whole fenced blocks, including an unfinished block during streaming. */
export function replaceMarkdownCodeFences(value, renderBlock, { streaming = false } = {}) {
  const source = String(value ?? '');
  const output = [];
  let cursor = 0;
  let block = null;
  const stack = [];
  const noListScanPositions = new Map();
  const containerBoundaryCache = new Map();

  const matches = markdownFenceLines(source);
  const containers = matches.map(match => fenceContainer(match.prefix, match.indentation));
  const closerIndexes = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index].info.trim()) continue;
    const marker = matches[index].fence[0];
    const indexes = closerIndexes.get(marker) || [];
    indexes.push(index);
    closerIndexes.set(marker, indexes);
  }
  const nestedCloserCache = new Map();
  for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
    const match = matches[matchIndex];
    const { prefix, indentation, fence, info } = match;
    const container = containers[matchIndex];
    if (block) {
      const boundary = block.boundary;
      if (boundary <= match.index) {
        const code = source.slice(block.start, boundary);
        const needsBoundaryNewline = (/\r?\n$/.test(code) || (!code && block.openingEndsWithNewline))
          && !/^\r?\n/.test(source.slice(boundary));
        output.push(block.prefix + renderBlock(
          block.info,
          normalizeContainerCode(code, block.container, block.fenceIndentation),
        ) + (needsBoundaryNewline ? '\n' : ''));
        cursor = boundary;
        block = null;
        stack.length = 0;
        matchIndex -= 1;
        continue;
      }
    }
    const validOpening = fence[0] !== '`' || !info.includes('`');
    const markdown = /^(?:md|markdown)$/i.test(codeFenceLanguage(info));
    if (!block) {
      // Four-space indented code is not a fenced block at the document root,
      // but list continuations may require more than three spaces to close.
      let openingContainer = container;
      let openingPrefix = prefix;
      if (!validOpening) continue;
      const continuation = (fenceIndentationColumns(container) || container.leadingQuoteIndent || container.overIndentedQuote)
        ? listContinuationContainer(source, match.index, prefix, indentation, noListScanPositions)
        : null;
      if (continuation) {
        openingContainer = continuation;
        openingPrefix = `${prefix}${indentation}`;
      } else if (fenceIndentationColumns(container) > 3 || container.leadingQuoteIndent > 3 || container.overIndentedQuote) {
        continue;
      }
      output.push(source.slice(cursor, match.index));
      const start = match.index + match.raw.length;
      block = {
        info,
        prefix: openingPrefix,
        container: openingContainer,
        start,
        openingEndsWithNewline: /\r?\n$/.test(match.raw),
        fenceIndentation: fenceIndentationInContainer(container, openingContainer),
        boundary: unfinishedContainerEnd(source, start, openingContainer, containerBoundaryCache),
      };
      stack.push({ fence, markdown, container: openingContainer });
      continue;
    }

    const active = stack[stack.length - 1];
    // A closing fence occupies its own line, has no info string, and is at
    // least as long as its opener. Backticks inside source code are literal.
    const protectedNestedCloser = active.literalNestedCloserIndexes?.has(matchIndex);
    if (!protectedNestedCloser && isFenceCloser(active, container, fence, info)) {
      stack.pop();
      if (!stack.length) {
        output.push(block.prefix + renderBlock(
          block.info,
          normalizeContainerCode(source.slice(block.start, match.index), block.container, block.fenceIndentation),
        ));
        // Leave the closing line's newline for the surrounding Markdown.
        cursor = match.index + match.raw.replace(/\r?\n$/, '').length;
        block = null;
      }
    } else {
      const nestedContainer = (fenceIndentationColumns(container) > 3 || container.leadingQuoteIndent > 3 || container.overIndentedQuote)
        ? listContinuationContainer(source, match.index, prefix, indentation, noListScanPositions)
        : container;
      const nestedCloserIndex = nestedContainer
        ? nestedFenceCloserIndex(matches, containers, closerIndexes, nestedCloserCache, matchIndex, fence, nestedContainer)
        : -1;
      if (nestedCloserIndex >= 0 && active.nestedOuterCloserIndex === undefined) {
        active.nestedOuterCloserIndex = outerFenceCloserAfterNested(
          source,
          matches,
          containers,
          closerIndexes,
          nestedCloserCache,
          nestedCloserIndex,
          active,
          noListScanPositions,
        );
      }
      const outerCloserIndex = active.nestedOuterCloserIndex;
      if (streaming && active.markdown && validOpening && info.trim()
        && nestedContainer
        && nestedCloserIndex >= 0
        && outerCloserIndex >= 0
        && (!active.container.quoteDepth && !active.container.listPrefix
          || fenceCloserInContainer(active.container, nestedContainer))) {
        // Models sometimes wrap a README in ```markdown and reuse ```lang
        // inside it. Recover only this named Markdown nesting; ordinary code
        // and correctly longer outer fences retain their literal contents.
        stack.push({ fence, markdown, container: nestedContainer });
      } else if (streaming && active.markdown && nestedCloserIndex >= 0
        && outerCloserIndex === -1) {
        // An unfinished wrapper keeps every outer-compatible fence inside a
        // complete nested example literal, including alternate-marker pairs.
        const protectedClosers = active.literalNestedCloserIndexes ||= new Set();
        // A longer outer marker at the nested closer is still the real outer
        // closer; only a same-length or shorter nested fence protects it.
        const protectedEnd = active.fence.length <= fence.length
          ? nestedCloserIndex
          : nestedCloserIndex - 1;
        for (let index = matchIndex + 1; index <= protectedEnd; index += 1) {
          if (isFenceCloser(active, containers[index], matches[index].fence, matches[index].info)) {
            protectedClosers.add(index);
          }
        }
      }
    }
  }

  if (block) {
    const end = block.boundary;
    const code = source.slice(block.start, end);
    const tail = source.slice(end);
    const needsBoundaryNewline = tail && (/\r?\n$/.test(code) || (!code && block.openingEndsWithNewline))
      && !/^\r?\n/.test(tail);
    output.push(block.prefix + renderBlock(
      block.info,
      normalizeContainerCode(code, block.container, block.fenceIndentation),
    ) + (needsBoundaryNewline ? '\n' : ''));
    output.push(tail);
  } else output.push(source.slice(cursor));
  return output.join('');
}

function tokenSpan(type, value) {
  const escaped = escapeCodeHtml(value);
  return type ? `<span class="syntax-${type}">${escaped}</span>` : escaped;
}

function tokenize(source, pattern, classify) {
  let output = '';
  let cursor = 0;
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    output += escapeCodeHtml(source.slice(cursor, match.index));
    output += tokenSpan(classify(match[0], match.index, source), match[0]);
    cursor = match.index + match[0].length;
  }
  return output + escapeCodeHtml(source.slice(cursor));
}

function quoted(token) {
  return token.startsWith('"') || token.startsWith("'") || token.startsWith('`');
}

function punctuation(token) {
  return token.length === 1 && '{}[]();,.'.includes(token);
}

function highlightJavascript(source) {
  return tokenize(source, JS_TOKENS, (token, index, input) => {
    if (token.startsWith('//') || token.startsWith('/*')) return 'comment';
    if (quoted(token)) return 'string';
    if (/^(?:\d|0[xXbBoO])/.test(token)) return 'number';
    if (JS_KEYWORDS.has(token)) return 'keyword';
    if (JS_CONSTANTS.has(token)) return 'constant';
    if (JS_BUILTINS.has(token)) return 'builtin';
    if (/^[A-Za-z_$]/.test(token) && /^\s*\(/.test(input.slice(index + token.length))) return 'function';
    return punctuation(token) ? 'punctuation' : (/^[\w$]+$/.test(token) ? '' : 'operator');
  });
}

function highlightCss(source) {
  return tokenize(source, CSS_TOKENS, (token, index, input) => {
    if (token.startsWith('/*')) return 'comment';
    if (quoted(token)) return 'string';
    if (/^#[\da-fA-F]{3,8}$/.test(token)) return 'constant';
    if (/^[.#]/.test(token)) return 'selector';
    if (token.startsWith('@')) return 'keyword';
    if (token.startsWith('--')) return 'variable';
    if (/^-?\d/.test(token)) return 'number';
    if (CSS_BUILTINS.has(token)) return 'builtin';
    if (/^[-_a-zA-Z]/.test(token) && /^\s*:/.test(input.slice(index + token.length))) return 'property';
    return /^[{}[\]():;,>+~*=!]$/.test(token) ? 'punctuation' : '';
  });
}

function highlightMarkup(source) {
  return tokenize(source, MARKUP_TOKENS, (token) => {
    if (token.startsWith('<!--')) return 'comment';
    if (/^<!doctype/i.test(token)) return 'keyword';
    if (token.startsWith('&')) return 'constant';
    return 'tag';
  });
}

function highlightJson(source) {
  return tokenize(source, JSON_TOKENS, (token, index, input) => {
    if (token.startsWith('//') || token.startsWith('/*')) return 'comment';
    if (token.startsWith('"')) return /^\s*:/.test(input.slice(index + token.length)) ? 'property' : 'string';
    if (/^-?\d/.test(token)) return 'number';
    if (/^(?:true|false|null)$/.test(token)) return 'constant';
    return 'punctuation';
  });
}

function highlightPython(source) {
  return tokenize(source, PYTHON_TOKENS, (token, index, input) => {
    if (token.startsWith('#')) return 'comment';
    if (quoted(token)) return 'string';
    if (token.startsWith('@')) return 'decorator';
    if (/^\d/.test(token)) return 'number';
    if (PYTHON_KEYWORDS.has(token)) return 'keyword';
    if (PYTHON_BUILTINS.has(token)) return 'builtin';
    if (/^[A-Za-z_]/.test(token) && /^\s*\(/.test(input.slice(index + token.length))) return 'function';
    return punctuation(token) ? 'punctuation' : (/^\w+$/.test(token) ? '' : 'operator');
  });
}

function highlightShell(source) {
  return tokenize(source, SHELL_TOKENS, (token) => {
    if (token.startsWith('#')) return 'comment';
    if (quoted(token)) return 'string';
    if (token.startsWith('$')) return 'variable';
    if (/^\d/.test(token)) return 'number';
    if (SHELL_KEYWORDS.has(token)) return 'keyword';
    return punctuation(token) ? 'punctuation' : (/^\w+$/.test(token) ? '' : 'operator');
  });
}

function highlightSql(source) {
  return tokenize(source, SQL_TOKENS, (token) => {
    const lower = token.toLowerCase();
    if (token.startsWith('--') || token.startsWith('/*')) return 'comment';
    if (quoted(token)) return 'string';
    if (/^\d/.test(token)) return 'number';
    if (('add all alter and as asc begin between by case check column commit constraint create database default delete desc distinct drop else end exists foreign from full grant group having if in index inner insert into is join key left like limit not null on or order outer primary references right rollback select set table then union unique update values view when where with').split(' ').includes(lower)) return 'keyword';
    return /^\w+$/.test(token) ? '' : 'operator';
  });
}

function highlightYaml(source) {
  return tokenize(source, YAML_TOKENS, (token) => {
    if (token.startsWith('#')) return 'comment';
    if (quoted(token)) return 'string';
    if (/^[&*!]/.test(token)) return 'variable';
    if (/^-?\d/.test(token)) return 'number';
    if (/^(?:true|false|null|yes|no|on|off)$/i.test(token)) return 'constant';
    if (/:\s*$/.test(token) || /^[\s-]*[\w.-]+$/.test(token)) return 'property';
    return 'punctuation';
  });
}

function highlightClike(source) {
  return tokenize(source, CLIKE_TOKENS, (token, index, input) => {
    if (/^\s*#/.test(token)) return 'keyword';
    if (token.startsWith('//') || token.startsWith('/*')) return 'comment';
    if (quoted(token)) return 'string';
    if (token.startsWith('$')) return 'variable';
    if (/^\d/.test(token)) return 'number';
    if (CLIKE_KEYWORDS.has(token)) return 'keyword';
    if (CLIKE_TYPES.has(token) || /^[A-Z][A-Za-z0-9_]*$/.test(token)) return 'type';
    if (/^[A-Za-z_]/.test(token) && /^\s*\(/.test(input.slice(index + token.length))) return 'function';
    return punctuation(token) ? 'punctuation' : (/^\w+$/.test(token) ? '' : 'operator');
  });
}

export function highlightCode(code, language) {
  const source = String(code == null ? '' : code);
  switch (normalizeCodeLanguage(language)) {
    case 'javascript': return highlightJavascript(source);
    case 'css': return highlightCss(source);
    case 'markup': return highlightMarkup(source);
    case 'json': return highlightJson(source);
    case 'python': return highlightPython(source);
    case 'shell': return highlightShell(source);
    case 'sql': return highlightSql(source);
    case 'yaml': return highlightYaml(source);
    case 'clike': return highlightClike(source);
    default: return escapeCodeHtml(source);
  }
}

/** Convert escaped ATX heading lines while leaving inline formatting for the caller. */
export function renderMarkdownHeadings(text) {
  return String(text == null ? '' : text).replace(
    /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?(?:\r?\n|$)/gm,
    (_match, hashes, content) => {
      const level = hashes.length;
      return `<h${level}>${content.replace(/[ \t]+$/, '')}</h${level}>`;
    }
  );
}

function splitMarkdownTableRow(line) {
  let source = String(line || '').trim();
  if (!source.includes('|')) return null;
  if (source.startsWith('|')) source = source.slice(1);
  // A trailing escaped pipe belongs to the cell instead of closing the row.
  if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1);

  const cells = [];
  let cell = '';
  for (let i = 0; i < source.length; i += 1) {
    const character = source[i];
    if (character === '\\' && source[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function markdownTableSeparator(cell) {
  return /^:?-{3,}:?$/.test(cell);
}

function renderMarkdownTableRow(cells, tag) {
  return `<tr>${cells.map((cell) => `<${tag}>${cell}</${tag}>`).join('')}</tr>`;
}

/** Convert GitHub-style pipe tables after the caller has escaped source HTML. */
export function renderMarkdownTables(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const rendered = [];

  for (let index = 0; index < lines.length;) {
    const header = splitMarkdownTableRow(lines[index]);
    const separator = splitMarkdownTableRow(lines[index + 1]);
    const isTable = header?.length > 0
      && separator?.length === header.length
      && separator.every(markdownTableSeparator);
    if (!isTable) {
      rendered.push(lines[index]);
      index += 1;
      continue;
    }

    const body = [];
    let next = index + 2;
    while (next < lines.length) {
      const row = splitMarkdownTableRow(lines[next]);
      if (!row) break;
      body.push(row.length < header.length
        ? [...row, ...Array(header.length - row.length).fill('')]
        : row.slice(0, header.length));
      next += 1;
    }

    const headerRow = renderMarkdownTableRow(header, 'th');
    const bodyRows = body.map((row) => renderMarkdownTableRow(row, 'td'));
    rendered.push(`<div class="markdown-table-wrapper"><table><thead>${headerRow}</thead><tbody>${bodyRows.join('')}</tbody></table></div>`);
    index = next;
  }

  return rendered.join('\n');
}
