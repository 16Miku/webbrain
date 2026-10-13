// Real Agent with mocked browser APIs (unit level, both builds): automatic
// navigations cannot starve the user idle gate, and an agent click's own
// same-document route update is attributed to that click.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PAGE_URL = 'https://app.example/inbox';
const urls = new Map();
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: urls.get(id) || PAGE_URL, title: 'App' }),
    sendMessage: async (id, message) => message.action === 'page_monitor_capture_model' ? { ready: false } : { ready: true },
  },
  webNavigation: { getAllFrames: async ({ tabId }) => [{ frameId: 0, parentFrameId: -1, documentId: 'main-document', url: urls.get(tabId) || PAGE_URL },
    { frameId: 1, parentFrameId: 0, documentId: 'ad-document', url: 'https://ads.example/slot' }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 7800;

function makeAgent(Agent, next = async () => assert.fail('No inference')) {
  const provider = { name: 'navigation idle test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false, chat: messages => next(messages),
    async *chatStream(messages) {
      const response = await next(messages);
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { type: 'done' };
    } };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  Object.assign(agent, {
    _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
    _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
    _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
    _currentUrl: async () => PAGE_URL, _getTabUrlTitle: async () => ({ tabUrl: PAGE_URL, tabTitle: 'App' }),
    _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {}, _ensureProgressSessionForCurrentTask: async () => {},
    _plannerMode: () => 'off',
    _runPlannerIntentGate: async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false }),
    _skipPermissionGate: true, _ensureGateSetting: async () => true, _adoptLiveSocialPublishWorkflow: async () => false,
    _isFormValidationCandidate: () => false, _preflightRichTextToolbarTarget: async () => ({ block: null }),
    _auditRichTextToolbarTarget: async () => {}, _shouldAutoScreenshot: () => false, _completionDoneBlock: () => null,
  });
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  return agent;
}

