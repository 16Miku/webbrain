export const SESSION_CONVERSATION_BUDGET_BYTES = 1_500_000;
export const SESSION_CONVERSATION_RETRY_BUDGET_BYTES = 450_000;

const DATA_URL_RE = /data:(?:image|application)\/[a-zA-Z0-9+.-]+(?:;[^,\s]*)?;base64,[A-Za-z0-9+/=\s]+/g;

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function capText(value, maxChars, marker, state) {
  // Authority-bearing text must retain the exact parent-task hash. Its data
  // URLs are part of that text; quota handling may fail, but cannot rewrite it.
  if (maxChars === Infinity) return String(value || '');
  const sanitized = String(value || '').replace(DATA_URL_RE, () => {
    state.compacted = true;
    return '[embedded binary data omitted from session recovery]';
  });
  if (sanitized.length <= maxChars) return sanitized;
  state.compacted = true;
  return `${sanitized.slice(0, Math.max(0, maxChars - marker.length - 1))}\n${marker}`;
}

function attachmentPlaceholder(message, kind) {
  const handles = Array.isArray(message?.attachmentHandles) ? message.attachmentHandles : [];
  if (handles.length) {
    const ids = handles.map(handle => String(handle?.attachmentId || '')).filter(Boolean).slice(0, 8);
    return `[User ${kind} attachment bytes omitted from session recovery; durable attachment handle(s): ${ids.join(', ') || 'available in chat history'}.]`;
  }
  return `[${kind === 'image' ? 'Screenshot/image' : 'Document'} bytes omitted from session recovery.]`;
}

function sanitizeValue(value, state, depth = 0) {
  if (typeof value === 'string') return capText(value, 32_000, '[large value truncated for session recovery]', state);
  if (!value || typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeValue(item, state, depth + 1));
  const out = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    if (typeof child === 'string' && (/^(?:data|url)$/i.test(key)) && /^data:.*;base64,/i.test(child)) {
      state.compacted = true;
      out[key] = '[embedded binary data omitted from session recovery]';
    } else {
      out[key] = sanitizeValue(child, state, depth + 1);
    }
  }
  return out;
}

function sanitizeContent(message, state, caps) {
  if (message?.transientCompletionVerification === true) {
    state.compacted = true;
    return '[Completion verification screenshot omitted from persisted history.]';
  }
  const content = message?.content;
  if (typeof content === 'string') {
    const cap = message.role === 'tool' ? caps.toolChars : caps.textChars;
    return capText(content, cap, '[large content truncated for session recovery]', state);
  }
  if (!Array.isArray(content)) return sanitizeValue(content, state);
  return content.slice(0, 100).map(block => {
    if (block?.type === 'image_url' || block?.type === 'image') {
      state.compacted = true;
      return { type: 'text', text: attachmentPlaceholder(message, 'image') };
    }
    if (block?.type === 'document' || block?.source?.type === 'base64') {
      state.compacted = true;
      return { type: 'text', text: attachmentPlaceholder(message, 'document') };
    }
    if (caps.textChars === Infinity && block?.type === 'text' && typeof block.text === 'string') {
      return { ...sanitizeValue({ ...block, text: '' }, state), text: capText(block.text, caps.textChars, '[large content truncated for session recovery]', state) };
    }
    return sanitizeValue(block, state);
  });
}

function sanitizeMessage(message, state, caps) {
  if (!message || typeof message !== 'object') return message;
  const out = { ...message, content: sanitizeContent(message, state, caps) };
  if (Array.isArray(message.tool_calls)) {
    // Calls and results are one protocol group. A count-only cutoff silently
    // orphans results even when the complete group fits the byte budget.
    out.tool_calls = message.tool_calls.map(call => ({
      ...call,
      function: call?.function ? {
        ...call.function,
        arguments: capText(call.function.arguments || '', caps.toolArgsChars, '[tool arguments truncated for session recovery]', state),
      } : call?.function,
    }));
  }
  if (Array.isArray(message.responseItems)) out.responseItems = sanitizeValue(message.responseItems, state);
  return out;
}

function pruneOrphanedToolResults(messages, state) {
  let pending = new Set();
  let writeIndex = 0;
  for (const message of messages) {
    if (message?.role === 'tool') {
      // IDs may be reused by a provider across turns. A later assistant with
      // the same ID cannot authorize an earlier, compacted turn's result.
      if (!pending.delete(message.tool_call_id)) {
        state.compacted = true;
        continue;
      }
    } else {
      pending = new Set(message?.role === 'assistant' && Array.isArray(message.tool_calls)
        ? message.tool_calls.map(call => call?.id).filter(id => typeof id === 'string')
        : []);
    }
    messages[writeIndex++] = message;
  }
  messages.length = writeIndex;
}

