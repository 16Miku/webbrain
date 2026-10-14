#!/usr/bin/env node
// A user asked to send a photo to "gamze" on Instagram. The open conversation
// was "Gamze Çömlekçi". The user picked "Gamze Çömlekçi" twice in the model's
// questions, but the guard discarded both answers because the question did
// not say "instead", and the run gave up. Now WebBrain itself asks once, on
// its own card with fixed choices, whether the message may go to the person
// the page shows. No wording is read for consent: a question the model asks,
// and whatever the user types or picks on it, approves nothing by itself.
// These cases run the real content probe, guard, clarify tool, confirmation
// and upload handler in both builds.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import { defaultDecide, installModelStub } from './semantic-decision-stub.mjs';

const tests = [];
const bytes = Buffer.from('fixture photo bytes\n');
const directory = await mkdtemp(path.join(tmpdir(), 'webbrain-recipient-clarify-'));
const filePath = path.join(directory, 'photo.txt');
await writeFile(filePath, bytes);
const originalChrome = globalThis.chrome;
const originalBrowser = globalThis.browser;
const originalFetch = globalThis.fetch;
const originalAttach = cdpClient.attach;
const originalSend = cdpClient.sendCommand;
const deliver = (page, message) => page.evaluate(message => new Promise(resolve => {
  window.__wb_handler(message, {}, resolve);
}), message);
const call = (page, action, params) => deliver(page, { target: 'content', action, params });
const RECIPIENT = 'Gamze Çömlekçi';

