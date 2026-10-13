// Delivery regression (C1): a click_ax content message whose response is lost
// after the content script already ran el.click() must never be re-sent.
//
// Real-DOM fixture: the real Chrome/Firefox Agent dispatches click_ax through
// the real accessibility-tree.js + page-monitor.js + content.js of the same
// build, loaded into a Playwright page of the matching engine (Chromium for
// the Chrome build, Firefox for the Firefox build). Only the extension
// messaging transport is bridged: it can deliver the message to the page and
// then report the browser's lost-response or missing-receiver error.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, getManifest: () => ({ version: 'test' }) },
  tabs: { get: async () => ({ id: 17, url: 'https://delivery.test/start' }), query: async () => [] },
  scripting: { executeScript: async () => [{}] },
};
globalThis.chrome = api;
globalThis.browser = api;
const builds = {
  chrome: { Agent: (await import('../src/chrome/src/agent/agent.js')).Agent, engine: chromium },
  firefox: { Agent: (await import('../src/firefox/src/agent/agent.js')).Agent, engine: firefox },
};

// Exact browser error texts. Chrome reports a closed response channel when
// the listener answered asynchronously and its document went away; Firefox
// reports the conduit teardown. Neither proves that no click was delivered.
const LOST_RESPONSE = {
  chrome: 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received',
  firefox: "Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved",
};
const MISSING_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

const html = `<!doctype html><main><h1>Cart</h1>
<button id="add" type="button">Add to cart</button><output id="count">0</output></main>
<script>window.qaClicks = 0; add.addEventListener('click', () => { count.textContent = String(++window.qaClicks); });</script>`;

async function fixture(browserInstance, build) {
  const context = await browserInstance.newContext({ viewport: { width: 900, height: 600 } });
  await context.route('https://delivery.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(() => {
    window.qaListeners = [];
    const runtime = {
      onMessage: { addListener: fn => qaListeners.push(fn), removeListener: fn => {
        const index = qaListeners.indexOf(fn); if (index >= 0) qaListeners.splice(index, 1);
      } },
      getURL: value => value,
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: false };
        return {};
      },
    };
    window.chrome = { runtime }; window.browser = window.chrome;
    // Like the browser runtime, every listener in the content world receives
    // the message; the first sendResponse answers it.
    window.qaMessage = message => new Promise(resolve => {
      let answered = false, pending = false;
      const respond = value => { if (!answered) { answered = true; resolve(value); } };
      for (const listener of [...qaListeners]) {
        if (listener(message, {}, respond) === true) pending = true;
      }
      if (!answered && !pending) resolve(undefined);
    });
  });
  for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
    const source = fs.readFileSync(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8');
    await context.addInitScript({ content: source });
  }
  const page = await context.newPage();
  await page.goto('https://delivery.test/start');
  await page.waitForFunction(() => typeof window.__wb_ax_ref === 'function' && window.qaListeners.length > 0);
  const ref = await page.evaluate(() => {
    window.__generateAccessibilityTree?.('all', 15, 6000);
    return window.__wb_ax_ref(document.getElementById('add'));
  });
  assert.match(ref, /^ref_\d+$/);
  return { context, page, ref };
}

function agentFor(build, Agent) {
  const agent = new Agent({ getActive: () => ({ model: 'delivery-test' }) });
  // Observation helpers are not under test here; keep them read-only and local.
  agent._clickProgressSnapshot = async () => '';
  agent._maybeFallbackClickAxWithCdp = async (_tab, _args, response) => response;
  if (build === 'chrome') agent._captureClickAxObservation = async () => ({ startedAt: Date.now(), snapshot: '' });
  agent.injections = 0;
  agent._injectCoreContentScripts = async () => { agent.injections++; };
  return agent;
}

function bridge(page, messages, { failClickAx = [] } = {}) {
  let clickAxSends = 0;
  api.tabs.sendMessage = async (_tabId, message) => {
    messages.push(message.action);
    if (message.action !== 'click_ax') return page.evaluate(m => window.qaMessage(m), message);
    const failure = failClickAx[clickAxSends++];
    if (failure === 'missing-receiver') throw new Error(MISSING_RECEIVER);
    const response = await page.evaluate(m => window.qaMessage(m), message);
    if (failure === 'lost-response') throw new Error(LOST_RESPONSE[page.qaBuild]);
    return response;
  };
}

