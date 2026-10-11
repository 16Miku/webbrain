import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { telegramLab } from './quality/native-chat-fixture.mjs';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: private native-chat clear receipt accepts one scoped native delete and rejects intervention`, async t => {
    const browser = await engine.launch({ headless: true });
    const sources = await Promise.all(['accessibility-tree.js', 'rich-text-toolbar-heuristic.js', 'chat-observation.js', 'content.js']
      .map(file => readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')));
    try {
      for (const fault of ['none', 'cdp-first', 'checkpoint-first', 'cancelled', 'cancelled-mutating', 'beforeinput-restored', 'synthetic', 'partial-selection-authored-break', 'extra-delete', 'caret-replaced', 'identity-restored', 'focus-restored', 'selection-restored', 'authored-break', 'generic']) await t.test(fault, async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: telegramLab }));
        await page.goto('https://web.telegram.org/k/#123456');
        await page.evaluate(build => {
          window[build === 'firefox' ? 'browser' : 'chrome'] = { runtime: { getURL: value => value,
            onMessage: { addListener: handler => { window.qaHandler = handler; } } } };
          window.qaCall = (action, params) => new Promise(resolve => qaHandler({ target: 'content', action, params }, {}, resolve));
          window.qaInputs = [];
          document.querySelector('.input-message-input').addEventListener('input', event => qaInputs.push({ trusted: event.isTrusted, inputType: event.inputType }));
        }, build);
        for (const source of sources) await page.addScriptTag({ content: source });
        const composer = page.locator('.input-message-input');
        await composer.focus(); await page.keyboard.insertText('Owned draft before native clear');
        if (fault === 'partial-selection-authored-break') await composer.evaluate(el => {
          window.qaAuthoredBreak = document.createElement('br'); el.append(qaAuthoredBreak);
        });
        await composer.selectText();
        if (fault === 'generic') await composer.evaluate(el => el.removeAttribute('data-peer-id'));
        if (fault === 'authored-break') await composer.evaluate(el => el.replaceChildren(document.createElement('br')));
        const ref = await composer.evaluate(el => __wb_ax_ref(el));
        const call = (action, params = {}) => page.evaluate(({ action, params }) => qaCall(action, params), { action, params });
        const positive = ['none', 'cdp-first', 'checkpoint-first'].includes(fault);
        if (fault === 'checkpoint-first') await page.evaluate(() => {
          window.qaOrder = [];
          window.addEventListener('input', event => {
            if (event.isTrusted && event.inputType === 'deleteContentForward') {
              qaOrder.push('first-listener'); queueMicrotask(() => qaOrder.push('microtask'));
            }
          }, true);
        });
        let session, cdpReceipt;
        const originalCommand = cdpClient.sendCommand;
        const capture = async () => {
          session = await context.newCDPSession(page);
          cdpClient.sendCommand = (_tab, method, params) => session.send(method, params);
          cdpReceipt = await cdpClient.captureTextClearReceipt(10, { focused: true });
          assert.ok(cdpReceipt);
        };
        if (build === 'chrome' && fault === 'cdp-first') await capture();
        const prepared = await call('ax_prepare_native_chat_clear', { ref_id: ref });
        if (fault === 'generic' || fault === 'authored-break') {
          assert.equal(prepared.success, false, 'An unbound editor or pre-existing authored BR cannot acquire native empty authority.');
          assert.equal(prepared.token, undefined); await context.close(); return;
        }
        assert.equal(prepared.success, true, JSON.stringify(prepared)); assert.ok(prepared.token);
        if (build === 'chrome' && !cdpReceipt) await capture();
        if (fault === 'checkpoint-first') await page.evaluate(() => window.addEventListener('input', event => {
          if (event.isTrusted && event.inputType === 'deleteContentForward') qaOrder.push('last-listener');
        }, true));
        if (fault === 'cancelled') await composer.evaluate(el => el.addEventListener('beforeinput', event => event.preventDefault(), { once: true }));
        if (fault === 'cancelled-mutating') await composer.evaluate(el => el.addEventListener('beforeinput', event => {
          event.preventDefault(); el.replaceChildren(document.createElement('br'));
        }, { once: true }));
        if (fault === 'beforeinput-restored') await composer.evaluate(el => el.addEventListener('beforeinput', () => {
          const original = el.firstChild; el.replaceChildren(document.createTextNode('Changed draft')); el.replaceChildren(original);
          const range = document.createRange(); range.selectNodeContents(el);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }, { once: true }));
        if (fault === 'partial-selection-authored-break') await composer.evaluate(el => el.addEventListener('keydown', event => {
          if (event.code !== 'KeyA') return;
          event.preventDefault(); const range = document.createRange();
          range.setStart(el.firstChild, 0); range.setEnd(el.firstChild, el.firstChild.length);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }));
        if (fault === 'synthetic') await composer.evaluate(el => {
          for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true }));
          el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentForward', bubbles: true }));
          el.replaceChildren(document.createElement('br'));
          el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentForward', bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Delete', code: 'Delete', bubbles: true }));
        });
        else {
          if (build === 'chrome') {
            await session.send('Input.dispatchKeyEvent', { type:'keyDown', key:'a', code:'KeyA', modifiers:2, windowsVirtualKeyCode:65, commands:['selectAll'] });
            await session.send('Input.dispatchKeyEvent', { type:'keyUp', key:'a', code:'KeyA', modifiers:2, windowsVirtualKeyCode:65 });
            await session.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Delete', code:'Delete', windowsVirtualKeyCode:46 });
            await session.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Delete', code:'Delete', windowsVirtualKeyCode:46 });
          } else {
            await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Delete');
          }
        }
        if (fault === 'extra-delete') await page.keyboard.press('Delete');
        if (fault === 'caret-replaced') await composer.evaluate(el => el.replaceChildren(document.createElement('br')));
        if (fault === 'identity-restored') await page.evaluate(() => {
          const carrier = document.querySelector('.input-message-input');
          carrier.dataset.peerId = '654321'; carrier.dataset.peerId = '123456';
        });
        if (fault === 'focus-restored') await page.evaluate(() => {
          const button = document.querySelector('button'); button.focus(); document.querySelector('.input-message-input').focus();
        });
        if (fault === 'selection-restored') {
          await page.evaluate(() => {
            const range = document.createRange(); range.selectNodeContents(document.querySelector('button'));
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          });
          await page.waitForTimeout(10);
          await page.evaluate(() => {
            const range = document.createRange(); range.selectNodeContents(document.querySelector('.input-message-input')); range.collapse(false);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          });
        }
        await page.waitForTimeout(40);
        if (cdpReceipt) {
          const nativeVerified = await cdpReceipt.verify();
          await cdpReceipt.dispose(); cdpClient.sendCommand = originalCommand;
          assert.equal(nativeVerified, positive, 'Main-world CDP proof must survive the installed content listeners and reject native interventions.');
        }
        const verified = await call('ax_verify_native_chat_clear', { ref_id: ref, token: prepared.token });
        const value = await call('ax_verify_field_value', { ref_id: ref, expected: '' });
        assert.equal(verified.success, positive, JSON.stringify({ fault, verified, value }));
        assert.equal(value.verified, positive);
        assert.equal((await call('ax_verify_native_chat_clear', { ref_id: ref, token: prepared.token })).success, false, 'The private token is single-use.');
        const inputs = await page.evaluate(() => qaInputs);
        if (positive) {
          assert.equal(value.actual, ''); assert.equal(await composer.textContent(), '');
          assert.deepEqual(inputs, [{ trusted: true, inputType: build === 'firefox' ? 'insertCompositionText' : 'insertText' },
            { trusted: true, inputType: 'deleteContentForward' }]);
          if (fault === 'checkpoint-first') assert.deepEqual(await page.evaluate(() => qaOrder),
            build === 'chrome' ? ['first-listener', 'microtask', 'last-listener'] : ['first-listener', 'last-listener', 'microtask'],
            'Chromium yields a real listener checkpoint before receipt input; Firefox finishes the event first.');
        } else {
          assert.notEqual(value.actual, '', 'Rejected proof must preserve the actual nonempty or literal-BR readback.');
          if (fault === 'partial-selection-authored-break') {
            assert.equal(value.actual, '\n');
            assert.equal(await composer.evaluate(el => el.firstChild === qaAuthoredBreak), true,
              'The original authored BR remains literal even after one genuine native text deletion.');
          }
        }
        await context.close();
      });
    } finally { await browser.close(); }
  });
}
