import assert from 'node:assert/strict';
import { test } from 'node:test';

// The background side of a held observation: the model's thinking time and
// the user's answers to WebBrain's own cards are reported with every check of
// the pre-inference certificate (see page-monitor-held-observation.mjs for
// the content side).
const PAGE_URL = 'https://held-time.test/login';
const sent = [];
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: PAGE_URL, title: 'Sign in' }),
    async sendMessage(_tab, message) {
      sent.push(message);
      const params = message.params || {};
      return { ready: true, modelBindingValid: true, runToken: params.runToken, documentToken: 'doc-token',
        snapshotToken: params.snapshotToken || params.expectedModelSnapshot };
    },
  },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'main-document', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};

let nextTab = 9900;
for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  const withClock = async work => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try { await work(ms => { now += ms; }); } finally { Date.now = realNow; }
  };
  const watched = () => {
    const tab = nextTab++;
    const agent = new Agent({ getActive: () => null, getProvider: () => null, getVisionProvider: async () => null });
    const state = { token: 'run-token', url: PAGE_URL, frames: new Map(), steeringRevision: 0,
      actionBinding: { snapshotToken: 'snapshot-1', runToken: 'run-token', documentToken: 'doc-token', capturedAt: Date.now() } };
    const run = { token: 'run-token', url: PAGE_URL, events: new Map(), frames: new Map(), documents: new Map(), modelState: state };
    agent._pageFeedbackRuns = new Map([[tab, run]]);
    return { agent, tab, state, run };
  };

  test(`${build}: the model's thinking and the user's card decisions are reported as held time`, () => withClock(async advance => {
    const { agent, tab, state } = watched();
    assert.equal(agent._pageFeedbackModelHeldMs(state), 0);
    advance(46000);
    agent._notePageFeedbackModelResponse(tab);
    advance(3000); // WebBrain's own checks keep counting
    agent._notePageFeedbackModelResponse(tab);
    assert.equal(agent._pageFeedbackModelHeldMs(state), 46000, 'the response is noted once');
    // A permission card the user answers after 112 seconds.
    let answer = null;
    agent._pendingClarifications.set(tab, new Map([['perm-1', { resolve: value => { answer = value; }, ts: Date.now() }]]));
    advance(112000);
    assert.equal(agent.submitClarifyResponse(tab, 'perm-1', 'once'), true);
    assert.deepEqual(answer, { answer: 'once', source: 'user' });
    assert.equal(agent._pageFeedbackModelHeldMs(state), 158000);
    // A card that was already settled (timed out) adds nothing.
    agent._pendingClarifications.set(tab, new Map([['perm-2', { resolve() {}, ts: Date.now() - 5000, settled: true }]]));
    agent.submitClarifyResponse(tab, 'perm-2', 'once');
    assert.equal(agent._pageFeedbackModelHeldMs(state), 158000);
  }));

  test(`${build}: every check of the pre-inference certificate carries the held time`, () => withClock(async advance => {
    const { agent, tab, state } = watched();
    advance(46000);
    agent._notePageFeedbackModelResponse(tab);
    agent._notePageFeedbackUserDecision(tab, 112000);
    sent.length = 0;
    assert.equal(await agent._validatePageFeedbackAction(tab, 'click_ax', { ref_id: 'ref_submit' }, state), true);
    const validation = sent.find(message => message.action === 'page_monitor_validate_model');
    assert.equal(validation?.params.modelHeldMs, 158000);
    assert.equal(validation.params.snapshotToken, 'snapshot-1');
    // A fresh observation that nothing held reports none.
    const fresh = watched();
    sent.length = 0;
    await fresh.agent._validatePageFeedbackAction(fresh.tab, 'click_ax', { ref_id: 'ref_submit' }, fresh.state);
    assert.equal('modelHeldMs' in sent.find(message => message.action === 'page_monitor_validate_model').params, false);
  }));
}
