import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCloudBackend } from './backends/cloud.mjs';

const SECRET = 'mock-cloud-key-never-real';
const SESSION = 'brw_selected';
const role = (overrides = {}) => ({ name: 'actor', backend: 'cloud', sessionId: SESSION, apiKey: SECRET, ...overrides });
const ready = (overrides = {}) => ({ id: SESSION, profile_mode: 'normal', status: 'ready', runtime_ready: true, ...overrides });
const run = (overrides = {}) => ({
  run_id: 'run_one', session_id: SESSION, parent_run_id: null, tab_id: 7,
  status: 'completed', summary: 'Done', result: { ok: true }, final_url: 'https://example.com/',
  created_at: new Date().toISOString(), started_at: '2026-10-12T08:00:01Z',
  finished_at: '2026-10-12T08:00:02Z', updated_at: '2026-10-12T08:00:02Z', updates: [],
  ...overrides,
});

function mock(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const item = { url: String(url), route: new URL(url).pathname + new URL(url).search, options };
    calls.push(item);
    return await handler(item, calls);
  };
  return { calls, fetchImpl };
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function normalMock(overrides = {}) {
  return mock(async call => {
    const { route, options } = call;
    if (route === `/api/browser-sessions/${SESSION}`) return json({ browser_session: overrides.session ?? ready() });
    if (route.startsWith('/api/runs?')) return json({ runs: overrides.runs ?? [] });
    if (route === `/api/browser-sessions/${SESSION}/runs` && options.method === 'POST') {
      if (overrides.create) return await overrides.create(call);
      return json(run({ status: 'running' }), 202);
    }
    if (route === `/api/browser-sessions/${SESSION}/runs/run_one` && options.method === 'GET') {
      if (overrides.read) return await overrides.read(call);
      return json(overrides.run ?? run());
    }
    if (overrides.extra) return await overrides.extra(call);
    throw new Error(`Unexpected mock route ${route}`);
  });
}

const options = mockState => ({ timeoutMs: 100, pollMs: 1, maxRuns: 5, fetchImpl: mockState.fetchImpl });
const fails = (code) => error => error.code === code;

test('connect uses the supplied persistent session, strict readiness and no lifecycle mutations', async () => {
  const state = normalMock();
  const backend = createCloudBackend(role(), options(state));
  const metadata = await backend.connect();
  assert.equal(metadata.ready, true);
  assert.equal(metadata.runtimeReady, true);
  assert.equal(metadata.buildStatus, 'unknown');
  assert.equal(metadata.version, null);
  assert.equal(metadata.build, null);
  assert.deepEqual(metadata.capabilities, {
    domObservation: false, activeSteering: false, manualIntervention: true,
    files: true, continuation: true, ask: false,
  });
  assert.equal(metadata.independentObservation, 'manual_or_paired_local_required');
  assert.equal((await backend.close()).preserved, true);
  assert.ok(state.calls.every(call => call.options.method === 'GET'));
  assert.ok(state.calls.every(call => call.options.redirect === 'error' && call.options.signal instanceof AbortSignal));
  assert.ok(state.calls.every(call => call.route !== '/api/browser-sessions'));
});

test('status ready with runtime_ready absent, false or truthy strings cannot dispatch', async t => {
  for (const runtimeReady of [undefined, false, 'true', 1]) await t.test(String(runtimeReady), async () => {
    const state = normalMock({ session: ready({ runtime_ready: runtimeReady }) });
    const backend = createCloudBackend(role(), { ...options(state), timeoutMs: 8 });
    await assert.rejects(backend.connect(), fails('READINESS_TIMEOUT'));
    assert.ok(state.calls.every(call => call.options.method === 'GET'));
  });
});

test('runtime_ready true requires ready status and a normal profile', async () => {
  const state = normalMock({ session: ready({ status: 'paused' }) });
  await assert.rejects(createCloudBackend(role(), options(state)).connect(), fails('SESSION_NOT_READY'));
  const incognito = normalMock({ session: ready({ profile_mode: 'incognito' }) });
  await assert.rejects(createCloudBackend(role(), options(incognito)).connect(), fails('PERSISTENT_SESSION_REQUIRED'));
});

test('unknown runtime version/build blocks strict pins without assuming checkout HEAD', async () => {
  const state = normalMock({ session: ready({ version: '40.4.1', build: 'fake-unattested' }) });
  const backend = createCloudBackend(role({ expectedVersion: '40.4.1' }), options(state));
  const metadata = await backend.doctor();
  assert.equal(metadata.versionStatus, 'unknown');
  assert.equal(metadata.pinStatus, 'unverifiable');
  const count = state.calls.length;
  await assert.rejects(backend.connect(), fails('BUILD_UNVERIFIABLE'));
  assert.equal(state.calls.length, count);
});

