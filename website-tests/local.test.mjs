import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createLocalBackend } from './backends/local.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

async function rig(t, overrides = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-auth-local-unit-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const calls = [];
  let tabCount = 0;
  let started = false;
  let stopped = false;
  let polls = 0;
  const metadata = { extensionId, extensionVersion: '40.4.1', sourceHash: 'installed-source-hash',
    sourceHashFiles: ['manifest.json', 'src/background.js'], provider: 'owned-provider', model: 'owned-model',
    providerConfigured: true, providerCapabilities: { vision: false, askStreaming: false } };
  const context = {
    serviceWorkers: () => [], pages: () => [], async waitForEvent() { throw new Error('No extension worker.'); },
    async newPage() {
      let url = 'about:blank';
      let closed = false;
      const page = { url: () => url, isClosed: () => closed,
        async goto(next) { calls.push(['goto', next]); url = next; },
        async reload() { calls.push(['reload']); },
        async close() { closed = true; calls.push(['page.close']); },
        locator(selector) { return {
          async waitFor(options) { calls.push(['checkpoint', selector, options.state]); await overrides.waitFor?.(selector, options); },
          async fill(text) { calls.push(['fill', selector, text]); },
          async click() { calls.push(['click', selector]); },
          async press(text) { calls.push(['press', selector, text]); },
          async setInputFiles(file) { calls.push(['upload', selector, file]); },
          async selectOption(value) { calls.push(['selectOption', selector, value]); },
          async hover() { calls.push(['hover', selector]); },
        }; },
        mouse: { async wheel(deltaX, deltaY) { calls.push(['wheel', deltaX, deltaY]); } },
      };
      return page;
    },
    async close() { calls.push(['context.close']); },
    browser() { return browser; },
  };
  const browser = { contexts: () => [context], version: () => 'installed-chromium',
    async close() { calls.push(['browser.detach']); } };
  let requestId;
  const transport = { extensionId, downloads: overrides.downloads,
    async metadata() { return { ...metadata, ...overrides.metadata }; },
    async tabId() { return ++tabCount; },
    async close() { calls.push(['transport.close']); },
    async send(action, data) {
      calls.push([action, data]);
      if (overrides.send) {
        const supplied = await overrides.send(action, data, { started, stopped, polls, requestId });
        if (supplied !== undefined) return supplied;
      }
      if (action === 'chat_start' || action === 'continue_start') {
        started = true; requestId = data.requestId;
        return { ok: true, accepted: true, requestId };
      }
      if (action === 'abort') { stopped = true; return { ok: true }; }
      if (action === 'chat_steer') return { accepted: true };
      if (action === 'agent_run_state') {
        if (!started) return { ok: true, running: false, starting: false, runUi: overrides.prior || null };
        polls++;
        return { ok: true, running: false, starting: false,
          runUi: { requestId, runId: 'owned-run', status: stopped ? 'stopped' : 'completed',
            runSucceeded: !stopped, finalContent: 'Owned fixture completed.', events: [
              { seq: 1, type: 'tool_call', data: { name: 'get_accessibility_tree', args: { secret: 'private page body' } } },
              { seq: 2, type: 'run_complete', data: { runSucceeded: true, finalContent: 'private final body', apiKey: 'never-log' } },
            ] } };
      }
      throw new Error('Unexpected normal-runtime action.');
    },
  };
  const chromium = {
    async launchPersistentContext(dir, settings) { calls.push(['launch', dir, settings]); return context; },
    async connectOverCDP(url) { calls.push(['attach', url]); return browser; },
  };
  const role = { name: 'actor', backend: 'local', profile, provider: 'owned-provider', model: 'owned-model', ...overrides.role };
  if (role.cdpUrl) delete role.profile;
  const backend = createLocalBackend(role, { chromium, transportFactory: async () => transport,
    pollMs: 1, timeoutMs: 500, ...overrides.options });
  t.after(() => backend.close());
  return { backend, calls, profile, role, chromium, transport, metadata };
}

