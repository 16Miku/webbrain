async function postJson(apiBase, name, path, body, timeoutMs = 30_000) {
  const response = await fetch(`${apiBase}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${name} ${path}: HTTP ${response.status}`);
  const result = await response.json().catch(() => null);
  if (!result || typeof result !== 'object') throw new Error(`${name} ${path}: invalid response`);
  if (result.errorId) throw new Error(`${name} ${path}: ${result.errorDescription || result.errorCode || 'unknown error'}`);
  return result;
}

export async function getJsonCaptchaBalance(apiBase, name, apiKey) {
  if (!apiKey) throw new Error(`No ${name} API key configured.`);
  const result = await postJson(apiBase, name, 'getBalance', { clientKey: apiKey });
  if (result.balance == null || result.balance === '' || !Number.isFinite(Number(result.balance))) throw new Error(`${name} getBalance: missing balance`);
  return { balance: Number(result.balance) };
}

export async function solveJsonCaptcha(apiBase, name, apiKey, task) {
  if (!apiKey) throw new Error(`No ${name} API key configured.`);
  const created = await postJson(apiBase, name, 'createTask', { clientKey: apiKey, task });
  if (!created.taskId) throw new Error(`${name} createTask: missing taskId`);
  if (created.status === 'ready') return { taskId: created.taskId, solution: created.solution || {} };
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await postJson(apiBase, name, 'getTaskResult', { clientKey: apiKey, taskId: created.taskId }, Math.min(30_000, remaining));
    if (result.status === 'ready') return { taskId: created.taskId, solution: result.solution || {} };
    if (result.status !== 'processing') throw new Error(`${name} getTaskResult: unexpected status`);
  }
  throw new Error(`${name}: timed out waiting for solution.`);
}
