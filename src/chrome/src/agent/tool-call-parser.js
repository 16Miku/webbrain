// Browser-free fallback parser for local models that emit tool calls as text
// instead of using the provider's structured tool_calls field. This file is
// mirrored in the Firefox tree; keep both copies byte-identical.

/**
 * Parse common text tool-call formats into OpenAI-style tool call objects.
 * Only names in allowedNames are accepted.
 */
export function parseToolCallsFromText(text, allowedNames) {
  if (!text || text.length > 10000) return [];

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
        argsBody = argsBody.replace(/(?<=^|,)\s*(\w+)\s*:/g, '"$1":');
        try {
          const args = JSON.parse(`{${argsBody}}`);
          results.push({ name: toolName, arguments: args });
        } catch {
          results.push({ name: toolName, arguments: {} });
        }
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
    const bareRe = /\{[^{}]*"name"\s*:\s*"(\w+)"[^{}]*\}/g;
    let match;
    while ((match = bareRe.exec(text)) !== null) {
      if (!allowedNames.has(match[1])) continue;
      try {
        const obj = JSON.parse(match[0]);
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
      argsBody = argsBody.replace(/(?<=^|,)\s*(\w+)\s*:/g, '"$1":');
      try {
        const args = JSON.parse(`{${argsBody}}`);
        results.push({ name: toolName, arguments: args });
      } catch {
        results.push({ name: toolName, arguments: {} });
      }
    }
  }

  return results.map((obj, index) => ({
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
