// Real Agent loops (chat + stream) with mocked browser APIs and a provider that
// honors abort signals, both builds. An accepted correction interrupts the
// in-flight main inference (no browser side effects) instead of waiting for
// it, Stop keeps precedence, cost limits keep their own terminal handling, and
// unconsumed corrections from a stopped run are marked for manual send.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PAGE_URL = 'https://example.com/search';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Search' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 8500;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const call = (id, name, args = {}) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });

// A slow inference that ends early only when its request signal aborts.
const slow = (signal, ms, value) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(value), ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    const error = new Error('The operation was aborted.'); error.name = 'AbortError'; reject(error);
  }, { once: true });
});

function makeAgent(Agent, next) {
  const provider = {
    name: 'steering latency test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false,
    chat: (messages, options) => next(messages, options),
    async *chatStream(messages, options) {
      const response = await next(messages, options);
      if (response.content) yield { type: 'text', content: response.content };
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((item, index) => ({ ...item, index })) };
      yield { type: 'done' };
    },
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  Object.assign(agent, {
    _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
    _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
    _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
    _currentUrl: async () => PAGE_URL, _getTabUrlTitle: async () => ({ tabUrl: PAGE_URL, tabTitle: 'Search' }),
    _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {}, _ensureProgressSessionForCurrentTask: async () => {},
    _plannerMode: () => 'off',
    _runPlannerIntentGate: async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false }),
    _skipPermissionGate: true, _ensureGateSetting: async () => true, _shouldAutoScreenshot: () => false,
    _pageFeedbackIdleMs: 0, _completionDoneBlock: () => null,
  });
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  return agent;
}

const run = (agent, tab, streaming, text, update, options) => streaming
  ? agent.processMessageStream(tab, text, update, 'act', options)
  : agent.processMessage(tab, text, update, 'act', [], options);
