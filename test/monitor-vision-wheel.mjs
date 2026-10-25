// Vision mode's mouse wheel (scroll_at) through the real page monitor. Its
// own wheel events stay the agent's even when the browser delivers them after
// the next notch was already fenced, and page churn does not void the
// operation while a person's input still does. Chromium runs both builds'
// monitor (the file is shared verbatim).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';

const RUN = 'vision-wheel';
const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}#tall{height:3000px}
#ticker{position:fixed;left:10px;top:10px}#human{position:fixed;left:10px;top:60px}</style>
<div id="ticker">0</div><button id="human">Human control</button><div id="tall"></div>`;

async function fixture(browser, build) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('https://wheel.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(RUN => {
    window.feedback = []; window.messageListeners = [];
    const runtime = {
      onMessage: { addListener: fn => messageListeners.push(fn), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: RUN, documentToken: message.documentToken };
        if (message.action === 'page_feedback') { feedback.push(message.feedback); return { accepted: true }; }
        return {};
      },
    };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.deliver = (action, params = {}) => new Promise(resolve => {
      for (const listener of messageListeners) {
        let answered = false;
        const asynchronous = listener({ target: 'content', action, params: { runToken: RUN, ...params } }, {}, value => { answered = true; resolve(value); });
        if (answered || asynchronous === true) return;
      }
      resolve(undefined);
    });
  }, RUN);
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8') });
  const page = await context.newPage();
  await page.goto('https://wheel.test/start');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(300);
  return { context, page };
}

const message = (page, action, params = {}) => page.evaluate(({ action, params }) => deliver(action, params), { action, params });
// What page-feedback.js sends for scroll_at, and what cdpClient's fence sends
// before each mouseWheel command.
const prepare = page => message(page, 'page_monitor_prepare', { operationId: 'wheel', tool: 'scroll_at', allowPassiveRebase: true, visionWheel: true });
const wheelFence = page => message(page, 'page_monitor_dispatch', {
  operationId: 'wheel', kind: 'scroll', nativeWheel: true, nativeInput: true, eventTypes: ['wheel'], x: 400, y: 300,
});
const userEvents = page => page.evaluate(() => feedback.filter(event => event.source === 'user').map(event => event.kind));

for (const build of ['chrome', 'firefox']) {
  test(`${build}: a vision wheel keeps its own events and survives page churn, not a person`, { timeout: 120000 }, async t => {
    const browser = await chromium.launch({ headless: true });
    try {
      await t.test('two notches fenced before their wheel events arrive are both the agent\'s', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.mouse.move(400, 300);
          assert.equal((await prepare(page)).ready, true);
          assert.equal((await wheelFence(page)).ready, true);
          assert.equal((await wheelFence(page)).ready, true);
          await page.mouse.wheel(0, 100);
          await page.mouse.wheel(0, 100);
          await page.waitForFunction(() => window.scrollY >= 200);
          await page.waitForTimeout(400);
          assert.deepEqual(await userEvents(page), [], 'no wheel or scroll is reported as a person\'s');
          // A third wheel the agent never fenced is a person's.
          await page.mouse.wheel(0, 100);
          await page.waitForTimeout(400);
          assert.ok((await userEvents(page)).includes('activity'), JSON.stringify(await userEvents(page)));
        } finally { await context.close(); }
      });

      await t.test('page churn after preparation does not void the wheel', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.mouse.move(400, 300);
          assert.equal((await prepare(page)).ready, true);
          await page.evaluate(() => {
            let ticks = 0;
            window.churn = setInterval(() => { document.getElementById('ticker').textContent = String(++ticks); }, 20);
          });
          await page.waitForTimeout(300);
          const fenced = await wheelFence(page);
          await page.evaluate(() => clearInterval(window.churn));
          assert.equal(fenced.ready, true, JSON.stringify(fenced));
        } finally { await context.close(); }
      });

      await t.test('a person\'s click after preparation voids it', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          assert.equal((await prepare(page)).ready, true);
          await page.click('#human');
          await page.waitForTimeout(300);
          await page.mouse.move(400, 300);
          const fenced = await wheelFence(page);
          assert.equal(fenced.ready, false, JSON.stringify(fenced));
          assert.equal(fenced.preparationVeto?.predicate, 'intervention_changed', JSON.stringify(fenced));
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}
