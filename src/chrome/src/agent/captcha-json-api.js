async function postJson(apiBase, name, path, body, timeoutMs = 30_000) {
  const response = await fetch(`${apiBase}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Read the body even on HTTP errors: providers put errorCode there.
  const result = await response.json().catch(() => null);
  const redact = value => String(value).split(body.clientKey).join('[redacted]');
  const code = result?.errorCode ? ` [${redact(result.errorCode)}]` : '';
  if (!response.ok || result?.errorId) {
    const message = result?.errorDescription || result?.errorCode || 'request failed';
    throw new Error(`${name} ${path}: ${redact(message)}${code} (HTTP ${response.status})`);
  }
  if (!result || typeof result !== 'object') throw new Error(`${name} ${path}: invalid response (HTTP ${response.status})`);
  return result;
}

export async function getJsonCaptchaBalance(apiBase, name, apiKey) {
  if (!apiKey) throw new Error(`No ${name} API key configured.`);
  const result = await postJson(apiBase, name, 'getBalance', { clientKey: apiKey });
  if (result.balance == null || result.balance === '' || !Number.isFinite(Number(result.balance))) throw new Error(`${name} getBalance: missing balance`);
  return { balance: Number(result.balance) };
}

export async function solveJsonCaptcha(apiBase, name, apiKey, task, { pendingStatuses = ['processing'] } = {}) {
  if (!apiKey) throw new Error(`No ${name} API key configured.`);
  const created = await postJson(apiBase, name, 'createTask', { clientKey: apiKey, task });
  if (created.status === 'ready') return { taskId: created.taskId, solution: created.solution ?? {} };
  if (!created.taskId) throw new Error(`${name} createTask: missing taskId`);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await postJson(apiBase, name, 'getTaskResult', { clientKey: apiKey, taskId: created.taskId }, Math.min(30_000, remaining));
    if (result.status === 'ready') return { taskId: created.taskId, solution: result.solution ?? {} };
    if (!pendingStatuses.includes(result.status)) {
      throw new Error(`${name} getTaskResult: unexpected status ${JSON.stringify(String(result.status ?? 'missing')).slice(0, 40)}`);
    }
  }
  throw new Error(`${name}: timed out waiting for solution.`);
}
