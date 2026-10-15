import { semanticCommitDocumentMatches } from './semantic-commit-navigation.js';
import { DECISION_SETTINGS_KEYS, resolveDecisionConfig } from './decision-config.js';
import { createSystemOneJudge } from './systemone-judge.js';
import { redactSystemOneText, wrapSystemOneData, boundedSystemOneText as boundedText } from './systemone-evidence.js';
import { COMPLETION_INSTRUCTIONS, LATER_OUTCOME_FIELD, SUMMARY_KIND_FIELD, completionQuestions, decisionCompletionVerdict, llmCompletionVerdict, verifyCompletion, withCompletionTimeout, completionStopError } from './completion-verifier.js';
import { calculationResultInText } from './calculator.js';
import { isPageIndependentCalculationCompletion, literalCalculationSummaryFormatMatches } from './page-feedback-policy.js';

// Tool IDs survive compaction and separate this execution from retained history.
// Reused assets and durable task receipts keep their own authority checks.
function currentExecutionToolCalls(agent, tabId) {
  const run = agent.completionInvariants.get(tabId);
  const messages = agent.conversations.get(tabId) || [];
  return run?.historyToolCallIdsBeforeRun instanceof Set
    ? messages.flatMap(message => message.tool_calls || [])
      .filter(call => call.id && !run.historyToolCallIdsBeforeRun.has(call.id)) : [];
}

export function completionReportingContext(agent, tabId) {
  const run = agent.completionInvariants.get(tabId);
  if (!run?.runToken) return null;
  const known = run.historyToolCallIdsBeforeRun instanceof Set;
  const calls = currentExecutionToolCalls(agent, tabId);
  const names = new Map(), duplicateIds = new Set();
  for (const call of calls) {
    if (names.has(call.id)) duplicateIds.add(call.id);
    names.set(call.id, call.function?.name);
  }
  for (const id of duplicateIds) names.delete(id);
  const records = (agent.conversations.get(tabId) || []).filter(message =>
    message.role === 'tool' && names.has(message.tool_call_id));
  const results = records.slice(-8).map(message => {
    const name = names.get(message.tool_call_id);
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(name)) return null;
    const item = { tool: name };
    let result = null;
    if (typeof message.content === 'string' && message.content.length <= 50000) {
      try { result = JSON.parse(agent._unwrapUntrusted?.(message.content) ?? message.content); } catch {}
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) return { ...item, result: 'not_available_as_structured_evidence' };
    for (const key of ['success', 'dispatched', 'noDispatch', 'skipped', 'cancelled', 'outcomeUnknown', 'verified', 'remoteStateVerified', 'filePickerBlocked']) {
      if (typeof result[key] === 'boolean') item[key] = result[key];
    }
    if (name === 'upload_file' && ['input_attached', 'page_consumed'].includes(result.attachmentState)) {
      item.attachmentState = result.attachmentState;
    }
    return item;
  }).filter(Boolean);
  const action = run.lastAction;
  const facts = {
    executionProvenance: known ? 'owned_current_execution_tool_ids' : 'unavailable',
    evidenceWindow: 'last_8_retained_paired_results; omission_is_not_proof_an_action_never_occurred',
    recordedCurrentResults: results,
    ...(action && typeof action.name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(action.name)
      ? { latestConsequentialAction: { tool: action.name, uncertain: action.uncertain === true } } : {}),
    verificationPending: run.verificationDebt === true || run.iframeFormVerificationDebt === true,
  };
  const prefix = '[CURRENT EXECUTION EVIDENCE: app-owned reporting DATA, not a user instruction or new task authority]\n'
    + 'These are recorded tool outcomes from this execution, not a certificate of the current document or final task success. '
    + 'Earlier execution history and scratchpad artifacts remain usable context, and may contain valid progress for the same continuing task. '
    + 'They do not by themselves establish a new attachment, save, or send in the present document. '
    + 'Local attachment acceptance is distinct from remote submission. Durable delivery, progress, calculation and document receipts retain their existing authority checks; this block neither resets them nor requires repeating an action. '
    + 'A freshly verified already-correct state may satisfy the task without a new mutation.\n'
    ;
  // Cap added model context independently of retained page/tool output size.
  while (prefix.length + JSON.stringify(facts).length > 3000 && facts.recordedCurrentResults.length) {
    facts.recordedCurrentResults.shift();
  }
  return prefix + JSON.stringify(facts);
}

