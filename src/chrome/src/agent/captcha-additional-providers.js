import { getHcaptchaProviderBalance } from './captcha-hcaptcha-providers.js';
import { buildTwoCaptchaTask } from './two-captcha.js';
import { getJsonCaptchaBalance, solveJsonCaptcha } from './captcha-json-api.js';

// Provider schemas: https://docs.capmonster.cloud/docs/captchas/
// https://anti-captcha.com/apidoc and https://solvecaptcha.com/captcha-solver-api
export function buildAdditionalCaptchaTask(id, task) {
  const mapped = buildTwoCaptchaTask(task);
  if (id === 'anti-captcha') {
    if (task.type === 'AntiTurnstileTaskProxyLess') {
      const { data, pagedata, userAgent, ...rest } = mapped;
      return { ...rest, ...(data ? { cData: data } : {}), ...(pagedata ? { chlPageData: pagedata } : {}) };
    }
    return mapped;
  }
  if (id !== 'capmonster') throw new Error(`Unknown CAPTCHA provider: ${id}`);
  if (task.type === 'AntiTurnstileTaskProxyLess') {
    const { action, pagedata, ...rest } = mapped;
    return { ...rest, type: 'TurnstileTask', ...(action ? { pageAction: action } : {}),
      ...(task.userAgent ? { userAgent: task.userAgent } : {}),
      ...(pagedata ? { pageData: pagedata, cloudflareTaskType: 'token' } : {}) };
  }
  if (mapped.type === 'RecaptchaV2TaskProxyless') mapped.type = 'RecaptchaV2Task';
  if (mapped.type === 'RecaptchaV2EnterpriseTaskProxyless') mapped.type = 'RecaptchaV2EnterpriseTask';
  return mapped;
}

export function buildSolveCaptchaTask(task) {
  const mapped = buildTwoCaptchaTask(task);
  if (task.type === 'ImageToTextTask') return { method: 'base64', body: task.body, ...(task.case != null ? { regsense: Number(task.case) } : {}) };
  if (task.type === 'AntiTurnstileTaskProxyLess') {
    return { method: 'turnstile', sitekey: task.websiteKey, pageurl: task.websiteURL,
      ...(task.userAgent ? { userAgent: task.userAgent } : {}),
      ...(mapped.action ? { action: mapped.action } : {}), ...(mapped.data ? { data: mapped.data } : {}),
      ...(mapped.pagedata ? { pagedata: mapped.pagedata } : {}) };
  }
  return { method: 'userrecaptcha', googlekey: task.websiteKey, pageurl: task.websiteURL,
    ...(task.type.includes('V3') ? { version: 'v3', min_score: task.minScore || 0.3 } : {}),
    ...(task.pageAction ? { action: task.pageAction } : {}),
    ...(task.type.includes('Enterprise') ? { enterprise: 1 } : {}),
    ...(task.isInvisible != null ? { invisible: Number(task.isInvisible) } : {}),
    ...(task.userAgent ? { userAgent: task.userAgent } : {}),
    ...(task.enterprisePayload?.s || task.recaptchaDataSValue ? { 'data-s': task.enterprisePayload?.s || task.recaptchaDataSValue } : {}) };
}

export async function solveCaptchaRequest(apiKey, path, fields, timeout = 30_000) {
  if (!apiKey) throw new Error('No SolveCaptcha API key configured.');
  const body = new URLSearchParams({ key: apiKey, json: '1', ...fields });
  const isGet = path === 'res.php';
  const response = await fetch(`https://api.solvecaptcha.com/${path}${isGet ? `?${body}` : ''}`, {
    method: isGet ? 'GET' : 'POST', ...(isGet ? {} : { body }), signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`SolveCaptcha ${path}: HTTP ${response.status}`);
  const result = await response.json().catch(() => null);
  if (!result || ![0, 1].includes(Number(result.status))) throw new Error(`SolveCaptcha ${path}: invalid response`);
  if (Number(result.status) !== 1 && result.request !== 'CAPCHA_NOT_READY') throw new Error(`SolveCaptcha ${path}: ${result.request || 'unknown error'}`);
  return result;
}

async function solveWithSolveCaptcha(apiKey, task) {
  const created = await solveCaptchaRequest(apiKey, 'in.php', buildSolveCaptchaTask(task));
  if (Number(created.status) !== 1 || !created.request) throw new Error('SolveCaptcha: missing task ID');
  const deadline = Date.now() + 180_000;
  // reCAPTCHA requires an initial 20-second wait; subsequent polls are five seconds apart.
  let delay = task.type.startsWith('ReCaptcha') ? 20_000 : 5_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = 5_000;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await solveCaptchaRequest(apiKey, 'res.php', { action: 'get', id: created.request }, Math.min(30_000, remaining));
    if (Number(result.status) === 1) {
      const field = task.type === 'ImageToTextTask' ? 'text' : task.type === 'AntiTurnstileTaskProxyLess' ? 'token' : 'gRecaptchaResponse';
      return { taskId: created.request, solution: { [field]: result.request, ...(result.useragent ? { userAgent: result.useragent } : {}) } };
    }
  }
  throw new Error('SolveCaptcha: timed out waiting for solution.');
}

const JSON_PROVIDERS = {
  capmonster: { base: 'https://api.capmonster.cloud', name: 'CapMonster Cloud' },
  'anti-captcha': { base: 'https://api.anti-captcha.com', name: 'Anti-Captcha' },
};
export async function getAdditionalCaptchaBalance(id, apiKey) {
  if (['nopecha', 'nonecap'].includes(id)) return getHcaptchaProviderBalance(id, apiKey);
  if (id === 'solvecaptcha') {
    const result = await solveCaptchaRequest(apiKey, 'res.php', { action: 'getbalance' });
    if (Number(result.status) !== 1 || result.request == null || result.request === '' || !Number.isFinite(Number(result.request))) throw new Error('SolveCaptcha: missing balance');
    return { balance: Number(result.request) };
  }
  const provider = JSON_PROVIDERS[id];
  if (!provider) throw new Error(`Unknown CAPTCHA provider: ${id}`);
  return getJsonCaptchaBalance(provider.base, provider.name, apiKey);
}
export function solveWithAdditionalProvider(id, apiKey, task) {
  if (id === 'solvecaptcha') return solveWithSolveCaptcha(apiKey, task);
  const provider = JSON_PROVIDERS[id];
  if (!provider) throw new Error(`Unknown CAPTCHA provider: ${id}`);
  return solveJsonCaptcha(provider.base, provider.name, apiKey, buildAdditionalCaptchaTask(id, task));
}
