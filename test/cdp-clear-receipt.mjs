import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import { Agent } from '../src/chrome/src/agent/agent.js';
import { createHash } from 'node:crypto';

// Native Chromium keyboard events and the actual public CDP/Agent entry paths.
// Everything is served by the owned fixture; no external account or network.
test('native textarea replacement and append canonicalize Windows document separators once', async () => {
  const browser = await chromium.launch({ headless: true });
  const originals = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand };
  try {
    const page = await browser.newPage();
    const session = await page.context().newCDPSession(page);
    const insertions = [];
    cdpClient.attach = async () => ({ attached: true });
    cdpClient.sendCommand = async (_tab, method, params) => {
      if (method === 'Input.insertText') insertions.push(params.text);
      return session.send(method, params);
    };
    for (const route of ['selector', 'focused']) for (const clear of [true, false]) {
      await page.setContent('<textarea id="editor" style="width:800px">Existing draft</textarea>');
      await page.locator('#editor').focus();
      await page.evaluate(() => {
        const el = document.getElementById('editor'); el.setSelectionRange(el.value.length, el.value.length);
      });
      insertions.length = 0;
      const agent = new Agent({}); agent._showAgentTarget = () => {};
      const result = route === 'selector'
        ? await cdpClient.typeText(10, '#editor', 'First\r\n\r\nLast\r', clear)
        : await agent.executeTool(10, 'type_text', { text: 'First\r\n\r\nLast\r', clear });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.verified, true);
      assert.deepEqual(insertions, ['First\n\nLast\n']);
      assert.equal(await page.locator('#editor').inputValue(), (clear ? '' : 'Existing draft') + 'First\n\nLast\n');
    }
    await session.detach();
  } finally {
    Object.assign(cdpClient, originals);
    await browser.close();
  }
});