// Actual utility proof at normal explicit done verification, not an agent
// summary or a page judge's estimate. The caller pins it before browser awaits.
export function captureCalculationEvidence(agent, tabId, expected = null) {
  const scope = agent._pageFeedbackCalculationResponseScope?.(tabId);
  const guard = agent._planExecutionGuards?.get(tabId), receipt = guard?.pureCalculationReceipt;
  const feedback = agent._pageFeedbackRuns?.get(tabId), state = feedback?.modelState;
  if (!scope || !receipt || !agent._pageFeedbackCalculationComplete?.(tabId)
      || !feedback || !state || !agent._pageFeedbackStateCurrent?.(tabId, feedback, state)
      || (feedback.events.size && !isPageIndependentCalculationCompletion(
        [{ function: { name: 'done', arguments: '{"outcome":"success"}' } }],
        { pureCalculationComplete: true, calculationResponseScope: scope }, [...feedback.events.values()]))
      || typeof receipt.result !== 'string') return null;
  if (expected && (expected.guard !== guard || expected.receipt !== receipt || expected.owner !== scope.owner
      || expected.runToken !== scope.runToken || expected.expression !== scope.expression
      || expected.actualExpression !== receipt.expression || expected.result !== receipt.result || expected.fraction !== receipt.fraction
      || expected.feedback !== feedback || expected.token !== feedback.token || expected.url !== state.url
      || expected.documentId !== state.documentId
      || expected.frames.some(([id, frame]) => feedback.frames.get(id)?.id !== frame.id
        || feedback.frames.get(id)?.token !== frame.token))) return null;
  return expected || { guard, receipt, owner: scope.owner, runToken: scope.runToken,
    expression: scope.expression, actualExpression: receipt.expression, result: receipt.result, fraction: receipt.fraction,
    feedback, token: feedback.token, url: state.url, documentId: state.documentId,
    frames: [...state.frames].map(([id, frame]) => [id, { ...frame }]) };
}

export function captureCalculationCompletion(agent, tabId, summary, expected = null) {
  const evidence = captureCalculationEvidence(agent, tabId, expected);
  const requirements = agent._pageFeedbackCalculationResponseScope?.(tabId)?.outputRequirements;
  return evidence && calculationResultInText(summary, evidence.result, evidence.fraction)
    && literalCalculationSummaryFormatMatches(summary, requirements, evidence.result, evidence.fraction) ? evidence : null;
}

export async function refreshCalculationEvidence(agent, tabId, expected) {
  if (!expected || !captureCalculationEvidence(agent, tabId, expected)) return null;
  try {
    const api = typeof browser !== 'undefined' ? browser : chrome;
    const [tab, frames] = await Promise.all([api.tabs.get(tabId), api.webNavigation?.getAllFrames?.({ tabId })]);
    const main = frames?.find(frame => frame.frameId === 0);
    if (tab?.url !== expected.url || (main?.url && main.url !== expected.url)
        || (expected.documentId && main?.documentId !== expected.documentId)) return null;
    for (const [frameId, original] of expected.frames) {
      const live = frames?.find(frame => frame.frameId === frameId);
      if (!live || (original.id && live.documentId !== original.id)) return null;
      if (!original.id) {
        const current = await api.tabs.sendMessage(tabId, { target: 'content', action: 'page_monitor_state', active: true }, { frameId });
        if (current?.ready !== true || current.active !== true || current.runToken !== expected.token
            || current.documentToken !== original.token || !captureCalculationEvidence(agent, tabId, expected)) return null;
      }
    }
    return captureCalculationEvidence(agent, tabId, expected);
  } catch { return null; }
}

export async function refreshCalculationCompletion(agent, tabId, summary, expected) {
  return await refreshCalculationEvidence(agent, tabId, expected)
    ? captureCalculationCompletion(agent, tabId, summary, expected) : null;
}

