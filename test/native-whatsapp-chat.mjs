import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { fixtureMessageStatusReading } from './semantic-decision-stub.mjs';

// Structural selectors/status come from the user's sanitized current Web DOM.
// All requests are intercepted and all contacts/bodies/IDs below are fixtures.
const fixture = `<!doctype html><style>body{margin:0;font:16px sans-serif}#main{width:800px;padding:16px}[data-testid="conversation-panel-messages"]{height:200px;overflow-y:scroll}[role=row]{padding:8px}[contenteditable]{min-height:30px;border:1px solid #aaa}svg{height:16px;width:16px}</style>
<div id="main" data-testid="conversation-panel-wrapper"><header data-testid="conversation-header"><div role="button" data-testid="conversation-info-header"><span data-testid="conversation-info-header-chat-title">Fixture QA</span><span data-testid="you-label">(You)</span></div></header>
<div data-testid="conversation-panel-body"><div data-testid="conversation-panel-messages"></div></div><footer><div data-testid="conversation-compose-box-input" contenteditable="true" role="textbox" data-tab="10"></div></footer></div>`;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: current native WhatsApp self-chat uses opaque IDs and explicit Read evidence`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const observer = await readFile(new URL(`../src/${build}/src/content/chat-observation.js`, import.meta.url), 'utf8');
      const kernel = await readFile(new URL(`../src/${build}/src/agent/chat-workflow.js`, import.meta.url), 'utf8');
      await page.route('**/*', route => route.fulfill({ contentType: route.request().url().includes('/__qa/kernel.js') ? 'text/javascript' : 'text/html',
        body: route.request().url().includes('/__qa/kernel.js') ? kernel : fixture }));
      await page.goto('https://web.whatsapp.com/'); await page.addScriptTag({ content: observer });
      // What a model reads these status labels as, in any language. content.js
      // keeps the agent's readings; this observer-only page stands in for it.
      const statusReadings = Object.fromEntries(['Read', 'Pending', 'Okundu'].map(text => [text, fixtureMessageStatusReading(text)]));
      await page.evaluate(readings => {
        window.__wb_page_reading = (kind, value) => (kind === 'message_status' ? readings[String(value).trim()] ?? null : null);
      }, statusReadings);
      const result = await page.evaluate(async () => {
        const { createChatSession, advanceChatSession, markChatSendPending, decideChatSend, serializeChatSession } = await import('/__qa/kernel.js');
        const transcript = document.querySelector('[data-testid="conversation-panel-messages"]');
        const composer = document.querySelector('[contenteditable]');
        window.__wb_ax_ref = () => 'composer'; window.__wb_ax_lookup = () => composer;
        const row = (id, text, status = ' Read ') => {
          const outer = document.createElement('div'); outer.setAttribute('role', 'row');
          const node = document.createElement('div'); node.dataset.id = id; node.dataset.testid = `conv-msg-${id}`;
          const container = document.createElement('div'); container.dataset.testid = 'msg-container';
          const content = document.createElement('span'); content.dataset.testid = 'selectable-text'; content.textContent = text;
          const meta = document.createElement('div'); meta.dataset.testid = 'msg-meta'; meta.setAttribute('role', 'button');
          meta.innerHTML = '<span>edited 10:42</span>';
          const indicator = document.createElement('span'); indicator.setAttribute('aria-label', status); indicator.innerHTML = '<svg><path></path></svg>';
          meta.append(indicator); container.append(content, meta); node.append(container); outer.append(node); return outer;
        };
        const observe = () => window.__wb_observe_chat_dom({ probe: { success: true, composerAvailable: true, composerRef: 'composer' } });
        transcript.replaceChildren(row('opaque-Z-last', 'Same self note'), row('opaque-A-first', 'Same self note'));
        const initial = observe(); let session = advanceChatSession(createChatSession(), initial).session;
        const decision = decideChatSend(session, initial, 'New fixture note'); session = markChatSendPending(session, decision);
        const pending = row('another_opaque-ID', 'New fixture note', 'Pending'); transcript.append(pending);
        const withheld = advanceChatSession(session, observe());
        pending.querySelector('[aria-label]').setAttribute('aria-label', ' Read ');
        const delivered = advanceChatSession(withheld.session, observe());
        session = delivered.session;
        // A status in another language verifies a send once a model reads it
        // as delivered; one nobody has read yet verifies nothing.
        transcript.replaceChildren(row('opaque-tr-status', 'Turkish status note', 'Okundu'),
          row('opaque-unread-status', 'Unread status note', 'Zugestellt'));
        const localizedStatus = observe().messages.map(message => message.text);
        const originalKey = initial.threadKey;
        const rich = row('rich-body', 'Nested emoji ');
        const body = rich.querySelector('[data-testid="selectable-text"]');
        const emoji = document.createElement('img'); emoji.dataset.testid = 'selectable-text';
        emoji.dataset.plainText = '🙂'; emoji.alt = 'unrelated image description';
        emoji.width = 18; emoji.height = 18;
        const link = document.createElement('a'); link.dataset.testid = 'selectable-text';
        link.textContent = 'fixture.example'; body.append(emoji, document.createTextNode(' '), link);
        transcript.replaceChildren(rich); const richMessage = observe().messages[0];
        // No numeric or lexical order is meaningful: every distinct opaque row
        // must surface, including one with an ID below every preceding ID.
        let deltas = 0;
        for (let minute = 1; minute <= 720; minute++) {
          transcript.replaceChildren(row(`opaque-${minute % 2 ? 'Z' : 'A'}-${720 - minute}`, 'Recurring self note'));
          const observation = observe(); observation.observedAt = new Date(Date.parse('2026-10-07T00:00:00Z') + minute * 60000).toISOString();
          const step = advanceChatSession(session, observation); deltas += step.newMessages.length; session = step.session;
          if (minute % 240 === 0) session = JSON.parse(JSON.stringify(serializeChatSession(session)));
          if (advanceChatSession(session, observe()).newMessages.length) throw new Error('Unchanged self row was reported twice');
        }
        const historySpacer = document.createElement('div'); historySpacer.style.height = '1000px';
        transcript.replaceChildren(row('opaque-historical-only', 'Retained historical note'), historySpacer); transcript.scrollTop = 0;
        const history = observe(); const historyStep = advanceChatSession(session, history);
        const pendingHistory = markChatSendPending(session, decideChatSend(session, history, 'Retained historical note'));
        const historyPending = advanceChatSession(pendingHistory, history).session.pendingOutbound;
        document.querySelector('[data-testid="you-label"]').remove(); const genericContact = observe();
        const self = document.createElement('span'); self.dataset.testid = 'you-label'; self.textContent = '(You)';
        document.querySelector('header [role=button]').append(self);
        document.querySelector('[data-testid="conversation-info-header-chat-title"]').textContent = 'Other QA account';
        transcript.replaceChildren(row('second-account-id', 'Different account self note'));
        const switched = observe();
        const duplicateText = row('ambiguous-quote', 'Authored body');
        const quote = document.createElement('span'); quote.dataset.testid = 'selectable-text'; quote.textContent = 'Quoted body';
        duplicateText.querySelector('[data-testid="msg-container"]').prepend(quote); transcript.replaceChildren(duplicateText);
        return { initial, pendingWithheld: withheld.session.pendingOutbound !== null, pendingCleared: delivered.session.pendingOutbound === null,
          repeatRejected: decideChatSend(delivered.session, delivered.snapshot, 'New fixture note').reason,
          deltas, seenBound: session.seenMessageIds.length, noNumericWatermark: !session.telegramIncomingHighWater,
          historyMessages: history.messages.length, historyDelta: historyStep.newMessages.length, historyPending: !!historyPending,
          genericContact, switched, accountSwitchAction: advanceChatSession(session, switched).nextAction,
          ambiguousTextMessages: observe().messages.length, originalKey, richMessage, localizedStatus };
      });
      assert.equal(result.initial.success, true);
      assert.equal(result.initial.conversationIdentity, 'Fixture QA');
      assert.deepEqual(result.initial.messages.map(message => message.direction), ['outgoing', 'outgoing']);
      assert.deepEqual(result.initial.messages.map(message => message.text), ['Same self note', 'Same self note']);
      assert.notEqual(result.initial.messages[0].id, result.initial.messages[1].id);
      assert.equal(result.pendingWithheld, true); assert.equal(result.pendingCleared, true);
      assert.equal(result.repeatRejected, 'already_sent');
      assert.deepEqual(result.localizedStatus, ['Turkish status note']);
      assert.equal(result.richMessage.text, 'Nested emoji 🙂 fixture.example',
        'A nested native emoji or link belongs to one authored body and must not erase it or insert its alt description');
      assert.equal(result.deltas, 720); assert.equal(result.seenBound, 200); assert.equal(result.noNumericWatermark, true);
      assert.equal(result.historyMessages, 0); assert.equal(result.historyDelta, 0); assert.equal(result.historyPending, true);
      assert.equal(result.genericContact.success, false, 'Contact-title-only evidence does not establish native recipient binding');
      assert.equal(result.switched.success, true); assert.notEqual(result.switched.threadKey, result.originalKey);
      assert.equal(result.accountSwitchAction, 'pause_for_user');
      assert.equal(result.ambiguousTextMessages, 0, 'Quoted/attachment text ambiguity must not verify an exact body');
    } finally { await browser.close(); }
  });
}
