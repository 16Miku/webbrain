import test from 'node:test';
import assert from 'node:assert/strict';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await tick(); } assert.fail('Condition did not settle'); }

const storage = new Map();
const area = { get: async key => ({ [key]: storage.get(key) }), set: async value => { for (const [key, item] of Object.entries(value)) storage.set(key, structuredClone(item)); }, remove: async key => storage.delete(key) };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/', title: 'Example' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};

for (const browser of ['chrome', 'firefox']) {
  const { CloudHandoffGate } = await import(`../src/${browser}/src/agent/cloud-handoff.js`);
  const { createCloudRunController, buildCloudPersistenceRows } = await import(`../src/${browser}/src/cloud-runs.js`);
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);

  function harness(processMessage, options = {}) {
    const stored = {};
    const local = {};
    const api = { storage: { local: { get: async key => ({ [key]: structuredClone(local[key]) }), set: async data => Object.assign(local, structuredClone(data)) }, session: { get: async key => ({ [key]: structuredClone(stored[key]) }), set: async data => Object.assign(stored, structuredClone(data)) } },
      tabs: { get: async id => ({ id, url: 'https://example.com/' }), query: async () => [{ id: 7, url: 'https://example.com/' }], update: async () => {} } };
    let clarificationResolve;
    const agent = { isRunning: () => false, hasOtherRunningTabs: () => false, canPauseAtClarification: () => true,
      strictSecretMode: true, processMessage, abort() {}, _persistNow: async () => ({ ok: true }),
      submitClarifyResponse(_tab, _id, answer) { clarificationResolve?.(answer); return true; } };
    let seq = 0;
    const controller = createCloudRunController({ chromeApi: api, agent, makeRunId: () => `run_handoff_${++seq}`, ensureOffscreen: async () => {}, ...options });
    return { controller, stored, local, agent, api, setClarificationResolver(value) { clarificationResolve = value; } };
  }

  test(`${browser}: pausing acknowledges only a settled boundary and keeps its tab reservation`, async () => {
    const tool = deferred(); let actions = 0, observations = 0, returnedNote;
    const h = harness(async (_tab, _task, update, _mode, _attachments, options) => {
      actions++;
      await tool.promise;
      const handoff = await options.handoffBoundary();
      returnedNote = handoff.note;
      observations++;
      await options.handoffObserved();
      options.onRunFinished('done');
      return 'Checked the page';
    });
    const run = await h.controller.startRun({ task: 'Check the page' });
    const pausing = await h.controller.pause({ runId: run.runId });
    assert.equal(pausing.status, 'pausing');
    assert.equal(pausing.handoff.state, 'pausing');
    assert.equal(observations, 0);
    await assert.rejects(h.controller.resume({ runId: run.runId }), error => error.status === 409);
    await assert.rejects(h.controller.startRun({ task: 'Another bot' }), error => error.status === 409);
    tool.resolve();
    await until(() => h.controller.runs.get(run.runId).status === 'paused');
    assert.equal(h.stored.webbrainCloudRunSnapshots[0].status, 'paused');
    assert.equal(actions, 1);
    const returning = await h.controller.resume({ runId: run.runId, note: 'I signed in' });
    assert.equal(returning.status, 'resuming');
    await until(() => h.controller.runs.get(run.runId).status === 'completed');
    assert.equal(observations, 1);
    assert.equal(returnedNote, 'I signed in');
    assert.equal(JSON.stringify(await h.controller.status({ runId: run.runId })).includes('I signed in'), false, 'the note is not put in public updates');
  });

  test(`${browser}: a worker restart preserves manual control and reservation without replay`, async () => {
    const tool = deferred(); let calls = 0;
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => { calls++; await tool.promise; await options.handoffBoundary(); options.onRunFinished('done'); return 'Read'; });
    const run = await h.controller.startRun({ task: 'Read' });
    await h.controller.pause({ runId: run.runId }); tool.resolve();
    await until(() => h.controller.runs.get(run.runId).status === 'paused');
    const restarted = createCloudRunController({ chromeApi: h.api, agent: h.agent, ensureOffscreen: async () => {} });
    const restored = await restarted.status({ runId: run.runId });
    assert.equal(restored.status, 'paused');
    assert.equal(restored.handoff.interrupted, true);
    assert.equal(restored.handoff.resumable, false);
    assert.equal(restored.completedAt, null);
    await assert.rejects(restarted.resume({ runId: run.runId }), error => error.status === 409);
    await assert.rejects(restarted.startRun({ task: 'Another bot' }), error => error.status === 409);
    await assert.rejects(restarted.startRun({ task: 'Another bot in another tab', tabId: 8 }), error => error.status === 409);
    for (const kind of ['scheduled', 'interactive', 'cloud']) await assert.rejects(restarted.guardRunStart(8, { kind }), error => error.status === 409);
    assert.equal(calls, 1, 'neither restart nor Hand back replays the old task');
    assert.equal((await restarted.abort({ runId: run.runId })).status, 'aborted');
    assert.equal(restarted.isRunning(7), false);
    await restarted.guardRunStart(8, { kind: 'scheduled' });
    await h.controller.abort({ runId: run.runId });
  });

  test(`${browser}: manual control preserves a clarification and handback never answers it`, async () => {
    const question = deferred(); let responses = 0, reads = 0;
    const h = harness(async (_tab, _task, update, _mode, _attachments, options) => {
      update('clarify', { clarifyId: 'login', question: 'Have you signed in?', options: ['Yes', 'Stop'], requireExplicitAnswer: true });
      await question.promise;
      const handoff = await options.handoffBoundary();
      assert.equal(handoff.note, 'I signed in'); reads++;
      await options.handoffObserved(); options.onRunFinished('done'); return 'Done';
    });
    h.setClarificationResolver(answer => { responses++; assert.equal(answer, 'Yes'); question.resolve(); });
    const run = await h.controller.startRun({ task: 'Read the account' });
    await until(() => h.controller.runs.get(run.runId).status === 'needs_user_input');
    const paused = await h.controller.pause({ runId: run.runId });
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pendingInput.clarifyId, 'login');
    await assert.rejects(h.controller.respond({ runId: run.runId, clarifyId: 'login', answer: 'Yes' }), error => error.status === 409);
    const returning = await h.controller.resume({ runId: run.runId, note: 'I signed in' });
    assert.equal(returning.status, 'resuming');
    assert.equal(returning.pendingInput.clarifyId, 'login');
    assert.equal(responses, 0); assert.equal(reads, 0);
    await h.controller.respond({ runId: run.runId, clarifyId: 'login', answer: 'Yes' });
    await until(() => h.controller.runs.get(run.runId).status === 'completed');
    assert.equal(responses, 1); assert.equal(reads, 1);
  });

  test(`${browser}: pre-handoff batch actions are discarded, page read is fresh, task authority and mutation receipts stay intact`, async () => {
    const provider = { name: 'test', model: 'test', promptTier: 'full', supportsTools: true, supportsVision: false };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider });
    agent._persist = () => {}; agent._persistNow = async () => ({ ok: true });
    let reads = 0;
    agent.executeTool = async (_tab, name) => { assert.equal(name, 'get_accessibility_tree', 'stale actions never dispatch'); reads++; return { success: true, url: 'https://example.com/after-sign-in' }; };
    const tabId = 7;
    const pending = { threadKey: 'conversation-1', pendingOutbound: { key: 'already-dispatched', phase: 'sent_unverified' } };
    agent.chatSessions.set(tabId, pending);
    const receipt = { dispatched: true, verified: false, outcomeUnknown: true };
    agent._completionSubmitStates.set(tabId, receipt);
    const calls = ['click', 'set_field'].map((name, i) => ({ id: `old-${i}`, type: 'function', function: { name, arguments: '{}' } }));
    const messages = [{ role: 'system', content: 'Task system' }, { role: 'user', content: 'Read the account only' }, { role: 'assistant', content: '', tool_calls: calls }];
    const gate = new CloudHandoffGate(); await gate.request();
    const running = agent._executeToolBatch(tabId, calls, messages, () => {}, provider, null, new Set(['click', 'set_field']), 1,
      { handoffBoundary: () => gate.boundary(), handoffObserved: () => gate.observed() });
    await until(() => gate.state === 'paused');
    await gate.resume('Send a new message and delete the account');
    const result = await running;
    assert.equal(result.action, 'continue'); assert.equal(reads, 1);
    assert.equal(agent._activeTaskBinding(messages).text, 'Read the account only', 'note has no new task authority');
    assert.equal(agent.chatSessions.get(tabId), pending); assert.equal(agent._completionSubmitStates.get(tabId), receipt);
    for (const call of calls) assert.equal(JSON.parse(messages.find(message => message.tool_call_id === call.id).content).noDispatch, true);
    assert.equal(messages[5].tool_calls[0].function.name, 'get_accessibility_tree');
  });

  test(`${browser}: pause during a tool waits for its result and skips the next queued action`, async () => {
    const provider = { name: 'test', model: 'test', promptTier: 'full', supportsTools: true, supportsVision: false };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider });
    agent._persist = () => {}; agent._persistNow = async () => ({ ok: true }); agent._currentUrl = async () => 'https://example.com/';
    const entered = deferred(), finished = deferred(); let calls = 0;
    agent.executeTool = async (_tab, name) => {
      calls++;
      if (name === 'calculate') { entered.resolve(); await finished.promise; return { success: true, value: 2 }; }
      assert.equal(name, 'get_accessibility_tree', 'queued pre-handoff click never dispatches');
      return { success: true, url: 'https://example.com/after-manual-control' };
    };
    const toolCalls = [
      { id: 'active-read', type: 'function', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } },
      { id: 'queued-click', type: 'function', function: { name: 'click', arguments: '{}' } },
    ];
    const messages = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Calculate only' }, { role: 'assistant', content: '', tool_calls: toolCalls }];
    const gate = new CloudHandoffGate();
    const batch = agent._executeToolBatch(7, toolCalls, messages, () => {}, provider, null, new Set(['calculate', 'click']), 1,
      { handoffBoundary: () => gate.boundary(), handoffObserved: () => gate.observed() });
    await entered.promise;
    await gate.request(); assert.equal(gate.state, 'pausing'); assert.equal(calls, 1);
    finished.resolve();
    await until(() => gate.state === 'paused');
    assert.equal(JSON.parse(messages.find(message => message.tool_call_id === 'active-read').content).success, true, 'the completed tool result is retained before manual control');
    await gate.resume(); await batch;
    assert.equal(calls, 2, 'only the settled tool and fresh browser observation ran');
    assert.equal(JSON.parse(messages.find(message => message.tool_call_id === 'queued-click').content).noDispatch, true);
  });

  test(`${browser}: failed handback observation keeps manual control and blocks new work`, async () => {
    const ready = deferred();
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => {
      await ready.promise;
      await options.handoffBoundary();
      throw new Error('Could not inspect the browser after handoff.');
    });
    const run = await h.controller.startRun({ task: 'Read' });
    await h.controller.pause({ runId: run.runId }); ready.resolve();
    await until(() => h.controller.runs.get(run.runId).status === 'paused');
    await h.controller.resume({ runId: run.runId });
    await until(() => h.controller.runs.get(run.runId).handoff?.interrupted === true);
    const interrupted = await h.controller.status({ runId: run.runId });
    assert.equal(interrupted.status, 'paused'); assert.equal(interrupted.handoff.resumable, false); assert.equal(interrupted.completedAt, null);
    assert.equal(h.controller.isRunning(7), true);
    await assert.rejects(h.controller.startRun({ task: 'Queued bot', tabId: 8 }), error => error.status === 409);
    await assert.rejects(h.controller.resume({ runId: run.runId }), error => error.status === 409);
    await h.controller.abort({ runId: run.runId }); assert.equal(h.controller.isRunning(7), false);
  });

  test(`${browser}: pause acknowledgement waits for durable storage and abort wakes the paused agent`, async () => {
    const ready = deferred(), writing = deferred(), written = deferred();
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => { await ready.promise; await options.handoffBoundary(); options.onRunFinished('done'); return 'Stopped'; });
    const write = h.api.storage.session.set;
    h.api.storage.session.set = async data => {
      if (data.webbrainCloudRunSnapshots?.[0]?.status === 'paused') { writing.resolve(); await written.promise; }
      return write(data);
    };
    const run = await h.controller.startRun({ task: 'Read' });
    await h.controller.pause({ runId: run.runId }); ready.resolve(); await writing.promise;
    let exposed = false;
    const status = h.controller.status({ runId: run.runId }).then(value => { exposed = true; return value; });
    let pauseExposed = false;
    const repeatPause = h.controller.pause({ runId: run.runId }).then(value => { pauseExposed = true; return value; });
    await tick(); assert.equal(exposed, false, 'the viewer does not get control until the checkpoint is durable');
    assert.equal(pauseExposed, false, 'repeating Take over also waits for the checkpoint');
    written.resolve(); assert.equal((await status).status, 'paused');
    assert.equal((await repeatPause).status, 'paused');
    await h.controller.abort({ runId: run.runId });
    await until(() => h.controller.runs.get(run.runId).status === 'aborted');
    assert.equal(h.controller.isRunning(7), false);
  });

  test(`${browser}: another Cloud startup prevents handoff until it settles`, async () => {
    const pending = deferred(), entered = deferred(), done = deferred();
    let started = 0;
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => {
      started++; await done.promise; options.onRunFinished('done'); return 'Read';
    });
    const run = await h.controller.startRun({ task: 'Read', tabId: 7 });
    const get = h.api.tabs.get;
    h.api.tabs.get = async id => { if (id === 8) { entered.resolve(); await pending.promise; } return get(id); };
    const second = h.controller.startRun({ task: 'Read in another tab', tabId: 8 });
    await entered.promise;
    try {
      await assert.rejects(h.controller.pause({ runId: run.runId }), error => error.status === 409);
      assert.equal(h.controller.runs.get(run.runId).handoff, undefined);
    } finally { pending.resolve(); await second; done.resolve(); }
    await until(() => [...h.controller.runs.values()].every(value => value.status === 'completed'));
    assert.equal(started, 2);
  });

  test(`${browser}: other active Cloud or native tabs prevent manual control`, async () => {
    const done = deferred();
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => {
      await done.promise; options.onRunFinished('done'); return 'Read';
    });
    const run = await h.controller.startRun({ task: 'Read', tabId: 7 });
    const other = await h.controller.startRun({ task: 'Read', tabId: 8 });
    try {
      await assert.rejects(h.controller.pause({ runId: run.runId }), error => error.status === 409);
      h.controller.runs.get(other.runId).status = 'completed';
      h.agent.hasOtherRunningTabs = id => id === 7;
      await assert.rejects(h.controller.pause({ runId: run.runId }), error => error.status === 409);
      assert.equal(h.controller.runs.get(run.runId).handoff, undefined);
    } finally { done.resolve(); }
    await until(() => h.controller.runs.get(run.runId).status === 'completed');
  });

  test(`${browser}: startup guards hydrate interrupted handoffs before permitting any agent`, async () => {
    const h = harness(async () => assert.fail('No new run should start'));
    h.stored.webbrainCloudRunSnapshots = [{ runId: 'old', tabId: 7, status: 'paused', createdAt: '2020-01-01',
      handoff: { state: 'paused', resumable: true, interrupted: false } }];
    for (const kind of ['cloud', 'scheduled', 'interactive']) {
      await assert.rejects(h.controller.guardRunStart(8, { kind }), error => error.status === 409);
    }
    assert.equal(h.controller.isRunning(7), true);
    await h.controller.abort({ runId: 'old' });
    await h.controller.guardRunStart(8, { kind: 'interactive' });
  });

  test(`${browser}: unavailable persisted state cannot silently authorize a new agent`, async () => {
    const h = harness(async () => assert.fail('No run should start'));
    h.api.storage.session.get = async () => { throw new Error('Session storage unavailable'); };
    await assert.rejects(h.controller.guardRunStart(8, { kind: 'interactive' }), /Session storage unavailable/);
    await assert.rejects(h.controller.startRun({ task: 'Read' }), /Session storage unavailable/);
    assert.equal(h.controller.runs.size, 0);
  });

  test(`${browser}: history limits cannot evict an old active handoff`, () => {
    const handoff = { runId: 'old-paused', tabId: 7, status: 'paused', createdAt: '2000-01-01',
      handoff: { state: 'paused', resumable: true, interrupted: false } };
    const history = Array.from({ length: 60 }, (_, index) => ({ runId: `history-${index}`, status: 'completed',
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z` }));
    const rows = buildCloudPersistenceRows([...history, handoff]);
    assert.equal(rows.length, 50);
    assert.equal(rows[0].runId, 'old-paused');
    assert.equal(rows[0].handoff.state, 'paused');
  });

  test(`${browser}: internal permission waits cannot acknowledge an unsettled action`, async () => {
    const answer = deferred(); let posted = false;
    const h = harness(async (_tab, _task, update, _mode, _attachments, options) => {
      update('clarify', { clarifyId: 'submit-form', promptKind: 'submitConfirmation', question: 'Submit?', options: ['once', 'deny'] });
      await answer.promise; posted = true; options.onRunFinished('done'); return 'Submitted';
    });
    h.agent.canPauseAtClarification = () => false;
    h.setClarificationResolver(() => answer.resolve());
    const run = await h.controller.startRun({ task: 'Submit the form' });
    await until(() => h.controller.runs.get(run.runId).status === 'needs_user_input');
    await assert.rejects(h.controller.pause({ runId: run.runId }), error => error.status === 409);
    assert.equal(h.controller.runs.get(run.runId).handoff, undefined);
    assert.equal(posted, false);
    await h.controller.respond({ runId: run.runId, clarifyId: 'submit-form', answer: 'once' });
    await until(() => h.controller.runs.get(run.runId).status === 'completed');
    assert.equal(posted, true);
  });

  test(`${browser}: native standalone clarification is safe but native form approval is not`, async () => {
    const provider = { name: 'test', model: 'test' };
    const agent = new Agent({ getActive: () => provider });
    agent.clarifyTimeoutSec = -1;
    const ready = deferred(); let question, approval;
    const standalone = agent._executeToolImpl(7, 'clarify', { question: 'Have you signed in?', options: ['Yes', 'Stop'] },
      (type, data) => { if (type === 'clarify') { question = data; ready.resolve(); } });
    const form = agent._promptSubmitConfirmation(7, { host: 'example.com', summary: 'Submit this form' },
      (type, data) => { if (type === 'clarify') approval = data; });
    try {
      await ready.promise;
      assert.equal(agent.canPauseAtClarification(7, question.clarifyId), true);
      assert.equal(agent.canPauseAtClarification(7, approval.clarifyId), false);
    } finally { agent._cancelClarifications(7, 'Fixture cleanup'); await Promise.all([standalone, form]); }
    assert.equal(agent.canPauseAtClarification(7, question.clarifyId), false);
    agent._runningTabs.add(8);
    assert.equal(agent.hasOtherRunningTabs(7), true);
    assert.equal(agent.hasOtherRunningTabs(8), false);
  });
  for (const restart of ['extension reload', 'browser startup without session storage']) {
    test(`${browser}: ${restart} restores only a durable manual guard and never replays`, async () => {
      const ready = deferred(); let calls = 0;
      const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => { calls++; await ready.promise; await options.handoffBoundary(); options.onRunFinished('done'); return 'Read'; });
      const run = await h.controller.startRun({ task: 'Private task with secret-provider-token' });
      await h.controller.pause({ runId: run.runId }); ready.resolve();
      await until(() => h.controller.runs.get(run.runId).status === 'paused');
      await h.controller.status({ runId: run.runId });
      const guard = h.local.webbrainCloudHandoffGuards[0];
      assert.deepEqual(Object.keys(guard).sort(), ['createdAt', 'pausedAt', 'runId', 'tabId', 'updatedAt']);
      assert.equal(JSON.stringify(h.local).includes('secret-provider-token'), false);
      delete h.stored.webbrainCloudRunSnapshots;
      if (restart.includes('without')) delete h.api.storage.session;
      const restarted = createCloudRunController({ chromeApi: h.api, agent: h.agent, ensureOffscreen: async () => {} });
      const restored = await restarted.status({ runId: run.runId });
      assert.equal(restored.status, 'paused'); assert.equal(restored.handoff.interrupted, true); assert.equal(restored.handoff.resumable, false);
      assert.equal(restored.task, undefined); assert.equal(restored.result, undefined); assert.equal(calls, 1);
      await assert.rejects(restarted.resume({ runId: run.runId }), error => error.status === 409);
      await assert.rejects(restarted.startRun({ task: 'Other bot', tabId: 8 }), error => error.status === 409);
      await assert.rejects(restarted.guardRunStart(8, { kind: 'scheduled' }), error => error.status === 409);
      assert.equal((await restarted.abort({ runId: run.runId })).status, 'aborted');
      assert.deepEqual(h.local.webbrainCloudHandoffGuards, []);
      await restarted.guardRunStart(8, { kind: 'interactive' });
      await h.controller.abort({ runId: run.runId });
    });
  }

  test(`${browser}: a durable guard overrides a matching stale terminal snapshot`, async () => {
    const ready = deferred();
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => { await ready.promise; await options.handoffBoundary(); options.onRunFinished('done'); return 'Read'; });
    const run = await h.controller.startRun({ task: 'Read' });
    await h.controller.pause({ runId: run.runId }); ready.resolve();
    await until(() => h.controller.runs.get(run.runId).status === 'paused'); await h.controller.status({ runId: run.runId });
    h.stored.webbrainCloudRunSnapshots[0].status = 'aborted'; h.stored.webbrainCloudRunSnapshots[0].handoff = null;
    const restarted = createCloudRunController({ chromeApi: h.api, agent: h.agent, ensureOffscreen: async () => {} });
    const restored = await restarted.status({ runId: run.runId });
    assert.equal(restored.status, 'paused'); assert.equal(restored.handoff.interrupted, true);
    await restarted.abort({ runId: run.runId }); assert.deepEqual(h.local.webbrainCloudHandoffGuards, []);
    await h.controller.abort({ runId: run.runId });
  });

  test(`${browser}: durable local acknowledgement blocks publication and direct resume while writing`, async () => {
    const ready = deferred(), writing = deferred(), written = deferred();
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => { await ready.promise; await options.handoffBoundary(); options.onRunFinished('done'); return 'Read'; });
    const write = h.api.storage.local.set;
    h.api.storage.local.set = async data => { if (data.webbrainCloudHandoffGuards?.[0]?.pausedAt) { writing.resolve(); await written.promise; } return write(data); };
    const run = await h.controller.startRun({ task: 'Read' });
    await h.controller.pause({ runId: run.runId }); ready.resolve(); await writing.promise;
    assert.equal(h.controller.runs.get(run.runId).status, 'pausing');
    let exposed = false, resumed = false;
    const status = h.controller.status({ runId: run.runId }).then(value => { exposed = true; return value; });
    const returning = h.controller.resume({ runId: run.runId }).then(() => { resumed = true; }, error => { assert.equal(error.status, 409); });
    await tick(); assert.equal(exposed, false); assert.equal(resumed, false);
    written.resolve(); await status; await returning;
    await h.controller.abort({ runId: run.runId });
  });

  test(`${browser}: failed guard writes retain read-only ownership and abort waits for native quiescence`, async () => {
    const ready = deferred(), finished = deferred();
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => { await ready.promise; await options.handoffBoundary(); await finished.promise; options.onRunFinished('done'); return 'Read'; });
    const run = await h.controller.startRun({ task: 'Read' });
    const write = h.api.storage.local.set;
    h.api.storage.local.set = async () => { throw Error('Fixture guard write failure'); };
    await assert.rejects(h.controller.pause({ runId: run.runId }), /guard write failure/);
    assert.equal(h.controller.runs.get(run.runId).handoff.resumable, false);
    await assert.rejects(h.controller.guardRunStart(8, { kind: 'scheduled' }), error => error.status === 409);
    h.api.storage.local.set = write;
    const aborting = await h.controller.abort({ runId: run.runId }); assert.equal(aborting.status, 'aborting');
    assert.equal(h.local.webbrainCloudHandoffGuards.length, 1, 'a cancellation request must retain the durable guard');
    ready.resolve(); await tick(); assert.equal(h.local.webbrainCloudHandoffGuards.length, 1);
    finished.resolve(); await until(() => h.controller.runs.get(run.runId).status === 'aborted');
    await h.controller.status({ runId: run.runId }); assert.deepEqual(h.local.webbrainCloudHandoffGuards, []);
  });

  test(`${browser}: guard removal failures preserve the lock until explicit cancellation retries`, async () => {
    const ready = deferred();
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => { await ready.promise; await options.handoffBoundary(); options.onRunFinished('done'); return 'Read'; });
    const run = await h.controller.startRun({ task: 'Read' });
    await h.controller.pause({ runId: run.runId }); ready.resolve(); await until(() => h.controller.runs.get(run.runId).status === 'paused'); await h.controller.status({ runId: run.runId });
    const restarted = createCloudRunController({ chromeApi: h.api, agent: h.agent, ensureOffscreen: async () => {} });
    await restarted.status({ runId: run.runId });
    const write = h.api.storage.local.set;
    h.api.storage.local.set = async data => { if (!data.webbrainCloudHandoffGuards.length) throw Error('Fixture clear failure'); return write(data); };
    await assert.rejects(restarted.abort({ runId: run.runId }), /clear failure/);
    assert.equal(restarted.runs.get(run.runId).status, 'paused');
    assert.equal(restarted.runs.get(run.runId).handoff.interrupted, true);
    assert.equal(restarted.runs.get(run.runId).updates.at(-1).data.state, 'paused', 'failed cancellation cannot publish a null handoff');
    assert.equal(restarted.isRunning(7), true);
    await assert.rejects(restarted.guardRunStart(8, { kind: 'interactive' }), error => error.status === 409);
    h.api.storage.local.set = write;
    assert.equal((await restarted.abort({ runId: run.runId })).status, 'aborted'); assert.deepEqual(h.local.webbrainCloudHandoffGuards, []);
    await h.controller.abort({ runId: run.runId });
  });

  test(`${browser}: handback guard-clear failure stops before any further action`, async () => {
    const ready = deferred(); let observations = 0, actions = 0;
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => {
      await ready.promise; await options.handoffBoundary(); observations++;
      await options.handoffObserved(); actions++; options.onRunFinished('done'); return 'Read';
    });
    const run = await h.controller.startRun({ task: 'Read only' });
    await h.controller.pause({ runId: run.runId }); ready.resolve(); await until(() => h.controller.runs.get(run.runId).status === 'paused'); await h.controller.status({ runId: run.runId });
    const write = h.api.storage.local.set;
    h.api.storage.local.set = async data => { if (!data.webbrainCloudHandoffGuards.length) throw Error('Fixture observed-clear failure'); return write(data); };
    await h.controller.resume({ runId: run.runId }); await until(() => h.controller.runs.get(run.runId).handoff?.interrupted);
    const stopped = await h.controller.status({ runId: run.runId });
    assert.equal(stopped.status, 'paused'); assert.equal(stopped.handoff.resumable, false); assert.equal(observations, 1); assert.equal(actions, 0);
    assert.equal(h.local.webbrainCloudHandoffGuards.length, 1);
    await assert.rejects(h.controller.startRun({ task: 'Another bot', tabId: 8 }), error => error.status === 409);
    h.api.storage.local.set = write; await h.controller.abort({ runId: run.runId }); assert.deepEqual(h.local.webbrainCloudHandoffGuards, []);
  });

  test(`${browser}: queued persistence cannot resurrect a confirmed cleared guard`, async () => {
    const ready = deferred(), clearing = deferred(), cleared = deferred();
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => { await ready.promise; await options.handoffBoundary(); options.onRunFinished('done'); return 'Read'; });
    const run = await h.controller.startRun({ task: 'Read' });
    await h.controller.pause({ runId: run.runId }); ready.resolve(); await until(() => h.controller.runs.get(run.runId).status === 'paused'); await h.controller.status({ runId: run.runId });
    const restarted = createCloudRunController({ chromeApi: h.api, agent: h.agent, ensureOffscreen: async () => {} }); await restarted.status({ runId: run.runId });
    const write = h.api.storage.local.set;
    h.api.storage.local.set = async data => { if (!data.webbrainCloudHandoffGuards.length) { clearing.resolve(); await cleared.promise; } return write(data); };
    const first = restarted.abort({ runId: run.runId }); await clearing.promise;
    const queued = restarted.abort({ runId: run.runId }); await tick(); cleared.resolve();
    await first; await queued; await restarted.status({ runId: run.runId }); assert.deepEqual(h.local.webbrainCloudHandoffGuards, []);
    await h.controller.abort({ runId: run.runId });
  });

  test(`${browser}: failed or malformed durable guard reads prevent run startup`, async () => {
    const valid = { runId: 'owned_1', tabId: 7, createdAt: '2026-10-12T23:00:00.000Z', updatedAt: '2026-10-12T23:00:00.000Z', pausedAt: null };
    const readFailure = Symbol('read failure');
    for (const value of [readFailure, null, false, 0, '', [{ runId: '', tabId: 7 }], [{ ...valid, runId: 123 }], [{ ...valid, runId: ' ' }],
      [valid, valid], [{ ...valid, tabId: '7' }], [{ ...valid, createdAt: 'yesterday' }]]) {
      let calls = 0;
      const h = harness(async () => { calls++; });
      h.api.storage.local.get = async () => { if (value === readFailure) throw Error('Fixture read failure'); return { webbrainCloudHandoffGuards: value }; };
      await assert.rejects(h.controller.startRun({ task: 'Read' })); assert.equal(calls, 0);
    }
  });

  test(`${browser}: failed live cancellation clear stays interrupted until owner retries`, async () => {
    const ready = deferred();
    const h = harness(async (_tab, _task, update, _mode, _attachments, options) => { await ready.promise; await options.handoffBoundary(); update('clarify', { clarifyId: 'late', question: 'Late question' }); options.onRunFinished('done'); return 'Read'; });
    const run = await h.controller.startRun({ task: 'Read' });
    await h.controller.pause({ runId: run.runId }); ready.resolve(); await until(() => h.controller.runs.get(run.runId).status === 'paused'); await h.controller.status({ runId: run.runId });
    const write = h.api.storage.local.set;
    h.api.storage.local.set = async data => { if (!data.webbrainCloudHandoffGuards.length) throw Error('Fixture live clear failure'); return write(data); };
    assert.equal((await h.controller.abort({ runId: run.runId })).status, 'aborting');
    await until(() => h.controller.runs.get(run.runId).handoff?.interrupted);
    const stopped = await h.controller.status({ runId: run.runId });
    assert.equal(stopped.status, 'paused'); assert.equal(stopped.handoff.resumable, false); assert.equal(stopped.pendingInput, null); assert.equal(stopped.completedAt, null);
    assert.equal(h.local.webbrainCloudHandoffGuards.length, 1);
    await assert.rejects(h.controller.guardRunStart(8, { kind: 'scheduled' }), error => error.status === 409);
    h.api.storage.local.set = write; assert.equal((await h.controller.abort({ runId: run.runId })).status, 'aborted'); assert.deepEqual(h.local.webbrainCloudHandoffGuards, []);
  });

  test(`${browser}: valid caller correlation IDs remain usable for handoff and reload`, async () => {
    for (const runId of ['request:17', 'tenant/run/1', 'browser-ü-任务']) {
      const ready = deferred();
      const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => {
        await ready.promise; await options.handoffBoundary(); options.onRunFinished('done'); return 'Read';
      });
      await h.controller.startRun({ task: 'Read only', runId });
      await h.controller.pause({ runId }); ready.resolve();
      await until(() => h.controller.runs.get(runId).status === 'paused'); await h.controller.status({ runId });
      delete h.stored.webbrainCloudRunSnapshots;
      const restarted = createCloudRunController({ chromeApi: h.api, agent: h.agent });
      assert.equal((await restarted.status({ runId })).handoff.interrupted, true);
      await restarted.abort({ runId }); await h.controller.abort({ runId });
    }
    const h = harness(async () => assert.fail('Oversized ID must not dispatch'));
    await assert.rejects(h.controller.startRun({ task: 'Read', runId: 'x'.repeat(16 * 1024 + 1) }), error => error.status === 400);
    assert.equal(h.controller.runs.size, 0);
  });

  test(`${browser}: cancellation during a pending pause guard write cannot resurrect manual control`, async () => {
    for (const fail of [false, true]) {
      const ready = deferred(), writing = deferred(), written = deferred(), finished = deferred();
      const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => {
        await ready.promise; await options.handoffBoundary(); await finished.promise; options.onRunFinished('done'); return 'Read';
      });
      const run = await h.controller.startRun({ task: 'Read' });
      await h.controller.pause({ runId: run.runId });
      const set = h.api.storage.local.set;
      let failed = false;
      h.api.storage.local.set = async data => {
        if (data.webbrainCloudHandoffGuards?.[0]?.pausedAt) {
          writing.resolve(); await written.promise;
          if (fail && !failed) { failed = true; throw Error('Fixture pending pause write failure'); }
        }
        return set(data);
      };
      ready.resolve(); await writing.promise;
      const aborting = h.controller.abort({ runId: run.runId });
      await tick(); assert.equal(h.controller.runs.get(run.runId).status, 'aborting');
      await assert.rejects(h.controller.guardRunStart(8, { kind: 'scheduled' }), error => error.status === 409);
      written.resolve(); await aborting;
      assert.equal(h.controller.runs.get(run.runId).handoff, null, 'a delayed pause callback cannot restore writable state');
      finished.resolve(); await until(() => h.controller.runs.get(run.runId).status === 'aborted');
      assert.equal((await h.controller.status({ runId: run.runId })).status, 'aborted');
      assert.deepEqual(h.local.webbrainCloudHandoffGuards, []);
    }
  });

  test(`${browser}: cancellation stays nonterminal through native and recording cleanup`, async () => {
    const ready = deferred(), settled = deferred(), flushing = deferred(), flushed = deferred();
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => {
      await ready.promise; await options.handoffBoundary(); await settled.promise; options.onRunFinished('done'); return 'Read';
    }, {
      startRecording: async () => ({ ok: true, state: { recordingId: 'capture-1' } }),
      stopRecording: async () => { flushing.resolve(); await flushed.promise; return { ok: true }; },
    });
    const run = await h.controller.startRun({ task: 'Read', capture: 'video' });
    await h.controller.pause({ runId: run.runId }); ready.resolve();
    await until(() => h.controller.runs.get(run.runId).status === 'paused'); await h.controller.status({ runId: run.runId });
    assert.equal((await h.controller.abort({ runId: run.runId })).status, 'aborting');
    for (const kind of ['cloud', 'scheduled', 'interactive']) await assert.rejects(h.controller.guardRunStart(8, { kind }), error => error.status === 409);
    await assert.rejects(h.controller.startRun({ task: 'Another bot', tabId: 8 }), error => error.status === 409);
    settled.resolve(); await flushing.promise;
    const pending = await h.controller.status({ runId: run.runId });
    assert.equal(pending.completedAt, null); assert.notEqual(pending.status, 'aborted');
    assert.equal(h.local.webbrainCloudHandoffGuards.length, 1, 'recording still owns the profile');
    flushed.resolve(); await until(() => h.controller.runs.get(run.runId).status === 'aborted');
    await h.controller.status({ runId: run.runId }); assert.deepEqual(h.local.webbrainCloudHandoffGuards, []);
    await h.controller.guardRunStart(8, { kind: 'interactive' });
  });

  test(`${browser}: a failed public paused checkpoint becomes nonresumable`, async () => {
    const ready = deferred();
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => {
      await ready.promise; await options.handoffBoundary(); options.onRunFinished('done'); return 'Read';
    });
    const run = await h.controller.startRun({ task: 'Read' });
    await h.controller.pause({ runId: run.runId });
    const set = h.api.storage.session.set;
    h.api.storage.session.set = async data => {
      if (data.webbrainCloudRunSnapshots?.[0]?.handoff?.resumable && data.webbrainCloudRunSnapshots[0].status === 'paused') throw Error('Fixture public checkpoint failure');
      return set(data);
    };
    ready.resolve(); await until(() => h.controller.runs.get(run.runId).handoff?.interrupted);
    assert.equal(h.controller.runs.get(run.runId).handoff.resumable, false);
    assert.equal(h.local.webbrainCloudHandoffGuards.length, 1);
    await assert.rejects(h.controller.resume({ runId: run.runId }));
    h.api.storage.session.set = set;
    await until(() => !h.controller.runs.get(run.runId).pendingInput);
    await h.controller.abort({ runId: run.runId }); await until(() => h.controller.runs.get(run.runId).status === 'aborted');
  });

  test(`${browser}: abort racing a fresh-observation guard clear retains ownership through recording cleanup`, async () => {
    const ready = deferred(), clearing = deferred(), cleared = deferred(), continued = deferred(), flushing = deferred(), flushed = deferred();
    const h = harness(async (_tab, _task, _update, _mode, _attachments, options) => {
      await ready.promise; await options.handoffBoundary(); await options.handoffObserved();
      await continued.promise; options.onRunFinished('done'); return 'Read';
    }, {
      startRecording: async () => ({ ok: true, state: { recordingId: 'capture-2' } }),
      stopRecording: async () => { flushing.resolve(); await flushed.promise; return { ok: true }; },
    });
    const run = await h.controller.startRun({ task: 'Read', capture: 'video' });
    await h.controller.pause({ runId: run.runId }); ready.resolve();
    await until(() => h.controller.runs.get(run.runId).status === 'paused'); await h.controller.status({ runId: run.runId });
    const set = h.api.storage.local.set;
    let held = false;
    h.api.storage.local.set = async data => {
      if (!held && !data.webbrainCloudHandoffGuards.length) {
        held = true; clearing.resolve(); await cleared.promise;
      }
      return set(data);
    };
    await h.controller.resume({ runId: run.runId }); await clearing.promise;
    const aborting = h.controller.abort({ runId: run.runId });
    await tick();
    await assert.rejects(h.controller.guardRunStart(8, { kind: 'scheduled' }), error => error.status === 409);
    cleared.resolve();
    assert.equal((await aborting).status, 'aborting');
    assert.equal(h.local.webbrainCloudHandoffGuards.length, 1, 'cancellation during clear restores the durable reservation');
    continued.resolve(); await flushing.promise;
    for (const kind of ['cloud', 'scheduled', 'interactive']) await assert.rejects(h.controller.guardRunStart(8, { kind }), error => error.status === 409);
    await assert.rejects(h.controller.startRun({ task: 'Another bot', tabId: 8 }), error => error.status === 409);
    const pending = await h.controller.status({ runId: run.runId });
    assert.equal(pending.completedAt, null); assert.notEqual(pending.status, 'aborted');
    assert.equal(h.local.webbrainCloudHandoffGuards.length, 1);
    flushed.resolve(); await until(() => h.controller.runs.get(run.runId).status === 'aborted');
    assert.equal((await h.controller.status({ runId: run.runId })).status, 'aborted');
    assert.deepEqual(h.local.webbrainCloudHandoffGuards, []);
    await h.controller.guardRunStart(8, { kind: 'interactive' });
  });

  if (browser === 'firefox') test('Firefox keeps its in-process Cloud bridge transport', async () => {
    const calls = [];
    const h = harness(async () => assert.fail('Bridge controls must not start browser work'), {
      bridge: {
        start: async options => { calls.push(['start', options.url]); return { connected: true }; },
        stop: async () => { calls.push(['stop']); return { connected: false }; },
        status: async () => { calls.push(['status']); return { connected: true }; },
      },
      ensureOffscreen: () => assert.fail('Firefox has no offscreen document'),
    });
    h.api.runtime = { sendMessage: () => assert.fail('Firefox uses its injected background bridge') };
    assert.equal((await h.controller.startBridge('ws://127.0.0.1:17374/extension')).connected, true);
    assert.equal((await h.controller.bridgeStatus()).connected, true);
    assert.equal((await h.controller.stopBridge()).connected, false);
    assert.deepEqual(calls, [['start', 'ws://127.0.0.1:17374/extension'], ['status'], ['stop']]);
  });
}
