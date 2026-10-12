import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, authorize, scopeDigest, redact, safeError } from './config.mjs';
import { MutationLedger } from './ledger.mjs';
import { WorkflowRunner, publicDoctor } from './runner.mjs';
import { summarize } from './report.mjs';
import { parseArgs, selectScenarios, main } from './cli.mjs';
import { applyIntervention } from './interventions.mjs';

async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-auth-core-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
async function config(t, changes = {}) {
  const cwd = await temp(t);
  return Object.assign(await loadConfig({ cwd, env: {}, overrides: { target: 'live' } }), {
    artifacts: path.join(cwd, 'private'), sites: { x: { url: 'https://x.com/', expectedIdentity: 'ownedqa' } },
    actors: { A: { backend: 'local', name: 'actor', profile: path.join(cwd, 'profile') }, B: {} },
    liveMutations: true, allowedActions: ['compose', 'post', 'delete'], ...changes });
}
test('private env references resolve without leaking to summaries; process secrets win', async t => {
  const cwd = await temp(t);
  await fs.writeFile(path.join(cwd, '.env'), 'WEBBRAIN_API_KEY=file-secret\nWBTEST_ACTOR_BACKEND=cloud\n');
  await fs.writeFile(path.join(cwd, '.env.accounts.json'), JSON.stringify({ actors: { A: { apiKey: 'env:WEBBRAIN_API_KEY', sessionId: 'selected' } } }));
  const cfg = await loadConfig({ cwd, configFile: '.env.accounts.json', env: { WEBBRAIN_API_KEY: 'runtime-secret' } });
  assert.equal(cfg.actors.A.apiKey, 'runtime-secret'); assert.equal(cfg.actors.A.sessionId, 'selected');
  assert.equal(JSON.stringify(summarize([{ scenario: 'x', status: 'blocked', content: 'runtime-secret', task: 'private' }])).includes('runtime-secret'), false);
});
test('literal credentials in JSON are rejected', async t => {
  const cwd = await temp(t); await fs.writeFile(path.join(cwd, '.env.accounts.json'), '{"actors":{"A":{"apiKey":"literal-secret"}}}');
  await assert.rejects(loadConfig({ cwd, configFile: '.env.accounts.json', env: {} }), { code: 'credential_reference_required' });
});
test('limits and backend selections reject invalid values instead of changing driver', async t => {
  const cwd = await temp(t);
  await assert.rejects(loadConfig({ cwd, env: { WBTEST_MAX_RUNS: '-1' } }), { code: 'invalid_configuration' });
  await assert.rejects(loadConfig({ cwd, env: { WBTEST_ACTOR_BACKEND: 'magic' } }), { code: 'invalid_configuration' });
  const cfg = await loadConfig({ cwd, env: {}, overrides: { target: 'fixtures', backend: 'cloud' } });
  assert.equal(cfg.target, 'fixtures'); assert.equal(cfg.actors.A.backend, 'cloud');
});
test('scope requires enabled actions, exact account, recipient and folder', async t => {
  const cfg = await config(t); const scenario = { actions: ['post'], requiresObserver: false };
  assert.doesNotThrow(() => authorize(cfg, scenario, cfg.sites.x));
  assert.throws(() => authorize({ ...cfg, liveMutations: false }, scenario, cfg.sites.x), { code: 'live_mutations_disabled' });
  assert.throws(() => authorize(cfg, { actions: ['share'] }, cfg.sites.x), { code: 'action_not_authorized' });
  assert.throws(() => authorize(cfg, { ...scenario, requiresObserver: true }, { ...cfg.sites.x, recipient: 'other' }), { code: 'recipient_not_authorized' });
  assert.throws(() => authorize(cfg, scenario, { ...cfg.sites.x, folderUrl: 'https://drive.google.com/other' }), { code: 'destination_not_authorized' });
});
test('display-label allowlisting cannot authorize a different delivery identity', async t => {
  const cfg = await config(t, { allowedRecipients: ['allowed@example.test'] });
  assert.throws(() => authorize(cfg, { actions: [], requiresObserver: true }, { expectedIdentity: 'ownedqa', recipient: 'allowed@example.test', recipientIdentity: 'outside@example.test' }), { code: 'recipient_not_authorized' });
  assert.doesNotThrow(() => authorize(cfg, { actions: [], requiresObserver: true }, { expectedIdentity: 'ownedqa', recipient: 'Bob QA', recipientIdentity: 'allowed@example.test' }));
});
test('an explicit environment denial overrides enabled JSON mutation settings', async t => {
  const cwd = await temp(t); await fs.writeFile(path.join(cwd, '.env.accounts.json'), '{"liveMutations":true,"allowedActions":["send"]}');
  const cfg = await loadConfig({ cwd, configFile: '.env.accounts.json', env: { WBTEST_LIVE_MUTATIONS: 'false', WBTEST_ALLOWED_ACTIONS: '' } });
  assert.equal(cfg.liveMutations, false); assert.deepEqual(cfg.allowedActions, []);
});
test('scope digest changes for account or recipient changes but not API-key rotation', async t => {
  const cfg = await config(t); const original = scopeDigest(cfg);
  assert.equal(scopeDigest({ ...cfg, actors: { ...cfg.actors, A: { ...cfg.actors.A, apiKey: 'new' } } }), original);
  assert.notEqual(scopeDigest({ ...cfg, sites: { x: { ...cfg.sites.x, expectedIdentity: 'other' } } }), original);
  assert.notEqual(scopeDigest({ ...cfg, allowedRecipients: ['different'] }), original);
});
test('ledger is durable before dispatch and blocks ambiguous replay', async t => {
  const cfg = await config(t), ledger = await MutationLedger.create(cfg, cfg.artifacts);
  const attempt = await ledger.attempt({ scenario: 'x', stage: 'publish', actor: 'A', action: 'post', marker: 'WBQA-owned' });
  assert.equal(JSON.parse(await fs.readFile(ledger.filename)).entries[0].status, 'attempted');
  await ledger.update(attempt.requestId, { status: 'ambiguous' });
  await assert.rejects(ledger.attempt({ scenario: 'x', stage: 'publish', actor: 'A', action: 'post', marker: 'WBQA-owned' }), { code: 'pending_attempt_requires_reconciliation' });
});
test('cleanup preserves immutable IDs and rejects changed scopes/ownership', async t => {
  const cfg = await config(t), ledger = await MutationLedger.create(cfg, cfg.artifacts);
  const entry = await ledger.attempt({ scenario: 'x', stage: 'publish', actor: 'A', action: 'post', marker: 'WBQA-owned' });
  const resource = await ledger.recordResource(entry, { id: '1', url: 'https://x.com/ownedqa/status/1', kind: 'post', immutable: true, threadId: 'thread', messageId: 'message', raw: 'private unrelated' }, 'ownedqa');
  assert.equal(resource.immutable, true); assert.equal(resource.threadId, 'thread'); assert.equal(resource.raw, undefined);
  await assert.rejects(ledger.recordResource({ ...entry, marker: 'different' }, resource, 'ownedqa'), { code: 'resource_ownership_changed' });
  await assert.rejects(MutationLedger.load(ledger.filename, { ...cfg, allowedActions: [] }), { code: 'cleanup_scope_changed' });
});
test('errors and artifacts redact secrets and do not grade blocked cases as passes', () => {
  const secret = 'exact-private'; const redacted = redact({ apiKey: secret, detail: `Bearer ${secret}`, token: secret, url: `https://example.org/?token=${secret}` }, [secret]);
  assert.equal(JSON.stringify(redacted).includes(secret), false);
  assert.deepEqual(safeError(new Error(secret)), { code: 'unexpected_error', status: 'failed' });
  const report = summarize([{ scenario: 'x', status: 'blocked' }, { scenario: 'mail', status: 'unsupported' }]);
  assert.equal(report.counts.passed, 0); assert.equal(report.counts.blocked, 1); assert.equal(report.counts.unsupported, 1);
});
test('CLI never silently accepts unknown scenarios/options or runs all fixtures by default', async t => {
  assert.throws(() => parseArgs(['run', '--secret', 'key']), { code: 'unknown_option' });
  assert.equal(parseArgs(['run', '--scenario=x-post-lifecycle']).scenario, 'x-post-lifecycle');
  const cfg = await config(t, { target: 'fixtures', selectedScenarios: [], selectedSites: [] });
  assert.deepEqual(selectScenarios(cfg).map(row => row.id), ['fixture-file-transfer']);
  assert.throws(() => selectScenarios({ ...cfg, selectedScenarios: ['x-post-lifecycle'] }), { code: 'no_matching_scenarios' });
});