test('native generic editor clear receipts preserve literal breaks and reject intervention', async () => {
  const browser = await chromium.launch({ headless: true });
  const originals = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand, captureTextClearReceipt: cdpClient.captureTextClearReceipt };
  const originalChrome = globalThis.chrome;
  let checked = 0;
  try {
    const context = await browser.newContext();
    const saved = [];
    await context.route('**/*', route => {
      if (route.request().method() === 'POST') { saved.push(route.request().postDataJSON()); return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); }
      return route.fulfill({ contentType: 'text/html', body: '<div id="editor" contenteditable="true" role="textbox">Owned initial draft</div><input id="other">' });
    });
    const page = await context.newPage();
    await page.goto('https://owned-editor.invalid/');
    const session = await context.newCDPSession(page);
    let intervention = null, insertions = 0, nativeMarkers = false;
    cdpClient.attach = async () => ({ attached: true });
    cdpClient.sendCommand = async (_tab, method, params) => {
      if (method === 'Input.insertText') insertions++;
      if (nativeMarkers && method.startsWith('Input.')) {
        const active = await session.send('Runtime.evaluate', { expression: 'document.activeElement' });
        if (active.result?.objectId) {
          // Use the real transport's app-owned target marker writer.
          await cdpClient._pageAgentObjectTarget(10, active.result.objectId);
          await session.send('Runtime.releaseObject', { objectId: active.result.objectId });
        }
      }
      const result = await session.send(method, params);
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp' && params.key === 'Delete' && intervention) {
        const apply = intervention; intervention = null; await apply();
      }
      return result;
    };
    const reset = async html => {
      await page.setContent('<div id="editor" contenteditable="true" role="textbox">' + html + '</div><input id="other"><button id="save">Save owned text</button>');
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-webbrain-page-revision', 'owned-document:1');
        window.nativeInputs = [];
        document.querySelector('#editor').addEventListener('input', event => nativeInputs.push(event.isTrusted));
        document.querySelector('#save').onclick = () => fetch('/owned-save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: document.querySelector('#editor').innerText }) });
      });
      await page.locator('#editor').focus(); insertions = 0; intervention = null; nativeMarkers = false;
    };
    const write = async (route, text, options = {}) => {
      if (route === 'selector') return cdpClient.typeText(10, '#editor', text, true, null, options);
      const agent = new Agent({}); agent._showAgentTarget = () => {};
      return agent.executeTool(10, 'type_text', { text, clear: true });
    };
    const expected = 'Literal replacement ① 🧠 ıİşŞğĞüÜöÖçÇ';
    for (const route of ['selector', 'focused']) for (const markers of [false, true]) {
      await reset('Owned initial draft');
      nativeMarkers = markers;
      const result = await write(route, expected);
      assert.equal(result.success, true, route + ': ' + JSON.stringify(result));
      assert.equal(result.verified, true);
      assert.equal(await page.locator('#editor').innerText(), expected);
      assert.equal(insertions, 1);
      assert.ok(await page.evaluate(() => nativeInputs.length === 2 && nativeInputs.every(Boolean)), 'Native delete and insertion reach the application once each.');
      const previous = saved.length;
      await page.locator('#save').click();
      await page.waitForFunction(() => true);
      for (let attempt = 0; saved.length === previous && attempt < 20; attempt++) await page.waitForTimeout(10);
      assert.equal(saved.length, previous + 1); assert.equal(saved.at(-1).text, expected);
      assert.equal(createHash('sha256').update(saved.at(-1).text).digest('hex'), createHash('sha256').update(expected).digest('hex'));
      checked++;
    }
    for (const html of ['<br>', '<br><br>']) {
      await reset(html);
      assert.notEqual(await page.locator('#editor').innerText(), '');
      assert.equal(await cdpClient.verifyTextEntry(10, { selector: '#editor', text: '', clear: true }), null,
        'An authored blank line cannot be inferred empty from DOM shape.');
      checked++;
    }
    for (const [name, apply] of [
      ['extra native input', async () => { await page.keyboard.type('User intervention'); }],
      ['extra user Delete with unchanged empty DOM', async () => { await page.keyboard.press('Delete'); }],
      ['changed then restored same caret', async () => { await page.evaluate(() => {
        const el = document.querySelector('#editor'), br = el.firstChild;
        el.replaceChildren(document.createTextNode('Intervention')); el.replaceChildren(br);
      }); }],
      ['focus changed and returned', async () => { await page.evaluate(() => {
        document.querySelector('#other').focus(); document.querySelector('#editor').focus();
      }); }],
      ['blurred to body and returned', async () => { await page.evaluate(() => {
        const el = document.querySelector('#editor'); el.blur(); el.focus();
      }); }],
      ['same node removed and returned', async () => { await page.evaluate(() => {
        const el = document.querySelector('#editor'), parent = el.parentNode, sibling = el.nextSibling;
        el.remove(); parent.insertBefore(el, sibling); el.focus();
      }); }],
      ['selection left and returned', async () => {
        await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#other'));
          const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
        await page.waitForTimeout(5);
        await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#editor')); r.collapse(false);
          const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
      }],
      ['document replaced', async () => { await page.goto('https://owned-editor.invalid/new-document'); }],
    ]) {
      for (const route of ['selector', 'focused']) {
        await reset('Owned initial draft'); intervention = apply;
        const result = await write(route, 'Must never be inserted');
        assert.equal(result.success, false, route + '/' + name + ': ' + JSON.stringify(result));
        assert.equal(insertions, 0, route + '/' + name + ': no replacement after intervention');
        checked++;
      }
    }
    await reset('Owned initial draft');
    const controller = new AbortController();
    intervention = async () => controller.abort(new Error('Owned Stop'));
    await assert.rejects(write('selector', 'Must never be inserted', { abortSignal: controller.signal }), /Owned Stop/);
    assert.equal(insertions, 0); checked++;
    await reset('Owned initial draft');
    let originalOwner = true;
    intervention = async () => { originalOwner = false; };
    const ownerChanged = await write('selector', 'Must never be inserted', { beforeDispatch() {
      if (!originalOwner) throw new Error('The original operation owner ended.');
    } });
    assert.equal(ownerChanged.success, false); assert.equal(insertions, 0); checked++;
    await reset('Owned initial draft');
    await page.evaluate(() => document.querySelector('#editor').addEventListener('beforeinput', event => event.preventDefault(), { once: true }));
    const cancelled = await write('selector', 'Must never be inserted');
    assert.equal(cancelled.success, false); assert.equal(insertions, 0);
    assert.equal(await page.locator('#editor').innerText(), 'Owned initial draft'); checked++;
    for (const route of ['selector', 'focused', 'prepared-focused']) {
      await reset('Owned initial draft');
      const agent = new Agent({}); agent._showAgentTarget = () => {};
      // Claim the real run cancellation owner without starting an unrelated
      // monitor fixture; executeTool still uses its normal native typing path.
      if (route !== 'selector') await agent._claimRunEntry(10, 'interactive', { standaloneChat: true });
      const controller = new AbortController();
      let stopped = false;
      cdpClient.captureTextClearReceipt = async (...args) => {
        const receipt = await originals.captureTextClearReceipt.apply(cdpClient, args);
        assert.ok(receipt);
        return { ...receipt, async verify() {
          const value = await receipt.verify();
          assert.equal(value, true, 'Stop arrives after genuine native clear proof, before replacement.');
          stopped = true;
          if (route === 'selector') controller.abort(new Error('Owned Stop at proof'));
          else agent.abort(10);
          return value;
        } };
      };
      if (route === 'prepared-focused') globalThis.chrome = { ...(originalChrome || {}), tabs: {
        ...(originalChrome?.tabs || {}), async sendMessage(_tab, message) {
          if (message.action === 'prepare_focused_type_dispatch') return page.evaluate(() => {
            const el = document.querySelector('#editor'), r = el.getBoundingClientRect();
            return { success: true, tag: el.tagName, name: el.id, contentEditable: el.isContentEditable,
              rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
          });
          if (message.action === 'release_dispatch_binding') return { success: true };
          throw new Error('No verification or new dispatch may occur after Stop.');
        },
      } };
      try {
        if (route === 'selector') await assert.rejects(cdpClient.typeText(10, '#editor', 'Must never be inserted', true, null,
          { abortSignal: controller.signal }), /Owned Stop at proof/);
        else {
          const result = await agent.executeTool(10, 'type_text', { text: 'Must never be inserted', clear: true }, null,
            route === 'prepared-focused' ? { dispatchBinding: { token: 'owned-fixture-binding', frameId: 0 } } : null);
          assert.equal(result.success, false); assert.equal(result.cancelled, true);
        }
        assert.equal(stopped, true); assert.equal(insertions, 0, route + ': Stop after clear proof prevents replacement');
        assert.notEqual(await page.locator('#editor').innerText(), 'Must never be inserted'); checked++;
      } finally {
        if (route !== 'selector') agent._releaseRunEntry(10);
        cdpClient.captureTextClearReceipt = originals.captureTextClearReceipt;
        globalThis.chrome = originalChrome;
      }
    }
    for (const route of ['selector', 'focused']) {
      await reset('Owned initial draft');
      const empty = await write(route, '');
      assert.notEqual(empty.verified, true, 'A generic application could save the rendered caret LF.');
      assert.equal(insertions, 0); checked++;
    }
    await page.setContent('<iframe id="frame" srcdoc="&lt;div id=editor contenteditable=true&gt;Owned frame draft&lt;/div&gt;"></iframe>');
    const frame = page.frames().find(candidate => candidate !== page.mainFrame());
    await frame.locator('#editor').focus();
    await session.send('DOM.getDocument', { depth: -1, pierce: true });
    const target = await session.send('Runtime.evaluate', {
      expression: 'document.querySelector("#frame").contentDocument.querySelector("#editor")',
    });
    const { nodeId } = await session.send('DOM.requestNode', { objectId: target.result.objectId });
    const frameReceipt = await cdpClient.captureTextClearReceipt(10, { nodeId });
    assert.ok(frameReceipt, 'The receipt resolves the exact editable node in its own frame.');
    for (const type of ['keyDown', 'keyUp']) await session.send('Input.dispatchKeyEvent', {
      type, key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, commands: ['selectAll'],
    });
    for (const type of ['keyDown', 'keyUp']) await session.send('Input.dispatchKeyEvent', {
      type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46,
    });
    assert.equal(await frameReceipt.verify(), true);
    await page.evaluate(() => { document.querySelector('#frame').srcdoc = '<div id="editor" contenteditable="true">New frame</div>'; });
    await page.waitForFunction(() => document.querySelector('#frame').contentDocument?.body?.textContent === 'New frame');
    assert.equal(await frameReceipt.current(), false, 'Replacing only the target frame invalidates its native clear receipt.');
    assert.equal(await frameReceipt.verify(), false);
    await frameReceipt.dispose();
    await session.send('Runtime.releaseObject', { objectId: target.result.objectId });
    checked++;
    const resetShadow = async mode => {
      await page.setContent('<div id="host"></div><input id="outside"><button id="save">Save owned text</button>');
      await page.evaluate(mode => {
        const root = document.querySelector('#host').attachShadow({ mode });
        root.innerHTML = '<section data-recipient="owned"><div id="editor" contenteditable="true" role="textbox">Owned initial draft</div><input id="inside"></section>';
        window.qaShadowRoot = root; window.qaShadowEditor = root.querySelector('#editor');
        window.nativeInputs = [];
        qaShadowEditor.addEventListener('input', event => nativeInputs.push(event.isTrusted));
        document.querySelector('#save').onclick = () => fetch('/owned-save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: qaShadowEditor.innerText }) });
        qaShadowEditor.focus();
      }, mode);
      insertions = 0; intervention = null; nativeMarkers = false;
    };
    for (const mode of ['open', 'closed']) {
      await resetShadow(mode);
      const result = await write('selector', expected);
      assert.equal(result.success, true, mode + ': ' + JSON.stringify(result));
      assert.equal(result.verified, true); assert.equal(insertions, 1);
      assert.equal(await page.evaluate(() => qaShadowEditor.innerText), expected);
      assert.ok(await page.evaluate(() => nativeInputs.length === 2 && nativeInputs.every(Boolean)));
      const previous = saved.length;
      await page.locator('#save').click();
      for (let attempt = 0; saved.length === previous && attempt < 20; attempt++) await page.waitForTimeout(10);
      assert.equal(saved.length, previous + 1); assert.equal(saved.at(-1).text, expected); checked++;
      for (const [name, apply] of [
        ['inside focus-return', async () => page.evaluate(() => { qaShadowRoot.querySelector('#inside').focus(); qaShadowEditor.focus(); })],
        ['outside focus-return', async () => page.evaluate(() => { document.querySelector('#outside').focus(); qaShadowEditor.focus(); })],
        ['inside native extra input', async () => page.keyboard.type('User intervention')],
        ['editor identity changed-returned', async () => page.evaluate(() => { qaShadowEditor.setAttribute('aria-label', 'Changed'); qaShadowEditor.removeAttribute('aria-label'); })],
        ['host identity changed-returned', async () => page.evaluate(() => { const host = document.querySelector('#host'); host.setAttribute('data-recipient', 'other'); host.removeAttribute('data-recipient'); })],
        ['same host removed-returned', async () => page.evaluate(() => { const host = document.querySelector('#host'), after = host.nextSibling;
          host.remove(); document.body.insertBefore(host, after); qaShadowEditor.focus(); })],
        ['document replaced', async () => page.goto('https://owned-editor.invalid/new-shadow-document')],
      ]) {
        await resetShadow(mode); intervention = apply;
        const blocked = await write('selector', 'Must never be inserted');
        assert.equal(blocked.success, false, mode + '/' + name + ': ' + JSON.stringify(blocked));
        assert.equal(insertions, 0); checked++;
      }
      await resetShadow(mode);
      await page.evaluate(() => qaShadowEditor.addEventListener('beforeinput', () => {
        const host = document.querySelector('#host'); host.setAttribute('data-recipient', 'other'); host.removeAttribute('data-recipient');
      }, { once: true }));
      const changedDuringDelete = await write('selector', 'Must never be inserted');
      assert.equal(changedDuringDelete.success, false); assert.equal(insertions, 0); checked++;
      await resetShadow(mode);
      const controller = new AbortController(); let stopped = false;
      cdpClient.captureTextClearReceipt = async (...args) => {
        const receipt = await originals.captureTextClearReceipt.apply(cdpClient, args); assert.ok(receipt);
        return { ...receipt, async verify() {
          assert.equal(await receipt.verify(), true);
          stopped = true; controller.abort(new Error('Owned Stop in shadow proof')); return true;
        } };
      };
      try {
        await assert.rejects(write('selector', 'Must never be inserted', { abortSignal: controller.signal }), /Owned Stop in shadow proof/);
        assert.equal(stopped, true); assert.equal(insertions, 0); checked++;
      } finally { cdpClient.captureTextClearReceipt = originals.captureTextClearReceipt; }
    }
    await session.detach();
  } finally {
    Object.assign(cdpClient, originals); globalThis.chrome = originalChrome; await browser.close();
  }
  assert.equal(checked, 51);
});
