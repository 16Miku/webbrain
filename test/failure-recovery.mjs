import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const extensionApi = {
  storage: { local: area, session: area },
  runtime: { getURL: path => `extension://owned/${path}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://owned.example.test/' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = globalThis.browser = extensionApi;

for (const browser of ['chrome', 'firefox']) {
  const { FailureRecoveryRegistry, modelFailureRecovery } = await import(`../src/${browser}/src/agent/failure-recovery.js`);
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  const { projectTraceEventData } = await import(`../src/${browser}/src/trace/privacy.js`);
  const tabId = 42;
  const task = 'Publish exactly Hello to the owned account.';
  const generic = { stage: 'inference', code: 'request_failed', message: 'Failed while contacting the model.' };

  function setup() {
    const agent = new Agent({ getActive: () => ({ name: 'fixture', model: 'fixture', config: {} }) });
    agent._persist = () => {};
    agent.conversationIds.set(tabId, 'private-conversation');
    agent.conversations.set(tabId, [{ role: 'system', content: 'Follow the current user task.' },
      { role: 'user', content: task, webbrainUserAuthoredText: task }]);
    return agent;
  }

  function publicationFixture(agent, guardTaskKey = agent._progressTaskKeyHash(tabId)) {
    const social = { key: 'private-contract', actionId: 'p1', deniedAuditKey: 'private-publication',
      contract: { status: 'ready', requirements: { kind: 'all', items: ['p1'] }, actions: [{ id: 'p1' }] },
      outcomes: {} };
    agent._planExecutionGuards.set(tabId, { enabled: true, taskKey: guardTaskKey, pendingDownloadIds: [],
      socialPublication: social });
    return social;
  }

  function monitoringFixture(agent) {
    agent.conversationModes.set(tabId, 'act');
    agent._pageFeedbackRuns ??= new Map();
    agent._pageFeedbackRuns.set(tabId, { url: 'https://owned.example.test/', token: 'old-run',
      frames: new Map([[0, { token: 'owned-document', id: 'browser-document' }]]),
      documents: new Map([[0, { id: 'browser-document' }]]), events: new Map(), gestures: new Set(), gestureLeases: new Map() });
    return agent._offerFailureRecovery(tabId, { stage: 'action_preparation', code: 'action_context_unverified',
      message: 'The current control has no certified owner.' });
  }

  test(`${browser}: context Retry reserves a private grant for exactly its accepted request`, () => {
    const agent = setup(), offer = monitoringFixture(agent);
    assert.equal(offer.retryMode, 'action_monitoring_relaxed');
    assert.equal(agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry').ok, false);
    assert.equal(agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry', 'owned-retry').ok, true);
    const retry = agent._failureRecovery.monitoringRetries.get(tabId);
    assert.equal(agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry', 'owned-retry').ok, true);
    assert.equal(agent._failureRecovery.monitoringRetries.get(tabId).grantToken, retry.grantToken);
    assert.equal(agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry', 'different-retry').ok, false);
    assert.doesNotMatch(JSON.stringify(offer), /owned-document|browser-document|grantToken|taskSignature/);
    assert.equal(agent._failureRecovery.takeMonitoringRetry(agent._failureRecoveryBinding(tabId), 'different-retry'), null);
    assert.equal(agent._failureRecovery.takeMonitoringRetry(agent._failureRecoveryBinding(tabId), 'owned-retry'), retry);
    assert.equal(agent._failureRecovery.takeMonitoringRetry(agent._failureRecoveryBinding(tabId), 'owned-retry'), null);
    assert.equal(agent._pendingFailureRecoveryForUi(tabId), null);
  });

  test(`${browser}: rejected startup restores the monitoring Retry option with fresh UI authority`, async () => {
    const agent = setup(), offer = monitoringFixture(agent), updates = [];
    agent._finishPageFeedbackRun(tabId);
    agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry', 'failed-start');
    agent.setRunStartGuard(() => { throw new Error('fixture startup denied'); });
    await assert.rejects(agent._claimRunEntry(tabId, 'interactive', {
      trustedContinuation: true, detachedRequestId: 'failed-start' }, (type, data) => updates.push({ type, data })), /startup denied/);
    const restored = agent._pendingFailureRecoveryForUi(tabId);
    assert.equal(agent.isRunning(tabId), false);
    assert.equal(restored.retryMode, 'action_monitoring_relaxed');
    assert.notEqual(restored.recoveryId, offer.recoveryId);
    assert.equal(updates.filter(update => update.type === 'failure_recovery').length, 1);
    assert.equal(agent.requestFailureRecovery(tabId, restored.recoveryId, 'retry', 'another-start').ok, true);
  });

  test(`${browser}: monitoring grant expires on intervention, navigation and exact task changes`, () => {
    for (const change of ['input', 'navigation', 'task', 'document']) {
      const agent = setup(), offer = monitoringFixture(agent);
      agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry', 'retry-request');
      const retry = agent._failureRecovery.takeMonitoringRetry(agent._failureRecoveryBinding(tabId), 'retry-request');
      const run = agent._pageFeedbackRuns.get(tabId);
      run.monitoringRetry = retry; retry.started = true;
      agent._runningTabs.add(tabId);
      agent._beginSteeringRun(tabId, () => {}, { detachedRequestId: 'retry-request' });
      assert.equal(agent._monitoringRetryCurrent(tabId), retry);
      agent._queuePageFeedback(tabId, { kind: 'dom', source: 'unknown', frameId: 0, target: 'span' });
      assert.equal(agent._monitoringRetryCurrent(tabId), retry, 'Unowned DOM-only counters are tolerated in the approved retry.');
      if (change === 'input') agent._queuePageFeedback(tabId, { kind: 'input', source: 'user', frameId: 0 });
      if (change === 'navigation') agent.observePageNavigation({ tabId, frameId: 0, url: run.url }, 'history');
      if (change === 'task') agent.conversations.get(tabId).push({ role: 'user', content: 'A changed exact task.' });
      if (change === 'document') run.frames.get(0).token = 'replacement-document';
      assert.equal(agent._monitoringRetryCurrent(tabId), null, change);
      assert.equal(retry.invalidated, true, change);
      agent._releaseRunEntry(tabId);
      assert.equal(agent._pendingFailureRecoveryForUi(tabId), null);
    }
  });

  test(`${browser}: accepted startup correction permanently expires a retry even if startup subsequently rejects`, async () => {
    const agent = setup(), offer = monitoringFixture(agent);
    agent._finishPageFeedbackRun(tabId);
    agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry', 'corrected-start');
    let rejectGuard, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    agent.setRunStartGuard(() => { entered(); return new Promise((_resolve, reject) => { rejectGuard = reject; }); });
    const attempt = agent._claimRunEntry(tabId, 'interactive', { trustedContinuation: true, detachedRequestId: 'corrected-start' }, () => {});
    await ready;
    assert.equal(agent.steerMessage(tabId, 'Cancel this task.', { requestId: 'corrected-start', messageId: 'correction' }).accepted, true);
    rejectGuard(new Error('startup rejected after correction'));
    await assert.rejects(attempt, /startup rejected after correction/);
    assert.equal(agent._pendingFailureRecoveryForUi(tabId), null);
    assert.equal(agent._monitoringRetryStarts.has(tabId), false);
  });

  test(`${browser}: grant metadata is finite and its token stays private`, () => {
    const metadata = projectTraceEventData('note', { note: 'page_action_validation', extra: {
      retryMode: 'action_monitoring_relaxed', certificationFailure: 'owner_unresolved', predicate: 'target_changed',
      monitoringRelaxed: true, targetCount: 30, captureMs: 100, grantToken: 'private-token', text: 'private-body' } });
    assert.equal(metadata.extra.retryMode, 'action_monitoring_relaxed');
    assert.equal(metadata.extra.certificationFailure, 'owner_unresolved');
    assert.equal(metadata.extra.monitoringRelaxed, true);
    assert.doesNotMatch(JSON.stringify(metadata), /private-token|private-body/);
    // Why a binding changed is a fixed name, kept so a refused click says why.
    for (const predicate of ['semantic_binding_changed', 'target_hit_changed']) {
      assert.equal(projectTraceEventData('note', { note: 'page_action_validation', extra: { status: 'blocked', predicate } }).extra.predicate, predicate);
    }
    const bad = projectTraceEventData('note', { note: 'page_action_validation', extra: {
      certificationFailure: 'private-body', predicate: 'private-secret', monitoringRelaxed: 'private-mode', captureMs: 'private-time' } });
    assert.doesNotMatch(JSON.stringify(bad), /private-body|private-secret|private-mode|private-time/);
  });

  test(`${browser}: preparation-only passive veto retains the context failure after original-target revalidation`, async () => {
    const agent = setup(); monitoringFixture(agent);
    const run = agent._pageFeedbackRuns.get(tabId);
    const state = run.modelState = { token: run.token, url: run.url, frames: new Map(run.frames), steeringRevision: 0,
      actionBinding: { runToken: run.token, documentToken: 'owned-document', snapshotToken: 'original-observation' } };
    const previous = extensionApi.tabs.sendMessage;
    let changed = false, validations = 0;
    extensionApi.tabs.sendMessage = async (_tab, message) => {
      assert.equal(message.action, 'page_monitor_validate_model'); validations++;
      return { ready: false, runToken: run.token, documentToken: 'owned-document', snapshotToken: 'original-observation',
        ...(changed ? { reason: 'target_changed' } : { uncertified: true, certificationFailure: 'owner_unresolved' }) };
    };
    try {
      run.actionContextUnverified = true;
      const honest = await agent._pageFeedbackPreparationFailure(tabId, 'click_ax', { ref_id: 'ref_original' }, state);
      assert.equal(honest.noDispatch, true);
      assert.equal(honest.errorCode, 'action_context_unverified');
      assert.equal(honest.actionContextUnverified, true);
      changed = true;
      const drift = await agent._pageFeedbackPreparationFailure(tabId, 'click_ax', { ref_id: 'ref_original' }, state);
      assert.equal(drift.actionContextUnverified, undefined, 'Real target changes cannot be reported as the bypassable certificate failure.');
      assert.equal(validations, 2);
    } finally { extensionApi.tabs.sendMessage = previous; agent._finishPageFeedbackRun(tabId); }
  });

  test(`${browser}: recovery registry expires private task signatures even when normalized task keys match`, () => {
    const registry = new FailureRecoveryRegistry();
    const binding = { tabId, conversationId: 'c', taskKey: 'tk_same', taskSignature: 'exact-first' };
    const descriptor = { recoveryId: 'r', stage: 'inference' };
    registry.offer(binding, descriptor);
    binding.conversationId = 'mutated';
    descriptor.recoveryId = 'mutated';
    assert.equal(registry.current({ tabId, conversationId: 'c', taskKey: 'tk_same', taskSignature: 'exact-first' }).descriptor.recoveryId, 'r');
    assert.equal(registry.current({ tabId: 99, conversationId: 'c', taskKey: 'tk_same', taskSignature: 'exact-first' }), null);
    assert.equal(registry.current({ tabId, conversationId: 'c', taskKey: 'tk_same', taskSignature: 'exact-second' }), null);
    assert.equal(registry.current({ tabId, conversationId: 'c', taskKey: 'tk_same', taskSignature: 'exact-first' }), null);
  });

  test(`${browser}: model recovery keeps raw provider details outside the friendly message`, () => {
    const error = Object.assign(new Error('webbrain-cloud error 400: {"error":{"code":"webbrain_cloud_upstream_error"}}'),
      { code: 'webbrain_cloud_upstream_error' });
    const model = modelFailureRecovery(error);
    assert.match(model.message, /WebBrain Cloud/);
    assert.doesNotMatch(model.message, /400|\{"error"/);
    assert.equal(model.diagnostics, error.message);
    const after = modelFailureRecovery(error, { postAction: true });
    assert.match(after.message, /action may have completed/);
    assert.match(after.message, /Review the current result before choosing Retry/);
    const earlier = modelFailureRecovery(error, { earlierSubmission: { host: 'mastoturk.org' } });
    assert.equal(earlier.message, 'Failed while contacting WebBrain Cloud. The model service could not finish this request. '
      + 'A submission on mastoturk.org was sent earlier in this task, so review the current result before choosing Retry.');
    assert.equal(earlier.stage, 'model');
    assert.equal(modelFailureRecovery(new Error('timed out'), { earlierSubmission: { host: '' } }).message,
      'Failed while requesting the model response. A submission was sent earlier in this task, so review the current result before choosing Retry.');
    // Without a submission the messages stay as they were.
    assert.equal(model.message, 'Failed while contacting WebBrain Cloud. The model service could not finish this request. You can retry from the current state.');
    assert.equal(modelFailureRecovery(new Error('timed out')).message, 'Failed while requesting the model response. You can retry from the current state.');
  });

  test(`${browser}: checker trace budgets survive metadata projection while raw validation content stays private`, () => {
    const request = projectTraceEventData('llm_request', { phase: 'planner_alignment', requestedMaxTokens: 2048,
      messages: [{ role: 'user', content: 'private-task-body' }] });
    assert.equal(request.requestedMaxTokens, 2048);
    assert.doesNotMatch(JSON.stringify(request), /private-task-body/);
    const response = projectTraceEventData('llm_response', { requestedMaxTokens: 4096, finishReason: 'length',
      emptyReason: 'output_limit', content: 'private-checker-body' });
    assert.equal(response.requestedMaxTokens, 4096);
    assert.equal(response.emptyReason, 'output_limit');
    assert.doesNotMatch(JSON.stringify(response), /private-checker-body/);
    const known = projectTraceEventData('note', { note: 'publication_checker_validation_failed',
      extra: { validationFailure: 'missing_authorized', attempt: 2, privateText: 'private-task-body' } });
    assert.equal(known.extra.validationFailure, 'missing_authorized');
    assert.doesNotMatch(JSON.stringify(known), /private-task-body/);
    const unknown = projectTraceEventData('note', { note: 'publication_checker_validation_failed',
      extra: { validationFailure: 'duplicate_private-user-authored-field', stage: 'private-stage',
        retryMode: 'private-mode', candidateAttempt: 'private-attempt' } });
    assert.doesNotMatch(JSON.stringify(unknown), /private-user-authored-field/);
    assert.doesNotMatch(JSON.stringify(unknown), /private-stage|private-mode|private-attempt/);
    const contract = projectTraceEventData('note', { note: 'publication_checker_validation_failed',
      extra: { validationFailure: 'Invalid publication contract: ambiguous start anchor' } });
    assert.equal(contract.extra.validationFailure, 'contract_ambiguous_start_anchor');
    assert.deepEqual(projectTraceEventData('note', contract), contract, 'Repeated exports preserve canonical diagnostics.');
    for (const kind of ['llm_request', 'llm_response']) {
      const invalid = projectTraceEventData(kind, { requestedMaxTokens: 'private-token-budget', emptyReason: 'private-reason' });
      assert.doesNotMatch(JSON.stringify(invalid), /private-token-budget|private-reason/);
    }
  });

  test(`${browser}: explicit generic Retry consumes its opaque offer without granting an audit bypass`, () => {
    const agent = setup(), events = [];
    let grants = 0;
    agent._grantSocialPublicationAuditRetry = () => { grants++; return true; };
    const offer = agent._offerFailureRecovery(tabId, { ...generic, retryMode: 'publication_without_audit',
      taskKey: 'private-task', publicationKey: 'private-publication' }, (type, data) => events.push({ type, data }));
    assert.ok(/^recovery_[a-z0-9]{24}$/.test(offer.recoveryId));
    assert.equal(offer.retryMode, 'resume');
    assert.equal(events[0].type, 'failure_recovery');
    const payload = JSON.stringify(offer);
    assert.doesNotMatch(payload, /private-conversation|private-task|private-publication|taskSignature|taskKey|conversationId/);
    assert.deepEqual(agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry'),
      { ok: true, continue: true, retryMode: 'resume' });
    assert.equal(grants, 0);
    assert.equal(agent._pendingFailureRecoveryForUi(tabId), null);
    assert.equal(agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry').ok, false);
  });

  test(`${browser}: Give up consumes the offer without continuing or granting publication permission`, () => {
    const agent = setup();
    let grants = 0;
    agent._grantSocialPublicationAuditRetry = () => { grants++; return true; };
    const offer = agent._offerFailureRecovery(tabId, { stage: 'publication_audit', taskKey: 't',
      publicationKey: 'private-publication', message: 'Failed during the publication check.' });
    const answer = agent.requestFailureRecovery(tabId, offer.recoveryId, 'give_up');
    assert.equal(answer.ok, true);
    assert.equal(answer.continue, false);
    assert.equal(grants, 0);
    assert.equal(agent._pendingFailureRecoveryForUi(tabId), null);
    assert.equal(agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry').ok, false);
  });

  test(`${browser}: Give up or Stop revokes an unused publication grant from live and carried state`, () => {
    for (const choice of ['give_up', 'stop']) {
      const agent = setup(), social = publicationFixture(agent);
      assert.equal(agent._grantSocialPublicationAuditRetry(tabId, {
        taskKey: agent._progressTaskKeyHash(tabId), publicationKey: social.deniedAuditKey }), true);
      const carried = agent._continuationExecutionEvidence.get(tabId).socialPublication;
      assert.ok(social.retryBypass);
      assert.ok(carried.retryBypass);
      const offer = agent._offerFailureRecovery(tabId, generic);
      if (choice === 'give_up') assert.equal(agent.requestFailureRecovery(tabId, offer.recoveryId, choice).continue, false);
      else agent.abort(tabId);
      assert.equal(social.retryBypass, null);
      assert.equal(carried.retryBypass, null);
      assert.equal(social.contract.status, 'ready');
      assert.equal(carried.contract.status, 'ready');
      assert.equal(agent._pendingFailureRecoveryForUi(tabId), null);
    }
  });

  test(`${browser}: invalid choices, wrong opaque IDs and other tabs cannot consume a valid offer`, () => {
    const agent = setup();
    const offer = agent._offerFailureRecovery(tabId, generic);
    for (const [id, choice] of [[offer.recoveryId, 'approve'], ['unknown', 'retry'], ['', 'give_up']]) {
      assert.equal(agent.requestFailureRecovery(tabId, id, choice).ok, false);
    }
    agent.conversationIds.set(99, 'private-conversation');
    agent.conversations.set(99, structuredClone(agent.conversations.get(tabId)));
    assert.equal(agent.requestFailureRecovery(99, offer.recoveryId, 'retry').ok, false);
    assert.equal(agent._pendingFailureRecoveryForUi(tabId).recoveryId, offer.recoveryId);
  });

  for (const revision of ['conversation', 'new task', 'case-only task', 'whitespace-only task']) {
    test(`${browser}: ${revision} invalidates the old recovery offer`, () => {
      const agent = setup(), offer = agent._offerFailureRecovery(tabId, generic);
      if (revision === 'conversation') agent.conversationIds.set(tabId, 'replacement-conversation');
      else {
        const revised = revision === 'case-only task' ? task.replace('Hello', 'hello')
          : revision === 'whitespace-only task' ? task.replace('Hello', 'Hello  ')
            : 'Read the owned page without publishing.';
        agent.conversations.get(tabId).push({ role: 'user', content: revised, webbrainUserAuthoredText: revised });
      }
      assert.equal(agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry').ok, false);
      assert.equal(agent._pendingFailureRecoveryForUi(tabId), null);
    });
  }

  test(`${browser}: recovery choices wait for an active run and retain the offer until it finishes`, () => {
    const agent = setup();
    agent._runningTabs.add(tabId);
    const offer = agent._offerFailureRecovery(tabId, generic);
    assert.ok(offer, 'A winding-down failed run can display its terminal recovery.');
    assert.equal(agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry').ok, false);
    assert.equal(agent._pendingFailureRecoveryForUi(tabId).recoveryId, offer.recoveryId);
    agent._runningTabs.delete(tabId);
    assert.equal(agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry').continue, true);
  });

  test(`${browser}: claiming a later run invalidates an old offer for the same task`, async () => {
    const agent = setup(), offer = agent._offerFailureRecovery(tabId, generic);
    agent.assertRunStartAllowed = async () => {};
    agent._beginPageFeedbackRun = async () => {};
    await agent._claimRunEntry(tabId, 'interactive');
    agent._releaseRunEntry(tabId);
    assert.equal(agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry').ok, false);
    assert.equal(agent._pendingFailureRecoveryForUi(tabId), null);
  });

  test(`${browser}: cancellation and pending steering do not create a new recovery offer`, () => {
    const agent = setup();
    agent.abortFlags.set(tabId, true);
    assert.equal(agent._offerFailureRecovery(tabId, generic), null);
    agent.abortFlags.delete(tabId);
    agent._beginSteeringRun(tabId, () => {}, {});
    agent._steeringRuns.get(tabId).messages.push({ id: 's', text: 'Change the task.' });
    assert.equal(agent._offerFailureRecovery(tabId, generic), null);
  });

  test(`${browser}: a failed publication grant expires recovery without allowing continuation`, () => {
    const agent = setup();
    const social = publicationFixture(agent);
    const offer = agent._offerFailureRecovery(tabId, { stage: 'publication_audit', taskKey: agent._progressTaskKeyHash(tabId),
      publicationKey: social.deniedAuditKey, message: 'Failed during publication.' });
    social.needsRecompile = true;
    const answer = agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry');
    assert.equal(answer.ok, false);
    assert.notEqual(answer.continue, true);
    assert.equal(social.retryBypass, undefined);
    assert.equal(agent._pendingFailureRecoveryForUi(tabId), null);
  });

  test(`${browser}: publication Retry binds current steering authority separately from the initiating guard`, () => {
    const agent = setup(), initiatingKey = agent._progressTaskKeyHash(tabId);
    const correction = 'Use the same exact body with the corrected account.';
    agent.conversations.get(tabId).push({ role: 'user', content: correction, webbrainUserAuthoredText: correction,
      webbrainSteering: { requestId: 'owned-run', messageId: 'owned-steering', revision: 1, parentTaskKey: initiatingKey } });
    assert.notEqual(agent._progressTaskKeyHash(tabId), initiatingKey);
    const social = publicationFixture(agent, initiatingKey);
    const offer = agent._offerFailureRecovery(tabId, { stage: 'publication_audit', taskKey: initiatingKey,
      publicationKey: social.deniedAuditKey, message: 'Failed during publication.' });
    assert.doesNotMatch(JSON.stringify(offer), /private-publication|taskKey|publicationTaskKey/);
    const answer = agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry');
    assert.equal(answer.ok, true);
    assert.equal(answer.continue, true);
    assert.equal(social.retryBypass.taskKey, initiatingKey);
    assert.equal(social.retryBypass.key, social.deniedAuditKey);
    assert.equal(agent._continuationExecutionEvidence.get(tabId).socialPublication.retryBypass.taskKey, initiatingKey);
    assert.equal(agent.requestFailureRecovery(tabId, offer.recoveryId, 'retry').ok, false);
  });

  test(`${browser}: post-submit recovery uses the real tool batch and observation recorder without replaying Submit`, async () => {
    const agent = setup(), messages = agent.conversations.get(tabId), dispatched = [], errors = [];
    const url = 'https://addons.mozilla.org/developers/addon/owned/finish';
    const provider = { name: 'fixture', model: 'fixture', promptTier: 'full', supportsTools: true, config: {} };
    agent.conversationModes.set(tabId, 'act');
    agent._completionVerdicts = new Map();
    agent._currentUrl = async () => url;
    agent._skipPermissionGate = true;
    agent._ensureGateSetting = async () => true;
    agent._chromeProtectedPageFailure = async () => null;
    agent._captchaMutationPreflight = async () => null;
    agent._adoptLiveSocialPublishWorkflow = async () => false;
    agent._workflowPreSubmitDispatchBlock = async () => null;
    agent._messageRecipientGuardBlock = async () => null;
    agent._detectLikelySubmitAction = async () => null;
    agent._isFormValidationCandidate = () => false;
    agent._preflightRichTextToolbarTarget = async () => ({ block: null });
    agent._socialPublicationPreSubmitBlock = async () => null;
    agent._auditRichTextToolbarTarget = async () => {};
    agent._shouldAutoScreenshot = () => false;
    agent._observeCaptchaChallenge = async () => ({ gate: null, loopCheck: { kind: 'none' } });
    agent._observeHuggingFaceSignupRecovery = async () => null;
    agent._planExecutionGuards.set(tabId, { requiresSubmission: true, requiresStateChange: true });
    agent._beginCompletionInvariant(tabId);
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_submit' },
      { success: true, dispatched: true, verified: true });
    agent._recordCompletionSubmitAttempt(tabId, { isSubmit: true }, 'click_ax', { ref_id: 'ref_submit' },
      url, url, { success: true, dispatched: true, verified: true }, 'document-1', 'document-1');
    const before = agent.completionInvariants.get(tabId);
    agent._lastAxScopes.set(tabId, { pageUrl: url, documentToken: 'document-1' });
    agent.executeTool = async (_tab, name, args) => {
      dispatched.push(name);
      if (name === 'get_accessibility_tree') {
        return { success: true, pageUrl: url, pageContent: 'status "Your submission was recorded" [ref_receipt]' };
      }
      assert.equal(name, 'done', 'Recovery may only observe and pass through the existing terminal pipeline.');
      assert.equal(agent._completionSubmitStates.get(tabId).observedAfterSubmit, true);
      assert.equal(agent._completionDoneBlock(tabId, 'done', args), null);
      agent._completionVerdicts.set(tabId, { outcome: 'succeeded' });
      return { success: true, done: true, outcome: 'success', summary: args.summary };
    };
    const executeBatch = agent._executeToolBatch.bind(agent);
    agent._executeToolBatch = async (...args) => {
      try { return await executeBatch(...args); } catch (error) { errors.push(String(error.stack || error)); throw error; }
    };
    const recovered = await agent._recoverPostActionModelFailure(tabId, messages, () => {}, provider, 4);
    assert.equal(recovered?.status, 'done', JSON.stringify({ recovered, dispatched, errors }));
    assert.match(recovered.content, /submitted for review/);
    assert.deepEqual(dispatched, ['get_accessibility_tree', 'done']);
    assert.notEqual(agent.completionInvariants.get(tabId), before);
    assert.equal(agent.completionInvariants.get(tabId).lastAction.sequence, before.lastAction.sequence);
    const recoveryCalls = messages.flatMap(message => message.tool_calls || []);
    assert.equal(recoveryCalls.length, 2);
    for (const call of recoveryCalls) {
      assert.equal(messages.filter(message => message.role === 'tool' && message.tool_call_id === call.id).length, 1);
    }
  });

  test(`${browser}: a model failure after the run moved to the next site names where the earlier post went`, async () => {
    // QA K1 with the real recorders: post on Mastodon, read the result, open
    // x.com for the X post, then the model request fails.
    const agent = setup(), messages = agent.conversations.get(tabId), updates = [], operations = [];
    const home = 'https://mastoturk.org/home';
    agent.conversationModes.set(tabId, 'act');
    agent._planExecutionGuards.set(tabId, { requiresSubmission: true, requiresStateChange: true });
    agent._beginCompletionInvariant(tabId);
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_publish' }, { success: true, dispatched: true });
    agent._recordCompletionSubmitAttempt(tabId, { isSubmit: true }, 'click_ax', { ref_id: 'ref_publish' },
      home, home, { success: true, dispatched: true }, 'document-1', 'document-1');
    assert.equal(agent._completionSubmissionIsLatestAction(tabId), true);
    agent._recordCompletionToolResult(tabId, 'get_accessibility_tree', {}, { success: true, pageContent: 'article "Hello"' });
    assert.equal(agent._completionSubmissionIsLatestAction(tabId), true, 'Reading the result is not a later step');
    agent._recordCompletionToolResult(tabId, 'navigate', { url: 'https://x.com' },
      { success: true, dispatched: true, verified: true, url: 'https://x.com/', pageUrlChanged: true });
    assert.equal(agent._completionSubmissionIsLatestAction(tabId), false);
    agent._executeToolBatch = async (_tab, calls) => { operations.push(calls[0].function.name); return { action: 'continue' }; };
    agent._currentUrl = async () => 'https://x.com/home';
    const error = Object.assign(new Error('local proxy timed out'), { code: 'TRANSPORT' });
    const result = await agent._finalModelFailure(tabId, messages, (type, data) => updates.push({ type, data }), {}, error, 7);
    assert.deepEqual(operations, [], 'Nothing is read or completed on x.com in the Mastodon post\'s name');
    assert.equal(result.status, 'partial');
    assert.equal(result.content, 'Failed while requesting the model response. A submission on mastoturk.org was sent '
      + 'earlier in this task, so review the current result before choosing Retry.');
    assert.equal(updates.find(x => x.type === 'failure_recovery').data.stage, 'model');
  });

  test(`${browser}: reconciliation stops on exact-task, conversation or in-place run-token changes during its read`, async () => {
    for (const change of ['exact-task', 'conversation', 'run-token']) {
      const agent = setup(), operations = [];
      agent.conversationModes.set(tabId, 'act');
      agent._beginCompletionInvariant(tabId);
      agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'submit' }, { success: true, dispatched: true });
      agent._completionSubmitStates.set(tabId, { dispatched: true,
        actionSequence: agent.completionInvariants.get(tabId).lastAction.sequence });
      agent._completionDoneBlock = () => null;
      agent._executeToolBatch = async (_tab, calls) => {
        const name = calls[0].function.name;
        operations.push(name);
        if (name === 'get_accessibility_tree') {
          if (change === 'exact-task') agent.conversations.get(tabId).push({ role: 'user',
            content: task.replace('Hello', 'hello'), webbrainUserAuthoredText: task.replace('Hello', 'hello') });
          if (change === 'conversation') agent.conversationIds.set(tabId, 'replacement-conversation');
          if (change === 'run-token') agent.completionInvariants.get(tabId).runToken = 'replacement-run';
        }
        return { action: 'continue' };
      };
      agent._currentUrl = async () => 'https://owned.example.test/result';
      assert.equal(await agent._recoverPostActionModelFailure(tabId, agent.conversations.get(tabId), () => {}, {}, 4), null);
      assert.deepEqual(operations, ['get_accessibility_tree'], change);
    }
  });

  function messageBoundary(agent) {
    const source = readFileSync(new URL(`../src/${browser}/src/background.js`, import.meta.url), 'utf8');
    const start = source.indexOf('async function handleFailureRecoveryResponse(');
    const end = source.indexOf('\nasync function handleMessage(', start);
    assert.ok(start >= 0 && end > start);
    const launches = [], starts = new Map();
    let snapshot = null;
    const context = vm.createContext({
      chrome: extensionApi, browser: extensionApi, agent, detachedRunStarts: starts,
      getRunUiSnapshot: async () => snapshot,
      assertNoActiveTabRun: () => {
        if (agent.isRunning(tabId) || starts.has(tabId)) throw new Error('An agent run is already active.');
      },
      launchDetachedRun: async (kind, message, sender) => {
        launches.push({ kind, message, sender });
        return { ok: true, accepted: true, requestId: message.requestId };
      },
    });
    vm.runInContext(source.slice(start, end), context);
    return { send: (message, sender = { url: extensionApi.runtime.getURL('src/ui/sidepanel.html') }) =>
      context.handleFailureRecoveryResponse(message, sender), launches, starts, setSnapshot: value => { snapshot = value; } };
  }

  test(`${browser}: only the extension sidepanel can consume a recovery and launch its continuation`, async () => {
    const agent = setup(), offer = agent._offerFailureRecovery(tabId, generic), boundary = messageBoundary(agent);
    const message = { action: 'failure_recovery_response', tabId, recoveryId: offer.recoveryId,
      choice: 'retry', requestId: 'owned-retry' };
    for (const url of ['https://owned.example.test/', extensionApi.runtime.getURL('src/ui/settings.html')]) {
      assert.equal((await boundary.send(message, { url })).ok, false);
    }
    assert.equal(boundary.launches.length, 0);
    assert.equal(agent._pendingFailureRecoveryForUi(tabId).recoveryId, offer.recoveryId);
    assert.equal((await boundary.send(message)).accepted, true);
    assert.equal(boundary.launches.length, 1);
    assert.equal(boundary.launches[0].kind, 'continue');
    assert.equal((await boundary.send(message)).ok, false);
    assert.equal(boundary.launches.length, 1);
  });

  test(`${browser}: background Give up and failed audit grants never launch a continuation`, async () => {
    const agent = setup(), boundary = messageBoundary(agent);
    const first = agent._offerFailureRecovery(tabId, generic);
    assert.equal((await boundary.send({ tabId, recoveryId: first.recoveryId, choice: 'give_up' })).continue, false);
    const publication = agent._offerFailureRecovery(tabId, { stage: 'publication_audit',
      publicationKey: 'missing', taskKey: 'missing', message: 'Failed during publication.' });
    assert.equal((await boundary.send({ tabId, recoveryId: publication.recoveryId, choice: 'retry', requestId: 'audit-retry' })).ok, false);
    assert.equal(boundary.launches.length, 0);
  });

  test(`${browser}: the background rejects malformed recovery messages before consuming a valid offer`, async () => {
    const agent = setup(), offer = agent._offerFailureRecovery(tabId, generic), boundary = messageBoundary(agent);
    const good = { tabId, recoveryId: offer.recoveryId, choice: 'retry', requestId: 'owned-request' };
    for (const changes of [{ tabId: 0 }, { tabId: -1 }, { tabId: 42.5 }, { tabId: 'invalid' },
      { recoveryId: null }, { recoveryId: {} }, { choice: 'approve' }]) {
      assert.equal((await boundary.send({ ...good, ...changes })).ok, false);
    }
    assert.equal(boundary.launches.length, 0);
    assert.equal(agent._pendingFailureRecoveryForUi(tabId).recoveryId, offer.recoveryId);
  });

  test(`${browser}: duplicate delivery acknowledges an existing continuation without consuming another offer`, async () => {
    const agent = setup(), offer = agent._offerFailureRecovery(tabId, generic), boundary = messageBoundary(agent);
    const message = { tabId, recoveryId: offer.recoveryId, choice: 'retry', requestId: 'same-ui-request' };
    boundary.starts.set(tabId, { requestId: message.requestId });
    assert.equal((await boundary.send(message)).accepted, true);
    boundary.starts.clear();
    boundary.setSnapshot({ kind: 'continue', requestId: message.requestId });
    assert.equal((await boundary.send(message)).accepted, true);
    assert.equal(boundary.launches.length, 0);
    assert.equal(agent._pendingFailureRecoveryForUi(tabId).recoveryId, offer.recoveryId);
  });
}
