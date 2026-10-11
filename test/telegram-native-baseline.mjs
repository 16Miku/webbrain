import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

// A send baseline is a private mounted native-ID floor, not a claim that the
// conversation history has been read. Exercise the real content probe in both
// native browser engines and the real completion invariant consuming its floor.
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const invariant = await import(`../src/${build}/src/agent/completion-invariant.js`);
  test(`${build}: long native Telegram histories retain a bounded complete send floor`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      const sources = await Promise.all(['rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'chat-observation.js', 'content.js']
        .map(file => readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')));
      const prepare = async (count = 235) => {
        await page.goto('about:blank');
        await page.goto('https://web.telegram.org/k/#123456');
        await page.setContent(`<!doctype html><style>body{margin:20px;font:16px sans-serif}.chat{width:800px}.topbar{height:60px}.bubbles-scrollable{height:500px;overflow-y:auto}.bubble{height:25px}.input-message-input{width:650px;min-height:32px}button{height:32px}</style>
          <div class="chat"><div class="topbar"><div class="chat-info"><div class="user-title"><span class="peer-title" data-peer-id="123456">Owned QA</span></div></div></div>
          <div class="bubbles scrolled-down"><div class="bubbles-scrollable"><div class="bubbles-inner"></div></div></div><div class="input-message-input" contenteditable="true" role="textbox" data-peer-id="123456">Owned exact reply</div><button id="send" aria-label="Send">Send</button></div>`);
        await page.evaluate(count => {
          window.fixtureHandlers = []; window.actualSends = 0;
          const runtime = { onMessage: { addListener(fn) { fixtureHandlers.push(fn); } }, getURL: value => value };
          window.chrome = window.browser = { runtime };
          for (let id = 1; id <= count; id++) {
            const row = document.createElement('div'); row.className = 'bubble is-in';
            row.dataset.mid = String(id); row.dataset.peerId = '123456';
            const body = document.createElement('div'); body.className = 'message'; body.textContent = 'Owned historical row ' + id;
            row.append(body); document.querySelector('.bubbles-inner').append(row);
          }
          const scroll = document.querySelector('.bubbles-scrollable'); scroll.scrollTop = scroll.scrollHeight;
          send.onclick = () => actualSends++;
        }, count);
        for (const source of sources) await page.addScriptTag({ content: source });
        await page.locator('.input-message-input').focus();
      };
      const call = (action, params = {}) => page.evaluate(message => new Promise(resolve => {
        for (const handler of fixtureHandlers) handler(message, {}, resolve);
      }), { target: 'content', action, params });
      const probe = async () => {
        await call('get_accessibility_tree', { filter: 'all' });
        const ref_id = await page.locator('.input-message-input').evaluate(node => __wb_ax_ref(node));
        return call('probe_message_recipient_guard', { tool: 'set_field',
          args: { ref_id, text: 'Owned exact reply', clear: true, submit: true },
          adapterName: 'telegram', bindDispatch: true });
      };

      for (const count of [200, 235, 1000]) await t.test(`${count} mounted native rows prove only a bounded ID floor`, async () => {
        await prepare(count);
        const result = await probe();
        assert.equal(result.success, true); assert.equal(result.messageSend, true, JSON.stringify({error: result.error, reason: result.reason, reasonCode:result.reasonCode, conclusive:result.conclusive, keys:Object.keys(result), baselinePresent: !!result.nativeChatMessageBaseline}));
        assert.equal(result.nativeChatMessageBaseline?.complete, true);
        assert.equal(result.nativeChatMessageBaseline.coverage, 'mounted_native_id_floor');
        assert.equal(result.nativeChatMessageBaseline.messageIds.length, 200);
        assert.equal(new Set(result.nativeChatMessageBaseline.messageIds).size, 200);
        assert.ok(result.nativeChatMessageBaseline.messageIds.includes(`telegram:k:123456:0:${count}`));
        const observation = await call('observe_chat');
        assert.equal(observation.success, true); assert.equal(observation.messages.length, 200);
        assert.equal(await page.evaluate(() => actualSends), 0, 'Probing the floor neither sends nor reads all history.');
      });

      await t.test('a maximum ID before the trailing cache still prevents old outgoing evidence', async () => {
        await prepare();
        await page.locator('.bubble').first().evaluate(node => { node.dataset.mid = '9000'; });
        const result = await probe(), baseline = result.nativeChatMessageBaseline;
        assert.equal(baseline.complete, true); assert.equal(baseline.messageIds.length, 200);
        assert.ok(baseline.messageIds.includes('telegram:k:123456:0:9000'));
        const threadKey = baseline.threadKey;
        const action = invariant.recordCompletionToolResult(invariant.createCompletionInvariantState('owned-run'), 'click_ax', {},
          { success: true, dispatched: true }, { chatDeliveryBinding: { ...baseline, body: 'Owned exact reply' } });
        for (const id of ['235', '9000', '9001']) {
          const evidence = { success: true, threadKey, composer: { available: true, empty: true },
            chatWorkflow: { threadKey, pendingOutbound: false }, chatDeliveryVerification: {
              schema: 'webbrain-chat-completion/1', threadKey, actionSequence: action.lastAction.sequence,
              messageId: `telegram:k:123456:0:${id}` } };
          assert.equal(invariant.recordCompletionToolResult(action, 'chat_observe', {}, evidence).verificationDebt, id !== '9001');
        }
        assert.equal(await page.evaluate(() => actualSends), 0);
      });

      for (const mutation of ['duplicate-old-id', 'malformed-old-id', 'wrong-old-peer', 'missing-old-peer', 'old-pending']) {
        await t.test(`a row outside the last 200 cannot hide ${mutation}`, async () => {
          await prepare();
          await page.locator('.bubble').first().evaluate((node, mutation) => {
            if (mutation === 'duplicate-old-id') node.dataset.mid = '2';
            if (mutation === 'malformed-old-id') node.dataset.mid = '1x';
            if (mutation === 'wrong-old-peer') node.dataset.peerId = '987654';
            if (mutation === 'missing-old-peer') node.removeAttribute('data-peer-id');
            if (mutation === 'old-pending') node.className = 'bubble is-out is-sending';
          }, mutation);
          const result = await probe();
          assert.notEqual(result.nativeChatMessageBaseline?.complete, true);
          assert.equal(await page.evaluate(() => actualSends), 0);
        });
      }

      await t.test('a non-main topic remains unverified despite a large valid history', async () => {
        await prepare();
        await page.locator('.peer-title').evaluate(node => { node.dataset.threadId = '7'; });
        const result = await probe(); assert.notEqual(result.conclusive, true);
        assert.notEqual(result.nativeChatMessageBaseline?.complete, true);
        assert.equal(await page.evaluate(() => actualSends), 0);
      });
    } finally { await browser.close(); }
  });
}
