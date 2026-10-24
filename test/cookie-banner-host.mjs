// Automatic cookie-banner declining: the background host's coverage, frame and
// eval boundaries, settling, the agent note, and the vendored autoconsent copy.
// No browser; a fake extension API records what the host would do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

import { checkVendoredAutoconsent } from '../scripts/update-autoconsent.mjs';

const BUILDS = ['chrome', 'firefox'];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

async function until(check, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function fakeApi() {
  const listeners = { message: [], committed: [], removed: [] };
  const calls = { execute: [], sent: [], frameLookups: 0 };
  let frames = [];
  const api = {
    runtime: {
      id: 'webbrain',
      getURL: (path = '') => `chrome-extension://webbrain/${path}`,
      onMessage: { addListener: fn => listeners.message.push(fn) },
    },
    webNavigation: {
      onCommitted: { addListener: fn => listeners.committed.push(fn) },
      getAllFrames: async () => {
        calls.frameLookups += 1;
        return frames;
      },
    },
    tabs: {
      onRemoved: { addListener: fn => listeners.removed.push(fn) },
      sendMessage: async (tabId, message, options) => {
        calls.sent.push({ tabId, frameId: options?.frameId, message });
      },
    },
    scripting: {
      executeScript: async (details) => {
        calls.execute.push(details);
        return [{ result: 'snippet-result' }];
      },
    },
  };
  return {
    api,
    calls,
    setFrames(value) { frames = value; },
    commit(tabId, frameId, url) {
      for (const fn of listeners.committed) fn({ tabId, frameId, url });
    },
    content(tabId, frameId, url, msg) {
      let response;
      for (const fn of listeners.message) {
        fn({ type: 'webbrain-autoconsent', msg }, { tab: { id: tabId }, frameId, url }, value => { response = value; });
      }
      return response;
    },
    status(tabId, senderUrl) {
      let response;
      for (const fn of listeners.message) {
        fn({ type: 'webbrain-cookie-banner-status', tabId }, { url: senderUrl }, (value) => { response = value; });
      }
      return response;
    },
  };
}

for (const build of BUILDS) {
  const hostModule = await import(`../src/${build}/src/agent/cookie-banner-host.js`);
  const { cookieBannerNoteText, settleCookieBannersForTurn } = await import(`../src/${build}/src/agent/cookie-banner-turn.js`);
  const { evalSnippets } = await import(`../src/${build}/vendor/autoconsent/autoconsent.esm.js`);
  const { WEBBRAIN_COOKIE_BANNER_RULES, cookieBannerRulesFor } = await import(`../src/${build}/src/agent/cookie-banner-rules.js`);
  const { guardCookieBannerInstance } = await import(`../src/${build}/src/content/autoconsent-runtime.js`);
  const rules = JSON.parse(await read(`src/${build}/vendor/autoconsent/compact-rules.json`));
  const { createCookieBannerHost, normalizeCookieBannerMode, isChallengeFrameUrl } = hostModule;

  function setup({ runs = new Map(), mode, options = {} } = {}) {
    const fake = fakeApi();
    const host = createCookieBannerHost(fake.api, {
      isRunActive: tabId => runs.has(tabId),
      runMode: tabId => runs.get(tabId),
      loadRules: async () => rules,
      ...(mode ? { loadMode: async () => mode } : {}),
      ...options,
    });
    host.start();
    return { host, fake, runs };
  }

  const injections = calls => calls.execute.filter(call => Array.isArray(call.files));

  test(`${build}: revoking coverage stops injected frames and denies further actions`, async () => {
    const runs = new Map([[201, 'act']]);
    const { fake, host } = setup({ runs });
    const url = 'https://shop.example/';
    fake.commit(201, 0, url);
    await until(() => injections(fake.calls).length === 1, 'injection');
    assert.equal(fake.content(201, 0, url, { type: 'checkCoverage' }), true);
    runs.delete(201);
    host.refreshCoverage(201);
    assert.ok(fake.calls.sent.some(call => call.tabId === 201 && call.message.msg.type === 'stop'));
    assert.equal(fake.content(201, 0, url, { type: 'checkCoverage' }), false);
    assert.deepEqual(host.status(201).frames, []);
    runs.set(201, 'act');
    fake.commit(201, 0, url);
    await until(() => injections(fake.calls).length === 2, 'fresh injection');
    host.setMode('off');
    assert.equal(fake.content(201, 0, url, { type: 'checkCoverage' }), false);
    assert.deepEqual(host.status(201).frames, []);
  });

  test(`${build}: cancellation survives a pending action grant and stops every click in a rule`, async () => {
    let clicks = 0;
    const elements = [{ click() { clicks += 1; } }, { click() { clicks += 1; } }];
    const instance = () => ({
      config: { enabled: true, autoAction: 'optOut' },
      doOptOut() {}, doOptIn() {}, handlePopup() {}, findCmp() {}, waitForPopup() {},
      undoPrehide() {}, restoreFocus() {},
      domActions: {
        elementSelector: () => elements,
        clickElement: async element => { element.click(); return true; },
        hide() {}, stylesheet() {}, removeClass() {}, setStyle() {}, addStyle() {}, prehide() {},
      },
    });
    let grant;
    const pending = instance();
    const guard = guardCookieBannerInstance(pending, () => new Promise(resolve => { grant = resolve; }));
    const action = pending.domActions.click('button', true);
    guard.stop();
    grant(true);
    await assert.rejects(action, /Cookie-banner coverage revoked/);
    assert.equal(clicks, 0, 'a grant already in transit cannot revive a stopped instance');
    assert.deepEqual(await pending.findCmp(), []);
    assert.equal(pending.domActions.hide('banner'), false);

    let covered = true;
    const active = instance();
    elements[0].click = () => { clicks += 1; covered = false; };
    guardCookieBannerInstance(active, async () => covered);
    await assert.rejects(active.domActions.click('button', true), /Cookie-banner coverage revoked/);
    assert.equal(clicks, 1, 'click-all rules recheck coverage for each element');

    const disconnected = instance();
    guardCookieBannerInstance(disconnected, async () => { throw new Error('worker gone'); });
    await assert.rejects(disconnected.domActions.click('button'), /Cookie-banner coverage revoked/);
    assert.equal(clicks, 1, 'loss of background coverage fails closed');

    let resume;
    const direct = instance();
    direct.domActions.wait = () => new Promise(resolve => { resume = resolve; });
    direct.doOptOut = async () => {
      await direct.domActions.wait(500);
      elements[1].click(); // Like Sourcepoint's direct toggles after wait().
      return true;
    };
    const directGuard = guardCookieBannerInstance(direct, async () => true);
    const delayed = direct.doOptOut();
    await until(() => resume, 'the rule to enter its wait');
    directGuard.stop();
    resume(true);
    assert.equal(await delayed, false);
    assert.equal(clicks, 1, 'cancellation unwinds a rule before its direct DOM mutations');
  });

  test(`${build}: 'agent' mode injects only into tabs an Act or Dev run is driving`, async () => {
    const { fake } = setup({ runs: new Map([[1, 'act'], [2, 'ask'], [4, 'dev']]) });
    fake.commit(1, 0, 'https://shop.example/');
    fake.commit(2, 0, 'https://news.example/');
    fake.commit(3, 0, 'https://blog.example/');
    fake.commit(4, 0, 'https://docs.example/');
    await until(() => injections(fake.calls).length === 2, 'two injections');
    await sleep(20);
    const injected = injections(fake.calls);
    assert.deepEqual(injected.map(call => call.target.tabId).sort(), [1, 4]);
    assert.deepEqual(injected[0].files, ['src/content/autoconsent-bridge.js']);
    assert.deepEqual(injected[0].target.frameIds, [0]);
    assert.equal(injected[0].injectImmediately, true);
    assert.equal(injected[0].world, undefined, 'the content half must stay in the isolated world');
  });

  test(`${build}: an engine that rejects injectImmediately still gets the injection`, async () => {
    const fake = fakeApi();
    const attempts = [];
    fake.api.scripting.executeScript = async (details) => {
      attempts.push(details);
      if ('injectImmediately' in details) throw new TypeError('Type error for parameter injection (Unexpected property "injectImmediately")');
      return [{ result: true }];
    };
    const host = createCookieBannerHost(fake.api, { loadRules: async () => rules, loadMode: async () => 'everywhere' });
    host.start();
    fake.commit(13, 0, 'https://example.net/');
    await until(() => attempts.length === 2, 'retry without the option');
    assert.deepEqual(attempts[1].files, attempts[0].files);
    await until(() => host.status(13).frames[0]?.lifecycle === 'injecting', 'frame recorded');
    assert.equal(host.status(13).frames[0].failed, false);
  });

  test(`${build}: Firefox-style extension-root paths are used when asked for`, async () => {
    const { fake } = setup({ mode: 'everywhere', options: { absoluteFilePaths: true } });
    fake.commit(9, 0, 'https://example.org/');
    await until(() => injections(fake.calls).length === 1, 'injection');
    assert.deepEqual(injections(fake.calls)[0].files,
      ['/src/content/autoconsent-bridge.js']);
  });

  test(`${build}: 'everywhere' covers every tab, 'off' none, and the stored mode applies before the first injection`, async () => {
    assert.equal(normalizeCookieBannerMode('everywhere'), 'everywhere');
    assert.equal(normalizeCookieBannerMode('off'), 'off');
    assert.equal(normalizeCookieBannerMode('sometimes'), 'agent');
    assert.equal(normalizeCookieBannerMode(undefined), 'agent');

    const stored = setup({ mode: 'off' });
    stored.fake.commit(5, 0, 'https://example.com/');
    await sleep(30);
    assert.equal(injections(stored.fake.calls).length, 0, "a stored 'off' must hold even for the navigation that woke the worker");

    const { host, fake } = setup({ mode: 'everywhere' });
    fake.commit(5, 0, 'https://example.com/');
    await until(() => injections(fake.calls).length === 1, 'everywhere injection');
    host.setMode('off');
    fake.commit(5, 0, 'https://example.com/next');
    await sleep(30);
    assert.equal(injections(fake.calls).length, 1);
    assert.equal(host.setMode('nonsense'), 'agent');
  });

  test(`${build}: the host reads and follows its own setting in storage`, async () => {
    const fake = fakeApi();
    const storageListeners = [];
    fake.api.storage = {
      local: { get: async key => ({ [key]: 'everywhere' }) },
      onChanged: { addListener: fn => storageListeners.push(fn) },
    };
    const host = createCookieBannerHost(fake.api, { loadRules: async () => rules });
    host.start();
    fake.commit(12, 0, 'https://example.net/');
    await until(() => injections(fake.calls).length === 1, 'injection under the stored setting');
    assert.equal(host.mode, 'everywhere');
    assert.equal(storageListeners.length, 1);
    storageListeners[0]({ cookieBanners: { newValue: 'off' } }, 'sync');
    assert.equal(host.mode, 'everywhere', 'only the local area holds the setting');
    storageListeners[0]({ cookieBanners: { newValue: 'off' } }, 'local');
    assert.equal(host.mode, 'off');
    storageListeners[0]({ cookieBanners: { oldValue: 'off' } }, 'local');
    assert.equal(host.mode, 'agent', 'a cleared setting returns to the default');
  });

  test(`${build}: CAPTCHA and challenge frames are never injected`, async () => {
    const challengeUrls = [
      'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox',
      'https://www.google.com/recaptcha/api2/anchor?k=site',
      'https://www.recaptcha.net/recaptcha/api2/bframe?k=site',
      'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js',
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc',
      'https://shop.example/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1',
      'https://client-api.arkoselabs.com/fc/gc/?token=1',
      'https://geo.captcha-delivery.com/captcha/?initialCid=1',
      // Would pass the Sourcepoint frame test if it were not a challenge host.
      'https://newassets.hcaptcha.com/index.html?message_id=1',
    ];
    for (const url of challengeUrls) assert.equal(isChallengeFrameUrl(url), true, url);
    assert.equal(isChallengeFrameUrl('https://www.google.com/search?q=recaptcha'), false);
    assert.equal(isChallengeFrameUrl('https://example.com/'), false);

    const { fake } = setup({ mode: 'everywhere' });
    challengeUrls.forEach((url, index) => fake.commit(7, index + 1, url));
    fake.commit(8, 0, 'https://accounts.hcaptcha.com/demo');
    await sleep(50);
    assert.equal(injections(fake.calls).length, 0);
  });

  test(`${build}: a subframe is injected only when a rule names its URL`, async () => {
    const { fake } = setup({ mode: 'everywhere' });
    fake.commit(11, 3, 'https://ads.example/frame.html');
    fake.commit(11, 4, 'https://cdn.privacy-mgmt.com/index.html?message_id=123');
    fake.commit(11, 5, 'https://consent.pdf24.org/');
    await until(() => injections(fake.calls).length === 2, 'consent iframe injections');
    await sleep(20);
    assert.deepEqual(injections(fake.calls).map(call => call.target.frameIds[0]).sort(), [4, 5]);

    fake.content(11, 5, 'https://consent.pdf24.org/', { type: 'init', url: 'https://consent.pdf24.org/' });
    await until(() => fake.calls.sent.length === 1, 'subframe initResp');
    const { rules: frameRules } = fake.calls.sent[0].message.msg;
    assert.ok(frameRules.compact.r.length > 0);
    assert.ok(frameRules.compact.r.every(rule => typeof rule[3] === 'string' && rule[3] !== ''),
      'subframes receive only rules that target their URL');
  });

  test(`${build}: init answers with an opt-out config and the frame's rules`, async () => {
    const { fake } = setup({ runs: new Map([[21, 'act'], [22, 'ask']]) });
    fake.commit(21, 0, 'https://shop.example/');
    await until(() => injections(fake.calls).length === 1, 'injection');
    fake.content(21, 0, 'https://shop.example/', { type: 'init', url: 'https://shop.example/' });
    fake.content(22, 0, 'https://news.example/', { type: 'init', url: 'https://news.example/' });
    await until(() => fake.calls.sent.length === 2, 'two initResp');
    const reply = tabId => fake.calls.sent.find(entry => entry.tabId === tabId).message;
    assert.equal(reply(21).type, 'webbrain-autoconsent-bg');
    const { config, rules: topRules } = reply(21).msg;
    assert.equal(reply(21).msg.type, 'initResp');
    assert.equal(config.enabled, true);
    assert.equal(config.autoAction, 'optOut');
    assert.equal(config.heuristicMode, 'reject', "the heuristic may only reject, never accept or dismiss");
    assert.equal(config.enableHeuristicDetection, false);
    assert.equal(config.isMainWorld, false);
    assert.ok(topRules.compact.r.length > 100, 'the top frame gets the generic rules');
    assert.equal(reply(22).msg.config.enabled, false, 'an Ask tab gets a disabled reply');
  });

  test(`${build}: WebBrain's own rules are DOM-only autoconsent rules`, () => {
    // Step keys autoconsent's declarative rules understand, minus `eval`: our
    // rules must not need page-world code.
    const domStepKeys = new Set(['exists', 'visible', 'check', 'waitFor', 'waitForVisible', 'timeout', 'click', 'all',
      'waitForThenClick', 'retry', 'retryInterval', 'wait', 'hide', 'method', 'negated', 'optional', 'any', 'if', 'then', 'else',
      'cookieContains']);
    const domOnly = steps => Array.isArray(steps) && steps.every(step => Object.keys(step).every(key => domStepKeys.has(key))
      && ['any', 'then', 'else'].every(key => !step[key] || domOnly(step[key])) && (!step.if || domOnly([step.if])));
    const bundledNames = new Set(rules.r.map(rule => rule[1]));
    assert.ok(WEBBRAIN_COOKIE_BANNER_RULES.length > 0);
    assert.ok(Object.isFrozen(WEBBRAIN_COOKIE_BANNER_RULES) && Object.isFrozen(WEBBRAIN_COOKIE_BANNER_RULES[0].optOut[0]));
    for (const rule of WEBBRAIN_COOKIE_BANNER_RULES) {
      // The name reaches the model's note, so it must survive cleanCmpName.
      assert.match(rule.name, /^[\w .:-]{1,40}$/);
      assert.doesNotMatch(rule.name, /^auto_/i);
      assert.equal(bundledNames.has(rule.name), false, `${rule.name} must not shadow a bundled rule`);
      for (const key of ['detectCmp', 'detectPopup', 'optIn', 'optOut']) {
        assert.ok(rule[key]?.length && domOnly(rule[key]), `${rule.name}.${key} must be non-empty DOM steps`);
      }
      if (rule.runContext?.urlPattern) assert.doesNotThrow(() => new RegExp(rule.runContext.urlPattern));
    }
  });

  test(`${build}: WebBrain's own rules reach only the frames they target, even without the bundled rules`, async () => {
    const names = list => list.map(rule => rule.name);
    const generic = ['Efilli', 'heuristic-tr'];
    const withSite = site => ['Efilli', site, 'heuristic-tr'];
    assert.deepEqual(names(cookieBannerRulesFor('https://www.hepsiburada.com/', { mainFrame: true })), withSite('hepsiburada'));
    assert.deepEqual(names(cookieBannerRulesFor('https://checkout.hepsiburada.com/sepetim', { mainFrame: true })), withSite('hepsiburada'));
    assert.deepEqual(names(cookieBannerRulesFor('http://www.hepsiburada.com:8123/', { mainFrame: true })), withSite('hepsiburada'));
    assert.deepEqual(names(cookieBannerRulesFor('https://www.n11.com/', { mainFrame: true })), generic);
    assert.deepEqual(names(cookieBannerRulesFor('https://hepsiburada.com.example/', { mainFrame: true })), generic);
    assert.deepEqual(names(cookieBannerRulesFor('https://www.mediamarkt.com.tr/tr/category/telefon.html', { mainFrame: true })),
      withSite('mediamarkt.com.tr'));
    assert.deepEqual(names(cookieBannerRulesFor('https://www.mediamarkt.de/', { mainFrame: true })), generic);
    assert.deepEqual(names(cookieBannerRulesFor('https://www.hepsiburada.com/', { mainFrame: false })), []);

    const { fake } = setup({ mode: 'everywhere' });
    fake.content(101, 0, 'https://www.hepsiburada.com/', { type: 'init' });
    fake.content(102, 0, 'https://www.n11.com/', { type: 'init' });
    fake.content(101, 7, 'https://www.hepsiburada.com/frame.html', { type: 'init' });
    await until(() => fake.calls.sent.length === 3, 'three initResp');
    const reply = (tabId, frameId) => fake.calls.sent.find(entry => entry.tabId === tabId && entry.frameId === frameId).message.msg;
    assert.deepEqual(names(reply(101, 0).rules.autoconsent), withSite('hepsiburada'));
    assert.ok(reply(101, 0).rules.compact.r.length > 100, 'next to the bundled rules');
    assert.deepEqual(names(reply(102, 0).rules.autoconsent), generic);
    assert.equal(reply(101, 7).config.enabled, false, 'a subframe no rule targets is not served');
    assert.deepEqual(reply(101, 7).rules.autoconsent, []);

    const broken = setup({ mode: 'everywhere', options: { loadRules: async () => { throw new Error('missing'); } } });
    broken.fake.content(103, 0, 'https://www.hepsiburada.com/', { type: 'init' });
    await until(() => broken.fake.calls.sent.length === 1, 'initResp without bundled rules');
    const { config, rules: sent } = broken.fake.calls.sent[0].message.msg;
    assert.equal(config.enabled, true);
    assert.deepEqual(names(sent.autoconsent), withSite('hepsiburada'));
    assert.equal(sent.compact, undefined);
  });

  test(`${build}: eval runs only autoconsent's named snippets, in frames the host injected`, async () => {
    const snippetId = Object.keys(evalSnippets)[0];
    const { fake } = setup({ mode: 'everywhere' });
    fake.commit(31, 0, 'https://shop.example/');
    await until(() => injections(fake.calls).length === 1, 'injection');
    const evalReplies = () => fake.calls.sent.filter(entry => entry.message.msg.type === 'evalResp');

    fake.content(31, 0, 'https://shop.example/', { type: 'eval', id: 'a', snippetId, code: 'ignored' });
    await until(() => evalReplies().length === 1, 'first evalResp');
    const mainWorld = fake.calls.execute.filter(call => call.world === 'MAIN');
    assert.equal(mainWorld.length, 1);
    assert.equal(mainWorld[0].func, evalSnippets[snippetId]);
    assert.deepEqual(mainWorld[0].target, { tabId: 31, frameIds: [0] });
    assert.deepEqual(evalReplies()[0].message.msg, { type: 'evalResp', id: 'a', result: 'snippet-result' });

    fake.content(31, 0, 'https://shop.example/', { type: 'eval', id: 'b', snippetId: 'EVAL_NOT_A_SNIPPET', code: 'alert(1)' });
    fake.content(31, 6, 'https://shop.example/frame', { type: 'eval', id: 'c', snippetId });
    fake.content(31, 0, 'https://newassets.hcaptcha.com/x', { type: 'eval', id: 'd', snippetId });
    await until(() => evalReplies().length === 4, 'refused evalResp');
    assert.equal(fake.calls.execute.filter(call => call.world === 'MAIN').length, 1, 'refused evals never reach the page');
    for (const id of ['b', 'c', 'd']) {
      assert.equal(evalReplies().find(entry => entry.message.msg.id === id).message.msg.result, false, id);
    }
  });

  test(`${build}: page messages, other types and page-originated status requests are ignored`, async () => {
    const { fake } = setup({ mode: 'everywhere' });
    fake.content(41, 0, 'https://example.com/', { type: 'init' });
    await until(() => fake.calls.sent.length === 1, 'initResp');
    // No sender tab: not from a content script.
    fake.content(undefined, 0, 'https://example.com/', { type: 'init' });
    await sleep(20);
    assert.equal(fake.calls.sent.length, 1);
    assert.equal(fake.status(41, 'https://example.com/'), undefined, 'pages cannot read the status');
    const status = fake.status(41, 'chrome-extension://webbrain/src/ui/settings.html');
    assert.equal(status.mode, 'everywhere');
    assert.equal(status.frames.length, 1);
  });

  test(`${build}: a turn waits for a decline in progress and reports it once`, async () => {
    const { host, fake } = setup({ runs: new Map([[51, 'act']]) });
    fake.setFrames([{ frameId: 0, url: 'https://shop.example/' }]);
    const turn = host.prepareTurn(51);
    await until(() => injections(fake.calls).length === 1, 'injection of the already-open page');
    const url = 'https://shop.example/';
    fake.content(51, 0, url, { type: 'init', url });
    fake.content(51, 0, url, { type: 'report', state: { lifecycle: 'started' } });
    fake.content(51, 0, url, { type: 'cmpDetected', cmp: 'Cookiebot', url });
    let settled = false;
    turn.then(() => { settled = true; });
    await sleep(60);
    assert.equal(settled, false, 'a detected banner holds the turn');
    fake.content(51, 0, url, { type: 'popupFound', cmp: 'Cookiebot', url });
    fake.content(51, 0, url, { type: 'optOutResult', cmp: 'Cookiebot', result: true, url });
    fake.content(51, 0, url, { type: 'autoconsentDone', cmp: 'Cookiebot', isCosmetic: false, url });
    assert.deepEqual(await turn, [{ cmp: 'Cookiebot', cosmetic: false }]);
    assert.deepEqual(await host.prepareTurn(51), [], 'a decline is reported once');
  });

  test(`${build}: a quiet page settles soon after its DOM is ready, and a stuck one at the cap`, async () => {
    const { host, fake } = setup({ runs: new Map([[61, 'act']]) });
    fake.setFrames([{ frameId: 0, url: 'https://quiet.example/' }]);
    const started = Date.now();
    const turn = host.prepareTurn(61);
    await until(() => injections(fake.calls).length === 1, 'injection');
    fake.content(61, 0, 'https://quiet.example/', { type: 'init' });
    fake.content(61, 0, 'https://quiet.example/', { type: 'report', state: { lifecycle: 'started' } });
    assert.deepEqual(await turn, []);
    const quietMs = Date.now() - started;
    assert.ok(quietMs < 1700, `quiet already-open page settled in ${quietMs} ms`);

    fake.content(61, 0, 'https://quiet.example/', { type: 'cmpDetected', cmp: 'Stuck' });
    const capStart = Date.now();
    assert.deepEqual(await host.prepareTurn(61, { maxWaitMs: 150 }), []);
    const capMs = Date.now() - capStart;
    assert.ok(capMs >= 140 && capMs < 600, `stuck banner released after ${capMs} ms`);
  });

  test(`${build}: a decline that never finishes holds one turn at most`, async () => {
    let clock = 1_000_000;
    const { host, fake } = setup({ runs: new Map([[91, 'act']]), options: { now: () => clock } });
    fake.setFrames([{ frameId: 0, url: 'https://stuck.example/' }]);
    const first = host.prepareTurn(91);
    await until(() => injections(fake.calls).length === 1, 'injection');
    fake.content(91, 0, 'https://stuck.example/', { type: 'init' });
    fake.content(91, 0, 'https://stuck.example/', { type: 'cmpDetected', cmp: 'Removed' });
    setTimeout(() => { clock += 5000; }, 40);
    assert.deepEqual(await first, []);
    const started = Date.now();
    assert.deepEqual(await host.prepareTurn(91), []);
    assert.ok(Date.now() - started < 100, 'the next turn does not wait for it again');
  });

  test(`${build}: a consent tool with no banner showing holds a turn only briefly`, async () => {
    let clock = 2_000_000;
    const { host, fake } = setup({ runs: new Map([[111, 'act'], [112, 'act']]), options: { now: () => clock } });
    const turnFor = async (tabId, url, popup) => {
      fake.setFrames([{ frameId: 0, url }]);
      const turn = host.prepareTurn(tabId);
      await until(() => injections(fake.calls).some(call => call.target.tabId === tabId), `injection into ${tabId}`);
      fake.content(tabId, 0, url, { type: 'init' });
      fake.content(tabId, 0, url, { type: 'report', state: { lifecycle: 'started' } });
      fake.content(tabId, 0, url, { type: 'cmpDetected', cmp: 'OneTrust', url });
      if (popup) fake.content(tabId, 0, url, { type: 'popupFound', cmp: 'OneTrust', url });
      const state = { settled: false };
      turn.then(() => { state.settled = true; });
      return state;
    };

    // Already answered: the tool is in the page, but no banner shows.
    const answered = await turnFor(111, 'https://answered.example/', false);
    clock += 1000;
    await sleep(150);
    assert.equal(answered.settled, false, 'a banner may still show within the grace period');
    clock += 600;
    await until(() => answered.settled, 'the grace period to end');

    // Showing: the decline gets the full handling time.
    const showing = await turnFor(112, 'https://showing.example/', true);
    clock += 1600;
    await sleep(150);
    assert.equal(showing.settled, false, 'a showing banner is waited for past the grace period');
    clock += 2500;
    await until(() => showing.settled, 'the handling cap');
  });

  test(`${build}: a report that several rules matched does not end the wait for the decline`, async () => {
    const { host, fake } = setup({ runs: new Map([[121, 'act']]) });
    const url = 'https://both.example/';
    fake.setFrames([{ frameId: 0, url }]);
    const turn = host.prepareTurn(121);
    await until(() => injections(fake.calls).length === 1, 'injection');
    fake.content(121, 0, url, { type: 'init' });
    fake.content(121, 0, url, { type: 'report', state: { lifecycle: 'started' } });
    fake.content(121, 0, url, { type: 'cmpDetected', cmp: 'Onetrust', url });
    fake.content(121, 0, url, { type: 'cmpDetected', cmp: 'heuristic-tr', url });
    fake.content(121, 0, url, { type: 'popupFound', cmp: 'Onetrust', url });
    fake.content(121, 0, url, { type: 'autoconsentError', details: { msg: 'Found multiple CMPs, check the detection rules.' } });
    let settled = false;
    turn.then(() => { settled = true; });
    await sleep(60);
    assert.equal(settled, false, 'the decline that started is still waited for');
    fake.content(121, 0, url, { type: 'optOutResult', cmp: 'Onetrust', result: true, url });
    fake.content(121, 0, url, { type: 'autoconsentDone', cmp: 'Onetrust', isCosmetic: false, url });
    assert.deepEqual(await turn, [{ cmp: 'Onetrust', cosmetic: false }]);
  });

  test(`${build}: a frame whose run ended before init is not waited for`, async () => {
    const runs = new Map([[95, 'act']]);
    const { host, fake } = setup({ runs });
    fake.commit(95, 0, 'https://late.example/');
    await until(() => injections(fake.calls).length === 1, 'injection');
    runs.set(95, 'ask');
    fake.content(95, 0, 'https://late.example/', { type: 'init' });
    await until(() => fake.calls.sent.length === 1, 'disabled initResp');
    assert.equal(fake.calls.sent[0].message.msg.config.enabled, false);
    assert.equal(host.status(95).frames[0].failed, true);
  });

  test(`${build}: nothing is looked up when the tab is not covered`, async () => {
    const { host, fake } = setup({ runs: new Map([[71, 'ask']]) });
    assert.deepEqual(await host.prepareTurn(71), []);
    assert.deepEqual(await host.prepareTurn(72), []);
    assert.equal(fake.calls.frameLookups, 0);
    const off = setup({ mode: 'off', runs: new Map([[73, 'act']]) });
    assert.deepEqual(await off.host.prepareTurn(73), []);
    assert.equal(off.fake.calls.frameLookups, 0);
  });

  test(`${build}: the agent note names the rule, never page text, and is pushed only when needed`, async () => {
    assert.equal(cookieBannerNoteText([]), '');
    assert.match(cookieBannerNoteText([{ cmp: 'Cookiebot', cosmetic: false }]), /declined the Cookiebot cookie banner/);
    assert.match(cookieBannerNoteText([{ cmp: '', cosmetic: true }]), /hid a cookie banner/);
    const messages = [{ role: 'user', content: 'Book a table' }];
    assert.equal(await settleCookieBannersForTurn({ prepareTurn: async () => [] }, 1, messages), false);
    assert.equal(await settleCookieBannersForTurn({ prepareTurn: async () => { throw new Error('gone'); } }, 1, messages), false);
    assert.equal(await settleCookieBannersForTurn(null, 1, messages), false);
    assert.equal(messages.length, 1);
    assert.equal(await settleCookieBannersForTurn({ prepareTurn: async () => [{ cmp: 'OneTrust', cosmetic: false }] }, 1, messages), true);
    assert.deepEqual(Object.keys(messages[1]).sort(), ['content', 'role']);
    assert.equal(messages[1].role, 'user');
    assert.match(messages[1].content, /^\[Cookie banners: WebBrain automatically declined the OneTrust cookie banner/);
  });

  test(`${build}: generated rule and heuristic names stay out of the note`, async () => {
    const { host, fake } = setup({ runs: new Map([[81, 'act'], [82, 'act'], [83, 'act']]) });
    for (const [tabId, cmp, cosmetic] of [[81, 'auto_GB_example.co.uk_x1', true], [82, 'HEURISTIC-REJECT', false], [83, 'heuristic-tr', false]]) {
      fake.setFrames([{ frameId: 0, url: 'https://example.co.uk/' }]);
      const turn = host.prepareTurn(tabId);
      await until(() => injections(fake.calls).some(call => call.target.tabId === tabId), `injection into ${tabId}`);
      fake.content(tabId, 0, 'https://example.co.uk/', { type: 'init' });
      fake.content(tabId, 0, 'https://example.co.uk/', { type: 'autoconsentDone', cmp, isCosmetic: cosmetic });
      assert.deepEqual(await turn, [{ cmp: '', cosmetic }], cmp);
    }
    assert.match(cookieBannerNoteText([{ cmp: '', cosmetic: false }]), /declined a cookie banner/);
  });

  test(`${build}: the agent, background and settings are wired`, async () => {
    const agent = await read(`src/${build}/src/agent/agent.js`);
    assert.equal(agent.split('await settleCookieBannersForTurn(this._cookieBannerHost, tabId, messages);').length - 1, 3,
      'both run loops and the tool-batch screenshot path settle cookie banners');
    assert.match(agent, /setCookieBannerHost\(host\) \{/);
    const background = await read(`src/${build}/src/background.js`);
    assert.match(background, /createCookieBannerHost\(/);
    assert.match(background, /cookieBannerHost\.start\(\);/);
    assert.match(background, /agent\.setCookieBannerHost\(cookieBannerHost\);/);
    // The host watches its own setting; the shared settings listener, which
    // other tests evaluate in isolation, must not depend on it.
    assert.equal(/COOKIE_BANNER_SETTING_KEY|cookieBannerHost\.setMode/.test(background), false);
    assert.equal(/absoluteFilePaths: true/.test(background), build === 'firefox');
    const manifest = JSON.parse(await read(`src/${build}/manifest.json`));
    const declared = JSON.stringify(manifest.content_scripts || []);
    assert.equal(/autoconsent/.test(declared), false, 'autoconsent must not be a static content script');
    const html = await read(`src/${build}/src/ui/settings.html`);
    const select = html.match(/<select id="select-cookie-banners"[\s\S]*?<\/select>/)?.[0] || '';
    assert.deepEqual([...select.matchAll(/value="(\w+)"/g)].map(match => match[1]), ['agent', 'everywhere', 'off']);
    const settingsScript = await read(`src/${build}/src/ui/settings.js`);
    assert.match(settingsScript, /storage\.local\.set\(\{ cookieBanners:/);
  });

  test(`${build}: every interface locale has the cookie-banner setting`, async () => {
    const codes = ['ar', 'bn', 'de', 'en', 'es', 'fa', 'fr', 'he', 'hi', 'id', 'ja', 'ko', 'ms', 'nl', 'pl', 'pt', 'ru', 'th', 'tl', 'tr', 'uk', 'vi', 'zh'];
    for (const code of codes) {
      const dict = (await import(`../src/${build}/src/ui/locales/${code}.js`)).default;
      for (const key of ['label', 'desc', 'agent', 'everywhere', 'off']) {
        assert.equal(typeof dict[`st.display.cookie_banners.${key}`], 'string', `${code} ${key}`);
      }
    }
  });
}

test('the vendored autoconsent patch is reproducible and the glue matches across browsers', async () => {
  assert.deepEqual(checkVendoredAutoconsent(), []);
  for (const file of ['src/agent/cookie-banner-host.js', 'src/agent/cookie-banner-rules.js', 'src/agent/cookie-banner-turn.js',
    'src/content/autoconsent-bridge.js', 'src/content/autoconsent-runtime.js']) {
    assert.equal(await read(`src/chrome/${file}`), await read(`src/firefox/${file}`), file);
  }
});

test('autoconsent acknowledgement regex rejects repeated cookie phrases without exponential backtracking', async () => {
  for (const browser of BUILDS) {
    for (const file of ['autoconsent.esm.js', 'autoconsent.playwright.js']) {
      const source = await read(`src/${browser}/vendor/autoconsent/${file}`);
      const expression = source.split('\n').find(line => line.includes('(close|dismiss|schlie')).trim().replace(/,$/, '');
      const pattern = runInNewContext(expression);
      for (const label of ['close', 'close de cookies', 'close des cookies', 'Fermer le bandeau', 'close this dialog.', 'cerrar el banner']) {
        assert.equal(pattern.test(label), true, `${browser}/${file}: ${label}`);
      }
      for (const label of ['accept and close', 'agree and close', 'close marketing settings!']) assert.equal(pattern.test(label), false);
      // An unpatched bundle hangs on this input. Keep it in a bounded child
      // process so a regression cannot freeze the test runner itself.
      execFileSync(process.execPath, ['--eval', `const pattern = ${expression};
        if (pattern.test('close ' + 'de cookies '.repeat(2000) + '!')) process.exit(1);`], { timeout: 1500 });
    }
  }
});
