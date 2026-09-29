import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const capKey = 'CAP-0123456789abcdefghij';
const twoKey = '0123456789abcdef0123456789abcdef';
const enabled = { capsolverApiKey: capKey, captchaSolverEnabled: true, twoCaptchaApiKey: twoKey, twoCaptchaEnabled: true };
const params = { type: 'turnstile', websiteURL: 'https://example.com/signup', websiteKey: 'site-key' };

function mockApi(t, respond) {
  const calls = [];
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { now += delay; callback(); });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const call = { url, body: JSON.parse(options.body), signal: options.signal };
    calls.push(call);
    return Response.json(await respond(call, calls.length));
  });
  return calls;
}

for (const build of ['chrome', 'firefox']) {
  const config = await import(`../src/${build}/src/agent/captcha-provider-config.js`);
  const solver = await import(`../src/${build}/src/agent/captcha-solver.js`);
  const two = await import(`../src/${build}/src/agent/two-captcha.js`);
  const transfer = await import(`../src/${build}/src/config-transfer.js`);

  test(`${build}: every supported locale translates the live CAPTCHA card keys`, async () => {
    const { captchaEnglish, captchaTranslations } = await import(`../src/${build}/src/ui/locales/captcha-copy.mjs`);
    const base = new URL(`../src/${build}/src/ui/locales/`, import.meta.url);
    const locales = (await readdir(base)).filter(name => name.endsWith('.js')).map(name => name.slice(0, -3));
    const markup = await readFile(new URL('../settings.html', base), 'utf8');
    const settings = await readFile(new URL('../settings.js', base), 'utf8');
    const keys = Object.keys(captchaEnglish).sort();
    for (const key of keys) assert.ok(markup.includes(key) || settings.includes(key), `${key}: unused copy`);
    for (const lang of locales) {
      const copy = lang === 'en' ? captchaEnglish : captchaTranslations[lang];
      assert.ok(copy, `${lang}: missing translation`);
      assert.deepEqual(Object.keys(copy).sort(), keys, `${lang}: incomplete translation`);
      for (const key of keys) assert.ok(copy[key].trim().length > 0, `${lang}/${key}: empty translation`);
      assert.match(copy['st.captcha.two_desc'], /hCaptcha.*CapSolver|CapSolver.*hCaptcha/, lang);
      const legacy = (await import(new URL(`${lang}.js`, base))).default;
      for (const key of ['desc_html', 'security_html', 'enabled.label', 'enabled.desc']) {
        assert.equal(legacy[`st.captcha.${key}`], undefined, `${lang}: stale copy retained`);
      }
    }
  });

  test(`${build}: unsupported providers are skipped without creating paid hCaptcha tasks`, async t => {
    const calls = mockApi(t, () => ({ errorId: 12, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE' }));
    await assert.rejects(solver.solveCaptchaWithProviders(config.getCaptchaProviders({ ...enabled, captchaSolverEnabled: false }), { ...params, type: 'hcaptcha' }), /No enabled provider supports hcaptcha/);
    assert.equal(calls.length, 0);
    await assert.rejects(solver.solveCaptchaWithProviders(config.getCaptchaProviders(enabled), { ...params, type: 'hcaptcha' }), /ERROR_CAPTCHA_UNSOLVABLE/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.capsolver.com/createTask');
  });

  test(`${build}: independent consent, validation, order, and managed isolation`, () => {
    assert.deepEqual(config.getCaptchaProviders({}), []);
    assert.deepEqual(config.getCaptchaProviders({ capsolverApiKey: capKey, twoCaptchaApiKey: twoKey }), []);
    assert.deepEqual(config.getCaptchaProviders(enabled).map(p => p.id), ['capsolver', '2captcha']);
    assert.deepEqual(config.getCaptchaProviders({ ...enabled, captchaSolverEnabled: false }).map(p => p.id), ['2captcha']);
    assert.deepEqual(config.getCaptchaProviders({ ...enabled, twoCaptchaEnabled: false }).map(p => p.id), ['capsolver']);
    assert.deepEqual(config.getCaptchaProviders({ ...enabled, twoCaptchaApiKey: 'invalid', capsolverApiKey: 'invalid' }), []);
    assert.equal(config.isValidTwoCaptchaApiKey(`  ${twoKey.toUpperCase()}  `), true);
    for (const key of ['', 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) assert.equal(config.isValidTwoCaptchaApiKey(key), false);
    assert.deepEqual(config.getCaptchaProviders({ ...enabled, webbrainCloudManaged: true }), []);
    assert.deepEqual(config.getCaptchaProviders({ ...enabled, webbrainCloudManaged: true, webbrainCloudCapsolverBrokerEnabled: true }), [
      { id: 'capsolver', apiKey: '', useCloudBroker: true },
    ]);
  });

  test(`${build}: config round trip preserves each opt-in; key-only imports stay disabled`, () => {
    for (const settings of [enabled, { ...enabled, captchaSolverEnabled: false }, { ...enabled, twoCaptchaEnabled: false }]) {
      const exported = transfer.createConfigExport(settings);
      const imported = transfer.parseConfigImport(JSON.stringify(exported)).settings;
      assert.deepEqual(config.getCaptchaProviders(imported), config.getCaptchaProviders(settings));
    }
    const imported = transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { twoCaptchaApiKey: twoKey } })).settings;
    assert.equal(imported.twoCaptchaEnabled, false);
    assert.deepEqual(config.getCaptchaProviders(imported), []);
  });

  test(`${build}: CapSolver success stops before 2Captcha`, async t => {
    const calls = mockApi(t, ({ url }) => url.endsWith('/createTask') ? { taskId: 'cap-task' } : { status: 'ready', solution: { token: 'cap-token' } });
    const result = await solver.solveCaptchaWithProviders(config.getCaptchaProviders(enabled), params);
    assert.equal(result.provider, 'capsolver');
    assert.equal(result.token, 'cap-token');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.url.startsWith('https://api.capsolver.com/')));
  });

  for (const failure of ['api-error', 'network-timeout', 'missing-token', 'poll-timeout']) {
    test(`${build}: ${failure} falls back once to 2Captcha with its own key/task`, async t => {
      const calls = mockApi(t, ({ url, body }) => {
        if (url.startsWith('https://api.capsolver.com')) {
          assert.equal(body.clientKey, capKey);
          if (failure === 'api-error') return { errorId: 1, errorCode: 'ERROR_ZERO_BALANCE' };
          if (failure === 'network-timeout') throw new Error('Request timed out');
          return url.endsWith('/createTask') ? { taskId: 'cap-task' }
            : failure === 'poll-timeout' ? { status: 'processing' } : { status: 'ready', solution: {} };
        }
        assert.equal(body.clientKey, twoKey);
        assert.equal(body.appId, undefined);
        if (url.endsWith('/createTask')) {
          assert.deepEqual(body.task, { type: 'TurnstileTaskProxyless', websiteURL: params.websiteURL, websiteKey: params.websiteKey });
          return { taskId: 123 };
        }
        assert.equal(body.taskId, 123);
        return { status: 'ready', solution: { token: 'two-token' } };
      });
      const result = await solver.solveCaptchaWithProviders(config.getCaptchaProviders(enabled), params);
      assert.equal(result.provider, '2captcha');
      assert.equal(result.fieldName, 'cf-turnstile-response');
      assert.equal(result.token, 'two-token');
      assert.equal(calls.filter(call => call.url === 'https://api.2captcha.com/createTask').length, 1);
      assert.ok(calls.findIndex(call => call.url.includes('2captcha')) > 0);
    });
  }

  test(`${build}: 2Captcha alone polls processing tasks and returns image text`, async t => {
    const calls = mockApi(t, ({ url }, n) => {
      assert.ok(url.startsWith('https://api.2captcha.com/'));
      return n === 1 ? { taskId: 123 } : n === 2 ? { status: 'processing' } : { status: 'ready', solution: { text: 'readable' } };
    });
    const result = await solver.solveCaptchaWithProviders(config.getCaptchaProviders({ ...enabled, captchaSolverEnabled: false }), { type: 'image_to_text', body: 'base64-image' });
    assert.equal(result.token, 'readable');
    assert.equal(result.fieldName, null);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].body.task, { type: 'ImageToTextTask', body: 'base64-image' });
  });

  test(`${build}: both failures stop, while disabled providers receive no requests`, async t => {
    const calls = mockApi(t, () => ({ errorId: 12, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE' }));
    await assert.rejects(solver.solveCaptchaWithProviders(config.getCaptchaProviders(enabled), params), /capsolver:.*2captcha:/);
    assert.equal(calls.length, 2);
    await assert.rejects(solver.solveCaptchaWithProviders([], params), /No CAPTCHA solver/);
    assert.equal(calls.length, 2);
  });

  test(`${build}: invalid v3 parameters fail before a paid dispatch`, async t => {
    const calls = mockApi(t, () => { throw new Error('must not dispatch'); });
    await assert.rejects(solver.solveCaptchaWithProviders(config.getCaptchaProviders(enabled), { ...params, type: 'recaptcha_v3' }), /pageAction/);
    assert.equal(calls.length, 0);
  });

  test(`${build}: 2Captcha task mapping covers reCAPTCHA variants and Turnstile data`, () => {
    const task = overrides => two.buildTwoCaptchaTask(solver.buildTask({ ...params, ...overrides }));
    assert.equal(task({ type: 'recaptcha_v2' }).type, 'RecaptchaV2TaskProxyless');
    assert.deepEqual(task({ type: 'recaptcha_v2_enterprise', enterprisePayload: { s: 'opaque' }, isInvisible: true }), {
      type: 'RecaptchaV2EnterpriseTaskProxyless', websiteURL: params.websiteURL, websiteKey: params.websiteKey, enterprisePayload: { s: 'opaque' }, isInvisible: true,
    });
    assert.deepEqual(task({ type: 'recaptcha_v3_enterprise', pageAction: 'login', minScore: 0.9 }), {
      type: 'RecaptchaV3TaskProxyless', websiteURL: params.websiteURL, websiteKey: params.websiteKey, pageAction: 'login', minScore: 0.9, isEnterprise: true,
    });
    assert.equal(task({ type: 'recaptcha_v3', pageAction: 'login' }).minScore, 0.3);
    assert.deepEqual(task({ metadata: { action: 'login', cdata: 'opaque', chlPageData: 'page' } }), {
      type: 'TurnstileTaskProxyless', websiteURL: params.websiteURL, websiteKey: params.websiteKey, action: 'login', data: 'opaque', pagedata: 'page',
    });
    assert.throws(() => task({ type: 'hcaptcha' }), /does not support/);
  });

  test(`${build}: balance check uses 2Captcha and surfaces API errors`, async t => {
    const calls = mockApi(t, (_, n) => n === 1 ? { balance: 1.25 } : { errorId: 1, errorCode: 'ERROR_KEY_DOES_NOT_EXIST' });
    assert.deepEqual(await two.getTwoCaptchaBalance(twoKey), { balance: 1.25 });
    assert.equal(calls[0].url, 'https://api.2captcha.com/getBalance');
    assert.deepEqual(calls[0].body, { clientKey: twoKey });
    await assert.rejects(two.getTwoCaptchaBalance(twoKey), /ERROR_KEY_DOES_NOT_EXIST/);
  });

  test(`${build}: managed broker failure never falls back to personal keys`, async t => {
    const calls = mockApi(t, () => { throw new Error('broker unavailable'); });
    await assert.rejects(solver.solveCaptchaWithProviders(config.getCaptchaProviders({ ...enabled, webbrainCloudManaged: true, webbrainCloudCapsolverBrokerEnabled: true }), params), /broker unavailable/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:17373/capsolver/solve');
    assert.equal(calls[0].body.clientKey, undefined);
  });
}
