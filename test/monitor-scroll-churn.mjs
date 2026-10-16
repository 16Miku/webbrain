// Relative scrolling must work on live pages without waiting for DOM quiet.
// Exercise the real monitor and content scroll handler in both browser builds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const RUN = 'scroll-churn';
const html = `<!doctype html><style>
body{margin:0;font:16px sans-serif}#pane{position:absolute;left:20px;top:70px;width:700px;height:350px;overflow-y:auto}
#other{position:absolute;left:750px;top:70px;width:200px;height:350px;overflow-y:auto}
.row{height:45px}#counter{position:absolute;left:20px;top:20px}#human{position:absolute;left:750px;top:20px}
</style><div id="counter">0</div><button id="human">Human control</button><section id="pane" role="region"></section><aside id="other"></aside>
<script>for(const pane of document.querySelectorAll('#pane,#other'))pane.innerHTML=Array.from({length:50},(_,i)=>'<div class="row">Live row '+i+'</div>').join('');document.querySelector('#pane .row').id='origin';</script>`;

async function fixture(browser, build) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('https://scroll.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(RUN => {
    window.feedback = []; window.messageListeners = [];
    const runtime = {
      onMessage: { addListener: fn => messageListeners.push(fn), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: RUN, documentToken: message.documentToken };
        if (message.action === 'page_feedback') {
          feedback.push(message.feedback);
          // Keep outstanding feedback while the page continues rendering.
          await new Promise(resolve => setTimeout(resolve, 300));
          return { accepted: true };
        }
        return {};
      },
    };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.__wb_ax_lookup = ref => document.getElementById(ref.replace(/^ref_/, ''));
    window.deliver = (action, params = {}) => new Promise(resolve => {
      for (const listener of messageListeners) {
        let answered = false;
        const asynchronous = listener({ target: 'content', action, params: { runToken: RUN, ...params } }, {}, value => { answered = true; resolve(value); });
        if (answered || asynchronous === true) return;
      }
      resolve(undefined);
    });
  }, RUN);
  for (const file of ['page-monitor.js', 'content.js']) await context.addInitScript({
    content: fs.readFileSync(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8'),
  });
  const page = await context.newPage();
  await page.goto('https://scroll.test/start');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(500);
  return { context, page };
}

