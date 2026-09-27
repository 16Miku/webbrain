import { makeEvent } from './event-model.js';

const STORAGE_KEY = 'webbrainCloudRuntimeOutboxV1';
const MAX_OUTBOX_EVENTS = 200;
const MAX_FIELD_CHARS = 24_000;
let storageQueue = Promise.resolve();
let fallbackRunCounter = 0;

function bounded(value, limit = MAX_FIELD_CHARS) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const text = typeof serialized === 'string' ? serialized : String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[… ${text.length - limit} characters omitted]`;
}

function currentTurn(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let start = 0;
  for (let index = list.length - 1; index >= 0; index--) {
    if (list[index]?.role === 'user') {
      start = index + 1;
      break;
    }
  }
  return list.slice(start);
}

function parseResult(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? null);
  const candidates = [text];
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function terminalTool(messages) {
  const turn = currentTurn(messages);
  const calls = new Map();
  const results = [];
  for (const message of turn) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.id) calls.set(call.id, call);
      }
    } else if (message?.role === 'tool' && message.tool_call_id) {
      results.push(message);
    }
  }
  if (!results.length) return null;
  const paired = results.map(result => ({ result, call: calls.get(result.tool_call_id) })).filter(item => item.call);
  const selected = [...paired].reverse().find(item => (
    ['done', 'done_json'].includes(item.call?.function?.name || item.call?.name)
    && parseResult(item.result.content)?.done === true
  )) || paired.at(-1);
  if (!selected) return null;
  const call = selected.call;
  const result = parseResult(selected.result.content);
  const blocked = result?.blocked === true || result?.blockedDone === true;
  const skipped = result?.skipped === true;
  const failed = result?.success === false || (!blocked && typeof result?.error === 'string');
  const status = blocked ? 'blocked' : skipped ? 'skipped' : failed ? 'failed' : 'succeeded';
  return {
    call_id: String(call.id),
    name: String(call.function?.name || call.name || 'unknown_tool').slice(0, 128),
    arguments: bounded(call.function?.arguments ?? call.arguments ?? '', 12_000),
    result: bounded(selected.result.content, MAX_FIELD_CHARS),
    status,
    success: status === 'succeeded',
  };
}

export function buildTerminalRuntimeEvent({
  runId,
  status,
  finalContent,
  messages,
  model,
  mode,
  browserTarget,
  extensionVersion,
}) {
  const tool = terminalTool(messages);
  if (!tool) return null;
  const generatedId = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}_${(++fallbackRunCounter).toString(36)}`;
  const effectiveRunId = String(runId || `cloud_${generatedId}`);
  const event = makeEvent(effectiveRunId, 1, 'terminal_runtime', {
    status: String(status || 'unknown').slice(0, 64),
    final_content: bounded(finalContent || '', MAX_FIELD_CHARS),
    terminal_tool: tool,
    model: String(model || '').slice(0, 255),
    mode: String(mode || '').slice(0, 32),
    browser_target: String(browserTarget || '').slice(0, 32),
    extension_version: String(extensionVersion || '').slice(0, 64),
  });
  if (!event) return null;
  return {
    event_id: `${effectiveRunId}:1:terminal_runtime`,
    event,
  };
}

function localStorageArea() {
  const api = (typeof browser !== 'undefined' && browser?.storage)
    ? browser
    : ((typeof chrome !== 'undefined' && chrome?.storage) ? chrome : null);
  if (!api?.storage?.local?.get || !api.storage.local.set) {
    throw new Error('Extension local storage is unavailable');
  }
  return api.storage.local;
}

async function readOutbox() {
  const stored = await localStorageArea().get([STORAGE_KEY]);
  return Array.isArray(stored?.[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
}

function updateOutbox(update) {
  const next = storageQueue.catch(() => {}).then(async () => {
    const current = await readOutbox();
    const value = await update(current);
    await localStorageArea().set({ [STORAGE_KEY]: value.slice(-MAX_OUTBOX_EVENTS) });
    return value;
  });
  storageQueue = next;
  return next;
}

export async function enqueueCloudRuntimeEvent(sessionId, item) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId || !item?.event_id || !item?.event) return false;
  await updateOutbox(current => {
    if (current.some(entry => entry?.event_id === item.event_id)) return current;
    return [...current, {
      session_id: normalizedSessionId,
      event_id: item.event_id,
      event: item.event,
      queued_at: Date.now(),
    }];
  });
  return true;
}

export async function flushCloudRuntimeOutbox(provider) {
  if (String(provider?.config?.providerName || '').toLowerCase() !== 'webbrain-cloud') return 0;
  if (typeof provider.sendRuntimeEvents !== 'function') return 0;
  await storageQueue.catch(() => {});
  let snapshot;
  try { snapshot = await readOutbox(); } catch { return 0; }
  if (!snapshot.length) return 0;
  const groups = new Map();
  for (const entry of snapshot) {
    if (!groups.has(entry.session_id)) groups.set(entry.session_id, []);
    groups.get(entry.session_id).push(entry);
  }
  const removeIds = new Set();
  for (const [sessionId, entries] of groups) {
    for (let index = 0; index < entries.length; index += 50) {
      const batch = entries.slice(index, index + 50);
      let result;
      try {
        result = await provider.sendRuntimeEvents(
          sessionId,
          batch.map(({ event_id, event }) => ({ event_id, event })),
        );
      } catch {
        result = { ok: false, retryable: true };
      }
      if (result?.ok === true || result?.retryable === false) {
        for (const entry of batch) removeIds.add(entry.event_id);
      }
    }
  }
  if (removeIds.size) {
    await updateOutbox(current => current.filter(entry => !removeIds.has(entry?.event_id)));
  }
  return removeIds.size;
}

export const CLOUD_RUNTIME_OUTBOX_STORAGE_KEY = STORAGE_KEY;
