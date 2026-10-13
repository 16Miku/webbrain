// Delivery regression (C9): the agent's own hover may lift or resize the exact
// certified native BUTTON between the pointer move and the press. The press
// must use the button's verified current centre (never stale coordinates) and
// any other change must still refuse before dispatch.
//
// [real DOM, Chromium only: the trusted native-button path is Chrome CDP]
// The real Agent, page-feedback run, page monitor, accessibility tree and
// content script run unchanged; only the extension transport and debugger
// session are bridged to Playwright.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
let page, session, commandHook = null;
const commands = [];
const requests = new Set();
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: p => pathToFileURL(path.join(root, 'src/chrome', p)).href },
  tabs: {
    get: async () => ({ id: 17, url: page.url() }),
    query: async () => [{ id: 17, url: page.url() }],
    sendMessage: (_id, message) => page.evaluate(message => window.qaMessage(message), message),
  },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'delivery-native-document', url: page.url() }] },
  webRequest: { onBeforeRequest: { addListener: l => requests.add(l), removeListener: l => requests.delete(l) } },
  debugger: { sendCommand: (_target, method, params, callback) => {
    commands.push({ method, type: params.type, x: params.x, y: params.y });
    Promise.resolve().then(() => commandHook?.(method, params))
      .then(() => session.send(method, params)).then(callback, error => {
        api.runtime.lastError = { message: error.message };
        callback(); delete api.runtime.lastError;
      });
  } },
};
globalThis.chrome = api;
globalThis.browser = api;
const { Agent } = await import('../src/chrome/src/agent/agent.js');

const html = ({ css = '', script = '' } = {}) => `<!doctype html><style>
body{margin:20px} #commit{width:200px;height:45px} ${css}</style>
<main><h1>Current record settings</h1><button id="commit" type="button">Apply settings</button>
<label>Record title<input value="Owned neutral draft"></label><output id="result">0</output></main>
<script>window.qaClicks=[];
commit.addEventListener('click',event=>{qaClicks.push({trusted:event.isTrusted,x:event.clientX,y:event.clientY});
if(event.isTrusted){result.textContent=String(qaClicks.length);commit.setAttribute('aria-pressed',String(qaClicks.length%2===1));}});
${script}</script>`;

async function fixture(browserInstance, options) {
  const context = await browserInstance.newContext({ viewport: { width: 900, height: 700 } });
  await context.route('**/*', route => route.request().url().startsWith('https://delivery-native.invalid/')
    ? route.fulfill({ contentType: 'text/html', body: html(options) }) : route.abort());
  page = await context.newPage();
  const agent = new Agent({ getActive: () => ({ model: 'delivery-model' }) });
  agent._runningTabs.add(17);
  await page.exposeFunction('qaBackground', message => {
    const sender = { tab: { id: 17 }, frameId: 0, documentId: 'delivery-native-document', url: page.url() };
    if (message.action === 'get_page_monitor_state') return agent.pageMonitorState(sender, message.documentToken);
    if (message.action === 'page_feedback') return agent.observePageFeedback(sender, message.feedback);
    return {};
  });
  await page.addInitScript(() => {
    window.qaListeners = [];
    window.chrome = window.browser = { runtime: {
      getURL: p => p,
      onMessage: { addListener: f => qaListeners.push(f), removeListener() {} },
      sendMessage: message => window.qaBackground(message),
    } };
    window.qaMessage = message => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const f of qaListeners) { const value = f(message, {}, respond); if (answered || value === true) return; }
      resolve(undefined);
    });
  });
  for (const name of ['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
    await page.addInitScript({ content: await readFile(path.join(root, 'src/chrome/src/content', name), 'utf8') });
  }
  await page.goto('https://delivery-native.invalid/current');
  session = await context.newCDPSession(page);
  await agent._beginPageFeedbackRun(17, 'neutral');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.mouse.move(5, 690);
  await page.waitForTimeout(180);
  const run = agent._pageFeedbackRuns.get(17);
  run.events.clear();
  const axScope = await api.tabs.sendMessage(17, { target: 'content', action: 'get_accessibility_tree', params: { filter: 'visible', maxChars: 12000 } });
  const capture = await api.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_capture_model',
    params: { runToken: run.token, includeTree: true } });
  const ref = capture.page.pageContent.match(/button "Apply settings" \[(ref_[A-Za-z0-9_-]+)\]/)?.[1];
  assert.ok(ref, capture.page.pageContent);
  const state = { token: run.token, url: run.url, steeringRevision: 0, frames: new Map(run.frames),
    actionBinding: { snapshotToken: capture.snapshotToken, runToken: run.token, documentToken: capture.documentToken } };
  run.modelState = state;
  run.dispatchCall = { name: 'click_ax', args: { ref_id: ref }, expectedModelSnapshot: capture.snapshotToken,
    modelState: state, dispatchState: { started: false }, allowPassiveRebase: true };
  const prepared = await api.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_prepare',
    params: { runToken: run.token, tool: 'click_ax', ref_id: ref, operationId: 'delivery-owned-operation',
      expectedModelSnapshot: capture.snapshotToken, allowPassiveRebase: true } });
  assert.equal(prepared.modelBindingValid, true);
  commands.length = 0; commandHook = null;
  agent._settleContentFilePickerGuard = async (_id, result) => result;
  agent._annotateClickProgress = async (_id, _name, _args, result) => result;
  agent._recordInteractionRect = () => {};
  agent._clearUploadSelectorRecoveryAfterInspection = () => {};
  agent._lastAxScopes.set(17, { documentToken: axScope.documentToken, pageUrl: axScope.refScopeUrl });
  return { context, agent, ref };
}