const authored = messages => {
  const message = messages.filter(message => message.role === 'user' && !message.webbrainAppOwned).at(-1);
  return message?.webbrainUserAuthoredText ?? message?.content;
};

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  for (const streaming of [false, true]) {
    const mode = streaming ? 'stream' : 'chat';

    test(`${build}: ${mode} an accepted correction interrupts the in-flight inference`, async () => {
      const tab = nextTab++, updates = [], dispatched = [], entered = deferred();
      let agent, requests = 0, aborted = false;
      agent = makeAgent(Agent, async (messages, options) => {
        requests++;
        if (requests === 1) {
          entered.resolve();
          try { return await slow(options?.signal, 20000, call('stale-read', 'get_accessibility_tree')); }
          catch (error) { aborted = true; throw error; }
        }
        if (requests === 2) {
          assert.equal(authored(messages), 'Open the docs page instead');
          return call('read', 'get_accessibility_tree');
        }
        return call('done', 'done', { summary: 'Opened the docs page.', outcome: 'success' });
      });
      agent._executeToolWithLifecycle = async (_tab, name, args) => {
        if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
        dispatched.push(name); return { success: true, pageContent: 'main [ref_1]' };
      };
      const update = (type, data) => updates.push({ type, data, at: Date.now() });
      const pending = run(agent, tab, streaming, 'Open the pricing page', update, { detachedRequestId: 'latency-' + tab });
      await entered.promise;
      const steeredAt = Date.now();
      assert.equal(agent.steerMessage(tab, 'Open the docs page instead', { requestId: 'latency-' + tab, messageId: 'c1' }).accepted, true);
      assert.equal(await pending, 'Opened the docs page.');
      assert.equal(aborted, true, 'The superseded request was aborted');
      const applied = updates.find(entry => entry.type === 'steering_applied');
      assert.ok(applied && applied.at - steeredAt < 2000, `correction applied after ${applied?.at - steeredAt} ms`);
      assert.deepEqual(dispatched, ['get_accessibility_tree'], 'The stale response is never dispatched');
      assert.equal(requests, 3);
      assert.ok(updates.some(entry => entry.type === 'text' && entry.data?.replace && !entry.data.content));
      assert.equal(agent._steeringRuns.size, 0);
    });

    test(`${build}: ${mode} a correction is applied before a pending page refresh read`, async () => {
      const tab = nextTab++, updates = [], events = [];
      let agent, send, requests = 0;
      agent = makeAgent(Agent, async () => {
        requests++;
        if (requests === 1) {
          // The user scrolls and sends a correction while the answer arrives.
          send({ kind: 'scroll', source: 'user', target: 'html', viewport: { x: 0, y: 300 } });
          agent.steerMessage(tab, 'Use the second result instead', { requestId: 'order-' + tab, messageId: 'c1' });
          return call('stale-click', 'click_ax', { ref_id: 'ref_1' });
        }
        if (requests === 2) return call('read', 'get_accessibility_tree');
        return call('done', 'done', { summary: 'Opened the second result.', outcome: 'success' });
      });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
        const from = { tab: { id: tab }, frameId: 0, documentId: 'document-1', url: PAGE_URL };
        const state = agent.pageMonitorState(from, 'content-1');
        let seq = 0;
        send = value => agent.observePageFeedback(from, { ...state, seq: ++seq, revision: seq, ...value });
        return { role: 'user', content };
      };
      agent._executeToolWithLifecycle = async (_tab, name, args, _update, context) => {
        if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
        assert.notEqual(name, 'click_ax', 'The superseded click is never dispatched');
        if (context?.pageFeedbackRead) events.push('refresh-read');
        return { success: true, pageContent: 'link "Result 2" [ref_2]' };
      };
      const update = (type, data) => { updates.push({ type, data }); if (type === 'steering_applied') events.push('steering_applied'); };
      assert.equal(await run(agent, tab, streaming, 'Open the first search result', update, { detachedRequestId: 'order-' + tab }),
        'Opened the second result.');
      assert.equal(events[0], 'steering_applied', `events: ${events.join(', ')}`);
      assert.ok(events.includes('refresh-read'), 'The user scroll is still observed before the next decision');
    });

    test(`${build}: ${mode} Stop keeps precedence and marks the unconsumed correction`, async () => {
      const tab = nextTab++, updates = [], entered = deferred();
      let agent, requests = 0;
      agent = makeAgent(Agent, async (_messages, options) => {
        requests++;
        entered.resolve();
        return slow(options?.signal, 20000, { content: 'never' });
      });
      agent._executeToolWithLifecycle = async () => assert.fail('No tool may run after Stop');
      const pending = run(agent, tab, streaming, 'Post "launch day" on X', (type, data) => updates.push({ type, data }),
        { detachedRequestId: 'stop-' + tab });
      await entered.promise;
      assert.equal(agent.steerMessage(tab, 'Also post it on Mastodon', { requestId: 'stop-' + tab, messageId: 'c1' }).accepted, true);
      agent.abort(tab);
      assert.match(await pending, /Stopped by user/);
      assert.equal(requests, 1, 'Stop is not turned into a steering continuation');
      assert.equal(updates.some(entry => entry.type === 'steering_applied'), false);
      const queued = updates.filter(entry => entry.type === 'steering_queued');
      assert.equal(queued.length, 1);
      assert.deepEqual(queued[0].data.messages.map(item => item.text), ['Also post it on Mastodon']);
      assert.equal(queued[0].data.stopped, true, 'The panel must keep a stopped run\'s correction for manual send');
    });

    test(`${build}: ${mode} a cost limit still ends the run when a correction is pending`, async () => {
      const tab = nextTab++, updates = [];
      let agent, requests = 0;
      agent = makeAgent(Agent, async () => {
        requests++;
        agent.steerMessage(tab, 'Search the archive too', { requestId: 'cost-' + tab, messageId: 'c1' });
        const error = new Error('Cloud cost allowance reached: this session is $1.00 against the $1.00 limit.');
        error.code = 'WB_COST_ALLOWANCE';
        throw error;
      });
      const result = await run(agent, tab, streaming, 'Search the docs', (type, data) => updates.push({ type, data }),
        { detachedRequestId: 'cost-' + tab });
      assert.match(result, /cost allowance reached/i);
      assert.equal(requests, 1, 'A cost limit is never retried as a steering supersession');
      const queued = updates.filter(entry => entry.type === 'steering_queued');
      assert.equal(queued.length, 1, 'The unconsumed correction is returned to the queue');
      assert.equal(queued[0].data.stopped, undefined, 'Only Stop holds a correction; an ordinary end keeps it for the next turn');
    });
  }

}
