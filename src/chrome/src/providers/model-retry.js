export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const ms = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

// OpenAI also answers exhausted billing with HTTP 429 (insufficient_quota).
// No cooldown restores credit, so these codes fail at once instead of being
// retried as a rate limit.
const BILLING_QUOTA_CODES = new Set(['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active']);
export function isBillingQuotaError(error) {
  return BILLING_QUOTA_CODES.has(String(error?.code ?? '').trim().toLowerCase());
}

/**
 * Rate limits (429) and Anthropic's documented "temporarily overloaded" 529
 * clear on their own within seconds, so both get the long cooldowns.
 */
export function isRateLimitClass(error) {
  return (error?.httpStatus === 429 || error?.httpStatus === 529) && !isBillingQuotaError(error);
}

const RATE_LIMIT_IDS = new Set(['429', 'rate_limit_exceeded', 'rate_limited', 'rate_limit_error', 'too_many_requests']);
const OVERLOADED_IDS = new Set(['529', 'overloaded_error']);

/**
 * The 429/529 equivalent of a provider error object that arrived after an
 * HTTP 200 (an SSE error event or an error-only JSON body), or null. Such an
 * error has no response status, so a transient limit would look permanent.
 */
export function rateLimitStatusOf(providerError) {
  if (!providerError || typeof providerError !== 'object') return null;
  const ids = [providerError.code, providerError.type, providerError.metadata?.error_type]
    .map(id => String(id ?? '').trim().toLowerCase());
  if (ids.some(id => RATE_LIMIT_IDS.has(id))) return 429;
  if (ids.some(id => OVERLOADED_IDS.has(id))) return 529;
  return /rate.?limit|too many requests/i.test(String(providerError.message || '')) ? 429 : null;
}

function cancelled(isAborted) {
  if (isAborted()) throw new DOMException('The operation was aborted', 'AbortError');
}

// Clients limited by the same window would otherwise all retry in lockstep.
// The spread only lengthens a cooldown: the 5/15/30 s schedule is the
// minimum wait a provider's limit window is given, and the longest spread
// schedule (6 + 18 + 36 s) still fits the 60 s budget.
function jittered(ms, random) {
  const spread = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(ms * (1 + 0.2 * spread));
}

/** Recover a single inference turn; completed browser tools are never replayed. */
export async function retryModelCall(initialError, call, {
  isAborted = () => false,
  onRetry = async () => {},
  random = Math.random,
  sleep = async ms => {
    while (ms > 0) {
      cancelled(isAborted);
      const chunk = Math.min(ms, 250);
      await new Promise(resolve => setTimeout(resolve, chunk));
      ms -= chunk;
    }
  },
} = {}) {
  if (isBillingQuotaError(initialError)) throw initialError;
  const rateLimited = isRateLimitClass(initialError);
  const cloudUpstream = initialError?.code === 'webbrain_cloud_upstream_error';
  const delays = rateLimited ? [5000, 15000, 30000] : cloudUpstream ? [2000, 5000] : [2000];
  let error = initialError, waited = 0;
  for (let i = 0; i < delays.length; i++) {
    cancelled(isAborted);
    const hint = Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0;
    const delayMs = Math.max(rateLimited ? jittered(delays[i], random) : delays[i], hint);
    // Never disregard a provider's longer cooldown or keep a run indefinitely.
    if (waited + delayMs > 60000) throw error;
    await onRetry({ error, delayMs, attempt: i + 1 });
    await sleep(delayMs);
    waited += delayMs;
    cancelled(isAborted);
    try { return await call(); }
    catch (next) {
      error = next;
      // Text already streamed to the user by this attempt is never generated again.
      if (error?.webbrainOutputEmitted === true) throw error;
      if (rateLimited ? !isRateLimitClass(error)
        : !cloudUpstream || error?.code !== 'webbrain_cloud_upstream_error') throw error;
    }
  }
  throw error;
}

/**
 * Retry stream startup only; emitted text/tool events must never be replayed.
 * Startup ends at the first event options.isOutput accepts (by default the
 * first event). Earlier events the caller never shows, such as reasoning, are
 * held back, so a rate limit that interrupts them is retried like one before
 * the first event and the failed attempt's held events are discarded.
 */
export async function* retryModelStream(createStream, options = {}) {
  const isAborted = options.isAborted || (() => false);
  const isOutput = options.isOutput || (() => true);
  let iterator = null;
  const close = async () => {
    const abandoned = iterator;
    iterator = null;
    try { await abandoned?.return?.(); } catch {}
  };
  const start = async () => {
    try {
      cancelled(isAborted);
      const stream = await createStream();
      iterator = stream[Symbol.asyncIterator]();
      const held = [];
      while (true) {
        const next = await iterator.next();
        cancelled(isAborted);
        if (next.done || isOutput(next.value)) return { held, next };
        held.push(next.value);
      }
    } catch (error) {
      await close();
      throw error;
    }
  };
  try {
    let first;
    try { first = await start(); }
    catch (error) {
      if (error?.code !== 'webbrain_cloud_upstream_error' && !isRateLimitClass(error)) throw error;
      first = await retryModelCall(error, start, options);
    }
    yield* first.held;
    if (first.next.done) return;
    yield first.next.value;
    while (true) {
      cancelled(isAborted);
      const next = await iterator.next();
      cancelled(isAborted);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await close();
  }
}