test('connection requires explicit ownership and rejects credential-bearing or untrusted CDP', async () => {
  for (const role of [{}, { cdpUrl: 'http://remote.example:9222' }, { cdpUrl: 'http://name:secret@127.0.0.1:9222' },
    { profile: 'relative-profile' }, { profile: path.resolve('Google/Chrome/User Data/Default') }]) {
    await assert.rejects(createLocalBackend(role).connect(), /requires an explicit|Non-loopback|Credentials|absolute|normal browser/);
  }
});

test('attached browser disconnects and preserves its user-owned context', async t => {
  const { backend, calls } = await rig(t, { role: { cdpUrl: 'http://127.0.0.1:9222' } });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  assert.equal(handle.tabId, 1);
  await backend.close();
  assert.ok(calls.some(call => call[0] === 'browser.detach'));
  assert.ok(calls.some(call => call[0] === 'page.close'));
  assert.equal(calls.filter(call => call[0] === 'context.close').length, 0);
});

test('a failed second profile claim cannot release the original owner', async t => {
  const original = await rig(t);
  await original.backend.connect();
  const makeOther = () => createLocalBackend(original.role, { chromium: original.chromium, transportFactory: async () => original.transport });
  await assert.rejects(makeOther().connect(), /already owned/);
  await assert.rejects(makeOther().connect(), /already owned/);
  await original.backend.close();
  const next = makeOther();
  await next.connect();
  await next.close();
});

test('doctor reports installed source scope and expected runtime metadata without credential configs', async t => {
  const { backend } = await rig(t, { metadata: { apiKey: 'config-secret-must-not-cross', model: 'different-model' }, role: { model: undefined } });
  await backend.connect();
  const report = await backend.doctor();
  assert.equal(report.model, 'different-model');
  assert.equal(report.sourceHash, 'installed-source-hash');
  assert.deepEqual(report.sourceHashFiles, ['manifest.json', 'src/background.js']);
  assert.equal(report.inferenceChecked, false);
  assert.equal(report.capabilities.continuation, true);
  assert.equal(JSON.stringify(report).includes('config-secret-must-not-cross'), false);
});

test('configured model mismatch fails safely and releases only the dedicated browser', async t => {
  const { backend, calls } = await rig(t, { metadata: { model: 'different-model' } });
  await assert.rejects(backend.connect(), /active model differs/);
  assert.equal(calls.filter(call => call[0] === 'context.close').length, 1);
  assert.equal(calls.filter(call => call[0] === 'browser.detach').length, 0);
});

test('setup allows manual provider selection and opens an owned real Settings tab while runs remain blocked', async t => {
  const { backend, metadata, calls } = await rig(t, { role: { provider: 'required-provider', model: 'required-model' } });
  await backend.connect({ setup: true });
  const setup = await backend.openSetup();
  assert.equal(setup.url, `chrome-extension://${extensionId}/src/ui/settings.html`);
  assert.equal(setup.extensionId, extensionId);
  assert.equal((await backend.doctor()).readiness, 'not_ready');
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  await assert.rejects(backend.run({ handle, task: 'Read.' }), error => error.status === 'blocked' && error.noDispatch === true);
  assert.equal(calls.some(call => ['chat_start', 'update_provider', 'set_active_provider'].includes(call[0])), false);
  metadata.provider = 'required-provider';
  metadata.model = 'required-model';
  assert.equal((await backend.doctor()).readiness, 'ready');
  assert.equal((await backend.run({ handle, task: 'Read.' })).status, 'completed');
  await backend.close();
  assert.equal(setup.page.isClosed(), true, 'Settings belongs to the harness and closes with it.');
});

test('setup permits an unconfigured provider but never grants runtime readiness', async t => {
  const { backend, calls } = await rig(t, { metadata: { providerConfigured: false } });
  await backend.connect({ setup: true });
  assert.equal((await backend.doctor()).readiness, 'not_ready');
  await backend.openSetup();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  await assert.rejects(backend.run({ handle, task: 'Read.' }), error => error.noDispatch === true);
  assert.equal(calls.some(call => call[0] === 'chat_start'), false);
});

test('DOM-only observer cannot open extension setup', async t => {
  const { backend, calls } = await rig(t, { role: { name: 'observer' }, options: { transportFactory: undefined } });
  await backend.connect({ setup: true });
  await assert.rejects(backend.openSetup(), error => error.status === 'blocked' && error.code === 'local_setup_unavailable');
  assert.equal(calls.some(call => call[0] === 'goto' && call[1].startsWith('chrome-extension:')), false);
});