function injectedRunner(cfg, dir, { observed = true, noDispatch = false, acknowledgeLost = false } = {}) {
  let calls = 0, opens = 0;
  const page = { url: () => 'https://x.com/', reload: async () => {} };
  const backend = { capabilities: { domObservation: true }, connect: async () => {}, doctor: async () => ({ readiness: 'ready', backend: 'local' }),
    open: async url => { opens++; return { page, tabId: 1, url }; }, close: async () => {},
    run: async () => { calls++; if (noDispatch) throw Object.assign(new Error('preflight refused'), { code: 'stale', noDispatch: true });
      if (acknowledgeLost) throw Object.assign(new Error('lost'), { status: 'ambiguous', code: 'unknown', noDispatch: false });
      return { status: 'completed', runId: 'actual-runtime-run', content: 'Everything succeeded!' }; } };
  const runner = new WorkflowRunner(cfg, dir, { backendFactory: async () => backend,
    siteCatalog: { x: { defaultUrl: 'https://x.com/', originAllowed: url => new URL(url).host === 'x.com', identity: async () => ({ matched: true }),
      observe: async () => ({ actualEffect: observed }) } }, taskPlanner: () => ({ task: 'Only the owned task', observation: { phase: 'resource' } }),
    evidenceVerifier: ({ evidence }) => ({ ok: evidence.actualEffect, reason: 'effect_unverified' }) });
  return { runner, calls: () => calls, opens: () => opens };
}
const simpleScenario = { id: 'x-test', site: 'x', kind: 'social', actions: ['post'], steps: [{ id: 'publish', action: 'post' }] };
test('runtime done without independent effect is failed and remains pending', async t => {
  const cfg = await config(t), { runner, calls } = injectedRunner(cfg, path.join(cfg.artifacts, 'one'), { observed: false });
  await runner.initialize(); const result = await runner.runScenario(simpleScenario); await runner.close();
  assert.equal(calls(), 1); assert.equal(result.status, 'failed'); assert.equal(result.code, 'effect_unverified');
  assert.equal(runner.ledger.pendingEntries().length, 1);
  const next = injectedRunner(cfg, path.join(cfg.artifacts, 'two')).runner;
  await assert.rejects(next.initialize(), { code: 'previous_run_requires_reconciliation' });
});
test('independent verified effect passes and clean scope permits another run', async t => {
  const cfg = await config(t), { runner } = injectedRunner(cfg, path.join(cfg.artifacts, 'one'));
  await runner.initialize(); const result = await runner.runScenario(simpleScenario); await runner.close();
  assert.equal(result.status, 'passed'); assert.equal(runner.ledger.pendingEntries().length, 0);
  const next = injectedRunner(cfg, path.join(cfg.artifacts, 'two')).runner; await next.initialize(); await next.close();
});
test('an empty ledger from a still-active owner cannot be stolen during preflight', async t => {
  const cfg = await config(t), first = injectedRunner(cfg, path.join(cfg.artifacts, 'one')).runner;
  await first.initialize();
  const second = injectedRunner(cfg, path.join(cfg.artifacts, 'two')).runner;
  await assert.rejects(second.initialize(), { code: 'another_harness_owns_scope' }); await first.close();
});
test('no-dispatch failures permit recovery, lost acknowledgements do not', async t => {
  const cfg = await config(t), first = injectedRunner(cfg, path.join(cfg.artifacts, 'one'), { noDispatch: true });
  await first.runner.initialize(); await first.runner.runScenario(simpleScenario); await first.runner.close();
  assert.equal(first.runner.ledger.pendingEntries().length, 0);
  const second = injectedRunner(cfg, path.join(cfg.artifacts, 'two'), { acknowledgeLost: true });
  await second.runner.initialize(); await second.runner.runScenario(simpleScenario); await second.runner.close();
  assert.equal(second.runner.ledger.pendingEntries().length, 1);
});
test('missing account scope blocks before a browser is opened', async t => {
  const cfg = await config(t, { sites: {} }), { runner, opens, calls } = injectedRunner(cfg, path.join(cfg.artifacts, 'one'));
  await runner.initialize(); const result = await runner.runScenario(simpleScenario); await runner.close();
  assert.equal(result.status, 'blocked'); assert.equal(opens(), 0); assert.equal(calls(), 0);
});
test('run budgets block before dispatch and unsupported interventions never start actions', async t => {
  const cfg = await config(t, { maxRuns: 1 }), { runner, calls } = injectedRunner(cfg, path.join(cfg.artifacts, 'one'));
  await runner.initialize(); const scenario = { ...simpleScenario, steps: [{ id: 'one', action: 'post' }, { id: 'two', action: 'post' }] };
  const result = await runner.runScenario(scenario); await runner.close();
  assert.equal(calls(), 1); assert.equal(result.code, 'run_budget_exceeded');
  await assert.rejects(applyIntervention({ capabilities: { checkpoints: false } }, {}, { kind: 'click', checkpoint: { selector: '#button' } }), { status: 'unsupported' });
});
test('public doctor reports runtime evidence without profile/account/private response fields', () => {
  const result = publicDoctor({ readiness: 'ready', extensionVersion: '40.4.1', profile: 'private', apiKey: 'secret', sourceHash: 'hash', sourceHashFiles: ['manifest.json'] });
  assert.equal(result.readiness, true); assert.equal(result.extensionVersion, '40.4.1'); assert.equal(result.apiKey, undefined); assert.equal(result.profile, undefined);
});
test('truthy false Cloud identity is refused before a session or task is started', async t => {
  const cfg = await config(t, { actors: { A: { backend: 'cloud', name: 'actor' }, B: {} } });
  cfg.sites.x.manualActorIdentityVerified = 'false';
  const { runner, calls, opens } = injectedRunner(cfg, path.join(cfg.artifacts, 'one'));
  await runner.initialize(); const result = await runner.runScenario(simpleScenario); await runner.close();
  assert.equal(result.code, 'cloud_actor_identity_confirmation_required'); assert.equal(calls(), 0); assert.equal(opens(), 0);
});


