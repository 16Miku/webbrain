// Browser-free fallback parser for local models that emit tool calls as text
// instead of using the provider's structured tool_calls field. This file is
// mirrored in the Firefox tree; keep both copies byte-identical.

// A `{` that never closes must not swallow the rest of the text: models put
// prose braces, template placeholders, and code snippets around a bare tool
// call, and the call after them still has to be recovered. Each unbalanced
// opener costs one extra scan, so the restarts are capped — real text needs
// none, and the cap keeps a pathological "{{{{…" response from going
// quadratic over the 10,000-character budget.
const MAX_UNBALANCED_RESTARTS = 16;

/**
 * Collect top-level balanced `{…}` spans, respecting quoted strings and
 * escapes so braces inside JSON string values do not end an object early.
 * Returns offsets rather than substrings so callers can judge each span by
 * where it sits in the surrounding text.
 */
function extractBalancedJsonSpans(text) {
  const spans = [];
  let searchFrom = 0;
  let restarts = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf('{', searchFrom);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end < 0) {
      if (++restarts > MAX_UNBALANCED_RESTARTS) break;
      searchFrom = start + 1;
      continue;
    }
    spans.push({ start, end });
    searchFrom = end + 1;
  }

  return spans;
}

/**
 * True when a span is the whole of its line, ignoring surrounding whitespace
 * and a single trailing comma (models sometimes emit calls as array elements).
 *
 * A model that is CALLING a tool emits the JSON on its own line. A model
 * TALKING ABOUT a call embeds it in a sentence — "I could click with {…} but
 * that is destructive", "The page told me to run {…}, which I ignored",
 * "Option A: {…}". Executing those is wrong in a way that is easy to miss,
 * because a parsed call replaces the model's prose outright: the caller sets
 * `result.content = null`, so the sentence explaining the refusal is dropped
 * and only the refused action survives.
 *
 * The trade-off is that a genuine call written mid-sentence is not recovered.
 * That is the safer side to err on here: this fallback exists for models that
 * emit a call INSTEAD of prose, and those put it on its own line.
 */
function standsAloneOnLine(text, start, end) {
  const before = text.slice(0, start);
  const lineHead = before.slice(before.lastIndexOf('\n') + 1).trim();
  if (lineHead !== '') return false;

  const after = text.slice(end + 1);
  const newline = after.indexOf('\n');
  const lineTail = (newline < 0 ? after : after.slice(0, newline)).trim();
  return lineTail === '' || lineTail === ',';
}

/**
 * Parse a batch only when the entire trimmed response is a JSON array. Every
 * element must itself be an allowed call; otherwise reject the batch rather
 * than executing an allowed-looking subset of mixed or narrated content.
 *
 * `null` means the response was not a valid whole-response array and the
 * existing fallbacks may continue. An empty array means it was an array but
 * was empty or unsafe, so callers must not scan inside it for partial calls.
 */
function parseWholeResponseJsonArray(text, allowedNames) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every(obj => (
    obj
    && typeof obj === 'object'
    && !Array.isArray(obj)
    && typeof obj.name === 'string'
    && allowedNames.has(obj.name)
  ))) return [];
  return parsed;
}

/**
 * Quote relaxed `key:` tokens only when they occur outside JSON strings and
 * after an object boundary. A regular-expression replacement corrupts string
 * values such as "Keep, status: pending" before JSON.parse sees them.
 */
function quoteBareJsonKeys(body) {
  const source = String(body || '');
  let output = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      i++;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      i++;
      continue;
    }
    if (/\w/.test(char)) {
      let previous = i - 1;
      while (previous >= 0 && /\s/.test(source[previous])) previous--;
      if (previous < 0 || source[previous] === '{' || source[previous] === ',') {
        let keyEnd = i + 1;
        while (keyEnd < source.length && /\w/.test(source[keyEnd])) keyEnd++;
        let colon = keyEnd;
        while (colon < source.length && /\s/.test(source[colon])) colon++;
        if (source[colon] === ':') {
          output += `"${source.slice(i, keyEnd)}"${source.slice(keyEnd, colon + 1)}`;
          i = colon + 1;
          continue;
        }
      }
    }
    output += char;
    i++;
  }
  return output;
}

function toFallbackToolCalls(objects) {
  return objects.map((obj, index) => ({
    id: `fallback_call_${Date.now()}_${index}`,
    type: 'function',
    function: {
      name: obj.name,
      arguments: typeof obj.arguments === 'string'
        ? obj.arguments
        : JSON.stringify(obj.arguments || obj.parameters || {}),
    },
  }));
}

