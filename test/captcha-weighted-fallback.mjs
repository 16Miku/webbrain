import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const key = '0123456789abcdef0123456789abcdef';
const params = { type: 'turnstile', websiteURL: 'https://example.com/form', websiteKey: 'widget', metadata: { action: 'managed', cdata: 'data', chlPageData: 'page-data' } };
function api(t, respond) {
  let now = 0;
  const calls = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => { now += delay; fn(); });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    const form = parsed.hostname === 'api.solvecaptcha.com';
    const body = form ? Object.fromEntries(options.body || parsed.searchParams) : JSON.parse(options.body);
    const call = { url, path: parsed.pathname, host: parsed.hostname, body, options, now };
    calls.push(call);
    const result = await respond(call, calls.length);
    return result instanceof Response ? result : Response.json(result);
  });
  return calls;
}

for (const build of ['chrome', 'firefox']) {
  const config = await import(`../src/${build}/src/agent/captcha-provider-config.js`);
  const solver = await import(`../src/${build}/src/agent/captcha-solver.js`);
  const extra = await import(`../src/${build}/src/agent/captcha-additional-providers.js`);
  const transfer = await import(`../src/${build}/src/config-transfer.js`);
  const originalProviders = config.CAPTCHA_PROVIDERS.filter(p => !['nopecha', 'nonecap'].includes(p.id));
  const all = Object.fromEntries(originalProviders.flatMap(p => [[p.key, p.id === 'capsolver' ? 'CAP-0123456789abcdefghij' : key], [p.enabled, true]]));
  const ids = value => config.getCaptchaProviders(value).map(p => p.id);

  test(`${build}: weights order all five, ties remain deterministic, disabled keys stay unused`, () => {
    assert.deepEqual(ids(all), ['capsolver', '2captcha', 'capmonster', 'solvecaptcha', 'anti-captcha']);
    assert.deepEqual(ids({ ...all, antiCaptchaWeight: 101, twoCaptchaEnabled: false }), ['anti-captcha', 'capsolver', 'capmonster', 'solvecaptcha']);
    assert.deepEqual(ids({ ...all, capmonsterWeight: 100, solveCaptchaWeight: 100 }), ['capsolver', 'capmonster', 'solvecaptcha', '2captcha', 'anti-captcha']);
    assert.deepEqual(ids({ ...all, capmonsterWeight: NaN, antiCaptchaWeight: Infinity, solveCaptchaWeight: '200' }), ids(all));
    assert.equal(ids({ ...all, capsolverWeight: -1 }).at(-1), 'capsolver');
    assert.equal(config.getCaptchaProviders({ ...all, antiCaptchaWeight: 0 }).at(-1).weight, 0);
    for (const p of originalProviders) {
      assert.deepEqual(ids({ [p.key]: all[p.key] }), []);
      assert.deepEqual(ids({ [p.key]: 'bad-key', [p.enabled]: true }), []);
    }
    assert.deepEqual(config.getCaptchaProviders({ ...all, webbrainCloudManaged: true }), []);
    assert.deepEqual(config.getCaptchaProviders({ ...all, webbrainCloudManaged: true, webbrainCloudCapsolverBrokerEnabled: true, antiCaptchaWeight: 200 }), [{ id: 'capsolver', apiKey: '', useCloudBroker: true }]);
  });

  test(`${build}: keys, checkbox states, and custom weights survive config round trip`, () => {
    const values = { ...all, antiCaptchaWeight: 120.5, capmonsterEnabled: false, solveCaptchaWeight: 0 };
    const imported = transfer.parseConfigImport(JSON.stringify(transfer.createConfigExport(values))).settings;
    for (const p of originalProviders) {
      assert.equal(imported[p.key], values[p.key]);
      assert.equal(imported[p.enabled], values[p.enabled]);
      assert.equal(imported[p.weight], values[p.weight] ?? p.defaultWeight);
      const keyOnly = transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { [p.key]: all[p.key] } })).settings;
      assert.equal(keyOnly[p.enabled], false);
    }
    assert.deepEqual(config.getCaptchaProviders(imported), config.getCaptchaProviders(values));
  });

  test(`${build}: provider-specific mappings preserve enterprise and Turnstile metadata`, () => {
    const normalized = solver.buildTask(params);
    const anti = extra.buildAdditionalCaptchaTask('anti-captcha', normalized);
    assert.deepEqual(anti, { type: 'TurnstileTaskProxyless', websiteURL: params.websiteURL, websiteKey: 'widget', action: 'managed', cData: 'data', chlPageData: 'page-data' });
    const monster = extra.buildAdditionalCaptchaTask('capmonster', normalized);
    // Challenge mode requires userAgent; without it CapMonster gets the plain task.
    assert.deepEqual(monster, { type: 'TurnstileTask', websiteURL: params.websiteURL, websiteKey: 'widget', data: 'data', pageAction: 'managed' });
    const monsterChallenge = extra.buildAdditionalCaptchaTask('capmonster', { ...normalized, userAgent: 'UA' });
    assert.deepEqual(monsterChallenge, { type: 'TurnstileTask', websiteURL: params.websiteURL, websiteKey: 'widget', data: 'data', pageAction: 'managed', userAgent: 'UA', pageData: 'page-data', cloudflareTaskType: 'token' });
    const solve = extra.buildSolveCaptchaTask(normalized);
    assert.deepEqual(solve, { method: 'turnstile', sitekey: 'widget', pageurl: params.websiteURL, action: 'managed', data: 'data', pagedata: 'page-data' });
    for (const type of ['recaptcha_v2', 'recaptcha_v2_enterprise', 'recaptcha_v3', 'recaptcha_v3_enterprise']) {
      const task = solver.buildTask({ ...params, type, pageAction: 'login', minScore: 0.7, enterprisePayload: { s: 's-value' } });
      const antiTask = extra.buildAdditionalCaptchaTask('anti-captcha', task);
      const capTask = extra.buildAdditionalCaptchaTask('capmonster', task);
      const solveTask = extra.buildSolveCaptchaTask(task);
      assert.equal(solveTask.method, 'userrecaptcha');
      assert.equal(solveTask.enterprise, type.includes('enterprise') ? 1 : undefined);
      if (type.includes('v3')) {
        assert.equal(antiTask.type, 'RecaptchaV3TaskProxyless');
        assert.equal(capTask.isEnterprise, type.includes('enterprise'));
        assert.equal(solveTask.version, 'v3');
        assert.equal(solveTask.action, 'login');
        assert.equal(solveTask.min_score, 0.7);
      } else {
        assert.equal(capTask.type, type.includes('enterprise') ? 'RecaptchaV2EnterpriseTask' : 'RecaptchaV2Task');
        assert.equal(antiTask.type, type.includes('enterprise') ? 'RecaptchaV2EnterpriseTaskProxyless' : 'RecaptchaV2TaskProxyless');
      }
    }
  });

  // API-contract fixtures, not evidence of a successful paid solve on a live site.
  const taskTypes = {
    capsolver: ['ReCaptchaV2TaskProxyLess', 'ReCaptchaV2EnterpriseTaskProxyLess', 'ReCaptchaV3TaskProxyLess', 'ReCaptchaV3EnterpriseTaskProxyLess', 'AntiTurnstileTaskProxyLess', 'ImageToTextTask'],
    '2captcha': ['RecaptchaV2TaskProxyless', 'RecaptchaV2EnterpriseTaskProxyless', 'RecaptchaV3TaskProxyless', 'RecaptchaV3TaskProxyless', 'TurnstileTaskProxyless', 'ImageToTextTask'],
    capmonster: ['RecaptchaV2Task', 'RecaptchaV2EnterpriseTask', 'RecaptchaV3TaskProxyless', 'RecaptchaV3TaskProxyless', 'TurnstileTask', 'ImageToTextTask'],
    solvecaptcha: ['userrecaptcha', 'userrecaptcha', 'userrecaptcha', 'userrecaptcha', 'turnstile', 'base64'],
    'anti-captcha': ['RecaptchaV2TaskProxyless', 'RecaptchaV2EnterpriseTaskProxyless', 'RecaptchaV3TaskProxyless', 'RecaptchaV3TaskProxyless', 'TurnstileTaskProxyless', 'ImageToTextTask'],
  };
  for (const provider of originalProviders) {
    for (const [index, type] of ['recaptcha_v2', 'recaptcha_v2_enterprise', 'recaptcha_v3', 'recaptcha_v3_enterprise', 'turnstile', 'image_to_text'].entries()) {
      test(`${build}: ${provider.id} ${type} request and response contract`, async t => {
        const image = type === 'image_to_text';
        const field = image ? 'text' : type === 'turnstile' ? 'token' : 'gRecaptchaResponse';
        const calls = api(t, call => {
          if (call.host === 'api.solvecaptcha.com') return { status: 1, request: call.path === '/in.php' ? 'task-id' : 'answer' };
          if (call.path === '/createTask' && !(provider.id === 'capsolver' && image)) return { errorId: 0, taskId: 'task-id' };
          return { errorId: 0, taskId: 'task-id', status: 'ready', solution: { [field]: 'answer' } };
        });
        assert.equal(config.captchaProviderSupportsType(provider.id, type), true);
        const result = await solver.solveCaptchaWithProviders(config.getCaptchaProviders({ [provider.key]: all[provider.key], [provider.enabled]: true }), {
          ...params, type, pageAction: 'login', minScore: 0.7, body: 'base64-image', userAgent: 'browser-agent', enterprisePayload: { s: 'enterprise-s' },
        });
        assert.equal(result.provider, provider.id);
        assert.equal(result.token, 'answer');
        assert.equal(result.fieldName, image ? null : type === 'turnstile' ? 'cf-turnstile-response' : 'g-recaptcha-response');
        assert.equal(calls.length, provider.id === 'capsolver' && image ? 1 : 2);
        const sent = calls[0].body.task || calls[0].body;
        assert.equal(sent.type || sent.method, taskTypes[provider.id][index]);
        if (provider.id === 'capsolver') assert.equal(sent.minScore, undefined, 'CapSolver has no documented minScore option');
        if (type === 'turnstile' && ['2captcha', 'capmonster', 'solvecaptcha'].includes(provider.id)) assert.equal(sent.userAgent, 'browser-agent');
        if (type === 'turnstile' && provider.id === 'anti-captcha') assert.equal(sent.userAgent, undefined);
      });
    }
  }

  test(`${build}: synchronous CapSolver OCR without task ID does not poll or fall back`, async t => {
    const calls = api(t, () => ({ errorId: 0, status: 'ready', solution: { text: 'AbC123' } }));
    const result = await solver.solveCaptchaWithProviders(config.getCaptchaProviders(all), { type: 'image_to_text', body: 'base64-image' });
    assert.equal(result.provider, 'capsolver');
    assert.equal(result.token, 'AbC123');
    assert.equal(calls.length, 1);
  });

  test(`${build}: invalid v3 scores fail locally before any provider or broker dispatch`, async t => {
    const calls = api(t, () => { throw new Error('unexpected dispatch'); });
    for (const minScore of [0, 0.5, 1, '0.7', NaN]) {
      const invalid = { ...params, type: 'recaptcha_v3', pageAction: 'login', minScore };
      await assert.rejects(solver.solveCaptchaWithProviders(config.getCaptchaProviders(all), invalid), /minScore/);
      await assert.rejects(solver.solveCaptcha('', invalid, { useCloudBroker: true }), /minScore/);
    }
    assert.equal(calls.length, 0);
  });

  test(`${build}: one attempt per service follows weights and stops on last-provider success`, async t => {
    const calls = api(t, call => {
      if (call.host === 'api.solvecaptcha.com') return { status: 0, request: 'ERROR_ZERO_BALANCE' };
      if (call.host !== 'api.anti-captcha.com') return { errorId: 1, errorCode: 'ERROR_ZERO_BALANCE' };
      return call.path === '/createTask' ? { taskId: 123 } : { status: 'ready', solution: { token: 'solved' } };
    });
    const result = await solver.solveCaptchaWithProviders(config.getCaptchaProviders({ ...all, capmonsterWeight: 120 }), params);
    assert.equal(result.provider, 'anti-captcha');
    assert.equal(result.token, 'solved');
    assert.deepEqual(calls.filter(c => c.path === '/createTask' || c.path === '/in.php').map(c => c.host), ['api.capmonster.cloud', 'api.capsolver.com', 'api.2captcha.com', 'api.solvecaptcha.com', 'api.anti-captcha.com']);
    for (const call of calls) assert.equal(call.body.clientKey || call.body.key, call.host === 'api.capsolver.com' ? all.capsolverApiKey : key);
  });

  for (const id of ['capmonster', 'solvecaptcha', 'anti-captcha']) {
    const p = config.CAPTCHA_PROVIDERS.find(p => p.id === id);
    test(`${build}: ${id} supports balance, processing, image result, and early success`, async t => {
      let polls = 0;
      const calls = api(t, call => {
        if (id === 'solvecaptcha') {
          if (call.body.action === 'getbalance') return { status: 1, request: '3.5' };
          if (call.path === '/in.php') { assert.equal(call.body.method, 'base64'); return { status: 1, request: 'task-1' }; }
          assert.equal(call.body.id, 'task-1');
          return ++polls === 1 ? { status: 0, request: 'CAPCHA_NOT_READY' } : { status: 1, request: 'text-result' };
        }
        if (call.path === '/getBalance') return { errorId: 0, balance: 3.5 };
        if (call.path === '/createTask') { assert.equal(call.body.task.type, 'ImageToTextTask'); return { taskId: 42 }; }
        assert.equal(call.body.taskId, 42);
        return ++polls === 1 ? { status: 'processing' } : { status: 'ready', solution: { text: 'text-result' } };
      });
      assert.deepEqual(await extra.getAdditionalCaptchaBalance(id, key), { balance: 3.5 });
      const providers = config.getCaptchaProviders({ ...all, [p.weight]: 200 });
      const result = await solver.solveCaptchaWithProviders(providers, { type: 'image_to_text', body: 'image-data' });
      assert.equal(result.provider, id);
      assert.equal(result.token, 'text-result');
      assert.equal(calls.length, 4);
      assert.equal(new Set(calls.map(c => c.host)).size, 1);
    });
    test(`${build}: ${id} timeout falls back; disabling it prevents all its requests`, async t => {
      const calls = api(t, call => {
        if (call.host === 'api.capsolver.com') return call.path === '/createTask' ? { taskId: 'fallback' } : { status: 'ready', solution: { token: 'fallback-token' } };
        if (id === 'solvecaptcha') return call.path === '/in.php' ? { status: 1, request: 'slow-task' } : { status: 0, request: 'CAPCHA_NOT_READY' };
        return call.path === '/createTask' ? { taskId: 'slow-task' } : { status: 'processing' };
      });
      assert.equal((await solver.solveCaptchaWithProviders(config.getCaptchaProviders({ ...all, [p.weight]: 200 }), params)).provider, 'capsolver');
      assert.equal(calls.filter(c => c.path === '/createTask' || c.path === '/in.php').length, 2);
      calls.length = 0;
      await solver.solveCaptchaWithProviders(config.getCaptchaProviders({ ...all, [p.weight]: 200, [p.enabled]: false }), params);
      assert.ok(calls.every(c => c.host === 'api.capsolver.com'));
    });
    test(`${build}: ${id} rejects errors and malformed balances; hCaptcha never dispatches`, async t => {
      const calls = api(t, () => id === 'solvecaptcha' ? { status: 1, request: '' } : { errorId: 0 });
      await assert.rejects(extra.getAdditionalCaptchaBalance(id, key), /missing balance/);
      const count = calls.length;
      await assert.rejects(solver.solveCaptchaWithProviders(config.getCaptchaProviders({ [p.key]: key, [p.enabled]: true }), { ...params, type: 'hcaptcha' }), /No enabled provider supports/);
      assert.equal(calls.length, count);
      await assert.rejects(extra.solveWithAdditionalProvider(id, key, solver.buildTask(params)), /missing task/);
    });
  }
  test(`${build}: SolveCaptcha v3 waits before polling and uses its legacy protocol`, async t => {
    const calls = api(t, call => call.path === '/in.php' ? { status: 1, request: 'v3-id' } : { status: 1, request: 'v3-token' });
    const result = await solver.solveCaptchaWithProviders(config.getCaptchaProviders({ solveCaptchaApiKey: key, solveCaptchaEnabled: true }), { ...params, type: 'recaptcha_v3_enterprise', pageAction: 'login' });
    assert.equal(result.token, 'v3-token');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].body.enterprise, '1');
    assert.equal(calls[0].body.version, 'v3');
    assert.equal(calls[1].options.method, 'GET');
    assert.equal(calls[1].body.action, 'get');
    assert.equal(calls[1].now, 20_000);
  });
}

test('shared provider code and settings controller match in both browser builds', async () => {
  for (const file of ['agent/captcha-provider-config.js', 'agent/captcha-json-api.js', 'agent/captcha-additional-providers.js', 'agent/two-captcha.js', 'ui/captcha-settings.js', 'ui/locales/captcha-copy.mjs']) {
    assert.equal(await readFile(`src/chrome/src/${file}`, 'utf8'), await readFile(`src/firefox/src/${file}`, 'utf8'), file);
  }
});