for (const [build, { Agent, engine }] of Object.entries(builds)) {
  test(`${build}: click_ax response loss after delivery is reported uncertain and never re-sent`, async t => {
    const browserInstance = await engine.launch({ headless: true });
    try {
      await t.test('lost response after the content script clicked: one page click, outcome unknown', async () => {
        const { context, page, ref } = await fixture(browserInstance, build);
        try {
          page.qaBuild = build;
          const messages = [];
          bridge(page, messages, { failClickAx: ['lost-response'] });
          const agent = agentFor(build, Agent);
          const state = { started: false };
          const result = await agent._dispatchClickAx(17, { ref_id: ref }, null, null, {}, null, state, null);
          assert.equal(await page.evaluate(() => window.qaClicks), 1, 'the delivered click must not be repeated');
          assert.equal(messages.filter(action => action === 'click_ax').length, 1);
          assert.equal(agent.injections, 0, 'a lost response is not a missing receiver; nothing is re-injected');
          assert.equal(state.started, true, 'the delivered click keeps its dispatch state');
          assert.equal(result.success, false);
          assert.equal(result.dispatched, true);
          assert.notEqual(result.noDispatch, true);
          assert.equal(result.outcomeUnknown, true);
          assert.equal(result.retryable, false);
        } finally { await context.close(); }
      });

      await t.test('explicit missing receiver: inject once and deliver exactly one click', async () => {
        const { context, page, ref } = await fixture(browserInstance, build);
        try {
          page.qaBuild = build;
          const messages = [];
          bridge(page, messages, { failClickAx: ['missing-receiver'] });
          const agent = agentFor(build, Agent);
          const state = { started: false };
          const result = await agent._dispatchClickAx(17, { ref_id: ref }, null, null, {}, null, state, null);
          assert.equal(agent.injections, 1);
          assert.equal(messages.filter(action => action === 'click_ax').length, 2);
          assert.equal(await page.evaluate(() => window.qaClicks), 1);
          assert.equal(result.success, true);
          assert.equal(state.started, true);
        } finally { await context.close(); }
      });

      await t.test('missing receiver on both attempts reports an undispatched click', async () => {
        const { context, page, ref } = await fixture(browserInstance, build);
        try {
          page.qaBuild = build;
          const messages = [];
          bridge(page, messages, { failClickAx: ['missing-receiver', 'missing-receiver'] });
          const agent = agentFor(build, Agent);
          const state = { started: false };
          const result = await agent._dispatchClickAx(17, { ref_id: ref }, null, null, {}, null, state, null);
          assert.equal(await page.evaluate(() => window.qaClicks), 0);
          assert.equal(result.success, false);
          assert.equal(result.dispatched, false);
          assert.equal(result.noDispatch, true);
          assert.equal(state.started, false);
        } finally { await context.close(); }
      });

      await t.test('normal click: one message, one page click, success', async () => {
        const { context, page, ref } = await fixture(browserInstance, build);
        try {
          page.qaBuild = build;
          const messages = [];
          bridge(page, messages);
          const agent = agentFor(build, Agent);
          const result = await agent._dispatchClickAx(17, { ref_id: ref }, null, null, {}, null, { started: false }, null);
          assert.equal(result.success, true);
          assert.equal(messages.filter(action => action === 'click_ax').length, 1);
          assert.equal(await page.evaluate(() => window.qaClicks), 1);
          assert.equal(agent.injections, 0);
        } finally { await context.close(); }
      });
    } finally {
      await browserInstance.close();
    }
  });

  test(`${build}: Stop while a click_ax message is in flight keeps its dispatch state`, async () => {
    const agent = agentFor(build, Agent);
    const controller = new AbortController();
    let sent = 0;
    api.tabs.sendMessage = async (_tabId, message) => {
      if (message.action !== 'click_ax') return {};
      sent++;
      // The content script received the click; Stop arrives before its reply
      // and the document then drops the response channel.
      controller.abort(Object.assign(new Error('Stopped by user'), { name: 'AbortError' }));
      throw new Error(LOST_RESPONSE[build]);
    };
    const state = { started: false };
    await assert.rejects(
      agent._dispatchClickAx(17, { ref_id: 'ref_1' }, null, null, {}, controller.signal, state, null),
      error => error?.name === 'AbortError',
    );
    assert.equal(sent, 1);
    assert.equal(agent.injections, 0, 'cancellation is not a missing receiver');
    assert.equal(state.started, true, 'the lifecycle wrapper reports a cancelled delivered click as uncertain');
  });
}
