import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { telegramLab } from './quality/native-chat-fixture.mjs';

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: an explicitly cleared verified native composer treats its caret BR as empty without erasing authored breaks`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      const posts = [];
      await page.route('https://web.telegram.org/**', async route => {
        if (route.request().method() === 'POST') {
          posts.push(route.request().postDataJSON()); await route.fulfill({ contentType: 'application/json', body: '{"saved":true}' });
        } else await route.fulfill({ contentType: 'text/html', body: telegramLab });
      });
      await page.goto('https://web.telegram.org/k/#123456');
      await page.evaluate(build => {
        window[build === 'firefox' ? 'browser' : 'chrome'] = { runtime: { getURL: value => value,
          onMessage: { addListener: handler => { window.qaHandler = handler; } } } };
        window.qaCall = (action, params) => new Promise(resolve => qaHandler({ target: 'content',
          action: action === 'type_text' ? 'type' : action, params }, {}, resolve));
        const composer = document.querySelector('.input-message-input');
        // The owned native app reads authored text, as its genuine send handler
        // does. A native caret BR contributes no message body to this model.
        window.qaValue = ''; window.qaEvents = [];
        composer.addEventListener('input', event => { qaValue = composer.textContent; qaEvents.push(event.isTrusted); });
        const save = document.createElement('button'); save.id = 'qaSave'; save.textContent = 'Save owned draft';
        save.onclick = async () => { await fetch('/qa-save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: qaValue }) }); }; document.body.append(save);
      }, build);
      for (const file of ['accessibility-tree.js', 'rich-text-toolbar-heuristic.js', 'chat-observation.js', 'content.js']) {
        await page.addScriptTag({ content: await readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
      }
      const ref = async () => {
        const tree = await page.evaluate(() => qaCall('get_accessibility_tree', { filter: 'all', maxDepth: 15, maxChars: 15000 }));
        const id = tree.pageContent.match(/textbox "Message" \[(ref_\d+)\]/)?.[1]; assert.ok(id); return id;
      };
      const write = async (action, text, clear = true) => page.evaluate(({ action, text, clear, id }) => qaCall(action,
        action === 'type_text' ? { selector: '.input-message-input', text, clear } : { ref_id: id, text, clear }),
      { action, text, clear, id: await ref() });
      const save = async expected => {
        const count = posts.length; await page.locator('#qaSave').click();
        await page.waitForFunction(() => true); while (posts.length === count) await page.waitForTimeout(10);
        assert.equal(posts.at(-1).value, expected, 'Assert the owned application POST, not normalized tool readback.');
      };
      const verify = async expected => {
        const result = await page.evaluate(({ id, expected }) => qaCall('ax_verify_field_value', { ref_id: id, expected }),
          { id: await ref(), expected });
        assert.equal(result.verified, true); assert.equal(result.actual, expected); return result;
      };
      for (const action of ['set_field', 'type_ax', 'type_text']) {
        const draft = await write(action, 'Owned existing draft'); assert.equal(draft.success, true);
        assert.ok(await page.evaluate(() => __wb_get_native_chat_context(document.querySelector('.input-message-input'))));
        const clear = await write(action, '');
        assert.equal(clear.success, true, clear.error); assert.equal(clear.verified, true); await verify('');
        assert.equal(await page.evaluate(() => qaValue), ''); await save('');
        const body = 'Literal <b>text</b> & 🧠\n\nSecond authored line';
        const next = await write(action, body, false);
        assert.equal(next.success, true, next.error); assert.equal(await page.evaluate(() => qaValue), body); await save(body);
      }
      for (const body of ['\n', '\n\n', '\n\n\n', '\nfirst\n', 'first\n\n\nsecond']) {
        const result = await write('set_field', body);
        const html = await page.locator('.input-message-input').evaluate(el => el.innerHTML);
        assert.equal(result.success, true, `${JSON.stringify(body)} ${result.error}; native DOM: ${html}`); await verify(body); await save(body);
      }
      await write('set_field', 'Draft before cancelled delete');
      await page.evaluate(() => document.querySelector('.input-message-input').addEventListener('beforeinput', event => event.preventDefault(), { once: true }));
      const cancelled = await write('set_field', ''); assert.equal(cancelled.noDispatch, true); assert.equal(cancelled.success, false);
      assert.equal(await page.evaluate(() => qaValue), 'Draft before cancelled delete');
      await write('set_field', '');
      await page.locator('.input-message-input').focus(); await page.keyboard.press('Shift+Enter');
      const authored = await page.locator('.input-message-input').evaluate(el => el.innerText);
      assert.notEqual(authored, '');
      const breaks = await write('set_field', '', false);
      assert.equal(breaks.success, true, breaks.error); await verify(authored);
      await write('set_field', 'Owned draft before same-name recipient switch'); await write('set_field', '');
      const rejectedEmptyRead = async () => {
        const result = await page.evaluate(id => qaCall('ax_verify_field_value', { ref_id: id, expected: '' }), await ref());
        assert.equal(result.verified, false); assert.notEqual(result.actual, '');
      };
      await page.evaluate(() => {
        history.replaceState(null, '', '#654321');
        for (const node of document.querySelectorAll('[data-peer-id]')) node.dataset.peerId = '654321';
      });
      assert.equal(await page.evaluate(() => __wb_get_native_chat_context(document.querySelector('.input-message-input'))?.id), 'telegram:k:654321:0');
      await rejectedEmptyRead();
      await page.evaluate(() => {
        history.replaceState(null, '', '#123456');
        for (const node of document.querySelectorAll('[data-peer-id]')) node.dataset.peerId = '123456';
      });
      await rejectedEmptyRead();
      await write('set_field', 'Owned draft before caret replacement'); await write('set_field', '');
      await page.locator('.input-message-input').evaluate(el => el.replaceChildren(document.createElement('br')));
      await rejectedEmptyRead();
      await write('set_field', 'Generic editor must retain strict readback');
      await page.evaluate(() => document.querySelector('.input-message-input').removeAttribute('data-peer-id'));
      const unbound = await write('set_field', ''); assert.equal(unbound.success, false); assert.equal(unbound.outcomeUnknown, true);
      assert.ok(await page.evaluate(() => qaEvents.length > 0 && qaEvents.every(Boolean)), 'Actual application input events remain native and trusted.');
    } finally { await browser.close(); }
  });
}