test('expected extension version and installed build fingerprint are enforced without changing settings', async t => {
  for (const role of [{ expectedVersion: 'different-version' }, { expectedBuild: 'different-fingerprint' },
    { expectedBuild: 'installed-source-hash', sourceHash: 'conflicting-alias' }]) {
    const { backend, calls } = await rig(t, { role });
    await assert.rejects(backend.connect(), error => error.status === 'blocked');
    assert.equal(calls.some(call => ['chat_start', 'update_provider', 'set_active_provider'].includes(call[0])), false);
  }
  let preparationCalled = false;
  const { backend } = await rig(t, { role: { expectedBuild: 'different-fingerprint' }, options: {
    fixture: { async prepare() { preparationCalled = true; } },
  } });
  await assert.rejects(backend.connect({ setup: true }), error => error.status === 'blocked');
  assert.equal(preparationCalled, false, 'Fingerprint checks precede even an explicitly requested fixture setup.');
});

test('version or fingerprint changes after connection block the next run before dispatch', async t => {
  const { backend, metadata, calls } = await rig(t, { role: { expectedVersion: '40.4.1', expectedBuild: 'installed-source-hash' } });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  metadata.extensionVersion = 'changed-version';
  assert.equal((await backend.doctor()).readiness, 'not_ready');
  await assert.rejects(backend.run({ handle, task: 'Read.' }), error => error.status === 'blocked' && error.noDispatch === true);
  metadata.extensionVersion = '40.4.1';
  metadata.sourceHash = 'changed-fingerprint';
  assert.equal((await backend.doctor()).readiness, 'not_ready');
  await assert.rejects(backend.run({ handle, task: 'Read.' }), error => error.status === 'blocked' && error.noDispatch === true);
  assert.equal(calls.some(call => call[0] === 'chat_start'), false);
});

test('observer can independently inspect DOM with no provider, and cannot act', async t => {
  const { backend, calls } = await rig(t, { role: { name: 'observer' }, metadata: { providerConfigured: false } });
  await backend.connect();
  assert.equal((await backend.doctor()).readiness, 'ready');
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  await backend.checkpoint({ handle, selector: '#confirmation' });
  await assert.rejects(backend.run({ handle, task: 'Publish.' }), /read-only Ask/);
  await assert.rejects(backend.intervene({ handle, kind: 'click', selector: '#publish' }), /cannot simulate/);
  assert.equal(calls.some(call => call[0] === 'chat_start'), false);
});

test('busy selected tab is not taken over, started or stopped', async t => {
  const { backend, calls } = await rig(t, { send: action => action === 'agent_run_state'
    ? { ok: true, running: true, runUi: { requestId: 'user-owned-run', status: 'running' } } : undefined });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  await assert.rejects(backend.run({ handle, task: 'Read the owned fixture.' }), /already has an active/);
  assert.equal(calls.some(call => ['chat_start', 'abort'].includes(call[0])), false);
  await assert.rejects(backend.stop('user-owned-run'), /currently owned/);
});

test('events are sequenced and redacted while final completion retains private scoring content', async t => {
  const { backend, calls } = await rig(t);
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  const updates = [];
  const result = await backend.run({ handle, task: 'Read the fixture.', requestId: 'own-request', onUpdate: update => updates.push(update) });
  assert.equal(result.status, 'completed');
  assert.equal(result.delivered, true);
  assert.equal(result.content, 'Owned fixture completed.');
  assert.deepEqual(updates.map(update => update.seq), [1, 2]);
  assert.equal(updates[0].data.name, 'get_accessibility_tree');
  assert.equal(JSON.stringify(updates).includes('private'), false);
  assert.equal(JSON.stringify(updates).includes('never-log'), false);
  const start = calls.find(call => call[0] === 'chat_start')[1];
  assert.equal(start.tabId, handle.tabId);
  assert.equal(start.requestId, 'own-request');
  await assert.rejects(backend.run({ handle, task: 'Replay.', requestId: 'own-request' }), /already been submitted/);
});