test('the same selected browser cannot be concurrently acquired with different permission scope or artifact directory', async t => {
  const cfg = await config(t), first = injectedRunner(cfg, path.join(cfg.artifacts, 'one')).runner;
  await first.initialize();
  const changed = { ...cfg, allowedActions: ['post'], artifacts: path.join(cfg.cwd, 'other-private') };
  const second = injectedRunner(changed, path.join(changed.artifacts, 'two')).runner;
  await assert.rejects(second.initialize(), { code: 'another_harness_owns_scope' }); await first.close();
});
test('noninteractive Cloud private verification blocks before dispatch even with an evidence filename', async t => {
  const cfg = await config(t, { actors: { A: { backend: 'cloud', sessionId: 'selected', name: 'actor' }, B: {} }, manualEvidenceFile: 'unused' });
  cfg.sites.x.manualActorIdentityVerified = true;
  const { runner, calls, opens } = injectedRunner(cfg, path.join(cfg.artifacts, 'one'));
  await runner.initialize(); const result = await runner.runScenario({ ...simpleScenario, steps: [{ id: 'compose', action: 'compose', expectation: 'composer' }] }); await runner.close();
  assert.equal(result.code, 'cloud_private_phase_requires_manual_evidence'); assert.equal(calls(), 0); assert.equal(opens(), 0);
});
test('a consequence stage cannot be downgraded to an unsent composer success by an intervention', async t => {
  const cfg = await config(t, { interventions: { 'x-test:publish': { kind: 'steer', text: 'Leave it unsent', expectedBody: '{marker} unsent', expectedPhase: 'composer', finishAfterStage: true, checkpoint: { selector: '#owned' } } } });
  const { runner, calls } = injectedRunner(cfg, path.join(cfg.artifacts, 'one'));
  await runner.initialize(); const backend = await runner.backend('A'); Object.assign(backend.capabilities, { checkpoints: true, interventions: true });
  const result = await runner.runScenario({ ...simpleScenario, steps: [{ id: 'publish', action: 'post', expectation: 'resource' }] }); await runner.close();
  assert.equal(result.code, 'intervention_phase_invalid'); assert.equal(calls(), 0);
});
test('telemetry retains mechanical diagnostics and drops arbitrary page/provider content', async t => {
  const cfg = await config(t), runner = injectedRunner(cfg, path.join(cfg.artifacts, 'one')).runner;
  runner.recordEvent({ stage: 'send', type: 'tool_result', code: 'target_changed', dispatched: true, content: 'private mail', tool: 'click_ax' });
  runner.recordEvent({ stage: 'send', type: 'private mail text with spaces', code: 'Bearer secret' });
  assert.equal(runner.events[0].code, 'target_changed'); assert.equal(runner.events[0].dispatched, true);
  assert.equal(JSON.stringify(runner.events).includes('private mail'), false); assert.equal(JSON.stringify(runner.events).includes('Bearer'), false);
});


