// The recipient guard decides what a messaging control does from a model's
// reading of its name, in any language (the message_control question), never
// from word lists: whether it sends something to someone, opens a reply or a
// new post, only works on the draft, or is one of the conversation's own tools
// (call, search, more, back). The agent hands its readings to the page with
// each guard check; names the guard consulted unread come back to be read, and
// the check runs again. Until a name is read the guard treats it as one that
// could send.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { fixtureMessageControlReading, guardProbeWithReadings, stubPageTextReadings } from './semantic-decision-stub.mjs';

// What a model reads these fixtures' names as, beyond the shared oracle: a
// Polish send and photo button, a Turkish reply and post entry, German call and
// more buttons. The former word lists had none of them.
const READINGS = {
  Wyślij: 'send', 'Wyślij zaproszenie': 'send', 'Dodaj zdjęcie': 'draft_tool', Yanıtla: 'reply',
  'Gönderi başlatın': 'new_post', Anrufen: 'conversation_tool', Mehr: 'conversation_tool', Ada: 'other',
};
const read = caption => READINGS[caption] ?? fixtureMessageControlReading(caption);
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

        await t.test('a name no model could read is kept as one that could send, and asked about again', async () => {
          await open('https://www.linkedin.com/in/ada/', '<main><h1>Ada</h1><button id="t" type="button">Folgen</button></main>');
          const unread = await click('#t', 'linkedin', () => null);
          assert.notEqual(unread.messageSend, false);
          assert.equal(unread.reasonCode, 'message_control_unread');
          assert.deepEqual(unread.messageCaptionsNeeded, ['Folgen'], 'the unread name goes back to be read');
          // Read once, the same control is ordinary.
          assert.equal((await click('#t', 'linkedin', () => 'other')).messageSend, false);
        });
      } finally {
        await browser.close();
      }
    });
  }

  test(`${build}: the agent reads a guard check's unread names once and checks again with them`, async () => {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const agent = new Agent({ getActive: () => ({ supportsVision: false }) });
    const asked = stubPageTextReadings(agent, (kind, item) => (kind === 'message_control' ? read(item.text) : null));
    const sent = [];
    agent._messageRecipientContentProbe = async (_tab, params) => {
      sent.push(params.__wbMessageReadings);
      return params.__wbMessageReadings?.Wyślij === 'send'
        ? { success: true, conclusive: false, messageSend: null, reasonCode: 'message_commit_without_composer' }
        : { success: true, conclusive: false, messageSend: null, reasonCode: 'message_control_unread', messageCaptionsNeeded: ['Wyślij'] };
    };
    const result = await agent._messageRecipientGuardProbe(1, { tool: 'click', args: { selector: '#t' } });
    assert.equal(result.reasonCode, 'message_commit_without_composer');
    assert.deepEqual(asked.map(item => [item.kind, item.text]), [['message_control', 'Wyślij']]);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], {});
    assert.equal(sent[1].Wyślij, 'send');
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
      composerAvailable: false, reasonCode: 'message_control_unread', messageCaptionsNeeded: ['Folgen'] });
    const blocked = await agent._messageRecipientGuardBlock(1, 'click', { selector: '#t' }, 'https://www.linkedin.com/in/ada/');
    assert.equal(blocked?.noDispatch, true);
    assert.equal(blocked.reasonCode, 'message_control_unread');
    assert.equal(blocked.retryable, true);
    assert.match(blocked.error, /could not read in time what this control does/);
  });
}
