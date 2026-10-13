import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

for (const [kind, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${kind}: legacy nested iframe preparation keeps focus inert and respects the final dispatch fence`, async t => {
    const browser = await engine.launch({ headless: true });
    const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
    try {
      const page = await browser.newPage();
      await page.route('https://**.fixture.invalid/**', async route => {
        const host = new URL(route.request().url()).hostname;
        await route.fulfill({ contentType: 'text/html', body: host === 'top.fixture.invalid'
          ? '<!doctype html><iframe src="https://middle.fixture.invalid/"></iframe>'
          : host === 'middle.fixture.invalid' ? '<!doctype html><iframe src="https://editor.fixture.invalid/"></iframe>'
          : '<!doctype html><label>Subject<input name="subject"></label>' });
      });
      await page.goto('https://top.fixture.invalid/');
      await page.waitForFunction(() => document.querySelector('iframe').contentWindow !== null);
      await page.waitForTimeout(100);
      const editor = page.frames().find(frame => frame.url().startsWith('https://editor.fixture.invalid/'));
      assert.ok(editor, 'Resolve the actual third-origin child.');
      const frames = new Map(page.frames().map((frame, index) => [index, frame]));
      const evaluate = async (frame, func, args) => frame.evaluate(({ source, args }) => (0, eval)(`(${source})`)(...args), { source: String(func), args });
      const api = {
        webNavigation: { getAllFrames: async () => [...frames].map(([frameId, frame]) => ({ frameId, url: frame.url() })) },
        scripting: { executeScript: async ({ target, func, args = [] }) => Promise.all(
          [...frames].filter(([id]) => target.allFrames || target.frameIds?.includes(id))
            .map(async ([frameId, frame]) => ({ frameId, result: await evaluate(frame, func, args) }))) },
        tabs: { executeScript: async (_id, { allFrames, frameId, code }) => Promise.all(
          [...frames].filter(([id]) => allFrames || id === frameId).map(([, frame]) => frame.evaluate(code))) },
      };
      globalThis.chrome = api; globalThis.browser = api;
      const { RichTextToolbarProbe } = await import(`../src/${kind}/src/agent/rich-text-toolbar-probe.js`);
      const probe = new RichTextToolbarProbe({});
      const args = { selector: '[name="subject"]', text: 'Owned nested value', clear: true, urlFilter: 'editor.fixture.invalid', matchIndex: 0 };
      let fences = 0;
      const result = await probe.legacyIframeTypeAllFrames(1, args, { beforeDispatch: async frameId => {
        fences++;
        assert.equal(frames.get(frameId), editor);
        assert.equal(await editor.evaluate(() => document.activeElement === document.querySelector('input')), false,
          'Marker preparation must not create an unfenced native focus event.');
        assert.equal(await editor.locator('input').inputValue(), '');
      } });
      assert.equal(result.success, true, JSON.stringify(result)); assert.equal(fences, 1);
      assert.equal(await editor.locator('input').inputValue(), args.text);
      await editor.evaluate(() => { document.querySelector('input').value = ''; document.activeElement.blur(); });
      const controller = new AbortController();
      await assert.rejects(probe.legacyIframeTypeAllFrames(1, args, { abortSignal: controller.signal,
        beforeDispatch: async () => controller.abort(new Error('Stopped during dispatch fencing')) }), /Stopped during dispatch fencing/);
      assert.equal(await editor.locator('input').inputValue(), '', 'Stop during an awaited fence cannot write afterwards.');
      await assert.rejects(probe.legacyIframeTypeAllFrames(1, args, { beforeDispatch: async () => {
        await editor.locator('input').fill('Human edit');
        throw Object.assign(new Error('Physical input changed the observed target'), { code: 'page_feedback_pending' });
      } }), /Physical input changed/);
      assert.equal(await editor.locator('input').inputValue(), 'Human edit', 'A rejected transport fence preserves the user edit.');
      const replaced = await probe.legacyIframeTypeAllFrames(1, args, { beforeDispatch: async () => {
        await editor.goto('https://editor.fixture.invalid/replaced');
      } });
      assert.equal(replaced.success, false); assert.equal(replaced.noDispatch, true);
      assert.equal(await editor.locator('input').inputValue(), '', 'A replacement document never inherits the old marker binding.');
      for (const marker of [
        ['class', 'public-DraftEditor-content'], ['class', 'ProseMirror'], ['class', 'ql-editor'],
        ['class', 'cke_editable'], ['class', 'mce-content-body'], ['class', 'cm-content'],
        ['data-slate-editor', 'true'], ['data-lexical-editor', 'true'],
      ]) await t.test(`${marker.join('=')}: legacy typing preserves the model-owned document`, async () => {
        await editor.evaluate(([attribute, value]) => {
          document.body.innerHTML = '<div id="rich" contenteditable="true">Original <strong>format</strong></div>';
          const el = document.querySelector('#rich'); el.setAttribute(attribute, value);
          window.editorEvents = [];
          for (const name of ['focus', 'beforeinput', 'input']) el.addEventListener(name, () => editorEvents.push(name));
        }, marker);
        const refused = await probe.legacyIframeTypeAllFrames(1, { ...args, selector: '#rich', text: 'Replacement' });
        assert.equal(refused.success, false); assert.equal(refused.noDispatch, true);
        assert.equal(refused.dispatched, false); assert.equal(refused.trustedTypeRequired, true);
        assert.equal(refused.retryable, false);
        assert.equal(await editor.locator('#rich').innerHTML(), 'Original <strong>format</strong>');
        assert.deepEqual(await editor.evaluate(() => editorEvents), []);
      });
    } finally {
      globalThis.chrome = originalChrome; globalThis.browser = originalBrowser;
      await browser.close();
    }
  });
}
