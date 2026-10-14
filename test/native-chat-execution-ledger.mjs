import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: value => `extension://test/${value}` } };

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { createChatSession, decideChatSend, markChatSendPending } = await import(`../src/${build}/src/agent/chat-workflow.js`);
  const threadKey = 'dom:telegram:k:123456:0', url = 'https://web.telegram.org/k/#123456';
  async function fixture({ expected = {}, recipients, targets = [] } = {}) {
    const provider = { name: 'Owned QA classifier', model: 'test', config: { category: 'local' },
      chat: async () => ({ content: JSON.stringify({ mode: 'active', allowedActions: ['process_item'], forbiddenActions: [],
        targets, confidence: 1, pageScopePolicy: 'page' }) }) };
    const agent = new Agent({ getActive: () => provider });
    agent._persist = () => {}; agent._persistNow = async () => true;
    const task = 'Have six question-and-answer turns with the owned WebBrain QA Bot in this conversation.';
    agent.conversations.set(1, [{ role: 'system', content: 'Act' }, { role: 'user', content: task, webbrainUserAuthoredText: task }]);
    agent.conversationModes.set(1, 'act');
    const guard = agent._startPlanExecutionGuard(1, 'act', { requestKind: 'execute', requiresStateChange: true,
      requiresSubmission: true, messaging: { target_kind: 'named', recipients: recipients || [{ identity: 'telegram:k:123456:0', role: 'to' }] } });
    agent._beginCompletionInvariant(1);
    await agent._ensureProgressSessionForCurrentTask(1, { provider, pageScope: url, progressLedgerPolicy: 'enabled',
      progressAction: 'process_item', expectedItems: { count: 6, item_type: 'reply', ordered: true, required_fields: [], ...expected } });
    return { agent, guard };
  }
  function dispatch(agent, ordinal, { known = false, anchor = String(ordinal), tool = 'set_field' } = {}) {
    const args = tool === 'set_field' ? { field: 'composer', value: `Reply ${ordinal}`, submit: true } : {};
    const context = { messageRecipientGuardRequired: true, messageRecipientBody: `Reply ${ordinal}`,
      messageRecipientDispatchBinding: { token: `owned-${ordinal}` },
      messageRecipientNativeChatBaseline: { complete: true, threadKey, messageIds: [`telegram:k:123456:0:${ordinal * 2 - 1}`] },
      genericChatPending: { replyAnchor: `telegram:k:123456:0:${anchor}:rquestion` } };
    const result = { success: true, dispatched: true, verified: true, ...(known ? {} : { outcomeUnknown: true }) };
    agent._markPlanExecutionToolCall(1, tool, result, { consequential: true });
    agent._recordCompletionToolResult(1, tool, args, result, { messageRecipientContext: context });
    return result;
  }
  function observation(agent, ordinal) {
    return { success: true, observedAt: new Date().toISOString(), url, threadKey,
      composer: { available: true, empty: true }, chatWorkflow: { threadKey, pendingOutbound: false, userInput: null },
      chatDeliveryVerification: { schema: 'webbrain-chat-completion/1',
        actionSequence: agent.completionInvariants.get(1).lastAction.sequence, threadKey, messageId: `telegram:k:123456:0:${ordinal * 2}` } };
  }
  function observe(agent, result) {
    agent._markPlanExecutionToolCall(1, 'chat_observe', result);
    agent._recordCompletionToolResult(1, 'chat_observe', {}, result);
    return result;
  }

  test(`${build}: six uncertain native sends reconcile once and complete only their ordered reply rows`, async () => {
    const { agent, guard } = await fixture();
    for (let ordinal = 1; ordinal <= 6; ordinal++) {
      const sent = dispatch(agent, ordinal);
      assert.equal(sent.chatSendVerification.nextAction, 'chat_observe');
      assert.equal(guard.successfulConsequentialToolCalls, ordinal - 1, 'An uncertain dispatch cannot count before independent observation.');
      agent._recordCompletionToolResult(1, 'click_ax', {}, { success: false, noDispatch: true, dispatched: false, error: 'Composer is empty.' });
      const proof = observe(agent, observation(agent, ordinal));
      assert.equal(guard.successfulConsequentialToolCalls, ordinal);
      assert.equal(proof.chatDeliveryProgress.id, `expected:${ordinal}`);
      assert.equal(agent._progressRead(1, { currentTaskOnly: true }).counts.processed, ordinal);
      observe(agent, structuredClone(proof));
      assert.equal(guard.successfulConsequentialToolCalls, ordinal, 'Repeated observation cannot count the same native action twice.');
      assert.equal(agent._progressRead(1, { currentTaskOnly: true }).counts.processed, ordinal);
    }
    assert.equal(agent._progressDoneBlock(1), null);
    assert.equal(guard.successfulConsequentialActionKeys.size, 6);
  });

  test(`${build}: already successful native send is not counted again when its delivery becomes visible`, async () => {
    const { agent, guard } = await fixture();
    dispatch(agent, 1, { known: true });
    assert.equal(guard.successfulConsequentialToolCalls, 1);
    observe(agent, observation(agent, 1));
    assert.equal(guard.successfulConsequentialToolCalls, 1);
    assert.equal(agent._progressRead(1, { currentTaskOnly: true }).counts.processed, 1);
  });

  test(`${build}: wrong, old, pending, draft and unrelated-action observations cannot reconcile a send`, async () => {
    const invalid = [
      proof => ({ ...proof, threadKey: 'dom:telegram:k:654321:0' }),
      proof => ({ ...proof, chatDeliveryVerification: { ...proof.chatDeliveryVerification, messageId: 'telegram:k:123456:0:1' } }),
      proof => ({ ...proof, chatDeliveryVerification: undefined }),
      proof => ({ ...proof, outcomeUnknown: true }),
      proof => ({ ...proof, composer: { available: true, empty: false } }),
      proof => ({ ...proof, chatWorkflow: { ...proof.chatWorkflow, pendingOutbound: true } }),
      proof => ({ ...proof, chatWorkflow: { ...proof.chatWorkflow, userInput: { required: true } } }),
      proof => ({ ...proof, chatDeliveryVerification: { ...proof.chatDeliveryVerification, actionSequence: 200 } }),
    ];
    for (const change of invalid) {
      const { agent, guard } = await fixture(); dispatch(agent, 1);
      observe(agent, change(observation(agent, 1)));
      assert.equal(guard.successfulConsequentialToolCalls, 0);
      assert.equal(agent._progressRead(1, { currentTaskOnly: true }).counts.processed, 0);
      assert.equal(agent.completionInvariants.get(1).verificationDebt, true);
    }
    const { agent, guard } = await fixture(); dispatch(agent, 1);
    const stale = observation(agent, 1);
    agent._recordCompletionToolResult(1, 'click', {}, { success: true });
    observe(agent, stale);
    assert.equal(guard.successfulConsequentialToolCalls, 0);
    assert.equal(agent._progressRead(1, { currentTaskOnly: true }).counts.processed, 0);
    assert.equal(agent.completionInvariants.get(1).verificationDebt, true);
  });

  test(`${build}: proof remains bounded to its current task, run, approved peer and cancellation state`, async () => {
    for (const change of [
      agent => agent.conversations.get(1).push({ role: 'user', content: 'A new unrelated task', webbrainUserAuthoredText: 'A new unrelated task' }),
      agent => agent._beginCompletionInvariant(1),
      agent => { agent._planExecutionGuards.get(1).messaging.recipients[0].identity = 'telegram:k:654321:0'; },
      agent => { agent._checkAbort = () => true; },
      agent => { agent._hasUnvalidatedSteering = () => true; },
    ]) {
      const { agent, guard } = await fixture(); dispatch(agent, 1);
      const proof = observation(agent, 1); change(agent); observe(agent, proof);
      assert.equal(guard.successfulConsequentialToolCalls, 0);
      assert.equal(agent._progressRead(1, { currentTaskOnly: true }).counts.processed, 0);
    }
  });

  test(`${build}: required fields, explicit targets and extra ledger metadata retain their bulk completion gates`, async () => {
    for (const options of [
      { expected: { count: 20, item_type: 'row', required_fields: ['receipt'] } },
      { expected: { count: 20, item_type: 'row', required_fields: [] } },
      // The planner's canonical item type is "reply"; prose is not read.
      { expected: { item_type: 'chat replies' } },
      { expected: { item_type: 'sohbet yanıtları' } },
      { expected: { ordered: false } },
      { targets: [{ identity: 'owned-row', label: 'Owned row' }] },
      { recipients: [{ identity: 'telegram:k:123456:0', role: 'to' }, { identity: 'telegram:k:654321:0', role: 'to' }] },
    ]) {
      const { agent } = await fixture(options); dispatch(agent, 1); observe(agent, observation(agent, 1));
      assert.equal(agent._progressRead(1, { currentTaskOnly: true }).counts.processed, 0);
      assert.ok(agent._progressDoneBlock(1));
    }
    const { agent } = await fixture();
    const session = agent._currentProgressSession(1);
    assert.equal(agent._progressUpdate(1, { items: [{ id: 'expected:1', status: 'pending', fields: { externalRowId: 'owned-row' } }] },
      { source: 'auto', sessionId: session.sessionId, pageScope: session.pageScope }).success, true);
    dispatch(agent, 1); observe(agent, observation(agent, 1));
    assert.equal(agent._progressRead(1, { currentTaskOnly: true }).counts.processed, 0);
    assert.ok(agent._progressDoneBlock(1));
  });

  test(`${build}: two actual replies to one incoming message cannot complete two conversation turns`, async () => {
    const { agent, guard } = await fixture();
    dispatch(agent, 1, { anchor: 'same-question' }); observe(agent, observation(agent, 1));
    dispatch(agent, 2, { anchor: 'same-question' }); observe(agent, observation(agent, 2));
    assert.equal(guard.successfulConsequentialToolCalls, 2, 'Both independently verified actual sends are execution evidence.');
    assert.equal(agent._progressRead(1, { currentTaskOnly: true }).counts.processed, 1, 'One incoming question owns only one ordered reply placeholder.');
    assert.ok(agent._progressDoneBlock(1));
  });

  test(`${build}: hundreds of chat deliveries keep action reconciliation bounded without hiding unresolved rows`, async () => {
    const { agent, guard } = await fixture();
    for (let ordinal = 1; ordinal <= 205; ordinal++) {
      dispatch(agent, ordinal); observe(agent, observation(agent, ordinal));
    }
    assert.equal(guard.successfulConsequentialToolCalls, 205);
    assert.equal(guard.successfulConsequentialActionKeys.size, 200);
    const current = observation(agent, 205); observe(agent, current); observe(agent, structuredClone(current));
    assert.equal(guard.successfulConsequentialToolCalls, 205);
    assert.equal(agent._progressRead(1, { currentTaskOnly: true }).counts.processed, 6);
  });

  test(`${build}: echoing the already-bound native peer reads deltas without resetting delivery, dedup or OTP state`, async () => {
    const { agent } = await fixture();
    const raw = { success: true, observedAt: new Date().toISOString(), url, threadKey,
      composer: { available: true, empty: true, ref: 'composer' },
      messages: [{ id: 'telegram:k:123456:0:1:rquestion', direction: 'incoming', text: 'Owned question one.' }] };
    agent._readChatObservation = async () => structuredClone(raw);
    await agent._observeChatWorkflow(1);
    const decision = decideChatSend(agent.chatSessions.get(1), raw, 'Owned reply one.');
    assert.equal(decision.ok, true);
    agent.chatSessions.set(1, markChatSendPending(agent.chatSessions.get(1), decision));
    const pendingKey = agent.chatSessions.get(1).pendingOutbound.key;
    const echoedArgs = { rebind_thread_key: threadKey, reconcile_pending_outbound: false, pending_outbound_key: '' };
    const pending = await agent._observeChatWorkflow(1, echoedArgs);
    assert.equal(pending.success, true);
    assert.equal(pending.chatWorkflow.pendingOutboundKey, pendingKey, 'A same-peer echo cannot clear an uncertain send.');
    assert.equal(pending.chatWorkflow.newMessages.length, 0, 'A same-peer echo cannot replay consumed incoming messages.');
    raw.messages.push({ id: 'telegram:k:123456:0:2', direction: 'outgoing', text: 'Owned reply one.', authoredText: 'Owned reply one.' });
    const confirmed = await agent._observeChatWorkflow(1, echoedArgs);
    assert.equal(confirmed.success, true); assert.equal(confirmed.chatWorkflow.pendingOutbound, false);
    assert.equal(decideChatSend(agent.chatSessions.get(1), raw, 'Owned reply one.').reason, 'already_sent');
    raw.userInput = { required: true, reason: 'otp', message: 'Owned OTP stop.' };
    raw.messages.push({ id: 'telegram:k:123456:0:3:rnext', direction: 'incoming', text: 'Owned question two.' });
    const paused = await agent._observeChatWorkflow(1, echoedArgs);
    assert.equal(paused.success, true); assert.equal(paused.chatWorkflow.nextAction, 'pause_for_user');
    delete raw.userInput;
    const next = await agent._observeChatWorkflow(1, echoedArgs);
    assert.equal(next.success, true);
    assert.ok(next.chatWorkflow.newMessages.some(message => message.text === 'Owned question two.'));
    assert.equal((await agent._observeChatWorkflow(1, echoedArgs)).chatWorkflow.newMessages.length, 0);
  });

  test(`${build}: an AX hash or changed peer cannot use idempotent observation to reset the chat session`, async () => {
    const { agent } = await fixture();
    const raw = { success: true, url, threadKey, composer: { available: true, empty: true },
      messages: [{ id: 'telegram:k:123456:0:1:rquestion', direction: 'incoming', text: 'Owned question.' }] };
    agent._readChatObservation = async () => structuredClone(raw);
    await agent._observeChatWorkflow(1);
    const prior = structuredClone(agent.chatSessions.get(1));
    const hash = await agent._observeChatWorkflow(1, { rebind_thread_key: 'fnv1a64:2ae0dbd8de506919' });
    assert.equal(hash.success, false); assert.equal(hash.reason, 'thread_rebind_not_allowed');
    assert.deepEqual(agent.chatSessions.get(1), prior);
    raw.threadKey = 'dom:telegram:k:654321:0';
    const mismatch = await agent._observeChatWorkflow(1, { rebind_thread_key: threadKey });
    assert.equal(mismatch.success, false); assert.equal(mismatch.reason, 'thread_rebind_not_allowed');
    assert.deepEqual(agent.chatSessions.get(1), prior);
    const paused = await agent._observeChatWorkflow(1);
    assert.equal(paused.chatWorkflow.nextAction, 'pause_for_user');
    assert.equal(agent.chatSessions.get(1).stopReason, 'thread_changed');
  });

  test(`${build}: a pristine first read accepts only its fresh exact peer echo and gives a recoverable AX-hash error`, async () => {
    const { agent } = await fixture();
    const raw = { success: true, url, threadKey, composer: { available: true, empty: true },
      messages: [{ id: 'telegram:k:123456:0:1:rquestion', direction: 'incoming', text: 'Owned initial question.' }] };
    agent._readChatObservation = async () => structuredClone(raw);
    const first = await agent._observeChatWorkflow(1, { rebind_thread_key: threadKey,
      reconcile_pending_outbound: false, pending_outbound_key: '' });
    assert.equal(first.success, true); assert.equal(first.threadKey, threadKey);
    assert.equal(first.chatWorkflow.newMessages.length, 1);
    assert.equal((await agent._observeChatWorkflow(1, { rebind_thread_key: threadKey })).chatWorkflow.newMessages.length, 0);

    const other = await fixture(); other.agent._readChatObservation = async () => structuredClone(raw);
    const hash = await other.agent._observeChatWorkflow(1, { rebind_thread_key: 'fnv1a64:2ae0dbd8de506919' });
    assert.equal(hash.success, false); assert.equal(hash.reason, 'thread_rebind_not_allowed');
    assert.match(hash.error, /rebind_thread_key:""/);
    assert.equal(other.agent.chatSessions.has(1), false, 'An invalid option must not silently bind or reset workflow state.');
    const recovered = await other.agent._observeChatWorkflow(1, { rebind_thread_key: '',
      reconcile_pending_outbound: false, pending_outbound_key: '' });
    assert.equal(recovered.success, true); assert.equal(recovered.chatWorkflow.newMessages.length, 1);

    for (const retained of [{ seenMessageIds: ['owned-old'] }, { sentMessageKeys: ['owned-sent'] },
      { pendingOutbound: { key: 'owned-pending', text: 'Owned pending reply.' } },
      { completionReceipt: { schema: 'owned-existing-receipt' } }, { telegramIncomingHighWater: '1' },
      { telegramOutgoingHighWater: '2' }, { userInput: { required: true, reason: 'otp' } }]) {
      const dirty = await fixture(); dirty.agent._readChatObservation = async () => structuredClone(raw);
      const prior = { ...createChatSession(), ...retained };
      dirty.agent.chatSessions.set(1, structuredClone(prior));
      const blocked = await dirty.agent._observeChatWorkflow(1, { rebind_thread_key: threadKey });
      assert.equal(blocked.success, false);
      assert.deepEqual(dirty.agent.chatSessions.get(1), prior, 'A retained unbound workflow cannot masquerade as pristine.');
    }
  });
}
