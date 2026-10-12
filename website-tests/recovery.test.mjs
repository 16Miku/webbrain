import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MutationLedger } from './ledger.mjs';
import { lockFiles, scopeDigest } from './config.mjs';
import { scenarios } from './scenarios.mjs';
import { evidenceSchema } from './sites.mjs';
import { recover } from './recovery.mjs';
import { createCloudBackend } from './backends/cloud.mjs';

const marker = 'WBQA-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
async function setup(t, site = 'x', changes = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-auth-recovery-'));
  const expectedIdentity = ['gmail', 'protonmail', 'drive'].includes(site) ? 'actor@example.test' : site === 'whatsapp' ? '+905001112233' : 'ownedqa';
  const binding = { url: site === 'x' ? 'https://x.com/ownedqa/status/123' : site === 'gmail' ? 'https://mail.google.com/mail/u/0/#all/thread12345'
    : site === 'drive' ? 'https://drive.google.com/file/d/file123456/view' : 'https://web.whatsapp.com/',
  expectedIdentity, recipient: 'receiver@example.test', recipientIdentity: site === 'whatsapp' ? '+905009998877' : 'receiver@example.test',
  observerIdentity: 'receiver@example.test', folderUrl: site === 'drive' ? 'https://drive.google.com/drive/u/0/folders/folder123456' : undefined };
  const config = { cwd: process.cwd(), target: 'live', artifacts: directory, sites: { [site]: binding }, secrets: ['mock-private-key'],
    actors: { A: { name: 'actor', backend: 'local', profile: path.join(directory, 'profile') }, B: { name: 'observer', backend: 'local' } },
    maxRuns: 20, timeoutMs: 1000, totalTimeoutMs: 10000, pollMs: 1,
    liveMutations: true, allowedActions: ['delete', 'post', 'send', 'upload'], allowedRecipients: [binding.recipientIdentity],
    allowedDestinations: binding.folderUrl ? [binding.folderUrl] : [], ...changes };
  const ledger = await MutationLedger.create(config, directory);
  t.after(async () => {
    for (const filename of lockFiles(config)) {
      const current = await fs.readFile(filename, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (current?.ledger === ledger.filename) await fs.unlink(filename);
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const scenario = scenarios.find(s => s.site === site);
  return { config, directory, ledger, scenario, binding };
}
async function capture(ctx, stageId, item, { status = 'verified' } = {}) {
  const stage = ctx.scenario.steps.find(s => s.id === stageId);
  const entry = await ctx.ledger.attempt({ scenario: ctx.scenario.id, stage: stageId, actor: 'A', action: stage.action, marker });
  await ctx.ledger.update(entry.requestId, { status, runId: `source-${randomUUID()}`, tabId: 7, completedAt: new Date().toISOString() });
  const defaultBody = stage.bodySource === 'filename' ? `${marker}.txt` : stage.bodyVariant ? `${marker} final exact text 🧠\n${stage.bodyVariant}` : `${marker} revised exact text 🧠`;
  const resource = await ctx.ledger.recordResource(entry, { immutable: true, expectedBody: defaultBody, ...item }, ctx.binding.expectedIdentity);
  return { entry, resource };
}
async function loaded(ctx) { return await MutationLedger.load(ctx.ledger.filename, ctx.config); }

function injected(ctx, options = {}) {
  const calls = { connect: [], open: [], run: [], inspect: [], reload: [], close: 0, acceptedBeforeDispatch: [] };
  const removed = new Set(options.removed || []);
  const items = () => [...ctx.ledger.data.resources, ...(options.physicalItems || [])];
  let journal;
  const backend = {
    capabilities: { domObservation: options.cloud ? false : true },
    async connect(value) { calls.connect.push(value); if (options.connectError) throw Object.assign(new Error('Private detail'), { code: options.connectError }); },
    async doctor() { return { backend: options.cloud ? 'cloud' : 'local', ready: true }; },
    async getRun(runId) { return { status: options.runtimeStatus || 'completed', runId, sessionId: ctx.config.actors.A.sessionId, finalUrl: ctx.binding.url }; },
    async inspectSavedRun(entry) { calls.inspect.push(entry.requestId); return { status: options.runtimeStatus || 'completed', runId: entry.runId, active: options.runtimeActive === true }; },
    async open(url) {
      const handle = { tabId: 7, url, page: null }; let current = url;
      const page = { url: () => current,
        async reload() { calls.reload.push(handle); },
        async evaluate(fn, args) {
          if (fn.name === 'readIdentity') return { matched: !options.wrongIdentity, actual: options.wrongIdentity ? 'outside@example.test' : ctx.binding.expectedIdentity };
          if (fn.name !== 'readObservation') throw new Error('Unexpected DOM read');
          const input = args.input;
          const targetId = input.resource?.id;
          const isRemoved = targetId && removed.has(targetId);
          const visible = options.missing ? [] : items().filter(item => ['social', 'chat'].includes(ctx.scenario.kind) ? !removed.has(item.id)
            : ctx.scenario.kind === 'mail' && isRemoved ? item.id === targetId : true);
          const matches = visible.map(item => ({
            bodyMatches: !options.wrongBody && input.body === item.expectedBody, markerCount: 1,
            hrefs: ctx.scenario.kind === 'social' ? [item.url] : [], domId: item.id,
            peerId: item.conversationId, authors: ctx.scenario.kind === 'social' ? ['/ownedqa'] : [ctx.binding.expectedIdentity],
            recipients: [ctx.binding.recipientIdentity], direction: 'outgoing', sent: true,
            attachments: options.missingAttachment ? [] : [{ present: true, media: true, nameMatches: true }],
          }));
          return { marker: input.marker, matches, count: matches.length, exactCount: matches.filter(m => m.bodyMatches).length,
            scope: { recipientMatched: true, conversationId: ctx.binding.recipientIdentity.replace(/[^0-9]/g, '') },
            composer: { count: 0, exactCount: 0, recipientMatched: true }, explicitMissing: Boolean(isRemoved && ctx.scenario.kind === 'social'),
            exactDeletedRow: Boolean(isRemoved && ctx.scenario.kind === 'chat'), inTrash: Boolean(isRemoved && ctx.scenario.kind === 'mail'),
            trashNotice: Boolean(isRemoved && ctx.scenario.kind === 'files'),
            previewAccessible: ctx.scenario.kind === 'files' && !isRemoved && input.body === items().find(item => item.id === targetId)?.expectedBody };
        } };
      handle.page = page; handle.setCurrent = url => { current = url; };
      calls.open.push(handle); return handle;
    },
    async run(input) {
      calls.run.push(input);
      const saved = await loaded(ctx);
      calls.acceptedBeforeDispatch.push(saved.data.entries.some(entry => entry.requestId === input.requestId && entry.status === 'attempted'));
      if (options.runError) throw Object.assign(new Error('mock-private-key'), { code: 'lost_response', noDispatch: options.noDispatch === true });
      const target = items().find(item => input.task.includes(JSON.stringify(item.id)));
      if (!target) throw new Error('Cleanup did not bind an exact immutable ID');
      if (!options.keepPresent) removed.add(target.id);
      if (ctx.scenario.kind === 'mail') input.handle.setCurrent(target.url.replace('#all/', '#trash/'));
      if (journal) await journal({ type: 'accepted', requestId: input.requestId, runId: `cleanup-${calls.run.length}`, tabId: input.handle.tabId });
      return { status: options.cleanupRuntimeStatus || 'completed', runId: `cleanup-${calls.run.length}` };
    },
    async close() { calls.close++; },
  };
  const backendFactory = async (_role, _config, configOptions) => { journal = configOptions.onJournal; return backend; };
  return { calls, removed, backendFactory };
}

test('empty recovery has no browser calls and makes no live pass claim', async t => {
  const ctx = await setup(t); const mock = injected(ctx);
  const report = await recover(ctx.config, ctx.directory, {}, false, mock);
  assert.equal(report.results.length, 0); assert.equal(report.counts.passed, 0); assert.equal(mock.calls.connect.length, 0);
});

test('reconcile proves one exact resource without deleting it', async t => {
  const ctx = await setup(t);
  await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' });
  const mock = injected(ctx); const report = await recover(ctx.config, ctx.directory, {}, false, mock);
  assert.equal(report.counts.blocked, 1); assert.equal(report.results[0].code, 'owned_resource_present_cleanup_pending');
  assert.equal(mock.calls.run.length, 0); assert.equal((await loaded(ctx)).pendingResources().length, 1);
});

test('local cleanup journals once, preserves exact ID/body, and verifies in the same actor handle', async t => {
  const ctx = await setup(t);
  await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' });
  const mock = injected(ctx); const report = await recover(ctx.config, ctx.directory, {}, true, mock);
  assert.equal(report.counts.passed, 1); assert.equal(report.counts.blocked, 0);
  assert.equal(mock.calls.run.length, 1); assert.deepEqual(mock.calls.acceptedBeforeDispatch, [true]);
  assert.equal(mock.calls.reload[0], mock.calls.run[0].handle);
  assert.match(mock.calls.run[0].task, /immutable ID "123"/);
  assert.ok(mock.calls.run[0].task.includes(`${marker} revised exact text 🧠`));
  const ledger = await loaded(ctx); assert.equal(ledger.pendingResources().length, 0); assert.equal(ledger.pendingEntries().length, 0);
  assert.equal(JSON.stringify(report).includes(marker), false); assert.equal(JSON.stringify(report).includes('mock-private-key'), false);
});

test('two independently owned same-key items are each bound to their exact immutable ID', async t => {
  const ctx = await setup(t);
  await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' });
  await capture(ctx, 'publish', { id: '456', url: 'https://x.com/ownedqa/status/456', kind: 'post' });
  const mock = injected(ctx); const report = await recover(ctx.config, ctx.directory, {}, true, mock);
  assert.equal(report.counts.blocked, 0, JSON.stringify(report)); assert.equal(mock.calls.run.length, 2);
  assert.ok(mock.calls.run[0].task.includes('immutable ID "123"')); assert.ok(mock.calls.run[1].task.includes('immutable ID "456"'));
  assert.equal((await loaded(ctx)).pendingResources().length, 0); assert.equal((await loaded(ctx)).pendingEntries().length, 0);
});

test('already deleted exact resource is verified without another cleanup dispatch', async t => {
  const ctx = await setup(t);
  await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' });
  const entry = await ctx.ledger.attempt({ scenario: ctx.scenario.id, stage: 'cleanup', actor: 'A', action: 'delete', marker });
  await ctx.ledger.update(entry.requestId, { status: 'ambiguous', runId: 'old-cleanup', tabId: 7 });
  const mock = injected(ctx, { removed: ['123'] });
  const report = await recover(ctx.config, ctx.directory, {}, true, mock);
  assert.equal(report.counts.blocked, 0); assert.equal(mock.calls.run.length, 0);
  assert.equal((await loaded(ctx)).pendingEntries().length, 0); assert.equal((await loaded(ctx)).pendingResources().length, 0);
});

test('mail cleanup selects original/reply/forward stages and exact bodies among multiple marked messages', async t => {
  const ctx = await setup(t, 'gmail');
  for (const [stage, id] of [['send-attachment', 'original123'], ['reply', 'reply12345'], ['forward', 'forward123']]) {
    await capture(ctx, stage, { id, messageId: id, threadId: 'thread12345', url: ctx.binding.url, kind: 'message' });
  }
  const mock = injected(ctx); const report = await recover(ctx.config, ctx.directory, {}, true, mock);
  assert.equal(report.counts.blocked, 0, JSON.stringify(report));
  assert.equal(mock.calls.run.length, 3);
  assert.deepEqual(report.results.map(result => result.stage), ['cleanup-original', 'cleanup-reply', 'cleanup-forward']);
  assert.ok(mock.calls.run[0].task.includes(`${marker} revised exact text 🧠`));
  assert.ok(mock.calls.run[1].task.includes('reply-message'));
  assert.ok(mock.calls.run[2].task.includes('forward-message'));
  assert.equal((await loaded(ctx)).pendingEntries().length, 0);
});

test('chat cleanup chooses file and text ownership separately', async t => {
  const ctx = await setup(t, 'whatsapp');
  const conversationId = '905009998877';
  await capture(ctx, 'send', { id: `true_${conversationId}@c.us_TEXT123`, conversationId, url: ctx.binding.url, kind: 'message' });
  await capture(ctx, 'send-file', { id: `true_${conversationId}@c.us_FILE123`, conversationId, url: ctx.binding.url, kind: 'message' });
  const mock = injected(ctx); const report = await recover(ctx.config, ctx.directory, {}, true, mock);
  assert.equal(report.counts.blocked, 0, JSON.stringify(report)); assert.equal(mock.calls.run.length, 2);
  assert.deepEqual(report.results.map(result => result.stage), ['cleanup-text', 'cleanup-file']);
  assert.ok(mock.calls.run[0].task.includes('revised exact text'));
  assert.ok(mock.calls.run[1].task.includes('file-transfer'));
});

test('exact chat tombstone clears only its matching delete entry, preserving another owned message', async t => {
  const ctx = await setup(t, 'whatsapp'); const conversationId = '905009998877';
  const textId = `true_${conversationId}@c.us_TEXT123`, fileId = `true_${conversationId}@c.us_FILE123`;
  await capture(ctx, 'send', { id: textId, conversationId, url: ctx.binding.url, kind: 'message' });
  await capture(ctx, 'send-file', { id: fileId, conversationId, url: ctx.binding.url, kind: 'message' });
  const pending = [];
  for (const stage of ['cleanup-text', 'cleanup-file']) {
    const entry = await ctx.ledger.attempt({ scenario: ctx.scenario.id, stage, actor: 'A', action: 'delete', marker });
    await ctx.ledger.update(entry.requestId, { status: 'ambiguous', runId: `old-${stage}`, tabId: 7 }); pending.push(entry);
  }
  const mock = injected(ctx, { removed: [textId] });
  await recover(ctx.config, ctx.directory, {}, false, mock);
  const ledger = await loaded(ctx);
  assert.equal(ledger.data.entries.find(entry => entry.requestId === pending[0].requestId).status, 'cleaned');
  assert.equal(ledger.data.entries.find(entry => entry.requestId === pending[1].requestId).status, 'accepted');
  assert.equal(ledger.pendingResources().length, 1); assert.equal(ledger.pendingResources()[0].id, fileId);
  assert.equal(mock.calls.run.length, 0);
});

test('Drive cleanup binds original filename when rename has not occurred', async t => {
  const ctx = await setup(t, 'drive');
  await capture(ctx, 'upload', { id: 'file123456', url: ctx.binding.url, kind: 'file' });
  const mock = injected(ctx); const report = await recover(ctx.config, ctx.directory, {}, true, mock);
  assert.equal(report.counts.blocked, 0, JSON.stringify(report)); assert.equal(mock.calls.run.length, 1);
  assert.ok(mock.calls.run[0].task.includes(`${marker}.txt`));
  assert.equal((await loaded(ctx)).pendingResources().length, 0);
});

test('wrong identity/body or lack of positive evidence blocks cleanup without a mutation', async t => {
  for (const condition of ['wrongIdentity', 'wrongBody', 'missing']) await t.test(condition, async t => {
    const ctx = await setup(t); await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' });
    const mock = injected(ctx, { [condition]: true }); const report = await recover(ctx.config, ctx.directory, {}, true, mock);
    assert.equal(report.counts.passed, 0); assert.equal(report.counts.blocked, 1); assert.equal(mock.calls.run.length, 0);
    assert.equal((await loaded(ctx)).pendingResources().length, 1);
  });
});

test('active scope owner blocks recovery before any browser connection', async t => {
  const ctx = await setup(t); await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' });
  const filename = path.join(ctx.config.artifacts, `${scopeDigest(ctx.config)}.lock.private.json`);
  await fs.writeFile(filename, JSON.stringify({ ledger: ctx.ledger.filename, active: true, pid: process.pid, ownerToken: 'other-live-owner' }));
  const mock = injected(ctx);
  await assert.rejects(recover(ctx.config, ctx.directory, {}, true, mock), { code: 'another_harness_owns_scope' });
  assert.equal(mock.calls.connect.length, 0); assert.equal(JSON.parse(await fs.readFile(filename)).ownerToken, 'other-live-owner');
});

test('same browser selection remains exclusive across different permissions and artifact directories', async t => {
  const first = await setup(t); await capture(first, 'publish', { id: '123', url: first.binding.url, kind: 'post' });
  const second = await setup(t, 'x', { actors: first.config.actors, allowedActions: [...first.config.allowedActions, 'reply'] });
  await capture(second, 'publish', { id: '123', url: second.binding.url, kind: 'post' });
  const firstFiles = lockFiles(first.config), secondFiles = lockFiles(second.config);
  const shared = firstFiles.filter(filename => secondFiles.includes(filename));
  assert.equal(shared.length, 1); assert.notEqual(scopeDigest(first.config), scopeDigest(second.config));
  for (const filename of firstFiles) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, JSON.stringify({ ledger: first.ledger.filename, active: true, pid: process.pid, ownerToken: 'first-owner' }));
  }
  const mock = injected(second);
  await assert.rejects(recover(second.config, second.directory, {}, true, mock), { code: 'another_harness_owns_scope' });
  assert.equal(mock.calls.connect.length, 0); assert.equal(mock.calls.run.length, 0);
  assert.equal(JSON.parse(await fs.readFile(shared[0])).ownerToken, 'first-owner');
});

test('changed mutation scope cannot load or clean an old ledger', async t => {
  const ctx = await setup(t); await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' });
  const mock = injected(ctx);
  await assert.rejects(recover({ ...ctx.config, allowedActions: [] }, ctx.directory, {}, true, mock), { code: 'cleanup_scope_changed' });
  assert.equal(mock.calls.run.length, 0);
});

test('pending terminal publication is independently captured and never republished', async t => {
  const ctx = await setup(t); await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' }, { status: 'ambiguous' });
  const mock = injected(ctx); const report = await recover(ctx.config, ctx.directory, {}, false, mock);
  assert.equal(report.results[0].code, 'dispatch_effect_independently_verified');
  assert.equal(mock.calls.run.length, 0); assert.equal((await loaded(ctx)).pendingEntries().length, 0);
  assert.equal((await loaded(ctx)).pendingResources().length, 1);
});

test('a lost publication receipt captures a new resource only after independent exact-body proof', async t => {
  for (const wrongBody of [false, true]) await t.test(String(wrongBody), async t => {
    const ctx = await setup(t);
    const entry = await ctx.ledger.attempt({ scenario: ctx.scenario.id, stage: 'publish', actor: 'A', action: 'post', marker });
    await ctx.ledger.update(entry.requestId, { status: 'ambiguous', runId: 'lost-publication', tabId: 7 });
    const physicalItems = [{ id: '123', url: ctx.binding.url, kind: 'post', expectedBody: `${marker} revised exact text 🧠` }];
    const mock = injected(ctx, { physicalItems, wrongBody });
    const report = await recover(ctx.config, ctx.directory, {}, false, mock);
    const ledger = await loaded(ctx);
    assert.equal(mock.calls.run.length, 0);
    assert.equal(ledger.data.resources.length, wrongBody ? 0 : 1);
    assert.equal(ledger.pendingEntries().length, wrongBody ? 1 : 0);
    if (!wrongBody) {
      assert.equal(ledger.data.resources[0].sourceStage, 'publish');
      assert.equal(ledger.data.resources[0].expectedBody, physicalItems[0].expectedBody);
      assert.equal(report.results[0].code, 'dispatch_effect_independently_verified');
    } else assert.equal(report.counts.passed, 0);
  });
});

test('terminal attachment-quality and duplicate failures preserve exact owned IDs for cleanup without republishing', async t => {
  for (const duplicate of [false, true]) await t.test(duplicate ? 'duplicate' : 'missing media', async t => {
    const ctx = await setup(t);
    const entry = await ctx.ledger.attempt({ scenario: ctx.scenario.id, stage: 'publish', actor: 'A', action: 'post', marker });
    await ctx.ledger.update(entry.requestId, { status: 'ambiguous', runId: 'known-terminal-publication', tabId: 7 });
    const physicalItems = [{ id: '123', url: ctx.binding.url, kind: 'post', expectedBody: `${marker} revised exact text 🧠` }];
    if (duplicate) physicalItems.push({ id: '456', url: 'https://x.com/ownedqa/status/456', kind: 'post', expectedBody: physicalItems[0].expectedBody });
    const mock = injected(ctx, { physicalItems, missingAttachment: !duplicate });
    const report = await recover(ctx.config, ctx.directory, {}, true, mock);
    const ledger = await loaded(ctx);
    assert.equal(report.counts.failed, 1, JSON.stringify(report));
    assert.equal(report.results[0].code, duplicate ? 'duplicate-marked-items' : 'test-attachment-not-confirmed');
    assert.equal(ledger.data.resources.length, physicalItems.length);
    assert.equal(ledger.data.entries.find(item => item.requestId === entry.requestId).status, 'verified');
    assert.equal(ledger.pendingResources().length, 0); assert.equal(ledger.pendingEntries().length, 0);
    assert.equal(mock.calls.run.length, physicalItems.length);
    assert.ok(mock.calls.run.every(input => input.task.includes('Delete only') && !input.task.includes('Publish this')));
  });
});

test('active or pending-input dispatches cannot be waived or cleaned', async t => {
  for (const status of ['running', 'needs_user_input']) await t.test(status, async t => {
    const ctx = await setup(t); await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' }, { status: 'ambiguous' });
    const mock = injected(ctx, { runtimeStatus: status }); const report = await recover(ctx.config, ctx.directory, {}, true, mock);
    assert.equal(mock.calls.run.length, 0); assert.equal((await loaded(ctx)).pendingEntries().length, 1);
    assert.equal(report.counts.passed, 0);
  });
});

test('a lost cleanup response stays ambiguous and repeat recovery does not issue another delete', async t => {
  const ctx = await setup(t); await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' });
  const first = injected(ctx, { runError: true }); await recover(ctx.config, ctx.directory, {}, true, first);
  assert.equal((await loaded(ctx)).pendingEntries().length, 1);
  const second = injected(ctx, { runtimeStatus: 'running' }); await recover(ctx.config, ctx.directory, {}, true, second);
  assert.equal(second.calls.run.length, 0); assert.equal((await loaded(ctx)).pendingResources().length, 1);
});

test('Cloud recovery adopts only the selected receipt and never recreates an active task', async t => {
  const ctx = await setup(t); ctx.config.actors.A = { name: 'actor', backend: 'cloud', sessionId: `brw_mock_${randomUUID()}`, apiKey: 'mock-private-key' };
  ctx.ledger = await MutationLedger.create(ctx.config, ctx.directory);
  const { entry } = await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' }, { status: 'ambiguous' });
  const mock = injected(ctx, { cloud: true, runtimeStatus: 'needs_user_input' });
  const report = await recover(ctx.config, ctx.directory, { 'request-id': entry.requestId, 'run-id': entry.runId }, false, mock);
  assert.deepEqual(mock.calls.connect[0], { reconcileRunId: entry.runId, requestId: entry.requestId, attemptedAt: entry.attemptedAt });
  assert.equal(report.counts.needs_user_input, 1); assert.equal(mock.calls.run.length, 0);
  await assert.rejects(recover(ctx.config, ctx.directory, { 'run-id': entry.runId }, false, mock), { code: 'explicit_request_id_required' });
});

test('Cloud cleanup lacking independent actor control stays unsupported', async t => {
  const ctx = await setup(t); ctx.config.actors.A = { name: 'actor', backend: 'cloud', sessionId: `brw_mock_${randomUUID()}`, apiKey: 'mock-private-key' };
  ctx.config.actors.B = {};
  ctx.ledger = await MutationLedger.create(ctx.config, ctx.directory);
  await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' });
  const mock = injected(ctx, { cloud: true }); const report = await recover(ctx.config, ctx.directory, {}, true, mock);
  assert.equal(report.counts.unsupported, 1); assert.equal(mock.calls.run.length, 0);
});

test('Cloud exact already-removed manual proof retires the resource without a controller or delete', async t => {
  const ctx = await setup(t); ctx.config.actors.A = { name: 'actor', backend: 'cloud', sessionId: `brw_mock_${randomUUID()}`, apiKey: 'mock-private-key' };
  ctx.config.actors.B = {}; ctx.config.manualEvidenceFile = path.join(ctx.directory, 'manual.private.json');
  ctx.ledger = await MutationLedger.create(ctx.config, ctx.directory);
  await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' });
  await fs.writeFile(ctx.config.manualEvidenceFile, JSON.stringify({ observations: [{
    schema: evidenceSchema, source: 'manual-confirmed-private', confirmedByOperator: true, confirmedAt: new Date().toISOString(),
    site: 'x', stage: 'cleanup', phase: 'absent', marker, url: ctx.binding.url,
    identity: { matched: true, actual: ctx.binding.expectedIdentity }, absenceConfirmed: true, count: 0, exactCount: 0, matches: [],
  }] }));
  const mock = injected(ctx, { cloud: true }); const report = await recover(ctx.config, ctx.directory, {}, true, mock);
  assert.equal(report.counts.passed, 1, JSON.stringify(report)); assert.equal(mock.calls.run.length, 0); assert.equal(mock.calls.open.length, 0);
  assert.equal((await loaded(ctx)).pendingResources().length, 0);
});

test('a lost local receipt does not prevent read-only proof that the exact resource is already gone', async t => {
  const ctx = await setup(t); await capture(ctx, 'publish', { id: '123', url: ctx.binding.url, kind: 'post' });
  const pending = await ctx.ledger.attempt({ scenario: ctx.scenario.id, stage: 'cleanup', actor: 'A', action: 'delete', marker });
  await ctx.ledger.update(pending.requestId, { status: 'ambiguous', tabId: 7, runId: 'old-cleanup' });
  const mock = injected(ctx, { removed: ['123'] });
  const original = mock.backendFactory;
  mock.backendFactory = async (...args) => {
    const backend = await original(...args);
    backend.inspectSavedRun = async () => { throw Object.assign(new Error('Old tab no longer exists'), { code: 'old_journal_unavailable' }); };
    return backend;
  };
  const report = await recover(ctx.config, ctx.directory, {}, true, mock);
  assert.equal((await loaded(ctx)).pendingResources().length, 0);
  assert.equal((await loaded(ctx)).pendingEntries().length, 1);
  assert.equal(report.counts.passed, 1); assert.equal(report.counts.blocked, 1); assert.equal(mock.calls.run.length, 0);
});

test('generic completed Cloud navigation resolves its own dispatch without claiming a workflow effect', async t => {
  const ctx = await setup(t); ctx.config.actors.A = { name: 'actor', backend: 'cloud', sessionId: `brw_mock_${randomUUID()}`, apiKey: 'mock-private-key' };
  ctx.ledger = await MutationLedger.create(ctx.config, ctx.directory);
  const entry = await ctx.ledger.attempt({ scenario: 'backend-session', stage: 'create_run', actor: 'A', action: 'navigation', marker: 'session-A' });
  await ctx.ledger.update(entry.requestId, { status: 'ambiguous', runId: 'navigation-run' });
  const mock = injected(ctx, { cloud: true }); const report = await recover(ctx.config, ctx.directory, {}, false, mock);
  assert.equal(report.counts.passed, 1); assert.equal(report.results[0].scenario, 'backend-session');
  assert.equal(report.results[0].code, 'navigation_receipt_verified'); assert.equal(mock.calls.run.length, 0);
  assert.equal((await loaded(ctx)).pendingEntries().length, 0); assert.equal((await loaded(ctx)).data.resources.length, 0);
});

async function stagedUpload(t, { savedName = 'fixture-collision-1.txt', savedHash = true, corrupted = false } = {}) {
  const ctx = await setup(t); ctx.config.actors.A = { name: 'actor', backend: 'cloud', sessionId: `brw_mock_${randomUUID()}`, apiKey: 'mock-private-key' };
  ctx.config.actors.B = {};
  ctx.ledger = await MutationLedger.create(ctx.config, ctx.directory);
  const bytes = Buffer.from('the exact operator-created staged fixture bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const entry = await ctx.ledger.attempt({ scenario: 'backend-session', stage: 'upload_file', actor: 'A', action: 'navigation', marker: 'session-A' });
  entry.sha256 = savedHash ? sha256 : undefined; entry.remoteName = savedName;
  await ctx.ledger.save();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url); calls.push({ url: String(url), method: options.method || 'GET' });
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (parsed.pathname === `/api/browser-sessions/${ctx.config.actors.A.sessionId}`) return json({ browser_session: {
      id: ctx.config.actors.A.sessionId, profile_mode: 'normal', status: 'ready', runtime_ready: true,
    } });
    if (parsed.pathname === '/api/runs') return json({ runs: [] });
    if (parsed.pathname.endsWith('/downloads-access')) return json({
      url: 'https://downloads.example.test/files/', username: 'mock-private-user', password: 'mock-private-password',
    });
    if (parsed.href === 'https://downloads.example.test/files/') return json({ entries: [{ name: 'fixture-collision-1.txt', size: bytes.length }] });
    if (parsed.href === 'https://downloads.example.test/files/fixture-collision-1.txt') return new Response(corrupted ? Buffer.from('different bytes') : bytes);
    throw new Error('Unexpected mocked upload-recovery request');
  };
  const backendFactory = async (role, _config, options) => createCloudBackend(role, {
    ...options, fetchImpl, timeoutMs: 1000, pollMs: 1, maxRuns: 5,
  });
  return { ...ctx, entry, sha256, calls, backendFactory };
}

test('Cloud staged uploads reconcile exact selected bytes without a run ID, reupload or browser task', async t => {
  const ctx = await stagedUpload(t);
  const report = await recover(ctx.config, ctx.directory, {}, false, ctx);
  assert.equal(report.counts.passed, 1, JSON.stringify(report)); assert.equal(report.results[0].code, 'upload_bytes_reconciled');
  assert.equal((await loaded(ctx)).pendingEntries().length, 0);
  assert.ok(ctx.calls.some(call => call.url === 'https://downloads.example.test/files/fixture-collision-1.txt' && call.method === 'GET'));
  assert.ok(ctx.calls.every(call => call.method === 'GET' || call.method === 'POST' && call.url.endsWith('/downloads-access')));
  assert.equal(JSON.stringify(report).includes('mock-private-password'), false);
});

test('upload recovery accepts an explicit collision-safe name but never guesses a listing entry', async t => {
  const ctx = await stagedUpload(t, { savedName: undefined });
  // The helper default is a known name; clear it to model a lost receipt.
  delete ctx.entry.remoteName; await ctx.ledger.save();
  const blocked = await recover(ctx.config, ctx.directory, {}, false, ctx);
  assert.equal(blocked.counts.blocked, 1); assert.equal(ctx.calls.length, 0);
  const recovered = await recover(ctx.config, ctx.directory, { 'remote-name': 'fixture-collision-1.txt' }, false, ctx);
  assert.equal(recovered.counts.passed, 1); assert.equal((await loaded(ctx)).pendingEntries().length, 0);
});

test('unknown upload hash or mismatched remote bytes remain pending without any mutation', async t => {
  const missing = await stagedUpload(t, { savedHash: false });
  const blocked = await recover(missing.config, missing.directory, {}, false, missing);
  assert.equal(blocked.counts.blocked, 1); assert.equal(missing.calls.length, 0); assert.equal((await loaded(missing)).pendingEntries().length, 1);
  const mismatch = await stagedUpload(t, { corrupted: true });
  const report = await recover(mismatch.config, mismatch.directory, {}, false, mismatch);
  assert.equal(report.counts.blocked, 1); assert.equal(report.results[0].code, 'FILE_HASH_MISMATCH');
  assert.equal((await loaded(mismatch)).pendingEntries().length, 1);
  assert.ok(mismatch.calls.every(call => call.method === 'GET' || call.method === 'POST' && call.url.endsWith('/downloads-access')));
});
