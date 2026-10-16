import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { installModelStub } from './semantic-decision-stub.mjs';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area },
  runtime: { getURL: value => `extension://owned/${value}` } };
const tab = 42;
const root = 'Keep a dialog with the bot on this page while I watch.';
const latest = 'it is my verified continue!';
const user = (text, kind) => ({ role: 'user', content: text, webbrainUserAuthoredText: text,
  ...(kind ? { webbrainTurnKind: kind } : {}) });
const followUp = 'no just keep a chat with him i want to watc you guys doing it.';

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { serializeConversationForSession } = await import(`../src/${build}/src/agent/conversation-persistence.js`);
  const { buildPlannerMessages, buildPlannerIntentMessages, buildPlannerAlignmentMessages,
    buildPlannerAlignmentRepairMessages } = await import(`../src/${build}/src/agent/planner.js`);

  function fixture(messages = [{ role: 'system', content: 'sys' }, user(root)]) {
    const provider = { model: 'owned-followup-fixture', config: { category: 'local' }, chat: async () => ({ content: '{}' }) };
    const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
    agent._persist = () => {};
    agent._persistSubmittedTurn = async () => ({ ok: true });
    agent.useSiteAdapters = false;
    agent.conversations.set(tab, messages);
    agent.conversationModes.set(tab, 'act');
    agent.conversationIds.set(tab, 'followup-conversation');
    agent.setPlanBeforeActMode('try');
    agent.setPlanReviewSettings({ mode: 'never' });
    return { agent, provider, messages };
  }

  function chatPlan() {
    return {
      request_kind: 'execute', scope_relation: 'continue', deliverables: ['Continue the visible bot conversation'],
      expected_items: null, site_job: null, conditional_site_job: null,
      requires_state_change: true, requires_submission: true,
      messaging: { target_kind: 'named', recipients: [{ identity: '@emrebot', role: 'to' }] },
      completion_requirements: { download: false }, allows_planner_shaped_result: false,
      allows_app_state_tool_evidence: false, read_scope: 'visible_page', summary: 'Continue the authorized bot chat.',
      confidence: .99, steps: [{ id: '1', action: 'Inspect the form, use the confirmed email, and continue the bot chat.', tools: ['read_page', 'click_ax', 'chat_send'] }],
      skill_ids: [], memory: { use_scratchpad: false, scratchpad_notes: [], use_progress_ledger: false, progress_action: null },
      scheduling: null, risks: [], localized: { locale: 'en', summary: 'Continue the authorized bot chat.', steps: [], risks: [] },
      response_language: { framing_locale: 'en', deliverable_locales: ['en'], preserve_source_text: false },
    };
  }

  function clarifyPair(question, answer, source = 'text', name = 'clarify', id = 'answer-1') {
    return [{ role: 'assistant', content: null, tool_calls: [{ id, type: 'function',
      function: { name, arguments: JSON.stringify({ question }) } }] },
    { role: 'tool', tool_call_id: id, content: JSON.stringify({ success: true, answer, source }) }];
  }

  test(`${build}: trace reproduction retains latest confirmation and bot choice through planner, repair and alignment`, async () => {
    const { agent, messages } = fixture([{ role: 'system', content: 'sys' }, user('chat with this person'), user(followUp),
      ...clarifyPair('Chat with @emrebot or contact Emre?', 'Chat with @emrebot'),
      ...clarifyPair('What email should I use?', "you entered correctly continue! don't ask too many questions", 'text', 'clarify', 'answer-2'),
      { role: 'assistant', content: 'The email is only a placeholder, not your verified address.' }]);
    // Force the original misclassification. Its words must still survive.
    const incoming = user(latest, 'continue');
    let context;
    agent._runPlannerGate = async (_tab, enriched, _update, _cost, _run, _history, _info, _plannerMode, _mode, _options, follow) => {
      context = follow.authenticTaskText;
      assert.ok(context.includes(latest));
      assert.ok(context.includes('Chat with @emrebot'));
      assert.ok(context.includes("you entered correctly continue! don't ask too many questions"));
      for (const builder of [buildPlannerMessages, buildPlannerIntentMessages]) {
        const planned = builder(enriched, 'https://owned.test/chat', 'Chat', '', follow);
        assert.ok(planned.at(-1).content.endsWith(`User task:\n${context}`));
        const repair = buildPlannerAlignmentRepairMessages(planned);
        assert.equal(repair.at(-1).content, planned.at(-1).content);
      }
      const check = buildPlannerAlignmentMessages(context, {}, { taskBinding: 'owned-binding' });
      assert.equal(JSON.parse(check.at(-1).content).current_request, context);
      return { proceed: true, requestKind: 'execute', requiresStateChange: false };
    };
    const result = await agent._maybeRunPlannerGate(tab, messages, incoming, () => {}, 'act', {}, null,
      { tabUrl: 'https://owned.test/chat', tabTitle: 'Chat' });
    assert.equal(result.proceed, true);
    assert.equal(agent._progressTaskAnchorText(tab), followUp, 'Keep stable execution identity for continuation.');
    const stored = JSON.parse(JSON.stringify(agent._conversationStorageEntry(tab)));
    assert.ok(stored, 'Normal conversation persistence accepts the complete task context.');
    assert.ok(agent._activeTaskBinding(messages).pinnedIndices.includes(messages.indexOf(incoming)));
  });

  test(`${build}: actual planner and alignment use the same context on rejection and repair`, async () => {
    const { agent, messages } = fixture();
    agent._recordTaskClarification(tab, 'Which bot?', 'Chat with @emrebot', 'option');
    const incoming = user(latest, 'continue');
    const planners = [], checks = [];
    const plan = chatPlan();
    agent._chatWithCostAllowance = async (_provider, modelMessages) => {
      let payload;
      try { payload = JSON.parse(modelMessages.at(-1).content); } catch {}
      if (payload?.task_binding) {
        checks.push(payload);
        return { content: JSON.stringify({ task_binding: payload.task_binding, aligned: checks.length > 1,
          reason: checks.length > 1 ? 'The confirmed email and bot choice match the user task.' : 'Fixture forces one repair.' }) };
      }
      planners.push(modelMessages);
      return { content: JSON.stringify(plan) };
    };
    const result = await agent._maybeRunPlannerGate(tab, messages, incoming, () => {}, 'act', {}, null,
      { tabUrl: 'https://owned.test/chat', tabTitle: 'Chat' });
    assert.equal(result.proceed, true, JSON.stringify(result));
    assert.equal(planners.length, 2); assert.equal(checks.length, 2);
    const context = checks[0].current_request;
    assert.equal(checks[1].current_request, context);
    for (const planned of planners) assert.ok(planned.at(-1).content.endsWith(`User task:\n${context}`));
    assert.ok(context.includes(latest)); assert.ok(context.includes('Chat with @emrebot'));
    const modelView = agent._modelVisibleConversationMessages(messages);
    assert.ok(modelView.find(message => message.webbrainUserAuthoredText === latest).content.includes(context));
    assert.equal(incoming.content, latest, 'Model projection must not rewrite the durable user message.');
  });

  for (const accumulated of [false, true]) {
    test(`${build}: long correction reaches actual alignment intact${accumulated ? ' with accumulated user instructions' : ''}`, async () => {
      const { agent, messages } = fixture();
      const answers = accumulated ? Array.from({ length: 4 }, (_, index) =>
        `ANSWER-${index}-START: ` + 'Keep "quoted" details and \\ literal text. '.repeat(110) + ` ANSWER-${index}-END`) : [];
      for (const [index, answer] of answers.entries()) agent._recordTaskClarification(tab, `Detail ${index}?`, answer, 'text');
      const earlierCorrection = accumulated ? 'Earlier correction: ' + 'Preserve every earlier instruction. '.repeat(140) + ' EARLIER-END' : null;
      if (earlierCorrection) messages.push(user(earlierCorrection, 'update'));
      const head = 'Continue the authorized dialog using these instructions: ';
      const tail = ' LONG-CORRECTION-END';
      const correction = head + 'x'.repeat(5890 - head.length - tail.length) + tail;
      assert.equal(correction.length, 5890);
      const incoming = user(correction, 'update');
      const planners = [], checks = [];
      agent._chatWithCostAllowance = async (_provider, modelMessages) => {
        let payload;
        try { payload = JSON.parse(modelMessages.at(-1).content); } catch {}
        if (payload?.task_binding) {
          checks.push(payload);
          return { content: JSON.stringify({ task_binding: payload.task_binding, aligned: true, reason: 'Complete current user task is retained.' }) };
        }
        planners.push(modelMessages);
        return { content: JSON.stringify(chatPlan()) };
      };
      const result = await agent._maybeRunPlannerGate(tab, messages, incoming, () => {}, 'act', {}, null,
        { tabUrl: 'https://owned.test/chat', tabTitle: 'Chat' });
      assert.equal(result.proceed, true, JSON.stringify(result));
      assert.equal(checks.length, 1, 'Long authority must reach alignment instead of failing before the model call.');
      assert.equal(planners.length, 1);
      const context = checks[0].current_request;
      assert.ok(planners[0].at(-1).content.endsWith(`User task:\n${context}`));
      const parsed = JSON.parse(context.slice(context.indexOf('{')));
      const resolve = entry => entry?.text_ref === 'latest_request' ? parsed.latest_request : entry?.text ?? entry;
      assert.equal(resolve(parsed.request), root);
      assert.equal(parsed.latest_request, correction);
      assert.deepEqual(parsed.updates.map(resolve), [...answers, ...(earlierCorrection ? [earlierCorrection] : []), correction]);
      const encodedCorrection = JSON.stringify(correction).slice(1, -1);
      assert.equal(context.split(encodedCorrection).length - 1, 1, 'Serialize the latest correction once.');
      assert.equal(incoming.content, correction);
      if (accumulated) assert.ok(context.length > 12000, 'Complete accumulated instructions exceed the former artificial cap.');
    });
  }

  test(`${build}: explicit clarification replies survive bounded session recovery and cold hydration`, async () => {
    const { agent, messages } = fixture();
    for (const [question, answer] of [['Which bot?', 'Chat with @emrebot'], ['Use the entered email?', 'Yes, it is my verified email.']]) {
      agent._recordTaskClarification(tab, question, answer, 'text');
    }
    for (let i = 0; i < 30; i++) messages.push({ role: 'assistant', content: 'Page observation '.repeat(1200) });
    messages.push(user(latest, 'continue'));
    const stored = serializeConversationForSession(messages, { maxBytes: 100000,
      preserveMessageIndices: agent._activeTaskBinding(messages).pinnedIndices });
    assert.equal(stored.compacted, true);
    const cold = fixture(JSON.parse(JSON.stringify(stored.messages))).agent;
    assert.ok(cold._plannerAuthenticTaskText(cold.conversations.get(tab)).includes('Chat with @emrebot'));
    assert.ok(cold._plannerAuthenticTaskText(cold.conversations.get(tab)).includes(latest));
    const entry = JSON.parse(JSON.stringify(agent._conversationStorageEntry(tab)));
    const hydrated = fixture().agent;
    hydrated.conversations.delete(tab); hydrated.conversationIds.delete(tab);
    const before = area.get;
    area.get = async key => ({ [agent._convKey(tab)]: entry });
    try { await hydrated._hydrateFromSession(tab); } finally { area.get = before; }
    const restored = hydrated._plannerAuthenticTaskText(hydrated.conversations.get(tab));
    assert.ok(restored.includes('Chat with @emrebot'));
    assert.ok(restored.includes('Yes, it is my verified email.'));
    assert.ok(restored.includes(latest));
    const modelView = hydrated._modelVisibleConversationMessages(hydrated.conversations.get(tab));
    assert.ok(modelView.find(message => message.webbrainUserAuthoredText === latest).content.includes(restored));
  });

  test(`${build}: live clarify tool records only the human answer on its owning user turn`, async () => {
    const { agent, messages } = fixture();
    agent.clarifyTimeoutSec = -1;
    const result = await agent.executeTool(tab, 'clarify', { question: 'Which bot?', options: ['Chat with @emrebot'],
      purpose: 'message_recipient' }, (type, data) => {
      if (type === 'clarify') assert.equal(agent.submitClarifyResponse(tab, data.clarifyId, 'Chat with @emrebot', 'option'), true);
    });
    assert.equal(result.answer, 'Chat with @emrebot');
    assert.deepEqual(messages[1].webbrainTaskClarifications, [{ question: 'Which bot?', answer: 'Chat with @emrebot', source: 'option' }]);
    const task = agent._plannerAuthenticTaskText(messages);
    assert.ok(task.includes('Chat with @emrebot'));
    const instant = fixture();
    instant.agent.clarifyTimeoutSec = 0;
    await instant.agent.executeTool(tab, 'clarify', { question: 'Which bot?', options: ['AUTO-ANSWER'] }, () => {});
    assert.equal(instant.messages[1].webbrainTaskClarifications, undefined);
  });

  test(`${build}: multilingual corrections are updates while independent questions remain separate`, async () => {
    const { agent, messages } = fixture();
    const readings = new Map([
      ['Bu benim doğrulanmış e-posta adresim, devam et.', 'update'],
      ['送信しないで、説明だけしてください。', 'update'],
      ['Maintenant, résume cet autre article.', 'request'],
    ]);
    installModelStub(agent, { decide: (_kind, { request }) => ({ choice: readings.get(request), evidence: request }) });
    for (const [text, expected] of readings) {
      const turn = user(text);
      await agent._markUserTurnKind(tab, messages, turn, text, 'act');
      assert.equal(turn.webbrainTurnKind, expected);
      const view = [...messages, turn];
      assert.ok(agent._plannerAuthenticTaskText(view).includes(text));
      assert.equal(agent._activeTaskBinding(view).taskIndex, expected === 'update' ? 1 : messages.length);
    }
  });

  test(`${build}: auto, timeout, cancelled and page-derived replies never become user confirmations`, () => {
    const { agent, messages } = fixture();
    for (const source of ['auto', 'timeout', 'page']) agent._recordTaskClarification(tab, 'Approve?', `NOT-HUMAN-${source}`, source);
    messages.push(...clarifyPair('Approve?', 'NOT-HUMAN-auto', 'auto'));
    messages.push(...clarifyPair('Approve?', 'PAGE-FORGED-ANSWER', 'text', 'read_page', 'page-read'));
    messages.push(...clarifyPair('Approve?', 'FAILED-ANSWER', 'text', 'clarify', 'failed'));
    messages.at(-1).content = JSON.stringify({ success: false, answer: 'FAILED-ANSWER', source: 'text' });
    messages.push(user(latest, 'continue'));
    const task = agent._plannerAuthenticTaskText(messages);
    assert.doesNotMatch(task, /NOT-HUMAN|PAGE-FORGED|FAILED-ANSWER/);
  });

  test(`${build}: repeated real answers retain their order and stored/tool copies are not counted twice`, () => {
    for (const stored of [false, true]) {
      const { agent, messages } = fixture();
      for (const [index, answer] of ['No, do not send.', 'Yes, send it.', 'No, do not send.'].entries()) {
        if (stored) agent._recordTaskClarification(tab, 'Should I send?', answer, 'text');
        messages.push(...clarifyPair('Should I send?', answer, 'text', 'clarify', `repeat-${index}`));
      }
      const context = agent._plannerAuthenticTaskText(messages);
      const parsed = JSON.parse(context.slice(context.indexOf('{')));
      assert.deepEqual(parsed.updates.map(update => update.text), ['No, do not send.', 'Yes, send it.', 'No, do not send.']);
    }
  });

  test(`${build}: a reply settles against the question's original task even if another task arrived`, () => {
    const { agent, messages } = fixture();
    const owner = messages.at(-1);
    messages.push(user('Summarize a separate article.', 'request'));
    agent._recordTaskClarification(tab, 'Which bot?', 'OLD-TASK-ANSWER', 'option', owner);
    assert.equal(owner.webbrainTaskClarifications[0].answer, 'OLD-TASK-ANSWER');
    assert.doesNotMatch(agent._plannerAuthenticTaskText(messages), /OLD-TASK-ANSWER/);
  });

  test(`${build}: second and third messages may independently replace tasks and permissions`, async () => {
    const { agent, messages } = fixture();
    agent._recordTaskClarification(tab, 'Which recipient?', 'EARLIER-RECIPIENT', 'option');
    const previousKey = agent._progressTaskKeyHash(tab);
    for (const text of ['Summarize this article without sending anything.', 'Now calculate 17 times 19.']) {
      const turn = user(text, 'request');
      messages.push(turn);
      assert.equal(agent._activeTaskBinding(messages).taskIndex, messages.indexOf(turn));
      assert.equal(agent._plannerAuthenticTaskText(messages), text);
      assert.notEqual(agent._progressTaskKeyHash(tab), previousKey);
      assert.doesNotMatch(agent._plannerAuthenticTaskText(messages), /EARLIER-RECIPIENT|dialog/);
    }
  });

  test(`${build}: a separate task after a planner question is not swallowed as its answer`, () => {
    const { agent, messages } = fixture();
    messages.push({ role: 'assistant', content: 'Which email?', webbrainPlannerClarification: {
      taskText: root, taskKey: agent._progressTaskKeyForText(root), requiresSubmission: true } });
    messages.push(user('Instead explain this article.', 'request'));
    assert.equal(agent._plannerAuthenticTaskText(messages), 'Instead explain this article.');
  });

  test(`${build}: corrections keep task history while later no-send overrides earlier send intent`, async () => {
    const { agent, messages } = fixture();
    const calls = installModelStub(agent, { decide: (_kind, { request, page }) => {
      assert.equal(page.current_task, root);
      return { choice: 'update', evidence: request };
    } });
    const turn = user("Actually, don't send anything. Just explain the page.");
    await agent._markUserTurnKind(tab, messages, turn, turn.content, 'act');
    messages.push(turn);
    const task = agent._plannerAuthenticTaskText(messages);
    assert.equal(turn.webbrainTurnKind, 'update');
    assert.equal(agent._activeTaskBinding(messages).taskIndex, 1);
    assert.equal(agent._latestAcceptedRequestText(agent._activeTaskBinding(messages)), turn.content);
    assert.ok(task.includes(root)); assert.ok(task.includes(turn.content));
    assert.equal(calls.length, 1);
  });

  test(`${build}: acknowledgments stop before planning or page actions`, async () => {
    const { agent, messages } = fixture();
    agent._runPlannerGate = agent._runPlannerIntentGate = async () => { throw new Error('Acknowledgment must not resume execution'); };
    const result = await agent._maybeRunPlannerGate(tab, messages, user('Thanks!', 'acknowledge'), () => {}, 'act', {}, null);
    assert.equal(result.proceed, false);
    assert.equal(result.reason, 'acknowledged');
    assert.equal(result.requiresSubmission, false);
    assert.equal(agent._progressTaskAnchorText(tab), root);
  });

  test(`${build}: legacy turns and classification failure preserve the entire latest request`, async () => {
    const { agent, messages } = fixture();
    installModelStub(agent, { decide: () => null });
    const turn = user(latest);
    await agent._markUserTurnKind(tab, messages, turn, turn.content, 'act');
    messages.push(turn);
    assert.equal(turn.webbrainTurnKind, 'request');
    assert.equal(agent._plannerAuthenticTaskText(messages), latest);
    delete turn.webbrainTurnKind;
    assert.equal(agent._plannerAuthenticTaskText(messages), latest);
    turn.webbrainTurnKind = 'continue';
    assert.ok(agent._plannerAuthenticTaskText(messages).includes(latest));
    const long = user('Correction: ' + 'keep this exact text '.repeat(600));
    messages.push(long);
    assert.equal(agent._plannerAuthenticTaskText(messages), long.content.trim(), 'Never silently truncate authority.');
  });

  test(`${build}: projecting legacy execution context is idempotent and never promotes generated text to user words`, () => {
    const { agent, messages } = fixture([{ role: 'system', content: 'sys' }, { role: 'user', content: root },
      { role: 'user', content: latest, webbrainTurnKind: 'continue' }]);
    const view = agent._modelVisibleConversationMessages(messages);
    assert.equal(agent._plannerUserAuthoredText(view.at(-1)), latest);
    assert.deepEqual(agent._modelVisibleConversationMessages(view), view);
    assert.equal(messages.at(-1).content, latest);
    assert.equal(messages.at(-1).webbrainUserAuthoredText, undefined);
  });

  test(`${build}: decision context includes task status, last question, and direct answers`, async () => {
    const { agent, messages } = fixture();
    agent._recordTaskClarification(tab, 'Which bot?', 'Chat with @emrebot', 'option');
    messages.push(...clarifyPair('Is this your email?', 'Yes', 'text'));
    const calls = installModelStub(agent, { decide: (_kind, { request, page }) => {
      assert.equal(page.current_task, root);
      assert.equal(page.last_question, 'Is this your email?');
      assert.equal(page.task_status, 'in_progress_or_paused');
      assert.deepEqual(page.user_answers, ['Chat with @emrebot']);
      assert.ok(page.task_context_key);
      return { choice: 'update', evidence: request };
    } });
    assert.equal(await agent._userTurnKind(tab, messages, latest, 'act'), 'update');
    assert.equal(calls.length, 1);
  });

  test(`${build}: classification sees completion status and the complete task survives old clarification caps`, () => {
    const longRoot = 'Inspect the form. ' + 'Retain this original requirement. '.repeat(70) + ' DO-NOT-SEND-TAIL';
    const { agent, messages } = fixture([{ role: 'system', content: 'sys' }, user(longRoot)]);
    messages.push({ role: 'assistant', content: 'Which field?', webbrainPlannerClarification: {
      taskText: longRoot.slice(0, 1600), taskKey: agent._progressTaskKeyForText(longRoot), requiresSubmission: false } });
    messages.push(user('Use the email field.', 'update'));
    assert.ok(agent._plannerAuthenticTaskText(messages).includes('DO-NOT-SEND-TAIL'));
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'done-proof', function: { name: 'done', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'done-proof', content: JSON.stringify({ done: true, outcome: 'partial' }) });
    assert.equal(agent._userTurnReference(messages).task_status, 'partial');
  });

  test(`${build}: task-sensitive cache and latency retain one decision call with at most one LLM fallback`, async t => {
    const { agent, provider, messages } = fixture();
    agent._jevSettings = async () => ({ decisionConfig: { enabled: true, local: true } });
    let decisions = 0;
    agent.evaluateSystemOne = async () => {
      decisions++;
      return { model: 'owned-decider', answers: { user_turn_kind: { type: 'choice', choice: 'continue', confidence: .97,
        probabilities: { continue: .97, update: .01, acknowledge: .01, request: .01 } } } };
    };
    const calls = installModelStub(agent, { provider, decide: (_kind, { request }) => ({ choice: 'update', evidence: request }) });
    let started = performance.now();
    assert.equal(await agent._userTurnKind(tab, messages, 'continue', 'act'), 'continue');
    const fastMs = performance.now() - started;
    assert.equal(decisions, 1); assert.equal(calls.length, 0);
    started = performance.now();
    assert.equal(await agent._userTurnKind(tab, messages, 'continue', 'act'), 'continue');
    const cachedMs = performance.now() - started;
    assert.equal(decisions, 1, 'Cache hit adds no model request.');
    // The task shares its first 600 characters but differs later, beyond the
    // classifier's bounded reference text. Cache keys must still differ.
    messages.push(user('x'.repeat(700) + 'TASK A', 'request'));
    await agent._userTurnKind(tab, messages, 'continue', 'act');
    messages[messages.length - 1] = user('x'.repeat(700) + 'TASK B', 'request');
    await agent._userTurnKind(tab, messages, 'continue', 'act');
    assert.equal(decisions, 3);
    agent.evaluateSystemOne = async () => { decisions++; return { model: 'owned-decider', answers: {} }; };
    started = performance.now();
    assert.equal(await agent._userTurnKind(tab, messages, latest, 'act'), 'update');
    const fallbackMs = performance.now() - started;
    assert.equal(decisions, 4); assert.equal(calls.length, 1, 'Exactly one fallback, no new model stage.');
    t.diagnostic(JSON.stringify({ transport: 'immediate model fixtures; local overhead, not live network latency', fastMs, cachedMs, fallbackMs,
      fastCalls: { decision: 1, llm: 0 }, fallbackCalls: { decision: 1, llm: 1 } }));
  });
}
