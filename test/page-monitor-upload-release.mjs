import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { uploadReleaseHtml } from './lib/upload-release-fixture.mjs';

async function fixture(browser, build) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.route('https://owned-upload.invalid/**', route => route.fulfill({ contentType: 'text/html', body: uploadReleaseHtml }));
  await context.addInitScript(() => {
    window.listeners = []; window.feedback = []; window.qaRunToken = 'upload-release-run';
    const runtime = { onMessage: { addListener: listener => listeners.push(listener), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: qaRunToken, documentToken: message.documentToken };
        if (message.action === 'page_feedback') { feedback.push(message.feedback); return { accepted: true }; }
        return {};
      } };
    window.chrome = window.browser = { runtime };
    window.deliver = (action, params = {}) => new Promise(resolve => {
      for (const listener of listeners) {
        let answered = false;
        const message = action === 'page_monitor_state'
          ? { target: 'content', action, runToken: 'upload-release-run', ...params }
          : { target: 'content', action, params: { runToken: 'upload-release-run', ...params } };
        const asynchronous = listener(message, {}, result => { answered = true; resolve(result); });
        if (answered || asynchronous === true) return;
      }
    });
  });
  for (const name of ['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js'])
    await context.addInitScript({ content: await fs.readFile(new URL(`../src/${build}/src/content/${name}`, import.meta.url), 'utf8') });
  const page = await context.newPage(); await page.goto('https://owned-upload.invalid/owned/repository/releases/new');
  await page.waitForFunction(() => window.__wbPageMonitor?.active); await page.waitForTimeout(180);
  return { context, page };
}

