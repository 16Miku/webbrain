import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { createCompletionInvariantState, recordCompletionToolResult, completionDoneBlock } =
    await import(`../src/${build}/src/agent/completion-invariant.js`);
  const peer = 'whatsapp:phone:' + 'a'.repeat(32), threadKey = 'dom:' + peer;
  const oldId = peer + ':opaque-Z-before', newId = peer + ':opaque-A-after';
  const documentEpoch = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', timeOrigin = 123456;
  const binding = { complete: true, threadKey, body: 'Owned reply 🧪', messageIds: [oldId],
    documentEpoch, timeOrigin, url: 'https://web.whatsapp.com/' };
  const raw = () => ({ success: true, threadKey, url: 'https://web.whatsapp.com/',
    composer: { available: true, empty: true }, messages: [
      { id: newId, direction: 'outgoing', text: binding.body, authoredText: binding.body },
    ], nativeChatDeliveryProof: { schema: 'webbrain-native-mounted-delivery/1', threadKey,
      body: binding.body, baselineMessageIds: [oldId], messageId: newId, documentEpoch, timeOrigin, url: binding.url } });
  const advanced = observation => ({ snapshot: { threadKey, messages: observation.messages },
    session: { threadKey, pendingOutbound: null, userInput: null } });
  const agentFor = name => {
    const agent = new Agent({});
    agent.completionInvariants.set(1, recordCompletionToolResult(createCompletionInvariantState('owned-run'),
      name, {}, { success: true, dispatched: true, outcomeUnknown: true }, { chatDeliveryBinding: binding }));
    agent._chatObservationResult = observation => ({ success: true, threadKey, url: observation.url,
      composer: observation.composer, chatWorkflow: { threadKey, pendingOutbound: false } });
    return agent;
  };

  for (const name of ['chat_send', 'set_field', 'click_ax']) {
    test(`${build}: delayed opaque receipt verifies ${name} only with the private mounted-tail certificate`, () => {
      const agent = agentFor(name), observation = raw();
      const prior = agent.completionInvariants.get(1);
      assert.ok(prior.lastAction.chatDeliveryBinding, 'The guarded native WhatsApp baseline must survive action accounting.');
      const result = agent._chatCompletionObservationResult(1, observation, advanced(observation));
      assert.equal(result.nativeChatDeliveryProof, undefined, 'Private floor/body/baseline transport stays out of the public tool result.');
      assert.equal(result.chatDeliveryVerification.nativeMountedTailVerified, true);
      assert.equal(result.chatDeliveryVerification.messageId, newId, 'Opaque lexical order is unrelated to delivery order.');
      const verified = recordCompletionToolResult(prior, 'chat_observe', {}, result);
      assert.equal(completionDoneBlock(verified, 'done', { outcome: 'success' }), null);
      const bare = { ...result, chatDeliveryVerification: { ...result.chatDeliveryVerification, nativeMountedTailVerified: undefined } };
      assert.equal(recordCompletionToolResult(prior, 'chat_observe', {}, bare).verificationDebt, true);
      const later = recordCompletionToolResult(prior, 'click', {}, { success: true });
      assert.equal(recordCompletionToolResult(later, 'chat_observe', {}, result).verificationDebt, true);
    });
  }

  const corruptions = {
    'no private floor after restart': observation => { delete observation.nativeChatDeliveryProof; },
    'other baseline': observation => { observation.nativeChatDeliveryProof.baselineMessageIds = [peer + ':different-before']; },
    'duplicated baseline': observation => { observation.nativeChatDeliveryProof.baselineMessageIds.push(oldId); },
    'other peer': observation => { observation.nativeChatDeliveryProof.threadKey = 'dom:whatsapp:phone:' + 'b'.repeat(32); },
    'edited authored body': observation => { observation.nativeChatDeliveryProof.body = 'Different reply'; },
    'old historical receipt': observation => { observation.nativeChatDeliveryProof.messageId = oldId; },
    'missing delivered row': observation => { observation.messages = []; },
    'incoming echo': observation => { observation.messages[0].direction = 'incoming'; },
  };
  for (const [label, corrupt] of Object.entries(corruptions)) {
    test(`${build}: ${label} cannot discharge an uncertain native send`, () => {
      const agent = agentFor('chat_send'), observation = raw(); corrupt(observation);
      const result = agent._chatCompletionObservationResult(1, observation, advanced(observation));
      assert.equal(result.chatDeliveryVerification, undefined);
      assert.equal(recordCompletionToolResult(agent.completionInvariants.get(1), 'chat_observe', {}, result).verificationDebt, true);
    });
  }
  test(`${build}: absent or model-authored native WhatsApp baselines cannot authorize completion`, () => {
    for (const invalid of [{ ...binding, complete: false }, { ...binding, messageIds: [] },
      { ...binding, messageIds: [oldId, oldId] }, { ...binding, messageIds: ['other-peer:opaque'] }]) {
      const state = recordCompletionToolResult(createCompletionInvariantState(), 'chat_send', {},
        { dispatched: true, outcomeUnknown: true }, { chatDeliveryBinding: invalid });
      assert.equal(state.lastAction.chatDeliveryBinding, undefined);
    }
    const forged = recordCompletionToolResult(createCompletionInvariantState(), 'click_ax',
      { chatDeliveryBinding: binding }, { success: true });
    assert.equal(forged.lastAction.chatDeliveryBinding, undefined);
  });
}
