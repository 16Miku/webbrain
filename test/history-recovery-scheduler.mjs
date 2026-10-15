import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => value, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/' }), sendMessage: async () => ({}) },
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function backgroundGuards(source, agent, scheduler, locks, cloudGuard = async () => {}) {
  const cloudRunController = typeof cloudGuard === 'function'
    ? { guardRunStart: cloudGuard, isRunning: () => false }
    : cloudGuard;
  const start = source.indexOf('agent.setRunStartGuard(async (tabId, context) => {');
  const end = source.indexOf('\nconst profileSync', start);
  assert.ok(start >= 0 && end > start, 'The production run-start guard must be exercised');
  let runStartGuard;
  new Function('agent', 'recoveringHistoryTabs', 'cloudRunController', 'teacherRunInterlock', source.slice(start, end))(
    { setRunStartGuard: guard => { runStartGuard = guard; } }, locks,
    cloudRunController, { guardRunStart: async () => {} },
  );
  const assertStart = source.indexOf('function assertNoActiveTabRun(tabId) {');
  const assertEnd = source.indexOf('\nasync function activateForegroundCompatibilityTab', assertStart);
  assert.ok(assertStart >= 0 && assertEnd > assertStart, 'The production recovery guard must be exercised');
  const assertNoActiveTabRun = new Function('agent', 'scheduler', 'cloudRunController', 'recoveringHistoryTabs', 'detachedRunStarts',
    `${source.slice(assertStart, assertEnd)}\nreturn assertNoActiveTabRun;`)(agent, scheduler, cloudRunController, locks, new Map());
  return { runStartGuard, assertNoActiveTabRun };
}

async function createTask(h) {
  const result = await h.manager.createTaskJob({
    tabId: 77, conversationId: 'conv-1', source: 'sidepanel', currentUrl: 'https://example.com/',
    args: { title: 'Read later', prompt: 'Read this page', mode: 'ask', schedule: { after_seconds: 60 },
      target: { type: 'current_tab' } },
  });
  assert.equal(result.success, true);
  return result.jobId;
}

function cloudFixture(createCloudRunController, { clear = async () => {}, process = async () => 'Finished' } = {}) {
  const stored = {}, counts = { clears: 0, dispatches: 0 };
  const tab = { id: 77, windowId: 1, url: 'https://example.com/' };
  const api = {
    storage: { session: {
      get: async key => ({ [key]: structuredClone(stored[key]) }),
      set: async values => Object.assign(stored, structuredClone(values)),
    } },
    tabs: {
      get: async () => tab, query: async () => [tab], create: async () => tab,
      update: async () => tab, remove: async () => {},
    },
  };
  const agent = {
    isRunning: () => false, activeRunState: () => ({ running: false }), abort: () => {},
    clearConversation: async () => { counts.clears++; await clear(); },
    processMessage: async (...args) => { counts.dispatches++; return process(...args); },
  };
  const controller = createCloudRunController({ chromeApi: api, agent, ensureOffscreen: async () => {} });
  return { agent, controller, counts };
}

async function waitForCloudIdle(controller) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!controller.isRunning(77)) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Cloud run did not release its tab after the test gates settled');
}

