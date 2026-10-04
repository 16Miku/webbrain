import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

for (const build of ['chrome', 'firefox']) {
  const source = await readFile(new URL(`../src/${build}/src/content/captcha-callback-bridge.js`, import.meta.url), 'utf8');
  const { injectCaptchaTokenInPage } = await import(`../src/${build}/src/agent/captcha-frame-runtime.js`);
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
    const context = vm.createContext({ document, URL, URLSearchParams, performance: { timeOrigin: 1000 }, location: { href: 'https://fixture.test/join' }, Event: class {}, answers: [] });
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
  test(`${build}: bridge manifest runs before site scripts in every matching frame`, async () => {
    const manifest = JSON.parse(await readFile(new URL(`../src/${build}/manifest.json`, import.meta.url), 'utf8'));
    const entry = manifest.content_scripts.find(entry => entry.js?.includes('src/content/captcha-callback-bridge.js'));
    assert.equal(entry.world, 'MAIN'); assert.equal(entry.run_at, 'document_start');
    assert.equal(entry.all_frames, true); assert.equal(entry.match_about_blank, true);
  });
}
test('callback bridge is identical in Chrome and Firefox', async () => {
  assert.equal(await readFile('src/chrome/src/content/captcha-callback-bridge.js', 'utf8'), await readFile('src/firefox/src/content/captcha-callback-bridge.js', 'utf8'));
});
