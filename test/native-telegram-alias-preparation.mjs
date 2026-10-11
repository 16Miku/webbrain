import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

// Native WebK structure, owned text only, and no requests to Telegram. This
// exercises the real observer before native profile identity is available.
const fixture = self => `<!doctype html><style>
body{font:16px sans-serif}.chat{width:700px}.topbar{height:48px}.user-title,.peer-title{display:inline-block;min-height:24px}.bubbles-inner{min-height:160px}.bubble{height:32px}.input-message-input{width:600px;min-height:32px}.bubbles-remover-container{width:700px}.bubbles-remover{min-height:40px}
</style><div class="chat"><div class="topbar"><div class="chat-info"><div class="user-title"><span class="peer-title" data-peer-id="123456" data-me-as-notes="${self ? '1' : '0'}">${self ? 'Saved Messages' : 'Owned QA'}</span></div></div></div>
<div class="bubbles-remover-container"><div class="bubbles-remover bubbles-inner"><div class="bubble is-out is-sent" data-mid="8" data-peer-id="987654"><div class="message">Retired text</div></div></div></div>
<div class="scrollable bubbles-scrollable"><div class="bubbles-inner has-rights is-chat"><div class="bubble is-in" data-mid="9" data-peer-id="123456"><div class="message">Owned question</div></div></div></div>
<div class="input-message-input" contenteditable="true" data-peer-id="123456"></div></div><input id="search" aria-label="Search chats">`;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: a cold native Telegram alias exposes read-only preparation without verifying its recipient`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const source = await readFile(new URL(`../src/${build}/src/content/chat-observation.js`, import.meta.url), 'utf8');
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      const prepare = async (self = true, url = 'https://web.telegram.org/k/#@owned_qa') => {
        await page.goto('about:blank');
        await page.goto(url);
        await page.setContent(fixture(self));
        await page.addScriptTag({ content: source });
      };
      const observe = () => page.evaluate(() => window.__wb_observe_chat_dom({ probe: { success: false, composerAvailable: false } }));
      await t.test('unfocused cold Saved Messages offers own Settings, never a verified thread', async () => {
        await prepare();
        const result = await observe();
        assert.equal(result.success, false);
        assert.equal(result.reason, 'native_telegram_alias_binding_required');
        assert.equal(result.nativeTelegramRepair?.phase, 'open_profile_or_settings');
        assert.match(result.error, /Settings/);
        assert.equal(result.conversationId, undefined);
        assert.equal(result.threadKey, undefined);
        assert.equal(result.messages, undefined);
        assert.equal(JSON.stringify(result).includes('owned_qa'), false, 'Do not project the private username in repair metadata.');
        const context = await page.evaluate(() => {
          const value = window.__wb_get_native_telegram_alias_preparation();
          const composer = document.querySelector('.input-message-input');
          return { exists: !!value, peer: value?.peer, sameComposer: value?.composer === composer,
            sameHeader: value?.header === document.querySelector('.topbar'), sameTranscript: value?.transcript === document.querySelector('.bubbles-scrollable > .bubbles-inner'),
            verifiedContext: window.__wb_get_native_chat_context(composer), id: value?.id, service: value?.service };
        });
        assert.deepEqual(context, { exists: true, peer: '123456', sameComposer: true, sameHeader: true, sameTranscript: true, verifiedContext: null, id: undefined, service: undefined });
      });
      await t.test('ordinary contact preparation chooses its current native profile', async () => {
        await prepare(false);
        const result = await observe();
        assert.equal(result.success, false);
        assert.equal(result.nativeTelegramRepair?.phase, 'open_profile_or_settings');
        assert.match(result.error, /native profile/);
      });
      await t.test('geometry-visible fake native editor has no numeric identity and cannot create ambiguity', async () => {
        await prepare();
        await page.evaluate(() => {
          const fake = document.querySelector('.input-message-input').cloneNode(true);
          fake.removeAttribute('data-peer-id'); document.querySelector('.chat').append(fake);
        });
        assert.equal((await observe()).nativeTelegramRepair?.phase, 'open_profile_or_settings');
      });
      await t.test('focused search keeps the ordinary unverified observation', async () => {
        await prepare(); await page.locator('#search').focus();
        const result = await observe();
        assert.equal(result.reason, 'chat_root_unverified');
        assert.equal(result.nativeTelegramRepair, undefined);
        assert.equal(await page.evaluate(() => window.__wb_get_native_telegram_alias_preparation()), null);
      });
      await t.test('native data-me-as-notes is not required for read-only preparation', async () => {
        await prepare();
        for (const flag of ['0', null]) {
          await page.evaluate(flag => {
            const title = document.querySelector('.topbar .peer-title');
            if (flag === null) title.removeAttribute('data-me-as-notes'); else title.setAttribute('data-me-as-notes', flag);
          }, flag);
          assert.equal((await observe()).nativeTelegramRepair?.phase, 'open_profile_or_settings');
          assert.equal(await page.evaluate(() => !!window.__wb_get_native_chat_context(document.querySelector('.input-message-input'))), false);
        }
      });
      await t.test('ordinary negative peer may inspect identity without acquiring send authority', async () => {
        await prepare(false);
        await page.evaluate(() => { for (const node of document.querySelectorAll('.chat [data-peer-id]')) node.dataset.peerId = '-123456'; });
        assert.equal((await observe()).nativeTelegramRepair?.phase, 'open_profile_or_settings');
        assert.equal(await page.evaluate(() => window.__wb_get_native_telegram_alias_preparation()?.peer), '-123456');
      });
      await t.test('only known WebK locations offer this read-only native preparation', async () => {
        for (const url of ['https://web.telegram.org/a/#@owned_qa', 'https://weba.telegram.org/#@owned_qa',
          'https://telegram.org/k/#@owned_qa', 'https://web.telegram.org.evil.test/k/#@owned_qa']) {
          await prepare(true, url);
          assert.equal(await page.evaluate(() => window.__wb_get_native_telegram_alias_preparation()), null, url);
          assert.equal((await observe()).nativeTelegramRepair, undefined, url);
        }
      });
      for (const mutation of ['header-peer','bubble-peer','missing-bubble-peer','malformed-composer','header-topic','two-editors','two-live-panes','retired-only','animating','hidden-root','opacity-header','unsupported-topic','login-route','numeric-route']) {
        await t.test(`no private preparation certificate for ${mutation}`, async () => {
          await prepare();
          await page.evaluate(mutation => {
            const composer = document.querySelector('.input-message-input'), headerPeer = document.querySelector('.topbar .peer-title');
            const live = document.querySelector('.bubbles-scrollable > .bubbles-inner'), bubble = live.querySelector('.bubble');
            if (mutation === 'header-peer') headerPeer.dataset.peerId = '987654';
            if (mutation === 'bubble-peer') bubble.dataset.peerId = '987654';
            if (mutation === 'missing-bubble-peer') bubble.removeAttribute('data-peer-id');
            if (mutation === 'malformed-composer') composer.dataset.peerId = '123456\u200b';
            if (mutation === 'header-topic') headerPeer.dataset.threadId = '0\u200b';
            if (mutation === 'two-editors') composer.after(composer.cloneNode(true));
            if (mutation === 'two-live-panes') live.after(live.cloneNode(true));
            if (mutation === 'retired-only') live.remove();
            if (mutation === 'animating') live.classList.add('is-animating');
            if (mutation === 'hidden-root') document.querySelector('.chat').hidden = true;
            if (mutation === 'opacity-header') document.querySelector('.topbar').style.opacity = '0';
            if (mutation === 'unsupported-topic') location.hash = '@owned_qa?thread=7';
            if (mutation === 'login-route') location.hash = '@owned_qa?tgaddr=tg%3A%2F%2Flogin';
            if (mutation === 'numeric-route') location.hash = '123456';
          }, mutation);
          assert.equal(await page.evaluate(() => window.__wb_get_native_telegram_alias_preparation()), null);
          const result = await observe();
          assert.equal(result.nativeTelegramRepair, undefined, 'An unresolved or contradictory native pane cannot produce an actionable prep proof.');
        });
      }
    } finally { await browser.close(); }
  });
}
