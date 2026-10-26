import assert from 'node:assert/strict';
import test from 'node:test';

const PAGE = 'https://owned.example.test/video';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => value, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE, title: 'Video', status: 'complete' }) },
};
let nextTab = 18100, nextCall = 1;
const builds = await Promise.all(['chrome', 'firefox'].map(async build => ({
  build, Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
})));

function fixture(Agent, { strict = false, status = 'unverified' } = {}) {
  const agent = new Agent({ getActive: () => ({ model: 'test', supportsTools: true, supportsVision: false }), getVisionProvider: async () => null });
  const tab = nextTab++;
  agent.strictGuards = strict;
  agent.conversationIds.set(tab, `video-${tab}`);
  agent.conversationModes.set(tab, 'act');
  agent.conversations.set(tab, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Generate a sixty-second video.' }]);
  agent._ensureGateSetting = async () => {};
  agent._skipPermissionGate = true;
  agent._currentUrl = async () => PAGE;
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  const guard = agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: false });
  guard.videoDurationContract = { requestedSeconds: 60, status, ...(status === 'short' ? { durationSeconds: 5 } : {}) };
  guard.evidenceTaskKey = guard.taskKey;
  guard.successfulTaskToolCalls = guard.successfulConsequentialToolCalls = 1;
  agent.executeTool = async (_tab, name, args) => {
    assert.ok(['done', 'done_json'].includes(name));
    return name === 'done_json'
      ? { done: true, doneJson: true, summary: args.summary }
      : { done: true, summary: args.summary, outcome: args.outcome };
  };
  const batch = async (name = 'done', outcome = 'success') => {
    const calls = [{ id: `done_${nextCall++}`, function: { name, arguments: JSON.stringify({ outcome, summary: 'Here is the generated video.' }) } }];
    const messages = agent.conversations.get(tab);
    messages.push({ role: 'assistant', content: null, tool_calls: calls });
    return agent._executeToolBatch(tab, calls, messages, () => {}, { supportsVision: false }, null,
      new Set(['done', 'done_json']), 1, {}, null);
  };
  return { agent, tab, guard, batch };
}

test('a generated video with unavailable duration verification can finish after one note', async () => {
  for (const { build, Agent } of builds) {
    const { agent, tab, batch } = fixture(Agent);
    agent._resolveExactTableDone = async (_tab, args) => ({ done: true, summary: args.summary, outcome: args.outcome });
    agent.executeTool = (_tab, name, args) => agent._executeToolImpl(_tab, name, args, () => {});
    assert.equal((await batch()).action, 'continue', `${build}: first completion leaves its note`);
    const final = await batch();
    assert.equal(final.action, 'return', `${build}: verification timeout does not trap completion`);
    assert.equal(final.status, undefined, `${build}: missing evidence does not prove failure`);
    assert.match(final.value, /WebBrain could not verify everything:.*60-second duration could not be verified/);
    assert.equal(agent._guardRunState(tab).advised.has('done-video-duration'), true);
  }
});

for (const { build, Agent } of builds) {
  test(`${build}: duration quality guard applies strict checks and permits honest partial outcomes`, async () => {
    const { agent, tab, batch } = fixture(Agent, { strict: true });
    for (let i = 0; i < 3; i++) assert.equal((await batch()).action, 'continue');
    assert.equal(agent._guardRunState(tab).advised.has('done-video-duration'), false);
    for (const outcome of ['partial', 'failed']) {
      assert.equal(agent._videoDurationDoneBlock(tab, outcome), null);
      assert.equal((await batch('done', outcome)).action, 'return');
    }
  });

  test(`${build}: known short or unfinished videos finish as partial with their caveat`, async () => {
    for (const status of ['short', 'unjoined', 'failed', 'pending']) {
      const { agent, tab, batch } = fixture(Agent, { status });
      assert.equal((await batch()).action, 'continue');
      const final = await batch();
      assert.equal(final.action, 'return', status);
      assert.equal(final.endStatus, 'partial', status);
      assert.match(final.value, /WebBrain could not verify everything:/);
      assert.equal(agent._completionOutcomeDowngraded(tab), true);
    }
  });

  test(`${build}: batch skip, direct done and plain final share the same duration note`, async () => {
    const { agent, tab } = fixture(Agent);
    const firstBlock = agent._completionDoneBlock(tab, 'done', { outcome: 'success' });
    assert.equal(agent._completionInvariantRefuses(tab, firstBlock), true);
    assert.equal(agent._completionDoneBlock(tab, 'done', { outcome: 'success' }, null,
      { skip: new Set(['video_duration_incomplete']) }), null, 'accepted batch invariant is skipped');
    let reached = 0;
    agent._resolveExactTableDone = async () => { reached++; return { done: true, outcome: 'success' }; };
    const direct = await agent._executeToolImpl(tab, 'done', { outcome: 'success', summary: 'Video ready.' }, () => {});
    assert.equal(direct.done, true);
    assert.equal(reached, 1, 'the direct handler does not refuse the already-noted check');
    agent._guardRunState(tab).advised.add('plan-plain-final-protocol');
    assert.equal(agent._planOnlyTerminalDecision(tab, 'Here is the generated video.'), null);
    assert.match(agent._completionCaveatLine(tab), /60-second duration could not be verified/);
    assert.equal(agent._completionOutcomeDowngraded(tab), false);
  });

  test(`${build}: direct done gets one quality refusal and respects strict or lean modes`, async () => {
    for (const strict of [false, true]) {
      const { agent, tab } = fixture(Agent, { strict });
      agent._resolveExactTableDone = async () => ({ done: true, outcome: 'success' });
      assert.equal((await agent._executeToolImpl(tab, 'done', { outcome: 'success' }, () => {})).videoDurationIncomplete, true);
      const next = await agent._executeToolImpl(tab, 'done', { outcome: 'success' }, () => {});
      assert.equal(next.videoDurationIncomplete === true, strict);
      assert.equal(next.done === true, !strict);
    }
    const { agent, tab } = fixture(Agent, { strict: true });
    agent._leanRunActive = () => true;
    agent._resolveExactTableDone = async () => null;
    agent._leanChatReceiptBlock = async () => null;
    const lean = await agent._executeToolImpl(tab, 'done', { outcome: 'success', summary: 'Video ready.' }, () => {});
    assert.equal(lean.done, true, 'lean mode follows its existing quality-guard policy');
    assert.equal(agent._completionCaveatLine(tab), '');
  });

  test(`${build}: plain final gives one duration note while strict checks continue refusing`, () => {
    for (const strict of [false, true]) {
      const { agent, tab } = fixture(Agent, { strict });
      // Isolate duration from the separate plain-final protocol note.
      agent._guardRunState(tab).advised.add('plan-plain-final-protocol');
      assert.equal(agent._planOnlyTerminalDecision(tab, 'Here is the generated video.').retry, true);
      const second = agent._planOnlyTerminalDecision(tab, 'Here is the generated video.');
      assert.equal(second?.retry === true, strict);
      if (!strict) {
        assert.equal(second, null);
        assert.match(agent._completionCaveatLine(tab), /60-second duration could not be verified/);
        assert.equal(agent._completionOutcomeDowngraded(tab), false);
      }
    }
  });

  test(`${build}: structured done completion carries a duration caveat after one note`, async () => {
    const { batch } = fixture(Agent);
    assert.equal((await batch('done_json')).action, 'continue');
    const final = await batch('done_json');
    assert.equal(final.action, 'return');
    assert.match(final.value, /60-second duration could not be verified/);
  });
}
