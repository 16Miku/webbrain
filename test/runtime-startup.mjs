import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(Agent) {
  const provider = { name: 'startup test', model: 'test', supportsTools: false, supportsVision: false };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider });
  agent._hydrate = async () => {};
  agent._persist = () => {};
  agent._beginReadCompleteness = async () => null;
  agent._restoreCapturePolicyAfterRun = async () => {};
  agent._maybeEmitAskModeHandoff = async () => {};
  return agent;
}

for (const browser of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);

  test(`${browser}: cancellation before claiming restores unsent attachments without hydration`, async () => {
    const agent = setup(Agent), updates = [];
    agent._hydrate = async () => assert.fail('Cancelled startup must not hydrate');
    agent._processMessageInner = async () => assert.fail('Cancelled startup must not accept attachments');
    const result = await agent.processMessage(445, 'Do not start', (type, data) => updates.push({ type, data }), 'ask', [
      { kind: 'image', name: 'unsent.png', dataUrl: 'data:image/png;base64,AA==' },
    ], { isDetachedStartCancelled: () => true });
    assert.equal(result, '[Stopped by user]');
    assert.equal(updates.filter(event => event.type === 'attachment_rejected').length, 1);
    assert.equal(agent.isRunning(445), false);
    assert.equal(agent._runAbortStates.has(445), false);
  });

  test(`${browser}: cancellation during hydration restores attachments before processing begins`, async () => {
    const agent = setup(Agent), entered = deferred(), release = deferred(), updates = [];
    agent._hydrate = async () => {
      entered.resolve(); await release.promise;
      const error = new Error('Stopped during hydration'); error.name = 'AbortError'; throw error;
    };
    agent._processMessageInner = async () => assert.fail('Cancelled hydration must not accept attachments');
    const run = agent.processMessage(446, 'Do not start', (type, data) => updates.push({ type, data }), 'ask', [
      { kind: 'image', name: 'unsent.png', dataUrl: 'data:image/png;base64,AA==' },
    ]);
    await entered.promise;
    agent.abort(446); release.resolve();
    assert.equal(await run, '[Stopped by user]');
    assert.equal(updates.filter(event => event.type === 'attachment_rejected').length, 1);
    assert.equal(agent.isRunning(446), false);
    assert.equal(agent._runAbortStates.has(446), false);
  });

  test(`${browser}: cancellation after processing starts does not restore accepted attachments`, async () => {
    const agent = setup(Agent), updates = [];
    agent._processMessageInner = async () => {
      const error = new Error('Stopped during processing'); error.name = 'AbortError'; throw error;
    };
    const result = await agent.processMessage(447, 'Attachment turn', (type, data) => updates.push({ type, data }), 'ask', [
      { kind: 'image', name: 'accepted.png', dataUrl: 'data:image/png;base64,AA==' },
    ]);
    assert.equal(result, '[Stopped by user]');
    assert.equal(updates.filter(event => event.type === 'attachment_rejected').length, 0);
    assert.equal(agent.isRunning(447), false);
  });

  for (const phase of ['authorization', 'tab lookup', 'frame enumeration', 'frame monitor']) {
    for (const streaming of [false, true]) {
      test(`${browser}: ${streaming ? 'stream' : 'chat'} Stop releases unresponsive ${phase} startup`, async () => {
        const agent = setup(Agent), entered = deferred(), release = deferred(), updates = [];
        const previousGet = api.tabs.get, previousSend = api.tabs.sendMessage, previousNavigation = api.webNavigation;
        const block = async value => { entered.resolve(); await release.promise; return value; };
        if (phase === 'authorization') agent.setRunStartGuard(() => block());
        if (phase === 'tab lookup') api.tabs.get = id => block({ id, url: 'https://example.com/' });
        if (phase === 'frame enumeration') api.webNavigation = { getAllFrames: () => block([{ frameId: 0 }]) };
        if (phase === 'frame monitor') api.tabs.sendMessage = (_tab, message) => message.active ? block({ ready: true }) : Promise.resolve({});
        agent._processMessageInner = agent._processMessageStreamInner = async () => assert.fail('Cancelled startup must not dispatch model work');
        const update = (type, data) => updates.push({ type, data });
        const options = { detachedRequestId: 'startup-1' };
        const run = streaming
          ? agent.processMessageStream(440, 'Original task', update, 'ask', options)
          : agent.processMessage(440, 'Original task', update, 'ask', [], options);
        let outcome = null;
        const observed = run.then(value => { outcome = { value }; }, error => { outcome = { error }; });
        try {
          await entered.promise;
          agent.abort(440);
          await tick();
          assert.equal(agent.isRunning(440), false, 'Stop must not wait for an unresponsive browser callback');
          assert.equal(outcome?.value, '[Stopped by user]');
          assert.equal(outcome?.error, undefined);
          assert.equal(agent._runAbortStates.has(440), false);
          assert.equal(agent._pageFeedbackRuns?.has(440) || false, false);
          assert.equal(agent._steeringRuns.has(440), false);
          assert.ok(updates.some(event => event.type === 'run_status' && event.data.status === 'cancelled'));
        } finally {
          release.resolve(); await observed;
          api.tabs.get = previousGet; api.tabs.sendMessage = previousSend; api.webNavigation = previousNavigation;
        }
      });
    }
  }

  for (const streaming of [false, true]) {
    test(`${browser}: ${streaming ? 'stream' : 'chat'} accepts and retains steering during monitor startup`, async () => {
      const agent = setup(Agent), entered = deferred(), release = deferred(), updates = [];
      const previousSend = api.tabs.sendMessage;
      api.tabs.sendMessage = async (_tab, message) => {
        if (message.active) { entered.resolve(); await release.promise; }
        return {};
      };
      let applied;
      const inner = async (tabId, task, onUpdate) => {
        const messages = agent.getConversation(tabId, 'ask');
        messages.push({ role: 'user', content: task });
        agent._applyPendingSteering(tabId, messages, onUpdate);
        applied = agent._activeTaskBinding(messages);
        return 'Corrected response';
      };
      agent._processMessageInner = agent._processMessageStreamInner = inner;
      const update = (type, data) => updates.push({ type, data });
      const options = { detachedRequestId: 'startup-2' };
      const run = streaming
        ? agent.processMessageStream(441, 'Original task', update, 'ask', options)
        : agent.processMessage(441, 'Original task', update, 'ask', [], options);
      try {
        await entered.promise;
        const accepted = agent.steerMessage(441, 'Use the revised target', { requestId: 'startup-2', messageId: 'correction' });
        assert.equal(accepted.accepted, true);
        release.resolve();
        assert.equal(await run, 'Corrected response');
        assert.equal(applied.requestText, 'Original task');
        assert.deepEqual(applied.updates.map(item => item.text), ['Use the revised target']);
        assert.equal(updates.filter(item => item.type === 'steering_applied').length, 1);
      } finally { release.resolve(); await run; api.tabs.sendMessage = previousSend; }
    });

    test(`${browser}: duplicate ${streaming ? 'stream' : 'chat'} startup cannot release the original owner`, async () => {
      const agent = setup(Agent), entered = deferred(), release = deferred();
      agent.setRunStartGuard(async () => { entered.resolve(); await release.promise; });
      agent._processMessageInner = agent._processMessageStreamInner = async () => 'Original response';
      const start = () => streaming
        ? agent.processMessageStream(444, 'Original task', () => {}, 'ask', { standaloneChat: true })
        : agent.processMessage(444, 'Original task', () => {}, 'ask', [], { standaloneChat: true });
      const original = start();
      try {
        await entered.promise;
        const owner = agent._runAbortStates.get(444);
        await assert.rejects(start(), /already in progress/);
        assert.equal(agent.isRunning(444), true);
        assert.equal(agent._runAbortStates.get(444), owner);
        release.resolve();
        assert.equal(await original, 'Original response');
      } finally { release.resolve(); await original; }
    });
  }

  test(`${browser}: late cancelled frame enumeration cannot attach to the replacement run`, async () => {
    const agent = setup(Agent), entered = deferred(), release = deferred(), deliveries = [];
    const previousNavigation = api.webNavigation, previousSend = api.tabs.sendMessage;
    let enumerations = 0;
    api.webNavigation = { getAllFrames: async () => {
      if (++enumerations === 1) { entered.resolve(); await release.promise; return [{ frameId: 7, documentId: 'old-child' }]; }
      return [{ frameId: 0, documentId: 'replacement-document' }];
    } };
    api.tabs.sendMessage = async (_tab, message, options) => { deliveries.push({ message, frameId: options?.frameId }); return {}; };
    const first = agent._claimRunEntry(442, 'interactive');
    let firstOutcome;
    const observed = first.then(() => { firstOutcome = 'success'; }, error => { firstOutcome = error.name; });
    try {
      await entered.promise;
      agent.abort(442); await tick();
      assert.equal(firstOutcome, 'AbortError');
      await agent._claimRunEntry(442, 'interactive');
      const replacement = agent._pageFeedbackRuns.get(442);
      const deliveryCount = deliveries.length;
      release.resolve(); await observed; await tick();
      assert.equal(agent._pageFeedbackRuns.get(442), replacement);
      assert.equal(replacement.documents.get(0).id, 'replacement-document');
      assert.equal(deliveries.length, deliveryCount, 'The retired startup must never send a late activation');
    } finally {
      release.resolve(); await observed; agent._releaseRunEntry(442);
      api.webNavigation = previousNavigation; api.tabs.sendMessage = previousSend;
    }
  });

  test(`${browser}: an unresponsive monitor has a bounded startup deadline`, async context => {
    const agent = setup(Agent), entered = deferred(), release = deferred();
    const previousSend = api.tabs.sendMessage;
    api.tabs.sendMessage = async (_tab, message) => {
      if (message.active) { entered.resolve(); await release.promise; }
      return {};
    };
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let outcome;
    const observed = agent._claimRunEntry(443, 'interactive').then(() => { outcome = 'success'; }, error => { outcome = error; });
    try {
      await entered.promise;
      context.mock.timers.tick(15_000); await tick();
      assert.equal(outcome?.code, 'content_action_timeout');
      assert.equal(agent.isRunning(443), false);
    } finally {
      release.resolve(); await observed; agent._releaseRunEntry(443); api.tabs.sendMessage = previousSend;
      context.mock.timers.reset();
    }
  });
}
