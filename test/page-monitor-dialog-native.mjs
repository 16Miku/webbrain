import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const base = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;width:1000px;height:650px} #dialog{position:absolute;left:20px;top:20px;width:420px;height:260px}
textarea{display:block;width:350px;height:80px} #counter{position:absolute;left:650px;top:20px}
</style><div id="dialog" role="dialog" aria-modal="true">CONTENT</div><aside id="counter">1</aside>`;
const controls = '<textarea id="draft" aria-label="Draft">Original</textarea><nav><button id="audience" type="button" aria-label="Public audience">Public</button></nav><button id="commit" type="button">Publish</button>';

async function fixture(browser, build, body) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('https://owned-dialog.invalid/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
  await context.addInitScript(() => {
    window.qaFeedback = []; window.qaListeners = []; window.qaClicks = 0;
    const runtime = { getURL: value => value,
      onMessage: { addListener: fn => qaListeners.push(fn), removeListener: fn => { qaListeners = qaListeners.filter(item => item !== fn); } },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: 'dialog-regression', documentToken: message.documentToken };
        if (message.action === 'page_feedback') { qaFeedback.push(message.feedback); return { accepted: true }; }
        return {};
      } };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.qaSend = (action, params = {}) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No production response for ${action}`)), 3000);
      let answered = false;
      const respond = value => { answered = true; clearTimeout(timeout); resolve(value); };
      for (const listener of qaListeners) {
        const asynchronous = listener({ target: 'content', action, params: { runToken: 'dialog-regression', ...params } }, {}, respond);
        if (answered || asynchronous === true) break;
      }
    });
    document.addEventListener('click', event => { if (event.target.closest?.('#commit')) qaClicks++; });
  });
  for (const name of ['page-monitor-shadow.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
    await context.addInitScript({ content: await readFile(new URL(`../src/${build}/src/content/${name}`, import.meta.url), 'utf8') });
  }
  const page = await context.newPage();
  await page.goto('https://owned-dialog.invalid/composer');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(180);
  return { context, page };
}

async function capture(page) {
  const snapshot = await page.evaluate(() => qaSend('page_monitor_capture_model', { includeTree: true }));
  assert.equal(snapshot.ready, true); assert.equal(snapshot.page?.success, true);
  assert.ok(snapshot.documentToken); assert.ok(snapshot.snapshotToken);
  return snapshot;
}

function ref(snapshot, pattern) {
  const line = snapshot.page.pageContent.split('\n').find(line => pattern.test(line));
  const value = line?.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(value, `Resolve the actual production AX reference for ${pattern}`);
  return value;
}