test('active unrelated runs, including pending clarification, block reuse and cannot be stopped', async t => {
  for (const status of ['running', 'aborting', 'needs_user_input']) await t.test(status, async () => {
    const state = normalMock({ runs: [run({ run_id: 'run_unrelated', status })] });
    const backend = createCloudBackend(role(), options(state));
    await assert.rejects(backend.connect(), fails('ACTIVE_RUN_CONFLICT'));
    await assert.rejects(backend.stop('run_unrelated'), fails('UNOWNED_RUN'));
    assert.ok(state.calls.every(call => call.options.method === 'GET'));
  });
});

test('a selected session mismatch fails closed and no ready session is selected from a list', async () => {
  const state = normalMock({ session: ready({ id: 'brw_elsewhere' }) });
  await assert.rejects(createCloudBackend(role(), options(state)).connect(), fails('SESSION_MISMATCH'));
  const missing = createCloudBackend(role({ sessionId: null }), options(state));
  await assert.rejects(missing.connect(), fails('SESSION_REQUIRED'));
  assert.equal(state.calls.length, 1);
});

test('setup explicitly creates one named normal session and close preserves it', async () => {
  const state = mock(call => {
    if (call.route === '/api/browser-sessions' && call.options.method === 'POST') {
      assert.deepEqual(JSON.parse(call.options.body), { type: 'normal', display_name: 'Workflow actor' });
      return json({ browser_session: ready({ display_name: 'Workflow actor' }) }, 202);
    }
    if (call.route === `/api/browser-sessions/${SESSION}`) return json({ browser_session: ready() });
    if (call.route.startsWith('/api/runs?')) return json({ runs: [] });
    throw new Error('Unexpected setup request');
  });
  const journal = [];
  const backend = createCloudBackend(role({ sessionId: null }), { ...options(state), onJournal: event => journal.push(event) });
  await assert.rejects(backend.connect({ setup: true }), fails('INVALID_CONFIG'));
  assert.equal(state.calls.length, 0);
  await backend.connect({ setup: true, name: 'Workflow actor' });
  await backend.close();
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(journal[0].type, 'attempt');
  assert.equal(journal[1].type, 'accepted');
  assert.equal(journal[1].sessionId, SESSION);
});

