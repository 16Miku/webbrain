import fs from 'node:fs/promises';
import { repositoryRoot } from './paths.mjs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { authorize, HarnessError, placeholder, safeError, lockFiles, requirePrivateLocation } from './config.mjs';
import { MutationLedger } from './ledger.mjs';
import { sites } from './sites.mjs';
import { planTask, verifyEvidence } from './scenarios.mjs';
import { applyIntervention, interventionKinds } from './interventions.mjs';
import { createLocalBackend } from './backends/local.mjs';
import { createCloudBackend } from './backends/cloud.mjs';

export async function createBackend(role, config, options = {}) {
  if (!role?.backend) throw new HarnessError('backend_not_selected');
  if (role.backend === 'cloud') {
    if (placeholder(role.apiKey)) throw new HarnessError('cloud_api_key_missing');
    if (role.provider || role.model) throw new HarnessError('cloud_provider_pin_unverifiable', 'The public API cannot attest or select an existing session provider/model.', 'unsupported');
    return createCloudBackend(role, { timeoutMs: config.timeoutMs, pollMs: config.pollMs, maxRuns: config.maxRuns, ...options });
  }
  if (!role.profile && !role.cdpUrl) throw new HarnessError('local_session_not_selected', 'Configure an explicit dedicated profile or debugging endpoint.');
  if (role.profile) await requirePrivateLocation(role.profile, config.cwd);
  return createLocalBackend({ ...role, extensionPath: role.extensionPath || path.join(config.repositoryRoot || repositoryRoot, 'src/chrome') }, { timeoutMs: config.timeoutMs, pollMs: config.pollMs, ...options });
}
export function publicDoctor(value) {
  return { backend: value?.backend, browser: value?.browser, version: value?.version || 'unknown', build: value?.build || 'unknown',
    extensionVersion: value?.extensionVersion || value?.version || 'unknown',
    readiness: value?.readiness === 'ready' || value?.readiness === true || value?.ready === true, reason: value?.reason ? 'backend_not_ready' : undefined,
    sourceHash: value?.sourceHash, sourceHashScope: value?.sourceHashScope || value?.sourceHashFiles, provider: value?.provider || 'unknown', model: value?.model || 'unknown',
    capabilities: value?.capabilities };
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(marker) {
  const chunk = (type, data) => { const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((32 * 4 + 1) * 32, 190); for (let y = 0; y < 32; y++) pixels[y * 129] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('tEXt', Buffer.from(`WebBrain QA\0${marker}`)), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
async function dummyFile(directory, marker, media = false) {
  const name = `${marker}.${media ? 'png' : 'txt'}`, data = media ? png(marker) : Buffer.from(`${marker}\nAuthenticated WebBrain QA attachment.\n`);
  const filename = path.join(directory, name);
  await fs.writeFile(filename, data, { mode: 0o600 });
  return { name, path: filename, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
}

export class WorkflowRunner {
  constructor(config, directory, { backendFactory = createBackend, siteCatalog = sites, taskPlanner = planTask, evidenceVerifier = verifyEvidence, manualCheckpoint } = {}) {
    this.config = config; this.directory = directory; this.backendFactory = backendFactory; this.siteCatalog = siteCatalog;
    this.taskPlanner = taskPlanner; this.evidenceVerifier = evidenceVerifier; this.manualCheckpoint = manualCheckpoint; this.backends = {}; this.doctors = {};
    this.started = Date.now(); this.calls = 0; this.events = []; this.handles = new Map();
  }
  recordEvent(event) {
    if (this.events.length >= 2000) return;
    const label = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) && !this.config.secrets.some(secret => secret && value.includes(secret)) ? value : undefined;
    this.events.push({ stage: label(event.stage), type: label(event.type), tool: label(event.tool), code: label(event.code), kind: label(event.kind),
      timestamp: Number.isFinite(event.timestamp) ? event.timestamp : Number.isFinite(Date.parse(event.timestamp)) ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
      dispatched: typeof event.dispatched === 'boolean' ? event.dispatched : undefined,
      noDispatch: typeof event.noDispatch === 'boolean' ? event.noDispatch : undefined, deliveryVerified: typeof event.deliveryVerified === 'boolean' ? event.deliveryVerified : undefined, observed: event.observed === true || undefined });
  }
  async initialize() {
    await fs.mkdir(this.config.artifacts, { recursive: true });
    this.lockPaths = [];
    this.ownerToken = randomUUID();
    try {
      for (const lockPath of lockFiles(this.config)) {
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
        const claimPath = lockPath + '.recovery.claim';
        try { await fs.writeFile(claimPath, JSON.stringify({ pid: process.pid, ownerToken: this.ownerToken }), { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code === 'EEXIST') throw new HarnessError('scope_lock_reclamation_in_progress'); throw error; }
        try {
        const recovery = await fs.readFile(lockPath + '.recovery', 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (recovery) throw new HarnessError('another_recovery_owns_scope');
        try {
          const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
          if (lock.active !== false) {
            if (!Number.isSafeInteger(lock.pid) || lock.pid < 1) throw new HarnessError('scope_lock_owner_unverified');
            let alive = true;
            try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
            if (alive) throw new HarnessError('another_harness_owns_scope');
          }
          const previous = await MutationLedger.load(lock.ledger, this.config);
          if (previous.pendingEntries().length || previous.pendingResources().length) throw new HarnessError('previous_run_requires_reconciliation');
          await fs.unlink(lockPath);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { await fs.writeFile(lockPath, JSON.stringify({ ledger: path.join(this.directory, 'ledger.private.json'), pid: process.pid,
          ownerToken: this.ownerToken, active: true }), { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code === 'EEXIST') throw new HarnessError('another_harness_owns_scope'); throw error; }
        this.lockPaths.push(lockPath);
        } finally { await fs.unlink(claimPath); }
      }
    } catch (error) { for (const file of this.lockPaths) await fs.unlink(file); this.lockPaths = []; throw error; }
    try { this.ledger = await MutationLedger.create(this.config, this.directory); }
    catch (error) { for (const file of this.lockPaths) await fs.unlink(file); this.lockPaths = []; throw error; }
    return this;
  }
  checkBudget() {
    if (Date.now() - this.started >= this.config.totalTimeoutMs) throw new HarnessError('suite_deadline_exceeded');
    if (this.calls >= this.config.maxRuns) throw new HarnessError('run_budget_exceeded');
  }
  async backend(role) {
    if (!this.backends[role]) {
      if (Date.now() - this.started >= this.config.totalTimeoutMs) throw new HarnessError('suite_deadline_exceeded');
      const backend = await this.backendFactory(this.config.actors[role], this.config, { timeoutMs: Math.min(this.config.timeoutMs, this.config.totalTimeoutMs - (Date.now() - this.started)), onJournal: async event => {
        if (event.type === 'attempt' && !this.ledger.data.entries.some(e => e.requestId === event.requestId)) {
          if (['create_run', 'continue_run'].includes(event.operation)) { this.checkBudget(); this.calls++; }
          await this.ledger.attempt({ scenario: 'backend-session', stage: event.operation, actor: role, action: 'navigation', marker: `session-${role}`, requestId: event.requestId, sha256: event.sha256, remoteName: event.remoteName });
        }
        // Durable acceptance precedes the next operation. A response lost after dispatch remains pending.
        if (event.requestId && this.ledger.data.entries.some(e => e.requestId === event.requestId)) {
          await this.ledger.update(event.requestId, { status: event.type === 'ambiguous' ? 'ambiguous' : event.type === 'accepted' ? 'accepted' : undefined,
            runId: event.runId, sessionId: event.sessionId, tabId: event.tabId, remoteName: event.remoteName, sha256: event.sha256 });
        }
      } });
      this.backends[role] = backend;
      let doctor;
      try { await backend.connect(); doctor = await backend.doctor(); }
      catch (error) { throw new HarnessError(error.code || 'backend_connection_failed', '', error.status === 'unsupported' ? 'unsupported' : 'blocked'); }
      this.doctors[role] = publicDoctor(doctor);
      if (this.doctors[role].readiness !== true) throw new HarnessError('backend_not_ready');
    }
    return this.backends[role];
  }
  async handle(role, siteId, url) {
    const key = `${role}:${siteId}:${url}`;
    if (!this.handles.has(key)) {
      const handle = await (await this.backend(role)).open(url);
      if (!this.siteCatalog[siteId].originAllowed(handle.url || handle.page?.url?.() || url, this.config.sites[siteId])) throw new HarnessError('navigation_left_site_scope');
      this.handles.set(key, handle);
      for (const entry of this.ledger.data.entries.filter(e => e.scenario === 'backend-session' && e.runId === handle.runId))
        await this.ledger.update(entry.requestId, { status: 'verified' });
    }
    return this.handles.get(key);
  }
  async observe(role, siteId, context, phase, preferredHandle) {
    const binding = context.siteBinding;
    const backend = await this.backend(role);
    if (backend.capabilities?.domObservation === false) {
      if (!this.config.manualEvidenceFile) throw new HarnessError('independent_observation_unavailable', 'Configure a local observer or import explicit manual observation.', 'unsupported');
      let rows;
      try { rows = JSON.parse(await fs.readFile(this.config.manualEvidenceFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; rows = { observations: [] }; }
      let evidence = rows.observations?.find(row => row.marker === context.marker && row.stage === context.stage.id && row.site === siteId);
      if (!evidence && this.manualCheckpoint) {
        const requirement = path.join(this.directory, `manual-${context.stage.id}.private.json`);
        await fs.writeFile(requirement, JSON.stringify({ site: siteId, stage: context.stage.id, marker: context.marker, phase,
          expectedIdentity: role === 'A' ? binding.expectedIdentity : binding.observerIdentity || binding.recipientIdentity,
          expectedBody: context.body, expectedResource: context.resource, evidenceFile: this.config.manualEvidenceFile,
          note: 'Observe the actual selected browser. Never copy model completion into evidence. Append a confirmed manual observation using the documented schema.' }, null, 2), { mode: 0o600 });
        await this.manualCheckpoint({ requirement, evidenceFile: this.config.manualEvidenceFile, timeoutMs: this.config.timeoutMs });
        rows = JSON.parse(await fs.readFile(this.config.manualEvidenceFile, 'utf8'));
        evidence = rows.observations?.find(row => row.marker === context.marker && row.stage === context.stage.id && row.site === siteId);
      }
      if (!evidence || evidence.source !== 'manual-confirmed-private' || evidence.confirmedByOperator !== true || !evidence.confirmedAt)
        throw new HarnessError('manual_observation_required', 'An explicit observation for this exact run and stage is required.');
      return evidence;
    }
    const candidate = role === 'B' ? phase === 'access' ? context.resource?.url : binding.observerUrl || binding.url || this.siteCatalog[siteId].defaultUrl
      : siteId === 'drive' && !['download', 'access'].includes(phase) ? binding.folderUrl : context.resource?.url || binding.url || this.siteCatalog[siteId].defaultUrl;
    const url = String(candidate).replaceAll('{marker}', encodeURIComponent(context.marker));
    const handle = preferredHandle?.page ? preferredHandle : await this.handle(role, siteId, url);
    const expectedIdentity = role === 'B' ? binding.observerIdentity || binding.recipientIdentity : binding.expectedIdentity;
    if (placeholder(expectedIdentity)) throw new HarnessError('observer_identity_missing');
    const viewBinding = role === 'B' && this.siteCatalog[siteId].kind === 'chat' ? { ...binding, expectedIdentity,
      recipient: binding.observerRecipient || binding.expectedIdentity, recipientIdentity: binding.observerRecipientIdentity || binding.expectedIdentity } : binding;
    const observed = { ...context, phase, expectedIdentity, expectedSender: binding.expectedIdentity,
      recipient: viewBinding.recipient, siteBinding: viewBinding };
    if (this.siteCatalog[siteId].prepareObservation && (role === 'B' || this.siteCatalog[siteId].kind === 'mail' && phase === 'resource')) {
      const ready = await this.siteCatalog[siteId].prepareObservation(handle.page, observed);
      if (ready.blocked) throw new HarnessError(ready.reason || 'observer_view_not_ready');
    }
    return this.siteCatalog[siteId].observe(handle.page, observed);
  }
  async runScenario(scenario) {
    const begin = Date.now(), result = { scenario: scenario.id, site: scenario.site, target: this.config.target, backend: this.config.actors.A.backend,
      layer: this.config.target === 'fixtures' ? 'deterministic-harness-integration' : 'installed-extension-real-provider', status: 'blocked', stage: 'preflight', stages: [], cleanup: 'not_started' };
    let context;
    try {
      const configured = this.config.sites[scenario.site];
      authorize(this.config, scenario, configured);
      const site = this.siteCatalog[scenario.site];
      if (!site) throw new HarnessError('unknown_site');
      const url = configured.url || (scenario.site === 'drive' ? configured.folderUrl : null) || site.defaultUrl;
      const binding = { ...configured, url };
      if (!site.originAllowed(url, binding)) throw new HarnessError('site_origin_mismatch');
      if (this.config.actors.A.backend === 'cloud' && binding.manualActorIdentityVerified !== true)
        throw new HarnessError('cloud_actor_identity_confirmation_required');
      const cloudPrivatePhases = this.config.actors.A.backend === 'cloud' && scenario.steps.some(stage =>
        stage.expectation === 'composer' || scenario.kind === 'files');
      if (cloudPrivatePhases && (!this.config.manualEvidenceFile || !this.manualCheckpoint))
        throw new HarnessError('cloud_private_phase_requires_manual_evidence', 'A receiver cannot observe the actor’s private draft/folder.', 'unsupported');
      const actor = await this.backend('A');
      // Establish independent observation before allowing any remote mutation.
      const observerRole = scenario.requiresObserver || actor.capabilities?.domObservation === false && this.config.actors.B.backend ? 'B' : 'A';
      if (observerRole === 'B') {
        if (!this.config.actors.B.backend) throw new HarnessError('observer_backend_missing');
        const observer = await this.backend('B');
        if (observer.capabilities?.domObservation === false && (!this.config.manualEvidenceFile || !this.manualCheckpoint))
          throw new HarnessError('independent_observation_unavailable', 'Cloud REST lacks independent DOM inspection; select a local observer.', 'unsupported');
        if (placeholder(binding.observerIdentity || binding.recipientIdentity)) throw new HarnessError('observer_identity_missing');
        if (observer.capabilities?.domObservation !== false) {
          const view = await this.handle('B', scenario.site, binding.observerUrl || url);
          const identity = await site.identity(view.page, { ...binding, expectedIdentity: binding.observerIdentity || binding.recipientIdentity });
          if (!identity?.matched) throw new HarnessError(identity?.reason || 'observer_account_identity_mismatch');
        }
      }
      const handle = await this.handle('A', scenario.site, url);
      if (handle.page) {
        const identity = await site.identity(handle.page, binding);
        if (!identity?.matched) throw new HarnessError(identity?.reason || 'account_identity_mismatch');
      } else if (binding.manualActorIdentityVerified !== true) {
        throw new HarnessError('cloud_actor_identity_confirmation_required', 'Confirm the selected Cloud login identity in private configuration before mutations.');
      }
      const marker = `WBQA-${randomUUID()}`;
      context = { marker, body: `${marker} final exact text 🧠`, initialBody: `${marker} initial draft`, revisedBody: `${marker} revised exact text 🧠`,
        revisedFilename: `${marker}-renamed.txt`, actorIdentity: binding.expectedIdentity, expectedIdentity: binding.expectedIdentity, expectedSender: binding.expectedIdentity,
        siteId: scenario.site, site: binding, siteBinding: binding, file: await dummyFile(this.directory, marker, scenario.kind === 'social'), resource: null, resources: {}, observerRole };
      if (scenario.actions.includes('upload') && actor.upload) {
        const upload = await actor.upload({ file: context.file.path, remoteName: context.file.name });
        if (!(upload.browser_ready || upload.browserReady) || !(upload.browser_path || upload.browserPath)) throw new HarnessError('file_not_browser_ready');
        context.file.path = upload.browser_path || upload.browserPath;
        for (const entry of this.ledger.data.entries.filter(e => e.scenario === 'backend-session' && e.stage === 'upload_file' && e.status === 'accepted'))
          await this.ledger.update(entry.requestId, { status: 'verified' });
      }
      for (const stage of scenario.steps) {
        if (Date.now() - this.started >= this.config.totalTimeoutMs) throw new HarnessError('suite_deadline_exceeded');
        context.stage = stage; result.stage = stage.id;
        if (stage.resourceKey) context.resource = context.resources[stage.resourceKey] || null;
        const stageStart = Date.now(), row = { id: stage.id, status: 'running', delivery: 'not_started', effect: 'unverified', retries: 0, dispatchCount: 0 };
        const eventStart = this.events.length;
        result.stages.push(row);
        let attempted;
        try {
          if (stage.action === 'delete' && (!context.resource?.id || !context.resource?.url)) throw new HarnessError('cleanup_resource_unproven');
          const role = stage.actor || 'A';
          const backend = await this.backend(role);
          const plan = this.taskPlanner({ scenario, stage, context });
          const task = typeof plan === 'string' ? plan : plan.task;
          const phase = plan.observation?.phase || stage.phase || stage.expectation || 'resource';
          const actorPrivatePhase = phase === 'composer' || scenario.kind === 'files' && stage.actor !== 'B';
          const viewRole = stage.actor === 'B' ? 'B' : actor.capabilities?.domObservation === false && !actorPrivatePhase ? observerRole : 'A';
          let observedContext = { ...context, ...plan.observation, observedAfter: new Date(stageStart).toISOString(), expectedIdentity: viewRole === 'B' ? binding.observerIdentity || binding.recipientIdentity : binding.expectedIdentity };
          if (stage.actor === 'B' && stage.action === 'navigation') {
            const evidence = await this.observe('B', scenario.site, observedContext, phase);
            const verdict = this.evidenceVerifier({ scenario, stage, evidence, context: observedContext });
            row.verificationSource = evidence.source;
            if (!verdict.ok) throw new HarnessError(verdict.reason || 'observer_receipt_unverified', '', verdict.blocked ? 'blocked' : 'failed');
            row.status = 'passed'; row.code = 'verified'; row.delivery = 'read_only_observer'; row.effect = 'independently_verified';
            continue;
          }
          const configuredSpec = this.config.interventions[`${scenario.id}:${stage.id}`];
          const spec = configuredSpec ? { ...configuredSpec, text: configuredSpec.text?.replaceAll('{marker}', marker),
            expectedBody: configuredSpec.expectedBody?.replaceAll('{marker}', marker) } : null;
          if (spec && (!interventionKinds.includes(spec.kind) || !spec.checkpoint?.selector)) throw new HarnessError('intervention_configuration_invalid');
          if (spec?.kind === 'passive-update' && !spec.updateCheckpoint?.selector) throw new HarnessError('passive_update_checkpoint_missing');
          if (spec && (backend.capabilities?.checkpoints !== true || backend.capabilities?.interventions !== true))
            throw new HarnessError('active_intervention_unavailable', 'The selected backend has no supported active browser controller.', 'unsupported');
          if (spec?.kind === 'stop-continue' && !['compose', 'edit'].includes(stage.action)) throw new HarnessError('stop_continue_requires_unsent_draft');
          if (spec?.kind === 'navigate' && !site.originAllowed(spec.url, binding)) throw new HarnessError('intervention_origin_outside_scope');
          if (spec && ['steer', 'narrow', 'cancel'].includes(spec.kind) && !spec.expectedBody) throw new HarnessError('intervention_expected_body_missing');
          if (spec?.expectedBody && !spec.expectedBody.includes(marker)) throw new HarnessError('intervention_marker_changed');
          if (spec?.expectedPhase && spec.expectedPhase !== phase) throw new HarnessError('intervention_phase_invalid');
          if (spec?.kind === 'cancel' && (!['compose', 'edit'].includes(stage.action) || spec.expectedPhase !== 'composer' || !spec.finishAfterStage))
            throw new HarnessError('cancel_requires_owned_unsent_draft');
          if (this.config.secrets.some(secret => secret.length > 5 && (task.includes(secret) || spec?.text?.includes(secret)))) throw new HarnessError('credential_in_task');
          if (spec?.expectedBody) observedContext.body = spec.expectedBody;
          const expectedStage = spec?.expectedPhase ? { ...stage, expectation: spec.expectedPhase, phase: spec.expectedPhase } : stage;
          const expectedPhase = spec?.expectedPhase || phase;
          this.checkBudget();
          const entry = await this.ledger.attempt({ scenario: scenario.id, stage: stage.id, actor: role, action: stage.action, marker });
          attempted = entry;
          if (handle.tabId) await this.ledger.update(entry.requestId, { tabId: handle.tabId });
          let dispatchEntry = entry;
          const dispatches = [entry];
          row.delivery = 'pending'; this.calls++; row.dispatchCount++;
          const runStart = Date.now();
          const update = async event => {
            if (event.runId) await this.ledger.update(dispatchEntry.requestId, { runId: event.runId, tabId: handle.tabId, status: 'running' });
            this.recordEvent({ stage: stage.id, type: event.type, timestamp: event.timestamp || event.ts,
              tool: event.data?.name, code: event.data?.code || event.data?.reason, dispatched: event.data?.dispatched, noDispatch: event.data?.noDispatch, deliveryVerified: event.data?.deliveryVerified });
          };
          const running = backend.run({ task, mode: 'act', handle, requestId: entry.requestId, timeoutMs: Math.min(this.config.timeoutMs,
            this.config.totalTimeoutMs - (Date.now() - this.started)), onUpdate: update });
          let intervention;
          if (spec) {
            try { intervention = await applyIntervention(backend, handle, spec, event => this.recordEvent({ stage: stage.id, ...event })); }
            catch (error) { await backend.stop(handle).catch(() => {}); await running.catch(() => {}); throw error; }
            row.intervention = intervention.kind;
          }
          let response = await running;
          await this.ledger.update(entry.requestId, { runId: response.runId, status: ['completed', 'failed', 'aborted'].includes(response.status) ? 'accepted' : response.status,
            completedAt: new Date().toISOString() });
          if (spec?.kind === 'stop-continue') {
            this.checkBudget(); this.calls++; row.dispatchCount++;
            dispatchEntry = await this.ledger.attempt({ scenario: scenario.id, stage: `${stage.id}-continue`, actor: role, action: stage.action, marker });
            dispatches.push(dispatchEntry); attempted = dispatchEntry;
            response = await backend.run({ handle, continueFrom: response.runId, task, mode: 'act', requestId: dispatchEntry.requestId, timeoutMs: this.config.timeoutMs, onUpdate: update });
          }
          await this.ledger.update(dispatchEntry.requestId, { runId: response.runId, status: ['completed', 'failed', 'aborted'].includes(response.status) ? 'accepted' : response.status,
            completedAt: new Date().toISOString() });
          row.runtimeMs = Date.now() - runStart;
          const observationStart = Date.now();
          row.delivery = response.status === 'completed' ? 'runtime_completed' : response.status;
          // Read evidence even after a runtime error: the effect may already exist.
          if (stage.refresh !== false) {
            const view = await this.backend(viewRole);
            if (view.capabilities?.domObservation !== false) {
              const target = viewRole === 'A' ? handle : await this.handle(viewRole, scenario.site, binding.observerUrl || url);
              if (expectedPhase !== 'composer') await target.page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.timeoutMs });
            }
          }
          const evidence = await this.observe(viewRole, scenario.site, observedContext, expectedPhase, viewRole === 'A' ? handle : undefined);
          if (stage.requiresDownloadBytes && backend.collectDownload) evidence.download = await backend.collectDownload({ handle, marker, filename: context.revisedFilename,
            resourceId: context.resource.id, expectedSha256: context.file.sha256, after: stageStart });
          row.observationMs = Date.now() - observationStart;
          const verdict = this.evidenceVerifier({ scenario, stage: expectedStage, evidence, context: observedContext });
          row.verificationSource = evidence.source;
          for (const resource of stage.captureResource ? verdict.resources || (verdict.resource ? [verdict.resource] : []) : []) {
            const owned = await this.ledger.recordResource(entry, { ...resource, expectedBody: observedContext.body }, binding.expectedIdentity);
            context.resource = owned; context.resources[stage.id] = owned;
            if (stage.captureResourceKey) context.resources[stage.captureResourceKey] = owned;
          }
          row.effect = verdict.ok ? 'independently_verified' : 'unverified';
          if (!verdict.ok) {
            for (const dispatch of dispatches) await this.ledger.update(dispatch.requestId, { status: 'ambiguous', code: verdict.reason || 'effect_unverified' });
            throw new HarnessError(verdict.reason || 'effect_unverified', '', verdict.blocked ? 'blocked' : 'failed');
          }
          for (const dispatch of dispatches) await this.ledger.update(dispatch.requestId, { status: 'verified', verifiedAt: new Date().toISOString() });
          if (stage.action === 'delete') await this.ledger.cleaned(context.resource);
          if (response.status !== 'completed' && !(spec?.kind === 'cancel' && response.status === 'aborted')) throw new HarnessError(response.status === 'needs_user_input' ? 'runtime_user_input_required' : 'runtime_failed_after_effect', '', response.status === 'needs_user_input' ? 'needs_user_input' : 'failed');
          row.status = 'passed'; row.code = 'verified';
          if (spec?.expectedBody) {
            if (stage.bodyVariant) (context.bodyOverrides ||= {})[stage.bodyVariant] = spec.expectedBody;
            else context[stage.bodyKey || 'body'] = spec.expectedBody;
          }
          if (spec?.finishAfterStage) break;
        } catch (error) {
          if (attempted && error.noDispatch === true) await this.ledger.update(attempted.requestId, { status: 'not_delivered', code: error.code || 'not_delivered' });
          Object.assign(row, safeError(error)); throw error;
        }
        finally { row.durationMs = Date.now() - stageStart; row.events = this.events.slice(eventStart); }
      }
      result.status = 'passed'; result.code = 'verified'; result.cleanup = this.ledger.pendingResources().some(r => r.marker === context.marker) ? 'pending' : 'verified';
    } catch (error) { Object.assign(result, safeError(error)); result.cleanup = context && this.ledger.pendingResources().some(r => r.marker === context.marker) ? 'pending' : 'not_started'; }
    result.durationMs = Date.now() - begin; return result;
  }
  async close() {
    if (this.events.length) await fs.writeFile(path.join(this.directory, 'events.json'), JSON.stringify(this.events, null, 2), { mode: 0o600 });
    for (const backend of Object.values(this.backends)) await backend.close().catch(() => {});
    for (const lockPath of this.lockPaths || []) {
      if (!this.ledger) continue;
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (lock.ownerToken === this.ownerToken) {
        if (!this.ledger.pendingEntries().length && !this.ledger.pendingResources().length) await fs.unlink(lockPath);
        else await fs.writeFile(lockPath, JSON.stringify({ ...lock, active: false }), { mode: 0o600 });
      }
    }
  }
}