const validate = (page, snapshot, target) => page.evaluate(({ snapshotToken, target }) =>
  qaSend('page_monitor_validate_model', { snapshotToken, ...target }), { snapshotToken: snapshot.snapshotToken, target });

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: heading-free native dialog certification preserves its full destination and label semantics`, { timeout: 60000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      await t.test('controls-only composer survives unrelated counters and includes its navigation audience control', async () => {
        const { context, page } = await fixture(browser, build, base.replace('CONTENT', controls));
        try {
          const snapshot = await capture(page);
          const draft = { tool: 'set_field', ref_id: ref(snapshot, /textbox "Draft"/) };
          const audience = { tool: 'click_ax', ref_id: ref(snapshot, /button "Public audience"/) };
          assert.equal((await validate(page, snapshot, draft)).ready, true);
          assert.equal((await validate(page, snapshot, audience)).ready, true, 'Controls inside dialog navigation remain bound.');
          await page.locator('#counter').evaluate(node => { node.textContent = '2'; });
          assert.equal((await validate(page, snapshot, draft)).ready, true, 'A separate counter does not change the destination.');
          const result = await page.evaluate(({ snapshotToken, refId }) => qaSend('set_field', {
            ref_id: refId, text: 'Exactly authored draft', clear: true, allowPassiveRebase: true, expectedModelSnapshot: snapshotToken,
          }), { snapshotToken: snapshot.snapshotToken, refId: draft.ref_id });
          assert.equal(result.success, true, result.error); assert.equal(result.verified, true);
          assert.equal(await page.locator('#draft').inputValue(), 'Exactly authored draft');
          assert.equal(await page.evaluate(() => qaClicks), 0);
        } finally { await context.close(); }
      });

      for (const attribute of ['title', 'aria-label']) await t.test(`a navigation audience ${attribute} change stops the captured draft action`, async () => {
        const { context, page } = await fixture(browser, build, base.replace('CONTENT', controls));
        try {
          const snapshot = await capture(page), draft = { tool: 'set_field', ref_id: ref(snapshot, /textbox "Draft"/) };
          assert.equal((await validate(page, snapshot, draft)).ready, true);
          await page.locator('#audience').evaluate((node, attribute) => node.setAttribute(attribute, 'Changed destination'), attribute);
          assert.equal((await validate(page, snapshot, draft)).ready, false);
          const result = await page.evaluate(({ snapshotToken, refId }) => qaSend('set_field', {
            ref_id: refId, text: 'Must not dispatch', clear: true, allowPassiveRebase: true, expectedModelSnapshot: snapshotToken,
          }), { snapshotToken: snapshot.snapshotToken, refId: draft.ref_id });
          assert.equal(result.success, false); assert.equal(result.dispatched, false);
          assert.equal(await page.locator('#draft').inputValue(), 'Original');
        } finally { await context.close(); }
      });

      for (const display of ['inline', 'contents']) await t.test(`external full ARIA label descendants bind ${display} visibility or retain the strict fence`, async () => {
        const content = controls.replace('aria-label="Public audience"', 'aria-labelledby="external-audience"');
        const label = `<span id="external-audience"><span id="current-audience" style="display:${display}" role="textbox" aria-readonly="true">${'Original audience '.repeat(20)}A</span><span id="replacement-audience" style="display:none">${'Original audience '.repeat(20)}B</span></span>`;
        const { context, page } = await fixture(browser, build, base.replace('CONTENT', content) + label);
        try {
          const snapshot = await capture(page), draft = { tool: 'set_field', ref_id: ref(snapshot, /textbox "Draft"/) };
          const initial = await validate(page, snapshot, draft);
          if (display === 'inline') assert.equal(initial.ready, true);
          else if (!initial.ready) assert.ok(initial.uncertified === true || initial.reason === 'target_uncovered',
            'A boxless identity that cannot be fully exposed cannot certify the target.');
          const textBefore = await page.locator('#external-audience').textContent();
          await page.evaluate(display => {
            document.querySelector('#current-audience').style.display = 'none';
            document.querySelector('#replacement-audience').style.display = display;
          }, display);
          assert.equal(await page.locator('#external-audience').textContent(), textBefore, 'Raw textContent stays identical while the rendered audience changes.');
          const result = await validate(page, snapshot, draft);
          assert.equal(result.ready, false);
          assert.equal(JSON.stringify(result).includes('Original audience'), false, 'Only opaque ownership metadata crosses the monitor boundary.');
          assert.equal(await page.locator('#draft').inputValue(), 'Original');
        } finally { await context.close(); }
      });

      await t.test('a fully observed external read-only identity exposes its complete text and binds later changes', async () => {
        const content = controls.replace('aria-label="Public audience"', 'aria-labelledby="external-audience"');
        const name = `${'Original audience '.repeat(20)}A`;
        const label = `<span id="external-audience" role="textbox" aria-readonly="true">${name}</span>`;
        const { context, page } = await fixture(browser, build, base.replace('CONTENT', content) + label);
        try {
          const snapshot = await capture(page), draft = { tool: 'set_field', ref_id: ref(snapshot, /textbox "Draft"/) };
          assert.equal((await validate(page, snapshot, draft)).ready, true);
          assert.ok(snapshot.page.pageContent.includes(name), 'An inferred or truncated AX name cannot stand in for the recipient label.');
          await page.locator('#counter').evaluate(node => { node.textContent = 'Changed independently'; });
          assert.equal((await validate(page, snapshot, draft)).ready, true);
          await page.locator('#external-audience').evaluate(node => { node.textContent = node.textContent.slice(0, -1) + 'B'; });
          assert.equal((await validate(page, snapshot, draft)).ready, false);
          assert.equal(await page.locator('#draft').inputValue(), 'Original');
        } finally { await context.close(); }
      });

      for (const [kind, display] of [
        ['editable', '<span contenteditable="true">Audience</span>'],
        ['focusable', '<span tabindex="0">Audience</span>'],
        ['clickable', '<span onclick="window.qaClicks++">Audience</span>'],
        ['nested-control', '<span><button type="button">Audience</button></span>'],
        ['nested-clickable', '<span><span onclick="window.qaClicks++">Audience</span></span>'],
        ['nested-focusable', '<span><span tabindex="0">Audience</span></span>'],
      ]) await t.test(`an external read-only label containing ${kind} behavior keeps the strict fence`, async () => {
        const content = controls.replace('aria-label="Public audience"', 'aria-labelledby="external-audience"');
        const label = display.replace('<span', '<span id="external-audience" role="textbox" aria-readonly="true"');
        const { context, page } = await fixture(browser, build, base.replace('CONTENT', content) + label);
        try {
          const snapshot = await capture(page), draft = { tool: 'set_field', ref_id: ref(snapshot, /textbox "Draft"/) };
          assert.equal((await validate(page, snapshot, draft)).ready, false);
          await page.locator('#counter').evaluate(node => { node.textContent = 'Changed independently'; });
          const result = await page.evaluate(({ snapshotToken, refId }) => qaSend('set_field', {
            ref_id: refId, text: 'Must not dispatch', clear: true, allowPassiveRebase: true, expectedModelSnapshot: snapshotToken,
          }), { snapshotToken: snapshot.snapshotToken, refId: draft.ref_id });
          assert.equal(result.success, false); assert.equal(result.dispatched, false);
          assert.equal(await page.locator('#draft').inputValue(), 'Original');
          assert.equal(await page.evaluate(() => qaClicks), 0);
        } finally { await context.close(); }
      });

      for (const nested of ['<p>Observed destination</p>', '<div style="display:contents"><span>Observed destination</span></div>']) await t.test(`fully observed nested destination survives counters and rejects recipient changes (${nested.includes('contents') ? 'display contents' : 'paragraph'})`, async () => {
        const { context, page } = await fixture(browser, build, base.replace('CONTENT', nested + controls));
        try {
          const snapshot = await capture(page), draft = { tool: 'set_field', ref_id: ref(snapshot, /textbox "Draft"/) };
          const result = await validate(page, snapshot, draft);
          assert.equal(result.ready, true);
          assert.ok(snapshot.page.pageContent.includes('Observed destination'), 'The entire destination is exposed in the same model observation.');
          const preparation = await page.evaluate(({ snapshotToken, target }) => qaSend('page_monitor_prepare', {
            operationId: 'observed-dialog', expectedModelSnapshot: snapshotToken, allowPassiveRebase: true, ...target,
          }), { snapshotToken: snapshot.snapshotToken, target: draft });
          assert.equal(preparation.ready, true);
          await page.locator('#counter').evaluate(node => { node.textContent = '3'; });
          const dispatch = await page.evaluate(() => qaSend('page_monitor_dispatch', {
            operationId: 'observed-dialog', kind: 'input', fenceOnly: true,
          }));
          assert.equal(dispatch.ready, true, 'An unrelated counter cannot invalidate an exactly bound recipient.');
          const fresh = await capture(page);
          await page.locator('#dialog').evaluate(node => {
            const recipient = [...node.querySelectorAll('p,span')].find(item => item.textContent === 'Observed destination');
            recipient.textContent = 'Changed destination';
          });
          assert.equal((await validate(page, fresh, draft)).ready, false);
          const write = await page.evaluate(({ snapshotToken, target }) => qaSend('set_field', {
            text: 'Must not dispatch', clear: true, allowPassiveRebase: true, expectedModelSnapshot: snapshotToken, ...target,
          }), { snapshotToken: fresh.snapshotToken, target: draft });
          assert.equal(write.success, false); assert.equal(write.dispatched, false);
          assert.equal(await page.locator('#draft').inputValue(), 'Original');
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}