async function setup(page, kind) {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto('https://www.instagram.com/direct/t/17848282661759097/');
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    body{margin:0;font:16px sans-serif} #composer{position:fixed;left:340px;top:390px;width:430px;height:200px}
    textarea{width:300px;height:90px} h2{position:fixed;left:350px;top:60px}
    [role=button]{display:inline-block;width:32px;height:32px} svg{width:24px;height:24px}
  </style><form id="composer"><h2 id="recipient">${RECIPIENT}</h2><textarea id="body" aria-label="Message"></textarea>
    <input id="file" type="file" accept="audio/*,.mp4,.mov,.png,.jpg,.jpeg,.txt" multiple hidden>
    <div role="button" tabindex="0" id="attach"><svg aria-label="Add Photo or Video" role="img"><path d="M0 0h24v24H0z"/></svg></div>
    <div role="button" tabindex="0" id="titled"><svg role="img"><title>Choose an emoji</title><path d="M0 0h24v24H0z"/></svg></div>
    <div role="button" tabindex="0" id="like"><svg aria-label="Like" role="img"><path d="M0 0h24v24H0z"/></svg></div>
    <div role="button" tabindex="0" id="send-icon"><svg aria-label="Send" role="img"><path d="M0 0h24v24H0z"/></svg></div>
    <div role="button" tabindex="0" id="mixed"><svg aria-label="Add Photo or Video" role="img"></svg><svg aria-label="Send" role="img"></svg></div>
    <div role="button" tabindex="0" id="bare"><svg role="img"><path d="M0 0h24v24H0z"/></svg></div>
  </form>`);
  await page.evaluate(() => {
    window.__wb_handlers = [];
    const runtime = { onMessage: { addListener(fn) { window.__wb_handlers.push(fn); } }, getURL: path => path };
    window.__wb_handler = (message, sender, response) => {
      for (const handler of window.__wb_handlers) handler(message, sender, response);
    };
    window.chrome = { runtime }; window.browser = { runtime };
    window.inputEvents = 0; window.changeEvents = 0; window.clicks = [];
    document.querySelector('#file').addEventListener('input', () => window.inputEvents++);
    document.querySelector('#file').addEventListener('change', () => window.changeEvents++);
    for (const control of document.querySelectorAll('[role=button]')) {
      control.addEventListener('click', () => window.clicks.push(control.id));
    }
  });
  const sourceRoot = path.resolve('src', kind, 'src', 'content');
  for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
    await page.addScriptTag({ content: await readFile(path.join(sourceRoot, file), 'utf8') });
  }
  const api = {
    runtime: {},
    tabs: {
      async get() { return { id: 71, url: page.url() }; },
      async sendMessage(_, message) { return deliver(page, message); },
      async executeScript(_, details) {
        if (details.file) { await page.addScriptTag({ content: await readFile(path.resolve('src', kind, details.file), 'utf8') }); return []; }
        return [await page.evaluate(source => window.eval(source), details.code)];
      },
    },
    downloads: kind === 'chrome'
      ? { async search(_, callback) { callback([{ id: 2073, state: 'complete', filename: filePath }]); } }
      : { async search() {
        return [{ id: 2073, state: 'complete', filename: filePath, url: 'https://assets.example.test/photo.txt', mime: 'text/plain' }];
      } },
  };
  globalThis.chrome = api;
  globalThis.browser = api;
  globalThis.fetch = async () => new Response(bytes, { headers: { 'content-type': 'text/plain' } });
  if (kind === 'chrome') {
    const session = await page.context().newCDPSession(page);
    cdpClient.attach = async () => {};
    cdpClient.sendCommand = async (_, method, params = {}) => session.send(method, params);
  }
  const Agent = kind === 'chrome' ? ChromeAgent : FirefoxAgent;
  const agent = new Agent({ getActive: () => ({ supportsVision: false }) });
  agent._resolvePromptTier = () => 'full';
  agent._currentUrl = async () => page.url();
  // The planner kept the name the user typed: "gamze".
  agent._planExecutionGuards.set(71, { messaging: { target_kind: 'named', recipients: [{ identity: 'gamze', role: 'to' }] },
    requiresSubmission: true, requiresStateChange: true });
  agent.clarifyTimeoutSec = -1;
  agent._recordClarificationAuthorization = async () => true;
  const args = { selector: 'input[type="file"][accept="audio/*,.mp4,.mov,.png,.jpg,.jpeg,.txt"][multiple]', downloadId: 2073 };
  const bind = async () => {
    const context = {};
    const block = await agent._messageRecipientGuardBlock(71, 'upload_file', args, page.url(), context);
    return { block, context };
  };
  // WebBrain's own card: answered with a fixed value, or left for Stop.
  const confirm = async (block, choice, { allowPrompt = true, beforeAnswer = null } = {}) => {
    const cards = [];
    const context = {};
    const rerun = () => agent._messageRecipientGuardBlock(71, 'upload_file', args, page.url(), context);
    const result = await agent._resolveMessageRecipientConfirmation(71, block, (status, details) => {
      if (status !== 'clarify') return;
      cards.push(details);
      const settle = async () => {
        if (beforeAnswer) await beforeAnswer();
        const entry = agent._pendingClarifications.get(71).get(details.clarifyId);
        if (choice === null) agent._cancelClarifications(71, 'stopped');
        else agent._settleClarification(entry, { answer: choice, source: 'option' });
      };
      void settle();
    }, rerun, { allowPrompt });
    return { result, cards, context };
  };
  // Shows one clarify card and answers it the way the user did.
  const ask = async (clarifyArgs, answer, source = 'option') => {
    const shown = [];
    const result = await agent._executeToolImpl(71, 'clarify', clarifyArgs, (status, details) => {
      if (status !== 'clarify') return;
      shown.push(details);
      agent._settleClarification(agent._pendingClarifications.get(71).get(details.clarifyId), { answer, source });
    });
    return { result, shown };
  };
  const state = () => page.evaluate(() => ({ inputs: window.inputEvents, changes: window.changeEvents,
    count: document.querySelector('#file')?.files?.length || 0 }));
  return { agent, args, bind, ask, confirm, state };
}

const traceQuestions = [
  ['the first question from the trace', { options: [RECIPIENT, 'Cancel'], purpose: 'message_recipient',
    question: `Send the photo to ${RECIPIENT} on Instagram?` }],
  ['the second question from the trace', { purpose: 'recipient_change',
    options: [RECIPIENT, 'Send all remaining emails in this task without asking again', 'Cancel'],
    question: `Authorize sending the photo to ${RECIPIENT} on Instagram?` }],
  ['the question the guard prescribes', { options: [RECIPIENT, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` }],
  ['a Turkish question without a declared purpose', { options: [RECIPIENT, 'İptal'],
    question: `Fotoğrafı ${RECIPIENT}'ye göndereyim mi?` }],
  ['a declared recipient question in a language without listed send words', { options: [RECIPIENT, 'Ακύρωση'],
    purpose: 'message_recipient', question: `${RECIPIENT}: σωστό άτομο;` }],
];