test('journal repeats are deduplicated and an evicted sequence is reported honestly', async t => {
  let stateCalls = 0;
  const { backend } = await rig(t, { send(action, data, state) {
    if (action !== 'agent_run_state' || !state.started) return undefined;
    stateCalls++;
    return { ok: true, running: stateCalls < 3, runUi: {
      requestId: data.requestId, runId: 'owned-run', status: stateCalls < 3 ? 'running' : 'completed',
      runSucceeded: true, finalContent: 'Complete', events: stateCalls < 3
        ? [{ seq: 1, type: 'tool_call', data: { name: 'read' } }]
        : [{ seq: 5, type: 'run_complete', data: { runSucceeded: true } }],
    } };
  } });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  const result = await backend.run({ handle, task: 'Read.' });
  assert.deepEqual(result.updates.map(update => [update.type, update.seq]), [['tool_call', 1], ['event_gap', 4], ['run_complete', 5]]);
});

test('matching run can be steered and stopped through normal runtime messages', async t => {
  const { backend, calls } = await rig(t, { send(action, data, state) {
    if (action !== 'agent_run_state' || !state.started || state.stopped) return undefined;
    return { ok: true, running: true, runUi: { requestId: state.requestId, runId: 'owned-run', status: 'running',
      events: [{ seq: 1, type: 'tool_call', data: { name: 'get_accessibility_tree' } }] } };
  } });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  const result = await backend.run({ handle, task: 'Read.', requestId: 'steer-owned', async onUpdate(update) {
    if (update.type !== 'tool_call') return;
    await assert.rejects(backend.run({ handle, task: 'Concurrent takeover.' }), /already owns/);
    await backend.steer({ handle, task: 'Use only the visible fixture heading.' });
    await backend.stop(handle);
  } });
  assert.equal(result.status, 'stopped');
  const steering = calls.find(call => call[0] === 'chat_steer')[1];
  assert.equal(steering.tabId, handle.tabId);
  assert.equal(steering.requestId, 'steer-owned');
  assert.equal(steering.text, 'Use only the visible fixture heading.');
  assert.equal(calls.filter(call => call[0] === 'abort').length, 1);
});

test('foreign run discovered after acceptance is never aborted', async t => {
  const { backend, calls } = await rig(t, { send(action, data, state) {
    if (action === 'agent_run_state' && state.started) return { ok: true, running: true,
      runUi: { requestId: 'foreign-request', runId: 'foreign-run', status: 'running' } };
  } });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  await assert.rejects(backend.run({ handle, task: 'Read.' }), /different WebBrain run/);
  assert.equal(calls.some(call => call[0] === 'abort'), false);
});

test('continuation is explicitly tied to the last run in the owned tab', async t => {
  const { backend, calls } = await rig(t, { prior: { requestId: 'prior-request', runId: 'prior-run', status: 'clarification_required' } });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  await assert.rejects(backend.run({ handle, continueFrom: 'foreign-run' }), /current run in this exact tab/);
  const result = await backend.run({ handle, continueFrom: 'prior-run' });
  assert.equal(result.status, 'completed');
  assert.equal(calls.filter(call => call[0] === 'continue_start').length, 1);
  assert.equal(calls.filter(call => call[0] === 'chat_start').length, 0);
});

test('explicit human simulation consumes a checkpoint and rejects foreign handles', async t => {
  const { backend, calls } = await rig(t);
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  await assert.rejects(backend.intervene({ handle, kind: 'fill', selector: '#draft', text: 'human draft' }), /checkpoint/);
  await backend.checkpoint({ handle, selector: '#ready' });
  await backend.intervene({ handle, kind: 'fill', selector: '#draft', text: 'human draft' });
  await assert.rejects(backend.intervene({ handle, kind: 'click', selector: '#commit' }), /checkpoint/);
  await assert.rejects(backend.checkpoint({ handle: { ...handle }, selector: '#ready' }), /does not belong/);
  assert.equal(calls.filter(call => call[0] === 'fill').length, 1);
  assert.equal(calls.filter(call => call[0] === 'click').length, 0);
});