const capture = (page, params = {}) => page.evaluate(params => deliver('page_monitor_capture_model', { includeTree: true, ...params }), params);
const validate = (page, snapshot, selector = '#releases-upload') => page.evaluate(({ snapshot, selector }) => deliver('page_monitor_validate_model', {
  tool: 'upload_file', selector, snapshotToken: snapshot.snapshotToken,
}), { snapshot, selector });
async function attach(page, snapshot, race = null) {
  await page.evaluate(snapshot => {
    window.qaUploadSnapshot = snapshot.snapshotToken;
    return deliver('page_monitor_prepare', { operationId: 'owned-upload', tool: 'upload_file',
      selector: '#releases-upload', expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true });
  }, snapshot);
  if (race) await race(page);
  return page.evaluate(async () => {
    const validation = await deliver('page_monitor_validate_model', { tool: 'upload_file', selector: '#releases-upload',
      snapshotToken: window.qaUploadSnapshot });
    const fence = await deliver('page_monitor_dispatch', { operationId: 'owned-upload', kind: 'input', fenceOnly: true });
    if (validation.ready && fence.ready) __wbPageMonitor.withPreparedDispatch('owned-upload', () => __wbPageMonitor.withLocalDispatch(() => {
      const input = document.getElementById('releases-upload'), transfer = new DataTransfer();
      transfer.items.add(new File(['PK\\u0003\\u0004owned bytes'], 'owned.zip', { type: 'application/zip', lastModified: 1 }));
      input.files = transfer.files; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    }));
    return { validation, fence, events: attachmentEvents, chooserClicks };
  });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: release binary upload has exact widget, recovery and dispatch fences`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const withFixture = async work => {
        const { context, page } = await fixture(browser, build);
        try { await work(page); } finally { await context.close(); }
      };
      await t.test('discovered binary input receives one file, with no Markdown attachment or chooser', () => withFixture(async page => {
        const inventory = await page.evaluate(() => deliver('get_interactive_elements_cdp'));
        assert.equal(inventory.filter(item => item.type === 'file').length, 2);
        assert.equal(inventory.find(item => item.id === 'releases-upload')?.selector, '#releases-upload');
        const snapshot = await capture(page), result = await validate(page, snapshot);
        assert.equal(result.ready, true, JSON.stringify({ result, targetCount: snapshot.targetCount, page: snapshot.page }));
        assert.match(snapshot.page.pageContent, /file input selector="#releases-upload" widget_ref=/);
        await page.evaluate(() => document.getElementById('clock').textContent = '2');
        assert.equal((await validate(page, snapshot)).ready, true);
        const attached = await attach(page, snapshot);
        assert.equal(attached.fence.ready, true); assert.equal(attached.events.binary.length, 1);
        assert.deepEqual(attached.events.markdown, []); assert.equal(attached.chooserClicks, 0);
      }));
      await t.test('a deep discovered input belongs only to a fresh bounded observation', () => withFixture(async page => {
        await page.evaluate(() => {
          const decoration = document.createElement('div'); decoration.hidden = true;
          decoration.innerHTML = '<span></span>'.repeat(5000); document.getElementById('binary-widget').before(decoration);
        });
        const original = await capture(page);
        assert.equal((await validate(page, original)).reason, 'target_uncovered');
        const inventory = await page.evaluate(() => deliver('get_interactive_elements_cdp'));
        const fresh = await capture(page, { uploadTargets: inventory.filter(item => item.type === 'file').map(item => item.selector) });
        assert.equal((await validate(page, original)).ready, false, 'New observation never repairs the old rejected call.');
        assert.equal((await validate(page, fresh)).ready, true);
        const attached = await attach(page, fresh); assert.equal(attached.fence.ready, true); assert.equal(attached.events.binary.length, 1);
      }));
      for (const changeHandler of [false, true]) await t.test(`associated native label ${changeHandler ? 'rejects a changed handler' : 'retains its original handler'}`, () => withFixture(async page => {
        await page.evaluate(() => {
          const button = document.getElementById('binary-button'), label = document.createElement('label');
          label.id = button.id; label.htmlFor = 'releases-upload'; label.textContent = button.textContent;
          label.onclick = () => {}; button.replaceWith(label);
        });
        const snapshot = await capture(page);
        assert.equal((await validate(page, snapshot)).ready, true);
        const attached = await attach(page, snapshot, changeHandler
          ? page => page.evaluate(() => { document.getElementById('binary-button').onclick = () => { window.unexpected = true; }; })
          : undefined);
        assert.equal(attached.fence.ready, !changeHandler);
        assert.equal(attached.events.binary.length, changeHandler ? 0 : 1);
        assert.deepEqual(attached.events.markdown, []);
        assert.equal(attached.chooserClicks, 0);
      }));
      const mutations = [
        ['input replacement', () => { const input = document.getElementById('releases-upload'); input.replaceWith(input.cloneNode()); }],
        ['widget replacement', () => { const widget = document.getElementById('binary-widget'); widget.replaceWith(widget.cloneNode(true)); }],
        ['activation purpose', () => { document.getElementById('binary-button').textContent = 'Upload to another place'; }],
        ['activation handler identity', () => { document.getElementById('binary-button').onclick = () => {}; }],
        ['repository heading', () => { document.querySelector('h1').textContent = 'New release for another/repository'; }],
        ['form association', () => { document.getElementById('releases-upload').setAttribute('form', 'other-form'); }],
        ['accepted type', () => { document.getElementById('releases-upload').accept = 'image/*'; }],
        ['disabled input', () => { document.getElementById('releases-upload').disabled = true; }],
        ['transport aria hidden', () => { document.getElementById('releases-upload').parentElement.setAttribute('aria-hidden', 'true'); }],
        ['hidden widget', () => { document.getElementById('binary-widget').style.display = 'none'; }],
        ['inert widget', () => { document.getElementById('binary-widget').inert = true; }],
        ['second file slot', () => { const extra = document.createElement('input'); extra.type = 'file'; document.getElementById('binary-widget').append(extra); }],
        ['URL', () => { history.replaceState({}, '', '/another/repository/releases/new'); }],
      ];
      for (const [name, mutate] of mutations) await t.test(`${name} between preparation and file assignment blocks both slots`, () => withFixture(async page => {
        const snapshot = await capture(page); assert.equal((await validate(page, snapshot)).ready, true);
        const attached = await attach(page, snapshot, page => page.evaluate(mutate));
        assert.equal(attached.fence.ready, false); assert.deepEqual(attached.events, { markdown: [], binary: [] });
        assert.equal(attached.chooserClicks, 0);
      }));
      await t.test('duplicate selectors cannot acquire a certificate', () => withFixture(async page => {
        const snapshot = await capture(page);
        assert.equal((await validate(page, snapshot, 'input[type=file]')).ready, false);
        await page.evaluate(() => document.getElementById('fc-release-body').id = 'releases-upload');
        assert.equal((await validate(page, snapshot)).ready, false);
      }));
      for (const authority of ['user', 'Stop', 'run', 'document']) await t.test(`${authority} revokes upload authority`, () => withFixture(async page => {
        const snapshot = await capture(page);
        const attached = await attach(page, snapshot, async page => {
          if (authority === 'user') await page.locator('#human').click();
          else if (authority === 'Stop') await page.evaluate(() => deliver('page_monitor_state', { active: false }));
          else if (authority === 'run') await page.evaluate(async () => { qaRunToken = 'another-run'; await deliver('page_monitor_state', { active: true }); });
          else await page.reload();
        });
        assert.equal(attached.validation.ready, false); assert.deepEqual(attached.events, { markdown: [], binary: [] });
      }));
    } finally { await browser.close(); }
  });
}
