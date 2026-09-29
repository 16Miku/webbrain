// 2Captcha API v2: https://2captcha.com/api-docs
const API_BASE = 'https://api.2captcha.com';
const POLL_INTERVAL_MS = 5_000;
const SOLVE_TIMEOUT_MS = 180_000;

async function postJson(path, body, timeoutMs = 30_000) {
  const response = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`2Captcha ${path}: HTTP ${response.status}`);
  const result = await response.json().catch(() => null);
  if (!result || typeof result !== 'object') throw new Error(`2Captcha ${path}: invalid response`);
  if (result.errorId) throw new Error(`2Captcha ${path}: ${result.errorDescription || result.errorCode || 'unknown error'}`);
  return result;
}

export async function getTwoCaptchaBalance(apiKey) {
  if (!apiKey) throw new Error('No 2Captcha API key configured.');
  const result = await postJson('getBalance', { clientKey: apiKey });
  if (!Number.isFinite(Number(result.balance)) || result.balance == null) {
    throw new Error('2Captcha getBalance: missing balance');
  }
  return { balance: Number(result.balance) };
}

// Translate the existing normalized task to 2Captcha's case-sensitive types
// and fields. Never forward CapSolver-specific task names or affiliate IDs.
export function buildTwoCaptchaTask(task) {
  const { websiteURL, websiteKey } = task;
  switch (task.type) {
    case 'ReCaptchaV2TaskProxyLess':
    case 'ReCaptchaV2EnterpriseTaskProxyLess': {
      const enterprise = task.type.includes('Enterprise');
      return {
        type: enterprise ? 'RecaptchaV2EnterpriseTaskProxyless' : 'RecaptchaV2TaskProxyless',
        websiteURL, websiteKey,
        ...(task.isInvisible != null ? { isInvisible: task.isInvisible } : {}),
        ...(task.userAgent ? { userAgent: task.userAgent } : {}),
        ...(enterprise && task.enterprisePayload ? { enterprisePayload: task.enterprisePayload } : {}),
        ...(!enterprise && task.recaptchaDataSValue ? { recaptchaDataSValue: task.recaptchaDataSValue } : {}),
      };
    }
    case 'ReCaptchaV3TaskProxyLess':
    case 'ReCaptchaV3EnterpriseTaskProxyLess':
      return {
        type: 'RecaptchaV3TaskProxyless', websiteURL, websiteKey,
        minScore: task.minScore || 0.3, pageAction: task.pageAction,
        isEnterprise: task.type.includes('Enterprise'),
      };
    case 'AntiTurnstileTaskProxyLess':
      return {
        type: 'TurnstileTaskProxyless', websiteURL, websiteKey,
        ...(task.metadata?.action ? { action: task.metadata.action } : {}),
        ...(task.metadata?.cdata ? { data: task.metadata.cdata } : {}),
        ...(task.metadata?.chlPageData ? { pagedata: task.metadata.chlPageData } : {}),
      };
    case 'ImageToTextTask':
      return { type: 'ImageToTextTask', body: task.body, ...(task.case != null ? { case: task.case } : {}) };
    default:
      // hCaptcha is not listed in the current 2Captcha API v2 documentation.
      throw new Error(`2Captcha does not support this CAPTCHA type in WebBrain: ${task.type}`);
  }
}

export async function solveWithTwoCaptcha(apiKey, task) {
  if (!apiKey) throw new Error('No 2Captcha API key configured.');
  const created = await postJson('createTask', { clientKey: apiKey, task: buildTwoCaptchaTask(task) });
  if (!created.taskId) throw new Error('2Captcha createTask: missing taskId');
  const deadline = Date.now() + SOLVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await postJson('getTaskResult', { clientKey: apiKey, taskId: created.taskId }, Math.min(30_000, remaining));
    if (result.status === 'ready') return { taskId: created.taskId, solution: result.solution || {} };
    if (result.status !== 'processing') throw new Error('2Captcha getTaskResult: unexpected status');
  }
  throw new Error('2Captcha: timed out waiting for solution.');
}