test('active checkpoint waits for the exact accepted run to actually begin before accepting an already visible selector', async t => {
  let releaseAcceptance, sawAttempt, sawAccepted;
  const acceptance = new Promise(resolve => { releaseAcceptance = resolve; });
  const attempted = new Promise(resolve => { sawAttempt = resolve; });
  const accepted = new Promise(resolve => { sawAccepted = resolve; });
  let actuallyRunning = false;
  const { backend, calls } = await rig(t, {
    options: { onJournal(event) { if (event.type === 'attempt') sawAttempt(); if (event.type === 'accepted') sawAccepted(); } },
    async send(action, data, state) {
      if (action === 'chat_start') { await acceptance; return undefined; }
      if (action !== 'agent_run_state' || state.stopped || !data.requestId) return undefined;
      if (!state.started) return { ok: true, running: false, starting: false };
      return { ok: true, running: actuallyRunning, starting: !actuallyRunning, startingRequestId: state.requestId,
        runUi: { requestId: state.requestId, runId: 'actual-owned-run', status: 'running', events: [] } };
    },
    waitFor() { assert.equal(actuallyRunning, true, 'A visible composer cannot satisfy a checkpoint during runtime preflight.'); },
  });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  const running = backend.run({ handle, task: 'Read.', requestId: 'active-checkpoint-owned' });
  const checkpointing = backend.checkpoint({ handle, selector: '#visible-composer', requireActiveRun: true });
  await attempted;
  assert.equal(calls.some(call => call[0] === 'checkpoint'), false);
  releaseAcceptance();
  await accepted;
  assert.equal(calls.some(call => call[0] === 'checkpoint'), false, 'Acceptance alone is not proof the Agent has begun running.');
  actuallyRunning = true;
  const checkpoint = await checkpointing;
  assert.equal(checkpoint.runtimeRunning, true);
  assert.equal(checkpoint.requestId, 'active-checkpoint-owned');
  assert.equal(checkpoint.runId, 'actual-owned-run');
  assert.equal(JSON.stringify(checkpoint).includes('Read.'), false);
  await backend.steer({ handle, task: 'Read the fixture heading only.' });
  await backend.stop(handle);
  assert.equal((await running).status, 'stopped');
});

test('an active checkpoint that misses a terminal run blocks rather than steering stale UI', async t => {
  const { backend, calls } = await rig(t);
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  const running = backend.run({ handle, task: 'Read.' });
  await assert.rejects(backend.checkpoint({ handle, selector: '#visible-composer', requireActiveRun: true }), error =>
    error.status === 'blocked' && error.code === 'local_checkpoint_missed');
  assert.equal((await running).status, 'completed');
  assert.equal(calls.some(call => call[0] === 'chat_steer'), false);
  assert.equal(calls.some(call => call[0] === 'checkpoint'), false);
});

test('a foreign active run can never satisfy the owned runtime checkpoint', async t => {
  let foreign = false;
  const { backend, calls } = await rig(t, { send(action, data, state) {
    if (action !== 'agent_run_state' || !state.started || state.stopped) return undefined;
    return { ok: true, running: true, runUi: { requestId: foreign ? 'user-owned-foreign' : state.requestId,
      runId: foreign ? 'foreign-run' : 'owned-run', status: 'running',
      events: [{ seq: 1, type: 'tool_call', data: { name: 'get_accessibility_tree' } }] } };
  } });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  await backend.run({ handle, task: 'Read.', async onUpdate(update) {
    if (update.type !== 'tool_call') return;
    foreign = true;
    await assert.rejects(backend.checkpoint({ handle, selector: '#composer', requireActiveRun: true }), error =>
      error.status === 'blocked' && error.code === 'local_checkpoint_missed');
    foreign = false;
    await backend.stop(handle);
  } });
  assert.equal(calls.some(call => call[0] === 'checkpoint'), false);
  assert.equal(calls.some(call => call[0] === 'chat_steer'), false);
});

test('active checkpoint rechecks run identity after the selector resolves', async t => {
  let ended = false;
  const { backend, calls } = await rig(t, { send(action, data, state) {
    if (action !== 'agent_run_state' || !state.started) return undefined;
    return { ok: true, running: !ended, runUi: { requestId: state.requestId, runId: 'owned-run',
      status: ended ? 'completed' : 'running', runSucceeded: ended, events: [] } };
  }, waitFor() { ended = true; } });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  const running = backend.run({ handle, task: 'Read.' });
  await assert.rejects(backend.checkpoint({ handle, selector: '#late-composer', requireActiveRun: true }), error =>
    error.status === 'blocked' && error.code === 'local_checkpoint_missed');
  assert.equal((await running).status, 'completed');
  assert.equal(calls.some(call => call[0] === 'chat_steer'), false);
});