for (const kind of ['chrome', 'firefox']) {
  const test = (name, fn) => tests.push({ kind, name: `${kind}: ${name}`, fn });

  // The model's own questions, in three languages, answered with the name:
  // nothing is approved until WebBrain's card is answered.
  for (const [label, question] of traceQuestions) {
    test(`${label}, answered with the name, approves nothing: WebBrain's card decides`, async page => {
      const f = await setup(page, kind);
      const first = await f.bind();
      assert.equal(first.block?.reasonCode, 'active_recipient_unverified', JSON.stringify(first.block));
      assert.equal(first.block.retryable, false);
      assert.deepEqual(first.block.recipientConfirmation, { recipients: [{ identity: RECIPIENT, role: 'to' }],
        requested: ['gamze'], host: 'www.instagram.com', offerAll: false });
      assert.match(first.block.error, new RegExp(`"${RECIPIENT}"`));
      assert.match(first.block.error, /named for this task \("gamze"\)/);
      assert.doesNotMatch(first.block.error, /clarify\(|emails|treat it as authorized/);
      const { result, shown } = await f.ask(question, RECIPIENT);
      assert.equal(shown.length, 1);
      assert.equal(result.recipientBinding, undefined, JSON.stringify(result));
      if (question.purpose) assert.match(result.note, /does not approve a recipient by itself[\s\S]*on its own card/);
      const second = await f.bind();
      assert.equal(second.block?.reasonCode, 'active_recipient_unverified', JSON.stringify(second.block));
      assert.equal(second.context.messageRecipientDispatchBinding, undefined);
      const refused = await f.agent.executeTool(71, 'upload_file', f.args, null, second.context);
      assert.equal(refused.success, false, JSON.stringify(refused));
      assert.deepEqual(await f.state(), { inputs: 0, changes: 0, count: 0 });
      // WebBrain's card asks once, and its answer decides.
      const { result: confirmed, cards, context } = await f.confirm(second.block, 'once');
      assert.equal(confirmed, null, JSON.stringify(confirmed));
      assert.equal(cards.length, 1);
      const upload = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
      assert.equal(upload.success, true, JSON.stringify(upload));
      assert.deepEqual(await f.state(), { inputs: 1, changes: 1, count: 1 });
    });
  }

  test('typed or picked answers on the model\'s questions approve nothing, whatever they say', async page => {
    const f = await setup(page, kind);
    assert.equal((await f.bind()).block?.reasonCode, 'active_recipient_unverified');
    const all = 'Send all remaining messages in this task without asking again';
    for (const [question, answer, source] of [
      [{ options: [RECIPIENT, 'Cancel'], question: 'Who should I send the photo to?' }, RECIPIENT, 'option'],
      [{ options: [RECIPIENT, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` }, "you're on the right user", 'text'],
      [{ options: [RECIPIENT, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` }, 'yes', 'text'],
      [{ options: [RECIPIENT, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` }, `No, not ${RECIPIENT}`, 'text'],
      [{ options: [RECIPIENT, 'İptal'], question: `${RECIPIENT}'ye göndereyim mi?` }, `Hayır, ${RECIPIENT} değil`, 'text'],
      [{ options: [RECIPIENT, all, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` }, all, 'option'],
      [{ options: ['Gamze Yılmaz', 'Cancel'], purpose: 'message_recipient', question: 'Should I send the photo to Gamze Yılmaz?' }, 'Gamze Yılmaz', 'option'],
      [{ options: [RECIPIENT, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` }, RECIPIENT, 'timeout'],
    ]) {
      const { result } = await f.ask(question, answer, source);
      assert.equal(result.recipientBinding, undefined, answer);
      const guard = f.agent._planExecutionGuards.get(71);
      assert.equal(guard.messageRecipientApprovedAll, undefined, answer);
      assert.deepEqual(guard.approvedRecipients || [], [], answer);
      const retry = await f.bind();
      assert.equal(retry.block?.reasonCode, 'active_recipient_unverified', `${answer}: ${JSON.stringify(retry.block)}`);
      const upload = await f.agent.executeTool(71, 'upload_file', f.args, null, retry.context);
      assert.equal(upload.success, false, answer);
    }
    assert.deepEqual(await f.state(), { inputs: 0, changes: 0, count: 0 });
  });

  test('an approval on the card covers only that person: a different conversation asks again', async page => {
    const f = await setup(page, kind);
    assert.equal((await f.confirm((await f.bind()).block, 'once')).result, null);
    await page.evaluate(() => { document.querySelector('#recipient').textContent = 'Gamze Yılmaz'; });
    const moved = await f.bind();
    assert.equal(moved.block?.reasonCode, 'active_recipient_unverified', JSON.stringify(moved.block));
    assert.match(moved.block.error, /"Gamze Yılmaz"/);
    assert.deepEqual(moved.block.recipientConfirmation.recipients, [{ identity: 'Gamze Yılmaz', role: 'to' }]);
    const upload = await f.agent.executeTool(71, 'upload_file', f.args, null, moved.context);
    assert.equal(upload.success, false);
    assert.deepEqual(await f.state(), { inputs: 0, changes: 0, count: 0 });
  });

  test('WebBrain asks once with its own card, and Send attaches the photo', async page => {
    const f = await setup(page, kind);
    const { block } = await f.bind();
    const { result, cards, context } = await f.confirm(block, 'once');
    assert.equal(result, null, JSON.stringify(result));
    assert.equal(cards.length, 1);
    assert.equal(cards[0].promptKind, 'recipientConfirmation');
    assert.equal(cards[0].question, `Send to ${RECIPIENT}?`);
    assert.deepEqual(cards[0].options, ['once', 'deny']);
    assert.deepEqual(cards[0].recipientConfirmation.requested, ['gamze']);
    assert.ok(context.messageRecipientDispatchBinding?.token);
    const upload = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
    assert.equal(upload.success, true, JSON.stringify(upload));
    assert.deepEqual(await f.state(), { inputs: 1, changes: 1, count: 1 });
    // The same person is not asked about again in this task.
    const again = await f.bind();
    assert.equal(again.block, null, JSON.stringify(again.block));
  });

  test('Don\'t send blocks the send and is not asked again for the same person', async page => {
    const f = await setup(page, kind);
    const { block } = await f.bind();
    const { result, cards, context } = await f.confirm(block, 'deny');
    assert.equal(cards.length, 1);
    assert.equal(result.reasonCode, 'recipient_declined', JSON.stringify(result));
    assert.equal(result.noDispatch, true);
    assert.match(result.error, /chose not to send to "Gamze Çömlekçi"[\s\S]*Do not retry/);
    const upload = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
    assert.equal(upload.success, false);
    const retry = await f.bind();
    assert.equal(retry.block?.reasonCode, 'recipient_declined', JSON.stringify(retry.block));
    assert.equal(retry.block.recipientConfirmation, undefined);
    assert.deepEqual(await f.state(), { inputs: 0, changes: 0, count: 0 });
  });

  test('Stop while the card is open sends nothing', async page => {
    const f = await setup(page, kind);
    const { block } = await f.bind();
    const { result } = await f.confirm(block, null);
    assert.equal(result.cancelled, true, JSON.stringify(result));
    assert.equal(result.recipientConfirmationCancelled, true);
    assert.equal((await f.bind()).block?.reasonCode, 'active_recipient_unverified');
    assert.deepEqual(await f.state(), { inputs: 0, changes: 0, count: 0 });
  });

  test('a conversation that changes while the card is open is not sent to', async page => {
    const f = await setup(page, kind);
    const { block } = await f.bind();
    const { result, context } = await f.confirm(block, 'once', { beforeAnswer: () => page.evaluate(() => {
      document.querySelector('#recipient').textContent = 'Gamze Yılmaz';
    }) });
    assert.equal(result.reasonCode, 'recipient_changed_during_confirmation', JSON.stringify(result));
    assert.match(result.error, /changed to "Gamze Yılmaz"/);
    assert.equal(context.messageRecipientDispatchBinding, undefined);
    assert.deepEqual(await f.state(), { inputs: 0, changes: 0, count: 0 });
  });

  test('an unattended run is not asked and sends nothing', async page => {
    const f = await setup(page, kind);
    const { block } = await f.bind();
    const { result, cards } = await f.confirm(block, 'once', { allowPrompt: false });
    assert.equal(cards.length, 0);
    assert.equal(result, block);
    assert.match(result.error, /user has not confirmed it, so nothing was sent/);
  });

  test('a task with several recipients can approve the remaining sends at once', async page => {
    const f = await setup(page, kind);
    f.agent._planExecutionGuards.get(71).messaging = { target_kind: 'named',
      recipients: [{ identity: 'gamze', role: 'to' }, { identity: 'ali', role: 'to' }] };
    const { block } = await f.bind();
    assert.equal(block.recipientConfirmation.offerAll, true);
    const { result, cards } = await f.confirm(block, 'always');
    assert.deepEqual(cards[0].options, ['once', 'always', 'deny']);
    assert.equal(result, null, JSON.stringify(result));
    assert.equal(f.agent._planExecutionGuards.get(71).messageRecipientApprovedAll, true);
  });

  test('"always" is ignored where it was not offered', async page => {
    const f = await setup(page, kind);
    const { block } = await f.bind();
    const { result } = await f.confirm(block, 'always');
    assert.equal(result.reasonCode, 'recipient_declined', JSON.stringify(result));
    assert.equal(f.agent._planExecutionGuards.get(71).messageRecipientApprovedAll, undefined);
  });

  test('a plan that does not send messages never offers the card for an attachment', async page => {
    const f = await setup(page, kind);
    f.agent._planExecutionGuards.get(71).requiresSubmission = false;
    const { block } = await f.bind();
    assert.equal(block?.noDispatch, true, JSON.stringify(block));
    assert.equal(block.recipientConfirmation, undefined);
    assert.doesNotMatch(block.error, /ask the user/i, 'Consent is never routed through the model');
  });

  // A typed message whose task never named the recipient (or never asked to
  // send anything) used to end with "ask the user to authorize sending", and
  // no answer could authorize it. Now WebBrain's card shows who gets it and
  // what it says, and the user decides.
  const textSend = async (f, page, guard) => {
    f.agent._planExecutionGuards.set(71, guard);
    await page.fill('#body', 'See you at 5 at the café');
    const sendArgs = { selector: '#send-icon' };
    const context = {};
    const block = await f.agent._messageRecipientGuardBlock(71, 'click', sendArgs, page.url(), context);
    const answer = async (choice, { allowPrompt = true } = {}) => {
      const cards = [];
      const rerunContext = {};
      const result = await f.agent._resolveMessageRecipientConfirmation(71, block, (status, details) => {
        if (status !== 'clarify') return;
        cards.push(details);
        const entry = f.agent._pendingClarifications.get(71).get(details.clarifyId);
        if (choice === null) f.agent._cancelClarifications(71, 'stopped');
        else f.agent._settleClarification(entry, { answer: choice, source: 'option' });
      }, () => f.agent._messageRecipientGuardBlock(71, 'click', sendArgs, page.url(), rerunContext), { allowPrompt });
      return { result, cards, context: rerunContext };
    };
    return { block, answer, again: () => f.agent._messageRecipientGuardBlock(71, 'click', sendArgs, page.url(), {}) };
  };

  test('a message the task never named a recipient for is put to the user with its text, and Send goes out', async page => {
    const f = await setup(page, kind);
    const send = await textSend(f, page, { messaging: null, requiresSubmission: true, requiresStateChange: true });
    assert.equal(send.block?.reasonCode, 'authorized_recipient_missing', JSON.stringify(send.block));
    assert.deepEqual(send.block.recipientConfirmation.recipients, [{ identity: RECIPIENT, role: 'to' }]);
    assert.equal(send.block.recipientConfirmation.reason, 'unnamed');
    assert.equal(send.block.recipientConfirmation.message, 'See you at 5 at the café');
    assert.doesNotMatch(send.block.error, /ask the user/i);
    const { result, cards, context } = await send.answer('once');
    assert.equal(result, null, JSON.stringify(result));
    assert.equal(cards.length, 1);
    assert.equal(cards[0].recipientConfirmation.reason, 'unnamed');
    assert.equal(cards[0].recipientConfirmation.message, 'See you at 5 at the café');
    assert.ok(context.messageRecipientDispatchBinding?.token, 'The send binds to a fresh reading of the same page');
    assert.equal(await send.again(), null, 'The confirmed person is not asked about again in this task');
  });

  test('a message the task never asked to send is put to the user, and Don\'t send is final', async page => {
    const f = await setup(page, kind);
    const send = await textSend(f, page, { messaging: null, requiresSubmission: false, requiresStateChange: false });
    assert.equal(send.block.recipientConfirmation.reason, 'unrequested', JSON.stringify(send.block));
    const { result, cards } = await send.answer('deny');
    assert.equal(cards.length, 1);
    assert.equal(result.reasonCode, 'recipient_declined', JSON.stringify(result));
    assert.equal(result.noDispatch, true);
    const retry = await send.again();
    assert.equal(retry?.reasonCode, 'recipient_declined', JSON.stringify(retry));
    assert.equal(retry.recipientConfirmation, undefined, 'A declined person is not offered again');
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
  });

  test('an unattended run is not asked about an unrequested message and sends nothing', async page => {
    const f = await setup(page, kind);
    const send = await textSend(f, page, { messaging: null, requiresSubmission: false, requiresStateChange: false });
    const { result, cards } = await send.answer('once', { allowPrompt: false });
    assert.equal(cards.length, 0);
    assert.equal(result, send.block);
    assert.match(result.error, /user has not confirmed it, so nothing was sent/);
  });

  // Whether the request says not to send is read by a model, in any language;
  // a send the user said not to make is refused without offering a card.
  for (const [label, request, answer, outcome] of [
    ['an English request', "Draft a reply to Gamze saying I'll be late, but don't send it.", null, 'sending_forbidden'],
    ['a Turkish request', 'Gamze için geç kalacağımı söyleyen bir cevap taslağı yaz ama gönderme.', { choice: 'forbidden', evidence: 'gönderme' }, 'sending_forbidden'],
    ['a plain request', 'Tell Gamze I will be late.', { choice: 'not_forbidden', evidence: '' }, 'card'],
  ]) {
    test(`${label} that ${outcome === 'card' ? 'does not say not to send gets the card' : 'says not to send is refused without a card'}`, async page => {
      const f = await setup(page, kind);
      const provider = { model: 'owned-decision-fixture', chat: async () => ({ content: '{}' }) };
      f.agent._activeProvider = () => provider;
      f.agent.conversations.set(71, [{ role: 'system', content: 'system' }, { role: 'user', content: request }]);
      const calls = installModelStub(f.agent, { decide: (kind, question) => answer ?? defaultDecide(kind, question), provider });
      const send = await textSend(f, page, { messaging: null, requiresSubmission: false, requiresStateChange: false });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].kind, 'sending_forbidden');
      assert.equal(calls[0].request, request, 'The request reaches the model as written');
      assert.deepEqual(calls[0].page, { message: 'See you at 5 at the café', recipients: [RECIPIENT], site: 'www.instagram.com' });
      assert.match(calls[0].wrapped, /^<untrusted_page_content id="/, 'The message and the page stay untrusted data');
      if (outcome === 'card') {
        assert.equal(send.block?.reasonCode, 'authorized_recipient_missing', JSON.stringify(send.block));
        assert.equal(send.block.recipientConfirmation.reason, 'unrequested');
      } else {
        assert.equal(send.block?.reasonCode, 'sending_forbidden', JSON.stringify(send.block));
        assert.equal(send.block.recipientConfirmation, undefined, 'What the user said not to send is not offered');
        assert.equal(send.block.retryable, false);
        assert.match(send.block.error, /says not to send this message, so nothing was sent/);
        const { result, cards } = await send.answer('once');
        assert.equal(cards.length, 0);
        assert.equal(result, send.block);
      }
      assert.deepEqual(await page.evaluate(() => window.clicks), []);
    });
  }

  test('a matching planned recipient still sends without a card', async page => {
    const f = await setup(page, kind);
    const send = await textSend(f, page, { messaging: { target_kind: 'named', recipients: [{ identity: RECIPIENT, role: 'to' }] },
      requiresSubmission: true, requiresStateChange: true });
    assert.equal(send.block, null, JSON.stringify(send.block));
  });

  // The model clicked the composer's icon buttons while the send was blocked.
  // Attachment and picker launchers are not sends; Like and Send stay guarded.
  for (const [control, nonSend] of [['attach', true], ['titled', true], ['like', false], ['send-icon', false],
    ['mixed', false], ['bare', false]]) {
    test(`the ${control} icon control ${nonSend ? 'is a composer utility' : 'stays a guarded send'}`, async page => {
      await setup(page, kind);
      const probe = await call(page, 'probe_message_recipient_guard', { tool: 'click', args: { selector: `#${control}` },
        adapterName: 'generic-messaging', supportsRecipientSets: false });
      assert.equal(probe.success, true, JSON.stringify(probe));
      if (nonSend) {
        assert.equal(probe.messageSend, false, JSON.stringify(probe));
        assert.equal(probe.composerUtility, true);
      } else {
        assert.notEqual(probe.messageSend, false, JSON.stringify(probe));
      }
    });
  }
}

let passed = 0, failed = 0;
try {
  for (const [kind, type] of [['chrome', chromium], ['firefox', firefox]]) {
    const browser = await type.launch();
    for (const t of tests.filter(t => t.kind === kind)) {
      const page = await browser.newPage();
      try { await t.fn(page); passed++; console.log(`✓ ${t.name}`); }
      catch (error) { failed++; console.error(`✗ ${t.name}\n${error.stack}`); }
      finally { await page.close(); }
    }
    await browser.close();
  }
} finally {
  globalThis.chrome = originalChrome; globalThis.browser = originalBrowser; globalThis.fetch = originalFetch;
  cdpClient.attach = originalAttach; cdpClient.sendCommand = originalSend;
  await rm(directory, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
