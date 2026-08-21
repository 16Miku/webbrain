/**
 * Trace event model — the shared vocabulary and envelope for the per-run event
 * log written by trace/recorder.js.
 *
 * Pure and browser-neutral so it can be unit-tested in test/run.js without a
 * DOM or IndexedDB.
 *
 * The recorder stores events as {runId, seq, ts, kind, data}. This module owns:
 *   - the authoritative list of known event kinds. The recorder, Traces UI,
 *     and exporters consult it instead of maintaining their own lists, so a
 *     new event type has one place to be declared;
 *   - the run-level trace format version stamped on every new run record, so
 *     a future schema change can detect old traces instead of misreading them;
 *   - envelope construction with write-side validation: unknown kinds and
 *     data that cannot survive a JSON round-trip are rejected here, so a
 *     recording bug surfaces at write time rather than as a ghost event.
 *
 * Events are privacy-filtered at their recording call sites (see
 * prompt-provenance.js); nothing in this module adds or requires content.
 */

export const TRACE_FORMAT_VERSION = 1;

export const EVENT_KINDS = Object.freeze([
  'llm_request',
  'llm_response',
  'tool',
  'screenshot',
  'error',
  'streaming',
  'note',
  'vision_sub_call',
  'vision_route',
]);

// Kinds that readers may safely collapse. Empty today: the mechanism exists so
// a future "the UI can skip this" event type has a defined place instead of
// each reader inventing its own skip list.
export const IGNORABLE_KINDS = Object.freeze([]);

const KNOWN_KINDS = new Set(EVENT_KINDS);

export function isKnownKind(kind) {
  return KNOWN_KINDS.has(kind);
}

export function isIgnorableKind(kind) {
  return IGNORABLE_KINDS.includes(kind);
}

/**
 * Build a writable event envelope. Returns null — never throws — when the
 * event cannot be recorded: unknown kind, or data that JSON.stringify cannot
 * represent. The recorder skips a null envelope with a warning so a recording
 * bug can never break a run.
 */
export function makeEvent(runId, seq, kind, data) {
  if (!isKnownKind(kind)) return null;
  const payload = data == null ? null : data;
  if (payload !== null) {
    try {
      JSON.stringify(payload);
    } catch {
      return null;
    }
  }
  const ev = { runId, seq, ts: Date.now(), kind, data: payload };
  if (isIgnorableKind(kind)) ev.ignorable = true;
  return ev;
}

/**
 * Read-side validation of an ordered event list: seq must be contiguous from
 * 1 and kinds must be known. Tolerant by design — the caller decides what to
 * do; the Traces UI keeps rendering unknown events rather than failing the
 * whole run view.
 *
 * @returns {{ok: boolean, firstGap: number|null, unknownKinds: string[]}}
 */
export function validateEventLog(events) {
  const list = Array.isArray(events) ? events : [];
  let expected = 1;
  const unknownKinds = [];
  for (const ev of list) {
    if (!ev) continue;
    if (ev.seq === expected) expected += 1;
    if (!isKnownKind(ev.kind) && !unknownKinds.includes(ev.kind)) unknownKinds.push(ev.kind);
  }
  const contiguous = expected - 1 === list.length;
  return {
    ok: contiguous && unknownKinds.length === 0,
    firstGap: contiguous ? null : expected,
    unknownKinds,
  };
}