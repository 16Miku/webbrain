import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';
import { createCompletionInvariantState } from '../src/chrome/src/agent/completion-invariant.js';

// Real guarded Agent sends and content dispatch, in intercepted local pages.
// Bodies are composed for an explicit ongoing goal, rather than supplied by a
// user for each turn. No authenticated service or external recipient is used.
const call = (page, action, params = {}) => page.evaluate(message => new Promise(resolve => {
  for (const handler of window.fixtureHandlers) handler(message, {}, resolve);
}), { target: 'content', action, params });

for (const [build, engine, Agent, apiName] of [
  ['chrome', chromium, ChromeAgent, 'chrome'], ['firefox', firefox, FirefoxAgent, 'browser'],
]) {
  test(`${build}: authorized generated replies survive durable waiting without duplicate or drifted sends`, async () => {
    const browser = await engine.launch({ headless: true });
    const previousApi = globalThis[apiName];
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      await page.goto('https://web.whatsapp.com/');
      await page.setContent(`<!doctype html><style>
        body{margin:0;font:16px sans-serif}aside{position:absolute;width:300px;height:790px}
        #main{position:absolute;left:320px;width:940px;height:790px}
        header{height:70px;display:flex;gap:30px;align-items:center;padding-left:70px}
        #contact{width:278px;height:20px}#messages{height:580px;overflow:auto}
        footer{display:flex;gap:15px;align-items:center}#body{width:550px;min-height:32px}
      </style><aside><h1>WhatsApp</h1><button>Unrelated recipient</button></aside>
      <main id="main" data-conversation-id="demo-qa-thread" data-recipient="Demo QA"><header>
        <img alt="" width="40" height="40"><div id="contact" role="button" tabindex="0"><span title="Demo QA">Demo QA</span></div>
        <button aria-label="Voice call">Call</button><button aria-label="Search">Search</button></header>
        <section id="messages" role="log"></section><footer><button>Attach</button>
        <textarea id="body" role="textbox" aria-label="Type a message to Demo QA"></textarea>
        <button aria-label="Send">Send</button></footer></main>`);
      await page.evaluate(() => {
        window.fixtureHandlers = [];
        const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: p => p };
        window.chrome = { runtime }; window.browser = { runtime };
        window.sentBodies = []; window.deferDelivery = false; window.replyAfterSend = '';
        window.appendMessage = (id, direction, text) => {
          const row = document.createElement('div'); row.dataset.messageId = id; row.dataset.direction = direction;
          row.textContent = text; document.querySelector('#messages').append(row);
        };
        window.appendMessage('in-1', 'incoming', 'Which destination would suit a weekend trip?');
        document.querySelector('#body').addEventListener('keydown', event => {
          if (event.key !== 'Enter') return;
          const body = document.querySelector('#body').value.trim(); window.sentBodies.push(body);
          if (!window.deferDelivery) window.appendMessage(`out-${window.sentBodies.length}`, 'outgoing', body);
          document.querySelector('#body').value = '';
          if (window.replyAfterSend) {
            window.appendMessage(`in-after-${window.sentBodies.length}`, 'incoming', window.replyAfterSend);
            window.replyAfterSend = '';
          }
          event.preventDefault();
        });
      });
      for (const file of ['rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'chat-observation.js', 'content.js']) {
        await page.addScriptTag({ content: await readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
      }
      await page.locator('#body').focus();
      const saved = {};
      globalThis[apiName] = {
        tabs: { get: async () => ({ url: page.url(), title: 'Controlled conversation lab' }) },
        storage: { session: { get: async () => saved, set: async patch => Object.assign(saved, patch) } },
      };
      const tabId = 730;
      const agent = new Agent({});
      const userGoal = 'Have an ongoing conversation with Demo QA about weekend travel. Compose useful replies until they finish. Ask me before purchases or account changes.';
      agent.conversations.set(tabId, [{ role: 'system', content: 'system' }, { role: 'user', content: userGoal }]);
      agent.conversationIds.set(tabId, 'controlled-chat-goal');
      agent.completionInvariants.set(tabId, createCompletionInvariantState('controlled-chat-goal'));
      agent._planExecutionGuards.set(tabId, { messaging: { target_kind: 'named', recipients: ['Demo QA'] },
        requiresStateChange: true, requiresSubmission: true });
      agent._currentUrl = async () => page.url();
      agent._readChatObservation = () => call(page, 'observe_chat');
      agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
      agent._persist = () => {};
      const executeImpl = agent._executeToolImpl.bind(agent);
      agent._executeToolImpl = (id, tool, args, update, context) => tool === 'set_field'
        ? call(page, tool, { ...args, ...context }) : executeImpl(id, tool, args, update, context);
      const observe = () => agent._observeChatWorkflow(tabId);
      const send = (observation, text) => agent.executeTool(tabId, 'chat_send', {
        thread_key: observation.threadKey, composer_ref: observation.composer?.ref, text,
      });
      const initial = await observe();
      assert.equal(initial.success, true, JSON.stringify(initial));
      assert.equal(initial.chatWorkflow.newMessages.filter(row => row.direction === 'incoming').length, 1);
      const firstBody = 'A nearby coastal town would suit a relaxed weekend. Do you prefer quiet walks or museums?';
      assert.equal(userGoal.includes(firstBody), false);
      const first = await send(initial, firstBody);
      assert.equal(first.deliveryVerified, true, JSON.stringify(first));
      agent._recordCompletionToolResult(tabId, 'chat_send', { thread_key: initial.threadKey }, first);
      assert.equal(agent.completionInvariants.get(tabId).verificationDebt, false,
        'The public nested wrapper must preserve chat_send delivery evidence instead of its inner set_field envelope');
      assert.equal(first.chatWorkflow.nextAction, 'schedule_resume', 'Verified delivery should durably wait for a slow reply');
      assert.equal(first.chatWorkflow.pendingOutbound, false);

      let scheduledState;
      agent.scheduler = { createResumeJob: async request => {
        assert.equal(request.args.after_seconds, 90);
        assert.match(request.args.resume_instruction, /chat_observe/);
        const entry = Object.values(saved).find(value => value?.chatWorkflow);
        assert.ok(entry?.chatWorkflow, 'The conversation state must reach storage before the scheduler');
        scheduledState = structuredClone(entry.chatWorkflow);
        return { success: true, scheduled: true, jobId: 'local-resume' };
      } };
      const paused = await agent.executeTool(tabId, 'schedule_resume', {
        after_seconds: 90, reason: 'Wait for the authorized conversation partner.',
        resume_instruction: 'Call chat_observe first and reply only to the new delta within the authorized travel goal.',
      });
      assert.equal(paused.success, true, JSON.stringify(paused));
      agent.chatSessions.set(tabId, structuredClone(scheduledState));
      const unchanged = await observe();
      assert.equal(unchanged.chatWorkflow.newMessages.length, 0, 'A resumed conversation cannot replay the prior reply');
      await page.evaluate(() => window.appendMessage('in-2', 'incoming', 'I prefer museums. Can you suggest an itinerary?'));
      const resumed = await observe();
      assert.equal(resumed.chatWorkflow.nextAction, 'reply');
      assert.deepEqual(resumed.chatWorkflow.newMessages.map(row => row.id), ['in-2']);
      const second = await send(resumed, 'Start with the city museum in the morning, then leave the afternoon free for a waterfront walk.');
      assert.equal(second.deliveryVerified, true, JSON.stringify(second));
      assert.equal(await page.evaluate(() => window.sentBodies.length), 2, 'Same authorized recipient must allow the next composed reply');

      await page.evaluate(() => window.appendMessage('in-3', 'incoming', 'How can I keep the trip inexpensive?'));
      const thirdObservation = await observe();
      await page.evaluate(() => { window.replyAfterSend = 'Thanks. What about public transport?'; });
      const third = await send(thirdObservation, 'Use public transport and compare free museum hours before choosing paid attractions.');
      assert.equal(third.deliveryVerified, true, JSON.stringify(third));
      assert.equal(third.chatWorkflow.nextAction, 'reply', 'A fresh incoming reply should preempt waiting');
      assert.equal(third.chatWorkflow.newMessages.filter(row => row.direction === 'incoming').length, 1);

      await page.evaluate(() => { window.deferDelivery = true; });
      const pendingBody = 'A day pass may be useful; check the local transit fare rules.';
      const uncertain = await send(await observe(), pendingBody);
      assert.equal(uncertain.deliveryVerified, false);
      assert.equal(uncertain.chatWorkflow.pendingOutbound, true);
      assert.equal(uncertain.chatWorkflow.nextAction, 'observe', 'An uncertain send must not enter a long durable wait');
      const blockedRepeat = await send(await observe(), pendingBody);
      assert.equal(blockedRepeat.dispatched, false);
      assert.equal(await page.evaluate(() => window.sentBodies.length), 4);
      await page.evaluate(body => window.appendMessage('out-4', 'outgoing', body), pendingBody);
      const lateDelivery = await observe();
      assert.equal(lateDelivery.chatWorkflow.pendingOutbound, false);
      assert.equal(lateDelivery.chatWorkflow.nextAction, 'schedule_resume');

      await page.evaluate(() => {
        window.appendMessage('in-otp', 'incoming', 'A login step is needed.');
        const otp = document.createElement('input'); otp.id = 'otp'; otp.autocomplete = 'one-time-code';
        document.querySelector('#main').append(otp);
      });
      const otp = await observe();
      assert.equal(otp.chatWorkflow.nextAction, 'pause_for_user');
      assert.equal((await send(otp, 'This must not be sent while the code is requested.')).dispatched, false);
      await page.locator('#otp').evaluate(node => node.remove());
      const otpCleared = await observe();
      assert.ok(otpCleared.chatWorkflow.newMessages.some(row => row.id === 'in-otp'), 'The pause must preserve the incoming delta');
      await page.evaluate(() => {
        document.querySelector('#main').dataset.conversationId = 'other-thread';
        document.querySelector('#contact span').textContent = 'Other person';
      });
      const drift = await observe();
      assert.equal(drift.chatWorkflow.nextAction, 'pause_for_user');
      assert.equal((await send(drift, 'This must not go to another person.')).dispatched, false);
      assert.equal(await page.evaluate(() => window.sentBodies.length), 4);
    } finally {
      if (previousApi === undefined) delete globalThis[apiName]; else globalThis[apiName] = previousApi;
      await browser.close();
    }
  });
}
