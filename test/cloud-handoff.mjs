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
  const { createCloudRunController } = await import(`../src/${browser}/src/cloud-runs.js`);
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);

  function harness(processMessage) {
    const stored = {};
    const api = { storage: { session: { get: async key => ({ [key]: structuredClone(stored[key]) }), set: async data => Object.assign(stored, structuredClone(data)) } },
      tabs: { get: async id => ({ id, url: 'https://example.com/' }), query: async () => [{ id: 7, url: 'https://example.com/' }], update: async () => {} } };
    let clarificationResolve;
    const agent = { isRunning: () => false, strictSecretMode: true, processMessage, abort() {}, _persistNow: async () => ({ ok: true }),
      submitClarifyResponse(_tab, _id, answer) { clarificationResolve?.(answer); return true; } };
    let seq = 0;
    const controller = createCloudRunController({ chromeApi: api, agent, makeRunId: () => `run_handoff_${++seq}`, ensureOffscreen: async () => {} });
    return { controller, stored, agent, api, setClarificationResolver(value) { clarificationResolve = value; } };
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
    for (const kind of ['scheduled', 'interactive']) assert.throws(() => restarted.guardRunStart(8, { kind }), error => error.status === 409);
    assert.equal(calls, 1, 'neither restart nor Hand back replays the old task');
    assert.equal((await restarted.abort({ runId: run.runId })).status, 'aborted');
    assert.equal(restarted.isRunning(7), false);
    assert.doesNotThrow(() => restarted.guardRunStart(8, { kind: 'scheduled' }));
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
    await tick(); assert.equal(exposed, false, 'the viewer does not get control until the checkpoint is durable');
    written.resolve(); assert.equal((await status).status, 'paused');
    await h.controller.abort({ runId: run.runId });
    await until(() => h.controller.runs.get(run.runId).status === 'aborted');
    assert.equal(h.controller.isRunning(7), false);
  });
}
