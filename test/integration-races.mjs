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
  const chat = await import(`../src/${browser}/src/agent/chat-workflow.js`);
  const scheduler = await import(`../src/${browser}/src/agent/scheduler.js`);

  function cloudHarness(processMessage, options = {}) {
    const stored = {};
    const tabs = new Map([[7, { id: 7, url: 'https://example.com/' }], [8, { id: 8, url: 'https://example.org/' }]]);
    let sequence = 0;
    const api = {
      storage: { session: {
        get: async key => ({ [key]: stored[key] }),
        set: async rows => Object.assign(stored, rows),
      } },
      tabs: {
        get: async id => tabs.get(id),
        query: async () => [...tabs.values()],
        update: async id => tabs.get(id),
      },
    };
    const agent = { isRunning: () => false, abort() {}, processMessage };
    const controller = createCloudRunController({
      chromeApi: api, agent, ensureOffscreen: async () => {},
      makeRunId: () => `run_${++sequence}`, ...options,
    });
    return { controller, agent, stored };
  }

  async function finish(controller, run) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = await controller.status({ runId: run.runId });
      if (['completed', 'failed', 'aborted'].includes(row.status)) return row;
      await tick();
    }
    assert.fail('Cloud run did not settle after its test gates were released.');
  }

  test(`${browser}: concurrent caller run IDs have one owner across distinct tabs`, async () => {
    const setup = deferred(), work = deferred();
    const dispatched = [];
    const { controller, agent, stored } = cloudHarness(async (tabId) => {
      dispatched.push(tabId);
      await work.promise;
      return 'Finished';
    });
    agent.assertRunStartAllowed = () => setup.promise;
    const requests = [
      controller.startRun({ runId: 'same-id', tabId: 7, task: 'First' }),
      controller.startRun({ run_id: 'same-id', tabId: 8, task: 'Second' }),
    ];
    // Attach rejection handlers before either request is allowed to settle.
    const settled = Promise.allSettled(requests);
    await tick();
    setup.resolve();
    const results = await settled;
    try {
      assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
      const rejected = results.find(row => row.status === 'rejected');
      assert.equal(rejected?.reason?.status, 409);
      assert.match(rejected.reason.message, /already exists|starting/);
      assert.equal(dispatched.length, 1, 'A duplicate run must never reach the agent.');
      assert.equal(controller.runs.size, 1);
      assert.equal(stored.webbrainCloudRunSnapshots.length, 1);
    } finally {
      work.resolve();
    }
    await finish(controller, results.find(row => row.status === 'fulfilled').value);
  });

  test(`${browser}: a failed run start releases its caller ID reservation`, async () => {
    const { controller, agent } = cloudHarness(async () => 'Finished');
    let attempts = 0;
    agent.assertRunStartAllowed = async () => {
      if (++attempts === 1) throw new Error('Temporary startup guard failure');
    };
    await assert.rejects(controller.startRun({ runId: 'retry-id', tabId: 7, task: 'First' }), /startup guard/);
    const started = await controller.startRun({ runId: 'retry-id', tabId: 7, task: 'Retry' });
    assert.equal((await finish(controller, started)).status, 'completed');
  });

  test(`${browser}: cancellation during video initialization never dispatches browser work`, async () => {
    const capture = deferred(), entered = deferred();
    let dispatched = 0, stopped = 0;
    const { controller } = cloudHarness(async () => { dispatched++; return 'Finished'; }, {
      startRecording: async () => {
        entered.resolve();
        await capture.promise;
        return { ok: true, state: { recordingId: 'recording-1' } };
      },
      stopRecording: async () => { stopped++; return { ok: true }; },
    });
    const started = await controller.startRun({ tabId: 7, task: 'Work', capture: 'video' });
    await entered.promise;
    await controller.abort({ runId: started.runId });
    capture.resolve();
    assert.equal((await finish(controller, started)).status, 'aborted');
    assert.equal(dispatched, 0, 'Abort during setup must survive agent startup resetting old abort flags.');
    assert.equal(stopped, 1, 'An initialized recording still needs to be flushed.');
  });

  test(`${browser}: cancellation survives late clarification and terminal updates`, async () => {
    const work = deferred(), entered = deferred();
    let publish;
    const { controller } = cloudHarness(async (_tab, _task, update) => {
      publish = update;
      entered.resolve();
      await work.promise;
      update('tool_result', { name: 'done', result: { outcome: 'success' } });
      return 'Late completion';
    });
    const started = await controller.startRun({ tabId: 7, task: 'Work' });
    await entered.promise;
    await controller.abort({ runId: started.runId });
    try {
      publish('clarify', { clarifyId: 'late-question', question: 'Still continue?' });
      const row = await controller.status({ runId: started.runId });
      assert.equal(row.status, 'aborting');
      assert.equal(row.pendingInput, null);
    } finally {
      work.resolve();
    }
    assert.equal((await finish(controller, started)).status, 'aborted');
  });

  test(`${browser}: cancellation while video flushes remains canceled after the recording settles`, async () => {
    const flush = deferred(), entered = deferred();
    const { controller } = cloudHarness(async () => 'Browser work completed', {
      startRecording: async () => ({ ok: true, state: { recordingId: 'recording-2' } }),
      stopRecording: async () => { entered.resolve(); await flush.promise; return { ok: true }; },
    });
    const started = await controller.startRun({ tabId: 7, task: 'Work', capture: 'video' });
    await entered.promise;
    await controller.abort({ runId: started.runId });
    flush.resolve();
    assert.equal((await finish(controller, started)).status, 'aborted');
  });

  test(`${browser}: Cloud dispatch carries cancellation through asynchronous agent startup`, async () => {
    const setup = deferred(), entered = deferred();
    let options, actions = 0;
    const { controller } = cloudHarness(async (_tab, _task, _update, _mode, _attachments, runOptions) => {
      options = runOptions;
      entered.resolve();
      await setup.promise;
      if (!runOptions.signal?.aborted && !runOptions.isDetachedStartCancelled?.()) actions++;
      return 'Finished';
    });
    const started = await controller.startRun({ tabId: 7, task: 'Work' });
    await entered.promise;
    await controller.abort({ runId: started.runId });
    try {
      assert.equal(options.signal?.aborted, true);
      assert.equal(options.isDetachedStartCancelled?.(), true);
    } finally {
      setup.resolve();
    }
    assert.equal((await finish(controller, started)).status, 'aborted');
    assert.equal(actions, 0);
  });

  test(`${browser}: canceled workflow replay never starts its model fallback`, async () => {
    const replay = deferred(), entered = deferred();
    let replayOptions, modelCalls = 0;
    const { controller, agent } = cloudHarness(async () => { modelCalls++; return 'Fallback'; });
    agent.replaySavedWorkflow = async (_tab, _workflow, _parameters, _update, options) => {
      replayOptions = options;
      entered.resolve();
      await replay.promise;
      return { status: 'fallback', prompt: 'Recover the workflow', summary: 'Needs recovery' };
    };
    const started = await controller.startRun({ tabId: 7, _workflow: { id: 'workflow-test', name: 'Demo' } });
    await entered.promise;
    await controller.abort({ runId: started.runId });
    replay.resolve();
    assert.equal((await finish(controller, started)).status, 'aborted');
    assert.equal(replayOptions.signal?.aborted, true);
    assert.equal(modelCalls, 0);
  });

  test(`${browser}: incoming chat messages survive a persisted user-input pause`, () => {
    for (const state of ['waiting_for_transfer', 'agent_connected', 'we_responded']) {
      const base = { threadId: 'case-1', composer: { available: true, empty: true }, messages: [] };
      let session = { ...chat.createChatSession({ threadKey: 'case-1' }), state };
      const paused = { ...base, userInput: { required: true, reason: 'otp' } };
      session = chat.advanceChatSession(session, paused).session;
      const question = { id: 'question-1', direction: 'incoming', text: 'Would you like a refund?' };
      const observed = chat.advanceChatSession(session, { ...paused, messages: [question] });
      assert.equal(observed.nextAction, 'pause_for_user');
      // A worker restart must preserve the unhandled question as well.
      session = chat.serializeChatSession(observed.session);
      const resumed = chat.advanceChatSession(session, { ...base, messages: [question] });
      assert.equal(resumed.nextAction, 'reply', state);
      assert.deepEqual(resumed.newMessages.map(message => message.id), ['question-1'], state);
      const repeated = chat.advanceChatSession(resumed.session, resumed.snapshot);
      assert.equal(repeated.newMessages.length, 0, 'The resumed question must be consumed exactly once.');
    }
  });

  test(`${browser}: paused chat preserves delivery evidence without consuming the new incoming question`, () => {
    const first = chat.advanceChatSession(chat.createChatSession(), {
      threadId: 'case-2', composer: { available: true, empty: true },
      messages: [{ id: 'old-question', direction: 'incoming', text: 'Can I help?' }],
    });
    const decision = chat.decideChatSend(first.session, first.snapshot, 'Yes, please.');
    const pending = chat.markChatSendPending(first.session, decision);
    const transcript = [
      ...first.snapshot.messages,
      { id: 'our-reply', direction: 'outgoing', text: decision.text },
      { id: 'new-question', direction: 'incoming', text: 'Would you like a refund?' },
    ];
    const paused = chat.advanceChatSession(pending, {
      threadId: 'case-2', composer: { available: true, empty: true }, messages: transcript,
      userInput: { required: true, reason: 'new_user_decision' },
    });
    assert.equal(paused.session.pendingOutbound, null);
    const resumed = chat.advanceChatSession(chat.serializeChatSession(paused.session), {
      threadId: 'case-2', composer: { available: true, empty: true }, messages: transcript,
    });
    assert.equal(resumed.nextAction, 'reply');
    assert.deepEqual(resumed.newMessages.map(message => message.id), ['new-question']);
  });

  for (const kind of ['watch', 'task']) {
    for (const action of ['cancel', 'pause']) {
      test(`${browser}: ${action} during ${kind} helper-tab creation closes the unclaimed tab`, async () => {
        const creation = deferred(), entered = deferred();
        let dispatches = 0;
        const h = makeSchedulerHarness(scheduler, { processMessage: async () => { dispatches++; return 'Finished'; } });
        const createTab = h.manager.api.tabs.create;
        h.manager.api.tabs.create = async args => {
          entered.resolve();
          await creation.promise;
          return createTab(args);
        };
        const started = kind === 'watch'
          ? await h.manager.createWatchJob({ args: { prompt: 'When the page changes, notify me' }, currentUrl: 'https://example.com/' })
          : await h.manager.createTaskJob({ args: {
            title: 'Read later', prompt: 'Read this page', schedule: { after_seconds: 60 },
            target: { type: 'url', url: 'https://example.com/' },
          } });
        const run = h.manager.handleAlarm(h.alarmName(started.jobId));
        await entered.promise;
        if (action === 'cancel') await h.manager.cancelJob(started.jobId);
        else await h.manager.pauseJob(started.jobId);
        creation.resolve();
        await run;
        assert.equal(dispatches, 0);
        assert.equal(h.jobs()[0].status, action === 'cancel' ? 'cancelled' : 'paused');
        assert.deepEqual([...h.tabs.keys()], [77], 'Canceled startup leaked its newly created hidden tab.');
        assert.equal(h.jobs()[0].tabId, null);
      });
    }
  }
}