const message = (page, action, params = {}) => page.evaluate(({ action, params }) => deliver(action, params), { action, params });
const prepare = (page, extra = {}) => message(page, 'page_monitor_prepare', {
  operationId: 'scroll', tool: 'scroll', allowPassiveRebase: true, ...extra,
});
const fence = page => message(page, 'page_monitor_dispatch', { operationId: 'scroll', kind: 'scroll', fenceOnly: true });

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: scroll proceeds through live renders and preserves its document and pane fences`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      await t.test('unknown DOM and pending feedback do not stop the actual content scroll', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, { ref_id: 'ref_pane' });
          await page.evaluate(() => {
            __wbPageMonitor.dispatch({ operationId: 'unrelated', kind: 'dom', runToken: 'scroll-churn' });
            document.getElementById('counter').textContent = '1';
            window.churn = setInterval(() => document.getElementById('counter').textContent = String(Math.random()), 15);
          });
          assert.equal((await fence(page)).ready, true);
          const result = await message(page, 'scroll', { ref_id: 'ref_pane', direction: 'down', amount: 120 });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.movedContainer, true);
          assert.equal(await page.locator('#pane').evaluate(node => node.scrollTop), 120);
          assert.equal(await page.locator('#other').evaluate(node => node.scrollTop), 0);
          const observed = await page.evaluate(() => { clearInterval(churn); return feedback; });
          assert.ok(observed.some(event => event.kind === 'dom' && event.source === 'unknown'));
        } finally { await context.close(); }
      });

      await t.test('recycling the row under coordinates preserves the same pane', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, { x: 100, y: 100 });
          await page.locator('#pane .row').first().evaluate(node => { const replacement = node.cloneNode(true); replacement.textContent = 'Replacement live row'; node.replaceWith(replacement); });
          assert.equal((await fence(page)).ready, true);
          const result = await message(page, 'scroll', { x: 100, y: 100, direction: 'down', amount: 120 });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.movedContainer, true);
        } finally { await context.close(); }
      });

      for (const [name, point] of [
        ['outside the ref pane', { x: 0, y: 0 }],
        ['over another pane', { x: 800, y: 100 }],
      ]) await t.test(`a ref takes precedence over fallback coordinates ${name}`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const request = { ref_id: 'ref_pane', ...point, direction: 'down', amount: 120 };
          assert.equal((await prepare(page, request)).ready, true);
          // Replacing the unrelated pane must not change the ref's recipient,
          // even when the ignored coordinates happen to hit that pane.
          await page.locator('#other').evaluate(node => node.replaceWith(node.cloneNode(true)));
          assert.equal((await fence(page)).ready, true);
          const result = await message(page, 'scroll', request);
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.movedContainer, true);
          assert.equal(await page.locator('#pane').evaluate(node => node.scrollTop), 120);
          assert.equal(await page.locator('#other').evaluate(node => node.scrollTop), 0);
        } finally { await context.close(); }
      });

      for (const direction of ['down', 'up']) await t.test(`a point outside all panes can scroll the largest visible container ${direction}`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          assert.equal(await page.evaluate(() => document.elementFromPoint(0, 0) === document.documentElement), true);
          assert.equal(await page.evaluate(() => document.scrollingElement.scrollHeight <= window.innerHeight), true);
          const before = await page.locator('#pane').evaluate((node, direction) => {
            if (direction === 'up') node.scrollTop = node.scrollHeight;
            return node.scrollTop;
          }, direction);
          const request = { x: 0, y: 0, direction, amount: 120 };
          assert.equal((await prepare(page, request)).ready, true);
          assert.equal((await fence(page)).ready, true);
          const result = await message(page, 'scroll', request);
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.movedContainer, true);
          assert.equal(await page.locator('#pane').evaluate(node => node.scrollTop), before + (direction === 'up' ? -120 : 120));
          assert.equal(await page.locator('#other').evaluate(node => node.scrollTop), 0);
          assert.equal(await page.evaluate(() => window.scrollY), 0);
        } finally { await context.close(); }
      });

      await t.test('a nested pane at its limit can scroll its original ancestor', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => {
            const inner = document.createElement('div'); inner.id = 'inner';
            inner.style.cssText = 'height:100px;overflow-y:auto'; inner.innerHTML = '<div style="height:600px">Nested history</div>';
            document.getElementById('pane').prepend(inner); inner.scrollTop = inner.scrollHeight;
          });
          await prepare(page, { x: 100, y: 100 });
          assert.equal((await fence(page)).ready, true);
          const result = await message(page, 'scroll', { x: 100, y: 100, direction: 'down', amount: 120 });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(await page.locator('#pane').evaluate(node => node.scrollTop), 120);
        } finally { await context.close(); }
      });

      await t.test('generic window scrolling and explicit alsoWindow survive live page content', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => { document.body.style.height = '2000px'; });
          await prepare(page);
          assert.equal((await fence(page)).ready, true);
          const windowResult = await message(page, 'scroll', { direction: 'down', amount: 120 });
          assert.equal(windowResult.success, true, JSON.stringify(windowResult));
          assert.equal(windowResult.movedWindow, true);
          await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById('counter').textContent = 'Updated'; });
          await prepare(page, { ref_id: 'ref_pane', alsoWindow: true });
          assert.equal((await fence(page)).ready, true);
          const combined = await message(page, 'scroll', { ref_id: 'ref_pane', direction: 'down', amount: 120, alsoWindow: true });
          assert.equal(combined.success, true, JSON.stringify(combined));
          assert.equal(combined.movedContainer, true);
          assert.equal(combined.movedWindow, true);
        } finally { await context.close(); }
      });

      for (const [name, request, mutate] of [
        ['a replaced ref pane', { ref_id: 'ref_pane' }, page => page.locator('#pane').evaluate(node => node.replaceWith(node.cloneNode(true)))],
        ['a ref moved into another pane', { ref_id: 'ref_origin' }, page => page.locator('#origin').evaluate(node => document.getElementById('other').prepend(node))],
        ['a different pane under prepared coordinates', { x: 100, y: 100 }, page => page.locator('#pane').evaluate(node => { node.style.left = '750px'; document.getElementById('other').style.left = '20px'; })],
        ['a replaced largest-container fallback pane', { x: 0, y: 0, direction: 'down' }, page => page.locator('#pane').evaluate(node => node.replaceWith(node.cloneNode(true)))],
        ['a moved largest-container fallback pane', { x: 0, y: 0, direction: 'down' }, page => page.locator('#pane').evaluate(node => { node.style.top = '100px'; })],
        ['a changed top-level viewport', {}, page => page.setViewportSize({ width: 990, height: 690 })],
        ['a changed same-document URL', {}, page => page.evaluate(() => history.pushState({}, '', '/other'))],
        ['a changed base URL', {}, page => page.evaluate(() => { const base = document.createElement('base'); base.href = '/other/'; document.head.append(base); })],
        ['genuine user input', {}, page => page.click('#human')],
      ]) await t.test(`${name} still vetoes the prepared scroll`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, request);
          await mutate(page);
          const result = await fence(page);
          assert.equal(result.ready, false, JSON.stringify(result));
          assert.equal(result.pageFeedbackPending, true);
          assert.equal(await page.locator('#pane').evaluate(node => node.scrollTop), 0);
        } finally { await context.close(); }
      });

      await t.test('a second local prepare cannot erase the original human-intervention fence', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, { ref_id: 'ref_pane' });
          assert.equal((await fence(page)).ready, true);
          await page.click('#human');
          await page.waitForTimeout(500);
          const result = await message(page, 'scroll', { ref_id: 'ref_pane', direction: 'down', amount: 120 });
          assert.notEqual(result.success, true, JSON.stringify(result));
          assert.equal(await page.locator('#pane').evaluate(node => node.scrollTop), 0);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of [
        ['replaced', page => page.locator('#pane').evaluate(node => node.replaceWith(node.cloneNode(true)))],
        ['moved', page => page.locator('#pane').evaluate(node => { node.style.top = '100px'; })],
      ]) await t.test(`a second local prepare cannot rebind a ${name} fallback pane`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const request = { x: 0, y: 0, direction: 'down', amount: 120 };
          assert.equal((await prepare(page, request)).ready, true);
          assert.equal((await fence(page)).ready, true);
          await mutate(page);
          const result = await message(page, 'scroll', request);
          assert.notEqual(result.success, true, JSON.stringify(result));
          assert.equal(result.noDispatch, true, JSON.stringify(result));
          assert.equal(await page.locator('#pane').evaluate(node => node.scrollTop), 0);
          assert.equal(await page.locator('#other').evaluate(node => node.scrollTop), 0);
        } finally { await context.close(); }
      });

      await t.test('scroll authority cannot authorize a click or input dispatch', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, { ref_id: 'ref_pane' });
          for (const kind of ['click', 'input']) {
            const result = await message(page, 'page_monitor_dispatch', { operationId: 'scroll', kind, fenceOnly: true });
            assert.equal(result.ready, false, JSON.stringify(result));
            assert.equal(result.preparationVeto?.predicate, 'operation_kind_changed');
          }
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}
