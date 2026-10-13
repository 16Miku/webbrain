import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const html = kind => `<!doctype html><style>
body{font:16px sans-serif}.chat,#MiddleColumn{width:600px}.Avatar{height:30px;width:30px}
[contenteditable]{min-height:30px}.bubbles-inner,.MessageList{height:150px}
</style>${kind === 'k'
  ? '<div class="chat"><div class="topbar"><div class="chat-info"><div class="user-title"><span class="peer-title" data-peer-id="123456">Owned QA</span></div></div></div><div class="bubbles-inner"></div><div class="input-message-input" data-peer-id="123456" contenteditable="true">Owned exact draft</div></div>'
  : '<div id="MiddleColumn"><div class="MiddleHeader"><div class="ChatInfo"><div class="Avatar" data-peer-id="123456"></div><h3 class="fullName">Owned QA</h3></div></div><div class="MessageList" data-list-key="123456_-1_thread"></div><div id="editable-message-text" contenteditable="true" role="textbox">Owned exact draft</div></div>'}<aside>Owned unrelated counter</aside>`;

// Use the production native reader and the production receipt comparator.
// A same-peer/title clone cannot inherit an earlier draft's node authority.
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) test(`${build}: Telegram draft receipts pin the actual numeric peer identity nodes`, async t => {
  const browser = await engine.launch({ headless: true });
  try {
    const reader = await readFile(new URL(`../src/${build}/src/content/chat-observation.js`, import.meta.url), 'utf8');
    const content = (await readFile(new URL(`../src/${build}/src/content/content.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const start = content.indexOf('  function _sameNativeChatCaretContext('), end = content.indexOf('\n  function _singleEditableCaretBreak(', start);
    assert.ok(start >= 0 && end > start);
    const compare = content.slice(start, end) + '\nwindow.qaSameNativeScope=_sameNativeChatCaretContext;';
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html(new URL(route.request().url()).pathname.includes('/a/') ? 'a' : 'k') }));
    for (const kind of ['a', 'k']) for (const mutation of ['none', 'sidebar', 'identity-clone', 'header-clone']) await t.test(`${kind}/${mutation}`, async () => {
      await page.goto(`https://web.telegram.org/${kind}/#123456`);
      await page.addScriptTag({ content: reader }); await page.addScriptTag({ content: compare });
      const facts = await page.evaluate(({ kind, mutation }) => {
        const composer = document.querySelector(kind === 'a' ? '#editable-message-text' : '.input-message-input');
        const before = __wb_get_native_chat_context(composer);
        if (!before?.peerIdentity) throw new Error('The actual native peer identity node must be pinned.');
        if (mutation === 'sidebar') document.querySelector('aside').append(document.createTextNode(' changed'));
        if (mutation === 'identity-clone') before.peerIdentity.replaceWith(before.peerIdentity.cloneNode(true));
        if (mutation === 'header-clone') before.header.replaceWith(before.header.cloneNode(true));
        const after = __wb_get_native_chat_context(composer);
        return { beforeValid: !!before, afterValid: !!after, samePeer: before.id === after?.id,
          sameScope: qaSameNativeScope(before, after), exactDraft: composer.textContent === 'Owned exact draft' };
      }, { kind, mutation });
      assert.equal(facts.beforeValid, true); assert.equal(facts.afterValid, true);
      assert.equal(facts.samePeer, true); assert.equal(facts.exactDraft, true);
      assert.equal(facts.sameScope, !mutation.endsWith('-clone'));
    });
  } finally { await browser.close(); }
});
