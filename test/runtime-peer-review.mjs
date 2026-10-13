import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

for (const browser of ['chrome', 'firefox']) {
  const { createCloudRunController } = await import(`../src/${browser}/src/cloud-runs.js`);
  const scheduler = await import(`../src/${browser}/src/agent/scheduler.js`);

  for (const target of ['conversation', 'fallback', 'existing']) {
    for (const failure of ['missing-task', 'startup-guard', 'storage']) {
      test(`${browser}: rejected ${failure} Cloud startup cleans only its new ${target} tab`, async () => {
        const stored = {}, tabs = new Map();
        if (target === 'existing') tabs.set(7, { id: 7, url: 'https://example.test/' });
        let nextTabId = 100, dispatches = 0, writes = 0;
        const controller = createCloudRunController({
          chromeApi: {
            storage: { session: {
              get: async key => ({ [key]: stored[key] }),
              set: async rows => {
                if (failure === 'storage' && writes++ === 0) throw new Error('Storage unavailable');
                Object.assign(stored, rows);
              },
            } },
            tabs: {
              get: async id => tabs.get(id), query: async () => [...tabs.values()],
              update: async id => tabs.get(id),
              create: async ({ url }) => { const tab = { id: nextTabId++, url }; tabs.set(tab.id, tab); return tab; },
              remove: async id => tabs.delete(id),
            },
          },
          agent: {
            isRunning: () => false, abort() {}, clearConversation: async () => {},
            assertRunStartAllowed: async () => { if (failure === 'startup-guard') throw new Error('Startup blocked'); },
            processMessage: async () => { dispatches++; return 'Finished'; },
          },
          ensureOffscreen: async () => {},
          makeRunId: () => 'rejected-start',
        });
        await assert.rejects(controller.startRun({
          ...(target === 'conversation' ? { conversationKey: '12345678-1234-1234-1234-123456789012' } : {}),
          ...(failure === 'missing-task' ? {} : { task: 'Read this page' }),
        }));
        assert.equal(dispatches, 0);
        assert.deepEqual([...tabs.keys()], target === 'existing' ? [7] : [],
          'Only the tab created for the rejected start should be removed; borrowed user tabs must remain.');
        assert.equal(controller.runs.size, 0);
      });
    }
  }

  test(`${browser}: rejected helper creation preserves a concurrent accepted tab owner`, async () => {
    const created = deferred(), releaseCreation = deferred(), releaseWork = deferred();
    const stored = {}, tabs = new Map();
    let sequence = 0;
    const controller = createCloudRunController({
      chromeApi: {
        storage: { session: {
          get: async key => ({ [key]: stored[key] }), set: async rows => Object.assign(stored, rows),
        } },
        tabs: {
          get: async id => tabs.get(id), query: async () => [...tabs.values()], update: async id => tabs.get(id),
          create: async ({ url }) => {
            const tab = { id: 100, url }; tabs.set(100, tab); created.resolve();
            await releaseCreation.promise; return tab;
          },
          remove: async id => tabs.delete(id),
        },
      },
      agent: {
        isRunning: () => false, abort() {},
        processMessage: async () => { await releaseWork.promise; return 'Finished'; },
      },
      ensureOffscreen: async () => {}, makeRunId: () => `accepted-owner-${++sequence}`,
    });
    const creator = controller.startRun({ task: 'Creator task' });
    await created.promise;
    const adopted = await controller.startRun({ tabId: 100, task: 'Concurrent accepted task' });
    releaseCreation.resolve();
    try {
      await assert.rejects(creator, /busy/);
      assert.deepEqual([...tabs.keys()], [100], 'Startup cleanup must not close a tab a concurrent run already owns.');
      assert.equal((await controller.status({ runId: adopted.runId })).status, 'running');
    } finally { releaseWork.resolve(); }
  });

  test(`${browser}: rejected startup reserves its discarded helper while tab removal is pending`, async () => {
    const removing = deferred(), releaseRemoval = deferred();
    const stored = {}, tabs = new Map();
    let guardCalls = 0, dispatches = 0;
    const controller = createCloudRunController({
      chromeApi: {
        storage: { session: {
          get: async key => ({ [key]: stored[key] }), set: async rows => Object.assign(stored, rows),
        } },
        tabs: {
          get: async id => tabs.get(id), query: async () => [...tabs.values()], update: async id => tabs.get(id),
          create: async ({ url }) => { const tab = { id: 100, url }; tabs.set(100, tab); return tab; },
          remove: async id => { removing.resolve(); await releaseRemoval.promise; tabs.delete(id); },
        },
      },
      agent: {
        isRunning: () => false, abort() {},
        assertRunStartAllowed: async () => { if (++guardCalls === 1) throw new Error('Startup blocked'); },
        processMessage: async () => { dispatches++; return 'Finished'; },
      },
      ensureOffscreen: async () => {}, makeRunId: () => `discard-owner-${guardCalls}`,
    });
    const rejection = assert.rejects(controller.startRun({ task: 'Rejected task' }), /Startup blocked/);
    await removing.promise;
    try {
      await assert.rejects(controller.startRun({ tabId: 100, task: 'Must wait for removal' }), /busy/);
      assert.equal(dispatches, 0, 'A run must not dispatch into a tab already being discarded.');
    } finally { releaseRemoval.resolve(); }
    await rejection;
    assert.deepEqual([...tabs.keys()], []);
  });

  test(`${browser}: a video-flushing cloud run retains its tab until cancellation settles`, async () => {
    const flushing = deferred(), releaseFlush = deferred();
    const tasks = [], abortedTabs = [];
    const stored = {};
    let sequence = 0;
    const tab = { id: 7, url: 'https://example.test/' };
    const controller = createCloudRunController({
      chromeApi: {
        storage: { session: {
          get: async key => ({ [key]: stored[key] }),
          set: async rows => Object.assign(stored, rows),
        } },
        tabs: { get: async () => tab, query: async () => [tab], update: async () => tab },
      },
      agent: {
        isRunning: () => false,
        abort: tabId => abortedTabs.push(tabId),
        processMessage: async (_tabId, task) => { tasks.push(task); return 'Finished'; },
      },
      ensureOffscreen: async () => {},
      makeRunId: () => `video-owner-${++sequence}`,
      startRecording: async () => ({ ok: true, state: { recordingId: 'video-1' } }),
      stopRecording: async () => { flushing.resolve(); await releaseFlush.promise; return { ok: true }; },
    });
    const first = await controller.startRun({ tabId: 7, task: 'First task', capture: 'video' });
    await flushing.promise;
    try {
      assert.equal((await controller.status({ runId: first.runId })).status, 'running');
      await assert.rejects(controller.startRun({ tabId: 7, task: 'Second task' }), error => {
        assert.equal(error.status, 409);
        assert.match(error.message, /busy/);
        return true;
      }, 'A nonterminal recording owner must prevent a second tab run from being aborted by its cloud_abort.');
      assert.deepEqual(tasks, ['First task']);
      await controller.abort({ runId: first.runId });
      assert.deepEqual(abortedTabs, [7]);
    } finally {
      releaseFlush.resolve();
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await controller.status({ runId: first.runId })).completedAt) break;
      await tick();
    }
    const settled = await controller.status({ runId: first.runId });
    assert.equal(settled.status, 'aborted');
    assert.ok(settled.completedAt);
    const second = await controller.startRun({ tabId: 7, task: 'Second task' });
    assert.equal(second.status, 'running');
    assert.deepEqual(tasks, ['First task', 'Second task']);
  });

  for (const kind of ['watch', 'task']) {
    for (const action of ['pause', 'cancel']) {
      test(`${browser}: ${action} during ${kind} helper reference persistence discards the unused helper`, async () => {
        const persisting = deferred(), releasePersist = deferred();
        let actions = 0, blocked = false;
        const h = makeSchedulerHarness(scheduler, { processMessage: async () => { actions++; return 'Finished'; } });
        const store = h.manager.api.storage.local;
        const save = store.set.bind(store);
        store.set = async values => {
          const jobs = values[scheduler.SCHEDULED_JOBS_KEY];
          if (!blocked && jobs?.some(job => job.target?.tabId === 100 && job.status === 'pending')) {
            blocked = true;
            persisting.resolve();
            await releasePersist.promise;
          }
          return save(values);
        };
        const started = kind === 'watch'
          ? await h.manager.createWatchJob({ args: { prompt: 'Watch for a page change' }, currentUrl: 'https://example.com/' })
          : await h.manager.createTaskJob({ args: {
            title: 'Read later', prompt: 'Read this page', schedule: { after_seconds: 60 },
            target: { type: 'url', url: 'https://example.com/' },
          } });
        const running = h.manager.handleAlarm(h.alarmName(started.jobId));
        await persisting.promise;
        const stopped = action === 'pause' ? h.manager.pauseJob(started.jobId) : h.manager.cancelJob(started.jobId);
        releasePersist.resolve();
        await Promise.all([running, stopped]);
        assert.equal(actions, 0);
        assert.equal(h.jobs()[0].status, action === 'pause' ? 'paused' : 'cancelled');
        assert.deepEqual([...h.tabs.keys()], [77], 'A helper created only for canceled startup must not remain open.');
        assert.equal(h.jobs()[0].tabId, null, 'The saved helper reference must not point to a closed startup tab.');
        assert.equal(h.jobs()[0].target.tabId, null);
      });
    }
  }
}
