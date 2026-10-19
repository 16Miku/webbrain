import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

// A pre-inference observation certifies its targets for two minutes of
// WebBrain's own time. The background reports how long it then waited for the
// model's decision and for the user's answers to its own cards (modelHeldMs);
// that time does not age the observation, while every page change is still
// judged as before. Without it a slow provider or a user reading a permission
// card for a minute expired an unchanged login button (E2, K1, M1 traces).
const html = `<!doctype html><style>body{margin:20px;font:16px sans-serif}button{min-height:40px;width:240px}</style>
<main id="owner"><h1>Sign in</h1><form id="login" onsubmit="event.preventDefault()">
<label>Username <input id="user" name="username"></label>
<button id="submit" type="submit">Log in</button></form></main><aside id="clock">0</aside>`;
const sources = new Map();
for (const build of ['chrome', 'firefox']) {
  const files = new Map();
  for (const name of ['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
    files.set(name, await readFile(new URL(`../src/${build}/src/content/${name}`, import.meta.url), 'utf8'));
  }
  sources.set(build, files);
}

async function fixture(browser, build) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('https://held-observation.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(() => {
    window.qaListeners = []; window.qaRunToken = 'held-observation-run';
    // The page's clock moves on without real waiting.
    const realNow = Date.now.bind(Date);
    window.qaClockOffset = 0;
    Date.now = () => realNow() + window.qaClockOffset;
    window.chrome = window.browser = { runtime: {
      onMessage: { addListener: fn => qaListeners.push(fn), removeListener() {} }, getURL: value => value,
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: qaRunToken, documentToken: message.documentToken };
        if (message.action === 'page_feedback') return { accepted: true };
        return {};
      },
    } };
    window.qaMessage = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of qaListeners) {
        const message = { target: 'content', action, params: { runToken: 'held-observation-run', ...params } };
        const asynchronous = listener(message, {}, respond);
        if (answered || asynchronous === true) break;
      }
    });
  });
  for (const content of sources.get(build).values()) await context.addInitScript({ content });
  const page = await context.newPage();
  await page.goto('https://held-observation.test/login');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(180);
  return { context, page };
}

const capture = page => page.evaluate(async () => {
  const snapshot = await qaMessage('page_monitor_capture_model', { includeTree: true });
  return { snapshotToken: snapshot.snapshotToken, ref_id: __wb_ax_ref(document.getElementById('submit')) };
});
const validate = (page, captured, extra = {}) => page.evaluate(({ captured, extra }) => qaMessage('page_monitor_validate_model', {
  tool: 'click_ax', ref_id: captured.ref_id, snapshotToken: captured.snapshotToken, ...extra,
}), { captured, extra });
const prepare = (page, captured, extra = {}) => page.evaluate(({ captured, extra }) => qaMessage('page_monitor_prepare', {
  tool: 'click_ax', ref_id: captured.ref_id, operationId: 'held-observation-click',
  expectedModelSnapshot: captured.snapshotToken, allowPassiveRebase: true, ...extra,
}), { captured, extra });
const advance = (page, ms) => page.evaluate(ms => { window.qaClockOffset += ms; }, ms);

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: time spent waiting for the model and the user does not expire an unchanged target`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const withFixture = async work => {
        const { context, page } = await fixture(browser, build);
        try { await work(page); } finally { await context.close(); }
      };

      await t.test('two minutes of WebBrain time still expire the observation', () => withFixture(async page => {
        const captured = await capture(page);
        assert.equal((await validate(page, captured)).ready, true);
        // A 46-second answer, then a 112-second wait on the permission card.
        await advance(page, 158000);
        const expired = await validate(page, captured);
        assert.deepEqual([expired.ready, expired.reason], [false, 'model_snapshot_expired']);
        // Held time that does not cover the gap leaves it expired.
        assert.equal((await validate(page, captured, { modelHeldMs: 30000 })).reason, 'model_snapshot_expired');
        // The background reports that the model and the user held it for 158 s.
        assert.equal((await validate(page, captured, { modelHeldMs: 158000 })).ready, true);
        // Preparation and later checks of the same call see the same hold.
        const prepared = await prepare(page, captured);
        assert.equal(prepared.modelBindingValid, true, JSON.stringify(prepared));
        assert.equal((await validate(page, captured, { modelHeldMs: 10 })).ready, true, 'a hold never shrinks');
        // WebBrain's own time keeps counting after the hold.
        await advance(page, 121000);
        assert.equal((await validate(page, captured)).reason, 'model_snapshot_expired');
      }));

      await t.test('a page change during the wait still retires the target', () => withFixture(async page => {
        const captured = await capture(page);
        await advance(page, 150000);
        await page.evaluate(() => { document.getElementById('submit').textContent = 'Delete account'; });
        await page.waitForTimeout(180);
        assert.equal((await validate(page, captured, { modelHeldMs: 150000 })).ready, false);
      }));

      await t.test('an unrelated counter changing during the wait does not', () => withFixture(async page => {
        const captured = await capture(page);
        await advance(page, 150000);
        await page.evaluate(() => { document.getElementById('clock').textContent = '1'; });
        await page.waitForTimeout(180);
        assert.equal((await validate(page, captured, { modelHeldMs: 150000 })).ready, true);
      }));

      await t.test('the hold is bounded', () => withFixture(async page => {
        const captured = await capture(page);
        await advance(page, 3 * 60 * 60 * 1000);
        assert.equal((await validate(page, captured, { modelHeldMs: 10 * 60 * 60 * 1000 })).reason, 'model_snapshot_expired');
      }));
    } finally { await browser.close(); }
  });
}
