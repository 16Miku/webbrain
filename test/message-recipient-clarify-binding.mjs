#!/usr/bin/env node
// A user asked to send a photo to "gamze" on Instagram. The open conversation
// was "Gamze Çömlekçi". The user picked "Gamze Çömlekçi" twice in the model's
// questions, but the guard discarded both answers because the question did
// not say "instead", and the run gave up. Now WebBrain itself asks once, on
// its own card with fixed choices, whether the message may go to the person
// the page shows; a model question that shows that name and gets it picked
// still counts, and refusals never do. These cases run the real content
// probe, guard, clarify tool, confirmation and upload handler in both builds.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

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

  for (const [label, question] of traceQuestions) {
    test(`${label} binds the picked recipient and the photo attaches`, async page => {
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
      assert.deepEqual(result.recipientBinding, { required: true, bound: true }, JSON.stringify(result));
      assert.match(result.note, /direct reply from the user/);
      const second = await f.bind();
      assert.equal(second.block, null, JSON.stringify(second.block));
      assert.ok(second.context.messageRecipientDispatchBinding?.token);
      const upload = await f.agent.executeTool(71, 'upload_file', f.args, null, second.context);
      assert.equal(upload.success, true, JSON.stringify(upload));
      assert.deepEqual(await f.state(), { inputs: 1, changes: 1, count: 1 });
      // The approval holds for the rest of the task without asking again.
      assert.equal((await f.bind()).block, null);
    });
  }

  for (const [label, question, answer, source, reason] of [
    ['a question that hides the recipient', { options: [RECIPIENT, 'Cancel'], question: 'Who should I send the photo to?' },
      RECIPIENT, 'option', /did not pick the recipient's exact name[\s\S]*its own confirmation \("Gamze Çömlekçi"\)/],
    ['a question about something else', { options: [RECIPIENT, 'No'], question: `Is ${RECIPIENT} your colleague?` },
      RECIPIENT, 'option', /approved nothing by itself[\s\S]*Do not ask about the recipient again/],
    ['a reply that does not pick the name', { options: [RECIPIENT, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` },
      "you're on the right user", 'text', /did not pick the recipient's exact name[\s\S]*continue with the send: WebBrain shows the user its own confirmation \("Gamze Çömlekçi"\)/],
    ['a refusal that names the recipient', { options: [RECIPIENT, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` },
      `No, not ${RECIPIENT}`, 'text', /declines or corrects[\s\S]*Do not send there/],
    ['a Turkish refusal that names the recipient', { options: [RECIPIENT, 'İptal'], question: `${RECIPIENT}'ye göndereyim mi?` },
      `Hayır, ${RECIPIENT} değil`, 'text', /declines or corrects/],
    ['a cancellation that says "all"', { options: [RECIPIENT, 'Send all remaining messages in this task without asking again', 'Cancel'],
      question: `Send it to ${RECIPIENT} instead?` }, 'Cancel all', 'text', /declines or corrects/],
    ['an answer naming someone the page does not show', { options: [RECIPIENT, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` },
      'Gamze Yılmaz', 'text', /did not pick the recipient's exact name/],
    ['a timed-out question', { options: [RECIPIENT, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` },
      RECIPIENT, 'timeout', /AUTO-SELECTED|auto-selected/],
  ]) {
    test(`${label} authorizes nothing and attaches nothing`, async page => {
      const f = await setup(page, kind);
      assert.equal((await f.bind()).block?.reasonCode, 'active_recipient_unverified');
      const { result } = await f.ask(question, answer, source);
      assert.equal(result.recipientBinding?.bound, false, JSON.stringify(result));
      assert.match(result.note, reason, result.note);
      assert.equal(f.agent._planExecutionGuards.get(71).messageRecipientApprovedAll, undefined);
      const retry = await f.bind();
      assert.equal(retry.block?.reasonCode, 'active_recipient_unverified', JSON.stringify(retry.block));
      const upload = await f.agent.executeTool(71, 'upload_file', f.args, null, retry.context);
      assert.equal(upload.success, false, JSON.stringify(upload));
      assert.deepEqual(await f.state(), { inputs: 0, changes: 0, count: 0 });
    });
  }

  test('after a vague reply, asking again with the exact name binds without another blocked send', async page => {
    const f = await setup(page, kind);
    assert.equal((await f.bind()).block?.reasonCode, 'active_recipient_unverified');
    const vague = await f.ask({ options: [RECIPIENT, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` }, 'yes', 'text');
    assert.equal(vague.result.recipientBinding.bound, false);
    // An unrelated question cannot pick up recipient consent.
    const unrelated = await f.ask({ options: [RECIPIENT, 'Original size'], question: 'Which image size do you prefer?' }, RECIPIENT);
    assert.equal(unrelated.result.recipientBinding, undefined);
    assert.equal((await f.bind()).block?.reasonCode, 'active_recipient_unverified');
    const picked = await f.ask({ options: [RECIPIENT, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` }, RECIPIENT);
    assert.deepEqual(picked.result.recipientBinding, { required: true, bound: true });
    assert.equal((await f.bind()).block, null);
  });

  test('a recipient question asked before the first send binds to the open conversation', async page => {
    const f = await setup(page, kind);
    const { result, shown } = await f.ask({ options: [RECIPIENT, 'Cancel'],
      question: `Should I send the photo to ${RECIPIENT}?` }, RECIPIENT);
    assert.equal(shown.length, 1);
    assert.deepEqual(result.recipientBinding, { required: true, bound: true }, JSON.stringify(result));
    const { block, context } = await f.bind();
    assert.equal(block, null, JSON.stringify(block));
    const upload = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
    assert.equal(upload.success, true, JSON.stringify(upload));
    assert.deepEqual(await f.state(), { inputs: 1, changes: 1, count: 1 });
  });

  test('an early recipient question naming someone the page does not show binds nothing', async page => {
    const f = await setup(page, kind);
    const { result } = await f.ask({ options: ['Gamze Yılmaz', 'Cancel'], purpose: 'message_recipient',
      question: 'Should I send the photo to Gamze Yılmaz?' }, 'Gamze Yılmaz');
    assert.equal(result.recipientBinding.bound, false, JSON.stringify(result));
    assert.equal((await f.bind()).block?.reasonCode, 'active_recipient_unverified');
    assert.deepEqual(await f.state(), { inputs: 0, changes: 0, count: 0 });
  });

  test('an approved recipient does not cover a different conversation', async page => {
    const f = await setup(page, kind);
    await f.bind();
    const { result } = await f.ask(traceQuestions[0][1], RECIPIENT);
    assert.equal(result.recipientBinding.bound, true);
    await page.evaluate(() => { document.querySelector('#recipient').textContent = 'Gamze Yılmaz'; });
    const moved = await f.bind();
    assert.equal(moved.block?.reasonCode, 'active_recipient_unverified', JSON.stringify(moved.block));
    assert.match(moved.block.error, /"Gamze Yılmaz"/);
    assert.deepEqual(await f.state(), { inputs: 0, changes: 0, count: 0 });
  });

  test('the send-all option approves the remaining sends; a refusal never does', async page => {
    const f = await setup(page, kind);
    await f.bind();
    const all = 'Send all remaining messages in this task without asking again';
    const { result } = await f.ask({ options: [RECIPIENT, all, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` }, all);
    assert.equal(result.recipientBinding.bound, true);
    assert.equal(f.agent._planExecutionGuards.get(71).messageRecipientApprovedAll, true);
    for (const answer of ['Cancel all', "No, don't send it to any of them", 'Stop everything', 'all good']) {
      f.agent._planExecutionGuards.set(71, { messaging: { target_kind: 'named', recipients: [{ identity: 'gamze', role: 'to' }] },
        requiresSubmission: true, requiresStateChange: true });
      await f.bind();
      const refused = await f.ask({ options: [RECIPIENT, all, 'Cancel'], question: `Send it to ${RECIPIENT} instead?` }, answer, 'text');
      assert.equal(refused.result.recipientBinding.bound, false, answer);
      assert.equal(f.agent._planExecutionGuards.get(71).messageRecipientApprovedAll, undefined, answer);
    }
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

  test('a plan that does not send messages never offers the card', async page => {
    const f = await setup(page, kind);
    f.agent._planExecutionGuards.get(71).requiresSubmission = false;
    const { block } = await f.bind();
    assert.equal(block?.noDispatch, true, JSON.stringify(block));
    assert.equal(block.recipientConfirmation, undefined);
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
