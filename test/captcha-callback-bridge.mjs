import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

for (const build of ['chrome', 'firefox']) {
  const source = await readFile(new URL(`../src/${build}/src/content/captcha-callback-bridge.js`, import.meta.url), 'utf8');
  const { injectCaptchaTokenInPage } = await import(`../src/${build}/src/agent/captcha-frame-runtime.js`);
  const { injectToken, ensureCaptchaCallbackBridge } = await import(`../src/${build}/src/agent/captcha-solver.js`);
  function fixture(family = 'hcaptcha') {
    const name = family === 'hcaptcha' ? 'h-captcha-response' : family === 'turnstile' ? 'cf-turnstile-response' : 'g-recaptcha-response';
    const hosts = [], fields = [];
    const document = {
      getElementById: id => [...hosts, ...fields].find(element => element.id === id),
      querySelector: () => null,
      querySelectorAll: selector => selector.includes('[data-callback]') ? []
        : selector.includes('[data-sitekey]') ? hosts
          : selector.includes('textarea[name=') ? fields.filter(field => selector.includes(`name="${field.name}"`)) : [],
    };
    const context = vm.createContext({ document, URL, URLSearchParams, performance: { timeOrigin: 1000 }, location: { href: 'https://fixture.test/join' }, Event: class { constructor(type) { this.type = type; } }, answers: [] });
    context.window = context;
    const evaluate = code => vm.runInContext(code, context);
    evaluate(source);
    const add = id => {
      const field = { id: `answer-${id}`, name, value: '', tagName: 'TEXTAREA', dispatchEvent() {}, getAttribute: key => key === 'id' ? `answer-${id}` : null };
      const host = { id, isConnected: true, contains: value => value === field, getAttribute: key => key === 'data-sitekey' ? 'site-key' : null };
      hosts.push(host); fields.push(field);
      return { host, field };
    };
    add('one'); add('two');
    evaluate(`window.${family === 'recaptcha' ? 'grecaptcha' : family} = {
      render(container, params) { window.lastOptions = params; return typeof container === 'string' ? container : container.id; },
      getResponse() { return 'native'; }, getRespKey() { return 'native-key'; },
      reset() { return 'reset-result'; }, remove() { return 'remove-result'; },
      execute() { return new Promise((resolve, reject) => { window.nativeResolve = resolve; window.nativeReject = reject; }); }
    }; window.api = ${family === 'recaptcha' ? 'grecaptcha' : family};`);
    const render = (id = 'one', callback = 'token => answers.push([token, api.getResponse("one"), api.getRespKey("one")])') => evaluate(`api.render('${id}', { sitekey: 'site-key', callback: ${callback} })`);
    const inject = (id = 'one') => injectCaptchaTokenInPage({ fieldName: name, token: 'paid-token', respKey: 'paid-key',
      target: { frameId: 0, frameUrl: context.location.href, websiteKey: 'site-key', type: family === 'recaptcha' ? 'recaptcha_v2' : family, responseFieldId: `answer-${id}`, documentTimeOrigin: 1000 } }, { document, window: context });
    return { context, evaluate, render, inject, hosts, fields, name };
  }
  for (const family of ['hcaptcha', 'turnstile', 'recaptcha']) test(`${build}: ${family} closure receives the selected token once and getResponse agrees`, () => {
    const f = fixture(family);
    assert.equal(f.render(), 'one');
    f.render('two', 'token => answers.push(["wrong", token])');
    const result = f.inject();
    assert.equal(result.calledCallback, true, result.callbackError);
    assert.equal(result.callbackSource, `${family}.render`);
    assert.equal(result.callbackCandidates, 1);
    assert.equal(f.fields[0].value, 'paid-token');
    assert.equal(f.fields[1].value, '');
    assert.deepEqual(JSON.parse(JSON.stringify(f.context.answers)), [['paid-token', 'paid-token', 'paid-key']]);
    assert.equal(f.inject().calledCallback, false);
    assert.equal(f.context.answers.length, 1);
  });
  test(`${build}: hCaptcha async execute resumes without a globally named callback`, async () => {
    const f = fixture(); f.render('one', 'undefined');
    const continuation = f.evaluate('api.execute("one", {async:true})');
    assert.equal(f.inject().calledCallback, true);
    assert.deepEqual(JSON.parse(JSON.stringify(await continuation)), { response: 'paid-token', key: 'paid-key' });
    f.context.nativeReject(new Error('late native rejection'));
    await new Promise(resolve => setImmediate(resolve));
  });
  test(`${build}: native execute resolution and rejection are preserved`, async () => {
    const f = fixture(); f.render('one', 'undefined');
    const first = f.evaluate('api.execute("one", {async:true})');
    f.context.nativeResolve({ response: 'human-token', key: 'human-key' });
    assert.equal((await first).response, 'human-token');
    await new Promise(resolve => setImmediate(resolve));
    const second = f.evaluate('api.execute("one", {async:true})');
    f.context.nativeReject(new Error('challenge-closed'));
    await assert.rejects(second, /challenge-closed/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.inject().callbackCandidates, 0);
  });
  test(`${build}: a reset during field events invalidates the captured callback`, () => {
    const f = fixture(); f.render();
    f.fields[0].dispatchEvent = () => f.evaluate('api.reset("one")');
    const result = f.inject();
    assert.equal(result.calledCallback, false);
    assert.match(result.callbackError, /changed/);
    assert.equal(f.context.answers.length, 0);
    assert.equal(f.evaluate('api.getResponse("one")'), 'native');
  });
  test(`${build}: removal and expiry discard captured responses`, () => {
    const f = fixture();
    f.evaluate('api.render("one", {sitekey:"site-key", callback:token=>answers.push(token), "expired-callback":()=>answers.push("expired")})');
    assert.equal(f.inject().calledCallback, true);
    f.evaluate('lastOptions["expired-callback"]()');
    assert.equal(f.evaluate('api.getResponse("one")'), 'native');
    assert.equal(f.evaluate('api.remove("one")'), 'remove-result');
    assert.equal(f.inject().callbackCandidates, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(f.context.answers)), ['paid-token', 'expired']);
  });
  test(`${build}: detached and ambiguous widgets never invoke a closure`, () => {
    const f = fixture(); f.render(); f.render('two');
    f.hosts[0].isConnected = false;
    assert.equal(f.inject().calledCallback, false);
    f.hosts[0].isConnected = true;
    f.fields.length = 0;
    const callbacks = f.context.__webbrainCaptchaCallbacks.callbacks('hcaptcha', 'site-key', f.name, null, null);
    assert.equal(callbacks.length, 2, 'shared site keys must not be collapsed into one widget');
  });
  test(`${build}: late SDK methods and enterprise render registrations are captured`, () => {
    const f = fixture('recaptcha');
    f.evaluate('grecaptcha = {ready: fn => fn()}; grecaptcha.enterprise = {}; grecaptcha.enterprise.render = (id, options) => id; grecaptcha.enterprise.render("one",{sitekey:"site-key",callback:token=>answers.push(token)})');
    assert.equal(f.inject().calledCallback, true);
    assert.deepEqual(JSON.parse(JSON.stringify(f.context.answers)), ['paid-token']);
  });
  test(`${build}: hCaptcha compatibility alias retains the hCaptcha family`, () => {
    const f = fixture();
    f.evaluate('grecaptcha = {render: id=>id}; hcaptcha = grecaptcha; hcaptcha.render("one",{sitekey:"site-key",callback:token=>answers.push(token)})');
    assert.equal(f.inject().calledCallback, true);
  });
  test(`${build}: callback exceptions remain diagnostic and cannot be replayed`, () => {
    const f = fixture(); f.render('one', 'token => { answers.push(token); throw new Error("site-handler-failed"); }');
    const result = f.inject();
    assert.equal(result.calledCallback, false);
    assert.equal(result.callbackError, 'site-handler-failed');
    assert.equal(f.inject().calledCallback, false);
    assert.equal(f.context.answers.length, 1);
  });
  for (const mode of ['field', 'removed', 'late-callback', 'navigated']) {
    test(`${build}: settle retry preserves ${mode} application without replaying field events`, async () => {
      const f = fixture();
      f.render('one', 'undefined');
      let events = 0, attempts = 0;
      f.fields[0].dispatchEvent = event => {
        events++;
        if (event.type === 'change' && mode === 'removed') f.fields.shift();
      };
      const input = { fieldName: f.name, token: 'paid-token', callbackHint: 'lateComplete',
        target: { frameId: 0, frameUrl: f.context.location.href, websiteKey: 'site-key',
          type: 'hcaptcha', responseFieldId: 'answer-one', documentTimeOrigin: 1000 } };
      const beforeAttempt = () => {
        attempts++;
        if (attempts === 2 && mode === 'navigated') throw new Error('frame navigated');
        if (attempts === 2 && mode === 'late-callback') f.evaluate('lateComplete = token => answers.push(token)');
      };
      const api = {
        scripting: { executeScript: async options => {
          if (options.files) return [];
          beforeAttempt();
          return [{ frameId: 0, result: options.func(options.args[0], { document: f.context.document, window: f.context }) }];
        } },
        tabs: { executeScript: async (_, options) => {
          beforeAttempt();
          return [f.evaluate(options.code)];
        } },
      };
      const namespace = build === 'firefox' ? 'browser' : 'chrome';
      const previous = globalThis[namespace];
      globalThis[namespace] = api;
      try {
        const result = await injectToken(1, input);
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.fieldUpdated, true);
        assert.equal(result.fieldsTouched, 1);
        assert.equal(result.bridgeSettleRetried, true);
        assert.equal(result.calledCallback, mode === 'late-callback');
        assert.equal(events, 2, 'one input/change pair, even when callback discovery retries');
        assert.equal(attempts, 2);
        assert.deepEqual(JSON.parse(JSON.stringify(f.context.answers)), mode === 'late-callback' ? ['paid-token'] : []);
      } finally {
        if (previous === undefined) delete globalThis[namespace]; else globalThis[namespace] = previous;
      }
    });
  }
  if (build === 'firefox') for (const fallback of [false, true]) {
    test(`firefox: descendant installation validates the full frame path (fallback=${fallback})`, async () => {
      const f = fixture();
      f.context.location.href = 'about:srcdoc';
      f.context.name = 'inner';
      f.evaluate('delete window.__webbrainCaptchaCallbacks');
      let loads = 0;
      f.context.document.createElement = () => ({ remove() {} });
      f.context.document.head = { appendChild(script) { loads++; f.evaluate(source); script.onload(); } };
      const outerWindow = { location: { href: 'about:blank' }, name: 'outer' };
      const outerDocument = { querySelectorAll: () => [{ contentWindow: f.context, contentDocument: f.context.document }] };
      const rootDocument = { querySelectorAll: () => [{ contentWindow: outerWindow, contentDocument: outerDocument }] };
      const root = vm.createContext({ document: rootDocument, setTimeout, clearTimeout });
      root.window = root;
      root.__webbrainCaptchaCallbacks = { callbacks() {} };
      const target = { frameId: 0, frameUrl: 'about:srcdoc', documentTimeOrigin: 1000,
        framePath: [{ index: 0, frameUrl: 'about:blank', frameName: 'outer' },
          { index: 0, frameUrl: 'about:srcdoc', frameName: 'inner' }] };
      const api = { runtime: { getURL: file => `moz-extension://fixture/${file}` },
        ...(fallback ? {} : { scripting: { executeScript: async options => [{ result: await vm.runInContext(
          `(${options.func.toString()})(...${JSON.stringify(options.args)})`, root) }] } }),
        tabs: { executeScript: async (_, options) => [await vm.runInContext(options.code, root)] } };
      assert.equal(await ensureCaptchaCallbackBridge(1, target, api), true);
      assert.equal(loads, 1, 'load into the descendant even when the ancestor already has a bridge');
      assert.equal(typeof f.context.__webbrainCaptchaCallbacks.callbacks, 'function');
      for (const stale of [
        { ...target, framePath: [{ ...target.framePath[0], index: 1 }] },
        { ...target, framePath: [{ ...target.framePath[0], frameName: 'changed' }] },
        { ...target, frameUrl: 'about:blank' },
        { ...target, documentTimeOrigin: 2000 },
      ]) assert.equal(await ensureCaptchaCallbackBridge(1, stale, api), false);
      assert.equal(loads, 1, 'stale paths and documents must not install another bridge');
    });
  }
  test(`${build}: bridge is scoped to provider settings and ensured in the selected document`, async () => {
    const manifest = JSON.parse(await readFile(new URL(`../src/${build}/manifest.json`, import.meta.url), 'utf8'));
    const entries = (manifest.content_scripts || []).filter(entry => entry.js?.includes('src/content/captcha-callback-bridge.js'));
    assert.equal(entries.length, 0, 'the bridge must be registered dynamically only while a provider is enabled');
    const solver = await readFile(new URL(`../src/${build}/src/agent/captcha-solver.js`, import.meta.url), 'utf8');
    assert.match(solver, /export async function ensureCaptchaCallbackBridge\(tabId/);
    assert.match(solver, /await ensureCaptchaCallbackBridge\(tabId, target\)/);
    assert.match(solver, /captcha-callback-bridge\.js/);
    assert.match(solver, /CAPTCHA_BRIDGE_SETTLE_RETRY_MS/);
    assert.match(solver, /bridgeSettleRetried/);
    const agent = await readFile(new URL(`../src/${build}/src/agent/agent.js`, import.meta.url), 'utf8');
    assert.match(agent, /await ensureCaptchaCallbackBridge\(tabId, detected\)/);
  });
}
test('callback bridge is identical in Chrome and Firefox', async () => {
  assert.equal(await readFile('src/chrome/src/content/captcha-callback-bridge.js', 'utf8'), await readFile('src/firefox/src/content/captcha-callback-bridge.js', 'utf8'));
});
