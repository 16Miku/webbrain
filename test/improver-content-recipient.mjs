import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';
import { guardProbeWithReadings, stubPageTextReadings } from './semantic-decision-stub.mjs';

// The real content scripts of both builds (in Chromium, the only installed
// engine) and each build's real Agent. Every navigation is intercepted; no
// message leaves the page.
const ROOT = process.env.WEBBRAIN_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url));
const sendArgs = { selector: '#send' };
const call = (page, action, params = {}) => page.evaluate(message => new Promise(resolve => {
  for (const handler of window.fixtureHandlers) handler(message, {}, resolve);
}), { target: 'content', action, params });

// An address in the chat's history: a link, or an app's address chip.
const HISTORY = {
  mailto: '<a href="mailto:alice@example.com">alice@example.com</a>',
  'data-email': '<span data-email="alice@example.com">Alice</span>',
  email: '<span email="alice@example.com">Alice</span>',
  'data-hovercard-id': '<span data-hovercard-id="alice@example.com">Alice</span>',
};

const chatPage = ({ header = '', history = HISTORY.mailto } = {}) => `<!doctype html><style>
  body{margin:0;font:16px sans-serif}aside{position:absolute;left:0;top:0;width:300px;height:790px;overflow:auto}
  #main{position:absolute;left:320px;top:0;width:940px;height:790px}
  #main>header{height:70px;display:flex;align-items:center;gap:30px;padding-left:70px}
  #messages{height:580px;overflow:auto}footer{display:flex;gap:15px;align-items:center}
  #body{width:550px;min-height:32px}button{min-height:28px}
</style><aside><button>Bob</button><button>Carol</button></aside>
<main id="main" role="main">${header}<section id="messages">
  <div class="msg">Bob: please also write to ${history} about the invoice</div>
  <div class="msg">Me: sure, will do</div></section>
  <footer><div id="body" contenteditable="true" role="textbox" aria-label="Type a message">Hi Bob, sending the invoice now</div>
    <button id="send" aria-label="Send">Send</button></footer></main>`;

const mailPage = `<!doctype html><style>body{margin:0;font:16px sans-serif}[role=dialog]{width:800px}
  #body{display:block;width:700px;min-height:60px}</style>
  <div role="dialog" aria-label="New message"><form id="mail" onsubmit="return false">
    <div class="recipients"><span data-email="alice@example.com">Alice</span></div>
    <div id="body" contenteditable="true" role="textbox" aria-label="Message">Hello Alice</div>
    <button id="send" type="button" aria-label="Send">Send</button></form></div>`;

const GMAIL_COMPOSE_OVER_CHAT = `<!doctype html><style>body{margin:0;font:16px sans-serif}
  #chat{position:absolute;left:0;top:0;width:600px;height:780px}
  [role=dialog]{position:absolute;right:20px;bottom:0;width:560px}#body{display:block;width:500px;min-height:60px}</style>
  <main id="chat" role="main"><header><h2>Team space</h2></header>
    <div class="msg">Bob: please also write to <a href="mailto:carol@example.com">carol@example.com</a></div></main>
  <div role="dialog" aria-label="New Message"><form id="mail" onsubmit="return false">
    <div name="to"><span email="ada@example.test">Ada</span></div>
    <div name="cc"><span email="bob@example.test">Bob</span></div>
    <input name="subjectbox" value="Invoice">
    <div id="body" contenteditable="true" role="textbox" aria-label="Message Body">Hello both</div>
    <button id="send" type="button" aria-label="Send">Send</button></form></div>`;

