import { D1_MODEL_ID, D1_CONSENT_KEY, D1_CONSENT_VERSION } from './d1-config.js';
import { dispatchD1Worker, resetD1Worker } from './d1-host.js';

export async function d1Request(command, payload = {}, { timeoutMs = 90_000, signal } = {}) {
  const api = globalThis.browser || globalThis.chrome;
  const consent = await api.storage.local.get(D1_CONSENT_KEY);
  if (['evaluate', 'load', 'download'].includes(command) && consent[D1_CONSENT_KEY] !== D1_CONSENT_VERSION) throw new Error('D1 is experimental and requires explicit local-model consent.');
  if (signal?.aborted) throw signal.reason;
  const abort = () => { void d1Request('reset').catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (command === 'reset') { resetD1Worker(); return { reset: true }; }
    const result = await dispatchD1Worker(command, payload, timeoutMs);
    if (signal?.aborted) throw signal.reason; return result;
  } finally { signal?.removeEventListener('abort', abort); }
}

export async function evaluateD1(args) {
  if (args.config?.model !== D1_MODEL_ID) throw new Error('Only the pinned experimental D1 package is supported.');
  return d1Request('evaluate', { state: args.state, questions: args.questions, images: args.images }, { timeoutMs: 90_000, signal: args.signal });
}