test('CLI local observer setup selects only requested sites, never requires WebBrain Settings, and reports missing manual login', async t => {
  const cwd = await temp(t), opened = [], previousLog = console.log; console.log = () => {}; t.after(() => { console.log = previousLog; });
  await fs.writeFile(path.join(cwd, '.env.accounts.json'), JSON.stringify({ sites: { x: { url: 'https://x.com/home', observerUrl: 'https://x.com/qa' }, gmail: { url: 'https://mail.google.com/mail/u/0/' } } }));
  const code = await main(['setup', '--role', 'B', '--sites', 'x'], { cwd, env: { WBTEST_CONFIG: '.env.accounts.json', WBTEST_OBSERVER_BACKEND: 'local' },
    backendFactory: async role => { assert.equal(role.name, 'observer'); return { connect: async () => {}, openSetup: async () => { throw new Error('Observer must not need Settings'); },
      open: async url => opened.push(url), doctor: async () => ({ ready: true, backend: 'local' }), close: async () => {} }; } });
  assert.deepEqual(opened, ['https://x.com/qa']); assert.equal(code, 2);
});
test('CLI setup recovery uses its saved named creation attempt and never invokes session creation', async t => {
  const cwd = await temp(t), artifacts = path.join(cwd, 'private'), requestId = 'owned-request', previousLog = console.log; console.log = () => {}; t.after(() => { console.log = previousLog; });
  await fs.mkdir(artifacts); await fs.writeFile(path.join(artifacts, 'setup-A-ledger.private.json'), JSON.stringify([{ type: 'attempt', operation: 'create_session', requestId, name: 'qa', attemptedAt: new Date().toISOString() }]));
  let reconciled;
  const code = await main(['reconcile-setup', '--request-id', requestId, '--session-id', 'selected-session'], { cwd,
    env: { WBTEST_ACTOR_BACKEND: 'cloud', WBTEST_ARTIFACTS: artifacts }, backendFactory: async () => ({ reconcile: async args => { reconciled = args; }, close: async () => {} }) });
  assert.equal(code, 0); assert.equal(reconciled.operation, 'create_session'); assert.equal(reconciled.sessionId, 'selected-session');
  const saved = JSON.parse(await fs.readFile(path.join(artifacts, 'session-A.private.json'))); assert.equal(saved.createdByHarness, true); assert.equal(saved.persistent, true);
});


