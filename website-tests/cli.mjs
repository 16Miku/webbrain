#!/usr/bin/env node
import fs from 'node:fs/promises';
import { suiteRoot } from './paths.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadConfig, authorize, HarnessError, safeError, redact, placeholder } from './config.mjs';
import { fixtureScenarios, runFixture } from './fixtures.mjs';
import { sites } from './sites.mjs';
import { scenarios, monitoringVariants } from './scenarios.mjs';
import { WorkflowRunner, createBackend, publicDoctor } from './runner.mjs';
import { recover } from './recovery.mjs';
import { summarize, writeSummary, sourceRevision, sourceIsDirty } from './report.mjs';

const commands = new Set(['help', 'list', 'dry-run', 'doctor', 'setup', 'reconcile-setup', 'run', 'summarize', 'reconcile', 'cleanup']);
export function parseArgs(argv) {
  const command = argv[0] || 'help';
  if (!commands.has(command)) throw new HarnessError('unknown_command');
  const args = { command };
  const allowed = new Set(['env', 'config', 'target', 'backend', 'sites', 'scenarios', 'scenario', 'role', 'report', 'name', 'run-id', 'request-id', 'session-id', 'remote-name']);
  for (let i = 1; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) throw new HarnessError('invalid_arguments');
    const [key, inline] = item.slice(2).split(/=(.*)/s);
    if (!allowed.has(key)) throw new HarnessError('unknown_option');
    const value = inline ?? argv[++i];
    if (!value || value.startsWith('--')) throw new HarnessError('option_value_missing');
    args[key] = value;
  }
  if (args.role && !['A', 'B'].includes(args.role)) throw new HarnessError('invalid_role');
  return args;
}
export function selectScenarios(config, { defaultFixture = true } = {}) {
  const catalog = config.target === 'fixtures' ? fixtureScenarios : scenarios;
  let selected = catalog.filter(row => (!config.selectedSites.length || config.selectedSites.some(site => row.site === site || row.sites?.includes(site)))
    && (!config.selectedScenarios.length || config.selectedScenarios.includes(row.id)));
  if (!selected.length) throw new HarnessError('no_matching_scenarios');
  for (const id of config.selectedScenarios) if (!catalog.some(row => row.id === id)) throw new HarnessError('unknown_scenario');
  if (defaultFixture && config.target === 'fixtures' && !config.selectedScenarios.length && !config.selectedSites.length) selected = selected.filter(row => row.id === 'fixture-file-transfer');
  return selected;
}
const help = `Authenticated WebBrain workflows (Node 22+)

node cli.mjs <command> [--env FILE] [--config PRIVATE_JSON]
Commands: list, dry-run, doctor, setup, reconcile-setup, run, summarize, reconcile, cleanup
Selection: --target fixtures|live --backend local|cloud --sites x,gmail --scenario ID
Setup: --role A|B --name LABEL (Cloud: explicitly create a normal persistent session)
Reports: --report DIRECTORY (summarize/reconcile/cleanup)
Reconciliation: --request-id ID --run-id ID (only when an ambiguous Cloud attempt lacks its run ID)

Default run: one owned local installed-extension file-transfer fixture.
Live runs require private explicit session, account, recipient and mutation configuration.
Run from website-tests/. See README.md. No live cases run in ordinary npm test.
`;

