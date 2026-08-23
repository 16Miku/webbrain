/**
 * Pure trace statistics reducers shared by the recorder, Traces UI, and tests.
 *
 * Event statistics are computed once when a run is finalized and persisted on
 * its run record. Session statistics then sum those bounded run snapshots
 * through the existing conversation/session index without replaying events.
 */

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
function stepNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

export function createTraceStats() {
  return {
    stepCount: 0,
    llmRequestCount: 0,
    llmResponseCount: 0,
    toolCallCount: 0,
    visionSubCallCount: 0,
    errorCount: 0,
    retryCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    totalLlmLatencyMs: 0,
    totalToolLatencyMs: 0,
    hasLoopError: false,
  };
}

export function addTraceEvent(stats, event) {
  if (!stats || !event || typeof event !== 'object') return stats;
  const data = event.data && typeof event.data === 'object' ? event.data : {};

  if (event.kind === 'llm_request') {
    stats.llmRequestCount += 1;
  } else if (event.kind === 'llm_response') {
    stats.llmResponseCount += 1;
    stats.stepCount = Math.max(stats.stepCount, stepNumber(data.step));
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
    stats.totalInputTokens += nonNegativeNumber(usage.prompt_tokens);
    stats.totalOutputTokens += nonNegativeNumber(usage.completion_tokens);
    stats.totalCost += nonNegativeNumber(usage.cost);
    stats.totalLlmLatencyMs += nonNegativeNumber(data.latencyMs);
  } else if (event.kind === 'tool') {
    stats.toolCallCount += 1;
    stats.totalToolLatencyMs += nonNegativeNumber(data.latencyMs);
  } else if (event.kind === 'vision_sub_call') {
    stats.visionSubCallCount += 1;
  } else if (event.kind === 'error') {
    stats.errorCount += 1;
    if (data.phase === 'loop') stats.hasLoopError = true;
  } else if (event.kind === 'note' && data.note === 'llm_retry') {
    stats.retryCount += 1;
  }

  return stats;
}

export function buildTraceStats(events) {
  const stats = createTraceStats();
  for (const event of Array.isArray(events) ? events : []) addTraceEvent(stats, event);
  return stats;
}

export function aggregateTraceRuns(runs) {
  const stats = createTraceStats();
  let runCount = 0;
  let runningRunCount = 0;

  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== 'object') continue;
    runCount += 1;
    if (run.status === 'running') runningRunCount += 1;
    if (run.status === 'loop_stopped') stats.hasLoopError = true;
    stats.stepCount += nonNegativeNumber(run.stepCount);
    stats.llmRequestCount += nonNegativeNumber(run.llmRequestCount);
    stats.llmResponseCount += nonNegativeNumber(run.llmResponseCount);
    stats.toolCallCount += nonNegativeNumber(run.toolCallCount);
    stats.visionSubCallCount += nonNegativeNumber(run.visionSubCallCount);
    stats.errorCount += nonNegativeNumber(run.errorCount);
    stats.retryCount += nonNegativeNumber(run.retryCount);
    stats.totalInputTokens += nonNegativeNumber(run.totalInputTokens);
    stats.totalOutputTokens += nonNegativeNumber(run.totalOutputTokens);
    stats.totalCost += nonNegativeNumber(run.totalCost);
    stats.totalLlmLatencyMs += nonNegativeNumber(run.totalLlmLatencyMs);
    stats.totalToolLatencyMs += nonNegativeNumber(run.totalToolLatencyMs);
  }

  return {
    runCount,
    runningRunCount,
    completedRunCount: runCount - runningRunCount,
    ...stats,
  };
}
