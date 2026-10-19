import { D1_MODEL_ID, D1_CONSENT_KEY, D1_CONSENT_VERSION, D1_KEEP_LOADED_KEY } from './d1-config.js';
import { cancelD1Request, dispatchD1Worker, resetD1Worker } from './d1-host.js';

const newRequestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export async function d1Request(command, payload = {}, { timeoutMs = 90_000, signal } = {}) {
  const api = globalThis.browser || globalThis.chrome;
  const stored = await api.storage.local.get([D1_CONSENT_KEY, D1_KEEP_LOADED_KEY]);
  if (['evaluate', 'load', 'download'].includes(command) && stored[D1_CONSENT_KEY] !== D1_CONSENT_VERSION) throw new Error('D1 is experimental and requires explicit local-model consent.');
  if (signal?.aborted) throw signal.reason;
  // A caller that stops waiting (a judge timeout, Stop) cancels only its own
  // evaluation; the loaded model stays for the next decision. The Worker's
  // own deadline (d1-host.js) still discards a stalled session.
  if (command === 'evaluate') payload = { ...payload, requestId: newRequestId(), consentVersion: stored[D1_CONSENT_KEY], keepLoaded: stored[D1_KEEP_LOADED_KEY] === true };
  const abort = () => cancelD1Request(payload.requestId);
  if (command === 'evaluate') signal?.addEventListener('abort', abort, { once: true });
  try {
    if (command === 'reset') { resetD1Worker(); return { reset: true }; }
    if (command === 'cancel') { cancelD1Request(payload.requestId); return { cancelled: true }; }
    const result = await dispatchD1Worker(command, payload, timeoutMs);
    if (signal?.aborted) throw signal.reason; return result;
  } finally { signal?.removeEventListener('abort', abort); }
}

export async function evaluateD1(args) {
  if (args.config?.model !== D1_MODEL_ID) throw new Error('Only the pinned experimental D1 package is supported.');
  return d1Request('evaluate', { state: args.state, questions: args.questions, images: args.images }, { timeoutMs: 90_000, signal: args.signal });
}
