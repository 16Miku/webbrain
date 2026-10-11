import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

// Drive the production content handler in both browser engines. Application
// state is populated only by native input events and saved through a POST;
// readback normalization cannot hide a different persisted document.
const texts = [
  'first\nsecond', 'first\n\nsecond', 'first\n\n\nsecond',
  '\nfirst\n', '\n\nfirst\n\n', '\n', '\n\n\n',
  'first\r\n\r\nsecond\r\n',
  '  spaces   and\ttab\u00a0nonbreaking  ',
  'Türkçe ı İ; 中文; العربية; 🧠 🧑🏽‍💻; e\u0301',
  '<script>window.literalExecuted=true</script> & <b>literal</b> "quotes"',
];
const normalized = value => value.replace(/\r\n?/g, '\n');
for (const [kind, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${kind}: native editor writes preserve the exact application POST, whitespace and literal markup`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      const saves = [];
      await page.route('https://owned-editor.fixture.invalid/**', async route => {
        if (route.request().method() === 'POST') {
          saves.push(route.request().postDataJSON());
          await route.fulfill({ contentType: 'application/json', body: '{"saved":true}' });
        } else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="fixture"></main>' });
      });
      await page.goto('https://owned-editor.fixture.invalid/editor');
      await page.evaluate(kind => {
        const api = { runtime: { getURL: value => value, onMessage: { addListener: handler => { window.qaHandler = handler; } } } };
        window[kind === 'firefox' ? 'browser' : 'chrome'] = api;
        window.qaCall = (action, params) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Content handler did not answer ${action}`)), 5000);
          qaHandler({ target: 'content', action: action === 'type_text' ? 'type' : action, params }, {}, value => { clearTimeout(timer); resolve(value); });
        });
      }, kind);
      for (const filename of ['accessibility-tree.js', 'rich-text-toolbar-heuristic.js', 'content.js']) {
        await page.addScriptTag({ content: await readFile(new URL(`../src/${kind}/src/content/${filename}`, import.meta.url), 'utf8') });
      }
      const prepare = async ({ style = 'normal', previous = '', behavior = '' } = {}) => {
        await page.evaluate(({ style, previous, behavior }) => {
          document.querySelector('#fixture').innerHTML = `<form><div id="editor" role="textbox" aria-label="Exact editor" contenteditable="true" style="white-space:${style};width:500px;min-height:70px"></div><button>Save</button></form><div id="other" contenteditable="true">Other</div><pre id="preview"></pre>`;
          const editor = document.querySelector('#editor');
          editor.innerHTML = previous;
          window.qaOriginalStrong = editor.querySelector('strong');
          window.qaValue = editor.innerText;
          window.qaInputEvents = [];
          editor.addEventListener('input', event => {
            qaValue = editor.innerText;
            qaInputEvents.push({ trusted: event.isTrusted, inputType: event.inputType });
          });
          if (behavior === 'cancel') editor.addEventListener('beforeinput', event => event.preventDefault());
          if (behavior === 'selection') editor.addEventListener('beforeinput', () => {
            const range = document.createRange(); range.selectNodeContents(document.querySelector('#other'));
            const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          });
          if (behavior === 'corrupt') editor.addEventListener('input', () => {
            editor.append(document.createTextNode('!')); qaValue = editor.innerText;
          });
          document.querySelector('form').onsubmit = async event => {
            event.preventDefault(); await fetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: qaValue }) });
            document.querySelector('#preview').textContent = qaValue;
          };
        }, { style, previous, behavior });
        const tree = await page.evaluate(() => qaCall('get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 10000 }));
        const ref = String(tree.pageContent).match(/textbox "Exact editor" \[(ref_\d+)\]/)?.[1];
        assert.ok(ref, 'Resolve the actual current editor from a fresh production AX tree.');
        return ref;
      };
      for (const style of ['normal', 'pre-wrap']) for (const action of ['type_text', 'type_ax', 'set_field']) for (const text of texts) {
        const ref = await prepare({ style });
        const result = await page.evaluate(({ action, ref, text }) => qaCall(action,
          action === 'type_text' ? { selector: '#editor', text, clear: true } : { ref_id: ref, text, clear: true }), { action, ref, text });
        assert.equal(result.success, true, `${kind}/${style}/${action}: native write must settle successfully: ${result.error || ''}`);
        assert.equal(result.verified, true);
        const state = await page.evaluate(() => ({ value: qaValue, text: document.querySelector('#editor').innerText, events: qaInputEvents,
          interpretedMarkup: !!document.querySelector('#editor script,#editor b'), executed: !!window.literalExecuted }));
        assert.equal(state.value, normalized(text), `${kind}/${style}/${action}: app input state preserves every literal character`);
        assert.equal(state.text, normalized(text));
        assert.ok(state.events.length > 0 && state.events.every(event => event.trusted), 'The actual application receives native trusted input events.');
        assert.equal(state.interpretedMarkup, false); assert.equal(state.executed, false);
        const count = saves.length;
        await page.locator('button').click();
        await page.waitForFunction(value => document.querySelector('#preview').textContent === value, normalized(text), { timeout: 5000 });
        assert.equal(saves.length, count + 1);
        assert.equal(saves.at(-1).value, normalized(text), 'Compare the real application POST, not a normalized tool result.');
      }
      for (const action of ['type_text', 'type_ax', 'set_field']) {
        const ref = await prepare({ previous: '<strong>Original</strong>' });
        const suffix = '\n\n\n  literal <b>append</b> e\u0301 🧠\n';
        const result = await page.evaluate(({ action, ref, suffix }) => qaCall(action,
          action === 'type_text' ? { selector: '#editor', text: suffix, clear: false } : { ref_id: ref, text: suffix, clear: false }), { action, ref, suffix });
        assert.equal(result.success, true, result.error);
        assert.equal(await page.locator('#editor').evaluate(el => el.innerText), 'Original' + suffix);
        assert.equal(await page.locator('#editor strong').textContent(), 'Original', 'Appending keeps existing rich nodes.');
        assert.equal(await page.evaluate(() => qaOriginalStrong?.isConnected === true
          && document.querySelector('#editor strong') === qaOriginalStrong), true, 'Append preserves the original rich node identity.');
      }
      for (const behavior of ['cancel', 'selection']) {
        const ref = await prepare({ behavior });
        const result = await page.evaluate(ref => qaCall('set_field', { ref_id: ref, text: 'Must not appear', clear: true }), ref);
        assert.equal(result.success, false); assert.equal(result.noDispatch, true);
        assert.equal(await page.locator('#editor').evaluate(el => el.innerText), '');
        assert.equal(await page.evaluate(() => qaInputEvents.length), 0);
      }
      const ref = await prepare({ behavior: 'corrupt' });
      const corrupt = await page.evaluate(ref => qaCall('set_field', { ref_id: ref, text: 'First\n\nSecond', clear: true }), ref);
      assert.equal(corrupt.success, false); assert.equal(corrupt.verified, false);
      assert.equal(corrupt.dispatched, true); assert.equal(corrupt.outcomeUnknown, true);
    } finally { await browser.close(); }
  });
}
