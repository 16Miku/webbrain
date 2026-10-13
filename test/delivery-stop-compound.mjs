// Delivery regression (C8): Stop between the write and the submit of a
// compound content action. The real set_field handler of each build runs in a
// Playwright page of the matching engine with the real page monitor; only the
// extension messaging transport is mocked. Stop is the agent's actual
// run-finish notification (page_monitor_state active:false for the owning run).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const form = `<!doctype html><main><h1>Search</h1>
<form id="f" action="/results" method="get"><label>Query <input id="q" name="q"></label>
<button type="submit">Go</button></form></main>
<script>window.qaSubmits = 0; window.qaEnters = 0;
q.addEventListener('keydown', event => { if (event.key === 'Enter') qaEnters++; });
f.addEventListener('submit', event => { event.preventDefault(); qaSubmits++; });</script>`;

// A form-less combobox commits through page-owned keyboard handlers instead
// of requestSubmit; Stop must also prevent its ArrowDown/Enter phase.
const combobox = `<!doctype html><main><h1>Pick a city</h1>
<div><input id="q" role="combobox" aria-autocomplete="list" aria-controls="cities" aria-label="City"></div>
<ul id="cities" role="listbox"><li role="option">Lisbon</li></ul></main>
<script>window.qaSubmits = 0; window.qaEnters = 0; window.qaArrows = 0;
q.addEventListener('keydown', event => { if (event.key === 'Enter') { qaEnters++; qaSubmits++; } if (event.key === 'ArrowDown') qaArrows++; });</script>`;

async function fixture(browserInstance, build, body) {
  const context = await browserInstance.newContext({ viewport: { width: 900, height: 600 } });
  await context.route('https://stop.test/**', route => route.fulfill({ contentType: 'text/html', body }));
  await context.addInitScript(() => {
    window.qaListeners = [];
    window.qaRunToken = 'run-owner';
    const runtime = {
      onMessage: { addListener: fn => qaListeners.push(fn), removeListener: fn => {
        const index = qaListeners.indexOf(fn); if (index >= 0) qaListeners.splice(index, 1);
      } },
      getURL: value => value,
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') {
          return window.qaRunToken
            ? { active: true, runToken: window.qaRunToken, documentToken: message.documentToken }
            : { active: false };
        }
        return { accepted: true };
      },
    };
    window.chrome = { runtime }; window.browser = window.chrome;
    // Like the browser runtime, every listener in the content world receives
    // the message; the first sendResponse answers it.
    window.qaDeliver = message => new Promise(resolve => {
      let answered = false, pending = false;
      const respond = value => { if (!answered) { answered = true; resolve(value); } };
      for (const listener of [...qaListeners]) {
        if (listener(message, {}, respond) === true) pending = true;
      }
      if (!answered && !pending) resolve(undefined);
    });
  });
  for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
    await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
  }
  const page = await context.newPage();
  await page.goto('https://stop.test/start');
  await page.waitForFunction(() => window.__wbPageMonitor?.active === true);
  await page.waitForTimeout(200);
  const ref = await page.evaluate(() => {
    window.__generateAccessibilityTree?.('all', 15, 6000);
    return window.__wb_ax_ref(document.getElementById('q'));
  });
  return { context, page, ref };
}

async function setFieldWithStop(page, ref, { stopAfterMs = null, text = 'webbrain' } = {}) {
  return page.evaluate(async ({ ref, stopAfterMs, text }) => {
    const operation = window.qaDeliver({ target: 'content', action: 'set_field',
      params: { ref_id: ref, text, submit: true } });
    if (stopAfterMs !== null) {
      await new Promise(resolve => setTimeout(resolve, stopAfterMs));
      // The agent's run finish (Stop) notifies every frame for the owning run.
      await window.qaDeliver({ target: 'content', action: 'page_monitor_state', active: false, runToken: window.qaRunToken });
      window.qaRunToken = '';
    }
    const result = await operation;
    await new Promise(resolve => setTimeout(resolve, 250));
    return { result, submits: window.qaSubmits, enters: window.qaEnters, value: document.getElementById('q').value,
      arrows: window.qaArrows || 0 };
  }, { ref, stopAfterMs, text });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: Stop between a set_field write and its submit prevents the submission`, async t => {
    const browserInstance = await engine.launch({ headless: true });
    try {
      for (const [name, body] of [['native form submit', form], ['form-less combobox Enter', combobox]]) {
        await t.test(`${name}: Stop during the settle wait sends no submission`, async () => {
          const { context, page, ref } = await fixture(browserInstance, build, body);
          try {
            const observed = await setFieldWithStop(page, ref, { stopAfterMs: 20 });
            assert.equal(observed.submits, 0, 'no form submission may follow Stop');
            assert.equal(observed.enters, 0, 'no Enter may follow Stop');
            assert.equal(observed.arrows, 0, 'no combobox commit key may follow Stop');
            assert.equal(observed.value, 'webbrain', 'the write itself already happened');
            const { result } = observed;
            assert.equal(result.success, false);
            assert.equal(result.dispatched, true, 'the field write was delivered');
            assert.equal(result.submitted, false);
            assert.equal(result.submissionDispatched, false);
            assert.equal(result.submissionBlockedBeforeDispatch, true);
            assert.equal(result.cancelled, true);
            assert.equal(result.verified, true, 'the write outcome is reported honestly');
          } finally { await context.close(); }
        });

        await t.test(`${name}: without Stop the value is set and submitted exactly once`, async () => {
          const { context, page, ref } = await fixture(browserInstance, build, body);
          try {
            const observed = await setFieldWithStop(page, ref);
            assert.equal(observed.value, 'webbrain');
            assert.equal(observed.submits, 1);
            assert.equal(observed.result.success, true);
            assert.equal(observed.result.verified, true);
            assert.equal(observed.result.submissionDispatched, true);
          } finally { await context.close(); }
        });
      }

      await t.test('a stale Stop for another run does not cancel the current submission', async () => {
        const { context, page, ref } = await fixture(browserInstance, build, form);
        try {
          const observed = await page.evaluate(async ref => {
            const operation = window.qaDeliver({ target: 'content', action: 'set_field',
              params: { ref_id: ref, text: 'webbrain', submit: true } });
            await new Promise(resolve => setTimeout(resolve, 20));
            await window.qaDeliver({ target: 'content', action: 'page_monitor_state', active: false, runToken: 'older-run' });
            const result = await operation;
            await new Promise(resolve => setTimeout(resolve, 250));
            return { result, submits: window.qaSubmits };
          }, ref);
          assert.equal(observed.submits, 1);
          assert.equal(observed.result.success, true);
        } finally { await context.close(); }
      });
    } finally {
      await browserInstance.close();
    }
  });
}