test('ambiguous session creation is never retried or destroyed', async () => {
  const state = mock(() => { throw new Error(`network failed with ${SECRET}`); });
  const events = [];
  const backend = createCloudBackend(role({ sessionId: null }), { ...options(state), onJournal: event => events.push(event) });
  await assert.rejects(backend.connect({ setup: true, name: 'Workflow actor' }), fails('RECONCILIATION_REQUIRED'));
  await assert.rejects(backend.connect({ setup: true, name: 'Workflow actor' }), fails('RECONCILIATION_REQUIRED'));
  await backend.close();
  assert.equal(state.calls.length, 1);
  assert.deepEqual(events.map(event => event.type), ['attempt', 'ambiguous']);
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test('run journals attempt before dispatch and run ID before its first poll', async () => {
  const order = [];
  const state = normalMock({ create: () => { order.push('dispatch'); return json(run({ status: 'running' }), 202); }, read: () => { order.push('poll'); return json(run()); } });
  const backend = createCloudBackend(role(), { ...options(state), onJournal: event => order.push(event.type) });
  await backend.connect();
  const result = await backend.run({ task: 'Read the scoped page.', requestId: 'request-one' });
  assert.deepEqual(order, ['attempt', 'dispatch', 'accepted', 'poll', 'update']);
  assert.equal(result.status, 'completed');
  assert.equal(result.runId, 'run_one');
  assert.equal(result.evidence.independent, false);
  assert.equal(result.startedAt, '2026-10-12T08:00:01Z');
  assert.equal(result.finishedAt, '2026-10-12T08:00:02Z');
  assert.ok(Number.isFinite(Date.parse(result.receivedAt)));
  await assert.rejects(backend.run({ task: 'Again', requestId: 'request-one' }), fails('DUPLICATE_REQUEST'));
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('journal failure before attempt dispatch never makes a billable request', async () => {
  const state = normalMock();
  const backend = createCloudBackend(role(), { ...options(state), onJournal: () => { throw new Error('Private ledger failed'); } });
  await backend.connect();
  await assert.rejects(backend.run({ task: 'Scoped task', requestId: 'req' }), error => error.code === 'JOURNAL_ERROR' && error.noDispatch === true);
  assert.equal(backend.runCount, 0);
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 0);
});

test('journal failure after acceptance retains the run ID for explicit reconciliation', async () => {
  const state = normalMock();
  const backend = createCloudBackend(role(), { ...options(state), onJournal: event => {
    if (event.type === 'accepted') throw new Error('Cannot persist ID');
  } });
  await backend.connect();
  await assert.rejects(backend.run({ task: 'Scoped task', requestId: 'req' }), error => error.code === 'RECONCILIATION_REQUIRED' && error.runId === 'run_one' && error.noDispatch !== true);
  await assert.rejects(backend.run({ task: 'Retry', requestId: 'newreq' }), fails('RECONCILIATION_REQUIRED'));
  const reconciled = await backend.reconcile({ requestId: 'req', runId: 'run_one' });
  assert.equal(reconciled.readyToContinue, true);
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('ambiguous run creation never retries; read-only reconciliation is required', async () => {
  const state = normalMock({ create: () => { throw new Error('Connection reset after acceptance'); } });
  const backend = createCloudBackend(role(), options(state));
  await backend.connect();
  await assert.rejects(backend.run({ task: 'Scoped task', requestId: 'ambiguous' }), fails('RECONCILIATION_REQUIRED'));
  await assert.rejects(backend.run({ task: 'Retry', requestId: 'another' }), fails('RECONCILIATION_REQUIRED'));
  await assert.rejects(backend.reconcile({ requestId: 'wrong', runId: 'run_one' }), fails('RECONCILIATION_MISMATCH'));
  const before = state.calls.length;
  const result = await backend.reconcile({ requestId: 'ambiguous', runId: 'run_one' });
  assert.equal(result.status, 'reconciled');
  assert.ok(state.calls.slice(before).every(call => call.options.method === 'GET'));
  assert.equal(backend.runCount, 1);
});

test('resumed reconciliation requires a recorded timestamp and matching session/time', async () => {
  const state = normalMock({ run: run({ created_at: '2020-01-01T00:00:00Z' }) });
  const backend = createCloudBackend(role(), options(state));
  await assert.rejects(backend.reconcile({ requestId: 'resumed', runId: 'run_one' }), fails('RECONCILIATION_REQUIRED'));
  await assert.rejects(backend.reconcile({ requestId: 'resumed', runId: 'run_one', attemptedAt: new Date().toISOString() }), fails('RECONCILIATION_MISMATCH'));
  const mismatched = normalMock({ run: run({ session_id: 'brw_elsewhere' }) });
  await assert.rejects(createCloudBackend(role(), options(mismatched)).getRun('run_one'), fails('RUN_MISMATCH'));
});

test('read-only recovery connects to one explicitly recorded active or pending-input run', async t => {
  for (const status of ['running', 'needs_user_input', 'aborting']) await t.test(status, async () => {
    const attemptedAt = new Date().toISOString();
    const selected = run({ status, created_at: attemptedAt,
      ...(status === 'needs_user_input' ? { pending_input: { clarify_id: 'clarify-one', question: 'Choose folder' } } : {}),
    });
    const state = normalMock({
      session: ready({ active_run_ids: ['run_one'] }), runs: [selected], run: selected,
    });
    const events = [];
    const backend = createCloudBackend(role(), { ...options(state), onJournal: event => events.push(event) });
    const metadata = await backend.connect({ reconcileRunId: 'run_one', requestId: 'saved-request', attemptedAt });
    assert.equal(metadata.ready, true);
    assert.deepEqual(metadata.activeRunIds, ['run_one']);
    assert.equal((await backend.getRun('run_one')).status, status);
    assert.deepEqual(events.map(event => event.type), ['reconciled']);
    assert.ok(state.calls.every(call => call.options.method === 'GET'));
    await assert.rejects(backend.run({ task: 'Create a duplicate', requestId: 'new-request' }), fails('ACTIVE_RUN_CONFLICT'));
    await backend.close();
    assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 0);
  });
});

test('recovery connection rejects unrelated active runs and mismatched ownership without redispatch', async () => {
  const attemptedAt = new Date().toISOString();
  const selected = run({ status: 'running', created_at: attemptedAt });
  const unrelated = run({ run_id: 'run_unrelated', status: 'running', created_at: attemptedAt });
  const state = normalMock({ runs: [selected, unrelated], run: selected });
  const backend = createCloudBackend(role(), options(state));
  await assert.rejects(backend.connect({ reconcileRunId: 'run_one', requestId: 'saved-request', attemptedAt }), fails('ACTIVE_RUN_CONFLICT'));
  assert.ok(state.calls.every(call => call.options.method === 'GET'));
  const reported = normalMock({ session: ready({ active_run_ids: ['run_one', 'run_unrelated'] }), runs: [selected], run: selected });
  await assert.rejects(createCloudBackend(role(), options(reported)).connect({
    reconcileRunId: 'run_one', requestId: 'saved-request', attemptedAt,
  }), fails('ACTIVE_RUN_CONFLICT'));
  const foreign = normalMock({ runs: [selected], run: run({ session_id: 'brw_other', status: 'running', created_at: attemptedAt }) });
  await assert.rejects(createCloudBackend(role(), options(foreign)).connect({
    reconcileRunId: 'run_one', requestId: 'saved-request', attemptedAt,
  }), fails('RUN_MISMATCH'));
  const stale = normalMock({ runs: [selected], run: run({ status: 'running', created_at: '2020-01-01T00:00:00Z' }) });
  await assert.rejects(createCloudBackend(role(), options(stale)).connect({
    reconcileRunId: 'run_one', requestId: 'saved-request', attemptedAt,
  }), fails('RECONCILIATION_MISMATCH'));
});

test('recovery requires saved request time, strict readiness and the original normal session', async () => {
  const attemptedAt = new Date().toISOString();
  const state = normalMock();
  const backend = createCloudBackend(role(), options(state));
  await assert.rejects(backend.connect({ reconcileRunId: 'run_one', requestId: 'saved-request' }), fails('RECONCILIATION_REQUIRED'));
  const missing = createCloudBackend(role({ sessionId: null }), options(state));
  await assert.rejects(missing.connect({ reconcileRunId: 'run_one', requestId: 'saved-request', attemptedAt }), fails('SESSION_REQUIRED'));
  await assert.rejects(backend.connect({ setup: true, reconcileRunId: 'run_one', requestId: 'saved-request', attemptedAt }), fails('SESSION_REQUIRED'));
  const notReady = normalMock({ session: ready({ runtime_ready: 'true' }) });
  await assert.rejects(createCloudBackend(role(), { ...options(notReady), timeoutMs: 8 }).connect({
    reconcileRunId: 'run_one', requestId: 'saved-request', attemptedAt,
  }), fails('READINESS_TIMEOUT'));
  const incognito = normalMock({ session: ready({ profile_mode: 'incognito' }) });
  await assert.rejects(createCloudBackend(role(), options(incognito)).connect({
    reconcileRunId: 'run_one', requestId: 'saved-request', attemptedAt,
  }), fails('PERSISTENT_SESSION_REQUIRED'));
  assert.ok([...state.calls, ...notReady.calls, ...incognito.calls].every(call => call.options.method === 'GET'));
});

test('polling emits updates and returns needs_user_input without creating a duplicate', async () => {
  let reads = 0;
  const state = normalMock({ read: () => json(++reads === 1
    ? run({ status: 'running', updates: [{ type: 'tool_call', timestamp: '2026-10-12T08:00:01Z' }] })
    : run({ status: 'needs_user_input', pending_input: { clarify_id: 'clarify-one', question: 'Choose a folder' } })) });
  const backend = createCloudBackend(role(), options(state));
  await backend.connect();
  const updates = [];
  const result = await backend.run({ task: 'Scoped task', requestId: 'req', onUpdate: snapshot => updates.push(snapshot) });
  assert.equal(result.status, 'needs_user_input');
  assert.equal(result.pendingInput.clarify_id, 'clarify-one');
  assert.equal(updates.length, 2);
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('readiness is rechecked before every run, and Ask remains explicitly unavailable', async () => {
  let unsafe = false;
  const state = normalMock();
  const original = state.fetchImpl;
  state.fetchImpl = async (url, init) => unsafe && new URL(url).pathname === `/api/browser-sessions/${SESSION}`
    ? json({ browser_session: ready({ runtime_ready: false }) }) : original(url, init);
  const backend = createCloudBackend(role(), options(state));
  await backend.connect();
  await assert.rejects(backend.run({ task: 'Read', mode: 'ask' }), error => error.code === 'UNSUPPORTED_CAPABILITY' && error.noDispatch === true);
  unsafe = true;
  await assert.rejects(backend.run({ task: 'Read' }), error => error.code === 'SESSION_NOT_READY' && error.noDispatch === true);
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 0);
});

test('navigation is a real normal run and consumes the run budget', async () => {
  const state = normalMock();
  const backend = createCloudBackend(role(), { ...options(state), maxRuns: 1 });
  await backend.connect();
  const handle = await backend.open('https://example.com/', { requestId: 'navigation' });
  assert.equal(handle.tabId, 7);
  assert.equal(handle.url, 'https://example.com/');
  assert.equal(backend.runCount, 1);
  const payload = JSON.parse(state.calls.find(call => call.options.method === 'POST').options.body);
  assert.equal(payload.mode, 'act');
  assert.equal(payload.capture, 'none');
  assert.match(payload.task, /Only navigate/);
  await assert.rejects(backend.run({ task: 'Task after navigation', requestId: 'next' }), error => error.code === 'RUN_LIMIT' && error.noDispatch === true);
});

test('only mechanically known preflight and explicit HTTP rejections carry noDispatch', async t => {
  for (const status of [400, 401, 403, 404, 409, 422]) await t.test(`HTTP ${status}`, async () => {
    const state = normalMock({ create: () => json({ error: 'Explicit rejected request' }, status) });
    const backend = createCloudBackend(role(), options(state));
    await backend.connect();
    await assert.rejects(backend.run({ task: 'Scoped task', requestId: 'rejected' }), error => error.status === status && error.noDispatch === true);
    await assert.rejects(backend.run({ task: 'Scoped task', requestId: 'rejected' }), fails('DUPLICATE_REQUEST'));
    assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1);
  });
  const state = normalMock();
  await assert.rejects(createCloudBackend(role(), options(state)).run({ task: 'Not yet connected' }), error => error.code === 'NOT_CONNECTED' && error.noDispatch === true);
  assert.equal(state.calls.length, 0);
});

test('ambiguous mutating responses and accepted-run polling failures never claim noDispatch', async t => {
  for (const status of [408, 429, 500]) await t.test(`HTTP ${status}`, async () => {
    const state = normalMock({ create: () => json({ error: 'Uncertain acceptance' }, status) });
    const backend = createCloudBackend(role(), options(state));
    await backend.connect();
    await assert.rejects(backend.run({ task: 'Scoped task', requestId: 'uncertain' }), error => error.code === 'RECONCILIATION_REQUIRED' && error.noDispatch !== true);
    assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1);
  });
  const state = normalMock({ read: () => { throw new Error('Lost poll response after accepted run'); } });
  const backend = createCloudBackend(role(), options(state));
  await backend.connect();
  await assert.rejects(backend.run({ task: 'Scoped task', requestId: 'accepted' }), error => error.code === 'CLOUD_HTTP_ERROR' && error.noDispatch !== true);
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('continuation uses messages only after a finished owned newest run', async () => {
  let hasChild = false;
  const child = run({ run_id: 'run_child', parent_run_id: 'run_one' });
  const state = normalMock({ extra: call => {
    if (call.route.endsWith('/run_one/messages')) { hasChild = true; return json(child, 202); }
    if (call.route.endsWith('/runs/run_child')) return json(child);
    throw new Error('Unexpected child request');
  } });
  const original = state.fetchImpl;
  state.fetchImpl = async (url, init) => hasChild && new URL(url).pathname === '/api/runs'
    ? json({ runs: [child] }) : original(url, init);
  const backend = createCloudBackend(role(), options(state));
  await backend.connect();
  await assert.rejects(backend.run({ task: 'Continue', continueFrom: 'run_one' }), fails('RECONCILIATION_REQUIRED'));
  await backend.run({ task: 'Initial', requestId: 'first' });
  const result = await backend.run({ task: 'Next', continueFrom: 'run_one', requestId: 'second' });
  assert.equal(result.parentRunId, 'run_one');
  assert.equal(backend.runCount, 2);
  await assert.rejects(backend.run({ task: 'Duplicate child', continueFrom: 'run_one', requestId: 'third' }), fails('CONTINUATION_NOT_LATEST'));
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 2);
});

test('active run messages, checkpoints, steering and DOM observation are unavailable', async () => {
  const state = normalMock({ run: run({ status: 'needs_user_input' }) });
  const backend = createCloudBackend(role(), options(state));
  await backend.connect();
  await backend.run({ task: 'Initial', requestId: 'first' });
  await assert.rejects(backend.run({ task: 'Midrun', continueFrom: 'run_one' }), fails('RUN_NOT_FINISHED'));
  for (const operation of ['steer', 'checkpoint', 'intervene', 'observe']) {
    assert.throws(() => backend[operation]({ task: 'Injected task' }), fails('UNSUPPORTED_CAPABILITY'));
  }
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('run HTTP errors never expose server body, control credentials, or private tasks', async () => {
  const state = normalMock({ create: () => json({ error: `Private ${SECRET}`, token: 'other-private', task: 'Private account page' }, 401) });
  const events = [];
  const backend = createCloudBackend(role(), { ...options(state), onJournal: event => events.push(event) });
  await backend.connect();
  await assert.rejects(backend.run({ task: 'Private account page', requestId: 'req' }), error => {
    assert.equal(error.status, 401);
    assert.ok(!JSON.stringify(error).includes(SECRET));
    assert.ok(!error.message.includes('Private'));
    assert.equal(error.body, undefined);
    return true;
  });
  assert.ok(!JSON.stringify(events).includes('Private account page'));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test('returned snapshots redact credentials without inventing evidence or service timestamps', async () => {
  const state = normalMock({ run: run({
    started_at: undefined, finished_at: undefined, updated_at: undefined,
    summary: `Bearer unknown-token ${SECRET}`, result: { api_key: SECRET },
    updates: [{ data: { password: 'private-password', message: SECRET } }],
  }) });
  const backend = createCloudBackend(role(), options(state));
  const result = await backend.getRun('run_one');
  assert.equal(result.startedAt, null);
  assert.equal(result.finishedAt, null);
  assert.equal(result.updatedAt, null);
  assert.equal(result.evidence.independent, false);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes('unknown-token'));
  assert.equal(result.updates[0].data.password, '[redacted]');
});

test('per-role credentials remain distinct and control secrets cannot enter a task', async () => {
  const actorState = normalMock();
  const observerState = normalMock();
  const actor = createCloudBackend(role(), options(actorState));
  const observer = createCloudBackend(role({ name: 'observer', apiKey: 'mock-observer-key' }), options(observerState));
  await actor.connect();
  await observer.connect();
  assert.equal(actorState.calls[0].options.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(observerState.calls[0].options.headers.authorization, 'Bearer mock-observer-key');
  await assert.rejects(actor.run({ task: `Print ${SECRET}` }), fails('SECRET_IN_INPUT'));
  assert.equal(JSON.stringify(actor).includes(SECRET), false);
});

test('bounded fetch includes response-body reads and never retries a hung mutating request', async () => {
  const state = normalMock({ create: () => ({ ok: true, status: 202, text: () => new Promise(() => {}) }) });
  const backend = createCloudBackend(role(), { ...options(state), timeoutMs: 10 });
  await backend.connect();
  await assert.rejects(backend.run({ task: 'Scoped task', requestId: 'req' }), fails('RECONCILIATION_REQUIRED'));
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('a run discovered after connect blocks a new dispatch without aborting it', async () => {
  let active = false;
  const state = normalMock();
  const original = state.fetchImpl;
  state.fetchImpl = async (url, init) => active && new URL(url).pathname === '/api/runs'
    ? json({ runs: [run({ run_id: 'unrelated', status: 'running' })] }) : original(url, init);
  const backend = createCloudBackend(role(), options(state));
  await backend.connect();
  active = true;
  await assert.rejects(backend.run({ task: 'Start another task' }), fails('ACTIVE_RUN_CONFLICT'));
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 0);
});

test('stop targets only a harness-owned run and ambiguous aborts reconcile without repeating', async () => {
  let status = 'completed';
  const events = [];
  const state = normalMock({
    read: () => json(run({ status, created_at: '2020-01-01T00:00:00Z' })),
    extra: call => {
      if (call.route.endsWith('/run_one/abort')) {
        status = 'aborting';
        throw new Error('Lost abort response');
      }
      throw new Error('Unexpected abort request');
    },
  });
  const backend = createCloudBackend(role(), { ...options(state), onJournal: event => events.push(event) });
  await backend.connect();
  await backend.run({ task: 'Initial task', requestId: 'initial' });
  status = 'running';
  await assert.rejects(backend.stop('run_one'), fails('RECONCILIATION_REQUIRED'));
  const attempt = events.find(event => event.type === 'attempt' && event.operation === 'abort_run');
  assert.equal(attempt.runId, 'run_one');
  const before = state.calls.length;
  const reconciled = await backend.reconcile({ requestId: attempt.requestId, runId: 'run_one' });
  assert.equal(reconciled.run.status, 'aborting');
  assert.ok(state.calls.slice(before).every(call => call.options.method === 'GET'));
  await backend.close();
  assert.equal(state.calls.filter(call => call.route.endsWith('/abort')).length, 1);
  assert.equal(backend.runCount, 1);
});

test('explicit clarification responses match the pending ID and stale reads do not resend them', async () => {
  let answered = false;
  let staleReads = 0;
  const pending = run({ status: 'needs_user_input', pending_input: { clarify_id: 'clarify-one', question: 'Choose folder' } });
  const state = normalMock({
    read: () => json(answered && ++staleReads >= 4 ? run() : pending),
    extra: call => {
      if (call.route.endsWith('/run_one/responses')) {
        assert.deepEqual(JSON.parse(call.options.body), { clarify_id: 'clarify-one', answer: 'Use folder Alpha' });
        answered = true;
        return json(pending);
      }
      throw new Error('Unexpected response request');
    },
  });
  const backend = createCloudBackend(role(), options(state));
  await backend.connect();
  await backend.run({ task: 'Initial task', requestId: 'initial' });
  await assert.rejects(backend.respond({ runId: 'run_one', clarifyId: 'wrong', answer: 'Use folder Alpha' }), fails('CLARIFICATION_MISMATCH'));
  await backend.respond({ runId: 'run_one', clarifyId: 'clarify-one', answer: 'Use folder Alpha', requestId: 'answer' });
  await assert.rejects(backend.respond({ runId: 'run_one', clarifyId: 'clarify-one', answer: 'Use folder Alpha', requestId: 'repeat' }), fails('DUPLICATE_RESPONSE'));
  assert.equal((await backend.resumePolling('run_one')).status, 'completed');
  assert.equal(state.calls.filter(call => call.route.endsWith('/responses')).length, 1);
});

test('poll timeout preserves the accepted run and resuming polling does not start another run', async () => {
  let status = 'running';
  const state = normalMock({ read: () => json(run({ status })) });
  const backend = createCloudBackend(role(), options(state));
  await backend.connect();
  await assert.rejects(backend.run({ task: 'Long task', requestId: 'initial', timeoutMs: 8 }), error => error.code === 'RUN_TIMEOUT' && error.runId === 'run_one');
  status = 'completed';
  assert.equal((await backend.resumePolling('run_one')).status, 'completed');
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('ambiguous server failures require reconciliation while explicit HTTP rejections do not retry', async () => {
  const state = normalMock({ create: () => json({ error: 'Internal mutation status uncertain' }, 500) });
  const backend = createCloudBackend(role(), options(state));
  await backend.connect();
  await assert.rejects(backend.run({ task: 'Task', requestId: 'initial' }), fails('RECONCILIATION_REQUIRED'));
  await assert.rejects(backend.run({ task: 'Task', requestId: 'again' }), fails('RECONCILIATION_REQUIRED'));
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('undocumented or malformed run-list states cannot be assumed idle', async () => {
  for (const entry of [run({ status: 'queued' }), run({ session_id: undefined }), run({ run_id: undefined })]) {
    const state = normalMock({ runs: [entry] });
    await assert.rejects(createCloudBackend(role(), options(state)).connect(), fails('ACTIVE_RUNS_UNKNOWN'));
    assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 0);
  }
});

test('owned-run pagination is bounded and incomplete coverage blocks dispatch', async () => {
  const state = normalMock({ runs: Array.from({ length: 50 }, (_, i) => run({ run_id: `other-${i}`, session_id: 'brw_other' })) });
  const backend = createCloudBackend(role(), options(state));
  await assert.rejects(backend.connect(), fails('ACTIVE_RUNS_UNKNOWN'));
  assert.equal(state.calls.filter(call => call.route.startsWith('/api/runs?')).length, 20);
  assert.equal(state.calls.filter(call => call.options.method === 'POST').length, 0);
});

function fileMock(bytes, uploadReady = true, extra = {}) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return normalMock({ extra: call => {
    if (call.route.endsWith('/downloads-access')) return json({
      url: 'https://downloads.example.test/files/', username: 'download-user-secret', password: 'download-password-secret', upload_limit_bytes: 1_024,
    });
    if (call.url.startsWith('https://downloads.example.test/files/')) {
      if (extra.transfer) return extra.transfer(call);
      if (call.options.method === 'PUT') return json({ name: 'input.txt', size: bytes.length, sha256, storage_backend: uploadReady ? 'browser_local' : 'shared_object', browser_ready: uploadReady, browser_path: '/home/browser/Downloads/input.txt' });
      if (call.route === '/files/') return json({ entries: [{ name: 'input.txt', size: bytes.length, sha256 }] });
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    }
    throw new Error('Unexpected file request');
  } });
}

test('Downloads upload verifies bytes and exposes a browser path only for exact browser_ready true', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-cloud-mock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('scoped test input');
  const file = path.join(dir, 'input.txt');
  await fs.writeFile(file, bytes);
  for (const readiness of [true, false, 'true']) {
    const state = fileMock(bytes, readiness);
    const events = [];
    const backend = createCloudBackend(role(), { ...options(state), onJournal: event => events.push(event) });
    const result = await backend.upload({ file, remoteName: 'input.txt', requestId: 'upload' });
    assert.equal(result.browserReady, readiness === true);
    assert.equal(result.browserPath, readiness === true ? '/home/browser/Downloads/input.txt' : null);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.ok(!JSON.stringify(events).includes('download-password-secret'));
    const transfer = state.calls.find(call => call.options.method === 'PUT');
    assert.equal(transfer.options.redirect, 'error');
    assert.deepEqual(transfer.options.body, bytes);
  }
});

test('Downloads download returns a sha256, rejects overwrite and rejects a mismatched digest', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-cloud-mock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('independent downloaded bytes');
  const state = fileMock(bytes);
  const backend = createCloudBackend(role(), options(state));
  const destination = path.join(dir, 'output.txt');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const result = await backend.download({ remoteName: 'input.txt', destination, expectedSha256: sha256 });
  assert.equal(result.sha256, sha256);
  assert.deepEqual(await fs.readFile(destination), bytes);
  const count = state.calls.length;
  await assert.rejects(backend.download({ remoteName: 'input.txt', destination }), fails('FILE_EXISTS'));
  assert.equal(state.calls.length, count);
  const badDestination = path.join(dir, 'bad.txt');
  await assert.rejects(backend.download({ remoteName: 'input.txt', destination: badDestination, expectedSha256: '0'.repeat(64) }), fails('FILE_HASH_MISMATCH'));
  await assert.rejects(fs.stat(badDestination), { code: 'ENOENT' });
  await assert.rejects(backend.download({ remoteName: '../input.txt', destination: badDestination }), fails('INVALID_PATH'));
});

test('Downloads errors redact Basic credentials and ambiguous uploads never retry', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-cloud-mock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('upload once');
  const file = path.join(dir, 'input.txt');
  await fs.writeFile(file, bytes);
  const state = fileMock(bytes, true, { transfer: () => { throw new Error('download-password-secret'); } });
  const events = [];
  const backend = createCloudBackend(role(), { ...options(state), onJournal: event => events.push(event) });
  await assert.rejects(backend.upload({ file, requestId: 'upload' }), fails('RECONCILIATION_REQUIRED'));
  await assert.rejects(backend.upload({ file, requestId: 'new-upload' }), fails('RECONCILIATION_REQUIRED'));
  assert.equal(state.calls.filter(call => call.options.method === 'PUT').length, 1);
  assert.ok(!JSON.stringify(events).includes('download-password-secret'));
});

test('ambiguous uploads reconcile by exact bytes and explicit filename with read-only requests', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-cloud-mock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('upload identified by bytes');
  const file = path.join(dir, 'input.txt');
  await fs.writeFile(file, bytes);
  let uncertain = true;
  const state = fileMock(bytes, true, { transfer: call => {
    if (call.options.method === 'PUT' && uncertain) throw new Error('Lost receipt');
    return new Response(bytes);
  } });
  const backend = createCloudBackend(role(), options(state));
  await assert.rejects(backend.upload({ file, requestId: 'upload' }), fails('RECONCILIATION_REQUIRED'));
  uncertain = false;
  const before = state.calls.length;
  const receipt = await backend.reconcile({ requestId: 'upload', remoteName: 'input.txt' });
  assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(receipt.browserReady, false);
  assert.equal(receipt.browserPath, null);
  assert.ok(state.calls.slice(before).every(call => call.options.method === undefined || call.options.method === 'GET'));
  assert.equal(state.calls.filter(call => call.options.method === 'PUT').length, 1);
});

test('resumed named setup reconciliation checks the recorded session and never creates it again', async () => {
  const createdAt = new Date().toISOString();
  const state = normalMock({ session: ready({ display_name: 'Workflow actor', created_at: createdAt }) });
  const backend = createCloudBackend(role({ sessionId: null }), options(state));
  const result = await backend.reconcile({
    operation: 'create_session', requestId: 'saved-setup', attemptedAt: createdAt,
    name: 'Workflow actor', sessionId: SESSION,
  });
  assert.equal(result.sessionId, SESSION);
  assert.equal(backend.sessionId, SESSION);
  assert.ok(state.calls.every(call => call.options.method === 'GET'));
});
