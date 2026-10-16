import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { serializeConversationForSession } = await import(`../src/${build}/src/agent/conversation-persistence.js`);
  const { BaseLLMProvider } = await import(`../src/${build}/src/providers/base.js`);
  const { OpenAICompatibleProvider } = await import(`../src/${build}/src/providers/openai.js`);
  const { mapProviderMessages } = await import(`../src/${build}/src/providers/provider-compatibility.js`);

  test(`${build}: private genuine-turn resume identity persists locally but never enters provider chat bodies`, () => {
    const agent = new Agent({}); agent._persist = () => {};
    const messages = [{ role: 'system', content: 'Owned fixture system.' },
      { role: 'user', content: 'Continue the owned QA dialogue.' }];
    agent.conversations.set(819, messages);
    const taskId = agent._resumeTaskId(819, { create: true });
    assert.match(taskId, /^resume_task_/);
    const stored = serializeConversationForSession(messages, { preserveMessageIndices: [1] }).messages;
    assert.equal(stored[1].webbrainResumeTaskId, taskId);
    const restored = JSON.parse(JSON.stringify(stored));
    const provider = new OpenAICompatibleProvider({ model: 'gpt-4o' });
    for (const stream of [false, true]) {
      const body = provider._buildChatCompletionsBody(restored, {}, stream);
      assert.deepEqual(body.messages, messages.map(({ role, content }) => ({ role, content })));
      assert.equal(JSON.stringify(body).includes('webbrainResumeTaskId'), false);
    }
    assert.equal(JSON.stringify(provider._responsesInput(restored)).includes('webbrainResumeTaskId'), false);
    assert.equal(restored[1].webbrainResumeTaskId, taskId, 'Provider projection must not alter durable local identity.');
  });

  test(`${build}: direct compatibility projection and base provider share bounded app-metadata exclusions`, () => {
    const message = { role: 'user', content: 'Owned user words.', webbrainResumeTaskId: 'resume_task_owned',
      webbrainPlannerClarification: { task: 'owned' }, webbrainAppOwned: true, webbrainAppOwnedKind: 'fixture',
      webbrainSelectionScopeRestored: true, webbrainUserAuthoredText: 'Owned original words.',
      webbrainTurnKind: 'update', webbrainTaskClarifications: [{ question: 'Which?', answer: 'Owned reply.', source: 'text' }] };
    const before = structuredClone(message), expected = [{ role: 'user', content: message.content }];
    assert.deepEqual(new BaseLLMProvider()._mapMessages([message]), expected);
    assert.deepEqual(mapProviderMessages([message]), expected);
    assert.deepEqual(message, before);
    const system = { role: 'system', content: 'Owned system.', webbrainResumeTaskId: 'resume_task_system' };
    const mapped = mapProviderMessages([system], { compat: { systemPromptRole: 'developer' } });
    assert.equal(mapped[0].role, 'developer');
    assert.equal(Object.hasOwn(mapped[0], 'webbrainResumeTaskId'), false);
    assert.equal(system.role, 'system'); assert.equal(system.webbrainResumeTaskId, 'resume_task_system');
  });

  test(`${build}: projection preserves ordinary structured tool and multimodal wire fields`, () => {
    const calls = [{ id: 'owned_call', type: 'function', function: { name: 'chat_observe', arguments: '{}' } }];
    const messages = [{ role: 'assistant', content: null, tool_calls: calls, webbrainResumeTaskId: 'resume_task_internal' },
      { role: 'tool', tool_call_id: 'owned_call', content: '{"success":true}' },
      { role: 'user', content: [{ type: 'text', text: 'Owned multimodal question.' }] }];
    const mapped = new BaseLLMProvider()._mapMessages(messages);
    assert.deepEqual(mapped, [{ role: 'assistant', content: null, tool_calls: calls }, ...messages.slice(1)]);
    assert.equal(messages[0].webbrainResumeTaskId, 'resume_task_internal');
  });

  test(`${build}: applied genuine steering keeps its private prior dispatch receipt locally while provider sees the shared user task without private receipts`, () => {
    const agent = new Agent({}); agent._persist = () => {}; agent._traceSteeringRevision = () => {};
    const messages = [{ role: 'system', content: 'Owned system.' }, { role: 'user', content: 'Fill the owned form.' }];
    agent.conversations.set(820, messages);
    agent._completionSubmitStates.set(820, { dispatched: true, privateDispatchToken: 'OWNED_PRIVATE_DISPATCH_RECEIPT' });
    agent._steeringRuns.set(820, { requestId: 'owned-run', revision: 0,
      messages: [{ id: 'owned-correction', text: 'Keep the result as a draft; the literal word webbrainSteering stays in my text.' }] });
    assert.equal(agent._applyPendingSteering(820, messages, () => {}), true);
    const applied = messages.at(-1);
    assert.equal(applied.webbrainSteering.priorSubmission.privateDispatchToken, 'OWNED_PRIVATE_DISPATCH_RECEIPT');
    const stored = serializeConversationForSession(messages, { preserveMessageIndices: [2] }).messages;
    assert.equal(stored[2].webbrainSteering.messageId, 'owned-correction');
    const provider = new OpenAICompatibleProvider({ model: 'gpt-4o' });
    const body = provider._buildChatCompletionsBody(agent._modelVisibleConversationMessages(stored), {}, false);
    assert.ok(body.messages.at(-1).content.startsWith(applied.content));
    assert.ok(body.messages.at(-1).content.endsWith(agent._plannerAuthenticTaskText(stored)));
    assert.equal(applied.content, 'Keep the result as a draft; the literal word webbrainSteering stays in my text.');
    assert.equal(Object.hasOwn(body.messages.at(-1), 'webbrainSteering'), false);
    assert.equal(JSON.stringify(body).includes('OWNED_PRIVATE_DISPATCH_RECEIPT'), false);
    assert.equal(applied.webbrainSteering.messageId, 'owned-correction');
    const future = { role: 'user', name: 'owned_name', content: 'Keep ordinary provider fields.',
      webbrainFuturePrivateReceipt: { token: 'PRIVATE_FUTURE_RECEIPT' }, customVendorFlag: true };
    assert.deepEqual(mapProviderMessages([future]), [{ role: 'user', name: 'owned_name', content: future.content, customVendorFlag: true }]);
    assert.equal(future.webbrainFuturePrivateReceipt.token, 'PRIVATE_FUTURE_RECEIPT');
  });
}