function bindMain(agent, tab) {
  const from = { tab: { id: tab }, frameId: 0, documentId: 'main-document', url: PAGE_URL };
  const state = agent.pageMonitorState(from, 'main-token');
  assert.equal(state.active, true);
  let seq = 0;
  return value => assert.equal(agent.observePageFeedback(from, { ...state, seq: ++seq, revision: seq, ...value }).accepted, true);
}
const navigate = (agent, tab, frameId, type, url, extra = {}) => {
  if (frameId === 0) urls.set(tab, url);
  agent.observePageNavigation({ tabId: tab, frameId, parentFrameId: frameId ? 0 : -1, url,
    documentId: frameId ? 'ad-' + Math.random() : 'main-document', transitionType: 'link', transitionQualifiers: [], ...extra }, type);
};
const raceTimeout = (promise, ms) => Promise.race([promise.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('starved'), ms))]);
const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  for (const variant of ['child_frame_commit', 'top_history_replace', 'top_fragment']) {
    test(`${build}: periodic automatic ${variant} navigations do not keep the idle gate closed`, async () => {
      const agent = makeAgent(Agent), tab = nextTab++;
      agent._pageFeedbackIdleMs = 80;
      await agent._claimRunEntry(tab, 'interactive');
      let count = 0;
      const tick = () => {
        count++;
        if (variant === 'child_frame_commit') navigate(agent, tab, 1, 'committed', 'https://ads.example/slot?r=' + count);
        else navigate(agent, tab, 0, variant === 'top_fragment' ? 'fragment' : 'history', PAGE_URL + (variant === 'top_fragment' ? '#t=' : '?t=') + count);
      };
      const ticker = setInterval(tick, 20);
      try {
        bindMain(agent, tab); tick();
        const started = Date.now();
        assert.equal(await raceTimeout(agent._waitForPageFeedbackIdle(tab), 1500), 'settled', 'Automatic navigations starved the idle gate');
        assert.ok(Date.now() - started < 500);
        const events = [...agent._pageFeedbackRuns.get(tab).events.values()].filter(event => event.kind === 'navigation');
        assert.ok(events.length >= 1 && events.every(event => event.source === 'unknown'), 'Navigations stay observable feedback');
      } finally { clearInterval(ticker); agent._releaseRunEntry(tab); }
    });
  }

  test(`${build}: navigation near user activity is attributed but cannot renew that activity forever`, async () => {
    const agent = makeAgent(Agent), tab = nextTab++;
    agent._pageFeedbackIdleMs = 80;
    await agent._claimRunEntry(tab, 'interactive');
    let count = 0;
    const ticker = setInterval(() => navigate(agent, tab, 1, 'committed', 'https://ads.example/slot?r=' + (++count)), 25);
    try {
      bindMain(agent, tab)({ kind: 'click', source: 'user', target: 'button#menu' });
      const userAt = agent._pageFeedbackRuns.get(tab).lastUserAt;
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal([...agent._pageFeedbackRuns.get(tab).events.values()].find(event => event.kind === 'navigation')?.source, 'user',
        'A navigation right after physical input is still treated as user navigation');
      assert.equal(await raceTimeout(agent._waitForPageFeedbackIdle(tab), 3500), 'settled', 'Proximity attribution renewed itself');
      assert.equal(agent._pageFeedbackRuns.get(tab).lastUserAt, userAt, 'Only physical input or browser UI sets the user time');
      assert.ok(Date.now() - userAt < 2700);
    } finally { clearInterval(ticker); agent._releaseRunEntry(tab); }
  });

  for (const [name, act] of [
    ['typed navigation', (agent, tab) => navigate(agent, tab, 0, 'history', PAGE_URL + '?typed', { transitionType: 'typed' })],
    ['top-level committed navigation', (agent, tab) => navigate(agent, tab, 0, 'committed', 'https://app.example/next')],
    ['top-level viewport change', (agent, tab) => bindMain(agent, tab)({ kind: 'resize', source: 'unknown', target: 'viewport',
      viewport: { width: 900, height: 700 } })],
    ['user scroll', (agent, tab) => bindMain(agent, tab)({ kind: 'scroll', source: 'user', target: 'html', viewport: { x: 0, y: 50 } })],
  ]) {
    test(`${build}: ${name} still settles through the idle gate`, async () => {
      const agent = makeAgent(Agent), tab = nextTab++;
      agent._pageFeedbackIdleMs = 90;
      await agent._claimRunEntry(tab, 'interactive');
      try {
        bindMain(agent, tab);
        act(agent, tab);
        const started = Date.now();
        await agent._waitForPageFeedbackIdle(tab);
        assert.ok(Date.now() - started >= 70, 'Genuine user navigation and geometry changes keep their settling wait');
      } finally { agent._releaseRunEntry(tab); }
    });
  }

  test(`${build}: an agent click's same-document route update is attributed to that click`, async () => {
    const agent = makeAgent(Agent), tab = nextTab++;
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const send = bindMain(agent, tab), run = agent._pageFeedbackRuns.get(tab);
      const messages = [{ role: 'system', content: '' }, { role: 'user', content: 'Open the archive' }];
      await agent._capturePageFeedbackModelState(tab, messages);
      const state = run.modelState, activityAt = run.lastActivityAt;
      send({ kind: 'activity', source: 'agent', operation: 'click' });
      navigate(agent, tab, 0, 'history', 'https://app.example/archive');
      navigate(agent, tab, 0, 'fragment', 'https://app.example/archive#top');
      assert.equal(agent._hasPendingPageFeedback(tab), false, 'No feedback, idle wait or UI note for the click effect');
      assert.equal(run.lastActivityAt, activityAt);
      assert.equal(run.url, 'https://app.example/archive#top');
      assert.equal(agent._pageFeedbackStateCurrent(tab, run, state), false, 'The URL change still invalidates bound model state');
      // Negative cases keep the strict route-change feedback.
      const visible = (label, arrange, type = 'history', frameId = 0, extra = {}) => {
        run.events.clear();
        send({ kind: 'activity', source: 'agent', operation: 'click' });
        arrange();
        navigate(agent, tab, frameId, type, 'https://app.example/' + label, extra);
        assert.equal(agent._hasPendingPageFeedback(tab), true, label);
      };
      visible('after-user', () => send({ kind: 'click', source: 'user', target: 'a#other' }));
      visible('other-frame', () => {}, 'history', 1);
      visible('expired', () => { run.sameDocumentNavigation.at -= 60000; });
      visible('back', () => {}, 'history', 0, { transitionQualifiers: ['forward_back'] });
      visible('typed', () => {}, 'history', 0, { transitionType: 'typed' });
      run.events.clear(); run.sameDocumentNavigation = null;
      navigate(agent, tab, 0, 'history', 'https://app.example/without-click');
      assert.equal(agent._hasPendingPageFeedback(tab), true, 'A route change after no agent click stays visible');
      visible('full-document', () => {}, 'committed');
    } finally { urls.delete(tab); agent._releaseRunEntry(tab); }
  });

  test(`${build}: an SPA button route change costs no idle wait, supersession or navigation note`, async () => {
    const tab = nextTab++, updates = [], dispatched = [];
    let agent, send, requests = 0;
    agent = makeAgent(Agent, async () => ++requests === 1 ? call('open', 'click', { text: 'Archive' })
      : call('finished', 'done', { summary: 'Archive opened', outcome: 'success' }));
    agent._pageFeedbackIdleMs = 1500; agent.maxSteps = 5;
    agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { send = bindMain(agent, tab); return { role: 'user', content }; };
    agent._executeToolWithLifecycle = async (_tab, name, args) => {
      if (name === 'get_accessibility_tree') return { success: true, pageContent: 'button "Archive" [ref_1]' };
      dispatched.push(name);
      if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
      // The monitor reports the agent click; the page script then pushes its route.
      send({ kind: 'activity', source: 'agent', operation: 'click' });
      navigate(agent, tab, 0, 'history', 'https://app.example/archive');
      return { success: true, dispatched: true };
    };
    try {
      const started = Date.now();
      const result = await agent.processMessage(tab, 'Open the archive', (type, data) => updates.push({ type, data }), 'act', [],
        { detachedRequestId: 'spa-' + tab, askStreamingEnabled: false });
      assert.equal(result, 'Archive opened');
      assert.deepEqual(dispatched, ['click', 'done']);
      assert.equal(requests, 2);
      assert.ok(Date.now() - started < 1200, 'The agent-caused route change did not wait for the user idle gate');
      assert.equal(updates.some(update => update.type === 'page_feedback' && update.data?.navigation), false);
    } finally { urls.delete(tab); }
  });

  for (const streaming of [false, true]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} run under continuous automatic navigation terminates without Stop`, async () => {
      const tab = nextTab++, dispatched = [];
      let agent, requests = 0, count = 0, ticker;
      agent = makeAgent(Agent, async () => {
        requests++;
        assert.ok(requests <= 6, 'Automatic churn stays inside the bounded budget');
        navigate(agent, tab, 1, 'committed', 'https://ads.example/slot?r=' + (++count)); // churn during inference
        return requests === 1 ? call('read', 'extract_data', { type: 'headings' })
          : call('finished', 'done', { summary: 'Read the inbox', outcome: 'success' });
      });
      agent._pageFeedbackIdleMs = 80; agent.maxSteps = 20;
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
        bindMain(agent, tab);
        ticker = setInterval(() => navigate(agent, tab, 1, 'committed', 'https://ads.example/slot?r=' + (++count)), 30);
        return { role: 'user', content };
      };
      agent._executeToolWithLifecycle = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: 'heading "Inbox" [ref_1]' };
        dispatched.push(name);
        return name === 'done' ? { done: true, success: true, summary: args.summary, outcome: args.outcome } : { success: true, headings: ['Inbox'] };
      };
      const stopper = setTimeout(() => agent.abort(tab), 4000);
      try {
        const options = { detachedRequestId: 'continuous-' + tab, askStreamingEnabled: false };
        const started = Date.now();
        const result = streaming ? await agent.processMessageStream(tab, 'Read the inbox headings', () => {}, 'act', options)
          : await agent.processMessage(tab, 'Read the inbox headings', () => {}, 'act', [], options);
        assert.doesNotMatch(result, /Stopped by user/, 'The idle gate starved the run until Stop');
        assert.match(result, /Read the inbox|page kept changing/);
        assert.ok(Date.now() - started < 3000);
        assert.equal(dispatched.filter(name => name === 'extract_data').length, 1, 'The read proceeds through automatic churn');
      } finally { clearTimeout(stopper); clearInterval(ticker); urls.delete(tab); }
    });
  }
}
