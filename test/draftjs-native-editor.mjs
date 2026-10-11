import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: native DraftJS edits retain literal application data and reject unsupported settled text`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const posts = [];
      await page.route('https://owned-editor.invalid/**', async route => {
        if (route.request().method() === 'POST') {
          posts.push(route.request().postDataJSON()); await route.fulfill({ contentType: 'application/json', body: '{"saved":true}' });
        } else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Owned DraftJS editor</h1><div id="editor" role="textbox" aria-label="Owned editor" contenteditable="true" class="public-DraftEditor-content"></div><button id="save">Save owned draft</button>' });
      });
      await page.goto('https://owned-editor.invalid/editor');
      await page.evaluate(build => {
        window[build === 'firefox' ? 'browser' : 'chrome'] = { runtime: { getURL: value => value, onMessage: { addListener: handler => { window.qaHandler = handler; } } } };
        window.qaCall = (action, params) => new Promise(resolve => qaHandler({ target: 'content', action, params }, {}, resolve));
        window.qaModel = ''; window.qaEvents = []; window.qaUnsupported = false;
        const editor = document.querySelector('#editor');
        const render = value => {
          const root = document.createElement('div'); root.dataset.contents = 'true';
          value.split('\n').forEach((line, index) => {
            const block = document.createElement('div'); block.dataset.block = 'true'; block.dataset.offsetKey = `${index}-0-0`;
            const body = document.createElement('div'); body.className = 'public-DraftStyleDefault-block'; body.dataset.offsetKey = `${index}-0-0`;
            const carrier = document.createElement('span'); carrier.dataset.offsetKey = `${index}-0-0`;
            const leaf = document.createElement(line ? 'span' : 'br'); leaf.dataset.text = 'true'; if (line) leaf.textContent = line;
            carrier.append(leaf); body.append(carrier); block.append(body); root.append(block);
          });
          editor.replaceChildren(root);
        };
        render('');
        editor.addEventListener('input', event => {
          qaEvents.push(event.isTrusted);
          // This owned app reads the browser's native insertion, then renders
          // the same strongly marked document blocks as a model-backed editor.
          qaModel = editor.textContent;
          render(qaModel);
          if (qaUnsupported) {
            const hidden = document.createElement('span'); hidden.dataset.text = 'true'; hidden.textContent = ' hidden unverified suffix'; hidden.style.display = 'none';
            editor.querySelector('.public-DraftStyleDefault-block').append(hidden);
          }
        });
        document.querySelector('#save').onclick = () => fetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: qaModel }) });
      }, build);
      for (const file of ['accessibility-tree.js', 'rich-text-toolbar-heuristic.js', 'content.js']) {
        await page.addScriptTag({ content: await readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
      }
      const write = text => page.evaluate(text => qaCall('type', { selector: '#editor', text, clear: true }), text);
      const literal = 'Literal <b>markup</b> & 🧠 Türkçe ıİşŞğĞüÜöÖçÇ.';
      const valid = await write(literal); assert.equal(valid.success, true, JSON.stringify(valid)); assert.equal(valid.verified, true);
      await page.locator('#save').click(); await page.waitForFunction(() => qaEvents.length > 0); while (!posts.length) await page.waitForTimeout(10);
      assert.equal(posts[0].value, literal, 'Verify real application POST bytes, not the tool\'s normalized readback.');
      assert.ok(await page.evaluate(() => qaEvents.every(Boolean)), 'All actual input events remain trusted.');
      await page.evaluate(() => { qaUnsupported = true; });
      const unknown = await write('matching visible prefix');
      assert.equal(unknown.success, false, 'Unknown model document text must not certify only its matching visible prefix.');
      assert.equal(unknown.verified, false); assert.equal(unknown.dispatched, true); assert.equal(unknown.outcomeUnknown, true);
      assert.equal(unknown.recoveryRequired, 'verify_or_restore_field');
      assert.equal(await page.evaluate(() => qaModel), 'matching visible prefix');
    } finally { await browser.close(); }
  });
}
