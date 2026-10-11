const MINIMAX_TRANSPORT_TOKEN = /\]<\]minimax\[>\[/g;
const NATIVE_CALL_BODY = /^\s*<(?:invoke\s+name\s*=|function(?:\s*=|\s+name\s*=))/i;

function replaceOutsideInlineCode(text, pattern, replacement) {
  const runs = [];
  for (let start = text.indexOf('`'); start >= 0;) {
    let end = start + 1;
    while (text[end] === '`') end++;
    runs.push({ start, end, length: end - start });
    start = text.indexOf('`', end);
  }
  // Markdown closes inline code with a delimiter run of exactly the opening
  // length. Index the next matching run once rather than backtracking through
  // a large unmatched delimiter or rescanning every later run per opener.
  const following = new Map(), next = new Array(runs.length), code = [];
  for (let index = runs.length - 1; index >= 0; index--) {
    next[index] = following.get(runs[index].length);
    following.set(runs[index].length, index);
  }
  for (let index = 0; index < runs.length;) {
    const closing = next[index];
    if (closing == null) index++;
    else { code.push([runs[index].start, runs[closing].end]); index = closing + 1; }
  }
  let span = 0;
  return text.replace(pattern, (...args) => {
    const offset = args.at(-2);
    while (span < code.length && code[span][1] <= offset) span++;
    if (span < code.length && offset >= code[span][0]) return args[0];
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  });
}

function recoveryProseOutsideCode(text) {
  const hadNativeTokens = text.includes(']<]minimax[>[');
  let prose = text;
  // These are transport envelopes, not deliverables. Do not parse arguments,
  // look up tools, or execute anything when salvaging a stopped browser run.
  prose = replaceOutsideInlineCode(prose, /<tool_call>([\s\S]*?)<\/tool_call>/gi, (whole, body) =>
    hadNativeTokens || NATIVE_CALL_BODY.test(body) ? '' : whole);
  prose = replaceOutsideInlineCode(prose, /<invoke\s+name\s*=[^>]*>[\s\S]*?<\/invoke>/gi, '');
  prose = replaceOutsideInlineCode(prose, MINIMAX_TRANSPORT_TOKEN, '');
  // A provider can stop partway through an envelope. Its arguments are not a
  // useful partial result, even when the closing transport tag never arrived.
  prose = replaceOutsideInlineCode(prose, /<tool_call>([\s\S]*)$/gi, (whole, body) =>
    hadNativeTokens || NATIVE_CALL_BODY.test(body) ? '' : whole);
  prose = replaceOutsideInlineCode(prose, /<invoke\s+name\s*=[\s\S]*$/gi, '');
  return prose;
}

/** Recovery-only display filter; normal Ask/code output never calls this. */
export function chatRecoveryDisplayText(value) {
  const text = typeof value === 'string' ? value : '';
  const chunks = [];
  let ordinary = '';
  let fence = null;
  // Preserve literal fenced examples and drafts, including native XML inside
  // them. Only unfenced recovery prose can contain a leaked tool transport.
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence && marker) {
      chunks.push(recoveryProseOutsideCode(ordinary), line);
      ordinary = '';
      fence = { character: marker[1][0], length: marker[1].length };
    } else if (fence) {
      chunks.push(line);
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length
          && line.slice(marker[0].length).trim() === '') fence = null;
    } else ordinary += line;
  }
  chunks.push(recoveryProseOutsideCode(ordinary));
  return chunks.join('').trim();
}

// Only the tool-free terminal-recovery generation uses this envelope. Normal
// Ask prose and literal code never pass through this parser. Whole-response
// parsing rejects unmarked preambles instead of guessing which prose to cut.
const MAX_TERMINAL_RECOVERY_TEXT = 65536;
const MAX_TERMINAL_RECOVERY_ENVELOPE = MAX_TERMINAL_RECOVERY_TEXT * 6 + 128;

export function terminalRecoveryFinalText(value) {
  if (typeof value !== 'string' || value.length > MAX_TERMINAL_RECOVERY_ENVELOPE) return '';
  let parsed;
  try { parsed = JSON.parse(value); } catch { return ''; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'final_text')) return '';
  const finalText = parsed.final_text;
  if (typeof finalText !== 'string' || finalText.length > MAX_TERMINAL_RECOVERY_TEXT
      || !finalText.trim()) return '';
  return finalText.trim();
}
