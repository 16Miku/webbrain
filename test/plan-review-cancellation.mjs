import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => value, sendMessage: async () => ({}) },
};
const builds = await Promise.all(['chrome', 'firefox'].map(async build => ({
  build,
  Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
  journalModule: await import(`../src/${build}/src/run-ui-journal.js`),
  reconnect: (await import(`../src/${build}/src/run-reconnect.js`)).sendPlanResponseWithReconnect,
  background: (await fs.readFile(new URL(`../src/${build}/src/background.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
})));

function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `Missing production function ${name}`);
  return source.slice(start, end + 2);
}
function between(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Missing production message route ${from}`);
  return source.slice(start, end);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const connectionError = () => new Error('Owned runtime message port closed');

// Run the real worker routes without starting unrelated background services.
// Agent review timers/abort, the UI journal, and reconnect recovery stay real.
function fixture(build, options = {}) {
  const tab = 77, request = 'owned-request', planId = 'owned-plan';
  const runId = options.noTracing ? null : 'owned-runtime';
  const agent = new build.Agent({ getActive: () => ({ name: 'owned', model: 'owned' }) });
  agent._persist = () => {};
  agent._runningTabs.add(tab);
  if (runId) agent.currentRunId.set(tab, runId);
  const controller = new AbortController();
  agent._runAbortStates.set(tab, { controller, dispose() {} });
  agent.getConversationState = async () => ({ conversationId: 'owned-conversation' });
  agent.hasDurableSubmittedTurn = async () => true;
  const journal = new build.journalModule.RunUiJournal();
  journal.begin(tab, request);
  const messages = [], holds = [], waits = [], sends = [], statuses = [];
  const reserved = { requestId: request, cancelled: false };
  const context = vm.createContext({
    agent, runUiJournal: journal, console,
    contextMenuStorage: { hold: async tabId => { holds.push(tabId); await options.hold?.(); } },
    detachedRunStarts: new Map([[tab, reserved]]), detachedRunFailures: new Map(), runUiPersistenceFailures: new Map(),
    runUiSnapshotForRequest: build.journalModule.runUiSnapshotForRequest,
    getRunUiSnapshot: async tabId => journal.get(tabId),
    notifyPlanReview() {}, clearPlanReviewAttention() {}, planReviewAttentionByTab: new Map(),
    chrome: { runtime: { sendMessage: async message => { messages.push(structuredClone(message)); } } },
  });
  context.browser = context.chrome;
  vm.runInContext([
    ...['recordRunUiEvent', 'sendAgentUpdate', 'holdContextMenuPromptsAfterStop', 'cancelDetachedRunStart'].map(name => extract(build.background, name)),
    `async function route(msg, sender = {}) { switch (msg.action) {
      ${between(build.background, "    case 'agent_run_state': {", "    case 'agent_run_ack': {")}
      ${between(build.background, "    case 'plan_response': {", "    case 'get_debug_log': {")}
    } }`,
  ].join('\n'), context);
  const f = {
    ...build, tab, request, planId, runId, agent, journal, controller, messages, holds, waits, sends, statuses, reserved, context,
    state: () => context.route({ action: 'agent_run_state', tabId: tab, requestId: request }),
    respond: data => context.route({ action: 'plan_response', tabId: tab, planId, requestId: request, decision: 'reject', ...data }),
    review(id = planId) {
      const waiting = agent._waitForPlanReview(tab, id, { steps: [] }, 'Owned test plan',
        (type, data) => context.sendAgentUpdate(tab, request, type, data));
      waits.push(waiting);
      return waiting;
    },
    recover(options = {}) {
      return build.reconnect({
        payload: { tabId: tab, planId, decision: 'reject', ...options.payload }, requestId: options.requestId ?? request,
        send: async payload => {
          sends.push(structuredClone(payload));
          return options.send ? options.send(payload, sends.length) : f.respond(payload);
        },
        probe: options.probe || (() => f.state()),
        isConnectionError: error => /Owned runtime message port closed/.test(error?.message || ''),
        wait: options.wait || (async () => {}), onStatus: status => statuses.push(status),
      });
    },
    async close() { agent._cancelPendingPlans(tab, 'Owned fixture cleanup'); await Promise.all(waits); },
  };
  return f;
}

async function autoApprove(t, f) {
  const waiting = f.review();
  t.mock.timers.tick(120_000);
  await flush();
  assert.deepEqual(await waiting, { action: 'approve', source: 'timeout' });
  assert.equal(f.agent.activeRunState(f.tab).pendingPlan, null);
  assert.equal(f.journal.get(f.tab).status, 'running');
  assert.deepEqual({ ...f.journal.get(f.tab).lastPlanResolution }, { planId: f.planId, decision: 'approve' });
}
function assertStopped(f) {
  assert.equal(f.controller.signal.aborted, true, 'The live execution receives Stop');
  assert.equal(f.agent.abortFlags.get(f.tab), true);
  assert.equal(f.reserved.cancelled, true, 'Detached startup is cancelled just like Stop');
  assert.ok(f.holds.includes(f.tab), 'Queued browser-menu prompts are held just like Stop');
  assert.deepEqual({ ...f.journal.get(f.tab).lastPlanResolution }, { planId: f.planId, decision: 'reject' });
}

for (const build of builds) {
  test(`${build.build}: ordinary pending Cancel remains a review rejection`, async () => {
    const f = fixture(build), waiting = f.review();
    try {
      const response = await f.recover();
      assert.equal(response.matched, true);
      assert.equal((await waiting).action, 'reject');
      assert.equal(f.sends[0].requestId, f.request, 'The reconnect sender binds the worker message to its request');
      assert.equal(f.controller.signal.aborted, false, 'The pending planning gate handles its own rejection');
      assert.equal(f.holds.length, 0);
      assert.equal(f.journal.get(f.tab).lastPlanResolution.decision, 'reject');
    } finally { await f.close(); }
  });

  test(`${build.build}: Cancel delivered after the exact two-minute auto-approval stops the same live run`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(build), gate = deferred(), started = deferred(), waiting = f.review();
    try {
      const cancelling = f.recover({ send: async payload => { started.resolve(); await gate.promise; return f.respond(payload); } });
      await started.promise;
      t.mock.timers.tick(119_999);
      await flush();
      assert.equal(f.journal.get(f.tab).status, 'awaiting_plan');
      assert.equal(f.controller.signal.aborted, false);
      t.mock.timers.tick(1);
      await flush();
      assert.deepEqual(await waiting, { action: 'approve', source: 'timeout' });
      assert.equal(f.journal.get(f.tab).lastPlanResolution.decision, 'approve');
      gate.resolve();
      assert.equal((await cancelling).matched, true);
      assertStopped(f);
    } finally { gate.resolve(); await f.close(); }
  });

  test(`${build.build}: lost first Cancel retries after the reconnect probe observes auto-approval`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(build), waiting = f.review();
    try {
      const response = await f.recover({
        send: async (payload, attempt) => { if (attempt === 1) throw connectionError(); return f.respond(payload); },
        wait: async () => { t.mock.timers.tick(120_000); await flush(); },
      });
      assert.deepEqual(await waiting, { action: 'approve', source: 'timeout' });
      assert.equal(response.matched, true);
      assert.equal(f.sends.length, 2);
      assert.ok(f.sends.every(payload => payload.requestId === f.request));
      assertStopped(f);
    } finally { await f.close(); }
  });

  test(`${build.build}: a lost Stop reply recovers the rejected decision after journal ACK and run completion`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(build);
    try {
      await autoApprove(t, f);
      const response = await f.recover({ send: async payload => {
        assert.equal((await f.respond(payload)).matched, true);
        f.journal.acknowledge(f.tab, f.request, f.journal.get(f.tab).seq);
        f.journal.finish(f.tab, f.request, 'stopped', 'Stopped by user', f.runId);
        f.agent._runningTabs.delete(f.tab);
        throw connectionError();
      } });
      assert.equal(response.matched, true);
      assert.equal(response.recovered, true);
      assert.equal(f.sends.length, 1, 'The durable rejected resolution prevents a second Stop');
      assert.equal(f.journal.get(f.tab).events.some(event => event.type === 'plan_resolved'), false);
      assertStopped(f);
    } finally { await f.close(); }
  });

  test(`${build.build}: Stop and its durable resolution happen before prompt-hold storage finishes`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = deferred(), f = fixture(build, { hold: () => gate.promise });
    try {
      await autoApprove(t, f);
      let settled = false;
      const response = f.respond().then(value => { settled = true; return value; });
      await flush();
      assert.equal(settled, false);
      assertStopped(f);
      gate.resolve();
      assert.equal((await response).matched, true);
    } finally { gate.resolve(); await f.close(); }
  });

  test(`${build.build}: auto-approved Cancel still stops when tracing has no runtime ID`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(build, { noTracing: true });
    try {
      await autoApprove(t, f);
      assert.equal(f.journal.get(f.tab).runId, null);
      assert.equal((await f.recover()).matched, true);
      assertStopped(f);
    } finally { await f.close(); }
  });

  for (const change of ['wrong-request', 'missing-request', 'other-plan', 'another-runtime', 'restarted-worker', 'completed', 'stopped', 'failed', 'cancelled', 'clarification_required', 'new-plan']) {
    test(`${build.build}: late Cancel cannot stop ${change}`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = fixture(build);
      try {
        await autoApprove(t, f);
        const payload = {};
        if (change === 'wrong-request') payload.requestId = 'different-request';
        if (change === 'missing-request') payload.requestId = '';
        if (change === 'other-plan') payload.planId = 'different-plan';
        if (change === 'another-runtime') f.agent.currentRunId.set(f.tab, 'new-runtime');
        if (change === 'restarted-worker') f.agent._runningTabs.delete(f.tab);
        if (['completed', 'stopped', 'failed', 'cancelled', 'clarification_required'].includes(change)) f.journal.finish(f.tab, f.request, change, '', f.runId);
        if (change === 'new-plan') f.review('different-pending-plan');
        assert.equal((await f.respond(payload)).matched, false);
        assert.equal(f.controller.signal.aborted, false);
        assert.equal(f.agent.abortFlags.get(f.tab), undefined);
        assert.equal(f.reserved.cancelled, false);
        assert.equal(f.holds.length, 0);
      } finally { await f.close(); }
    });
  }

  test(`${build.build}: wrong request cannot settle an ordinary pending review`, async () => {
    const f = fixture(build), waiting = f.review();
    try {
      assert.equal((await f.respond({ requestId: 'different-request' })).matched, false);
      assert.equal(f.agent.activeRunState(f.tab).pendingPlan.planId, f.planId);
      assert.equal((await f.respond()).matched, true);
      assert.equal((await waiting).action, 'reject');
    } finally { await f.close(); }
  });

  test(`${build.build}: a replacement journal during snapshot await cannot cancel its new run`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(build), gate = deferred(), started = deferred();
    try {
      await autoApprove(t, f);
      const oldSnapshot = f.journal.get(f.tab);
      f.context.getRunUiSnapshot = async () => { started.resolve(); await gate.promise; return oldSnapshot; };
      const response = f.respond();
      await started.promise;
      f.journal.begin(f.tab, f.request);
      f.journal.record(f.tab, f.request, 'plan_resolved', { planId: f.planId, decision: 'approve' }, f.runId);
      gate.resolve();
      assert.equal((await response).matched, false);
      assert.equal(f.controller.signal.aborted, false);
      assert.equal(f.holds.length, 0);
    } finally { gate.resolve(); await f.close(); }
  });

  test(`${build.build}: reconnect cannot accept a different request's identical rejected plan ID`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(build);
    try {
      await autoApprove(t, f);
      f.journal.begin(f.tab, 'different-request');
      f.journal.record(f.tab, 'different-request', 'plan_resolved', { planId: f.planId, decision: 'reject' }, f.runId);
      const response = await f.recover({ probe: async () => ({ ...f.agent.activeRunState(f.tab), runUi: f.journal.get(f.tab) }) });
      assert.equal(response.matched, false);
      assert.equal(f.controller.signal.aborted, false);
      assert.equal(f.sends.length, 1);
    } finally { await f.close(); }
  });
}