test('copied placeholder configuration defaults to exactly one owned fixture and lists live cases separately', async t => {
  const cwd = await temp(t); await fs.copyFile(new URL('./.env.example', import.meta.url), path.join(cwd, '.env'));
  await fs.copyFile(new URL('./config.example.json', import.meta.url), path.join(cwd, '.env.authenticated.json'));
  const cfg = await loadConfig({ cwd, env: {} }); assert.deepEqual(selectScenarios(cfg).map(row => row.id), ['fixture-file-transfer']);
  const live = await loadConfig({ cwd, env: {}, overrides: { target: 'live' } }); assert.equal(selectScenarios(live).length, 8);
  await assert.rejects(main(['run', '--target', 'live'], { cwd, env: {} }), { code: 'live_scenario_selection_required' });
});

test('paired Cloud stages use actor evidence and reserve B for receipts', async t => {
  const cfg = await config(t, { actors: { A: { backend: 'cloud', name: 'actor' }, B: { backend: 'local', name: 'observer' } }, manualEvidenceFile: 'unused' });
  Object.assign(cfg.sites.x, { manualActorIdentityVerified: true, observerIdentity: 'receiver', recipientIdentity: 'receiver', recipient: 'receiver' });
  cfg.allowedRecipients = ['receiver'];
  const { runner } = injectedRunner(cfg, path.join(cfg.artifacts, 'one'));
  runner.manualCheckpoint = async () => {};
  await runner.backend('A');
  runner.backends.A.capabilities.domObservation = false;
  const roles = [];
  runner.observe = async role => { roles.push(role); return { actualEffect: true }; };
  await runner.initialize();
  const result = await runner.runScenario({ ...simpleScenario, requiresObserver: true,
    steps: [{ id: 'publish', actor: 'A', action: 'post' }, { id: 'receipt', actor: 'B', action: 'navigation' }] });
  await runner.close();
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.deepEqual(roles, ['A', 'B']);
});

test('runner shutdown durably saves pending local receipts', async t => {
  const cfg = await config(t), { runner } = injectedRunner(cfg, path.join(cfg.artifacts, 'one'), { observed: false });
  await runner.initialize(); await runner.runScenario(simpleScenario);
  runner.backends.A.close = async ({ pendingEntries, saveReceipt }) => {
    assert.equal(pendingEntries.length, 1);
    const entry = pendingEntries[0];
    await saveReceipt(entry, { backend: 'local', source: 'installed-extension-run-journal', tabId: entry.tabId,
      requestId: entry.requestId, runId: entry.runId, status: 'completed', active: false, content: 'private' });
  };
  await runner.close();
  const ledger = await MutationLedger.load(runner.ledger.filename, cfg);
  assert.equal(ledger.pendingEntries()[0].localReceipt.status, 'completed');
  assert.equal(JSON.stringify(ledger.data).includes('private'), false);
});
