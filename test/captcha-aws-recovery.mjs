import test from 'node:test';
import assert from 'node:assert/strict';

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { describeAwsWafObservation, prepareNativeCaptchaTasks } = await import(`../src/${build}/src/agent/captcha-native-providers.js`);
  function fixture(t, { fallback = false } = {}) {
    const url = 'https://site.test/join';
    const observed = { pageUrl: url, websiteKey: 'observed-key', iv: 'iv', context: 'context',
      challengeScript: 'https://site.token.awswaf.com/challenge.js', active: true, inspectionComplete: true,
      rootDocument: { url, timeOrigin: 1000 } };
    const requests = [], cookies = [], stored = {};
    const settings = { captchaSolverEnabled: true, capsolverApiKey: 'CAP-' + 'a'.repeat(32),
      ...(fallback ? { capmonsterEnabled: true, capmonsterApiKey: 'b'.repeat(32) } : {}) };
    const evaluate = name => name.includes('observeAwsWafChallengeInPage') ? structuredClone(observed)
      : name.includes('applyCaptchaValuesInPage') ? { success: true, fieldsUpdated: 0, callbacksCalled: 0, clicksDispatched: 0 }
      : name === 'read' || name.includes('const read') || name.startsWith('(() => ({ url: location.href') ? { url, timeOrigin: observed.rootDocument.timeOrigin }
      : { candidates: [], challenge: null, frameContext: { frameUrl: url,
        documentTimeOrigin: observed.rootDocument.timeOrigin, childFrames: [] } };
    const api = { tabs: { get: async () => ({ url }), executeScript: async (_id, options) => [evaluate(options.code)] },
      scripting: { executeScript: async options => [{ frameId: 0, result: evaluate(options.func.name) }] },
      webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url }] },
      storage: { local: { get: async () => settings }, session: { get: async key => ({ [key]: stored[key] }),
        set: async value => Object.assign(stored, structuredClone(value)) } },
      cookies: { getAllCookieStores: async () => [{ id: 'store', tabIds: [1] }],
        set: async cookie => { cookies.push(cookie); return cookie; } } };
    if (build === 'firefox') delete api.scripting;
    const apiName = build === 'chrome' ? 'chrome' : 'browser';
    const previous = globalThis[apiName]; globalThis[apiName] = api;
    t.after(() => { globalThis[apiName] = previous; });
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const request = { url, ...JSON.parse(options.body) }; requests.push(request);
      assert.ok(stored[agent._convKey(1)].nativeCaptchaDispatch.awsAttempts.includes(`${request.task.awsExistingToken ? 'secondary' : 'initial'}:${url.includes('capmonster') ? 'capmonster' : 'capsolver'}`),
        'provider reservations must be durable before network dispatch');
      return Response.json({ status: 'ready', taskId: `task-${requests.length}`,
        solution: url.includes('capmonster') ? { cookies: { 'aws-waf-token': 'fallback-cookie' } } : { cookie: 'primary-cookie' } });
    });
    const agent = new Agent({ getActive: () => ({ promptTier: 'full' }) });
    agent.conversationModes.set(1, 'act'); agent.captchaSolverEnabled = true;
    agent.captchaProviderIds = fallback ? ['capsolver', 'capmonster'] : ['capsolver'];
    agent.conversations.set(1, [{ role: 'system', content: 'test' }]);
    const read = () => agent._observeCaptchaChallenge(1, 'get_accessibility_tree', { pageUrl: url, pageContent: 'heading "Let’s confirm you are human"' });
    return { agent, api, observed, requests, cookies, stored, read, url };
  }

  test(`${build}: SDK secondary AWS verification uses fresh SDK inputs instead of stale gokuProps`, () => {
    const observed = { pageUrl: 'https://site.test/join', websiteKey: 'stale', iv: 'stale', context: 'stale',
      apiKey: 'observed-sdk-key', existingToken: 'existing-cookie', jsapiScript: 'https://site.captcha-sdk.awswaf.com/jsapi.js' };
    const providers = ['capsolver', 'capmonster', 'anti-captcha'].map(id => ({ id, apiKey: 'provider-key' }));
    const result = describeAwsWafObservation(providers, observed);
    assert.equal(result.route, 'secondary');
    assert.deepEqual(result.providerTasks, [{ provider: 'capsolver', method: 'AntiAwsWafTaskProxyLess', parameters: {
      websiteURL: observed.pageUrl, awsApiKey: observed.apiKey, awsApiJs: observed.jsapiScript, awsExistingToken: observed.existingToken,
    } }]);
    assert.equal(prepareNativeCaptchaTasks(providers, result.providerTasks).length, 1);
  });

  test(`${build}: AWS auto route applies a cookie once and survives a reload without recharging the same provider`, async t => {
    const f = fixture(t);
    assert.equal((await f.read()).gate.status, 'solve_required');
    const result = await f.agent._executeToolImpl(1, 'solve_captcha', {});
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.type, 'aws_waf'); assert.equal(result.clearance, 'unverified');
    assert.equal(f.cookies.length, 1); assert.equal(f.cookies[0].name, 'aws-waf-token');
    assert.equal((await f.agent._executeToolImpl(1, 'solve_captcha', {})).noDispatch, true);
    f.observed.rootDocument.timeOrigin++;
    assert.equal((await f.read()).gate.status, 'manual_required');
    assert.equal((await f.agent._executeToolImpl(1, 'solve_captcha', {})).noDispatch, true);
    assert.equal(f.requests.length, 1);
  });

  test(`${build}: verified continued AWS blocking after reload uses only an untried compatible provider`, async t => {
    const f = fixture(t, { fallback: true });
    assert.equal((await f.agent._executeToolImpl(1, 'solve_captcha', {})).provider, 'capsolver');
    f.observed.rootDocument.timeOrigin++;
    assert.equal((await f.read()).gate.status, 'solve_required');
    const result = await f.agent._executeToolImpl(1, 'solve_captcha', {});
    assert.equal(result.provider, 'capmonster', result.error);
    assert.equal(result.success, true);
    f.observed.rootDocument.timeOrigin++;
    assert.equal((await f.read()).gate.status, 'manual_required');
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.agent._conversationStorageEntry(1).nativeCaptchaDispatch.awsAttempts, ['initial:capsolver', 'initial:capmonster']);
  });

  test(`${build}: confirmed AWS clearance permits a later secondary challenge in the same document`, async t => {
    const f = fixture(t);
    await f.agent._executeToolImpl(1, 'solve_captcha', {});
    f.observed.active = false;
    assert.equal((await f.read()).gate.status, 'cleared');
    assert.equal(f.agent._captchaGateBlockResult(1, 'click', {}), null);
    f.observed.active = true;
    Object.assign(f.observed, { apiKey: 'sdk-key', jsapiScript: 'https://site.captcha-sdk.awswaf.com/jsapi.js', existingToken: 'primary-cookie' });
    assert.equal((await f.read()).gate.status, 'solve_required');
    const result = await f.agent._executeToolImpl(1, 'solve_captcha', { type: 'aws_waf' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].task.awsExistingToken, 'primary-cookie');
    assert.equal(f.requests[1].task.awsKey, undefined);
  });

  test(`${build}: unreadable AWS state retains its lock; manual clearance resumes without another request`, async t => {
    const f = fixture(t);
    await f.agent._executeToolImpl(1, 'solve_captcha', {});
    const read = f.agent._readAwsWafChallenge;
    f.agent._readAwsWafChallenge = async () => null;
    assert.equal(await f.agent._observeAwsWafGate(1), null);
    assert.equal(f.agent._captchaGateBlockResult(1, 'click', {}).denied, true);
    f.agent._readAwsWafChallenge = read;
    f.observed.active = false;
    assert.equal((await f.read()).gate.status, 'cleared');
    assert.equal(f.requests.length, 1);
  });

  test(`${build}: an AWS dispatch survives restart and cannot be bought again after reload`, async t => {
    const f = fixture(t);
    await f.agent._executeToolImpl(1, 'solve_captcha', {});
    const restored = new Agent({ getActive: () => ({ promptTier: 'full' }) });
    await restored._hydrate(1);
    restored.captchaSolverEnabled = true; restored.captchaProviderIds = ['capsolver'];
    assert.deepEqual(restored._nativeCaptchaSolutions.get(1).awsAttempts, ['initial:capsolver']);
    f.observed.rootDocument.timeOrigin++;
    assert.equal((await restored._observeAwsWafGate(1)).status, 'manual_required');
    assert.equal((await restored._executeToolImpl(1, 'solve_captcha', {})).noDispatch, true);
    assert.equal(f.requests.length, 1);
  });

  test(`${build}: trace-shaped AWS cookie application ignores an empty callback without another solve`, async t => {
    const f = fixture(t);
    const solved = await f.agent._executeToolImpl(1, 'solve_captcha', { inject: false, providerTasks: [{
      provider: 'capsolver', method: 'AntiAwsWafTaskProxyLess', parameters: {
        websiteURL: f.url, awsKey: f.observed.websiteKey, awsIv: f.observed.iv,
        awsContext: f.observed.context, awsChallengeJS: f.observed.challengeScript,
      },
    }] });
    assert.equal(solved.applicationRequired, true);
    const binding = { clicks: [], frameId: 0, frameUrl: f.url, fields: [],
      cookies: [{ path: 'cookie', encoding: 'text', name: 'aws-waf-token' }], callback: { name: '', path: '' } };
    const result = await f.agent._executeToolImpl(1, 'apply_captcha_solution', binding);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.dispatched, true); assert.equal(result.cookiesUpdated, 1);
    assert.equal(f.cookies.length, 1); assert.equal(f.cookies[0].value, 'primary-cookie');
    assert.equal(f.requests.length, 1);
    assert.equal((await f.agent._executeToolImpl(1, 'apply_captcha_solution', binding)).success, false);
    assert.equal(f.cookies.length, 1); assert.equal(f.requests.length, 1);
  });

  test(`${build}: correcting an invalid callback reuses the paid answer without a cookie write on failure`, async t => {
    const f = fixture(t);
    await f.agent._executeToolImpl(1, 'solve_captcha', { type: 'aws_waf', inject: false });
    const binding = { frameId: 0, frameUrl: f.url,
      cookies: [{ path: 'cookie', name: 'aws-waf-token' }], callback: { name: '', path: 'cookie' } };
    const invalid = await f.agent._executeToolImpl(1, 'apply_captcha_solution', binding);
    assert.equal(invalid.success, false); assert.equal(invalid.dispatched, false);
    assert.equal(invalid.applicationRetryable, true);
    assert.match(invalid.error, /Omit callback.*reuse the stored answer/);
    assert.equal(f.cookies.length, 0);
    delete binding.callback;
    assert.equal((await f.agent._executeToolImpl(1, 'apply_captcha_solution', binding)).success, true);
    assert.equal(f.cookies.length, 1); assert.equal(f.requests.length, 1);
  });

  test(`${build}: AWS token-only requests do not mutate the cookie store`, async t => {
    const f = fixture(t);
    const result = await f.agent._executeToolImpl(1, 'solve_captcha', { type: 'aws_waf', inject: false });
    assert.equal(result.success, true); assert.equal(result.applicationRequired, true);
    assert.equal(result.injected, false); assert.equal(f.cookies.length, 0);
  });
}
