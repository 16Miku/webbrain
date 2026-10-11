import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const { createCompletionInvariantState, recordCompletionToolResult, completionDoneBlock } =
    await import(`../src/${build}/src/agent/completion-invariant.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  test(`${build}: new chat deltas are progress while unchanged polling still triggers loop recovery`, () => {
    const progressing = new Agent({}), polling = new Agent({}), repeated = new Agent({});
    const result = ids => ({ success: true, threadKey: 'dom:telegram:k:123456:0', chatWorkflow: {
      threadKey: 'dom:telegram:k:123456:0', newMessages: ids.map(id => ({ id, direction: 'incoming', text: 'Repeated text' })),
    } });
    for (let turn = 1; turn <= 30; turn++) {
      assert.equal(progressing._checkLoop(1, 'chat_observe', {}, result([`native-${turn}`])).kind, 'none');
      assert.equal(progressing._checkLoop(1, 'chat_send', { text: `Reply ${turn}` }, { success: true }).kind, 'none');
    }
    assert.equal(polling._checkLoop(1, 'chat_observe', {}, result([])).kind, 'none');
    assert.equal(polling._checkLoop(1, 'chat_observe', {}, result([])).kind, 'none');
    assert.equal(polling._checkLoop(1, 'chat_observe', {}, result([])).kind, 'nudge');
    assert.equal(repeated._checkLoop(1, 'chat_observe', {}, result(['same-native-id'])).kind, 'none');
    assert.equal(repeated._checkLoop(1, 'chat_observe', {}, result(['same-native-id'])).kind, 'none');
    assert.equal(repeated._checkLoop(1, 'chat_observe', {}, result(['same-native-id'])).kind, 'nudge');
  });
  test(`${build}: chat delivery proof is bound to the latest exact native send`, () => {
    const threadKey = 'dom:telegram:k:123456:0';
    const baseline = { complete: true, threadKey, body: 'Fixture reply', messageIds: ['telegram:k:123456:0:11'] };
    const dispatched = recordCompletionToolResult(createCompletionInvariantState(), 'click_ax', {},
      { success: true }, { chatDeliveryBinding: baseline });
    const proof = { success: true, threadKey, composer: { available: true, empty: true },
      chatWorkflow: { threadKey, pendingOutbound: false }, chatDeliveryVerification: {
        schema: 'webbrain-chat-completion/1', actionSequence: dispatched.lastAction.sequence,
        threadKey, messageId: 'telegram:k:123456:0:12',
      } };
    for (const bad of [
      { ...proof, chatDeliveryVerification: undefined },
      { ...proof, outcomeUnknown: true },
      { ...proof, error: 'Read failed' },
      { ...proof, threadKey: 'dom:telegram:k:987654:0' },
      { ...proof, composer: { available: true, empty: false } },
      { ...proof, chatWorkflow: { threadKey, pendingOutbound: true } },
      { ...proof, chatWorkflow: { threadKey, pendingOutbound: false, userInput: { required: true } } },
      ...['telegram:k:123456:0:11', 'telegram:k:123456:0:2', 'telegram:k:987654:0:12', 'telegram:k:123456:0:pending']
        .map(messageId => ({ ...proof, chatDeliveryVerification: { ...proof.chatDeliveryVerification, messageId } })),
      { ...proof, chatDeliveryVerification: { ...proof.chatDeliveryVerification, actionSequence: 99 } },
    ]) {
      assert.equal(recordCompletionToolResult(dispatched, 'chat_observe', {}, bad).verificationDebt, true);
    }
    const verified = recordCompletionToolResult(dispatched, 'chat_observe', {}, proof);
    assert.equal(completionDoneBlock(verified, 'done', { outcome: 'success' }), null);
    const laterAction = recordCompletionToolResult(dispatched, 'click', {}, { success: true });
    assert.equal(recordCompletionToolResult(laterAction, 'chat_observe', {}, proof).verificationDebt, true);
    const incomplete = recordCompletionToolResult(createCompletionInvariantState(), 'click', {},
      { success: true }, { chatDeliveryBinding: { ...baseline, complete: false } });
    assert.equal(recordCompletionToolResult(incomplete, 'chat_observe', {}, proof).verificationDebt, true);
    assert.equal(recordCompletionToolResult(createCompletionInvariantState(), 'click',
      { chatDeliveryBinding: baseline }, { success: true }).lastAction.chatDeliveryBinding, undefined,
      'Model-supplied tool arguments cannot install trusted delivery evidence');
  });
  test(`${build}: chat_send accounts for uncertain dispatch and independently verified delivery`, () => {
    const threadKey = 'dom:telegram:k:123456:0';
    const args = { thread_key: threadKey, text: 'Fixture reply' };
    const delivered = { success: true, sent: true, dispatched: true, deliveryVerified: true,
      verificationRequired: false, threadKey, composer: { available: true, empty: true },
      chatWorkflow: { threadKey, pendingOutbound: false } };
    assert.equal(recordCompletionToolResult(createCompletionInvariantState(), 'chat_send', args, delivered).verificationDebt, false);
    for (const bad of [
      { success: true },
      { ...delivered, deliveryVerified: false },
      { ...delivered, dispatched: false },
      { ...delivered, threadKey: 'other-thread' },
      { ...delivered, outcomeUnknown: true },
      { ...delivered, chatWorkflow: { threadKey, pendingOutbound: true } },
    ]) assert.equal(recordCompletionToolResult(createCompletionInvariantState(), 'chat_send', args, bad).verificationDebt, true);
    const noDispatch = recordCompletionToolResult(createCompletionInvariantState(), 'chat_send', args,
      { success: false, noDispatch: true, dispatched: false });
    assert.equal(noDispatch.hadAction, false);
    const priorDebt = recordCompletionToolResult(createCompletionInvariantState(), 'click', {}, { success: true });
    assert.equal(recordCompletionToolResult(priorDebt, 'chat_send', args, delivered).verificationDebt, true,
      'Independent verification of a chat send cannot erase debt from an unrelated earlier action');
  });
  test(`${build}: late structured chat delivery retains its native proof through public wrappers and terminal submit gates`, async () => {
    const agent = new Agent({}), tabId = 748, threadKey = 'dom:telegram:k:123456:0';
    const url = 'https://web.telegram.org/k/#123456', body = 'A delayed generated fixture reply.';
    agent.conversations.set(tabId, [{ role: 'system', content: 'system' }, { role: 'user', content: 'Have a bounded QA dialogue with WebBrain QA Bot.' }]);
    agent.conversationModes.set(tabId, 'act');
    const guard = agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute',
      requiresStateChange: true, requiresSubmission: true,
      messaging: { target_kind: 'named', recipients: [{ identity: 'telegram:k:123456:0', role: 'to' }] } });
    agent._beginCompletionInvariant(tabId);
    const raw = { success: true, observedAt: new Date().toISOString(), url, threadKey,
      composer: { available: true, empty: true, ref: 'composer' },
      nativeChatMessageBaseline: { complete: true, coverage: 'mounted_native_id_floor', threadKey,
        messageIds: ['telegram:k:123456:0:1'] },
      messages: [{ id: 'telegram:k:123456:0:1:rfixture', direction: 'incoming', text: 'Fixture question' }] };
    agent._currentUrl = async () => url; agent._readChatObservation = async () => structuredClone(raw);
    agent._persist = () => {}; agent._persistNow = async () => true;
    agent._messageRecipientGuardBlock = async (_tab, _tool, _args, _url, context) => {
      Object.assign(context, { messageRecipientGuardRequired: true, messageRecipientBody: body,
        messageRecipientDispatchBinding: { token: 'fixture-token' },
        messageRecipientNativeChatBaseline: structuredClone(raw.nativeChatMessageBaseline) });
      return null;
    };
    const execute = agent._executeToolImpl.bind(agent);
    agent._executeToolImpl = async (id, name, args, update, context) => name === 'set_field'
      ? { success: true, dispatched: true, verified: true, method: 'fixture-text-dispatch' }
      : execute(id, name, args, update, context);
    await agent._observeChatWorkflow(tabId);
    const context = { chatCompletionBindingSink: {}, _contentActionDispatchState: { started: false } };
    const args = { thread_key: threadKey, text: body };
    const uncertain = await agent.executeTool(tabId, 'chat_send', args, null, context);
    assert.equal(uncertain.deliveryVerified, false, 'The outer result must retain workflow fields, even after inner field success');
    assert.equal(uncertain.chatWorkflow.pendingOutbound, true);
    assert.equal(context._contentActionDispatchState.started, true);
    agent._recordCompletionToolResult(tabId, 'chat_send', args, uncertain, { messageRecipientContext: context });
    assert.equal(agent.completionInvariants.get(tabId).verificationDebt, true);
    raw.messages.push({ id: 'telegram:k:123456:0:2', direction: 'outgoing', text: body, authoredText: body });
    raw.nativeChatMessageBaseline.messageIds.push('telegram:k:123456:0:2');
    const late = await agent._observeChatWorkflow(tabId);
    assert.ok(late.chatDeliveryVerification);
    agent._recordCompletionToolResult(tabId, 'chat_observe', {}, late);
    assert.equal(agent.completionInvariants.get(tabId).verificationDebt, false);
    const native = agent._nativeChatTerminalEvidence(tabId, late, url);
    assert.ok(native, 'The terminal submit gate must accept the same current task, peer and exact delivery proof');
    guard.nativeChatDeliveryEvidence = native;
    const page = { relevantFormCount: 0, nativeChatDeliveryEvidence: native };
    assert.equal(agent._completionSubmissionEvidence(tabId, page, url).verifiedFinalSubmit, true);
    for (const changed of [{ ...late, url: `${url}0` }, { ...late, chatDeliveryVerification: undefined },
      { ...late, composer: { available: true, empty: false } }]) {
      assert.equal(agent._nativeChatTerminalEvidence(tabId, changed, url), null);
    }
    const priorProof = guard.nativeChatDeliveryEvidence;
    agent._recordCompletionToolResult(tabId, 'click', {}, { success: true });
    assert.equal(agent._completionSubmissionEvidence(tabId, { ...page, nativeChatDeliveryEvidence: priorProof }, url).verifiedFinalSubmit, false,
      'A later consequential action invalidates the old native terminal receipt');
  });
}

// First-observation rows are history, not an owned current-task delivery.
for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { createChatSession, advanceChatSession, decideChatSend, markChatSendPending } =
    await import(`../src/${build}/src/agent/chat-workflow.js`);
  const threadKey = 'dom:telegram:k:123456:0', url = 'https://web.telegram.org/k/#123456';
  const old = { id: 'telegram:k:123456:0:11', direction: 'outgoing', text: '/start' };
  const body = 'A distinct current requested message.';
  const snapshot = (messages = [old]) => ({ success: true, observedAt: new Date().toISOString(), url, threadKey,
    composer: { available: true, empty: true, ref: 'composer' }, messages,
    nativeChatMessageBaseline: { complete: true, coverage: 'mounted_native_id_floor', threadKey,
      messageIds: messages.map(message => message.id) } });
  test(`${build}: initial outgoing history establishes dedup without fresh-delivery progress`, () => {
    const initial = advanceChatSession(createChatSession(), snapshot());
    assert.deepEqual(initial.newMessages, []);
    assert.equal(initial.initialOutgoingHistoryCount, 1);
    assert.equal(initial.events.some(event => event.type === 'outgoing_verified'), false);
    assert.equal(initial.events.some(event => event.type === 'outgoing_history_observed'), true);
    assert.notEqual(initial.session.state, 'we_responded');
    assert.equal(initial.nextAction, 'observe');
    assert.equal(initial.session.telegramOutgoingHighWater, '11');
    assert.equal(initial.session.sentMessageKeys.length, 1);
    assert.equal(decideChatSend(initial.session, snapshot(), '/start').reason, 'already_sent');
    assert.equal(decideChatSend(initial.session, snapshot(), body).ok, true);
    const unchanged = advanceChatSession(initial.session, snapshot());
    assert.deepEqual(unchanged.newMessages, []);
    assert.equal(unchanged.session.sentMessageKeys.length, 1);
    const empty = advanceChatSession(createChatSession(), snapshot([]));
    const later = advanceChatSession(empty.session, snapshot());
    assert.equal(later.initialOutgoingHistoryCount || 0, 0);
    assert.equal(later.newMessages.length, 1, 'An empty first baseline must not swallow a later outgoing delta.');
    assert.equal(later.events.some(event => event.type === 'outgoing_verified'), true);
    const generic = advanceChatSession(createChatSession(), { threadKey: 'neutral-conversation',
      composer: { available: true, empty: true }, messages: [{ id: 'opaque-old', direction: 'outgoing', text: 'Earlier reply.' }] });
    assert.deepEqual(generic.newMessages, []);
    assert.equal(generic.initialOutgoingHistoryCount, 1);
    assert.equal(decideChatSend(generic.session, generic.snapshot, 'Earlier reply.').reason, 'already_sent');
  });
  test(`${build}: an owned pending delivery on first observation retains current delivery and its floor`, async () => {
    const session = createChatSession({ threadKey });
    const decision = decideChatSend(session, snapshot(), body);
    const pending = markChatSendPending(session, decision);
    const fresh = { id: 'telegram:k:123456:0:12', direction: 'outgoing', text: body };
    const observed = advanceChatSession(pending, snapshot([old, fresh]));
    assert.equal(observed.initialOutgoingHistoryCount || 0, 0);
    assert.equal(observed.session.pendingOutbound, null);
    assert.equal(observed.session.state, 'we_responded');
    assert.equal(observed.events.some(event => event.type === 'outgoing_verified'), true);
    assert.equal(decideChatSend(observed.session, snapshot([old, fresh]), body).reason, 'already_sent');
    // An actual new task can reuse a persisted conversation whose old state
    // already says we_responded. Preserve history/dedup; do not call it this
    // new goal's delivery or forbid its distinct requested body.
    const agent = new Agent({}), tabId = 844;
    const currentBody = 'A separate new explicit send goal.';
    agent.conversations.set(tabId, [{ role: 'system', content: 'system' }, { role: 'user',
      content: 'Send exactly one message with literal body: "' + currentBody + '". Do not send /start.' }]);
    agent.conversationModes.set(tabId, 'act');
    agent._persist = () => {};
    agent._readChatObservation = async () => structuredClone(snapshot());
    agent._currentUrl = async () => url;
    const guard = agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute',
      requiresStateChange: true, requiresSubmission: true,
      messaging: { target_kind: 'named', recipients: [{ identity: threadKey.slice(4), role: 'to' }] } });
    agent._beginCompletionInvariant(tabId);
    const stored = advanceChatSession(createChatSession(), snapshot()).session;
    agent.chatSessions.set(tabId, { ...stored, state: 'we_responded' });
    const reused = await agent._observeChatWorkflow(tabId);
    assert.equal(reused.chatWorkflow.state, 'we_responded', 'A new goal must not reset conversation state.');
    assert.deepEqual(reused.chatWorkflow.newMessages, []);
    assert.deepEqual(agent.chatSessions.get(tabId).sentMessageKeys, stored.sentMessageKeys);
    assert.deepEqual(agent.chatSessions.get(tabId).seenMessageIds, stored.seenMessageIds);
    assert.equal(agent.chatSessions.get(tabId).telegramOutgoingHighWater, '11');
    assert.equal(decideChatSend(agent.chatSessions.get(tabId), snapshot(), '/start').reason, 'already_sent');
    assert.equal(decideChatSend(agent.chatSessions.get(tabId), snapshot(), currentBody).ok, true);
    assert.equal(agent.chatSessions.get(tabId).completionReceipt, null);
    assert.equal(reused.chatDeliveryVerification, undefined);
    assert.equal(reused.chatGoalDeliveryVerification, undefined);
    assert.equal(agent._nativeChatTerminalEvidence(tabId, reused, url), null);
    assert.equal(agent._executionEvidenceSatisfied(guard), false);
    // The original source has no guidance field; its authority/dedup checks
    // above remain a baseline-positive preservation fixture. The candidate
    // must also tell the model that inherited state is not current delivery.
    if (reused.chatWorkflow.deliveryGuidance !== undefined) {
      assert.match(reused.chatWorkflow.deliveryGuidance, /do not prove delivery for the current task/);
      assert.match(reused.chatWorkflow.deliveryGuidance, /current requested body and goal/);
    }
    agent.chatSessions.set(tabId, { ...agent.chatSessions.get(tabId), pendingOutbound: pending.pendingOutbound });
    const stillUncertain = await agent._observeChatWorkflow(tabId);
    assert.ok(stillUncertain.chatWorkflow.pendingOutbound);
    assert.equal(agent.chatSessions.get(tabId).pendingOutbound.key, pending.pendingOutbound.key);
    assert.equal(decideChatSend(agent.chatSessions.get(tabId), snapshot(), currentBody).reason, 'send_pending');

  });
  test(`${build}: first incoming question remains actionable while existing outgoing rows stay historical`, () => {
    const question = { id: 'telegram:k:123456:0:12', direction: 'incoming', text: 'Current question.' };
    const observed = advanceChatSession(createChatSession(), snapshot([old, question]));
    assert.deepEqual(observed.newMessages.map(message => message.id), [question.id]);
    assert.equal(observed.nextAction, 'reply');
    assert.equal(observed.session.state, 'counterparty_replied');
    assert.equal(observed.session.sentMessageKeys.length, 1);
    assert.equal(observed.session.telegramOutgoingHighWater, '11');
  });
  test(`${build}: real Agent observation distinguishes an old start from the current send goal`, async () => {
    const agent = new Agent({}), tabId = 843;
    agent.conversations.set(tabId, [{ role: 'system', content: 'system' }, { role: 'user',
      content: 'Send exactly one message with literal body: "' + body + '". Do not send /start.' }]);
    agent.conversationModes.set(tabId, 'act');
    agent._persist = () => {};
    agent._readChatObservation = async () => structuredClone(snapshot());
    agent._currentUrl = async () => url;
    const guard = agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute',
      requiresStateChange: true, requiresSubmission: true,
      messaging: { target_kind: 'named', recipients: [{ identity: threadKey.slice(4), role: 'to' }] } });
    agent._beginCompletionInvariant(tabId);
    const result = await agent._observeChatWorkflow(tabId);
    assert.deepEqual(result.chatWorkflow.newMessages, []);
    assert.equal(result.chatWorkflow.initialOutgoingHistoryCount, 1);
    assert.equal(result.chatWorkflow.nextAction, 'observe');
    assert.match(result.chatWorkflow.deliveryGuidance, /do not prove delivery for the current task/);
    assert.match(result.chatWorkflow.deliveryGuidance, /uncertain sends blocked/);
    assert.equal(result.chatDeliveryVerification, undefined);
    assert.equal(result.chatGoalDeliveryVerification, undefined);
    assert.equal(agent.chatSessions.get(tabId).completionReceipt, null);
    assert.equal(agent._nativeChatTerminalEvidence(tabId, result, url), null);
    assert.equal(agent._executionEvidenceSatisfied(guard), false);
    assert.equal(decideChatSend(agent.chatSessions.get(tabId), snapshot(), body).ok, true);
  });
}