test('active checkpoint deadline blocks when its accepted request never begins running', async t => {
  const { backend, calls } = await rig(t, { send(action, data, state) {
    if (action !== 'agent_run_state' || !state.started || state.stopped) return undefined;
    return { ok: true, running: false, starting: true, startingRequestId: state.requestId,
      runUi: { requestId: state.requestId, status: 'running', events: [] } };
  } });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  const running = backend.run({ handle, task: 'Read.' });
  await assert.rejects(backend.checkpoint({ handle, selector: '#composer', requireActiveRun: true, timeoutMs: 20 }), error =>
    error.status === 'blocked' && error.code === 'local_checkpoint_missed');
  assert.equal(calls.some(call => call[0] === 'checkpoint'), false);
  await backend.stop(handle);
  assert.equal((await running).status, 'stopped');
});

test('attachments use the installed chat protocol and never execute uploaded files', async t => {
  const { backend, profile } = await rig(t);
  const textFile = path.join(profile, 'owned.txt');
  const scriptFile = path.join(profile, 'reject.exe');
  await fs.writeFile(textFile, 'Owned plain text attachment.');
  await fs.writeFile(scriptFile, 'Never execute this.');
  assert.deepEqual(await backend.attachFile(textFile), { name: 'owned.txt', kind: 'text', textContent: 'Owned plain text attachment.' });
  await assert.rejects(backend.attachFile(scriptFile), /WebBrain-supported/);
});

test('connection errors redact token and URL authentication before propagating', async t => {
  const { backend } = await rig(t, { options: { transportFactory: async () => {
    throw new Error('apiKey=actual-private-value Bearer actual-private-token http://name:actual-password@127.0.0.1/');
  } } });
  await assert.rejects(backend.connect(), error => !error.message.includes('actual-') && error.message.includes('[redacted]'));
});

test('saved journal inspection binds exact IDs without taking ownership or aborting', async t => {
  const { backend, calls } = await rig(t, { prior: { requestId: 'saved-request', runId: 'saved-run',
    status: 'completed', runSucceeded: true, finalContent: 'private body', events: [] } });
  await backend.connect();
  const metadata = await backend.inspectSavedRun({ tabId: 31, runId: 'saved-run', requestId: 'saved-request' });
  assert.equal(metadata.delivered, true);
  assert.equal(metadata.source, 'installed-extension-run-journal');
  assert.equal(JSON.stringify(metadata).includes('private body'), false);
  await assert.rejects(backend.inspectSavedRun({ tabId: 31, runId: 'different-run', requestId: 'saved-request' }), /does not match/);
  assert.equal(calls.some(call => ['abort', 'chat_start', 'continue_start'].includes(call[0])), false);
});

test('download evidence uses one fresh marked file, exact resource binding and actual bytes', async t => {
  const marker = 'WBQA-12345678-1234-1234-1234-123456789abc';
  const filename = `${marker}.txt`;
  const data = Buffer.from('Owned download fixture bytes.');
  const { createHash } = await import('node:crypto');
  const checksum = createHash('sha256').update(data).digest('hex');
  let rows = [];
  const { backend, profile } = await rig(t, { downloads: async () => rows });
  const actualFile = path.join(profile, filename);
  await fs.writeFile(actualFile, data);
  await backend.connect();
  const handle = await backend.open('https://drive.google.com/file/d/owned-resource-id/view');
  const afterTimestamp = new Date(Date.now() - 1000).toISOString();
  rows = [{ filename: actualFile, state: 'complete', exists: true, startTime: new Date().toISOString(),
    url: 'https://owned-cdn.example/download', referrer: '' }];
  const input = { handle, marker, filename, resourceId: 'owned-resource-id', expectedSha256: checksum, afterTimestamp };
  assert.deepEqual(await backend.collectDownload(input), { independent: true, resourceId: 'owned-resource-id', sha256: checksum, bytes: data.length });
  await assert.rejects(backend.collectDownload({ ...input, resourceId: 'different-resource-id' }), error => error.status === 'unsupported');
  rows.push({ ...rows[0] });
  await assert.rejects(backend.collectDownload(input), /unique_completed_file_unproven/);
  rows = [rows[0]];
  rows[0].startTime = new Date(Date.now() - 5000).toISOString();
  await assert.rejects(backend.collectDownload(input), /unique_completed_file_unproven/);
});