const presses = () => commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed');
const moves = () => commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mouseMoved');

test('Chrome: the agent\'s own hover may move the certified native button, never onto another node', { timeout: 240000 }, async t => {
  const cdpAttach = cdpClient.attach;
  cdpClient.attach = async () => cdpClient.sessions.set(17, {});
  const browserInstance = await chromium.launch({ headless: true });
  try {
    for (const [name, css] of [
      ['an instant hover lift', '#commit:hover { transform: translateY(-3px); }'],
      ['a hover border width', '#commit { width: auto; height: auto; border: 1px solid #333; } #commit:hover { border-width: 4px; }'],
    ]) await t.test(`${name}: one trusted click at the verified current centre`, async () => {
      const f = await fixture(browserInstance, { css });
      try {
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        const clicks = await page.evaluate(() => window.qaClicks);
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.initialTrustedNativeButton, true);
        assert.deepEqual(clicks.map(click => click.trusted), [true], 'exactly one trusted activation');
        assert.equal(presses().length, 1);
        const box = await page.locator('#commit').boundingBox();
        const centre = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
        assert.deepEqual({ x: presses()[0].x, y: presses()[0].y }, centre, 'the press used the hovered button\'s current centre');
        assert.notDeepEqual({ x: moves()[0].x, y: moves()[0].y }, centre, 'the hover itself moved the button');
      } finally { await f.context.close(); }
    });

    await t.test('an unmoved button keeps its single trusted click', async () => {
      const f = await fixture(browserInstance, {});
      try {
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        assert.equal(result.success, true);
        assert.deepEqual((await page.evaluate(() => window.qaClicks)).map(click => click.trusted), [true]);
        assert.equal(presses().length, 1);
      } finally { await f.context.close(); }
    });

    for (const [name, options] of [
      ['a hover-revealed overlay covering the button', {
        css: '#cover{position:absolute;display:none;left:10px;top:60px;width:400px;height:120px;background:#fff;z-index:5} main:hover ~ #cover{display:block}',
        script: "const cover=document.createElement('div');cover.id='cover';document.body.append(cover);",
      }],
      ['a hover move that puts another node over the new centre', {
        css: '#commit:hover{transform:translateY(-3px)} #shield{position:absolute;display:none;z-index:5;background:#eee} main:hover ~ #shield{display:block}',
        script: "const shield=document.createElement('div');shield.id='shield';const r=commit.getBoundingClientRect();"
          + "Object.assign(shield.style,{left:r.left+'px',top:(r.top-3)+'px',width:r.width+'px',height:(r.height/2+2)+'px'});document.body.append(shield);",
      }],
      ['a hover that replaces the button node', {
        script: "commit.addEventListener('mouseover',()=>{const next=commit.cloneNode(true);next.id='commit';commit.replaceWith(next);},{once:true});",
      }],
    ]) await t.test(`${name} refuses before any press`, async () => {
      const f = await fixture(browserInstance, options);
      try {
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        assert.equal(result.success, false);
        assert.equal(result.noDispatch, true, JSON.stringify(result));
        assert.equal(presses().length, 0, 'no press was sent');
        assert.deepEqual(await page.evaluate(() => window.qaClicks), []);
      } finally { await f.context.close(); }
    });
  } finally {
    cdpClient.attach = cdpAttach;
    await browserInstance.close();
  }
});
