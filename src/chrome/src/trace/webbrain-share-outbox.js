// Voluntary per-provider "share queries for research" outbox. Mirrors the
// Compass cloud-runtime outbox: writes are durable and awaited, network
// delivery is detached and retried by the next run. Unlike runtime events,
// each entry is a complete generation (request + response + attribution) and
// ships to POST /improvement/generations through the WebBrain Compass
// provider instance (its base URL hosts the backend), independent of which
// provider produced the run.

const STORAGE_KEY = 'webbrainShareOutboxV1';
const MAX_OUTBOX_ITEMS = 100;
const MAX_MESSAGE_CHARS = 10_000;
const MAX_REQUEST_BUDGET = 150_000;
const MAX_RESPONSE_CHARS = 40_000;
let storageQueue = Promise.resolve();
let flushQueue = Promise.resolve();
let fallbackRunCounter = 0;

function bounded(value, limit) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const text = typeof serialized === 'string' ? serialized : String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[… ${text.length - limit} characters omitted]`;
}

function clampText(value, limit = MAX_MESSAGE_CHARS) {
  if (typeof value !== 'string') return value;
  return bounded(value, limit);
}

// Remove embedded binary payloads from free text before clamping. Tool
// results are plain strings, so a canvas toDataURL(), screenshot bytes, or
// other base64 blob echoed into `message.content` would otherwise leave the
// browser unchanged (containsBinaryBlock never sees string content).
function scrubText(value, limit = MAX_MESSAGE_CHARS) {
  if (typeof value !== 'string') return value;
  let text = value;
  if (text.includes('data:')) {
    // Detect data URIs regardless of surrounding string or payload length:
    // even a 1x1 canvas/QR thumbnail is image bytes the UI promises to strip.
    // Newlines (but not spaces/words) are allowed inside the payload so
    // wrapped base64 is still removed while surrounding prose survives.
    text = text.replace(
      /data:(image|audio|video|application|font|model)\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\r\n]+/g,
      '[embedded base64 data omitted]',
    );
  }
  // Bare base64 blobs without a data: wrapper (e.g. read_downloaded_file
  // serializes small binaries as {"base64":"..."} into string tool content).
  // A 200+ run of base64 alphabet characters never occurs in prose, hashes,
  // or URLs (delimiters break the run), so redact it from research copies.
  if (/[A-Za-z0-9+/=\r\n]{200,}/.test(text)) {
    text = text
      .replace(/"base64"\s*:\s*"[A-Za-z0-9+/=\r\n]+"/g, '"base64":"[omitted]"')
      .replace(/[A-Za-z0-9+/]{200}[A-Za-z0-9+/=\r\n]*/g, '[embedded base64 data omitted]');
  }
  return bounded(text, limit);
}

function containsBinaryBlock(value) {
  // Bare data-URI strings can appear as array items or nested values (e.g.
  // screenshot bytes echoed into a tool result). Check anywhere in the
  // string, at any length: even tiny thumbnails are image bytes.
  if (typeof value === 'string') {
    return value.includes('data:')
      && /data:(image|audio|video|application)\/[^;]+;base64,/i.test(value);
  }
  if (!value || typeof value !== 'object') return false;
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
  if (type === 'image_url' || type === 'image' || type === 'document'
    || type === 'file' || type === 'input_file' || type === 'image_file' || type === 'pdf') return true;
  // Anthropic document/file blocks: { source: { type: 'base64', data: '...' } }.
  // Also catch { source: { data: '<long blob>' } } where the type tag varies
  // across provider contracts but the payload is still raw bytes.
  if (value.source && typeof value.source === 'object') {
    if (value.source.type === 'base64') return true;
    if (typeof value.source.data === 'string' && value.source.data.length > 50) return true;
  }
  // Generic base64 payload fields (OpenAI input_file, attachments, etc.).
  // Long user text lives in .text, never in .data, so this is safe.
  if (typeof value.data === 'string' && value.data.length > 50) return true;
  if (typeof value.url === 'string' && value.url.length > 1000 && value.url.startsWith('data:')) return true;
  if (Array.isArray(value)) return value.some(containsBinaryBlock);
  return Object.values(value).some(containsBinaryBlock);
}

function requestMessages(messages, responseContent) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const want = String(responseContent ?? '').trim();
  if (!want) return [...messages];
  // Only ever strip a trailing terminal answer. Pre-response snapshots (e.g.
  // the streaming path's captured request) contain no terminal message, and a
  // backward scan could otherwise delete earlier history that happens to
  // equal the response (asking the model to repeat a prior answer).
  const request = [...messages];
  const last = request[request.length - 1];
  if (last?.role !== 'assistant') return request;
  if (typeof last.content === 'string' && last.content.trim() === want) {
    request.pop();
  } else if (Array.isArray(last.content) && last.content.length === 1
    && last.content[0]?.type === 'text'
    && String(last.content[0]?.text ?? '').trim() === want) {
    request.pop();
  }
  return request;
}

// Fields that by name always carry binary payloads (any length counts:
// a field literally named imageBase64 is image bytes even when tiny).
const BINARY_VALUE_KEYS = /^(imageBase64|image_base64|screenshot|screenshotBase64|screenshot_data|imageData|image_data|audioBase64|audio_data|fileData|file_data|imageBytes|base64)$/i;

// Scrub tool-call arguments JSON: raw binary rides in fields like
// solve_captcha's imageBase64 for image_to_text, which the content scrubber
// never sees because it lives in tool_calls[].function.arguments.
function scrubToolCallArguments(args) {
  if (typeof args !== 'string' || !args) return args;
  let parsed;
  try { parsed = JSON.parse(args); } catch { return scrubText(args); }
  if (!parsed || typeof parsed !== 'object') return scrubText(args);
  try {
    const scrubbed = JSON.stringify(scrubValue(parsed));
    return typeof scrubbed === 'string' ? scrubbed : scrubText(args);
  } catch { return scrubText(args); }
}

// Recursively scrub non-content message fields (tool_calls, metadata).
// Known-binary keys are redacted at any length; other strings go through the
// data-URI/base64 text scrub so nested blobs cannot leak via copied fields.
function scrubValue(value) {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string' && BINARY_VALUE_KEYS.test(key)) {
        out[key] = '[omitted]';
        continue;
      }
      if (key === 'arguments' && typeof entry === 'string') {
        out[key] = scrubToolCallArguments(entry);
        continue;
      }
      out[key] = scrubValue(entry);
    }
    return out;
  }
  return value;
}

function scrubMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const copy = { role: message.role };
  if (message.tool_call_id !== undefined) copy.tool_call_id = message.tool_call_id;
  if (message.name !== undefined) copy.name = message.name;
  // Assistant tool-call turns carry the trajectory (and, on multi-step runs,
  // raw binary such as solve_captcha imageBase64 in arguments JSON). Scrub
  // the calls instead of copying them verbatim.
  if (Array.isArray(message.tool_calls)) {
    copy.tool_calls = message.tool_calls.map(call =>
      (!call || typeof call !== 'object') ? call : scrubValue(call));
  }
  // Drop known binary attachments outright; scrub any other metadata rather
  // than copying it verbatim into the research record.
  for (const [key, value] of Object.entries(message)) {
    if (key === 'role' || key === 'content' || key === 'tool_calls'
      || key === 'tool_call_id' || key === 'name') continue;
    if (key === 'image_url' || key === '_attachImage' || key === '_attachDocument') continue;
    const scrubbed = scrubValue(value);
    if (scrubbed !== undefined) copy[key] = scrubbed;
  }
  if (Array.isArray(message.content)) {
    const items = [];
    for (const item of message.content) {
      if (typeof item === 'string') {
        // Primitive string parts never reach containsBinaryBlock: scrub any
        // embedded data URIs here before clamping.
        items.push(scrubText(item));
        continue;
      }
      if (!item || typeof item !== 'object') {
        items.push(item);
        continue;
      }
      // Drop images entirely so raw screenshot/data-URI bytes never leave the
      // browser; text blocks are scrubbed of embedded payloads, then clamped.
      if (containsBinaryBlock(item)) continue;
      if (item.type === 'text' && typeof item.text === 'string') {
        items.push({ ...item, text: scrubText(item.text) });
        continue;
      }
      // Unrecognized objects still pass through nested strings (data URIs,
      // bare base64) and known-binary keys before being shared.
      items.push(scrubValue(item));
    }
    if (!items.length) return { role: message.role, content: '[binary content omitted]' };
    copy.content = items;
  } else if (typeof message.content === 'string') {
    if (!message.content.length) return null;
    copy.content = scrubText(message.content);
  } else if (message.content == null && Object.hasOwn(message, 'content')) {
    // Assistant tool-call turns carry content: null; preserve the marker.
    copy.content = message.content;
  }
  return copy;
}

function scrubMessages(messages) {
  if (!Array.isArray(messages)) return null;
  // Scrub every message first (per-message work is order-independent).
  const scrubbedAll = [];
  for (const message of messages) {
    const copy = scrubMessage(message);
    if (copy == null) continue;
    let serialized;
    try { serialized = JSON.stringify(copy); } catch { continue; }
    if (serialized == null) continue;
    scrubbedAll.push({ copy, size: serialized.length });
  }
  if (!scrubbedAll.length) return [];
  const hasSystemPrompt = scrubbedAll[0].copy.role === 'system';
  // A single clamped message always fits in practice; guard anyway so one
  // pathological turn cannot blow the whole-request budget on its own.
  if (hasSystemPrompt && scrubbedAll[0].size > MAX_REQUEST_BUDGET) {
    return [{ role: 'system', content: '[earlier shared messages omitted]' }];
  }
  // Preserve the tail: the newest user/tool turns directly produced the
  // uploaded response, while the oldest turns are the least relevant. Keep a
  // leading system prompt when present, then fill newest-first within the
  // budget and message cap. Dropped head turns are replaced by one marker so
  // the gap is explicit instead of silently pairing the answer with stale
  // context.
  const MAX_SCRUBBED_MESSAGES = 200;
  const kept = [];
  let budget = MAX_REQUEST_BUDGET;
  if (hasSystemPrompt) budget = Math.max(0, budget - scrubbedAll[0].size);
  let startIndex = scrubbedAll.length;
  const reserve = (entry) => {
    if (kept.length >= MAX_SCRUBBED_MESSAGES || entry.size > budget) return false;
    kept.push(entry);
    budget -= entry.size;
    return true;
  };
  for (let index = scrubbedAll.length - 1; index >= 0; index--) {
    if (index === 0 && scrubbedAll[index].copy.role === 'system') continue;
    if (!reserve(scrubbedAll[index])) break;
    startIndex = index;
  }
  kept.reverse();
  const headOmitted = startIndex > (hasSystemPrompt ? 1 : 0);
  const omissionMarker = { role: 'system', content: '[earlier shared messages omitted]' };
  const out = [];
  if (hasSystemPrompt) out.push(scrubbedAll[0].copy);
  if (headOmitted) out.push(omissionMarker);
  for (const entry of kept) out.push(entry.copy);
  // Charge the wrapper entries and JSON array delimiters, which the
  // per-message budget above does not count: trim oldest shared turns until
  // both the message cap and the byte budget hold for the final payload.
  const wrapperFloor = out.length - kept.length; // system + marker entries
  let outJson = '';
  try { outJson = JSON.stringify(out); } catch { outJson = ''; }
  let trimmed = false;
  while ((out.length > MAX_SCRUBBED_MESSAGES || (outJson && outJson.length > MAX_REQUEST_BUDGET))
    && out.length > wrapperFloor) {
    out.splice(wrapperFloor, 1);
    trimmed = true;
    try { outJson = JSON.stringify(out); } catch { break; }
  }
  if (trimmed && !headOmitted) {
    out.splice(hasSystemPrompt ? 1 : 0, 0, omissionMarker);
    if (out.length > MAX_SCRUBBED_MESSAGES) out.splice(hasSystemPrompt ? 2 : 1, 1);
    try { outJson = JSON.stringify(out); } catch { /* keep best effort */ }
    while (outJson && outJson.length > MAX_REQUEST_BUDGET && out.length > (hasSystemPrompt ? 2 : 1)) {
      out.splice(hasSystemPrompt ? 2 : 1, 1);
      try { outJson = JSON.stringify(out); } catch { break; }
    }
  }
  return out;
}

export function buildShareGenerationItem({
  runId,
  finalContent,
  messages,
  model,
  mode,
  provider,
  provider_name,
}) {
  const responseContent = String(finalContent ?? '');
  if (!responseContent.trim()) return null;
  const request = scrubMessages(requestMessages(messages, responseContent));
  if (!request?.length) return null;
  const generatedId = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}_${(++fallbackRunCounter).toString(36)}`;
  return {
    id: String(runId || `share_${generatedId}`),
    provider: String(provider || '').slice(0, 64),
    provider_name: String(provider_name || '').slice(0, 128),
    model: String(model || '').slice(0, 255),
    mode: String(mode || '').slice(0, 32),
    request,
    response: { role: 'assistant', content: scrubText(responseContent, MAX_RESPONSE_CHARS) },
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
    await localStorageArea().set({ [STORAGE_KEY]: value.slice(-MAX_OUTBOX_ITEMS) });
    return value;
  });
  storageQueue = next;
  return next;
}