test('human text selection and scroll use explicit native input after checkpoints', async t => {
  const { backend, calls } = await rig(t);
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  await backend.checkpoint({ handle, selector: '#ready' });
  await backend.intervene({ handle, kind: 'select', selector: '#draft' });
  assert.ok(calls.some(call => call[0] === 'press' && call[2] === 'ControlOrMeta+A'));
  await backend.checkpoint({ handle, selector: '#ready' });
  await backend.intervene({ handle, kind: 'scroll', deltaX: 0, deltaY: 450 });
  assert.ok(calls.some(call => call[0] === 'wheel' && call[2] === 450));
  await backend.checkpoint({ handle, selector: '#ready' });
  await assert.rejects(backend.intervene({ handle, kind: 'scroll', deltaY: 100000 }), /bounded/);
});

test('DOM-only observer needs no installed extension or provider, and cannot issue any runs', async t => {
  const { backend, calls } = await rig(t, { role: { name: 'observer' }, options: { transportFactory: undefined } });
  await backend.connect();
  const report = await backend.doctor();
  assert.equal(report.readiness, 'ready');
  assert.equal(report.extensionVersion, null);
  assert.equal(report.sourceHash, null);
  assert.equal(report.provider, null);
  assert.equal(report.capabilities.continuation, false);
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  assert.equal(handle.tabId, null);
  await backend.checkpoint({ handle, selector: '#ready' });
  await assert.rejects(backend.run({ handle, mode: 'ask', task: 'Read.' }), error => error.noDispatch === true);
  assert.equal(calls.some(call => call[0] === 'chat_start'), false);
});

test('actor cannot fall back to DOM-only when the real extension is missing', async t => {
  const { backend } = await rig(t, { options: { transportFactory: undefined } });
  await assert.rejects(backend.connect(), error => error.status === 'blocked' && /No installed WebBrain/.test(error.message));
});

test('lost chat acknowledgement remains ambiguous and is never retried or aborted blindly', async t => {
  const journal = [];
  const { backend, calls } = await rig(t, { options: { onJournal: event => journal.push(event.type) },
    send: action => { if (action === 'chat_start') throw new Error('Acknowledgement connection lost after delivery.'); } });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  await assert.rejects(backend.run({ handle, requestId: 'lost-ack', task: 'Read.' }), error =>
    error.status === 'ambiguous' && error.ambiguous === true && error.noDispatch === false);
  assert.deepEqual(journal, ['attempt', 'ambiguous']);
  await assert.rejects(backend.run({ handle, requestId: 'lost-ack', task: 'Read again.' }), /already been submitted/);
  assert.equal(calls.filter(call => call[0] === 'chat_start').length, 1);
  assert.equal(calls.some(call => call[0] === 'abort'), false);
});

test('explicit rejected acceptance is the only post-send proof of no dispatch', async t => {
  const { backend } = await rig(t, { send: action => action === 'chat_start' ? { accepted: false, error: 'Busy reservation rejected.' } : undefined });
  await backend.connect();
  const handle = await backend.open('http://127.0.0.1:5000/owned-fixture');
  await assert.rejects(backend.run({ handle, task: 'Read.' }), error => error.status === 'blocked' && error.noDispatch === true);
});

test('remote CDP download cannot be certified by a coincidental local file', async t => {
  const { backend } = await rig(t, { role: { cdpUrl: 'https://trusted-debugger.example', trustRemoteCdp: true } });
  await backend.connect();
  const handle = await backend.open('https://drive.google.com/file/d/owned-resource-id/view');
  await assert.rejects(backend.collectDownload({ handle }), error => error.status === 'blocked'
    && error.code === 'download_remote_filesystem_unavailable');
});

