/**
 * Trace run header — allowlisted normalization for the session-lineage fields
 * stored on every run record by trace/recorder.js.
 *
 * Pure and browser-neutral so it can be unit-tested in test/run.js without a
 * DOM or IndexedDB.
 *
 * `conversationId` is WebBrain's session identity (the Traces UI groups runs
 * by it). On top of that, a run can name its parent run, the parent's session
 * id, and its delegation depth — the chain that answers "which root run did
 * this derived run come from" for cloud runs, workflow replays, and any future
 * forked execution.
 *
 * These fields are identifiers and integers only; nothing content-bearing is
 * accepted here. Bounds follow the runtime-config.js allowlist pattern so a
 * caller can never smuggle credentials or message text into a trace via the
 * lineage fields.
 */

const MAX_ID_LENGTH = 200;
const MAX_DEPTH = 64;

function safeId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > MAX_ID_LENGTH) return null;
  // Ids are opaque but printable; strip control characters so a malformed
  // value can never corrupt an export or a query key.
  if (/[\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}

function safeDepth(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_DEPTH) return null;
  return n;
}

/**
 * Normalize the lineage portion of a run header. Returns null when nothing
 * valid is present, otherwise a partial object with only valid fields.
 */
export function normalizeRunHeader(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out = {};
  const parentRunId = safeId(meta.parentRunId);
  const parentSessionId = safeId(meta.parentSessionId);
  const delegationDepth = safeDepth(meta.delegationDepth);
  if (parentRunId) out.parentRunId = parentRunId;
  if (parentSessionId) out.parentSessionId = parentSessionId;
  if (delegationDepth != null) out.delegationDepth = delegationDepth;
  return Object.keys(out).length ? out : null;
}

/**
 * Resolve the run's own delegation depth: an explicit normalized depth wins;
 * a run with a parent but no depth is a direct child (depth 1); everything
 * else is a root run (depth 0).
 */
export function effectiveDelegationDepth(header) {
  if (header && header.delegationDepth != null) return header.delegationDepth;
  if (header && header.parentRunId) return 1;
  return 0;
}

/**
 * Mint a new trace run id: `run_<base36 ms timestamp>_<base36 token>`.
 *
 * Run ids leave the browser as Cloud share/diagnostic keys (client_share_id,
 * `diag_<runId>`, `<runId>:1:terminal_runtime`), where payment-card redaction
 * rewrites Luhn-valid 13–19 digit runs. A decimal Date.now() is 13 digits and
 * passes Luhn about one time in ten, which turned those ids into
 * "[payment card removed]". Base36 keeps the time component without a long
 * decimal run. Ids stay opaque: nothing parses the time back out (ordering
 * uses startedAt), so older `run_<decimal ms>_…` ids remain valid keys.
 * The caller supplies the random token so this module stays pure.
 */
export function generateTraceRunId(now, token) {
  const ms = Number(now);
  const time = Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : 0;
  const suffix = String(token ?? '').toLowerCase().replace(/[^0-9a-z]/g, '') || '0';
  return `run_${time.toString(36)}_${suffix}`;
}