// Current contracts: https://nopecha.com/api-reference/ and
// https://nonecap.com/api-reference/. Token and recognition transports share the documented v1 lifecycle.
const API_BASES = { nopecha: 'https://api.nopecha.com', nonecap: 'https://api.nonecap.com' };
const NAMES = { nopecha: 'NopeCHA', nonecap: 'NoneCap' };
const POLL_MS = 2000;
const TIMEOUT_MS = 180_000;

async function request(id, apiKey, path, { body, timeoutMs = 30_000, allowPending = false } = {}) {
  if (!apiKey) throw new Error(`No ${NAMES[id]} API key configured.`);
  const response = await fetch(`${API_BASES[id]}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `${id === 'nopecha' ? 'Basic' : 'Bearer'} ${apiKey}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await response.json().catch(() => null);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${NAMES[id]}: invalid response.`);
  // v1 uses code:14 / HTTP 409; older responses use error:14 with HTTP 200.
  // Accept numeric strings and nested error codes as well, but only while
  // polling an existing job. Auth, quota, rate-limit and server errors are
  // terminal even if their body happens to contain a pending code.
  const code = result.code ?? result.error?.code ?? result.error;
  const incomplete = code === 14 || code === '14';
  if (allowPending && !body && id === 'nopecha' && incomplete
      && (response.ok || response.status === 409)) return null;
  if (!response.ok || result.error || result.code) {
    const message = String(result.error?.message || result.message || result.error?.code || 'Request failed')
      .split(apiKey).join('[redacted]');
    const numericCode = typeof code === 'number' || (typeof code === 'string' && /^\d+$/.test(code))
      ? `; code ${code}` : '';
    // Keep phase/status in traces without including keys, task IDs or payloads.
    throw new Error(`${NAMES[id]}: ${message} (${body ? 'POST' : 'GET'} ${path.split('?')[0]}; HTTP ${response.status}${numericCode})`);
  }
  return result;
}

export function hcaptchaParamError(params) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params?.websiteKey || '')) {
    return 'solve_captcha: hCaptcha requires the observed UUID site key.';
  }
  try {
    if (!['http:', 'https:'].includes(new URL(params.websiteURL).protocol)) throw new Error();
  } catch { return 'solve_captcha: hCaptcha requires an HTTP(S) page URL.'; }
  if (params.rqdata && params.isEnterprise === false) {
    return 'solve_captcha: isEnterprise=false conflicts with observed hCaptcha rqdata, which requires Enterprise.';
  }
  return null;
}

export function buildHcaptchaTask(id, params) {
  if (!API_BASES[id] || params.type !== 'hcaptcha') throw new Error('Unsupported hCaptcha provider/type combination.');
  const error = hcaptchaParamError(params);
  if (error) throw new Error(error);
  const common = { sitekey: params.websiteKey, url: params.websiteURL };
  if (id === 'nopecha') return { ...common,
    ...(params.rqdata ? { data: { rqdata: params.rqdata } } : {}),
    ...(params.userAgent ? { useragent: params.userAgent } : {}),
  };
  // NoneCap ignores caller-supplied user_agent; do not claim to control it.
  return { type: params.isEnterprise || params.rqdata ? 'hcaptcha_enterprise' : 'hcaptcha', ...common,
    ...(params.rqdata ? { rqdata: params.rqdata } : {}),
  };
}

export async function getHcaptchaProviderBalance(id, apiKey) {
  if (!API_BASES[id]) throw new Error('Unknown hCaptcha provider.');
  const result = await request(id, apiKey, id === 'nopecha' ? '/v1/status' : '/v1/me');
  const balance = id === 'nopecha' ? result.credit : result.credits_balance;
  if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) throw new Error(`${NAMES[id]}: missing credit balance.`);
  return { balance, unit: 'credits' };
}

export async function solveNopechaTask(apiKey, path, body) {
  if (!/^\/v1\/(token|recognition)\/[a-z0-9_]+$/.test(path)) throw new Error('Invalid NopeCHA solving route.');
  const created = await request('nopecha', apiKey, path, { body });
  const taskId = created.data;
  if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('NopeCHA: missing task ID.');
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() + POLL_MS < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    const result = await request('nopecha', apiKey, `${path}?id=${encodeURIComponent(taskId)}`, { allowPending: true, timeoutMs: Math.min(30_000, deadline - Date.now()) });
    if (!result) continue;
    if (path.includes('/token/') && (typeof result.data !== 'string' || !result.data.trim())) throw new Error('NopeCHA: missing solution token.');
    if (result.data == null) throw new Error('NopeCHA: missing recognition result.');
    return { taskId, solution: result.data };
  }
  throw new Error('NopeCHA: timed out waiting for solution.');
}

export async function solveNonecapTask(apiKey, body) {
  let result = await request('nonecap', apiKey, '/v1/solves', { body });
  const taskId = result.id;
  if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('NoneCap: missing task ID.');
  const deadline = Date.now() + TIMEOUT_MS;
  while (true) {
    if (result.id !== taskId) throw new Error('NoneCap: mismatched solve ID.');
    if (result.status === 'solved') {
      if (typeof result.token !== 'string' || !result.token.trim()) throw new Error('NoneCap: missing solution token.');
      return { taskId, solution: { gRecaptchaResponse: result.token,
        ...(result.resp_key ? { respKey: result.resp_key } : {}),
        ...(result.user_agent ? { userAgent: result.user_agent } : {}),
      } };
    }
    if (!['pending', 'solving'].includes(result.status)) throw new Error(`NoneCap: ${result.error?.message || result.status || 'unexpected solve status'}`);
    if (Date.now() + POLL_MS >= deadline) throw new Error('NoneCap: timed out waiting for solution.');
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    result = await request('nonecap', apiKey, `/v1/solves/${encodeURIComponent(taskId)}`, { timeoutMs: Math.min(30_000, deadline - Date.now()) });
  }
}

export async function solveWithHcaptchaProvider(id, apiKey, params) {
  const body = buildHcaptchaTask(id, params);
  if (id === 'nonecap') return solveNonecapTask(apiKey, body);
  const result = await solveNopechaTask(apiKey, '/v1/token/hcaptcha', body);
  return { ...result, solution: { gRecaptchaResponse: result.solution } };
}