async function evidenceKey(state) {
  // Wrapper nonces delimit untrusted content; they are not evidence changes.
  const canonical = JSON.stringify(state, (_key, value) => typeof value === 'string'
    ? value.replace(/(<\/?untrusted_page_content) id="[^"]*"/g, '$1') : value);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

function invalidateCompletionProof(agent, tabId) {
  const guard = agent._planExecutionGuards.get(tabId);
  if (guard?.semanticSubmissionVerified) {
    guard.verifiedSubmissionEvidence = false;
    guard.semanticSubmissionVerified = false;
  }
  agent._completionVerdicts?.delete(tabId);
}

async function evaluateBrowserCompletion(agent, tabId, options = {}) {
  const { pageState = {}, pageUrl = '', summary = '', refreshOnly = false } = options;
  const calculationEvidence = Object.prototype.hasOwnProperty.call(options, 'calculationEvidence')
    ? options.calculationEvidence : captureCalculationEvidence(agent, tabId);
  const provider = agent._activeProvider(tabId);
  if (agent.strictSecretMode || !provider) {
    invalidateCompletionProof(agent, tabId);
    return { outcome: 'uncertain', engine: 'legacy', reason: 'unavailable' };
  }
  const stored = await chrome.storage.local.get(DECISION_SETTINGS_KEYS);
  const compass = provider.config?.providerName === 'webbrain-cloud' ? provider.config : null;
  const config = resolveDecisionConfig(stored, compass);
  const context = agent.systemOneContext(tabId);
  const signal = agent._runAbortSignal(tabId);
  const guard = agent._planExecutionGuards.get(tabId);
  const task = agent._progressTaskAnchorText?.(tabId) || guard?.taskText || agent._latestTaskText(tabId) || agent._originalTaskText(tabId);
  const run = agent.completionInvariants.get(tabId);
  const scope = JSON.stringify([run?.runToken, run?.lastAction?.sequence, agent._progressTaskKeyHash(tabId), config.provider, config.model, config.url, provider.model, provider.supportsVision, JSON.stringify(config)]);
  agent._completionVerdicts ??= new Map();
  const currentRun = () => context.isCurrent() && !signal?.aborted && agent._activeProvider(tabId) === provider
    && (!calculationEvidence || captureCalculationEvidence(agent, tabId, calculationEvidence))
    && scope === JSON.stringify([agent.completionInvariants.get(tabId)?.runToken, agent.completionInvariants.get(tabId)?.lastAction?.sequence, agent._progressTaskKeyHash(tabId), config.provider, config.model, config.url, provider.model, provider.supportsVision, JSON.stringify(config)]);
  const currentIdentity = async evidence => !!evidence.identity && currentRun()
    && JSON.stringify(resolveDecisionConfig(await chrome.storage.local.get(DECISION_SETTINGS_KEYS), compass)) === JSON.stringify(config)
    && evidence.identity === await agent._completionDocumentStamp(tabId, true) && currentRun();
  const current = async evidence => {
    if (!await currentIdentity(evidence)) return false;
    if (evidence.modality !== 'vision') {
      // Re-read the bounded AX evidence actually sent to the judge. Full-body
      // clocks/feeds outside that evidence do not establish staleness.
      const fresh = await capture('ax', true);
      return (!evidence.resultScope || fresh?.resultScope === evidence.resultScope)
        && fresh?.key === (evidence.key || evidence.evidenceKey) && await currentIdentity(evidence);
    }
    // Text and input stamps cannot detect canvas, image or CSS changes. Take a
    // new redacted, budgeted capture after the request; never reuse that cache.
    let fresh;
    try { fresh = await capture('vision', true); }
    catch (error) { if (completionStopError(error, signal)) throw error; }
    if (!await currentIdentity(evidence)) return false;
    if (fresh?.key === (evidence.key || evidence.evidenceKey)) return true;
    // Moving pixels cannot certify the old image, but need not mean the task
    // changed. Discard that verdict and judge a fresh AX read instead.
    throw Object.assign(new Error('Visual evidence changed or could not be refreshed.'), { code: 'COMPLETION_VISUAL_CHANGED' });
  };
  const messages = agent.conversations.get(tabId) || [];
  // Tool IDs survive conversation compaction. Unknown provenance or reused
  // pre-run IDs cannot certify that this task performed a required read.
  const calls = currentExecutionToolCalls(agent, tabId);
  const toolNames = new Map(calls.map(call => [call.id, call.function?.name]));
  const reads = messages.filter(m => m.role === 'tool' && /^(read_page|get_accessibility_tree|verify_form|iframe_read)$/.test(toolNames.get(m.tool_call_id) || ''));
  // The latest read of each of the four most recently read pages, so a page
  // the task depended on earlier (its rules, a source) is not crowded out by
  // repeated reads of the result page. Pages are told apart by the address
  // their read reports, never by what their text says.
  const readPage = message => {
    try {
      const result = JSON.parse(String(agent._unwrapUntrusted?.(message.content) ?? message.content));
      const address = typeof result?.url === 'string' ? result.url : '';
      return address ? address.replace(/#.*$/, '') : '';
    } catch { return ''; }
  };
  const latestReadByPage = new Map();
  for (const message of reads) {
    const key = readPage(message) || `read:${message.tool_call_id || latestReadByPage.size}`;
    latestReadByPage.delete(key);
    latestReadByPage.set(key, message);
  }
  const selectedReads = [...latestReadByPage.values()].slice(-4);
  const history = selectedReads.map(m => ({ tool: toolNames.get(m.tool_call_id) || m.name, evidence: wrapSystemOneData(boundedText(redactSystemOneText(String(m.content)), 450)) }));
  // A failed HTTP read may prove absence after a deletion. Supply only the
  // actual response status and URL, never response prose or a success waiver.
  // Pre-run/orphan tool IDs remain excluded by the current-run call map.
  const resourceReads = messages.filter(m => m.role === 'tool' && toolNames.get(m.tool_call_id) === 'fetch_url').slice(-2).flatMap(m => {
    let result; try { result = JSON.parse(String(agent._unwrapUntrusted?.(m.content) ?? m.content)); } catch { return []; }
    if (!Number.isInteger(result?.status) || result.status < 100 || result.status > 599 || typeof result.url !== 'string') return [];
    return [{ tool: 'fetch_url', evidence: wrapSystemOneData(JSON.stringify({
      url: boundedText(redactSystemOneText(result.url), 1000), status: result.status,
    })) }];
  });
  // Entered values can be secrets without recognizable labels. Action names
  // supply history without sending arbitrary tool arguments to another judge.
  const recordedActions = calls.filter(c => /^(type|fill|click|navigate|set_)/.test(c.function?.name || '')).slice(-8).map(c => ({ tool: c.function.name }));
  const resultSnapshot = async () => {
    try { return await agent._completionResultSnapshot?.(tabId); } catch { return null; }
  };
  const initialResult = await resultSnapshot();
  const preferAx = !!initialResult?.scopeRef && !!initialResult?.text;
  const captures = new Map();
  const capture = async (modality, refresh = false) => {
    const before = await agent._completionDocumentStamp(tabId, true);
    if (!semanticCommitDocumentMatches(agent._currentCompletionSubmitState(tabId), before)) return null;
    const cached = captures.get(modality);
    const reusable = cached?.identity === before && context.isCurrent();
    if (!refresh && reusable) return cached;
    // A new vision judgment needs both its evidence and its post-request
    // freshness capture. With only one slot left, use AX before paying a judge.
    if (modality === 'vision' && agent._canTakeAutoScreenshot?.(tabId, refresh || reusable ? 1 : 2) === false) return null;
    let observation, resultScope, resultView, resultFingerprint;
    if (modality === 'vision') {
      const result = await resultSnapshot();
      if (result?.identity === before && result.scopeRef && result.rect && result.viewport) {
        resultScope = result.scopeRef;
        resultView = { rect: result.rect, viewport: result.viewport };
        resultFingerprint = await evidenceKey([result.scopeRef, result.text, result.composerEmpty, result.truncated, result.controlFingerprint]);
      }
      if (refresh && cached?.resultScope && cached.resultScope !== resultScope) return null;
      let pixels = await agent._captureCompletionJudgeImage(tabId, resultView || null);
      if (!pixels) return null;
      const budget = agent._budgetForCapture();
      pixels = (await agent._shrinkImageForBudget(pixels, 0, 0, { ...budget, maxTargetPx: Math.min(1408, budget.maxTargetPx), maxTargetTokens: Math.min(1400, budget.maxTargetTokens) })).dataUrl;
      observation = { type: 'image_url', image_url: { url: pixels } };
    } else {
      const result = await resultSnapshot();
      if (result?.identity === before && result.scopeRef && typeof result.text === 'string' && result.text) {
        resultScope = result.scopeRef;
        resultFingerprint = await evidenceKey([result.scopeRef, result.text, result.composerEmpty, result.truncated, result.controlFingerprint]);
        observation = { observation: wrapSystemOneData(boundedText(redactSystemOneText(result.text), 4500)),
          truncated: result.truncated === true, composerEmpty: result.composerEmpty === true };
      }
      if (refresh && cached?.resultScope && cached.resultScope !== resultScope) return null;
      if (!observation) {
        const submit = agent._currentCompletionSubmitState(tabId);
        // Certify a single same-document form against its entire subtree rather
        // than unrelated page counters or feeds. Unknown/replaced scopes and
        // navigation still require the complete page. Live statuses and dialogs
        // outside the form are refreshed below and participate in freshness.
        const sameForm = guard?.requiresSubmission === true && !guard?.siteWorkflow?.job
          && Number(pageState.relevantFormCount) === 1 && submit?.dispatched === true
          && submit.observedAfterSubmit === true && submit.documentChanged !== true
          && /^ref_\d+$/.test(String(submit.formRef || ''))
          && agent._normalizeUrl(submit.originatingUrl || '') === agent._normalizeUrl(pageUrl)
          && agent._normalizeUrl(submit.currentUrl || '') === agent._normalizeUrl(pageUrl)
          && (!submit.originatingDocument || !submit.currentDocument || submit.originatingDocument === submit.currentDocument);
        let result = await agent.executeTool(tabId, 'get_accessibility_tree',
          sameForm ? { ref_id: submit.formRef, filter: 'all', maxDepth: 15, maxChars: 5500 } : { filter: 'all', maxDepth: 15, maxChars: 5500 });
        if (sameForm && (result?.success === false || result?.error || !result?.pageContent)) {
          result = await agent.executeTool(tabId, 'get_accessibility_tree', { filter: 'all', maxDepth: 15, maxChars: 5500 });
        }
        if (result?.success === false || !result?.pageContent) return null;
        observation = { observation: wrapSystemOneData(boundedText(redactSystemOneText(result.pageContent), 4500)) };
      }
    }
    // A bounded or scoped AX tree can omit inline confirmation outside a form.
    // Include visible live-region and open-dialog text separately and refresh it with the
    // evidence so a removed/replaced acknowledgement cannot preserve success.
    let liveStatusMessages = [];
    if (typeof agent._completionLiveStatusMessages === 'function') {
      try { liveStatusMessages = await agent._completionLiveStatusMessages(tabId); } catch { liveStatusMessages = null; }
    }
    const frame = typeof agent._completionIframeSnapshot === 'function' ? await agent._completionIframeSnapshot(tabId) : null;
    const identity = await agent._completionDocumentStamp(tabId, true);
    if (!identity || identity !== before || !context.isCurrent()) return null;
    const submit = agent._currentCompletionSubmitState(tabId);
    const binding = submit?.workflowBinding;
    const workflowBinding = binding ? { adapterName: binding.adapterName, revision: binding.revision,
      job: binding.job, verificationKind: binding.verificationKind, recipientBound: binding.recipientBound === true } : null;
    const info = {
      task: boundedText(redactSystemOneText(String(task || '')), guard?.approvedPlanAnchor ? 1700 : 2500),
      ...(guard?.approvedPlanAnchor ? { approved_plan: boundedText(redactSystemOneText(guard.approvedPlanAnchor), 800) } : {}),
      requirements: { requiresSubmission: guard?.requiresSubmission, requiresStateChange: guard?.requiresStateChange, workflow: boundedText(guard?.siteWorkflow?.job?.id, 120) },
      action: wrapSystemOneData(boundedText(redactSystemOneText(JSON.stringify({ submit: submit ? {
        dispatched: submit.dispatched, observedAfterSubmit: submit.observedAfterSubmit,
        formRef: submit.formRef,
        formValidationFailed: submit.formValidationFailed,
        completionSignalObserved: typeof agent._completionObservedSuccess === 'function'
          ? agent._completionObservedSuccess(submit) : submit.completionSignalObserved === true,
        documentChanged: submit.documentChanged, originatingUrl: submit.originatingUrl, resultingUrl: submit.currentUrl,
        workflowBinding,
      } : null, lastAction: run?.lastAction })), 1000)),
      recorded_reads: history, recorded_actions: recordedActions, document: boundedText(redactSystemOneText(pageUrl), 1000),
      ...(resultScope ? { result_scope: resultScope } : {}),
      ...(resultView ? { result_view: resultView } : {}),
      ...(calculationEvidence ? { recorded_calculations: [{ tool: 'calculate',
        expression: boundedText(calculationEvidence.actualExpression, 1000), result: boundedText(calculationEvidence.result, 1000),
        ...(calculationEvidence.fraction ? { fraction: boundedText(calculationEvidence.fraction, 1000) } : {}) }] } : {}),
      resource_reads: resourceReads,
      page_errors: wrapSystemOneData(boundedText(redactSystemOneText(JSON.stringify(pageState?.validationMessages || pageState?.errorMessages || [])), 500)),
      page_status_messages: wrapSystemOneData(boundedText(Array.isArray(liveStatusMessages)
        ? liveStatusMessages.map(text => redactSystemOneText(String(text))).join('\n') : '[Live status unavailable]', 900)),
      ...(frame ? { submitted_frame: wrapSystemOneData(boundedText(redactSystemOneText(JSON.stringify({
        url: frame.url, identity: frame.identity, stamp: frame.stamp, observedAfterSubmit: frame.observedAfterSubmit,
        messages: frame.messages, text: frame.text,
      })), 5000)) } : {}),
      candidate_summary_not_proof: wrapSystemOneData(boundedText(redactSystemOneText(String(summary)), 600)),
    };
    const state = [info, observation];
    // Fingerprint the complete local read too: redaction/truncation must not
    // let a changed result reuse an earlier judgment. Raw text stays local.
    const evidence = { identity, modality, state, ...(resultScope ? { resultScope } : {}), ...(frame ? { submittedFrameStamp: frame.stamp } : {}), key: await evidenceKey([state, resultFingerprint || null]) };
    captures.set(modality, evidence);
    return evidence;
  };
  const prior = agent._completionVerdicts.get(tabId);
  const priorCurrent = prior?.scope === scope && prior.outcome !== 'uncertain' && await current(prior).catch(error => {
    if (error?.code === 'COMPLETION_VISUAL_CHANGED') return false;
    throw error;
  });
  if (priorCurrent) {
    const fresh = await capture(prior.modality);
    if (fresh?.key === prior.evidenceKey) return prior;
  }
  invalidateCompletionProof(agent, tabId);
  // Scheduler checkpoints may reuse an already accepted verdict only while
  // its exact task/action/document/evidence remains current. Never pay for a
  // new judgment or promote an uncertain outcome during settlement.
  if (refreshOnly) return { outcome: 'uncertain', engine: 'freshness', reason: 'evidence_changed' };
  const online = globalThis.navigator?.onLine !== false;
  const decision = config.enabled && config.doneEnabled && (config.local || online) ? {
    name: config.provider, supportsVision: config.supportsVision,
    requiresIndependentSuccessConfirmation: config.requiresIndependentSuccessConfirmation === true,
    evaluate: async evidence => {
      const headers = compass ? { 'X-WebBrain-Device-Id': compass.deviceGuid || '', 'X-WebBrain-Client': 'extension', 'X-WebBrain-Help-Improve': compass.helpImproveWebBrain === false ? '0' : '1' } : {};
      const result = await agent.evaluateSystemOne(tabId, createSystemOneJudge({ maxRetries: 0 }), {
        config, state: evidence.state, questions: completionQuestions(), signal, headers,
        metadata: compass ? { session_id: agent.conversationIds.get(tabId), trace: { generation_name: 'completion_verification' } } : {},
      }, context);
      return decisionCompletionVerdict(result, config.threshold);
    },
  } : null;
  // These switches outsource checks to the decision sidecar. The approved
  // routing still uses the active LLM when that sidecar is off/unconfigured.
  const llm = typeof provider.chat === 'function' && (online || provider.config?.category === 'local') ? {
    name: 'llm', supportsVision: provider.supportsVision,
    evaluate: async (evidence, modality, { timeoutMs = 10000 } = {}) => {
      const [info, observation] = evidence.state;
      // Thinking providers count hidden reasoning inside their output limit.
      // Leave bounded room for it and the verdict without overriding the
      // provider's reasoning configuration or adding another model request.
      const result = await withCompletionTimeout(requestSignal => agent._chatWithCostAllowance(provider, [
        { role: 'system', content: `${COMPLETION_INSTRUCTIONS} Return only JSON {"outcome":"succeeded|pending|failed|uncertain","reason":"brief evidence-based reason","later":"asked|not_asked","summary":"result|meta_only|plan_only"}. ${LATER_OUTCOME_FIELD} ${SUMMARY_KIND_FIELD} Do not call tools or perform actions.` },
        { role: 'user', content: modality === 'vision' ? [{ type: 'text', text: JSON.stringify(info) }, observation] : JSON.stringify(evidence.state) },
      ], { temperature: 0, maxTokens: 4096, signal: requestSignal }, context.costState || agent._newCostRunState(), { tabId, generationName: 'completion_verification' }), signal,
      Math.max(1, Math.min(10000, Number(timeoutMs) || 10000)));
      if (result.costAllowanceMessage) throw agent._costAllowanceError(result.costAllowanceMessage);
      return { ...llmCompletionVerdict(result.content), model: provider.model };
    },
  } : null;
  const verdict = await verifyCompletion({ decision, llm, capture, isCurrent: current, signal, preferAx,
    onAttempt: ({ reason, ...metadata }) => agent.recordSystemOneVerdict(tabId, {
      phase: 'done_verification', ...metadata,
      // A model's own words never reach the trace: a sure verdict is recorded
      // as judged, an unsure one as insufficient evidence.
      ...(reason ? { reason: /^(?:capture_unavailable|unavailable|time_budget|COMPLETION_VISUAL_CHANGED|http_\d{3}|JEV_[A-Z_]+)$/.test(reason) ? reason
        : metadata.outcome && metadata.outcome !== 'uncertain' ? 'judged' : 'insufficient_evidence' } : {}),
    }, context) });
  const accepted = { ...verdict, scope, ...(captures.get(verdict.modality)?.submittedFrameStamp
    ? { submittedFrameStamp: captures.get(verdict.modality).submittedFrameStamp } : {}) };
  agent._completionVerdicts.set(tabId, accepted);
  return accepted;
}

export async function verifyBrowserCompletion(agent, tabId, options) {
  try {
    const calculationProof = Object.prototype.hasOwnProperty.call(options || {}, 'calculationProof')
      ? options.calculationProof : captureCalculationCompletion(agent, tabId, options?.summary);
    if (calculationProof) return await refreshCalculationCompletion(agent, tabId, options?.summary, calculationProof)
      ? { outcome: 'succeeded', engine: 'calculation', modality: 'utility' }
      : { outcome: 'pending', engine: 'freshness', reason: 'calculation_authority_changed' };
    return await evaluateBrowserCompletion(agent, tabId, options);
  }
  catch (error) {
    invalidateCompletionProof(agent, tabId);
    if ((error?.status ?? error?.httpStatus) === 402) error.code = 'WB_COST_ALLOWANCE';
    if (error?.code === 'STALE_COMPLETION') return { outcome: 'pending', engine: 'freshness', reason: 'evidence_changed' };
    if (completionStopError(error, agent._runAbortSignal(tabId))) throw error;
    return { outcome: 'uncertain', engine: 'legacy', reason: 'verifier_unavailable' };
  }
}