for (const build of ['chrome', 'firefox']) {
  const source = await readFile(`src/${build}/src/background.js`, 'utf8');
  const scheduler = await import(`../src/${build}/src/agent/scheduler.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { createCloudRunController } = await import(`../src/${build}/src/cloud-runs.js`);

  test(`${build}: history recovery blocks scheduler reservation and defers the job without losing it`, async () => {
    let dispatches = 0, cloudChecks = 0;
    const locks = new Set([77]);
    const h = makeSchedulerHarness(scheduler, { processMessage: async () => { dispatches++; return 'Finished'; } });
    h.manager.agent.activeRunState = () => ({ running: false });
    const guards = backgroundGuards(source, h.manager.agent, h.manager, locks, async () => { cloudChecks++; });
    h.manager.agent.assertRunStartAllowed = (tabId, kind) => guards.runStartGuard(tabId, { kind });
    const jobId = await createTask(h);
    await h.manager.handleAlarm(h.alarmName(jobId));
    assert.equal(dispatches, 0);
    assert.equal(cloudChecks, 0, 'A recovery-owned tab must be rejected before asynchronous startup checks');
    assert.equal(h.manager.isRunning(77), false, 'Rejected startup must release the scheduler reservation');
    assert.equal(h.jobs()[0].status, 'queued', 'Recovery is transient contention, not a permanent scheduled failure');
    assert.equal(h.alarms.has(h.alarmName(jobId)), true);
    assert.deepEqual([...locks], [77], 'Scheduler rejection must retain the recovery owner');
    locks.delete(77);
    await h.manager.handleAlarm(h.alarmName(jobId));
    assert.equal(dispatches, 1);
    assert.equal(h.jobs()[0].status, 'completed');
    assert.doesNotThrow(() => guards.assertNoActiveTabRun(77));
  });

  test(`${build}: scheduler reservation blocks recovery throughout guard and provider startup`, async () => {
    const guarded = deferred(), releaseGuard = deferred(), loading = deferred(), releaseLoading = deferred();
    let dispatches = 0;
    const locks = new Set();
    const h = makeSchedulerHarness(scheduler, { processMessage: async () => { dispatches++; return 'Finished'; } });
    h.manager.agent.activeRunState = () => ({ running: false });
    const guards = backgroundGuards(source, h.manager.agent, h.manager, locks, async () => {
      guarded.resolve(); await releaseGuard.promise;
    });
    h.manager.agent.assertRunStartAllowed = (tabId, kind) => guards.runStartGuard(tabId, { kind });
    h.manager.loadProviders = async () => { loading.resolve(); await releaseLoading.promise; };
    const jobId = await createTask(h);
    const run = h.manager.handleAlarm(h.alarmName(jobId));
    try {
      await guarded.promise;
      assert.equal(h.manager.isRunning(77), true);
      assert.equal(dispatches, 0);
      assert.throws(() => guards.assertNoActiveTabRun(77), /already active/);
      releaseGuard.resolve();
      await loading.promise;
      assert.equal(h.manager.isRunning(77), true);
      assert.equal(dispatches, 0, 'The scheduled agent has not started during provider loading');
      assert.throws(() => guards.assertNoActiveTabRun(77), /already active/);
    } finally {
      releaseGuard.resolve(); releaseLoading.resolve(); await run;
    }
    assert.equal(dispatches, 1);
    assert.equal(h.manager.isRunning(77), false);
    assert.doesNotThrow(() => guards.assertNoActiveTabRun(77));
  });

  test(`${build}: actual scheduled agent startup rechecks history ownership before processing`, async () => {
    const agent = new Agent({ getActive: () => ({ supportsVision: false }) });
    const locks = new Set();
    const guards = backgroundGuards(source, agent, { isRunning: () => false }, locks);
    agent.setRunStartGuard(guards.runStartGuard);
    let hydrations = 0, dispatches = 0;
    agent._hydrate = async () => { hydrations++; };
    agent._processMessageInner = async () => { dispatches++; return 'Finished'; };
    await agent.assertRunStartAllowed(77, 'scheduled', { scheduledRun: true });
    locks.add(77);
    await assert.rejects(agent.processMessage(77, 'Read this page', () => {}, 'ask', [], { scheduledRun: true }), /recovery is in progress/);
    assert.equal(hydrations, 0);
    assert.equal(dispatches, 0);
    assert.equal(agent.isRunning(77), false);
    assert.deepEqual([...locks], [77]);
  });

  test(`${build}: cloud startup reservation blocks recovery before and during conversation reset`, async () => {
    const enteredGuard = deferred(), releaseGuard = deferred(), enteredClear = deferred(), releaseClear = deferred();
    const enteredProcess = deferred(), releaseProcess = deferred(), locks = new Set();
    const h = cloudFixture(createCloudRunController, {
      clear: async () => { enteredClear.resolve(); await releaseClear.promise; },
      process: async () => { enteredProcess.resolve(); await releaseProcess.promise; return 'Finished'; },
    });
    const cloudGuard = h.controller.guardRunStart;
    h.controller.guardRunStart = async (...args) => {
      enteredGuard.resolve(); await releaseGuard.promise; return cloudGuard(...args);
    };
    const guards = backgroundGuards(source, h.agent, { isRunning: () => false }, locks, h.controller);
    h.agent.assertRunStartAllowed = (tabId, kind, runOptions) => guards.runStartGuard(tabId, { kind, runOptions });
    const starting = h.controller.startRun({ runId: 'cloud-startup', task: 'Read this page', mode: 'ask',
      conversationKey: '10000000-0000-4000-8000-000000000001' });
    try {
      await enteredGuard.promise;
      assert.equal(h.agent.isRunning(77), false);
      assert.equal(h.controller.isRunning(77), true, 'Cloud owns setup before Agent claims the run');
      assert.equal(h.counts.clears, 0);
      assert.throws(() => guards.assertNoActiveTabRun(77), /already active/);
      releaseGuard.resolve();
      await enteredClear.promise;
      assert.equal(h.agent.isRunning(77), false);
      assert.equal(h.counts.dispatches, 0);
      assert.throws(() => guards.assertNoActiveTabRun(77), /already active/);
      releaseClear.resolve();
      await enteredProcess.promise;
      assert.equal((await starting).runId, 'cloud-startup');
      assert.throws(() => guards.assertNoActiveTabRun(77), /already active/);
    } finally {
      releaseGuard.resolve(); releaseClear.resolve(); releaseProcess.resolve();
      await starting;
      await waitForCloudIdle(h.controller);
    }
    assert.equal(h.counts.clears, 1);
    assert.equal(h.counts.dispatches, 1);
    assert.doesNotThrow(() => guards.assertNoActiveTabRun(77));
  });

  test(`${build}: history recovery rejects cloud startup before conversation reset and releases the reservation`, async () => {
    const locks = new Set([77]);
    const h = cloudFixture(createCloudRunController);
    const guards = backgroundGuards(source, h.agent, { isRunning: () => false }, locks, h.controller);
    h.agent.assertRunStartAllowed = (tabId, kind, runOptions) => guards.runStartGuard(tabId, { kind, runOptions });
    const request = { runId: 'cloud-retry', task: 'Read this page', mode: 'ask',
      conversationKey: '20000000-0000-4000-8000-000000000002' };
    await assert.rejects(h.controller.startRun(request), /recovery is in progress/);
    assert.equal(h.controller.isRunning(77), false);
    assert.equal(h.controller.runs.size, 0);
    assert.deepEqual(h.counts, { clears: 0, dispatches: 0 });
    assert.deepEqual([...locks], [77]);
    locks.delete(77);
    assert.equal((await h.controller.startRun(request)).runId, 'cloud-retry');
    await waitForCloudIdle(h.controller);
    assert.deepEqual(h.counts, { clears: 1, dispatches: 1 });
    assert.doesNotThrow(() => guards.assertNoActiveTabRun(77));
  });
}
