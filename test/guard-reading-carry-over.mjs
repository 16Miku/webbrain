// The messaging guard reads a control's name before a click it cannot prove
// harmless, and the click waits four seconds for that reading. A slower model
// is not cut off there: its read goes on in the background for the run, and
// the retried click uses its answer instead of asking again and timing out the
// same way (QA A6, D6, W: Telegram, Gmail and WhatsApp clicks blocked with
// "could not read in time what this control does" while a local model needed
// about five seconds per reading).
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: path => `extension://owned/${path}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://web.telegram.org/k/' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  // A Telegram chat list's "More" button: the page cannot tell yet whether it
  // sends anything, so the guard asks what its name means.
  function fixture({ provider = { name: 'local-openai-proxy', chat: async () => ({}) } } = {}) {
    const agent = new Agent({ getActive: () => provider });
    const tab = 7, asked = [], answers = [];
    agent._activeProvider = () => provider;
    agent._semanticDecisions = async (_tab, kind, { items = [] } = {}, options = {}) => {
      const answer = deferred();
      asked.push({ kind, texts: items.map(item => item.text), options });
      answers.push(answer);
      return answer.promise.then(choice => items.map(() => (choice
        ? { choice, evidence: '', source: 'main_model' } : { choice: null, evidence: '', source: 'unavailable' })));
    };
    const names = { ref_more: 'More', ref_search: 'Search' };
    agent._messageRecipientContentProbe = async (_tab, params) => {
      const name = names[params.args?.ref_id];
      return params.__wbPageReadings?.message_control?.[name]
        ? { success: true, conclusive: true, messageSend: false, nonMessagingTarget: true, identityCandidates: [] }
        : { success: true, conclusive: false, messageSend: null, composerAvailable: false,
          reasonCode: 'message_control_unread', pageTextsNeeded: [{ kind: 'message_control', text: name }] };
    };
    return { agent, tab, asked, answers };
  }

  test(`${build}: a reading that misses the click's wait is used by the retried click`, async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const f = fixture();
      const first = f.agent._messageRecipientGuardProbe(f.tab, { tool: 'click_ax', args: { ref_id: 'ref_more' } });
      await flush();
      assert.equal(f.asked.length, 1);
      assert.equal(f.asked[0].options.mainTimeoutMs, 20_000, 'The model gets longer than the click waits');
      assert.equal(typeof f.asked[0].options.background?.current, 'function', 'The read is the run\'s background read');
      mock.timers.tick(4_000);
      await flush();
      const blocked = await first;
      assert.equal(blocked.reasonCode, 'message_control_unread', 'The click itself still waits only four seconds');
      // The model answers a second later; the retried click finds the reading.
      f.answers[0].resolve('conversation_tool');
      await flush();
      const retried = await f.agent._messageRecipientGuardProbe(f.tab, { tool: 'click_ax', args: { ref_id: 'ref_more' } });
      assert.equal(retried.conclusive, true, JSON.stringify(retried));
      assert.equal(retried.messageSend, false);
      assert.equal(f.asked.length, 1, 'The name is not asked about twice');
    } finally {
      mock.timers.reset();
    }
  });

  test(`${build}: a click retried while the reading is still going joins it`, async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const f = fixture();
      const first = f.agent._messageRecipientGuardProbe(f.tab, { tool: 'click_ax', args: { ref_id: 'ref_more' } });
      await flush();
      mock.timers.tick(4_000);
      await flush();
      assert.equal((await first).reasonCode, 'message_control_unread');
      const retry = f.agent._messageRecipientGuardProbe(f.tab, { tool: 'click_ax', args: { ref_id: 'ref_more' } });
      await flush();
      assert.equal(f.asked.length, 1, 'The retry waits for the read in flight instead of asking again');
      f.answers[0].resolve('conversation_tool');
      await flush();
      const retried = await retry;
      assert.equal(retried.conclusive, true, JSON.stringify(retried));
      assert.equal(f.asked.length, 1);
    } finally {
      mock.timers.reset();
    }
  });

  test(`${build}: a reading that arrives in time still lets the first click through`, async () => {
    const f = fixture();
    const first = f.agent._messageRecipientGuardProbe(f.tab, { tool: 'click_ax', args: { ref_id: 'ref_more' } });
    await flush();
    f.answers[0].resolve('conversation_tool');
    const result = await first;
    assert.equal(result.conclusive, true, JSON.stringify(result));
    assert.equal(f.asked.length, 1);
  });

  test(`${build}: Stop cancels a guard reading that outlasted its click`, async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const f = fixture();
      const controller = new AbortController();
      f.agent._runAbortSignal = () => controller.signal;
      f.agent._checkAbort = () => controller.signal.aborted;
      const first = f.agent._messageRecipientGuardProbe(f.tab, { tool: 'click_ax', args: { ref_id: 'ref_more' } });
      await flush();
      mock.timers.tick(4_000);
      await flush();
      await first;
      const signal = f.asked[0].options.background.signal;
      assert.equal(signal.aborted, false);
      controller.abort();
      assert.equal(signal.aborted, true, 'The background read stops with the run');
      // A late answer of a stopped run is not kept.
      f.answers[0].resolve('conversation_tool');
      await flush();
      assert.equal(f.agent._pageTextReading('message_control', 'More'), null);
    } finally {
      mock.timers.reset();
    }
  });

  test(`${build}: the end of the run cancels a guard reading still going`, async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const f = fixture();
      const first = f.agent._messageRecipientGuardProbe(f.tab, { tool: 'click_ax', args: { ref_id: 'ref_more' } });
      await flush();
      mock.timers.tick(4_000);
      await flush();
      await first;
      f.agent._cancelSocialPublicationBackground(f.tab);
      assert.equal(f.asked[0].options.background.signal.aborted, true);
      await flush();
      assert.equal(f.agent._guardPageTextReads.size, 0, 'Nothing is left to join');
    } finally {
      mock.timers.reset();
    }
  });

  test(`${build}: a check about another control cancels the earlier control's reading`, async () => {
    // QA D6: after a blocked click the model tried other parts of the row.
    // Only the latest check's reading is carried over, so earlier ones do
    // not keep the model busy.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const f = fixture();
      const first = f.agent._messageRecipientGuardProbe(f.tab, { tool: 'click_ax', args: { ref_id: 'ref_more' } });
      await flush();
      mock.timers.tick(4_000);
      await flush();
      await first;
      const other = f.agent._messageRecipientGuardProbe(f.tab, { tool: 'click_ax', args: { ref_id: 'ref_search' } });
      await flush();
      assert.equal(f.asked[0].options.background.signal.aborted, true, 'The reading of "More" was cancelled');
      assert.deepEqual(f.asked.map(item => item.texts), [['More'], ['Search']]);
      assert.equal(f.asked[1].options.background.signal.aborted, false);
      f.answers[1].resolve('conversation_tool');
      assert.equal((await other).conclusive, true);
      f.answers[0].resolve('conversation_tool');
      await flush();
      assert.equal(f.agent._pageTextReading('message_control', 'More'), null, 'A cancelled reading is not kept');
    } finally {
      mock.timers.reset();
    }
  });

  test(`${build}: an in-browser model is still asked in the foreground and cut off at four seconds`, async () => {
    const f = fixture({ provider: { name: 'webgpu', chat: async () => ({}) } });
    const first = f.agent._messageRecipientGuardProbe(f.tab, { tool: 'click_ax', args: { ref_id: 'ref_more' } });
    await flush();
    assert.equal(f.asked.length, 1);
    assert.equal(f.asked[0].options.mainTimeoutMs, 4_000);
    assert.equal(f.asked[0].options.background, undefined);
    f.answers[0].resolve(null);
    assert.equal((await first).reasonCode, 'message_control_unread');
  });
}
