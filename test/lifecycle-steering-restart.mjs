// Real Agent loops (both builds) over one shared fake session storage. A run
// accepts a correction from the chat panel, then its background (MV3 service
// worker / Firefox background page) dies before the next boundary: that Agent
// never runs again and its pending debounced writes are lost. A new Agent on the
// same storage resumes the same request exactly as continue_start does. The
// correction must be applied once, first, with its original message ID. When
// no run resumes it, it returns to the panel held, as after Stop; a cleared
// conversation or a closed tab discards it. Background routing and the panel's
// reconnect follower are extracted verbatim from both builds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const PAGE_URL = 'https://example.com/search';
function persistentArea() {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const list = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      return Object.fromEntries(list.filter(key => data.has(key)).map(key => [key, structuredClone(data.get(key))]));
    },
    async set(values) { for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value)); },
    async remove(keys) { for (const key of [].concat(keys)) data.delete(key); },
  };
}
// chrome.storage.session outlives a service-worker restart within a browser session.
const session = persistentArea();
const api = {
  storage: { local: persistentArea(), session },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}), getManifest: () => ({ version: 'test' }) },
  tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Search' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;

let nextTab = 9300;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const call = (id, name, args = {}) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
const authored = messages => messages.filter(message => message.role === 'user' && !message.webbrainAppOwned).at(-1)?.content;
const plain = value => JSON.parse(JSON.stringify(value));
const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/src/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function: ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const savedSteering = tab => (session.data.get(`agentConv:${tab}`)?.messages || []).filter(message => message.webbrainSteering);
const journaled = tab => session.data.get(`agentSteer:${tab}`)?.entries || [];

function makeAgent(Agent, next) {
  const provider = {
    name: 'steering restart test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false, chat: (messages, options) => next(messages, options),
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  // Conversation hydration and persistence stay real: they are what a restart keeps.
  Object.assign(agent, {
    _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
    _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
    _currentUrl: async () => PAGE_URL, _getTabUrlTitle: async () => ({ tabUrl: PAGE_URL, tabTitle: 'Search' }),
    _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {}, _ensureProgressSessionForCurrentTask: async () => {},
    _plannerMode: () => 'off',
    _runPlannerIntentGate: async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false }),
    _skipPermissionGate: true, _ensureGateSetting: async () => true, _shouldAutoScreenshot: () => false,
    _pageFeedbackIdleMs: 0, _completionDoneBlock: () => null,
  });
  agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  return agent;
}

// The model reads the page once, then reports the given result.
function readThenDone(summary, requests = []) {
  return async messages => {
    requests.push(messages);
    return requests.length === 1 ? call('read', 'get_accessibility_tree') : call('done', 'done', { summary, outcome: 'success' });
  };
}

function recordTools(agent, events) {
  agent._executeToolWithLifecycle = async (_tab, name, args) => {
    events.push(`tool:${name}`);
    if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
    return { success: true, pageContent: 'main [ref_1]' };
  };
}

// A dead background runs nothing more: debounced writes it had not flushed are lost.
function killBackground(agent) {
  for (const timer of agent.persistTimers.values()) clearTimeout(timer);
  agent.persistTimers.clear();
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: false });
}

