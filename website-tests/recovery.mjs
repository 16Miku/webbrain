import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { authorize, HarnessError, lockFiles, placeholder, redact, safeError } from './config.mjs';
import { MutationLedger } from './ledger.mjs';
import { WorkflowRunner, createBackend, publicDoctor } from './runner.mjs';
import { sites, normalizeIdentity } from './sites.mjs';
import { scenarios, planTask, verifyEvidence } from './scenarios.mjs';
import { summarize, sourceRevision } from './report.mjs';

const TERMINAL = new Set(['completed', 'failed', 'aborted', 'stopped', 'cancelled']);
const pendingInput = value => ['needs_user_input', 'clarification_required'].includes(value);
const fail = code => { throw new HarnessError(code); };
const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('scope_lock_owner_unverified');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}
function stageFor(scenario, value) {
  if (!scenario?.steps) return null;
  return scenario.steps.find(stage => stage.id === value)
    || [...scenario.steps].sort((a, b) => b.id.length - a.id.length)
      .find(stage => value === `${stage.id}-continue` || value?.startsWith(`${stage.id}-recovery-`));
}
function sourceStage(ledger, scenario, resource) {
  const source = ledger.data.entries.find(entry => entry.requestId === resource.requestId);
  const stage = stageFor(scenario, resource.sourceStage || source?.stage);
  if (!stage?.captureResource) fail('resource_source_stage_unproven');
  return stage;
}
function keyFor(ledger, scenario, resource) {
  const stage = sourceStage(ledger, scenario, resource);
  return stage.captureResourceKey || stage.resourceKey || stage.id;
}
function cleanupStage(ledger, scenario, resource) {
  const key = keyFor(ledger, scenario, resource);
  const stage = scenario.steps.find(item => item.action === 'delete' && item.resourceKey === key);
  if (!stage) throw new HarnessError('cleanup_not_supported', '', 'unsupported');
  return stage;
}
function assertResource(ledger, scenario, resource, binding) {
  const site = sites[scenario.site];
  if (!resource?.immutable || resource.owned !== true || resource.ledgerId !== ledger.data.id
    || !resource.id || !resource.url || !resource.marker
    || normalizeIdentity(resource.ownerIdentity, site.identityMode) !== normalizeIdentity(binding.expectedIdentity, site.identityMode)) fail('cleanup_resource_ownership_unproven');
  if (!site.originAllowed(resource.url, binding)) fail('ledger_resource_origin_mismatch');
  if (['social', 'files'].includes(scenario.kind)
    && site.canonicalResource(resource.url, binding)?.id !== resource.id) fail('cleanup_canonical_resource_id_mismatch');
  if (scenario.kind === 'chat' && (!resource.conversationId
    || String(resource.conversationId) !== normalizeIdentity(binding.recipientIdentity, site.identityMode === 'phone' ? 'phone' : 'text'))) fail('cleanup_conversation_ownership_unproven');
  if (scenario.kind === 'mail' && (!resource.threadId
    || site.canonicalResource(resource.url, binding)?.id !== resource.threadId)) fail('cleanup_thread_ownership_unproven');
}

