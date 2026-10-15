// The recipient guard and the chat observer read a messaging page's texts by
// what they mean, in any language, never by word lists: what a control does
// (message_control: whether it sends something to someone, opens a reply or a
// new post, only works on the draft, or is one of the conversation's own
// tools), which row of a message a field is (message_field: To, Cc, Bcc or
// something else), whether a message's label says the page's own user sent it
// (message_author), and what a sent message's status says (message_status).
// The agent hands its readings to the page with each guard check and chat
// observation; texts consulted unread come back to be read, and the check runs
// again. Until a text is read each check takes it the cautious way: a control
// as one that could send, a field as holding no recipient, a message as
// nobody's in particular.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { fixturePageTextReading, guardProbeWithReadings, stubPageTextReadings } from './semantic-decision-stub.mjs';

// What a model reads these fixtures' names as, beyond the shared oracle: a
// Polish send and photo button, a Turkish reply and post entry, German call and
// more buttons. The former word lists had none of them.
const READINGS = {
  Wyślij: 'send', 'Wyślij zaproszenie': 'send', 'Dodaj zdjęcie': 'draft_tool', Yanıtla: 'reply',
  'Gönderi başlatın': 'new_post', Anrufen: 'conversation_tool', Mehr: 'conversation_tool', Ada: 'other',
};
// The former word lists knew neither these Turkish recipient rows ("Alıcı" is
// To, "Bilgi" is Cc, "Gizli" is Bcc) nor a Turkish own-message label ("Siz:").
const read = (kind, text) => (kind === 'message_control' && READINGS[text]) || fixturePageTextReading(kind, text);
// A model that reads nothing, or reads every control name as something else.
const readNothing = () => null;
const readOther = kind => (kind === 'message_control' ? 'other' : null);
const sources = build => Promise.all(['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js',
  'chat-observation.js', 'content.js'].map(file => readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')));

for (const build of ['chrome', 'firefox']) {
  for (const engine of ['chromium', 'firefox']) {
    test(`${build} build on ${engine}: messaging controls are judged by what their names mean, in any language`, async t => {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const browser = await (engine === 'chromium' ? chromium : firefox).launch({ headless: true });
      const scripts = await sources(build);
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      const call = (action, params = {}) => page.evaluate(message => new Promise(resolve => {
        for (const handler of window.fixtureHandlers) handler(message, {}, resolve);
      }), { target: 'content', action, params });
      const open = async (url, html) => {
        await page.goto(url);
        await page.setContent(`<!doctype html><style>body{margin:0;font:16px sans-serif}button{padding:8px}
          #chat{position:fixed;right:20px;bottom:20px;width:380px}#body{width:260px;height:60px}</style>${html}`);
        await page.evaluate(() => {
          window.fixtureHandlers = [];
          const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: value => value };
          window.chrome = { runtime }; window.browser = { runtime };
        });
        for (const content of scripts) await page.addScriptTag({ content });
      };
      const probe = (params, reader = read) => guardProbeWithReadings(next => call('probe_message_recipient_guard', next), params, reader);
      const click = (selector, adapterName, reader) => probe({ tool: 'click', args: { selector }, adapterName }, reader);
      try {
        await t.test('a send in a language no word list had stays a guarded send without a composer', async () => {
          await open('https://www.linkedin.com/in/ada/', '<main><h1>Ada</h1><button id="t" type="button">Wyślij zaproszenie</button>'
            + '<button id="other" type="button">Obserwuj</button></main>');
          const result = await click('#t', 'linkedin');
          assert.notEqual(result.messageSend, false, JSON.stringify(result));
          assert.equal(result.reasonCode, 'message_commit_without_composer');
          // Any other control there is not a message send.
          assert.equal((await click('#other', 'linkedin')).messageSend, false);
        });

        await t.test('a composer tool in a language no word list had is not a send; a send beside the composer is', async () => {
          await open('https://example.test/chat/rooms/one', '<main><h2>Ada</h2><form id="chat"><textarea id="body" aria-label="Wiadomość">Cześć</textarea>'
            + '<button id="photo" type="button">Dodaj zdjęcie</button><button id="send" type="button">Wyślij</button></form></main>');
          const photo = await click('#photo', 'generic-messaging');
          assert.equal(photo.messageSend, false, JSON.stringify(photo));
          assert.equal(photo.composerUtility, true);
          assert.equal((await click('#send', 'generic-messaging')).messageSend, true);
        });

        await t.test('a mail reply opener is told apart in any language', async () => {
          await open('https://mail.google.com/mail/u/0/#inbox/abc', '<main><h2>Toplantı</h2><div role="button" id="t" tabindex="0">Yanıtla</div></main>');
          const result = await click('#t', 'gmail');
          assert.equal(result.composerSetup, true, JSON.stringify(result));
          assert.notEqual(result.messageSend, false);
        });

        await t.test('a public post entry is told apart in any language', async () => {
          await open('https://www.linkedin.com/feed/', '<main><section><button id="t" type="button"><span>Gönderi başlatın</span></button></section></main>'
            + '<form id="chat"><h2>Ada</h2><textarea id="body">Merhaba</textarea><button id="send" type="button">Send</button></form>');
          const result = await click('#t', 'linkedin');
          assert.equal(result.messageSend, false, JSON.stringify(result));
          assert.equal(result.composerSetup, true);
        });

        await t.test('a conversation header names its contact apart from call and more buttons in any language', async () => {
          await open('https://example.test/chat/rooms/one', `<style>header{display:flex;gap:20px;height:60px;align-items:center}
            #pane{position:absolute;left:300px;top:0;width:700px;height:780px}#log{height:560px}footer{display:flex;gap:12px}</style>
            <aside><button>Sidebar</button></aside><div id="pane"><header><button id="contact" type="button">Ada</button>
            <button type="button">Anrufen</button><button type="button">Mehr</button></header><section id="log"><div>Hallo</div></section>
            <footer><div id="body" contenteditable="true" role="textbox" aria-label="Nachricht">Hallo Ada</div><button id="send" type="button">Senden</button></footer></div>`);
          await page.locator('#body').focus();
          const observed = await probe({ tool: 'observe_active_conversation', args: {}, adapterName: 'generic-messaging' });
          assert.deepEqual(observed.strongIdentityCandidates, ['Ada'], JSON.stringify(observed));
        });

        await t.test('a mail form names its recipient rows in any language', async () => {
          await open('https://mail.example.test/compose', `<div role="dialog" aria-label="Yeni ileti"><form id="mail">
            <label for="f1">Alıcı</label><input id="f1" value="ada@example.test">
            <label for="f2">Bilgi</label><input id="f2" value="bob@example.test">
            <label for="f3">Konu</label><input id="f3" value="Toplantı">
            <div id="body" contenteditable="true" role="textbox" aria-label="İleti">Merhaba</div>
            <button id="send" type="button">Gönder</button></form></div>`);
          const result = await probe({ tool: 'click', args: { selector: '#send' }, adapterName: 'generic-messaging', supportsRecipientSets: true });
          assert.deepEqual(result.strongRecipientCandidates, [{ identity: 'ada@example.test', role: 'to' },
            { identity: 'bob@example.test', role: 'cc' }], JSON.stringify(result));
          // Unread rows hold no recipient yet.
          await open('https://mail.example.test/compose', `<div role="dialog" aria-label="Yeni ileti"><form id="mail">
            <label for="f1">Alıcı</label><input id="f1" value="ada@example.test">
            <div id="body" contenteditable="true" role="textbox" aria-label="İleti">Merhaba</div>
            <button id="send" type="button">Gönder</button></form></div>`);
          const unread = await probe({ tool: 'click', args: { selector: '#send' }, adapterName: 'generic-messaging',
            supportsRecipientSets: true }, (kind, text) => (kind === 'message_field' ? null : read(kind, text)));
          assert.deepEqual(unread.strongRecipientCandidates, [], JSON.stringify(unread));
        });

        await t.test('a Gmail compose with a typed address and a subject field is checked, not failed', async () => {
          // The typed-address pass once called a row reader it could not see,
          // so every Gmail compose with a visible field failed its check.
          await open('https://mail.google.com/mail/u/0/#inbox?compose=new', `<div role="dialog" aria-label="New Message"><form>
            <input name="to" value="ada@example.test"><input name="subjectbox" value="Meeting">
            <div id="body" contenteditable="true" role="textbox" aria-label="Message Body">Hello</div>
            <div id="send" role="button" tabindex="0">Send</div></form></div>`);
          const result = await click('#send', 'gmail');
          assert.equal(result.success, true, JSON.stringify(result));
          assert.deepEqual(result.observedRecipientCandidates.map(item => [item.identity, item.role]), [['ada@example.test', 'to']]);
        });

        await t.test('Gmail chips take their row from its label in any language', async () => {
          await open('https://mail.google.com/mail/u/0/#inbox?compose=new', `<div role="dialog" aria-label="Yeni İleti"><form>
            <div aria-label="Alıcı"><span email="ada@example.test">Ada</span></div>
            <div aria-label="Gizli"><span email="eve@example.test">Eve</span></div>
            <input name="subjectbox" value="Toplantı">
            <div id="body" contenteditable="true" role="textbox" aria-label="İleti Gövdesi">Merhaba</div>
            <div id="send" role="button" tabindex="0">Gönder</div></form></div>`);
          const result = await click('#send', 'gmail');
          assert.deepEqual(result.observedRecipientCandidates.map(item => [item.identity, item.role]),
            [['ada@example.test', 'to'], ['eve@example.test', 'bcc']], JSON.stringify(result));
        });

        await t.test('a message labelled as sent by the user counts toward the sent-body baseline in any language', async () => {
          await open('https://example.test/chat/rooms/one', `<main><h2>Ada</h2><section aria-label="Sohbet">
            <div aria-label="Siz: Merhaba"><span>Merhaba</span></div><div aria-label="Ada: Merhaba"><span>Merhaba</span></div></section>
            <form id="chat"><textarea id="body" aria-label="Mesaj">Merhaba</textarea><button id="send" type="button">Gönder</button></form></main>`);
          // An unread label makes no message the user's.
          const unread = await click('#send', 'generic-messaging', (kind, text) => (kind === 'message_author' ? null : read(kind, text)));
          assert.equal(unread.messageBodyBaselineCount, 0, JSON.stringify(unread));
          const result = await click('#send', 'generic-messaging');
          assert.equal(result.messageBodyBaselineCount, 1, JSON.stringify(result));
        });

        await t.test('the chat observer reads whose a message is from its label in any language', async () => {
          await open('https://example.test/chat/rooms/one', `<div data-conversation-id="room-1"><h2>Ada</h2>
            <div role="log" aria-label="Sohbet"><div role="listitem" aria-label="Siz: Merhaba">Merhaba</div>
            <div role="listitem" aria-label="Ada: Selam">Selam</div></div>
            <form id="chat"><textarea id="body" aria-label="Mesaj">Taslak</textarea><button id="send" type="button">Gönder</button></form></div>`);
          await page.locator('#body').focus();
          const single = await call('observe_chat', { adapterName: 'generic-messaging' });
          assert.deepEqual(single.messages?.map(message => message.direction), ['unknown', 'unknown'], JSON.stringify(single));
          assert.deepEqual(single.pageTextsNeeded?.filter(item => item.kind === 'message_author').map(item => item.text).sort(),
            ['Ada: Selam', 'Siz: Merhaba']);
          const observed = await guardProbeWithReadings(params => call('observe_chat', params), { adapterName: 'generic-messaging' }, read);
          assert.deepEqual(observed.messages.map(message => [message.direction, message.text]),
            [['outgoing', 'Merhaba'], ['unknown', 'Selam']], JSON.stringify(observed));
        });

        await t.test('a name no model could read is kept as one that could send, and asked about again', async () => {
          await open('https://www.linkedin.com/in/ada/', '<main><h1>Ada</h1><button id="t" type="button">Folgen</button></main>');
          const unread = await click('#t', 'linkedin', readNothing);
          assert.notEqual(unread.messageSend, false);
          assert.equal(unread.reasonCode, 'message_control_unread');
          assert.deepEqual(unread.pageTextsNeeded, [{ kind: 'message_control', text: 'Folgen' }], 'the unread name goes back to be read');
          // Read once, the same control is ordinary.
          assert.equal((await click('#t', 'linkedin', readOther)).messageSend, false);
        });
      } finally {
        await browser.close();
      }
    });
  }

  test(`${build}: the agent reads a guard check's unread names once and checks again with them`, async () => {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const agent = new Agent({ getActive: () => ({ supportsVision: false }) });
    const asked = stubPageTextReadings(agent, (kind, item) => read(kind, item.text));
    const sent = [];
    agent._messageRecipientContentProbe = async (_tab, params) => {
      sent.push(params.__wbPageReadings);
      return params.__wbPageReadings?.message_control?.Wyślij === 'send'
        ? { success: true, conclusive: false, messageSend: null, reasonCode: 'message_commit_without_composer' }
        : { success: true, conclusive: false, messageSend: null, reasonCode: 'message_control_unread',
          pageTextsNeeded: [{ kind: 'message_control', text: 'Wyślij' }] };
    };
    const result = await agent._messageRecipientGuardProbe(1, { tool: 'click', args: { selector: '#t' } });
    assert.equal(result.reasonCode, 'message_commit_without_composer');
    assert.deepEqual(asked.map(item => [item.kind, item.text]), [['message_control', 'Wyślij']]);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].message_control, {});
    assert.equal(sent[1].message_control.Wyślij, 'send');
    // Held readings go with the next check; nothing is read again.
    await agent._messageRecipientGuardProbe(1, { tool: 'click', args: { selector: '#t' } });
    assert.equal(asked.length, 1);
    assert.equal(sent.length, 3);
  });

  test(`${build}: a control nobody could read is blocked as retryable, never as a missing composer`, async () => {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const agent = new Agent({ getActive: () => ({ supportsVision: false }) });
    stubPageTextReadings(agent, () => null);
    agent._messageRecipientContentProbe = async () => ({ success: true, conclusive: false, messageSend: null,
      composerAvailable: false, reasonCode: 'message_control_unread', pageTextsNeeded: [{ kind: 'message_control', text: 'Folgen' }] });
    const blocked = await agent._messageRecipientGuardBlock(1, 'click', { selector: '#t' }, 'https://www.linkedin.com/in/ada/');
    assert.equal(blocked?.noDispatch, true);
    assert.equal(blocked.reasonCode, 'message_control_unread');
    assert.equal(blocked.retryable, true);
    assert.match(blocked.error, /could not read in time what this control does/);
  });
}