function reduceToBudget(messages, maxBytes, state, preserveMessageIndices = []) {
  if (byteLength(messages) <= maxBytes) return messages;
  const out = messages.map(message => ({ ...message }));
  const preserved = new Set(
    Array.isArray(preserveMessageIndices)
      ? preserveMessageIndices.filter(index => Number.isInteger(index) && index >= 0 && index < out.length).map(index => out[index])
      : [],
  );
  let keepRecentFrom = Math.max(1, out.length - 14);
  for (let index = 1; index < keepRecentFrom && byteLength(out) > maxBytes; index++) {
    const message = out[index];
    // The agent supplies the active task binding's original user turn,
    // clarification questions, and answers. Keep those small authority-bearing
    // messages intact even when a long tool loop pushes them outside the
    // ordinary recent-message window; otherwise a worker restart can promote
    // only the latest answer fragment as a new task.
    if (!message || message.role === 'system' || preserved.has(message)) continue;
    state.compacted = true;
    out[index] = {
      role: message.role,
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      // The collapsed text is gone, so this turn no longer carries any task
      // authority. Mark it app-owned or the agent's task binding would treat
      // the placeholder as the latest genuine user request after a restart.
      ...(message.role === 'user'
        ? { webbrainAppOwned: true, webbrainAppOwnedKind: 'session_recovery_placeholder' }
        : {}),
      content: '[Earlier message omitted from bounded session recovery snapshot.]',
    };
  }
  // A compacted assistant loses its tool_calls. Drop its paired results
  // before measuring the remaining budget, using adjacent groups rather than
  // a global ID lookup that could match a different assistant turn.
  if (state.compacted) {
    pruneOrphanedToolResults(out, state);
    keepRecentFrom = Math.max(1, out.length - 14);
  }
  for (let index = keepRecentFrom; index < out.length && byteLength(out) > maxBytes; index++) {
    const message = out[index];
    if (!message || preserved.has(message) || typeof message.content !== 'string' || message.content.length <= 4_000) continue;
    state.compacted = true;
    out[index] = { ...message, content: `${message.content.slice(0, 3_900)}\n[content truncated for session recovery]` };
  }
  // Signed provider state is opaque. If the snapshot is still oversized,
  // remove whole replay/tool pairs instead of truncating a signature.
  let droppedReplay = false;
  for (let index = 0; index < out.length && byteLength(out) > maxBytes; index++) {
    const message = out[index];
    if (!message?._reasoning_replay?.providerState) continue;
    const rest = { ...message };
    delete rest._reasoning_replay;
    delete rest.tool_calls;
    out[index] = typeof rest.content !== 'string' || !rest.content.trim()
      ? { ...rest, content: '[Provider reasoning omitted from session recovery.]' }
      : rest;
    state.compacted = true;
    droppedReplay = true;
  }
  if (droppedReplay) {
    pruneOrphanedToolResults(out, state);
  }
  return out;
}

export function serializeConversationForSession(messages, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(100_000, options.maxBytes) : SESSION_CONVERSATION_BUDGET_BYTES;
  const tight = maxBytes <= SESSION_CONVERSATION_RETRY_BUDGET_BYTES;
  const caps = tight
    ? { textChars: 16_000, toolChars: 8_000, toolArgsChars: 8_000 }
    : { textChars: 96_000, toolChars: 32_000, toolArgsChars: 24_000 };
  const state = { compacted: false };
  // Task-authority messages must survive recovery verbatim. If their text
  // alone exceeds storage limits, persistence reports degradation instead of
  // restoring a truncated correction under its original authorization hash.
  const preserved = new Set(Array.isArray(options.preserveMessageIndices) ? options.preserveMessageIndices : []);
  const sanitized = Array.isArray(messages) ? messages.map((message, index) => sanitizeMessage(
    message, state, preserved.has(index) && message?.role === 'user'
      ? { ...caps, textChars: Infinity } : caps,
  )) : [];
  const bounded = reduceToBudget(sanitized, maxBytes, state, options.preserveMessageIndices);
  return { messages: bounded, bytes: byteLength(bounded), compacted: state.compacted };
}

export function isSessionQuotaError(error) {
  const message = String(error?.message || error || '');
  return /quota|QUOTA_BYTES|bytes? exceeded|storage limit/i.test(message);
}