async function contextFor(ledger, scenario, marker, directory, binding, resource = null) {
  if (typeof marker !== 'string' || !/^[A-Za-z0-9_-]{12,100}$/.test(marker)) fail('invalid_owned_marker');
  const resources = {};
  for (const item of ledger.data.resources.filter(item => item.scenario === scenario.id && item.marker === marker)) {
    resources[keyFor(ledger, scenario, item)] = item;
  }
  const filename = `${marker}.${scenario.kind === 'social' ? 'png' : 'txt'}`;
  const file = { name: filename, path: path.join(directory, filename) };
  const stat = await fs.stat(file.path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (stat?.isFile() && stat.size <= 1024 * 1024) file.sha256 = createHash('sha256').update(await fs.readFile(file.path)).digest('hex');
  return { marker, body: `${marker} final exact text 🧠`, initialBody: `${marker} initial draft`, revisedBody: `${marker} revised exact text 🧠`,
    revisedFilename: `${marker}-renamed.txt`,
    actorIdentity: binding.expectedIdentity, expectedIdentity: binding.expectedIdentity, expectedSender: binding.expectedIdentity,
    siteId: scenario.site, site: binding, siteBinding: binding, file, resource, resources };
}

function exactEvidence(evidence, resource) {
  const matches = (evidence.matches || []).filter(match => match.resource?.id === resource.id
    && (resource.threadId ? match.resource.threadId === resource.threadId : true)
    && (resource.conversationId ? match.resource.conversationId === resource.conversationId : true));
  return { ...evidence, matches, count: matches.length,
    exactCount: matches.filter(match => match.bodyMatches && match.markerCount === 1).length };
}
function checkEvidence(evidence, context, since) {
  const site = sites[context.siteId];
  if (!evidence || evidence.marker !== context.marker || evidence.site !== site.id
    || !['independent-dom', 'manual-confirmed-private'].includes(evidence.source)
    || evidence.identity?.matched !== true || evidence.blocked
    || normalizeIdentity(evidence.identity.actual, site.identityMode) !== normalizeIdentity(context.expectedIdentity, site.identityMode)
    || !site.originAllowed(evidence.url, context.siteBinding)) fail('independent_recovery_proof_required');
  if (evidence.source === 'manual-confirmed-private') {
    if (evidence.confirmedByOperator !== true || !Number.isFinite(Date.parse(evidence.confirmedAt))
      || !Number.isFinite(Date.parse(since)) || Date.parse(evidence.confirmedAt) < Date.parse(since)
      || Date.parse(evidence.confirmedAt) > Date.now() + 5_000) fail('fresh_manual_observation_required');
  }
}

async function claimLock(filename, ledger, token) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const guard = `${filename}.recovery`;
  const claim = `${guard}.claim`;
  try { await fs.writeFile(claim, JSON.stringify({ pid: process.pid, ownerToken: token }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') fail('scope_lock_reclamation_in_progress'); throw error; }
  let claimed = false;
  let guarded = false;
  try {
    // Serialize stale-guard reclamation as well as fresh acquisition. Otherwise
    // two reclaimers could remove a guard the other had just replaced.
    try { await fs.writeFile(guard, JSON.stringify({ pid: process.pid, ownerToken: token }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = JSON.parse(await fs.readFile(guard, 'utf8'));
      if (processAlive(previous.pid)) fail('another_recovery_owns_scope');
      await fs.unlink(guard);
      await fs.writeFile(guard, JSON.stringify({ pid: process.pid, ownerToken: token }), { flag: 'wx', mode: 0o600 });
    }
    guarded = true;
    let previous;
    try { previous = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
      if (previous.active !== false && processAlive(previous.pid)) fail('another_harness_owns_scope');
      if (!samePath(previous.ledger, ledger.filename)) fail('scope_owned_by_other_report');
    }
    const data = { ledger: ledger.filename, pid: process.pid, ownerToken: token, active: true };
    await fs.writeFile(filename, JSON.stringify(data), { ...(previous ? {} : { flag: 'wx' }), mode: 0o600 });
    claimed = true;
    return async () => {
      try {
        const current = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (current.ownerToken !== token) return;
        if (!ledger.pendingEntries().length && !ledger.pendingResources().length) await fs.unlink(filename);
        else await fs.writeFile(filename, JSON.stringify({ ...current, active: false }), { mode: 0o600 });
      } finally {
        const current = JSON.parse(await fs.readFile(guard, 'utf8')).ownerToken;
        if (current === token) await fs.unlink(guard);
      }
    };
  } catch (error) {
    if (!claimed && guarded) await fs.unlink(guard).catch(() => {});
    throw error;
  } finally { await fs.unlink(claim); }
}

async function claimScope(config, ledger) {
  const token = randomUUID(), releases = [];
  try {
    for (const filename of [...new Set(lockFiles(config))].sort()) releases.push(await claimLock(filename, ledger, token));
    return async () => {
      const errors = [];
      for (const release of [...releases].reverse()) {
        try { await release(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors[0];
    };
  } catch (error) {
    for (const release of [...releases].reverse()) await release().catch(() => {});
    throw error;
  }
}

/** Recovery observes an old dispatch; it never recreates it or adopts another user's tab. */
export async function recover(config, directory, args = {}, cleanup = false, { backendFactory = createBackend } = {}) {
  if (config.target !== 'live') throw new HarnessError('recovery_requires_live_ledger');
  if (args['run-id'] && !args['request-id']) fail('explicit_request_id_required');
  const ledger = await MutationLedger.load(path.join(directory, 'ledger.private.json'), config);
  const runner = new WorkflowRunner(config, directory, { backendFactory });
  runner.ledger = ledger;
  const results = [], receipts = new Map(), connected = new Set();
  const selectEntry = entry => !args['request-id'] || entry.requestId === args['request-id'];
  const selected = ledger.pendingEntries().filter(selectEntry);
  const requested = args['request-id'] && ledger.data.entries.find(entry => entry.requestId === args['request-id']);
  if (args['request-id'] && !requested) fail('unknown_attempt');
  const selectedResources = () => ledger.pendingResources().filter(resource => !requested
    || resource.requestId === requested.requestId || (resource.scenario === requested.scenario && resource.marker === requested.marker
      && stageFor(scenarios.find(s => s.id === resource.scenario), requested.stage)?.resourceKey === keyFor(ledger, scenarios.find(s => s.id === resource.scenario), resource)));
  if (!selected.length && !selectedResources().length) return summarize([], { operation: cleanup ? 'cleanup' : 'reconcile', target: 'live', sourceRevision: sourceRevision(config.repositoryRoot || config.cwd) });
  const release = await claimScope(config, ledger);
  const row = (entry, status, code, extra = {}) => ({ scenario: entry.scenario, site: scenarios.find(s => s.id === entry.scenario)?.site,
    stage: entry.stage, target: 'live', backend: config.actors[entry.actor || 'A']?.backend,
    layer: 'independent-recovery-evidence', status, code, ...extra });

  async function backend(role, entry) {
    if (!runner.backends[role]) runner.backends[role] = await backendFactory(config.actors[role], config, { onJournal: async event => {
      if (!event.requestId) return;
      if (event.type === 'attempt' && !ledger.data.entries.some(item => item.requestId === event.requestId)) {
        runner.checkBudget(); runner.calls++;
        await ledger.attempt({ scenario: 'backend-session', stage: event.operation, actor: role, action: 'navigation', marker: `session-${role}`, requestId: event.requestId });
      }
      if (ledger.data.entries.some(item => item.requestId === event.requestId)) await ledger.update(event.requestId, {
        status: event.type === 'accepted' ? 'accepted' : event.type === 'ambiguous' ? 'ambiguous' : undefined,
        runId: event.runId, tabId: event.tabId, sessionId: event.sessionId,
      });
    } });
    const value = runner.backends[role];
    const runId = entry?.runId || (entry?.requestId === args['request-id'] ? args['run-id'] : null);
    if (config.actors[role].backend === 'cloud' && runId) {
      await value.connect({ reconcileRunId: runId, requestId: entry.requestId, attemptedAt: entry.attemptedAt });
      connected.add(role);
    } else if (!connected.has(role)) { await value.connect(); connected.add(role); }
    const doctor = publicDoctor(await value.doctor());
    if (!doctor.readiness) fail('backend_not_ready');
    runner.doctors[role] = doctor;
    return value;
  }

  async function observe(scenario, stage, context, since, handle) {
    const actor = await backend('A');
    const privatePhase = stage.expectation === 'composer' || scenario.kind === 'files' && stage.actor !== 'B';
    const role = stage.actor === 'B' ? 'B' : actor.capabilities?.domObservation === false && !privatePhase
      && config.actors.B?.backend === 'local' ? 'B' : 'A';
    const observed = { ...context, stage,
      expectedIdentity: role === 'B' ? context.siteBinding.observerIdentity || context.siteBinding.recipientIdentity : context.actorIdentity };
    if (placeholder(observed.expectedIdentity)) fail('observer_identity_missing');
    let evidence;
    if (stage.expectation === 'composer' || actor.capabilities?.domObservation === false && role === 'A') {
      if (!config.manualEvidenceFile) throw new HarnessError('recovery_observation_unavailable', '', 'unsupported');
      const rows = JSON.parse(await fs.readFile(config.manualEvidenceFile, 'utf8'));
      evidence = rows.observations?.filter(item => item.marker === context.marker && item.site === scenario.site
        && item.stage === stage.id && (!item.phase || item.phase === stage.expectation))
        .sort((a, b) => Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt))[0];
    } else {
      await backend(role);
      evidence = await runner.observe(role, scenario.site, observed, stage.expectation, role === 'A' ? handle : undefined);
    }
    checkEvidence(evidence, observed, since);
    return { evidence, context: observed };
  }

  async function clearDeletes(scenario, resource, stage) {
    for (const entry of ledger.pendingEntries().filter(entry => entry.scenario === scenario.id && entry.marker === resource.marker
      && entry.action === 'delete' && stageFor(scenario, entry.stage)?.resourceKey === stage.resourceKey)) {
      if (!receipts.get(entry.requestId)?.terminal) continue;
      if (entry.stage.startsWith(`${stage.id}-recovery-`) && entry.stage !== `${stage.id}-recovery-${resource.id}`) continue;
      if (!entry.stage.startsWith(`${stage.id}-recovery-`)
        && new Set(ledger.data.resources.filter(item => item.scenario === scenario.id && item.marker === resource.marker
          && keyFor(ledger, scenario, item) === stage.resourceKey).map(item => item.id)).size !== 1) continue;
      await ledger.update(entry.requestId, { status: 'cleaned', verifiedAt: new Date().toISOString(), code: 'exact_resource_removal_verified' });
    }
  }

  try {
    for (const entry of selected) {
      try {
        const role = entry.actor || 'A';
        if (entry.scenario === 'backend-session' && entry.stage === 'upload_file') {
          const remoteName = args['remote-name'] || entry.remoteName;
          if (config.actors[role]?.backend !== 'cloud') throw new HarnessError('upload_reconciliation_requires_cloud', '', 'unsupported');
          if (typeof remoteName !== 'string' || !remoteName.trim() || !/^[a-f0-9]{64}$/i.test(entry.sha256 || '')
            || !Number.isFinite(Date.parse(entry.attemptedAt))) fail('upload_reconciliation_metadata_required');
          const value = await backend(role);
          if (typeof value.listDownloads !== 'function' || typeof value.reconcile !== 'function') {
            throw new HarnessError('upload_reconciliation_unavailable', '', 'unsupported');
          }
          await value.listDownloads();
          const receipt = await value.reconcile({ operation: 'upload_file', requestId: entry.requestId,
            attemptedAt: entry.attemptedAt, sha256: entry.sha256, remoteName });
          if (receipt?.status !== 'reconciled' || receipt.name !== remoteName.trim()
            || receipt.sha256?.toLowerCase() !== entry.sha256.toLowerCase()) fail('upload_bytes_hash_unproven');
          await ledger.update(entry.requestId, { status: 'verified', verifiedAt: new Date().toISOString(), code: 'upload_bytes_reconciled' });
          results.push(row(entry, 'passed', 'upload_bytes_reconciled'));
          continue;
        }
        const runId = entry.runId || (entry.requestId === args['request-id'] ? args['run-id'] : null);
        if (!runId && !entry.tabId) fail('explicit_dispatch_receipt_required');
        const value = await backend(role, entry);
        const runtime = config.actors[role].backend === 'cloud' ? await value.getRun(runId)
          : value.inspectSavedRun ? await value.inspectSavedRun(entry) : null;
        if (!runtime) fail('runtime_terminal_receipt_required');
        const terminal = runtime.active !== true && TERMINAL.has(runtime.status);
        receipts.set(entry.requestId, { terminal, runtime });
        await ledger.update(entry.requestId, { runId: runtime.runId || runId, status: terminal ? 'accepted' : pendingInput(runtime.status) ? 'needs_user_input' : 'running' });
        if (!terminal) {
          results.push(row(entry, pendingInput(runtime.status) ? 'needs_user_input' : 'blocked', 'runtime_not_terminal'));
          continue;
        }
        if (entry.scenario === 'backend-session') {
          const inScope = runtime.finalUrl && Object.entries(config.sites).some(([id, binding]) => sites[id]?.originAllowed(runtime.finalUrl, binding));
          const correlated = ledger.data.entries.some(other => other.scenario !== 'backend-session'
            && other.actor === entry.actor && other.runId === runtime.runId && ['verified', 'cleaned'].includes(other.status));
          if (correlated) {
            await ledger.update(entry.requestId, { status: 'verified', verifiedAt: new Date().toISOString(), code: 'dispatch_receipt_correlated_with_verified_effect' });
            results.push(row(entry, 'passed', 'dispatch_receipt_correlated_with_verified_effect'));
            continue;
          }
          if (entry.stage !== 'create_run' || entry.action !== 'navigation' || runtime.status !== 'completed' || !inScope) fail('backend_dispatch_effect_unproven');
          await ledger.update(entry.requestId, { status: 'verified', verifiedAt: new Date().toISOString(), code: 'navigation_receipt_verified' });
          results.push(row(entry, 'passed', 'navigation_receipt_verified'));
          continue;
        }
        const scenario = scenarios.find(item => item.id === entry.scenario);
        if (!scenario) fail('unknown_owned_scenario');
        const stage = stageFor(scenario, entry.stage);
        if (!stage) fail('unknown_owned_stage');
        const binding = { ...config.sites[scenario.site], url: config.sites[scenario.site]?.url || sites[scenario.site].defaultUrl };
        authorize(config, { ...scenario, actions: [] }, binding);
        const context = await contextFor(ledger, scenario, entry.marker, directory, binding);
        context.resource = stage.resourceKey ? context.resources[stage.resourceKey] || null : ledger.data.resources.find(item => item.requestId === entry.requestId) || null;
        const plan = planTask({ scenario, stage, context });
        if (stage.action === 'delete' && context.resource?.expectedBody) plan.observation.body = context.resource.expectedBody;
        const proof = await observe(scenario, stage, { ...context, ...plan.observation }, entry.attemptedAt);
        const evidence = context.resource && !stage.captureResource ? exactEvidence(proof.evidence, context.resource) : proof.evidence;
        const verdict = verifyEvidence({ scenario, stage, evidence, context: proof.context });
        const captured = [];
        if (stage.captureResource) {
          const candidates = [...new Map([...(verdict.resources || []), ...(verdict.resource ? [verdict.resource] : [])]
            .map(resource => [`${resource.id}:${resource.url}`, resource])).values()];
          for (const candidate of candidates) {
            // Quality requirements can fail while an immutable owned item was
            // created. Recheck its identity/body/author/recipient independently
            // before retaining it for cleanup; never infer it from completion.
            const ownership = verifyEvidence({ scenario, stage: { ...stage, requiresAttachment: false, requiresSentStatus: false },
              evidence: exactEvidence(proof.evidence, candidate), context: proof.context });
            if (!ownership.ok || ownership.resource?.id !== candidate.id || ownership.resource?.url !== candidate.url) continue;
            captured.push(await ledger.recordResource(entry, { ...ownership.resource, expectedBody: proof.context.body }, binding.expectedIdentity));
          }
        }
        if (!verdict.ok && captured.length) {
          const code = safeError({ code: verdict.reason || 'captured_item_quality_failed' }).code;
          await ledger.update(entry.requestId, { status: 'verified', verifiedAt: new Date().toISOString(), code });
          results.push(row(entry, 'failed', code, { cleanup: 'pending' }));
          continue;
        }
        if (!verdict.ok) fail(verdict.reason || 'effect_unverified');
        if (stage.captureResource && !captured.length) fail('capture_ownership_unproven');
        if (stage.action === 'delete') { await ledger.cleaned(context.resource); await clearDeletes(scenario, context.resource, stage); }
        else await ledger.update(entry.requestId, { status: 'verified', verifiedAt: new Date().toISOString() });
        results.push(row(entry, 'passed', 'dispatch_effect_independently_verified'));
        if (cleanup && stage.expectation === 'composer') results.push(row(entry, 'unsupported', 'unsent_draft_cleanup_requires_immutable_identity'));
      } catch (error) { results.push(row(entry, safeError(error).status === 'failed' ? 'blocked' : safeError(error).status, safeError(error).code)); }
    }

    for (const resource of selectedResources()) {
      const ownedEntry = ledger.data.entries.find(entry => entry.requestId === resource.requestId) || { scenario: resource.scenario, stage: resource.sourceStage, actor: 'A' };
      try {
        const scenario = scenarios.find(item => item.id === resource.scenario);
        if (!scenario) fail('unknown_owned_scenario');
        const binding = { ...config.sites[scenario.site], url: config.sites[scenario.site]?.url || sites[scenario.site].defaultUrl };
        authorize(config, { ...scenario, actions: cleanup ? ['delete'] : [] }, binding);
        assertResource(ledger, scenario, resource, binding);
        const stage = cleanupStage(ledger, scenario, resource);
        const actor = await backend('A');
        const context = await contextFor(ledger, scenario, resource.marker, directory, binding, resource);
        context.resources[stage.resourceKey] = resource;
        const plan = planTask({ scenario, stage, context });
        if (resource.expectedBody) {
          if (typeof resource.expectedBody !== 'string' || !resource.expectedBody.includes(resource.marker)
            || config.secrets?.some(secret => secret && resource.expectedBody.includes(secret))) fail('invalid_owned_resource_body');
          plan.observation.body = resource.expectedBody;
        } else if (scenario.kind === 'files' && !ledger.data.entries.some(entry => entry.scenario === scenario.id
          && entry.marker === resource.marker && stageFor(scenario, entry.stage)?.action === 'rename' && entry.status === 'verified')) {
          plan.observation.body = context.file.name;
        }
        const target = actor.capabilities?.domObservation === false ? null : await runner.handle('A', scenario.site, resource.url);
        const proof = await observe(scenario, stage, { ...context, ...plan.observation }, resource.observedAt || ownedEntry.attemptedAt, target);
        const removed = verifyEvidence({ scenario, stage, evidence: exactEvidence(proof.evidence, resource), context: proof.context });
        if (removed.ok) {
          await ledger.cleaned(resource); await clearDeletes(scenario, resource, stage);
          results.push(row({ ...ownedEntry, stage: stage.id }, 'passed', 'already_removed_independently_verified', { cleanup: 'verified' }));
          continue;
        }
        const source = sourceStage(ledger, scenario, resource);
        const presence = scenario.kind === 'files' ? { ...scenario.steps.find(item => item.expectation === 'access'), actor: 'A' }
          : { ...source, action: 'navigation', expectation: 'resource', resourceKey: stage.resourceKey,
            requiresResource: true, captureResource: false, requiresAttachment: false, requiresSentStatus: false };
        const present = verifyEvidence({ scenario, stage: presence, evidence: exactEvidence(proof.evidence, resource), context: proof.context });
        if (!present.ok) fail(present.reason || 'cleanup_resource_ownership_unproven');
        if (!cleanup) {
          results.push(row({ ...ownedEntry, stage: stage.id }, 'blocked', 'owned_resource_present_cleanup_pending', { cleanup: 'pending' }));
          continue;
        }
        const outstanding = ledger.pendingEntries().filter(entry => entry.scenario === scenario.id && entry.marker === resource.marker);
        if (outstanding.some(entry => entry.action !== 'delete' || !receipts.get(entry.requestId)?.terminal)) fail('pending_dispatch_requires_reconciliation');
        if (actor.capabilities?.domObservation === false || typeof actor.run !== 'function') {
          throw new HarnessError('cleanup_requires_actor_browser_controller', '', 'unsupported');
        }
        runner.checkBudget();
        const attempt = await ledger.attempt({ scenario: scenario.id, stage: `${stage.id}-recovery-${resource.id}`, actor: 'A', action: 'delete', marker: resource.marker });
        runner.calls++;
        await ledger.update(attempt.requestId, { tabId: target.tabId });
        let response;
        try {
          response = await actor.run({ handle: target, task: `${plan.task}\nConfirm the exact owned body or filename ${JSON.stringify(plan.observation.body)} before deleting. Stop if it differs.`,
            mode: 'act', requestId: attempt.requestId, timeoutMs: config.timeoutMs,
            onUpdate: async update => { if (update.runId) await ledger.update(attempt.requestId, { runId: update.runId, status: 'running' }); } });
        } catch (error) {
          await ledger.update(attempt.requestId, { status: error.noDispatch === true ? 'not_delivered' : 'ambiguous', code: safeError(error).code });
          throw error;
        }
        const terminal = TERMINAL.has(response.status);
        receipts.set(attempt.requestId, { terminal, runtime: response });
        await ledger.update(attempt.requestId, { runId: response.runId, status: terminal ? 'accepted' : pendingInput(response.status) ? 'needs_user_input' : 'running', completedAt: terminal ? new Date().toISOString() : undefined });
        if (!terminal) fail('cleanup_runtime_not_terminal');
        await target.page.reload({ waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
        const after = await observe(scenario, stage, { ...context, ...plan.observation }, attempt.attemptedAt, target);
        const verdict = verifyEvidence({ scenario, stage, evidence: exactEvidence(after.evidence, resource), context: after.context });
        if (!verdict.ok) fail(verdict.reason || 'cleanup_unverified');
        await ledger.cleaned(resource); await clearDeletes(scenario, resource, stage);
        results.push(row({ ...ownedEntry, stage: stage.id }, 'passed', 'cleanup_effect_independently_verified', { cleanup: 'verified' }));
      } catch (error) { results.push(row(ownedEntry, safeError(error).status === 'failed' ? 'blocked' : safeError(error).status, safeError(error).code, { cleanup: 'pending' })); }
    }
    return redact(summarize(results, { sourceRevision: sourceRevision(config.cwd), operation: cleanup ? 'cleanup' : 'reconcile', target: 'live' }), config.secrets || []);
  } finally { try { await runner.close(); } finally { await release(); } }
}
