import test from 'node:test';
import assert from 'node:assert/strict';

// Fixtures transcribed from the linked provider contracts, with placeholder
// values. No API keys, real challenges, or paid requests are used in this suite.
const websiteURL = 'https://example.test/challenge';
const challengeScript = 'https://example.token.awswaf.com/challenge.js';
const providers = ids => ids.map(id => ({ id, apiKey: `fixture-${id}` }));
function mockApi(t, replies) {
  const calls = [];
  t.mock.method(globalThis, 'setTimeout', fn => { queueMicrotask(fn); return 0; });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body instanceof URLSearchParams
      ? Object.fromEntries(options.body) : options.body ? JSON.parse(options.body) : null });
    assert.ok(replies.length, 'Unexpected provider request');
    return Response.json(replies.shift());
  });
  return calls;
}

for (const browser of ['chrome', 'firefox']) {
  const native = await import(`../src/${browser}/src/agent/captcha-native-providers.js`);
  const solver = await import(`../src/${browser}/src/agent/captcha-solver.js`);

  test(`${browser}: CapSolver does not report a malformed balance as zero credits`, async t => {
    mockApi(t, [{ errorId: 0 }, { errorId: 0, balance: null }, { errorId: 0, balance: 'bad' }, { errorId: 0, balance: 0 }]);
    for (let i = 0; i < 3; i++) await assert.rejects(solver.getBalance('fixture-key'), /missing balance/);
    assert.deepEqual(await solver.getBalance('fixture-key'), { balance: 0, packages: [] });
  });

  // CapMonster Option 1 and Anti-Captcha's Widget tab use the renderCaptcha
  // API key, not gokuProps.key. Both return cookies usable by this integration.
  test(`${browser}: AWS SDK fallback uses all three documented cookie providers`, async t => {
    const enabled = providers(['capsolver', 'capmonster', 'anti-captcha']);
    const observed = { pageUrl: websiteURL, apiKey: 'sdk-api-key', jsapiScript: 'https://example.captcha-sdk.awswaf.com/jsapi.js',
      existingToken: 'existing-cookie', websiteKey: 'stale-goku-key', iv: 'stale-iv', context: 'stale-context' };
    const entries = native.buildAwsWafProviderTasks(enabled, observed);
    const prepared = native.prepareNativeCaptchaTasks(enabled, entries);
    const calls = mockApi(t, [{ errorId: 1, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE' },
      { errorId: 1, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE' },
      { errorId: 0, status: 'ready', solution: { token: 'aws-cookie' } }]);
    const result = await native.solveNativeCaptchaTasks(prepared);
    assert.equal(result.provider, 'anti-captcha');
    assert.deepEqual(calls[1].body.task, { type: 'AmazonTask', websiteURL, websiteKey: 'sdk-api-key', captchaScript: observed.jsapiScript, cookieSolution: true });
    assert.deepEqual(calls[2].body.task, { type: 'AmazonTaskProxyless', wafType: 'widget', websiteURL, websiteKey: 'sdk-api-key', jsapiScript: observed.jsapiScript });
    const noCookie = native.buildAwsWafProviderTasks(enabled, { ...observed, existingToken: null });
    assert.deepEqual(noCookie.map(e => e.provider), ['capsolver', 'capmonster', 'anti-captcha']);
    assert.deepEqual(noCookie[0].parameters, { websiteURL, awsApiJs: observed.jsapiScript });
    assert.equal(native.prepareNativeCaptchaTasks(enabled, noCookie).length, 3);
    for (const key of ['websiteKey', 'jsapiScript']) {
      const bad = structuredClone(entries);
      bad[2].parameters[key] = 'different-challenge';
      assert.throws(() => native.prepareNativeCaptchaTasks(enabled, bad), /same observed challenge/);
    }
    const mixed = native.buildAwsWafProviderTasks(enabled, { pageUrl: websiteURL, websiteKey: 'key', iv: 'iv', context: 'context', challengeScript });
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [entries[0], mixed[1]]), /same observed challenge mode/);
  });

  // https://2captcha.com/api-docs/geetest — riskType is case sensitive.
  test(`${browser}: 2Captcha GeeTest sends the documented riskType spelling`, async t => {
    const calls = mockApi(t, [{ errorId: 0, taskId: 123 }, {
      errorId: 0, status: 'ready', solution: { captcha_id: 'captcha', lot_number: 'lot', pass_token: 'pass', gen_time: '1', captcha_output: 'output' },
    }]);
    const parameters = { websiteURL, version: 4, initParameters: { captcha_id: 'captcha' }, riskType: 'slide' };
    const result = await native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(providers(['2captcha']), [
      { provider: '2captcha', method: 'GeeTestTaskProxyless', parameters },
    ]));
    assert.deepEqual(calls[0].body.task, { ...parameters, type: 'GeeTestTaskProxyless' });
    assert.equal(result.solution.pass_token, 'pass');
    assert.throws(() => native.buildNativeCaptchaTask({ provider: '2captcha', method: 'GeeTestTaskProxyless',
      parameters: { ...parameters, risk_type: 'slide' } }), /undocumented field risk_type/);
  });

  // https://docs.capmonster.cloud/docs/captchas/amazon-task/ — Option 3.
  test(`${browser}: invisible AWS challenge reaches CapMonster after CapSolver fails`, async t => {
    const enabled = providers(['capsolver', 'capmonster']);
    const entries = native.buildAwsWafProviderTasks(enabled, { pageUrl: websiteURL, challengeScript });
    assert.deepEqual(entries[1], { provider: 'capmonster', method: 'AmazonTask:3', parameters: {
      websiteURL, challengeScript, iv: '', context: '', cookieSolution: true,
    } });
    const calls = mockApi(t, [{ errorId: 1, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE' },
      { errorId: 0, taskId: 456 }, { errorId: 0, status: 'ready', solution: { cookies: { 'aws-waf-token': 'cookie' } } }]);
    const result = await native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(enabled, entries));
    assert.equal(result.provider, 'capmonster');
    assert.deepEqual(calls[1].body.task, { type: 'AmazonTask', websiteURL, challengeScript, iv: '', context: '', cookieSolution: true });
    for (const partial of [{ iv: 'partial' }, { websiteKey: 'partial' }, { context: 'partial' }, { captchaScript: 'https://captcha.test/captcha.js' }]) {
      assert.ok(!native.buildAwsWafProviderTasks(enabled, { pageUrl: websiteURL, challengeScript, ...partial }).some(e => e.method === 'AmazonTask:3'));
    }
    assert.throws(() => native.buildNativeCaptchaTask({ provider: 'capmonster', method: 'AmazonTask:2',
      parameters: { websiteURL, websiteKey: 'key', challengeScript, iv: '', context: '' } }), /cannot be empty/);
  });

  for (const cookieSolution of [undefined, false]) test(`${browser}: CapMonster native AWS voucher (${cookieSolution}) stops fallback`, async t => {
    const solution = { existingToken: 'existing', captchaVoucher: 'voucher' };
    const calls = mockApi(t, [{ errorId: 0, status: 'ready', solution }]);
    const enabled = providers(['capmonster', 'anti-captcha']);
    const common = { websiteURL, websiteKey: 'key', iv: 'iv', context: 'context', challengeScript };
    const result = await native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(enabled, [
      { provider: 'capmonster', method: 'AmazonTask:2', parameters: { ...common, ...(cookieSolution === undefined ? {} : { cookieSolution }) } },
      { provider: 'anti-captcha', method: 'AmazonTaskProxyless', parameters: common },
    ]));
    assert.equal(calls.length, 1);
    assert.deepEqual(result.solution, solution);
    assert.equal(result.provider, 'capmonster');
  });

  for (const invalidCookie of ['', 'aws-waf-token=; Path=/', 0, null]) test(`${browser}: empty/malformed AWS cookie ${JSON.stringify(invalidCookie)} falls back`, async t => {
    const calls = mockApi(t, [{ errorId: 0, status: 'ready', solution: { cookies: { 'aws-waf-token': invalidCookie } } },
      { errorId: 0, status: 'ready', solution: { token: 'usable-cookie' } }]);
    const enabled = providers(['capmonster', 'anti-captcha']);
    const entries = native.buildAwsWafProviderTasks(enabled, { pageUrl: websiteURL, websiteKey: 'key', iv: 'iv', context: 'context', challengeScript });
    const result = await native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(enabled, entries));
    assert.equal(result.provider, 'anti-captcha');
    assert.equal(calls.length, 2);
  });

  // https://solvecaptcha.com/captcha-solver-api — Temu/VK result examples
  // use ready/solution while the established API uses numeric status/request.
  for (const method of ['temuimage', 'vkimage']) test(`${browser}: SolveCaptcha ${method} preserves its structured ready answer`, async t => {
    const solution = method === 'temuimage' ? { coordinates: [{ x: 155, y: 358 }] } : { best_step: 19 };
    const calls = mockApi(t, [{ status: 1, request: '789' }, { status: 0, request: 'CAPCHA_NOT_READY' },
      { errorId: 0, status: 'ready', solution }]);
    const parameters = method === 'temuimage' ? { body: 'image', part1: 'one', part2: 'two', part3: 'three' } : { body: 'image', steps: '[5,19]' };
    const result = await native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(providers(['solvecaptcha']), [
      { provider: 'solvecaptcha', method, parameters },
    ]));
    assert.equal(calls.length, 3);
    assert.deepEqual(result.solution, solution);
    assert.equal(result.taskId, '789');
    assert.equal(calls[0].body.method, method);
  });

  // https://docs.capsolver.com/en/guide/captcha/cloudflare_turnstile/
  // https://docs.capmonster.cloud/docs/captchas/turnstile-task/
  test(`${browser}: Cloudflare Challenge goes only to a compatible automatic provider`, async t => {
    const calls = mockApi(t, [{ errorId: 0, status: 'ready', solution: { token: 'answer' } }]);
    const result = await solver.solveCaptchaWithProviders(providers(['capsolver', 'capmonster']), {
      type: 'turnstile', websiteURL, websiteKey: 'key', userAgent: 'browser-UA',
      metadata: { action: 'managed', cdata: 'cdata', chlPageData: 'page-data' },
    });
    assert.equal(result.provider, 'capmonster');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api.capmonster.cloud/);
    assert.deepEqual(calls[0].body.task, { type: 'TurnstileTask', websiteURL, websiteKey: 'key', userAgent: 'browser-UA',
      data: 'cdata', pageAction: 'managed', pageData: 'page-data', cloudflareTaskType: 'token' });
  });

  test(`${browser}: incomplete Challenge metadata is never downgraded to standalone Turnstile`, async t => {
    const calls = mockApi(t, []);
    await assert.rejects(solver.solveCaptchaWithProviders(providers(['capsolver', 'capmonster']), {
      type: 'turnstile', websiteURL, websiteKey: 'key', metadata: { chlPageData: 'page-data' },
    }), /requires action, data, pageData/);
    assert.equal(calls.length, 0);
  });

  // https://docs.capsolver.com/en/guide/api-gettaskresult/
  test(`${browser}: unexpected CapSolver poll status advances fallback without repeated polls`, async t => {
    const calls = mockApi(t, [{ errorId: 0, taskId: 'id' }, { errorId: 0, status: 'unknown' },
      { errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'answer' } }]);
    const result = await solver.solveCaptchaWithProviders(providers(['capsolver', '2captcha']), { type: 'recaptcha_v2', websiteURL, websiteKey: 'key' });
    assert.equal(result.provider, '2captcha');
    assert.equal(calls.length, 3);
  });
}
