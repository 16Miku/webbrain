import { makeEvent } from './event-model.js';
import { normalizeErrorCode } from './error-codes.js';

// A run can legitimately take a while, so repair only treats records older
// than this conservative window as abandoned. Callers/tests may provide a
// smaller explicit threshold when they need a deterministic boundary.
export const TRACE_REPAIR_STALE_AFTER_MS = 10 * 60 * 1000;
export const TRACE_REPAIR_MARKER = 'service-worker-eviction';
export const TRACE_REPAIR_ERROR_CODE = 'SERVICE_WORKER_EVICTED';
export const TRACE_REPAIR_REASON = 'service_worker_eviction';
export const TRACE_REPAIR_MESSAGE = 'Trace run interrupted by service-worker eviction.';

function repairEvent(runId, seq, kind, data, now) {
  const event = makeEvent(runId, seq, kind, data);
  return event ? { ...event, ts: now } : null;
}

function eventStep(event) {
  return Number.isInteger(event?.data?.step) ? event.data.step : null;
}

function openSteps(events) {
  const open = new Map();
  for (const event of events) {
    if (event?.kind === 'step_start') open.set(eventStep(event), eventStep(event));
    if (event?.kind === 'step_end') open.delete(eventStep(event));
  }
  return [...open.values()].sort((a, b) => (a ?? 0) - (b ?? 0));
}

function openTurnStep(events) {
  let step = null;
  for (const event of events) {
    if (event?.kind === 'turn_start') step = eventStep(event);
    if (event?.kind === 'turn_end') step = null;
  }
  return step;
}

function normalizedThreshold(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : TRACE_REPAIR_STALE_AFTER_MS;
}

export function isStaleRunningTrace(run, { now = Date.now(), staleAfterMs = TRACE_REPAIR_STALE_AFTER_MS } = {}) {
  if (!run || run.status !== 'running' || run.repairedBy) return false;
  const startedAt = Number(run.startedAt);
  const currentTime = Number(now);
  if (!Number.isFinite(startedAt) || !Number.isFinite(currentTime)) return false;
  return currentTime - startedAt >= normalizedThreshold(staleAfterMs);
}

/**
 * Build the durable repair mutation for one abandoned trace.
 *
 * This is deliberately pure: the recorder applies the returned event/run
 * values in one IndexedDB transaction, while tests can prove the interruption
 * semantics without a browser or a real IndexedDB implementation.
 */
export function buildTraceRepairPlan(run, events, {
  now = Date.now(),
  staleAfterMs = TRACE_REPAIR_STALE_AFTER_MS,
} = {}) {
  if (!isStaleRunningTrace(run, { now, staleAfterMs })) return null;
  const orderedEvents = (Array.isArray(events) ? events : [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  const lastSeq = orderedEvents.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
  const code = normalizeErrorCode(TRACE_REPAIR_ERROR_CODE);
  const repairedEvents = [];
  let nextSeq = lastSeq + 1;

  for (const step of openSteps(orderedEvents)) {
    repairedEvents.push(repairEvent(run.runId, nextSeq++, 'step_end', {
      step,
      ok: false,
      reason: TRACE_REPAIR_REASON,
      code,
      repaired: true,
    }, now));
  }

  repairedEvents.push(repairEvent(run.runId, nextSeq++, 'error', {
    step: null,
    phase: 'repair',
    message: TRACE_REPAIR_MESSAGE,
    code,
  }, now));

  const turnStep = openTurnStep(orderedEvents);
  if (turnStep !== null) {
    repairedEvents.push(repairEvent(run.runId, nextSeq, 'turn_end', {
      step: turnStep,
      status: 'error',
      reason: TRACE_REPAIR_REASON,
      code,
      repaired: true,
    }, now));
  }

  const maxStep = orderedEvents.reduce((max, event) => Math.max(max, eventStep(event) ?? 0), 0);
  const startedAt = Number(run.startedAt);
  return {
    events: repairedEvents.filter(Boolean),
    run: {
      ...run,
      endedAt: now,
      durationMs: Math.max(0, now - startedAt),
      status: 'error',
      stepCount: Math.max(Number(run.stepCount) || 0, maxStep),
      repairedBy: TRACE_REPAIR_MARKER,
      repairedAt: now,
      repairReason: TRACE_REPAIR_REASON,
    },
  };
}