test('installed MV3 extension reports real source and attached-browser detach preserves Chrome', {
  skip: process.env.WEBBRAIN_LOCAL_SMOKE !== '1', timeout: 60000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-auth-local-installed-'));
  const extensionPath = fileURLToPath(new URL('../src/chrome/', import.meta.url));
  let providerRequests = 0;
  let observedActualPage = false;
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      providerRequests++;
      const observation = (input.messages || []).findLast(message => message.role === 'tool');
      const actualPage = observation && JSON.stringify(observation.content).includes('Owned visible confirmation.');
      if (actualPage) observedActualPage = true;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: `owned-${providerRequests}`, object: 'chat.completion', model: input.model,
        choices: [{ index: 0, finish_reason: observation ? 'stop' : 'tool_calls', message: observation
          ? { role: 'assistant', content: actualPage ? 'Owned visible confirmation.' : 'The owned observation was unavailable.' }
          : { role: 'assistant', content: '', tool_calls: [{ id: 'owned-read', type: 'function',
            function: { name: 'get_accessibility_tree', arguments: '{"filter":"visible"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Owned local fixture</title><h1 id="ready">Owned visible confirmation.</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/fixture`;
  let ownerContext;
  let attachedBackend;
  t.after(async () => {
    await attachedBackend?.close();
    await ownerContext?.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  });
  ownerContext = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--remote-debugging-port=0'] });
  const retainedPage = await ownerContext.newPage();
  await retainedPage.goto(fixtureUrl);
  const activePort = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0];
  const cdpUrl = `http://127.0.0.1:${activePort}`;
  attachedBackend = createLocalBackend({ name: 'actor', backend: 'local', cdpUrl,
    provider: 'openrouter', model: 'minimax/minimax-m3' }, { timeoutMs: 20000, pollMs: 100,
    fixture: { async prepare({ extensionPage, send }) {
      // These are ordinary settings in a disposable test-owned profile. Gates,
      // tools, Agent methods and the installed extension remain untouched.
      await extensionPage.evaluate(async () => chrome.storage.local.set({ helpImproveWebBrain: false,
        autoScreenshot: false, screenshotFallback: false, openaiAskStreamingEnabled: false,
        userMemoryAutoLearn: false, tracingEnabled: false }));
      const updated = await send('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3',
        shareQueriesForResearch: false, enabled: true, supportsAskStreaming: false } });
      assert.equal(updated.ok, true);
      assert.equal((await send('set_active_provider', { providerId: 'openrouter' })).ok, true);
    } } });
  await attachedBackend.connect({ setup: true });
  const doctor = await attachedBackend.doctor();
  assert.equal(doctor.readiness, 'ready');
  assert.match(doctor.sourceHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(doctor.sourceHashFiles, ['manifest.json', 'src/background.js', 'src/agent/agent.js', 'src/providers/manager.js']);
  assert.match(doctor.extensionVersion, /^\d+\.\d+\.\d+$/);
  t.diagnostic(`Installed version=${doctor.extensionVersion}; sourceHash=${doctor.sourceHash}; scope=${doctor.sourceHashScope}`);
  const observed = await attachedBackend.open(fixtureUrl);
  await attachedBackend.checkpoint({ handle: observed, selector: '#ready' });
  assert.equal(await observed.page.locator('#ready').innerText(), 'Owned visible confirmation.');
  const completed = await attachedBackend.run({ handle: observed, mode: 'ask', task: 'Read the visible fixture heading and repeat its exact text.' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.content, 'Owned visible confirmation.');
  assert.equal(completed.delivered, true);
  assert.ok(providerRequests >= 2 && observedActualPage, 'The real installed Agent must read the owned page before the deterministic provider answers.');
  assert.ok(completed.updates.some(update => update.type === 'tool_result' && update.data.name === 'get_accessibility_tree'));
  await attachedBackend.close();
  attachedBackend = null;
  assert.equal(retainedPage.isClosed(), false, 'A page created before attachment remains owned by the browser owner.');
  assert.equal(await retainedPage.locator('#ready').innerText(), 'Owned visible confirmation.');
  const stillAlive = await fetch(`${cdpUrl}/json/version`);
  assert.equal(stillAlive.status, 200, 'CDP detachment leaves the Chrome process alive.');
});
