import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installModelStub } from './semantic-decision-stub.mjs';

// "continue", "keep going", "ok" and "thanks" kept the earlier task in force
// only in English, through word lists. A short Act turn after an earlier task
// is now read by a model in any language, once, when it arrives; the answer is
// stored on the turn, so the task anchor, ledger scope and approved plan read
// it without words. Anything the model cannot read with confidence is a new
// request, as an unrecognised word was before.
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: value => `extension://owned/${value}` } };
const earlier = 'Follow every stargazer on this page and record each one.';

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  function fixture(decide) {
    const provider = { model: 'owned-turn-fixture', chat: async () => ({ content: '{}' }) };
    const agent = new Agent({ getActive: () => provider });
    agent._persist = () => {};
    const tab = 31;
    agent.conversations.set(tab, [{ role: 'system', content: 'system' }, { role: 'user', content: earlier },
      { role: 'assistant', content: 'Paused after 12 of 40.' }]);
    const calls = installModelStub(agent, { decide, provider });
    const mark = async (text, mode = 'act', runOptions = {}, extra = {}) => {
      const turn = { role: 'user', content: text, webbrainUserAuthoredText: text };
      await agent._markUserTurnKind(tab, agent.conversations.get(tab), turn, text, mode, runOptions, extra);
      return turn;
    };
    return { agent, tab, calls, mark };
  }
  const reading = { 'devam et': ['continue', 'devam et'], '続けて': ['continue', '続けて'], 'keep going': ['continue', 'keep going'],
    'tamam': ['acknowledge', 'tamam'], 'merci !': ['acknowledge', 'merci'], 'ok 29': ['acknowledge', 'ok 29'] };
  const decide = (kind, { request }) => {
    if (kind !== 'user_turn_kind') return null;
    const [choice, evidence] = reading[request] || ['request', ''];
    return { choice, evidence };
  };

  test(`${build}: a short turn is read in any language and stored on the turn`, async t => {
    for (const [text, [kind]] of Object.entries(reading)) {
      await t.test(text, async () => {
        const f = fixture(decide);
        const turn = await f.mark(text);
        assert.equal(turn.webbrainTurnKind, kind);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].kind, 'user_turn_kind');
        assert.equal(f.calls[0].request, text, 'The turn reaches the model as written');
        f.agent.conversations.get(f.tab).push(turn);
        assert.equal(f.agent._progressTaskAnchorText(f.tab), earlier, 'The earlier task stays in force');
        assert.equal(f.agent._currentTaskIsProgressContinuation(f.tab), kind === 'continue');
      });
    }
    for (const text of ['şimdi sadece ilk 5 kişiyi takip et', 'ok star repo', 'stop']) {
      await t.test(text, async () => {
        const f = fixture(decide);
        const turn = await f.mark(text);
        assert.equal(turn.webbrainTurnKind, 'request', 'A separate request is explicitly marked');
        f.agent.conversations.get(f.tab).push(turn);
        assert.equal(f.agent._progressTaskAnchorText(f.tab), text, 'A request becomes the new task');
      });
    }
  });

  test(`${build}: keeping the earlier task needs a sure answer`, async () => {
    // An answer without a quotation from the turn, or outside the choices, is no answer.
    for (const answer of [{ choice: 'continue', evidence: '' }, { choice: 'continue', evidence: 'the user said go' },
      { choice: 'resume', evidence: 'devam et' }, null]) {
      const f = fixture(() => answer);
      const turn = await f.mark('devam et');
      assert.equal(turn.webbrainTurnKind, 'request', JSON.stringify(answer));
    }
    // The decision model answers first when it is enabled and sure.
    const f = fixture(() => { throw new Error('The active model is not asked'); });
    f.agent._jevSettings = async () => ({ decisionConfig: { provider: 'local', model: 'owned-decider', enabled: true, local: true,
      config: { category: 'local', inputCostPerMillionUsd: 0, outputCostPerMillionUsd: 0 } }, typesafeApiKey: '' });
    f.agent.evaluateSystemOne = async () => ({ model: 'owned-decider', answers: { user_turn_kind: { type: 'choice', choice: 'continue',
      confidence: 0.93, probabilities: { continue: 0.93, acknowledge: 0.04, request: 0.03 } } } });
    assert.equal((await f.mark('devam et')).webbrainTurnKind, 'continue');
  });

  test(`${build}: Continue is a continuation by construction; other turns are not read`, async () => {
    const f = fixture(() => { throw new Error('No model call is expected'); });
    assert.equal((await f.mark('Please continue from where you left off.', 'act', { trustedContinuation: true })).webbrainTurnKind, 'continue');
    assert.equal((await f.mark('devam et', 'ask')).webbrainTurnKind, 'request', 'Ask turns are requests');
    assert.equal((await f.mark('devam et', 'act', {}, { sourceBound: true })).webbrainTurnKind, 'request', 'Shortcuts are requests');
    assert.equal((await f.mark('x'.repeat(6001))).webbrainTurnKind, 'request', 'Long turns are requests');
    assert.equal((await f.mark('[Scheduled resume] check the queue')).webbrainTurnKind, 'request', 'Scheduled resumes keep their own rule');
    f.agent.conversations.set(f.tab, [{ role: 'system', content: 'system' }]);
    assert.equal((await f.mark('devam et')).webbrainTurnKind, 'request', 'A first turn has nothing to continue');
    assert.equal(f.calls.length, 0);
  });

  test(`${build}: the runtime reads the turn before the planner sees it`, async () => {
    const f = fixture(decide);
    let gated = null;
    f.agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content, webbrainUserAuthoredText: content });
    f.agent._maybeRunPlannerGate = async (_tab, _messages, enriched) => {
      gated = { kind: enriched.webbrainTurnKind, anchor: f.agent._progressTaskAnchorText(f.tab) };
      return { proceed: false, reason: 'cancelled', message: 'owned fixture stop' };
    };
    f.agent._manageContext = async () => {};
    f.agent._getTabUrlTitle = async () => ({ tabUrl: 'https://owned.example.test/', tabTitle: 'Owned' });
    f.agent._startTraceRun = async () => null;
    f.agent.conversationModes.set(f.tab, 'act');
    await f.agent.processMessage(f.tab, 'devam et', () => {}, 'act');
    assert.deepEqual(gated, { kind: 'continue', anchor: earlier });
  });
}