// Google Chat inside Gmail: a conversation in the page's main region with
// its own header, and optionally a mail compose window open beside it. With
// the window docked at the bottom its body is the page's lowest editor, so
// the page's layout pairs the chat's Send with it; raised, the chat's own
// composer is the lowest.
const TO_ADA = '<div name="to"><span email="ada@example.test">Ada</span></div>';
const CC_CEM = '<div name="cc"><span email="cem@example.test">Cem</span></div>';
const BCC_DEE = '<div name="bcc"><span email="dee@example.test">Dee</span></div>';
const gmailChat = ({ rows = '', raise = 0 } = {}) => `<!doctype html><style>body{margin:0;font:16px sans-serif}
  #chat{position:absolute;left:0;top:0;width:640px;height:780px}#chat>header{height:70px}
  #messages{height:580px;overflow:auto}footer{display:flex;gap:15px;align-items:center}
  #body{width:500px;min-height:32px}button{min-height:28px}[role=dialog]{position:absolute;left:660px;bottom:${raise}px;width:560px}</style>
  <div id="app"><main id="chat" role="main"><header><h2>Bob</h2></header>
    <section id="messages"><div class="msg">Bob: please also write to <a href="mailto:carol@example.com">carol@example.com</a></div></section>
    <footer><div id="body" contenteditable="true" role="textbox" aria-label="Type a message">Hi Bob</div>
      <button id="send" type="button" aria-label="Send">Send</button></footer></main>
  ${rows ? `<div role="dialog" aria-label="New Message"><form onsubmit="return false">${rows}
    <div contenteditable="true" role="textbox" aria-label="Message Body">Draft</div>
    <button id="mail-send" type="button" aria-label="Send">Send</button></form></div>` : ''}</div>`;
const gmailCompose = rows => `<!doctype html><style>body{margin:0;font:16px sans-serif}[role=dialog]{width:800px}
  #body{display:block;width:700px;min-height:60px}</style>
  <main role="main"><h2>Inbox</h2></main>
  <div role="dialog" aria-label="New Message"><form onsubmit="return false">${rows}<input name="subjectbox" value="Invoice">
    <div id="body" contenteditable="true" role="textbox" aria-label="Message Body">Hello all</div>
    <button id="send" type="button" aria-label="Send">Send</button></form></div>`;

async function fixture(build, Agent, { url, html, recipients }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto(url);
  await page.setContent(html);
  await page.evaluate(() => {
    window.fixtureHandlers = [];
    const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: p => p };
    window.chrome = { runtime }; window.browser = { runtime };
    window.sent = 0;
    document.querySelector('#send').addEventListener('click', () => window.sent++);
  });
  for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
    await page.addScriptTag({ content: await readFile(path.join(ROOT, 'src', build, 'src/content', file), 'utf8') });
  }
  const agent = new Agent({ getActive: () => ({ supportsVision: false }) });
  agent._currentUrl = async () => page.url();
  stubPageTextReadings(agent);
  agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
  agent._planExecutionGuards.set(71, { messaging: { target_kind: 'named', recipients },
    requiresStateChange: true, requiresSubmission: true });
  const bind = async () => {
    const context = {};
    const blocked = await agent._messageRecipientGuardBlock(71, 'click', sendArgs, page.url(), context);
    return { blocked, context };
  };
  const probe = params => guardProbeWithReadings(next => call(page, 'probe_message_recipient_guard', next), {
    tool: 'click', args: sendArgs, bindDispatch: true, ...params,
  });
  return { browser, page, agent, bind, probe };
}

const CHAT_URL = 'https://example.test/chat/rooms/one';

