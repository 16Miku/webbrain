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

  test(`${build}: a page script's own Back after an agent click is that click's effect, never the browser's Back`, async () => {
    const agent = makeAgent(Agent), tab = nextTab++, previous = api.tabs.sendMessage, asked = [];
    let reply = null;
    api.tabs.sendMessage = async (id, message, options) => {
      if (message.action !== 'page_monitor_traversal') return previous(id, message, options);
      asked.push({ params: message.params, frameId: options?.frameId });
      return reply(message);
    };
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const send = bindMain(agent, tab), run = agent._pageFeedbackRuns.get(tab);
      const monitor = (pageInitiated, extra = {}) => message => ({ ready: true, runToken: message.params.runToken,
        documentToken: 'main-token', pageInitiated, ...extra });
      const navigation = () => [...run.events.values()].find(event => event.kind === 'navigation');
      // Each case starts from a clean run: no queued feedback, route or click marker.
      // A traversal reports its destination entry's original transition type.
      const back = async (label, { answer = monitor(true), click = true, arrange = () => {}, type = 'history',
        qualifiers = ['forward_back'], during = null } = {}) => {
        run.events.clear(); run.agentRoute = null; run.sameDocumentNavigation = null;
        if (click) send({ kind: 'activity', source: 'agent', operation: 'click' });
        arrange();
        reply = during ? async message => { await during(); return answer(message); } : answer;
        const userAt = run.lastUserAt, activityAt = run.lastActivityAt, at = Date.now();
        navigate(agent, tab, 0, type, 'https://app.example/' + label, { transitionType: 'typed', transitionQualifiers: qualifiers });
        assert.equal(navigation()?.source, 'user', `${label}: browser-UI attribution stands until the monitor answers`);
        assert.ok(run.lastUserAt >= at, `${label}: the traversal counts as user input meanwhile`);
        await agent._pageFeedbackTraversalSettled(run);
        return { userAt, activityAt, at };
      };
      let before = await back('posted');
      assert.deepEqual(asked.at(-1), { params: { runToken: run.token, url: 'https://app.example/posted' }, frameId: 0 });
      assert.equal(agent._hasPendingPageFeedback(tab), false, 'No feedback, idle wait or UI note for the click effect');
      assert.equal(run.lastUserAt, before.userAt, 'The withdrawn attribution does not renew the user idle gate');
      assert.equal(run.lastActivityAt, before.activityAt);
      assert.equal(run.agentRoute?.url, 'https://app.example/posted', 'The route is recorded as the agent action result');
      assert.equal(agent._pageFeedbackAgentRouteCurrent(tab, run, 0), false, 'Only the action in flight may claim it');
      assert.ok(run.traversedAt >= before.at, 'A route reached by Back/Forward is marked, so it is never proof');
      // Hash routes, and a destination first opened from the address bar, are read the same way.
      for (const [label, options] of [['hash-route', { type: 'fragment' }],
        ['address-bar-entry', { qualifiers: ['forward_back', 'from_address_bar'] }]]) {
        await back(label, options);
        assert.equal(navigation(), undefined, label);
        assert.equal(run.agentRoute?.url, 'https://app.example/' + label, label);
      }
      // A state restore while the reading is pending is the same click's effect, not user activity.
      await back('restored', { during: () => navigate(agent, tab, 0, 'history', 'https://app.example/restored?state=1') });
      assert.equal(navigation(), undefined);
      assert.equal(run.agentRoute?.url, 'https://app.example/restored?state=1', 'The later agent route stays current');
      // Nor is an embed the re-render inserts in a child frame meanwhile.
      await back('with-embed', { during: () => navigate(agent, tab, 1, 'committed', 'https://ads.example/slot?embed=1') });
      assert.equal([...run.events.values()].find(event => event.kind === 'navigation' && event.frameId === 0), undefined);
      assert.equal([...run.events.values()].find(event => event.kind === 'navigation' && event.frameId === 1)?.source, 'unknown',
        'The child frame commit stays ordinary page churn');
      // The browser's Back button, an absent or stale monitor and a timeout keep user attribution.
      for (const [label, answer] of [['browser-back', monitor(false)], ['no-monitor', () => undefined],
        ['other-document', monitor(true, { documentToken: 'replaced-token' })], ['other-run', monitor(true, { runToken: 'old-run' })],
        ['silent', () => new Promise(() => {})]]) {
        await back(label, { answer });
        assert.equal(navigation()?.source, 'user', label);
        assert.equal(run.agentRoute, null, label);
      }
      // A state restore the page makes after the browser's Back is not the click's either.
      await back('browser-back-restore', { answer: monitor(false),
        during: () => navigate(agent, tab, 0, 'history', 'https://app.example/browser-back-restore?state=1') });
      assert.equal(navigation()?.source, 'user');
      assert.equal(navigation()?.after, 'https://app.example/browser-back-restore?state=1', 'The update ends where the page left it');
      assert.equal(run.agentRoute, null, 'Nothing credited to the click while the reading was pending survives');
      // Physical input before the monitor answers keeps the user attribution.
      await back('touched', { during: () => send({ kind: 'click', source: 'user', target: 'a#other' }) });
      assert.equal(navigation()?.source, 'user');
      // So does the browser's Back arriving while the page's own Back is read.
      const readings = asked.length;
      await back('interleaved', { during: () => navigate(agent, tab, 0, 'history', 'https://app.example/interleaved-browser-back',
        { transitionType: 'typed', transitionQualifiers: ['forward_back'] }) });
      assert.equal(navigation()?.source, 'user');
      assert.equal(asked.length, readings + 1, 'The merged Back is not read separately');
      assert.equal(run.agentRoute, null);
      // Without a fresh agent click, a page-initiated traversal is attributed like any page route update:
      // unattributed, unless it closely follows physical input or comes during a held gesture.
      before = await back('page-only', { click: false, arrange: () => { run.lastUserAt = 0; } });
      assert.equal(navigation()?.source, 'unknown');
      assert.equal(run.lastUserAt, before.userAt);
      assert.equal(run.agentRoute, null);
      before = await back('recent-input', { click: false, arrange: () => { run.lastUserAt = Date.now() - 1200; } });
      assert.equal(navigation()?.source, 'user', 'A page Back right after the person\'s own input is theirs');
      assert.equal(run.lastUserAt, before.userAt, 'It still does not renew the user time');
      await back('held-gesture', { click: false, arrange: () => { run.lastUserAt = 0; run.gestures.add(0); } });
      assert.equal(navigation()?.source, 'user');
      run.gestures.delete(0);
      await back('expired', { arrange: () => { run.lastUserAt = 0; run.sameDocumentNavigation.at -= 60000; } });
      assert.equal(navigation()?.source, 'unknown');
      // An unattributed page update merged into the reading keeps the navigation visible, as the page's
      // (no physical input in the last two seconds, so the update itself is not near-user).
      await back('merged', { arrange: () => { run.lastUserAt = 0; run.sameDocumentNavigation.at -= 60000; },
        during: () => navigate(agent, tab, 0, 'history', 'https://app.example/merged?page=1') });
      assert.equal(navigation()?.source, 'unknown');
      // An earlier unconsumed navigation is never erased by a later reading.
      const count = asked.length;
      run.events.clear(); run.sameDocumentNavigation = null;
      navigate(agent, tab, 0, 'history', 'https://app.example/without-click');
      send({ kind: 'activity', source: 'agent', operation: 'click' });
      reply = monitor(true);
      navigate(agent, tab, 0, 'history', 'https://app.example/coalesced', { transitionQualifiers: ['forward_back'] });
      await agent._pageFeedbackTraversalSettled(run);
      assert.equal(asked.length, count, 'A coalesced navigation is not re-attributed');
      assert.equal(navigation()?.source, 'user');
      // A full document replacement ends the recorded route.
      await back('before-commit');
      assert.ok(run.agentRoute);
      navigate(agent, tab, 0, 'committed', 'https://app.example/next-document');
      assert.equal(run.agentRoute, null);
    } finally { api.tabs.sendMessage = previous; urls.delete(tab); agent._releaseRunEntry(tab); }
  });

  test(`${build}: a traversal reading cannot outlive its run or hold Stop`, async () => {
    const agent = makeAgent(Agent), tab = nextTab++, previous = api.tabs.sendMessage;
    let answer;
    api.tabs.sendMessage = async (id, message, options) => message.action === 'page_monitor_traversal'
      ? new Promise(resolve => { answer = () => resolve({ ready: true, runToken: message.params.runToken, documentToken: 'main-token', pageInitiated: true }); })
      : previous(id, message, options);
    try {
      await agent._claimRunEntry(tab, 'interactive');
      let send = bindMain(agent, tab), run = agent._pageFeedbackRuns.get(tab);
      send({ kind: 'activity', source: 'agent', operation: 'click' });
      navigate(agent, tab, 0, 'history', 'https://app.example/stopped', { transitionQualifiers: ['forward_back'] });
      const started = Date.now();
      const waiting = agent._pageFeedbackTraversalSettled(run, agent._runAbortSignal(tab));
      agent.abort(tab);
      await assert.rejects(waiting, { name: 'AbortError' });
      assert.ok(Date.now() - started < 300, 'Stop does not wait for the monitor reading');
      agent._releaseRunEntry(tab);
      await agent._claimRunEntry(tab, 'interactive');
      send = bindMain(agent, tab); run = agent._pageFeedbackRuns.get(tab);
      send({ kind: 'activity', source: 'agent', operation: 'click' });
      navigate(agent, tab, 0, 'history', 'https://app.example/replaced', { transitionQualifiers: ['forward_back'] });
      const pending = run.traversalAttribution;
      agent._releaseRunEntry(tab);
      answer(); await pending.settled;
      assert.equal([...run.events.values()].find(event => event.kind === 'navigation')?.source, 'user',
        'An ended run keeps what it observed');
    } finally { api.tabs.sendMessage = previous; urls.delete(tab); agent._releaseRunEntry(tab); }
  });

  test(`${build}: only the action in flight claims its route, and a route reached by Back is never its proof`, async () => {
    const agent = makeAgent(Agent), tab = nextTab++, previous = api.tabs.sendMessage, seen = [];
    api.tabs.sendMessage = async (id, message, options) => message.action === 'page_monitor_traversal'
      ? { ready: true, runToken: message.params.runToken, documentToken: 'main-token', pageInitiated: true }
      : previous(id, message, options);
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const send = bindMain(agent, tab), run = agent._pageFeedbackRuns.get(tab);
      const claims = since => [agent._pageFeedbackAgentRouteCurrent(tab, run, since),
        agent._pageFeedbackAgentRouteCurrent(tab, run, since, { proof: true })];
      agent._executeToolWithLifecycle = async () => {
        const since = Date.now();
        // The monitor reports this press; the page pushes its next route.
        send({ kind: 'activity', source: 'agent', operation: 'click' });
        navigate(agent, tab, 0, 'history', 'https://app.example/pushed');
        seen.push(['pushed', ...claims(since), ...claims(Date.now() + 60000)]);
        // Then the page goes back by itself, as another frame's script could make it.
        navigate(agent, tab, 0, 'history', PAGE_URL, { transitionType: 'typed', transitionQualifiers: ['forward_back'] });
        await agent._pageFeedbackTraversalSettled(run);
        seen.push(['back', ...claims(since)]);
        return { success: true };
      };
      await agent.executeTool(tab, 'click', { text: 'Post' });
      assert.deepEqual(seen, [['pushed', true, true, false, false], ['back', true, false]],
        'Tolerated while this action is in flight; a Back route is not proof; an earlier route is not this action\'s');
      assert.equal(agent._pageFeedbackAgentRouteCurrent(tab, run, 0), false, 'No later action can claim it');
    } finally { api.tabs.sendMessage = previous; urls.delete(tab); agent._releaseRunEntry(tab); }
  });

  test(`${build}: Firefox keeps every Back/Forward update the user's`, async () => {
    const agent = makeAgent(Agent), tab = nextTab++, previous = api.tabs.sendMessage, asked = [];
    api.tabs.sendMessage = async (id, message, options) => {
      if (message.action !== 'page_monitor_traversal') return previous(id, message, options);
      asked.push(message);
      return { ready: true, runToken: message.params.runToken, documentToken: 'main-token', pageInitiated: true };
    };
    // Whether Gecko reports its own Back button as userInitiated is unverified.
    api.runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const send = bindMain(agent, tab), run = agent._pageFeedbackRuns.get(tab);
      send({ kind: 'activity', source: 'agent', operation: 'click' });
      navigate(agent, tab, 0, 'history', 'https://app.example/firefox-back', { transitionType: 'typed', transitionQualifiers: ['forward_back'] });
      assert.equal(run.traversalAttribution ?? null, null, 'No reading starts');
      await agent._pageFeedbackTraversalSettled(run);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(asked.length, 0);
      assert.equal([...run.events.values()].find(event => event.kind === 'navigation')?.source, 'user');
      assert.equal(run.agentRoute ?? null, null);
    } finally { delete api.runtime.getBrowserInfo; api.tabs.sendMessage = previous; urls.delete(tab); agent._releaseRunEntry(tab); }
  });

  test(`${build}: feedback a reading withdraws while it is applied is not delivered empty`, async () => {
    const agent = makeAgent(Agent), tab = nextTab++, previous = api.tabs.sendMessage, updates = [];
    api.tabs.sendMessage = async (id, message, options) => message.action === 'page_monitor_traversal'
      ? new Promise(resolve => setTimeout(() => resolve({ ready: true, runToken: message.params.runToken,
        documentToken: 'main-token', pageInitiated: true }), 40))
      : previous(id, message, options);
    // The reading answers during the idle wait that the traversal itself opened.
    agent._pageFeedbackIdleMs = 200;
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const send = bindMain(agent, tab), run = agent._pageFeedbackRuns.get(tab);
      send({ kind: 'activity', source: 'agent', operation: 'click' });
      navigate(agent, tab, 0, 'history', 'https://app.example/withdrawn', { transitionType: 'typed', transitionQualifiers: ['forward_back'] });
      assert.equal(agent._hasPendingPageFeedback(tab), true, 'The browser-UI attribution stands meanwhile');
      const messages = [];
      assert.equal(await agent._applyPendingPageFeedback(tab, messages, (type, data) => updates.push({ type, data })), false);
      assert.deepEqual(messages, [], 'No empty browser state update');
      assert.equal(updates.some(update => update.type === 'page_feedback'), false);
      assert.equal(run.agentRoute?.url, 'https://app.example/withdrawn');
    } finally { api.tabs.sendMessage = previous; urls.delete(tab); agent._releaseRunEntry(tab); }
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
        assert.match(result, /Read the inbox|could not validate the next action after repeated browser updates/i);
        assert.ok(Date.now() - started < 3000);
        assert.equal(dispatched.filter(name => name === 'extract_data').length, 1, 'The read proceeds through automatic churn');
      } finally { clearTimeout(stopper); clearInterval(ticker); urls.delete(tab); }
    });
  }
}
