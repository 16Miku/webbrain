export function resolveCloudRunId(started = {}) {
  return started.run_id || started.runId || started.id || '';
}

export function suiteShouldFail(totals = {}) {
  return Number(totals.failed || 0) > 0 || Number(totals.skipped || 0) > 0;
}

export function successfulToolResults(trace, toolName) {
  const pending = [];
  const results = [];
  for (const update of trace?.run?.updates || []) {
    const name = update.data?.name || update.data?.tool || '';
    if (update.type === 'tool_call' && name === toolName) {
      pending.push(true);
    } else if (update.type === 'tool_result' && name === toolName && pending.length) {
      pending.shift();
      const result = update.data?.result;
      if (result?.success === true) results.push(result);
    }
  }
  return results;
}

export function buildSessionSettings(capsolverApiKey = '', overrides = {}) {
  return {
    wbLocale: 'en',
    useSiteAdapters: true,
    autoScreenshot: 'state_change',
    maxAgentSteps: 195,
    requestTimeoutMs: 180_000,
    verboseMode: true,
    enableAllPackagedSkills: true,
    askBeforeConsequentialActions: false,
    captchaSolverEnabled: Boolean(capsolverApiKey),
    ...(capsolverApiKey ? { capsolverApiKey } : {}),
    ...overrides,
  };
}