for (const [build, Agent] of [['chrome', ChromeAgent], ['firefox', FirefoxAgent]]) {
  for (const [kind, history] of Object.entries(HISTORY)) {
    for (const target of ['alice@example.com', 'anne@example.com']) {
      test(`${build}: an address in a headerless chat's history (${kind}) is not the recipient of a send to ${target}`, async () => {
        const f = await fixture(build, Agent, { url: CHAT_URL, html: chatPage({ history }), recipients: [target] });
        try {
          const observed = await f.probe({ adapterName: 'generic-messaging', expectedRecipients: [target] });
          assert.deepEqual(observed.strongRecipientCandidates, [], JSON.stringify(observed));
          assert.deepEqual(observed.observedRecipientCandidates, []);
          assert.equal(observed.messageRecipientDispatchBinding, undefined);
          const { blocked, context } = await f.bind();
          assert.equal(blocked?.success, false, JSON.stringify(blocked));
          assert.equal(blocked.noDispatch, true);
          assert.equal(blocked.reasonCode, 'recipient_identity_unavailable', JSON.stringify(blocked));
          assert.equal(blocked.recipientConfirmation, undefined, 'no card offers a send to an address from the history');
          assert.equal(context.messageRecipientDispatchBinding, undefined);
          assert.equal(await f.page.evaluate(() => window.sent), 0);
        } finally { await f.browser.close(); }
      });
    }
  }

  test(`${build}: a chat header still decides the recipient when the history holds an address`, async () => {
    const f = await fixture(build, Agent, { url: CHAT_URL, recipients: ['alice@example.com'],
      html: chatPage({ header: '<header><h2>Bob</h2></header>' }) });
    try {
      const { blocked, context } = await f.bind();
      assert.equal(blocked?.reasonCode, 'active_recipient_unverified', JSON.stringify(blocked));
      assert.deepEqual(blocked.recipientConfirmation?.recipients, [{ identity: 'Bob', role: 'to' }], JSON.stringify(blocked));
      assert.equal(context.messageRecipientDispatchBinding, undefined);
      assert.equal(await f.page.evaluate(() => window.sent), 0);
    } finally { await f.browser.close(); }
    const named = await fixture(build, Agent, { url: CHAT_URL, recipients: ['Bob'],
      html: chatPage({ header: '<header><h2>Bob</h2></header>' }) });
    try {
      const { blocked, context } = await named.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      assert.ok(context.messageRecipientDispatchBinding?.token);
      const result = await call(named.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await named.page.evaluate(() => window.sent), 1);
    } finally { await named.browser.close(); }
  });

  test(`${build}: a mail compose still binds its address chips as the recipient set`, async () => {
    const f = await fixture(build, Agent, { url: 'https://mail.example.test/compose', html: mailPage,
      recipients: ['alice@example.com'] });
    try {
      const observed = await f.probe({ adapterName: 'generic-messaging', supportsRecipientSets: true,
        expectedRecipients: [{ identity: 'alice@example.com', role: 'to' }] });
      assert.deepEqual(observed.strongRecipientCandidates, [{ identity: 'alice@example.com', role: 'to' }], JSON.stringify(observed));
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      assert.ok(context.messageRecipientDispatchBinding?.token);
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
  });
}

// Help-desk and CRM conversation views often show the contact only as an
// address in the conversation's own header: that header still identifies
// the recipient, while the same markup in the history never does.
const HEADER_CHIP = {
  mailto: '<header><a href="mailto:casey@example.com">casey@example.com</a></header>',
  'data-email': '<header><span data-email="casey@example.com">Casey Customer</span></header>',
};
const HELPDESK_URL = 'https://desk.example.test/conversations/42';

for (const [build, Agent] of [['chrome', ChromeAgent], ['firefox', FirefoxAgent]]) {
  for (const [kind, header] of Object.entries(HEADER_CHIP)) {
    test(`${build}: an address in a conversation's own header (${kind}) is its recipient, not one in the history`, async () => {
      const bound = await fixture(build, Agent, { url: HELPDESK_URL, html: chatPage({ header }), recipients: ['casey@example.com'] });
      try {
        const observed = await bound.probe({ adapterName: 'generic-messaging', expectedRecipients: ['casey@example.com'] });
        assert.deepEqual(observed.strongRecipientCandidates, [{ identity: 'casey@example.com', role: 'to' }], JSON.stringify(observed));
        const { blocked, context } = await bound.bind();
        assert.equal(blocked, null, JSON.stringify(blocked));
        assert.ok(context.messageRecipientDispatchBinding?.token);
        const result = await call(bound.page, 'click', { ...sendArgs, ...context });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(await bound.page.evaluate(() => window.sent), 1);
      } finally { await bound.browser.close(); }

      const other = await fixture(build, Agent, { url: HELPDESK_URL, html: chatPage({ header }), recipients: ['alice@example.com'] });
      try {
        const { blocked, context } = await other.bind();
        assert.equal(blocked?.reasonCode, 'active_recipient_unverified', JSON.stringify(blocked));
        assert.deepEqual(blocked.recipientConfirmation?.recipients, [{ identity: 'casey@example.com', role: 'to' }],
          'the card names the header address, never the one from the history');
        assert.equal(context.messageRecipientDispatchBinding, undefined);
        assert.equal(await other.page.evaluate(() => window.sent), 0);
      } finally { await other.browser.close(); }
    });
  }

  test(`${build}: a message's own header in the history is not the conversation header`, async () => {
    const f = await fixture(build, Agent, { url: HELPDESK_URL, recipients: ['alice@example.com'], html: chatPage({
      history: '<header><a href="mailto:alice@example.com">alice@example.com</a></header>' }) });
    try {
      const { blocked, context } = await f.bind();
      assert.equal(blocked?.reasonCode, 'recipient_identity_unavailable', JSON.stringify(blocked));
      assert.equal(blocked.recipientConfirmation, undefined);
      assert.equal(context.messageRecipientDispatchBinding, undefined);
    } finally { await f.browser.close(); }
  });

  test(`${build}: two addresses in a conversation header identify no one`, async () => {
    const f = await fixture(build, Agent, { url: HELPDESK_URL, recipients: ['casey@example.com'], html: chatPage({
      header: '<header><a href="mailto:casey@example.com">Casey</a><span data-email="dana@example.com">Dana</span></header>' }) });
    try {
      const { blocked, context } = await f.bind();
      assert.equal(blocked?.reasonCode, 'recipient_identity_unavailable', JSON.stringify(blocked));
      assert.equal(context.messageRecipientDispatchBinding, undefined);
    } finally { await f.browser.close(); }
  });

  // A pinned message or a topic shown in the header is text about someone,
  // not the conversation's recipient.
  for (const [kind, header] of Object.entries({
    paragraph: '<header><p>Invoices go to <a href="mailto:casey@example.com">casey@example.com</a></p></header>',
    note: '<header><div role="note">Pinned: <span data-email="casey@example.com">Casey</span></div></header>',
  })) {
    test(`${build}: an address in a header's pinned text (${kind}) is not the recipient`, async () => {
      const f = await fixture(build, Agent, { url: HELPDESK_URL, recipients: ['casey@example.com'], html: chatPage({ header }) });
      try {
        const observed = await f.probe({ adapterName: 'generic-messaging', expectedRecipients: ['casey@example.com'] });
        assert.deepEqual(observed.strongRecipientCandidates, [], JSON.stringify(observed));
        const { blocked, context } = await f.bind();
        assert.equal(blocked?.reasonCode, 'recipient_identity_unavailable', JSON.stringify(blocked));
        assert.equal(context.messageRecipientDispatchBinding, undefined);
        assert.equal(await f.page.evaluate(() => window.sent), 0);
      } finally { await f.browser.close(); }
    });
  }

  // Google Chat inside Gmail is a chat: an address in its history is not a
  // recipient set member as it would be in a mail compose.
  for (const url of ['https://mail.google.com/chat/u/0/#chat/dm/abc', 'https://mail.google.com/mail/u/0/#chat/space/AAAA']) {
    test(`${build}: Google Chat in Gmail (${new URL(url).pathname}${new URL(url).hash.slice(0, 11)}) never binds an address from its history`, async () => {
      const f = await fixture(build, Agent, { url, html: chatPage(), recipients: ['alice@example.com'] });
      try {
        const { blocked, context } = await f.bind();
        assert.equal(blocked?.success, false, JSON.stringify(blocked));
        assert.equal(blocked.reasonCode, 'recipient_identity_unavailable', JSON.stringify(blocked));
        assert.equal(blocked.recipientConfirmation, undefined);
        assert.equal(context.messageRecipientDispatchBinding, undefined);
        assert.equal(await f.page.evaluate(() => window.sent), 0);
      } finally { await f.browser.close(); }
    });
  }

  // Gmail keeps a mail compose window open over its Chat views. Its own To
  // and Cc rows make it a mail compose on any route; the chat's history
  // beside it adds no one.
  test(`${build}: a Gmail compose open over a Chat view sends to its To and Cc rows`, async () => {
    const recipients = [{ identity: 'ada@example.test', role: 'to' }, { identity: 'bob@example.test', role: 'cc' }];
    const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#chat/space/AAAA', recipients, html: GMAIL_COMPOSE_OVER_CHAT });
    try {
      const observed = await f.probe({ adapterName: 'gmail', expectedRecipients: recipients });
      assert.equal(observed.recipientSets, true, JSON.stringify(observed));
      assert.deepEqual(observed.strongRecipientCandidates, recipients, JSON.stringify(observed));
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      assert.ok(context.messageRecipientDispatchBinding?.token);
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
  });

  // A Gmail Chat is identified by the person in its own header, as any
  // chat is, and an address in its history still counts for nothing.
  test(`${build}: a Gmail Chat send binds to the person in its header, and asks before anyone else`, async () => {
    const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#chat/dm/abc', recipients: ['Bob'], html: gmailChat() });
    try {
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      assert.ok(context.messageRecipientDispatchBinding?.token);
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
    const other = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#chat/dm/abc', recipients: ['Ada'], html: gmailChat() });
    try {
      const { blocked, context } = await other.bind();
      assert.equal(blocked?.reasonCode, 'active_recipient_unverified', JSON.stringify(blocked));
      assert.deepEqual(blocked.recipientConfirmation?.recipients, [{ identity: 'Bob', role: 'to' }], JSON.stringify(blocked));
      assert.equal(context.messageRecipientDispatchBinding, undefined);
      assert.equal(await other.page.evaluate(() => window.sent), 0);
    } finally { await other.browser.close(); }
  });

  // A Chat send never takes the recipients of a compose window open beside
  // it: not when the layout pairs its Send with the window's body, not when
  // its own composer is the lowest editor, and not when the URL carries the
  // compose= Gmail keeps while any compose window is open.
  for (const [rows, recipients] of [
    [TO_ADA, ['ada@example.test']],
    [TO_ADA + CC_CEM, [{ identity: 'ada@example.test', role: 'to' }, { identity: 'cem@example.test', role: 'cc' }]],
  ]) {
    test(`${build}: a Gmail Chat send never goes to the ${recipients.length === 1 ? 'To' : 'To and Cc'} of a compose window open beside it`, async () => {
      for (const url of ['https://mail.google.com/mail/u/0/#chat/space/AAAA', 'https://mail.google.com/mail/u/0/#chat/space/AAAA?compose=new']) {
        for (const raise of [0, 150]) {
          const variant = `${url.slice(url.indexOf('#'))}, compose window ${raise ? 'raised' : 'docked'}`;
          const f = await fixture(build, Agent, { url, recipients, html: gmailChat({ rows, raise }) });
          try {
            const { blocked, context } = await f.bind();
            assert.equal(blocked?.success, false, `${variant}: ${JSON.stringify(blocked)}`);
            assert.equal(context.messageRecipientDispatchBinding, undefined, variant);
            // A card may name the chat's own person, never the window's.
            for (const item of blocked.recipientConfirmation?.recipients || []) assert.equal(item.identity, 'Bob', variant);
            assert.equal(await f.page.evaluate(() => window.sent), 0, variant);
          } finally { await f.browser.close(); }
        }
      }
    });
  }

  test(`${build}: beside an open compose window a Gmail Chat send binds to its own header, and the window's Send is not the chat's`, async () => {
    const url = 'https://mail.google.com/mail/u/0/#chat/dm/abc?compose=new';
    const f = await fixture(build, Agent, { url, recipients: ['Bob'], html: gmailChat({ rows: TO_ADA, raise: 150 }) });
    try {
      await f.page.evaluate(() => {
        window.mailSent = 0;
        document.querySelector('#mail-send').addEventListener('click', () => window.mailSent++);
      });
      // The layout pairs the window's Send with the chat's composer: it
      // identifies no one, so neither the chat's person nor the window's.
      const mailContext = {};
      const mailBlocked = await f.agent._messageRecipientGuardBlock(71, 'click', { selector: '#mail-send' }, url, mailContext);
      assert.equal(mailBlocked?.success, false, JSON.stringify(mailBlocked));
      assert.equal(mailContext.messageRecipientDispatchBinding, undefined);
      assert.equal(await f.page.evaluate(() => window.mailSent), 0);
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => [window.sent, window.mailSent]).then(String), '1,0');
    } finally { await f.browser.close(); }
  });

  // An inline reply in a thread has no dialog or form of its own: its
  // recipients are the chips of the reply around its body, a form in that
  // reply included, and never those of a compose window open in the same
  // app beside the thread.
  for (const [kind, rows, recipients] of [
    ['its own To row', TO_ADA, ['ada@example.test']],
    ['no To row of its own', '<span email="ada@example.test">Ada</span>', ['cem@example.test']],
  ]) {
    test(`${build}: a Gmail inline reply with ${kind} beside an open compose window`, async () => {
      const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}main{position:absolute;left:0;top:0;width:640px;height:780px}
        .reply{position:absolute;left:0;top:600px}#body{display:block;width:560px;min-height:40px}
        [role=dialog]{position:absolute;left:660px;top:20px;width:560px}</style>
        <div id="app"><main role="main"><h2>Invoice</h2><div class="message">Ada: here is the invoice</div>
          <div class="reply"><div class="rows">${rows}</div><form><input type="hidden" name="draft" value="r1"></form>
            <div id="body" g_editable="true" contenteditable="true" role="textbox" aria-label="Message Body">Thanks Ada</div>
            <div class="toolbar"><button id="send" type="button" aria-label="Send">Send</button></div></div></main>
        <div role="dialog" aria-label="New Message"><form onsubmit="return false">${CC_CEM}<input name="subjectbox" value="Other">
          <div contenteditable="true" role="textbox" aria-label="Message Body">Draft</div></form></div></div>`;
      const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#inbox/FMfc123', recipients, html });
      try {
        const { blocked, context } = await f.bind();
        if (kind === 'its own To row') {
          assert.equal(blocked, null, JSON.stringify(blocked));
          const result = await call(f.page, 'click', { ...sendArgs, ...context });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(await f.page.evaluate(() => window.sent), 1);
        } else {
          // A chip that names no row is no recipient, and the window's Cc
          // row is not this reply's.
          assert.equal(blocked?.success, false, JSON.stringify(blocked));
          for (const item of blocked.recipientConfirmation?.recipients || []) assert.notEqual(item.identity, 'cem@example.test');
          assert.equal(context.messageRecipientDispatchBinding, undefined);
          assert.equal(await f.page.evaluate(() => window.sent), 0);
        }
      } finally { await f.browser.close(); }
    });
  }

  test(`${build}: an ordinary Gmail compose still binds and sends to its own To, Cc and Bcc`, async () => {
    const recipients = [{ identity: 'ada@example.test', role: 'to' }, { identity: 'cem@example.test', role: 'cc' },
      { identity: 'dee@example.test', role: 'bcc' }];
    const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#inbox?compose=new', recipients, html: gmailCompose(TO_ADA + CC_CEM + BCC_DEE) });
    try {
      const observed = await f.probe({ adapterName: 'gmail', expectedRecipients: recipients });
      assert.equal(observed.recipientSets, true, JSON.stringify(observed));
      assert.deepEqual(observed.strongRecipientCandidates, recipients, JSON.stringify(observed));
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
  });
}

test('Gmail keeps recipient sets for mail and drops them for its chat routes', async () => {
  for (const build of ['chrome', 'firefox']) {
    const { getMessageRecipientGuardPolicy } = await import(`../src/${build}/src/agent/adapters.js`);
    const mail = { adapterName: 'gmail', verifyActiveRecipient: true, deferActiveConversationUntilComposer: true };
    for (const url of ['https://mail.google.com/mail/u/0/#inbox', 'https://mail.google.com/mail/u/0/?compose=new',
      'https://mail.google.com/mail/u/0/#chats']) {
      assert.deepEqual(getMessageRecipientGuardPolicy(url), { ...mail, supportsRecipientSets: true }, `${build}: ${url}`);
    }
    // Gmail keeps compose= in the URL while any compose window is open, so
    // it says nothing about which composer sends: a compose window decides
    // that from its own To/Cc/Bcc rows.
    for (const url of ['https://mail.google.com/chat/u/0/#chat/dm/abc', 'https://mail.google.com/chat/u/0/',
      'https://mail.google.com/mail/u/0/#chat/space/AAAA', 'https://mail.google.com/mail/u/0/#chat/home',
      'https://mail.google.com/mail/u/0/#chat/home?compose=new', 'https://mail.google.com/chat/u/0/?compose=abc#chat/dm/xyz']) {
      assert.deepEqual(getMessageRecipientGuardPolicy(url), mail, `${build}: ${url}`);
    }
  }
});