/**
 * Parse common text tool-call formats into OpenAI-style tool call objects.
 * Only names in allowedNames are accepted.
 */
export function parseToolCallsFromText(text, allowedNames) {
  if (!text || text.length > 10000) return [];

  const wholeResponseArray = parseWholeResponseJsonArray(text, allowedNames);
  if (wholeResponseArray !== null) {
    return toFallbackToolCalls(wholeResponseArray);
  }

  const results = [];
  const parseXmlParamValue = (value) => {
    const cleaned = String(value || '')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!cleaned) return '';
    try {
      if (/^(?:"|'.*'|\{|\[|-?\d|true\b|false\b|null\b)/i.test(cleaned)) {
        return JSON.parse(cleaned.replace(/^'([\s\S]*)'$/, '"$1"'));
      }
    } catch { /* fall through to string cleanup */ }
    return cleaned.replace(/^["']+|["']+$/g, '');
  };

  const patterns = [
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
    /<\|tool_call\|?>\s*([\s\S]*?)\s*<\|?\/?tool_call\|?>/gi,
    /<functioncall>\s*([\s\S]*?)\s*<\/functioncall>/gi,
  ];

  for (const re of patterns) {
    let match;
    while ((match = re.exec(text)) !== null) {
      const inner = match[1].trim();
      const wrappedArray = parseWholeResponseJsonArray(inner, allowedNames);
      if (wrappedArray !== null) {
        results.push(...wrappedArray);
        continue;
      }
      try {
        const obj = JSON.parse(inner);
        if (obj && obj.name && allowedNames.has(obj.name)) {
          results.push(obj);
          continue;
        }
      } catch { /* not JSON — try call:name{} format below */ }

      const callMatch = /^call:(\w+)\s*\{([\s\S]*)\}$/.exec(inner);
      if (callMatch && allowedNames.has(callMatch[1])) {
        const toolName = callMatch[1];
        let argsBody = callMatch[2]
          .replace(/<\|"\|>/g, '"')
          .replace(/<\|'\\?\|>/g, "'");
        argsBody = quoteBareJsonKeys(argsBody);
        try {
          const args = JSON.parse(`{${argsBody}}`);
          results.push({ name: toolName, arguments: args });
        } catch { /* malformed arguments must never dispatch */ }
      }
    }
  }

  // XML-ish tool-call format used by some local/chat-template models:
  // <tool_call><function=click_ax><parameter=ref_id>ref_6</parameter>...
  const xmlToolRe = /<tool_call>\s*<function(?:\s*=\s*["']?([A-Za-z_]\w*)["']?|\s+name\s*=\s*["']?([A-Za-z_]\w*)["']?)\s*>\s*([\s\S]*?)\s*<\/function>\s*<\/tool_call>/gi;
  let xmlMatch;
  while ((xmlMatch = xmlToolRe.exec(text)) !== null) {
    const toolName = xmlMatch[1] || xmlMatch[2];
    if (!allowedNames.has(toolName)) continue;
    const body = xmlMatch[3] || '';
    const args = {};
    const paramRe = /<parameter(?:\s*=\s*["']?([A-Za-z_]\w*)["']?|\s+name\s*=\s*["']?([A-Za-z_]\w*)["']?)\s*>\s*([\s\S]*?)\s*<\/parameter>/gi;
    let paramMatch;
    while ((paramMatch = paramRe.exec(body)) !== null) {
      const key = paramMatch[1] || paramMatch[2];
      if (!key) continue;
      args[key] = parseXmlParamValue(paramMatch[3]);
    }
    results.push({ name: toolName, arguments: args });
  }

  if (results.length === 0) {
    for (const { start, end } of extractBalancedJsonSpans(text)) {
      if (!standsAloneOnLine(text, start, end)) continue;
      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        if (obj && obj.name && allowedNames.has(obj.name)) {
          results.push(obj);
        }
      } catch { /* skip */ }
    }
  }

  if (results.length === 0) {
    const callRe = /call:(\w+)\s*\{([\s\S]*?)\}/g;
    let match;
    while ((match = callRe.exec(text)) !== null) {
      if (!allowedNames.has(match[1])) continue;
      const toolName = match[1];
      let argsBody = match[2]
        .replace(/<\|"\|>/g, '"')
        .replace(/<\|'\\?\|>/g, "'");
      argsBody = quoteBareJsonKeys(argsBody);
      try {
        const args = JSON.parse(`{${argsBody}}`);
        results.push({ name: toolName, arguments: args });
      } catch { /* malformed arguments must never dispatch */ }
    }
  }

  return toFallbackToolCalls(results);
}