export async function enqueueShareGeneration(item) {
  if (!item?.id || item.request === undefined || item.response === undefined) return false;
  await updateOutbox(current => {
    if (current.some(entry => entry?.id === item.id)) return current;
    return [...current, { ...item, queued_at: Date.now() }];
  });
  return true;
}

// Drop queued entries the predicate no longer consents to (e.g. the user
// revoked "share queries for research" after an offline/failed run queued an
// entry). Run before every flush so revocation is honored immediately before
// delivery, not just at enqueue time. Returns the dropped count.
export async function purgeShareGenerations(shouldDrop) {
  if (typeof shouldDrop !== 'function') return 0;
  let removed = 0;
  await updateOutbox(current => {
    const kept = [];
    for (const entry of current) {
      let drop = false;
      try { drop = shouldDrop(entry) === true; } catch { drop = false; }
      if (drop) removed++;
      else kept.push(entry);
    }
    return removed ? kept : current;
  });
  return removed;
}

async function flushShareOutboxNow(transportProvider) {
  if (typeof transportProvider?.sendShareGeneration !== 'function') return 0;
  await storageQueue.catch(() => {});
  let snapshot;
  try { snapshot = await readOutbox(); } catch { return 0; }
  if (!snapshot.length) return 0;
  const removeIds = new Set();
  for (const entry of snapshot) {
    let result;
    try {
      result = await transportProvider.sendShareGeneration(entry.session_id, {
        client_share_id: entry.id,
        provider: entry.provider,
        provider_name: entry.provider_name,
        model: entry.model,
        mode: entry.mode,
        request: entry.request,
        response: entry.response,
      });
    } catch {
      result = { ok: false, retryable: true };
    }
    if (result?.ok === true || result?.retryable === false) removeIds.add(entry.id);
  }
  if (removeIds.size) {
    await updateOutbox(current => current.filter(entry => !removeIds.has(entry?.id)));
  }
  return removeIds.size;
}

export function flushShareOutbox(transportProvider) {
  const next = flushQueue.catch(() => {}).then(() => flushShareOutboxNow(transportProvider));
  flushQueue = next;
  return next;
}

export const SHARE_OUTBOX_STORAGE_KEY = STORAGE_KEY;