// The old task acts once, then its background dies while the next model request
// is in flight, after the corrections were accepted and acknowledged.
async function interruptedRun(Agent, { tab, requestId, mode = 'act', corrections }) {
  const entered = deferred(), events = [];
  let requests = 0;
  const agent = makeAgent(Agent, async () => {
    if (++requests === 1) return call('old-read', 'get_accessibility_tree');
    entered.resolve();
    return new Promise(() => {});
  });
  recordTools(agent, events);
  void agent.processMessage(tab, 'Open the pricing page', () => {}, mode, [], { detachedRequestId: requestId });
  await entered.promise;
  for (const [id, text] of corrections) {
    assert.equal(agent.steerMessage(tab, text, { requestId, messageId: id }).accepted, true);
  }
  // The background acknowledges an accepted correction to the panel only after this.
  await agent.flushSteeringJournal?.(tab);
  killBackground(agent);
  assert.deepEqual(events, ['tool:get_accessibility_tree'], 'fixture: the old task acted before the restart');
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const reconnect = await import(`../src/${build}/src/run-reconnect.js`);
  const journalModule = await import(`../src/${build}/src/run-ui-journal.js`);

  for (const mode of ['act', 'ask']) {
    test(`${build}: ${mode} corrections accepted before a restart are applied once, first and in order when the run resumes`, async () => {
      const tab = nextTab++, requestId = `resume-${mode}-${tab}`;
      await interruptedRun(Agent, { tab, requestId, mode, corrections: [
        ['c1', 'Open the docs page instead'], ['c2', 'Then read its changelog'],
      ] });
      assert.equal(savedSteering(tab).length, 0, 'fixture: nothing was applied before the restart');

      const events = [], updates = [], requests = [];
      const fresh = makeAgent(Agent, async messages => {
        requests.push({ latest: authored(messages), users: messages.filter(message => message.role === 'user').map(message => message.content) });
        events.push('model');
        if (requests.length === 1) return call('new-read', 'get_accessibility_tree');
        return mode === 'act'
          ? call('done', 'done', { summary: 'Read the docs changelog.', outcome: 'success' })
          : { content: 'Read the docs changelog.' };
      });
      recordTools(fresh, events);
      // A third correction arrives while the resumed run is still starting.
      const hydrate = fresh._hydrate.bind(fresh);
      let startupCorrection = null;
      fresh._hydrate = async tabId => {
        startupCorrection ??= fresh.steerMessage(tabId, 'Skip the archive', { requestId, messageId: 'c3' });
        return hydrate(tabId);
      };
      const result = await fresh.continueProcessing(tab, (type, data) => {
        updates.push({ type, data });
        if (type === 'steering_applied') events.push(`applied:${data.id}`);
      }, mode, { detachedRequestId: requestId });

      assert.equal(result, 'Read the docs changelog.');
      assert.equal(startupCorrection?.accepted, true);
      assert.deepEqual(updates.filter(update => update.type === 'steering_applied').map(update => [update.data.id, update.data.text]),
        [['c1', 'Open the docs page instead'], ['c2', 'Then read its changelog'], ['c3', 'Skip the archive']]);
      assert.deepEqual(events.slice(0, 4), ['applied:c1', 'applied:c2', 'applied:c3', 'model'],
        'Every correction is applied before the resumed run asks the model or acts');
      assert.equal(requests[0].latest, 'Skip the archive', 'The first resumed request answers the corrected task');
      assert.ok(requests[0].users.includes('Open the docs page instead') && requests[0].users.includes('Then read its changelog'));
      assert.equal(updates.some(update => update.type === 'steering_queued'), false);
      await waitFor(() => savedSteering(tab).length === 3, 'the applied corrections to be saved');
      assert.deepEqual(savedSteering(tab).map(message => [message.content, message.webbrainSteering.requestId, message.webbrainSteering.messageId]), [
        ['Open the docs page instead', requestId, 'c1'], ['Then read its changelog', requestId, 'c2'], ['Skip the archive', requestId, 'c3'],
      ]);
      await fresh.flushSteeringJournal(tab);
      assert.deepEqual(journaled(tab), [], 'Nothing is left to recover or hand back');
    });
  }

  for (const journalState of ['forgotten', 'still journaled']) {
    test(`${build}: a correction already saved in the conversation is not applied again after another restart (${journalState})`, async () => {
      const tab = nextTab++, requestId = `applied-${tab}`, text = 'Open the docs page instead';
      await interruptedRun(Agent, { tab, requestId, corrections: [['c1', text]] });
      // The second background applies and saves it, then dies too.
      const entered = deferred(), secondUpdates = [];
      const second = makeAgent(Agent, async () => { entered.resolve(); return new Promise(() => {}); });
      recordTools(second, []);
      void second.continueProcessing(tab, (type, data) => secondUpdates.push({ type, data }), 'act', { detachedRequestId: requestId });
      await entered.promise;
      assert.deepEqual(secondUpdates.filter(update => update.type === 'steering_applied').map(update => update.data.id), ['c1']);
      await waitFor(() => savedSteering(tab).length === 1, 'the correction to be saved');
      await second.flushSteeringJournal(tab);
      assert.deepEqual(journaled(tab), [], 'A durably applied correction leaves the journal');
      killBackground(second);
      if (journalState === 'still journaled') {
        // The background died between saving the conversation and its journal update.
        session.data.set(`agentSteer:${tab}`, { entries: [{ requestId, id: 'c1', text, acceptedAt: 1 }] });
      }

      const events = [], updates = [], requests = [];
      const third = makeAgent(Agent, readThenDone('Opened the docs page.', requests));
      recordTools(third, events);
      assert.equal(await third.continueProcessing(tab, (type, data) => updates.push({ type, data }), 'act', { detachedRequestId: requestId }),
        'Opened the docs page.');
      assert.equal(updates.some(update => update.type === 'steering_applied'), false);
      assert.equal(updates.some(update => update.type === 'steering_queued'), false);
      assert.equal(requests[0].filter(message => message.content === text).length, 1, 'The model sees the correction once');
      assert.equal(savedSteering(tab).length, 1);
      await third.flushSteeringJournal(tab);
      assert.deepEqual(journaled(tab), []);
    });
  }

  test(`${build}: a new request never applies an interrupted request's correction; it returns held`, async () => {
    const tab = nextTab++, text = 'Delete the draft instead';
    await interruptedRun(Agent, { tab, requestId: `old-${tab}`, corrections: [['c1', text]] });
    const updates = [], requests = [], events = [];
    const fresh = makeAgent(Agent, readThenDone('Summarized the page.', requests));
    recordTools(fresh, events);
    assert.equal(await fresh.processMessage(tab, 'Summarize this page', (type, data) => updates.push({ type, data }), 'act', [],
      { detachedRequestId: `new-${tab}` }), 'Summarized the page.');
    assert.equal(updates.some(update => update.type === 'steering_applied'), false);
    assert.ok(requests.length && requests.every(messages => messages.every(message => message.content !== text)),
      'Another run never sees the correction');
    assert.deepEqual(plain(updates.filter(update => update.type === 'steering_queued').map(update => update.data)),
      [{ messages: [{ id: 'c1', text }], stopped: true }]);
    await fresh.flushSteeringJournal(tab);
    assert.deepEqual(journaled(tab), []);
  });

  test(`${build}: a resumed request restores only its own corrections`, async () => {
    const tab = nextTab++, requestId = `own-${tab}`;
    await interruptedRun(Agent, { tab, requestId, corrections: [['c1', 'Open the docs page instead']] });
    // An older interrupted request in this tab left a correction too.
    session.data.set(`agentSteer:${tab}`, { entries: [
      { requestId: `older-${tab}`, id: 'c0', text: 'Close every tab', acceptedAt: 0 }, ...journaled(tab),
    ] });
    const updates = [], requests = [], events = [];
    const fresh = makeAgent(Agent, readThenDone('Opened the docs page.', requests));
    recordTools(fresh, events);
    assert.equal(await fresh.continueProcessing(tab, (type, data) => updates.push({ type, data }), 'act', { detachedRequestId: requestId }),
      'Opened the docs page.');
    assert.deepEqual(updates.filter(update => update.type === 'steering_applied').map(update => update.data.id), ['c1']);
    assert.deepEqual(plain(updates.filter(update => update.type === 'steering_queued').map(update => update.data)),
      [{ messages: [{ id: 'c0', text: 'Close every tab' }], stopped: true }]);
    assert.ok(requests.every(messages => messages.every(message => message.content !== 'Close every tab')));
    await fresh.flushSteeringJournal(tab);
    assert.deepEqual(journaled(tab), []);
  });

  test(`${build}: Stop after a restart holds the correction instead of applying it`, async () => {
    // Stop while nothing is running: the panel reclaims it; a later resume applies nothing.
    const tab = nextTab++, requestId = `stop-idle-${tab}`, text = 'Post it on Mastodon too';
    await interruptedRun(Agent, { tab, requestId, corrections: [['c1', text]] });
    const requests = [], updates = [];
    const fresh = makeAgent(Agent, readThenDone('Posted on X.', requests));
    recordTools(fresh, []);
    assert.equal(await fresh.unappliedSteeringCount?.(tab), 1);
    assert.deepEqual(plain((await fresh.reclaimUnappliedSteering?.(tab))?.messages), [{ requestId, id: 'c1', text }]);
    assert.deepEqual(journaled(tab), []);
    assert.equal(await fresh.continueProcessing(tab, (type, data) => updates.push({ type, data }), 'act', { detachedRequestId: requestId }),
      'Posted on X.');
    assert.equal(updates.some(update => ['steering_applied', 'steering_queued'].includes(update.type)), false);
    assert.ok(requests.length && requests.every(messages => messages.every(message => message.content !== text)));

    // Stop while the resumed run is starting: nothing is applied and the panel holds it.
    const stopTab = nextTab++, stopRequest = `stop-live-${stopTab}`;
    await interruptedRun(Agent, { tab: stopTab, requestId: stopRequest, corrections: [['c1', text]] });
    const stopUpdates = [];
    const stopping = makeAgent(Agent, async () => assert.fail('No model request may start after Stop'));
    recordTools(stopping, []);
    stopping._enrichUserMessageWithCurrentPage = async (tabId, _messages, content) => {
      stopping.abort(tabId);
      return { role: 'user', content };
    };
    assert.match(await stopping.continueProcessing(stopTab, (type, data) => stopUpdates.push({ type, data }), 'act',
      { detachedRequestId: stopRequest }), /Stopped by user/);
    assert.equal(stopUpdates.some(update => update.type === 'steering_applied'), false);
    assert.deepEqual(plain(stopUpdates.filter(update => update.type === 'steering_queued').map(update => update.data)),
      [{ messages: [{ id: 'c1', text }], stopped: true }]);
    assert.equal(savedSteering(stopTab).length, 0);
    await stopping.flushSteeringJournal(stopTab);
    assert.deepEqual(journaled(stopTab), []);
  });

  for (const discard of ['conversation clear', 'tab close']) {
    test(`${build}: a ${discard} discards unapplied corrections`, async () => {
      const tab = nextTab++, requestId = `discard-${tab}`, text = 'Archive the thread instead';
      await interruptedRun(Agent, { tab, requestId, corrections: [['c1', text]] });
      const updates = [], requests = [];
      const fresh = makeAgent(Agent, readThenDone('Summarized the page.', requests));
      recordTools(fresh, []);
      if (discard === 'conversation clear') await fresh.clearConversation(tab);
      else { fresh._cleanupTab(tab); await fresh.flushSteeringJournal?.(tab); }
      assert.equal(session.data.has(`agentSteer:${tab}`), false);
      assert.equal(await fresh.unappliedSteeringCount?.(tab), 0);
      assert.deepEqual(plain((await fresh.reclaimUnappliedSteering?.(tab))?.messages), []);
      assert.equal(await fresh.processMessage(tab, 'Summarize this page', (type, data) => updates.push({ type, data }), 'act', [],
        { detachedRequestId: `after-${tab}` }), 'Summarized the page.');
      assert.equal(updates.some(update => ['steering_applied', 'steering_queued'].includes(update.type)), false);
      assert.ok(requests.length && requests.every(messages => messages.every(message => message.content !== text)));
    });
  }

  test(`${build}: a resume that fails before restoring leaves the correction for the panel`, async () => {
    const tab = nextTab++, requestId = `failed-${tab}`, text = 'Use the staging server';
    await interruptedRun(Agent, { tab, requestId, corrections: [['c1', text]] });
    const fresh = makeAgent(Agent, async () => assert.fail('The failed resume never reaches the model'));
    const hydrate = fresh._hydrate.bind(fresh);
    fresh._hydrate = async () => { throw new Error('session storage unavailable'); };
    const updates = [];
    await assert.rejects(fresh.continueProcessing(tab, (type, data) => updates.push({ type, data }), 'act', { detachedRequestId: requestId }),
      /session storage unavailable/);
    fresh._hydrate = hydrate;
    assert.equal(updates.some(update => update.type === 'steering_applied'), false);
    assert.equal(await fresh.unappliedSteeringCount?.(tab), 1);
    assert.deepEqual(plain((await fresh.reclaimUnappliedSteering?.(tab))?.messages), [{ requestId, id: 'c1', text }]);
    assert.deepEqual(journaled(tab), []);
  });

  test(`${build}: a live or starting run keeps its journaled corrections`, async () => {
    const tab = nextTab++, requestId = `live-${tab}`;
    const agent = makeAgent(Agent, async () => ({ content: 'unused' }));
    await agent._claimRunEntry(tab, 'interactive', { detachedRequestId: requestId });
    const updates = [];
    agent._beginSteeringRun(tab, (type, data) => updates.push({ type, data }), { detachedRequestId: requestId });
    try {
      assert.equal(agent.steerMessage(tab, 'Use blue', { requestId, messageId: 'c1' }).accepted, true);
      await agent.flushSteeringJournal(tab);
      assert.deepEqual(journaled(tab).map(entry => [entry.requestId, entry.id, entry.text]), [[requestId, 'c1', 'Use blue']],
        'Accepted corrections are journaled before the panel is told');
      assert.equal(await agent.unappliedSteeringCount(tab), 0);
      assert.deepEqual(plain((await agent.reclaimUnappliedSteering(tab)).messages), [], 'A live run applies its own corrections');
      assert.equal(journaled(tab).length, 1);
    } finally {
      agent._finishSteeringRun(tab);
      agent._releaseRunEntry(tab);
    }
    // An ordinary end hands the correction back through the run itself.
    assert.deepEqual(plain(updates.map(update => [update.type, update.data])),
      [['steering_queued', { messages: [{ id: 'c1', text: 'Use blue' }] }]]);
    await agent.flushSteeringJournal(tab);
    assert.deepEqual(journaled(tab), []);
    // A restarted background must also leave a reserved (starting) run's corrections alone.
    session.data.set(`agentSteer:${tab}`, { entries: [{ requestId, id: 'c2', text: 'Use red', acceptedAt: 1 }] });
    const restarted = makeAgent(Agent, async () => ({ content: 'unused' }));
    assert.deepEqual(plain((await restarted.reclaimUnappliedSteering(tab, { isBusy: () => true })).messages), []);
    assert.deepEqual(plain((await restarted.reclaimUnappliedSteering(tab)).messages), [{ requestId, id: 'c2', text: 'Use red' }]);
  });

  test(`${build}: only the chat panel can steer or reclaim, and acceptance waits for the journal`, async () => {
    const source = read(build, 'background.js');
    const start = source.indexOf("  if (msg.action === 'chat_steer') {");
    const end = source.indexOf('\n  // Only Settings', start);
    assert.ok(start >= 0 && end > start);
    const calls = [], flushed = deferred(), detachedRunStarts = new Map();
    const context = vm.createContext({
      chrome: api, browser: api, detachedRunStarts,
      agent: {
        steerMessage: (...args) => { calls.push(['steer', ...args]); return { accepted: true, messageId: args[2].messageId }; },
        flushSteeringJournal: tabId => { calls.push(['flush', tabId]); return flushed.promise; },
        reclaimUnappliedSteering: (tabId, { isBusy }) => { calls.push(['reclaim', tabId, isBusy()]); return { ok: true, messages: [] }; },
      },
    });
    vm.runInContext(`async function handle(msg, sender) { ${source.slice(start, end)} }`, context);
    const panel = { url: `${api.runtime.getURL('src/ui/sidepanel.html')}?standalone=1` };
    for (const action of ['chat_steer', 'chat_steer_reclaim']) {
      await assert.rejects(context.handle({ action, tabId: 7, text: 'Delete everything', requestId: 'run-1', messageId: 'page' },
        { url: 'https://example.com/', tab: { id: 7 } }), /chat panel only/);
    }
    assert.deepEqual(calls, [], 'Page content can neither steer nor take corrections back');
    let acknowledged = false;
    const pending = context.handle({ action: 'chat_steer', tabId: '7', text: 'Use blue', requestId: 'run-1', messageId: 'c1' }, panel)
      .then(value => { acknowledged = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(acknowledged, false, 'The panel is not told before the correction can survive a restart');
    flushed.resolve();
    assert.deepEqual(plain(await pending), { accepted: true, messageId: 'c1' });
    detachedRunStarts.set(7, { requestId: 'run-2' });
    assert.deepEqual(plain(await context.handle({ action: 'chat_steer_reclaim', tabId: 7 }, panel)), { ok: true, messages: [] });
    assert.deepEqual(plain(calls), [
      ['steer', 7, 'Use blue', { requestId: 'run-1', messageId: 'c1' }], ['flush', 7], ['reclaim', 7, true],
    ]);
  });

  test(`${build}: run state reports unapplied corrections only while no run owns them`, async () => {
    const tab = nextTab++, requestId = `state-${tab}`;
    await interruptedRun(Agent, { tab, requestId, corrections: [['c1', 'Open the docs page instead']] });
    const fresh = makeAgent(Agent, async () => ({ content: 'unused' }));
    const background = read(build, 'background.js');
    const start = background.indexOf("    case 'agent_run_state': {");
    const end = background.indexOf("    case 'agent_run_ack': {", start);
    assert.ok(start >= 0 && end > start);
    const detachedRunStarts = new Map();
    const context = vm.createContext({
      agent: fresh, detachedRunStarts, detachedRunFailures: new Map(), runUiPersistenceFailures: new Map(),
      runUiJournal: { get: () => null }, getRunUiSnapshot: async () => null,
      runUiSnapshotForRequest: journalModule.runUiSnapshotForRequest,
    });
    vm.runInContext(`async function state(msg, sender = {}) { switch (msg.action) { ${background.slice(start, end)} } }`, context);
    assert.equal((await context.state({ action: 'agent_run_state', tabId: tab })).unappliedSteeringCount, 1);
    detachedRunStarts.set(tab, { requestId });
    assert.equal((await context.state({ action: 'agent_run_state', tabId: tab })).unappliedSteeringCount, 0,
      'A starting resume owns them');
  });

  test(`${build}: the panel holds corrections whose interrupted run is not resumed`, async () => {
    const source = read(build, 'ui/sidepanel.js');
    const functions = ['sameTabId', 'getQueuedComposerMessages', 'setQueuedComposerMessages', 'queueUnconsumedSteeringMessages',
      'reclaimUnappliedSteering', 'sendRunWithReconnect', 'isTerminalRunUiStatus', 'restoreActiveRunState']
      .map(name => extract(source, name)).join('\n');
    const tab = 5, requestId = 'panel-run';
    const correction = { requestId, id: 'c1', text: 'Use the docs page' };
    const sent = [], script = [];
    let reclaimable = [], refreshedState = null, adoptions = 0;
    const context = vm.createContext({
      currentTabId: tab, renderedTabId: tab,
      queuedComposerMessagesByTab: new Map(), queuedSteeringMessageIds: new Set(), clearedConversationRunRequestIds: new Set(),
      cancelledRunRecoveryRequestIds: new Set(), conversationClearFollowerCancellationRequestIds: new Set(),
      localRunFollowers: new Map(), failedConversationClearRecoveryTabs: new Set(),
      runDetachedWithReconnect: reconnect.runDetachedWithReconnect, isBackgroundConnectionError: reconnect.isBackgroundConnectionError,
      isConversationClearInProgress: () => false, isTabAbortRequested: () => false, isAwaitingPlanReviewForTab: () => false,
      renderQueuedComposerMessages: () => {}, resetComposerHistoryNavigation: () => {}, showActivity: () => {},
      applyConversationScopeState: () => {}, applyActiveRunState: async () => true,
      normalizePlanReviewTabId: Number, recoverActiveRunAfterFailedConversationClear: async () => {},
      refreshConversationScopeState: async () => refreshedState, adoptRestoredRunState: async () => { adoptions++; },
      sendToBackground: async (action, data) => {
        sent.push(action);
        if (action === 'chat_steer_reclaim') {
          assert.equal(data.tabId, tab);
          const messages = reclaimable; reclaimable = [];
          return { ok: true, messages };
        }
        const next = script.shift();
        assert.ok(next, `Unexpected ${action}`);
        if (next instanceof Error) throw next;
        return next;
      },
    });
    vm.runInContext(functions, context);
    const queue = () => plain(context.getQueuedComposerMessages(tab));
    const lost = () => new Error('Could not establish connection. Receiving end does not exist.');
    const options = { wait: async () => {} };

    // The background restarted and the run cannot resume safely: the follower gives up.
    reclaimable = [correction];
    script.push({ ok: true, accepted: true, requestId }, lost(), { ok: true, running: false, starting: false,
      runUi: { requestId, status: 'running', seq: 3, pendingToolCall: { name: 'click_ax' } }, unappliedSteeringCount: 1 });
    await assert.rejects(context.sendRunWithReconnect('chat_start', { tabId: tab, requestId, text: 'Open the pricing page' }, options),
      /outcome of click_ax is uncertain/);
    assert.deepEqual(queue(), [{ id: 'c1', text: 'Use the docs page', held: true }], 'Held like after Stop, never sent on its own');
    assert.equal(sent.filter(action => action === 'chat_steer_reclaim').length, 1);

    // A run that finished without any restart returned its own leftovers; no reclaim round trip.
    context.queuedComposerMessagesByTab.clear(); sent.length = 0;
    script.push({ ok: true, accepted: true, requestId: 'quiet' },
      { ok: true, running: false, starting: false, runUi: { requestId: 'quiet', status: 'completed', seq: 2, events: [] } });
    await context.sendRunWithReconnect('chat_start', { tabId: tab, requestId: 'quiet', text: 'Summarize' }, options);
    assert.deepEqual(sent, ['chat_start', 'agent_run_state']);

    // Stop during the reconnect: the follower does not resume, the correction is held.
    sent.length = 0; reclaimable = [{ ...correction, id: 'c2' }];
    script.push({ ok: true, accepted: true, requestId: 'stopped' }, lost(),
      { ok: true, running: false, starting: false, submittedTurnDurable: true, runUi: { requestId: 'stopped', status: 'running', seq: 2 } });
    const stopOptions = { wait: async () => { if (sent.includes('agent_run_state')) context.cancelledRunRecoveryRequestIds.add('stopped'); } };
    await assert.rejects(context.sendRunWithReconnect('chat_start', { tabId: tab, requestId: 'stopped', text: 'Post it' }, stopOptions),
      /Run recovery was cancelled/);
    assert.deepEqual(queue(), [{ id: 'c2', text: 'Use the docs page', held: true }]);
    assert.equal(sent.includes('continue_start'), false, 'Stop never resumes the interrupted run');

    // Rendering an idle tab whose interrupted run can no longer resume reclaims too.
    context.queuedComposerMessagesByTab.clear(); sent.length = 0; reclaimable = [{ ...correction, id: 'c3' }];
    refreshedState = { ok: true, running: false, starting: false, unappliedSteeringCount: 1, runUi: { requestId, status: 'failed' } };
    await context.restoreActiveRunState(tab);
    assert.deepEqual(queue(), [{ id: 'c3', text: 'Use the docs page', held: true }]);
    // A resumable run applies its own corrections; the panel leaves them to it.
    sent.length = 0; reclaimable = [{ ...correction, id: 'c4' }];
    for (const state of [
      { running: false, starting: false, unappliedSteeringCount: 1, runUi: { requestId, status: 'running' } },
      { running: true, starting: false, unappliedSteeringCount: 0, runUi: { requestId, status: 'running' } },
    ]) {
      refreshedState = { ok: true, ...state };
      await context.restoreActiveRunState(tab);
    }
    assert.deepEqual(sent, []);
    assert.equal(adoptions, 3);
  });
}
