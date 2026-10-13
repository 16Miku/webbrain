// Delivery regression: the agent's own hover over a certified native BUTTON
// can start a CSS transition or a script-driven hover animation. The press
// must wait, without sending any input, until the exact target's geometry is
// stable (bounded), and is then sent once at the settled, re-verified centre.
// Every other change during that wait still refuses before any press.
//
// [real DOM, Chromium only: the trusted native-button path is Chrome CDP]
// The real Agent, page-feedback run, page monitor, accessibility tree and
// content script run unchanged; only the extension transport and debugger
// session are bridged to Playwright. Interventions are timed from the agent's
// own pointer move, so they land while the hover is still settling.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
let page, session;
const hooks = { afterHover: null };
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
  webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'delivery-hover-document', url: page.url() }] },
  webRequest: { onBeforeRequest: { addListener: l => requests.add(l), removeListener: l => requests.delete(l) } },
  debugger: { sendCommand: (_target, method, params, callback) => {
    commands.push({ method, type: params.type, x: params.x, y: params.y });
    session.send(method, params).then(result => {
      // The agent's own hover (pointer move without a button) was delivered.
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.buttons === 0 && hooks.afterHover) {
        const intervene = hooks.afterHover; hooks.afterHover = null;
        setTimeout(() => { void intervene(); }, 90);
      }
      return result;
    }).then(callback, error => {
      api.runtime.lastError = { message: error.message };
      try { callback(); } finally { delete api.runtime.lastError; }
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
<script>window.qaClicks=[];window.qaPressRects=[];window.qaPressColors=[];
const qaRect=()=>{const r=document.getElementById('commit').getBoundingClientRect();return [r.left,r.top,r.width,r.height];};
document.addEventListener('mousedown',event=>{if(!event.isTrusted)return;qaPressRects.push(qaRect());
qaPressColors.push(getComputedStyle(document.getElementById('commit')).backgroundColor);},true);
commit.addEventListener('click',event=>{qaClicks.push({trusted:event.isTrusted,x:event.clientX,y:event.clientY});
if(event.isTrusted){result.textContent=String(qaClicks.length);commit.setAttribute('aria-pressed',String(qaClicks.length%2===1));}});
${script}</script>`;

async function fixture(browserInstance, options) {
  const context = await browserInstance.newContext({ viewport: { width: 900, height: 700 } });
  await context.route('**/*', route => route.request().url().startsWith('https://delivery-hover.invalid/')
    ? route.fulfill({ contentType: 'text/html', body: html(options) }) : route.abort());
  page = await context.newPage();
  const agent = new Agent({ getActive: () => ({ model: 'delivery-model' }) });
  agent._runningTabs.add(17);
  await page.exposeFunction('qaBackground', message => {
    const sender = { tab: { id: 17 }, frameId: 0, documentId: 'delivery-hover-document', url: page.url() };
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
  await page.goto('https://delivery-hover.invalid/current');
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
    params: { runToken: run.token, tool: 'click_ax', ref_id: ref, operationId: 'delivery-hover-operation',
      expectedModelSnapshot: capture.snapshotToken, allowPassiveRebase: true } });
  assert.equal(prepared.modelBindingValid, true);
  commands.length = 0; hooks.afterHover = null;
  agent._settleContentFilePickerGuard = async (_id, result) => result;
  agent._annotateClickProgress = async (_id, _name, _args, result) => result;
  agent._recordInteractionRect = () => {};
  agent._clearUploadSelectorRecoveryAfterInspection = () => {};
  agent._lastAxScopes.set(17, { documentToken: axScope.documentToken, pageUrl: axScope.refScopeUrl });
  const before = await page.locator('#commit').boundingBox();
  return { context, agent, ref, before };
}

const presses = () => commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed');
const hovers = () => commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mouseMoved');
const centre = box => ({ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });

test('Chrome: a certified native button is pressed once after the agent\'s own hover settles', { timeout: 300000 }, async t => {
  const cdpAttach = cdpClient.attach;
  cdpClient.attach = async () => cdpClient.sessions.set(17, {});
  const browserInstance = await chromium.launch({ headless: true });
  try {
    for (const [name, options, moved, check] of [
      ['a transition lift (translateY + scale over 200 ms)', {
        css: '#commit{transition:transform .2s ease} #commit:hover{transform:translateY(-2px) scale(1.03)}',
      }, true],
      ['a box-shadow and border-width transition', {
        css: '#commit{width:auto;height:auto;border:1px solid #333;transition:border-width .2s,box-shadow .2s}'
          + ' #commit:hover{border-width:4px;box-shadow:0 4px 12px rgba(0,0,0,.3)}',
      }, true],
      ['a script-driven hover animation that settles', {
        script: "commit.addEventListener('mouseenter',()=>{const start=performance.now();"
          + "const step=now=>{const p=Math.min(1,(now-start)/180);commit.style.transform='translateY('+(-3*p)+'px)';if(p<1)requestAnimationFrame(step);};"
          + 'requestAnimationFrame(step);},{once:true});',
      }, true],
      // Two samples inside the delay match; the running transition still is not settled.
      ['a delayed transition lift (transition-delay)', {
        css: '#commit{transition:transform .15s ease .12s} #commit:hover{transform:translateY(-2px)}',
      }, true],
      // Paint-only transitions cannot move the press point and do not delay it.
      ['a long paint-only hover transition', {
        css: '#commit{transition:background-color 2s,box-shadow 2s,color 2s} #commit:hover{background-color:#cde;color:#036;box-shadow:0 0 8px #036}',
      }, false, async () => {
        const [pressColor] = await page.evaluate(() => window.qaPressColors);
        assert.notEqual(pressColor, 'rgb(204, 221, 238)', 'pressed while the 2 s paint-only transition was still running');
      }],
      ['an unmoved button', {}, false],
    ]) await t.test(`${name}: one trusted press at the settled, re-verified centre`, async () => {
      const f = await fixture(browserInstance, options);
      try {
        const startedAt = Date.now();
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        const elapsed = Date.now() - startedAt;
        const clicks = await page.evaluate(() => window.qaClicks);
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.initialTrustedNativeButton, true);
        assert.equal(result.dispatched, true);
        assert.deepEqual(clicks.map(click => click.trusted), [true], 'exactly one trusted activation');
        assert.equal(presses().length, 1, 'exactly one press was sent');
        assert.equal(hovers().filter(move => move.x >= 0).length, 1, 'the wait sent no additional pointer input');
        const settled = await page.locator('#commit').boundingBox();
        assert.deepEqual({ x: presses()[0].x, y: presses()[0].y }, centre(settled), 'pressed at the settled centre');
        assert.deepEqual({ x: clicks[0].x, y: clicks[0].y }, centre(settled));
        const [pressRect] = await page.evaluate(() => window.qaPressRects);
        assert.deepEqual(pressRect, await page.evaluate(() => qaRect()), 'the button had stopped moving when it was pressed');
        if (moved) assert.notDeepEqual(centre(settled), centre(f.before), 'the hover moved the button');
        else assert.deepEqual(centre(settled), centre(f.before));
        await check?.();
        assert.ok(elapsed < 4000, `bounded wait (${elapsed} ms)`);
      } finally { await f.context.close(); }
    });

    for (const [name, options, intervene, check] of [
      ['a never-settling hover animation', {
        css: '@keyframes wb-bob{from{transform:translateY(0)}to{transform:translateY(-3px)}}'
          + ' #commit:hover{animation:wb-bob .25s linear infinite alternate}',
      }, null, (result, elapsed) => {
        assert.equal(result.preparationVeto?.stage, 'settle_after_pointer', JSON.stringify(result));
        assert.equal(result.preparationVeto?.predicate, 'geometry_changed');
        assert.match(result.error, /Re-observe/);
        assert.ok(elapsed >= 500, `refused only after the bounded wait (${elapsed} ms)`);
      }],
      ['an overlay appearing while the hover settles', {
        css: '#commit{transition:transform .2s} #commit:hover{transform:translateY(-2px)}'
          + ' #cover{position:fixed;inset:0;background:#fff;z-index:9}',
        script: "commit.addEventListener('mouseenter',()=>setTimeout(()=>{const cover=document.createElement('div');"
          + "cover.id='cover';document.body.append(cover);},90),{once:true});",
      }, null, result => assert.equal(result.preparationVeto?.stage, 'settle_after_pointer', JSON.stringify(result))],
      ['the button node replaced while the hover settles', {
        css: '#commit{transition:transform .2s} #commit:hover{transform:translateY(-2px)}',
        script: "commit.addEventListener('mouseenter',()=>setTimeout(()=>{const next=commit.cloneNode(true);"
          + 'commit.replaceWith(next);},90),{once:true});',
      }, null, result => assert.equal(result.preparationVeto?.stage, 'settle_after_pointer', JSON.stringify(result))],
      ['a user pointer movement while the hover settles', {
        css: '#commit{transition:transform .2s} #commit:hover{transform:translateY(-2px)}',
      }, () => page.mouse.move(700, 600), result => {
        assert.equal(result.preparationVeto?.stage, 'settle_after_pointer', JSON.stringify(result));
        assert.equal(result.preparationVeto?.predicate, 'intervention_changed');
      }],
      ['a user key press while the hover settles', {
        css: '#commit{transition:transform .2s} #commit:hover{transform:translateY(-2px)}',
      }, () => page.keyboard.press('x'), result => {
        assert.equal(result.preparationVeto?.stage, 'settle_after_pointer', JSON.stringify(result));
        assert.equal(result.preparationVeto?.predicate, 'intervention_changed');
      }],
      ['Stop while the hover settles', {
        css: '#commit{transition:transform .2s} #commit:hover{transform:translateY(-2px)}',
      }, agent => agent.abort(17), result => assert.equal(result.preparationVeto?.stage, 'settle_after_pointer', JSON.stringify(result))],
      ['a hover move beyond the 8 px tolerance', {
        css: '#commit{transition:transform .2s} #commit:hover{transform:translateY(-12px)}',
      }, null, result => assert.match(result.error, /changed during trusted input preparation/)],
    ]) await t.test(`${name} refuses before any press`, async () => {
      const f = await fixture(browserInstance, options);
      try {
        if (intervene) hooks.afterHover = () => intervene(f.agent);
        const startedAt = Date.now();
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        const elapsed = Date.now() - startedAt;
        await page.waitForTimeout(150);
        assert.equal(result.success, false, JSON.stringify(result));
        assert.equal(result.noDispatch, true, JSON.stringify(result));
        assert.notEqual(result.dispatched, true);
        assert.equal(presses().length, 0, 'no press was sent');
        assert.deepEqual(await page.evaluate(() => window.qaClicks), []);
        assert.equal(hovers().filter(move => move.x >= 0).length, 1, 'the wait sent no additional pointer input');
        assert.ok(elapsed < 4000, `bounded refusal (${elapsed} ms)`);
        check(result, elapsed);
      } finally { hooks.afterHover = null; await f.context.close(); }
    });
  } finally {
    cdpClient.attach = cdpAttach;
    await browserInstance.close();
  }
});
