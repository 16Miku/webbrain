import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { createChatSession, normalizeChatSession, serializeChatSession, decideChatSend } =
    await import(`../src/${build}/src/agent/chat-workflow.js`);
  const tabId = 619, threadKey = 'dom:telegram:k:123456:0', url = 'https://web.telegram.org/k/#123456';
  const body = 'Verify the current owned browser state before repeating any action.';
  const task = 'Have a bounded QA dialogue with WebBrain QA Bot for five minutes; compose a useful reply to each fresh question once.';
  const provider = {};
  function setup(messages = [{ role: 'system', content: 'system' }, { role: 'user', content: task }]) {
    const agent = new Agent({});
    agent.conversations.set(tabId, structuredClone(messages)); agent.conversationModes.set(tabId, 'act');
    agent._persist = () => {}; agent._persistNow = async () => true;
    agent._activeProvider = () => provider; agent._currentUrl = async () => url;
    const guard = agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute', requiresStateChange: true,
      requiresSubmission: true, messaging: { target_kind: 'named', recipients: [{ identity: threadKey.slice(4), role: 'to' }] } });
    agent._beginCompletionInvariant(tabId);
    const raw = { success: true, observedAt: new Date().toISOString(), url, threadKey,
      composer: { available: true, empty: true, ref: 'composer' },
      messages: [{ id: 'telegram:k:123456:0:1:rfixture', direction: 'incoming', text: 'Owned question.' },
        { id: 'telegram:k:123456:0:2', direction: 'outgoing', text: body, authoredText: body }] };
    agent._readChatObservation = async () => structuredClone(raw);
    agent.chatSessions.set(tabId, createChatSession({ threadKey }));
    return { agent, guard, raw };
  }
  async function delivered() {
    const fixture = setup(), { agent } = fixture;
    agent._recordCompletionToolResult(tabId, 'click_ax', {}, { success: false, dispatched: true, outcomeUnknown: true },
      { messageRecipientContext: { messageRecipientGuardRequired: true, messageRecipientBody: body,
        messageRecipientDispatchBinding: { token: 'owned-one-use-token' },
        messageRecipientNativeChatBaseline: { complete: true, threadKey, messageIds: ['telegram:k:123456:0:1'] } } });
    assert.equal(agent.completionInvariants.get(tabId).verificationDebt, true);
    assert.equal(agent.chatSessions.get(tabId).completionReceipt, null, 'Unknown action success cannot create a receipt.');
    const observation = await agent._observeChatWorkflow(tabId);
    agent._recordCompletionToolResult(tabId, 'chat_observe', {}, observation);
    assert.equal(agent.completionInvariants.get(tabId).verificationDebt, false);
    assert.ok(agent.chatSessions.get(tabId).completionReceipt, 'Strict independent native delivery creates the durable receipt.');
    return fixture;
  }
  async function restored() {
    const prior = await delivered();
    const fixture = setup(prior.agent.conversations.get(tabId));
    fixture.agent.chatSessions.set(tabId, serializeChatSession(prior.agent.chatSessions.get(tabId)));
    return fixture;
  }

  test(`${build}: same-task alarm restore completes from fresh exact native delivery without inventing a new action`, async () => {
    const { agent, guard } = await restored();
    const observation = await agent._observeChatWorkflow(tabId);
    assert.ok(observation.chatGoalDeliveryVerification);
    agent._recordCompletionToolResult(tabId, 'chat_observe', {}, observation);
    const proof = await agent._freshNativeChatTerminalEvidence(tabId, url);
    assert.ok(proof?.priorVerifiedGoal); guard.nativeChatDeliveryEvidence = proof;
    assert.equal(agent._completionSubmissionEvidence(tabId, { nativeChatDeliveryEvidence: proof }, url).verifiedFinalSubmit, true);
    guard.verifiedSubmissionEvidence = true; guard.evidenceTaskKey = guard.taskKey;
    assert.equal(agent._executionEvidenceSatisfied(guard), true,
      'A same-task alarm may finish from its independently refreshed durable delivery, without repeating the send.');
    assert.equal(agent._planOnlyTerminalDecision(tabId, 'The owned conversation ended with its replies delivered.',
      { viaDone: true, outcome: 'success' }), null);
    assert.equal(guard.successfulConsequentialToolCalls, 0, 'Prior goal proof must not manufacture a current page action.');
    assert.equal(agent.completionInvariants.get(tabId).hadAction, false);
    assert.equal(agent.completionInvariants.get(tabId).lastAction, null);
    agent._recordCompletionToolResult(tabId, 'done', { outcome: 'success' }, { done: true, outcome: 'success',
      verification: { pageUrl: url, completionWarning: null } });
    assert.equal(agent._planOnlyTerminalDecision(tabId, 'The owned conversation ended with its replies delivered.',
      { viaDone: true, outcome: 'success' }), null,
      'The actual batch records done before its plan gate; terminal bookkeeping must retain the freshly checked proof.');
    assert.equal(agent.completionInvariants.get(tabId).lastAction, null);
    assert.ok(JSON.stringify(serializeChatSession(agent.chatSessions.get(tabId))).length < 5000);
    agent._recordCompletionToolResult(tabId, 'progress_read', {}, { success: true });
    assert.equal(agent._completionSubmissionEvidence(tabId, { nativeChatDeliveryEvidence: proof }, url).verifiedFinalSubmit, false,
      'A cached terminal observation cannot substitute for a fresh current sequence.');
    assert.equal(agent._executionEvidenceSatisfied(guard), false);
  });

  test(`${build}: structured send records its genuine native post-read even without an extra model observe`, () => {
    const { agent } = setup();
    const deliveryObservation = { success: true, observedAt: new Date().toISOString(), url, threadKey,
      messageId: 'telegram:k:123456:0:2', composer: { available: true, empty: true },
      chatWorkflow: { threadKey, pendingOutbound: false } };
    const context = { chatCompletionBindingSink: { binding: { complete: true, threadKey, body,
      messageIds: ['telegram:k:123456:0:1'] }, deliveryObservation } };
    agent._recordCompletionToolResult(tabId, 'chat_send', { thread_key: threadKey, text: body },
      { success: true, sent: true, dispatched: true, deliveryVerified: true, verificationRequired: false,
        threadKey, composer: deliveryObservation.composer, chatWorkflow: deliveryObservation.chatWorkflow },
      { messageRecipientContext: context });
    assert.ok(agent.chatSessions.get(tabId).completionReceipt);
  });

  test(`${build}: identical new wording and accepted task corrections cannot inherit the prior request's receipt`, async () => {
    for (const content of [task, `${task} Also check a different owned page.`]) {
      const { agent } = await restored();
      agent.conversations.get(tabId).push({ role: 'user', content });
      assert.equal(await agent._freshNativeChatTerminalEvidence(tabId, url), null);
    }
  });

  test(`${build}: edited/deleted/history/recipient/composer and OTP state invalidate restored delivery`, async () => {
    const changes = [raw => { raw.messages.pop(); }, raw => { raw.messages[1].authoredText += ' changed'; },
      raw => { raw.messages[1].id = 'telegram:k:123456:0:3'; }, raw => { raw.threadKey = 'dom:telegram:k:654321:0'; },
      raw => { raw.composer.empty = false; }, raw => { raw.userInput = { required: true, reason: 'otp' }; },
      raw => { raw.url += '?different-document'; }];
    for (const change of changes) {
      const { agent, raw } = await restored(); change(raw);
      assert.equal(await agent._freshNativeChatTerminalEvidence(tabId, url), null);
    }
    const { agent } = await restored();
    const session = agent.chatSessions.get(tabId);
    agent.chatSessions.set(tabId, { ...session, pendingOutbound: { key: 'uncertain', text: 'New unverified body', threadKey } });
    assert.equal(await agent._freshNativeChatTerminalEvidence(tabId, url), null);
  });

  test(`${build}: a later dispatched page action clears old delivery; local progress does not fabricate one`, async () => {
    const { agent } = await restored();
    agent._recordCompletionToolResult(tabId, 'progress_update', {}, { success: true });
    assert.ok(await agent._freshNativeChatTerminalEvidence(tabId, url));
    agent._recordCompletionToolResult(tabId, 'click', {}, { success: true });
    assert.equal(agent.chatSessions.get(tabId).completionReceipt, null);
    assert.equal(await agent._freshNativeChatTerminalEvidence(tabId, url), null);
  });

  test(`${build}: provider or task switch during native reobserve cannot certify the old capture`, async () => {
    for (const change of [agent => { agent._activeProvider = () => ({}); },
      agent => { agent.conversations.get(tabId).push({ role: 'user', content: task }); }]) {
      const { agent, raw } = await restored(); let release;
      agent._readChatObservation = () => new Promise(resolve => { release = () => resolve(structuredClone(raw)); });
      const pending = agent._freshNativeChatTerminalEvidence(tabId, url);
      while (!release) await Promise.resolve();
      change(agent); release();
      assert.equal(await pending, null);
    }
  });

  test(`${build}: internal terminal reobserve preserves a newly arrived question for the model`, async () => {
    const { agent, raw } = await restored();
    raw.messages.push({ id: 'telegram:k:123456:0:3:rnew', direction: 'incoming',
      text: 'New owned question arrived while completion was being assessed.' });
    assert.equal(await agent._freshNativeChatTerminalEvidence(tabId, url), null,
      'The candidate cannot finish over a fresh incoming message it has never considered.');
    const explicit = await agent._observeChatWorkflow(tabId);
    assert.ok(explicit.chatWorkflow.newMessages.some(message => message.id === raw.messages[2].id),
      'The internal completion check must not silently consume the incoming delta.');
  });

  test(`${build}: unavailable receipt persistence blocks scheduling without permitting the delivered body again`, async () => {
    const { agent, raw } = await delivered(); let schedules = 0;
    agent.scheduler = { async createResumeJob() { schedules++; return { success: true }; } };
    agent._persistNow = async () => false;
    const result = await agent._executeToolImpl(tabId, 'schedule_resume', { after_seconds: 60,
      reason: 'Wait for a fresh owned question.', resume_instruction: 'Observe then continue the same QA dialogue.' });
    assert.equal(result.reason, 'chat_state_not_durable'); assert.equal(result.noDispatch, true); assert.equal(schedules, 0);
    assert.equal(decideChatSend(agent.chatSessions.get(tabId), raw, body).ok, false,
      'Storage failure must never turn a delivered body into a new permissible send.');
  });

  test(`${build}: malformed receipt provenance is dropped by bounded persisted-state normalization`, async () => {
    const { agent } = await delivered(), session = agent.chatSessions.get(tabId), receipt = session.completionReceipt;
    for (const patch of [{ schema: 'model-reported-success' }, { threadKey: 'dom:whatsapp:unknown' },
      { messageId: 'telegram:k:654321:0:2' }, { messageId: 'telegram:k:123456:0:old-history' },
      { url: 'https://external.invalid/' }, { url: 'https://credential:secret@web.telegram.org/k/' },
      { bodySha256: 'wrong' }, { originActionSequence: 0 }]) {
      assert.equal(normalizeChatSession({ ...session, completionReceipt: { ...receipt, ...patch } }).completionReceipt, null);
    }
  });
}
