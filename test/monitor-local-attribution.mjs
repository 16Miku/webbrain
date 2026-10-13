// Attribution during content-script (synthetic) operations: trusted key and
// pointer presses cannot come from synthetic dispatch and belong to the user,
// while the operation's own execCommand/focus/blur effects stay the agent's.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const RUN = 'local-run';
const html = `<!doctype html><style>body { margin: 20px; font: 16px sans-serif; } button, input { margin: 8px; }</style>
<main><h1>Profile</h1><form id="form" action="/results" method="get">
<label>Query <input id="q" name="q"></label><label>Name <input id="a" name="a"></label>
<button id="go" type="submit">Search</button><button id="b" type="button">Next</button></form>
<div id="editor" contenteditable="true" role="textbox" aria-label="Notes"></div></main>
<script>
window.submits = 0; window.nextClicks = 0;
document.getElementById('form').addEventListener('submit', event => { event.preventDefault(); submits++; });
document.getElementById('b').addEventListener('click', () => nextClicks++);
</script>`;

async function fixture(browser, build) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await context.route('https://local.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(RUN => {
    window.feedback = []; window.messageListeners = [];
    const runtime = {
      onMessage: { addListener: fn => messageListeners.push(fn), removeListener() {} },
      async sendMessage(msg) {
        if (msg.action === 'get_page_monitor_state') return { active: true, runToken: RUN, documentToken: msg.documentToken };
        if (msg.action === 'page_feedback') { feedback.push(msg.feedback); return { accepted: true }; }
        return {};
      },
    };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.__wb_ax_lookup = ref => document.getElementById(ref.replace(/^ref_/, ''));
    window.deliver = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of messageListeners) {
        const asynchronous = listener({ target: 'content', action, params: { runToken: RUN, ...params } }, {}, respond);
        if (answered || asynchronous === true) return;
      }
      resolve(undefined);
    });
  }, RUN);
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8') });
  const page = await context.newPage();
  await page.goto('https://local.test/start');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(250);
  await page.evaluate(() => { feedback = []; });
  return { context, page };
}

const events = page => page.evaluate(() => feedback.map(event => `${event.kind}/${event.source}${event.operation ? ':' + event.operation : ''}`));

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: physical input during a synthetic content operation belongs to the user`, { timeout: 90000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      await t.test('a user Enter during a type settle wait is not correlated to the agent (r7)', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => {
            const q = document.getElementById('q');
            window.finishLocal = __wbPageMonitor.beginContentAction('type_ax', { ref_id: 'ref_q' });
            __wbPageMonitor.beforeLocalDispatch({ preparation: true, kind: 'focus', target: q });
            q.focus();
            __wbPageMonitor.withLocalDispatch(() => { q.value = 'webbrain'; q.dispatchEvent(new Event('input', { bubbles: true })); });
          });
          await page.keyboard.press('Enter'); // The operation is still settling.
          await page.evaluate(() => finishLocal());
          await page.waitForTimeout(260);
          const observed = await events(page);
          assert.equal(await page.evaluate(() => submits), 1);
          assert.ok(observed.includes('activity/user'), `The physical key is user activity: ${observed}`);
          assert.equal(observed.some(event => event.startsWith('activity/agent')), false, `No agent submit correlation: ${observed}`);
        } finally { await context.close(); }
      });

      await t.test('a user mouse click during a synthetic click operation is reported', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => {
            window.finishLocal = __wbPageMonitor.beginContentAction('click', { selector: '#b' });
            __wbPageMonitor.withLocalDispatch(() => document.getElementById('b').click());
          });
          await page.click('#b');
          await page.evaluate(() => finishLocal());
          await page.waitForTimeout(100);
          assert.equal(await page.evaluate(() => nextClicks), 2);
          // The trusted pointer press itself (not only a later duplicate click) is the user's.
          assert.ok((await events(page)).includes('activity/user'), `The physical press is user input: ${await events(page)}`);
        } finally { await context.close(); }
      });

      await t.test('the operation\'s own execCommand input and preparation focus stay attributed to it', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => {
            const editor = document.getElementById('editor');
            const finish = __wbPageMonitor.beginContentAction('type_ax', { ref_id: 'ref_editor' });
            __wbPageMonitor.beforeLocalDispatch({ preparation: true, kind: 'focus', target: editor });
            editor.focus();
            __wbPageMonitor.withLocalDispatch(() => document.execCommand('insertText', false, 'Agent note'));
            finish();
          });
          await page.waitForTimeout(260);
          assert.equal(await page.evaluate(() => document.getElementById('editor').textContent), 'Agent note');
          const observed = await events(page);
          assert.equal(observed.some(event => event.endsWith('/user') || event === 'input/page' || event === 'activity/page'), false, observed.join());
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });

  test(`${build}: the blur commit caused by the agent's own preparation focus is not an intervention (r8)`, { timeout: 90000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const agentTypes = async page => {
        await page.evaluate(() => document.getElementById('a').focus());
        await page.evaluate(() => deliver('page_monitor_prepare', { operationId: 'typing', tool: 'type_ax', selector: '#a' }));
        await page.evaluate(() => deliver('page_monitor_dispatch', { operationId: 'typing', kind: 'input', selector: '#a',
          eventTypes: ['beforeinput', 'input', 'change'] }));
        await page.keyboard.insertText('Ada Lovelace');
        await page.evaluate(() => deliver('page_monitor_finish', { operationId: 'typing' }));
        await page.waitForTimeout(400); // The next decision: the typing operation has expired.
      };
      const localClickOnB = page => page.evaluate(() => {
        const b = document.getElementById('b');
        const finish = __wbPageMonitor.beginContentAction('click_ax', { ref_id: 'ref_b' });
        try {
          __wbPageMonitor.beforeLocalDispatch({ preparation: true, kind: 'focus', target: b });
          b.focus(); // Commits field A: the browser fires a trusted change there.
          __wbPageMonitor.withLocalDispatch(() => b.click());
          return 'clicked';
        } catch (error) { return error.pagePreparationVeto?.predicate || error.code || 'error'; }
        finally { finish(); }
      });

      await t.test('the agent click proceeds and the commit is not reported as user input', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await agentTypes(page);
          await page.evaluate(() => { feedback = []; });
          assert.equal(await localClickOnB(page), 'clicked');
          assert.equal(await page.evaluate(() => nextClicks), 1);
          assert.equal((await events(page)).some(event => event.endsWith('/user')), false, (await events(page)).join());
        } finally { await context.close(); }
      });

      await t.test('a user edit in the same field is still reported by its own input events', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.click('#a');
          await page.keyboard.type('Grace');
          await page.waitForTimeout(100);
          assert.ok((await events(page)).includes('input/user'));
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}
