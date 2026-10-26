import assert from 'node:assert/strict';
import { test } from 'node:test';

// Exercise the real guard, session serializer and hydration. Only browser
// storage is replaced; these tests never submit provider generation requests.
const stored = new Map();
const area = {
  get: async key => ({ [key]: stored.get(key) }),
  set: async values => { for (const [key, value] of Object.entries(values)) stored.set(key, structuredClone(value)); },
  remove: async key => { stored.delete(key); },
};
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://duration-test/${value}` },
};

const task = 'Generate a one-minute educational video.';
const gate = { requestKind: 'execute', requiresStateChange: false, requiresSubmission: false };
let nextTab = 14800;

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  function fixture() {
    const agent = new Agent({ getActive: () => ({ config: {} }) });
    const tab = nextTab++;
    agent._persist = () => {};
    agent.conversationIds.set(tab, `duration-conversation-${tab}`);
    agent.conversationModes.set(tab, 'act');
    agent.conversations.set(tab, [{ role: 'system', content: 'System' }, { role: 'user', content: task }]);
    const guard = agent._startPlanExecutionGuard(tab, 'act', gate);
    return { agent, tab, guard };
  }
  async function hydrate(tab, entry) {
    const cold = new Agent({ getActive: () => ({ config: {} }) });
    cold._persist = () => {};
    stored.set(cold._convKey(tab), structuredClone(entry));
    await cold._hydrateFromSession(tab);
    return cold;
  }

  test(`${build}: failed-only video obligation survives trusted Continue without success evidence`, () => {
    const { agent, tab, guard } = fixture();
    guard.videoDurationContract = { requestedSeconds: 60, status: 'failed' };
    assert.equal(guard.successfulTaskToolCalls, 0);
    assert.equal(guard.evidenceTaskKey, '');
    assert.equal(guard.conversationId, agent.conversationIds.get(tab));
    agent._storeContinuationExecutionEvidence(tab);
    const carried = agent._continuationExecutionEvidence.get(tab);
    assert.deepEqual(carried.videoDurationContract, guard.videoDurationContract);
    assert.notEqual(carried.videoDurationContract, guard.videoDurationContract);
    // A planner flag correction cannot erase a duration already established
    // by this exact task. It still does not carry unrelated success evidence.
    const resumed = agent._startPlanExecutionGuard(tab, 'act', { ...gate, requiresStateChange: true }, { trustedContinuation: true });
    assert.deepEqual(resumed.videoDurationContract, { requestedSeconds: 60, status: 'failed' });
    assert.equal(resumed.successfulTaskToolCalls, 0);
    assert.equal(resumed.evidenceTaskKey, '');
  });

  test(`${build}: active and torn-down video obligations survive actual session storage and cold hydration`, async () => {
    for (const status of ['pending', 'failed', 'short', 'enough']) {
      for (const tornDown of [false, true]) {
        const { agent, tab, guard } = fixture();
        const contract = status === 'enough'
          ? { requestedSeconds: 330, approvedDurationSeconds: 90, durationSeconds: 90, status }
          : { requestedSeconds: 60, ...(status === 'short' ? { durationSeconds: 5 } : {}), status };
        guard.videoDurationContract = { ...contract, prompt: 'This extra field must never persist.' };
        if (tornDown) {
          agent._storeContinuationExecutionEvidence(tab);
          agent._planExecutionGuards.delete(tab);
        }
        assert.equal((await agent._persistNow(tab)).ok, true);
        const entry = stored.get(agent._convKey(tab));
        assert.deepEqual(entry.videoDurationObligation, {
          taskKey: guard.taskKey, conversationId: guard.conversationId, contract,
        });
        const cold = await hydrate(tab, entry);
        assert.equal(cold._planExecutionGuards.has(tab), false, 'Hydration never authorizes a run.');
        const resumed = cold._startPlanExecutionGuard(tab, 'act', gate, { trustedContinuation: true });
        assert.deepEqual(resumed.videoDurationContract, contract);
        assert.equal(resumed.successfulTaskToolCalls, 0, 'A persisted media obligation is not generic execution evidence.');
      }
    }
  });

  test(`${build}: new tasks, conversation changes and untrusted starts cannot inherit a video obligation`, () => {
    for (const change of ['new-task', 'new-conversation', 'new-run', 'steering']) {
      const { agent, tab, guard } = fixture();
      guard.videoDurationContract = { requestedSeconds: 60, status: 'failed' };
      agent._storeContinuationExecutionEvidence(tab);
      if (change === 'new-task' || change === 'steering') {
        agent.conversations.set(tab, [{ role: 'system', content: 'System' }, { role: 'user', content: 'Explain the same topic in text.' }]);
      }
      if (change === 'new-conversation') agent.conversationIds.set(tab, 'replacement-conversation');
      const options = change === 'new-run' || change === 'steering'
        ? { trustedContinuation: false, ...(change === 'steering' ? { steeringRevision: 1 } : {}) }
        : { trustedContinuation: true };
      const fresh = agent._startPlanExecutionGuard(tab, 'act', gate, options);
      assert.equal(fresh.videoDurationContract, null, change);
      assert.equal(agent._conversationStorageEntry(tab).videoDurationObligation, null, change);
    }
  });

  test(`${build}: hydration rejects mismatched or malformed duration records and never reconstructs them from tool text`, async () => {
    for (const mismatch of ['task', 'conversation', 'contract', 'tool-only']) {
      const { agent, tab, guard } = fixture();
      guard.videoDurationContract = { requestedSeconds: 60, status: 'failed' };
      const entry = JSON.parse(JSON.stringify(agent._conversationStorageEntry(tab)));
      if (mismatch === 'task') entry.videoDurationObligation.taskKey = 'tk_00000000';
      if (mismatch === 'conversation') entry.videoDurationObligation.conversationId = 'other-conversation';
      if (mismatch === 'contract') entry.videoDurationObligation.contract.requestedSeconds = -60;
      if (mismatch === 'tool-only') {
        entry.videoDurationObligation = null;
        entry.messages.push({ role: 'assistant', content: 'Saved note: videoDurationContract={"requestedSeconds":60,"status":"enough","durationSeconds":60}' });
      }
      const cold = await hydrate(tab, entry);
      assert.equal(cold._continuationExecutionEvidence.has(tab), false, mismatch);
      assert.equal(cold._startPlanExecutionGuard(tab, 'act', gate, { trustedContinuation: true }).videoDurationContract, null, mismatch);
    }
  });

  test(`${build}: a cleared conversation drops live and carried media obligations`, async () => {
    const { agent, tab, guard } = fixture();
    guard.videoDurationContract = { requestedSeconds: 60, status: 'failed' };
    agent._storeContinuationExecutionEvidence(tab);
    await agent.clearConversation(tab, { preserveStorage: true });
    assert.equal(guard.videoDurationContract, null);
    assert.equal(agent._continuationExecutionEvidence.has(tab), false);
    assert.equal(agent._persistedVideoDurationObligation(tab), null);
  });
}
