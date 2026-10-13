// Small diagnostic records survive the content budget without retaining
// CAPTCHA answers, provider keys, page cookies, or account form inputs.
export function toolOutcome(name, args, result) {
  const outcome = {};
  for (const key of ['success', 'dispatched', 'noDispatch', 'denied', 'injected', 'applicationRequired',
    'applicationRetryable', 'providerAnswered', 'manualCompletionRequired']) {
    if (typeof result?.[key] === 'boolean') outcome[key] = result[key];
  }
  for (const key of ['provider', 'method', 'type', 'clearance', 'error', 'reason']) {
    if (typeof result?.[key] === 'string') outcome[key] = result[key].slice(0, key === 'error' ? 1000 : 160);
  }
  if (Number.isSafeInteger(result?.cookiesUpdated)) outcome.cookiesUpdated = result.cookiesUpdated;
  if (result?.captchaGate) {
    outcome.captchaGate = {};
    for (const key of ['status', 'selectedType', 'solveAttempted', 'solveFailed', 'activeChallengeAfterSolve',
      'clearedByNavigation', 'clearedByResponseToken', 'clearedByNativeApplication', 'clearedByManualCompletion']) {
      const value = result.captchaGate[key];
      if (typeof value === 'boolean' || typeof value === 'string') outcome.captchaGate[key] = typeof value === 'string' ? value.slice(0, 160) : value;
    }
  }
  if (name === 'solve_captcha') {
    outcome.request = {};
    for (const key of ['type', 'inject', 'frameId']) {
      const value = args?.[key];
      if (typeof value === 'boolean' || Number.isFinite(value) || typeof value === 'string') outcome.request[key] = typeof value === 'string' ? value.slice(0, 160) : value;
    }
    if (Array.isArray(args?.providerTasks)) outcome.request.providers = args.providerTasks.slice(0, 7)
      .map(task => ({ provider: String(task.provider || '').slice(0, 80), method: String(task.method || '').slice(0, 120) }));
  }
  return outcome;
}