export async function main(argv = process.argv.slice(2), { cwd = suiteRoot, env = process.env, backendFactory = createBackend } = {}) {
  const args = parseArgs(argv);
  if (args.command === 'help') { console.log(help); return 0; }
  const config = await loadConfig({ envFile: args.env || '.env', configFile: args.config, env, cwd,
    overrides: { target: args.target, backend: args.backend, role: args.role, sites: args.sites, scenarios: args.scenarios || args.scenario } });
  if (args.command === 'run' && config.target === 'live' && !config.selectedSites.length && !config.selectedScenarios.length) throw new HarnessError('live_scenario_selection_required');
  const selected = ['list', 'dry-run', 'run'].includes(args.command) ? selectScenarios(config, { defaultFixture: args.command !== 'list' }) : [];
  if (args.command === 'list') {
    console.log(JSON.stringify({ target: config.target, scenarios: selected.map(row => ({ id: row.id, site: row.site, sites: row.sites,
      actions: row.actions, coverage: row.coverage, steps: row.steps?.map(stage => ({ id: stage.id, action: stage.action, actor: stage.actor })) })),
      monitoring: monitoringVariants }, null, 2)); return 0;
  }
  if (args.command === 'dry-run') {
    const plans = selected.map(row => {
      let blocker;
      if (config.target === 'live') try { authorize(config, row, config.sites[row.site]); } catch (error) { blocker = safeError(error).code; }
      return { scenario: row.id, target: config.target, backend: config.actors.A.backend, blocker, stages: row.steps?.map(s => ({ id: s.id, action: s.action, actor: s.actor })) };
    }); console.log(JSON.stringify({ networkRequests: 0, mutations: 0, plans }, null, 2)); return 0;
  }
  if (args.command === 'summarize') {
    if (!args.report) throw new HarnessError('report_directory_required');
    const report = JSON.parse(await fs.readFile(path.join(path.resolve(cwd, args.report), 'summary.json'), 'utf8'));
    console.log(JSON.stringify(summarize(report.results, { sourceRevision: report.sourceRevision, operation: report.operation, target: report.target, backends: report.backends, sourceWorktreeDirty: report.sourceWorktreeDirty }), null, 2)); return 0;
  }
  if (args.command === 'reconcile-setup') {
    const role = args.role || 'A';
    if (config.actors[role].backend !== 'cloud' || !args['request-id'] || !args['session-id']) throw new HarnessError('explicit_setup_receipt_required');
    const journal = path.join(config.artifacts, `setup-${role}-ledger.private.json`);
    const events = JSON.parse(await fs.readFile(journal, 'utf8'));
    const attempt = events.find(e => e.type === 'attempt' && e.operation === 'create_session' && e.requestId === args['request-id']);
    if (!attempt) throw new HarnessError('unknown_setup_attempt');
    const backend = await backendFactory(config.actors[role], config);
    try {
      await backend.reconcile({ ...attempt, operation: 'create_session', sessionId: args['session-id'] });
      events.push({ type: 'reconciled', requestId: attempt.requestId, sessionId: args['session-id'] });
      await fs.writeFile(journal, JSON.stringify(events, null, 2), { mode: 0o600 });
      await fs.writeFile(path.join(config.artifacts, `session-${role}.private.json`), JSON.stringify({ sessionId: args['session-id'], role, persistent: true, createdByHarness: true, lifecycle: 'preserved-until-operator-deletion' }, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ role, status: 'reconciled', operation: 'setup', readiness: 'not_checked', lifecycle: 'preserved' }));
      return 0;
    } finally { await backend.close(); }
  }
  if (args.command === 'doctor' || args.command === 'setup') {
    const role = args.role || 'A';
    const setupJournal = path.join(config.artifacts, `setup-${role}-ledger.private.json`);
    let events = [];
    if (args.command === 'setup' && config.actors[role].backend === 'cloud') {
      try { events = JSON.parse(await fs.readFile(setupJournal, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (events.some(e => e.type === 'attempt' && !events.some(later => ['accepted', 'not_delivered', 'reconciled'].includes(later.type) && later.requestId === e.requestId)))
        throw new HarnessError('setup_attempt_requires_reconciliation');
    }
    const backend = await backendFactory(config.actors[role], config, { onJournal: async event => {
      events.push(event); await fs.mkdir(config.artifacts, { recursive: true });
      await fs.writeFile(setupJournal, JSON.stringify(events, null, 2), { mode: 0o600 });
    } });
    let manualLoginPending = false;
    try {
      try { await backend.connect({ setup: args.command === 'setup', name: args.name }); }
      catch (error) {
        if (error.noDispatch === true) {
          const attempt = [...events].reverse().find(event => event.type === 'attempt');
          if (attempt) { events.push({ type: 'not_delivered', requestId: attempt.requestId });
            await fs.writeFile(setupJournal, JSON.stringify(events, null, 2), { mode: 0o600 }); }
        }
        throw error;
      }
      if (args.command === 'setup' && config.actors[role].backend === 'cloud') {
        await fs.mkdir(config.artifacts, { recursive: true });
        const inspected = await backend.inspect();
        await fs.writeFile(path.join(config.artifacts, `session-${role}.private.json`), JSON.stringify({ sessionId: backend.sessionId || inspected.sessionId || inspected.session?.sessionId,
          role, persistent: true, createdByHarness: true, lifecycle: 'preserved-until-operator-deletion' }, null, 2), { mode: 0o600 });
        console.log('Persistent session selection saved in private artifacts. The session remains available.');
      }
      if (args.command === 'setup' && config.actors[role].backend === 'local') {
        if (role === 'A' || config.actors[role].requireExtension === true) await backend.openSetup?.();
        for (const [id, row] of Object.entries(config.sites).filter(([id]) => !config.selectedSites.length || config.selectedSites.includes(id))) {
          const url = role === 'B' && !placeholder(row.observerUrl) ? row.observerUrl : row.url || sites[id]?.defaultUrl;
          if (url && sites[id]?.originAllowed(url, row)) await backend.open(url);
        }
        if (process.stdin.isTTY) {
          console.log('Configure WebBrain and log in manually. Press Enter here when finished.');
          const input = createInterface({ input: process.stdin, output: process.stdout });
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), config.totalTimeoutMs);
          try { await input.question('', { signal: controller.signal }); }
          catch { throw new HarnessError('manual_login_pending', '', 'needs_user_input'); }
          finally { clearTimeout(timer); input.close(); }
        } else { manualLoginPending = true; console.log('Interactive manual login requires a desktop terminal; no login was attempted.'); }
      }
      const doctor = publicDoctor(await backend.doctor());
      const siteChecks = [];
      if (args.command === 'doctor' && config.target === 'live') {
        for (const [id, configured] of Object.entries(config.sites).filter(([id]) => !config.selectedSites.length || config.selectedSites.includes(id))) {
          try {
            const site = sites[id]; if (!site) throw new HarnessError('unknown_site');
            const expectedIdentity = role === 'A' ? configured.expectedIdentity : configured.observerIdentity || configured.recipientIdentity;
            if (placeholder(expectedIdentity)) throw new HarnessError('account_identity_missing');
            if (backend.capabilities.domObservation === false) { siteChecks.push({ site: id, status: 'unsupported', code: 'cloud_login_requires_manual_observation' }); continue; }
            const url = role === 'B' ? configured.observerUrl || configured.url || site.defaultUrl : configured.url || configured.folderUrl || site.defaultUrl;
            if (!site.originAllowed(url, configured)) throw new HarnessError('site_origin_mismatch');
            const handle = await backend.open(url);
            const identity = await site.identity(handle.page, { ...configured, expectedIdentity });
            if (!identity.matched) throw new HarnessError(identity.reason || 'account_identity_mismatch');
            siteChecks.push({ site: id, status: 'passed', code: 'native_account_identity_verified' });
          } catch (error) { siteChecks.push({ site: id, ...safeError(error) }); }
        }
      }
      console.log(JSON.stringify(redact({ role, ...doctor, siteChecks, setupStatus: manualLoginPending ? 'needs_user_input' : undefined }, config.secrets), null, 2));
      return !manualLoginPending && doctor.readiness && siteChecks.every(check => check.status === 'passed') ? 0 : 2;
    } finally { await backend.close(); }
  }
  if (args.command === 'reconcile' || args.command === 'cleanup') {
    if (!args.report) throw new HarnessError('report_directory_required');
    const directory = path.resolve(cwd, args.report);
    const report = await recover(config, directory, args, args.command === 'cleanup');
    await fs.writeFile(path.join(directory, `${args.command}-summary.json`), JSON.stringify(redact(report, config.secrets), null, 2), { mode: 0o600 });
    console.log(JSON.stringify(redact(report, config.secrets), null, 2)); return report.counts.failed ? 1 : report.counts.blocked || report.counts.unsupported || report.counts.needs_user_input ? 2 : 0;
  }
  const directory = path.join(config.artifacts, new Date().toISOString().replace(/[:.]/g, '-'));
  const manualCheckpoint = process.stdin.isTTY ? async ({ requirement, timeoutMs }) => {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try { await input.question(`Manual browser observation required. Read ${requirement}, append actual evidence to the configured private file, then press Enter: `, { signal: controller.signal }); }
    catch { throw new HarnessError('manual_observation_pending', '', 'needs_user_input'); }
    finally { clearTimeout(timer); input.close(); }
  } : undefined;
  const runner = config.target === 'live' ? await new WorkflowRunner(config, directory, { manualCheckpoint }).initialize() : null;
  const results = [], suiteStarted = Date.now();
  let fixtureRuns = 0;
  try {
    suite: for (let repetition = 0; repetition < config.repetitions; repetition++) for (const row of selected) {
      let result;
      try {
        const remaining = config.totalTimeoutMs - (Date.now() - suiteStarted);
        if (remaining <= 0) throw new HarnessError('suite_deadline_exceeded');
        if (!runner && fixtureRuns++ >= config.maxRuns) throw new HarnessError('run_budget_exceeded');
        result = runner ? await runner.runScenario(row) : await runFixture(row, { ...config, totalTimeoutMs: remaining }, path.join(directory, `${row.id}-${repetition + 1}`));
      } catch (error) { result = { scenario: row.id, target: config.target, backend: config.actors.A.backend, ...safeError(error) }; }
      results.push({ ...result, repetition: repetition + 1 });
      // Durable live side effects require inspection before continuing a failed workflow.
      if (runner?.ledger.pendingEntries().length) break suite;
    }
  } finally { await runner?.close(); }
  const report = summarize(results, { sourceRevision: sourceRevision(config.repositoryRoot), target: config.target,
    backends: runner?.doctors, sourceWorktreeDirty: sourceIsDirty(config.repositoryRoot) });
  const sanitized = redact(report, config.secrets);
  await writeSummary(directory, sanitized);
  console.log(JSON.stringify(sanitized, null, 2));
  console.log(`Report directory: ${directory}`);
  return report.counts.failed ? 1 : report.counts.blocked || report.counts.unsupported || report.counts.needs_user_input ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(JSON.stringify(safeError(error))); process.exitCode = error?.status === 'failed' ? 1 : 2; });
}
