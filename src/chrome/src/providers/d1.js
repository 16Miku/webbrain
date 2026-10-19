import { D1_MODEL_ID, D1_CONSENT_KEY, D1_CONSENT_VERSION, D1_KEEP_LOADED_KEY } from './d1-config.js';
import { ensureOffscreen } from '../offscreen/ensure.js';
import { cancelD1Request, dispatchD1Worker, resetD1Worker } from './d1-host.js';

const newRequestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const hostError = response => Object.assign(new Error(response?.error || 'D1 offscreen host unavailable.'), typeof response?.code === 'string' ? { code: response.code } : {});

export async function d1Request(command, payload = {}, { timeoutMs = 90_000, signal } = {}) {
  const api = globalThis.browser || globalThis.chrome;
  const stored = await api.storage.local.get([D1_CONSENT_KEY, D1_KEEP_LOADED_KEY]);
  if (['evaluate', 'load', 'download'].includes(command) && stored[D1_CONSENT_KEY] !== D1_CONSENT_VERSION) throw new Error('D1 is experimental and requires explicit local-model consent.');
  if (signal?.aborted) throw signal.reason;
  // A caller that stops waiting (a judge timeout, Stop) cancels only its own
  // evaluation; the loaded model stays for the next decision. The Worker's
  // own deadline (d1-host.js) still discards a stalled session.
  if (command === 'evaluate') payload = { ...payload, requestId: newRequestId(), consentVersion: stored[D1_CONSENT_KEY], keepLoaded: stored[D1_KEEP_LOADED_KEY] === true };
  const abort = () => { void d1Request('cancel', { requestId: payload.requestId }).catch(() => {}); };
  if (command === 'evaluate') signal?.addEventListener('abort', abort, { once: true });
  try {
    let result;
    if (api.offscreen?.createDocument) {
      if (['reset', 'dispose', 'stop', 'cancel'].includes(command) && !await api.offscreen.hasDocument()) return { reset: true };
      await ensureOffscreen();
      if (signal?.aborted) throw signal.reason;
      const response = await api.runtime.sendMessage({ type: 'd1-offscreen', command, payload, timeoutMs });
      if (!response?.ok) throw hostError(response); result = response.result;
    } else {
      if (command === 'reset') { resetD1Worker(); return { reset: true }; }
      if (command === 'cancel') { cancelD1Request(payload.requestId); return { cancelled: true }; }
      result = await dispatchD1Worker(command, payload, timeoutMs);
    }
    if (signal?.aborted) throw signal.reason; return result;
  } finally { signal?.removeEventListener('abort', abort); }
}

export async function evaluateD1(args) {
  if (args.config?.model !== D1_MODEL_ID) throw new Error('Only the pinned experimental D1 package is supported.');
  return d1Request('evaluate', { state: args.state, questions: args.questions, images: args.images }, { timeoutMs: 90_000, signal: args.signal });
}
