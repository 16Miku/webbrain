import { redactSystemOneText } from './systemone-evidence.js';
import { completionStopError } from './completion-verifier.js';

// A negative outcome is honest reporting, but not by itself a reason to stop
// an authorized task. Keep recovery separate from success certification: it
// never supplies permission or dispatches an action, and has a finite budget.
export const INCOMPLETE_COMPLETION_REDIRECT_LIMIT = 2;

const text = value => redactSystemOneText(String(value ?? '')).slice(0, 600);
const parts = value => {
  const source = redactSystemOneText(String(value ?? '')).slice(0, 6000);
  return source.match(/[\s\S]{1,600}/g) || [];
};

function recordedResults(agent, tabId, run) {
  if (!(run.historyToolCallIdsBeforeRun instanceof Set)) return [];
  const messages = agent.conversations.get(tabId) || [];
  const names = new Map(), duplicates = new Set();
  for (const message of messages) for (const call of message.tool_calls || []) {
    if (!call.id || run.historyToolCallIdsBeforeRun.has(call.id)) continue;
    if (names.has(call.id)) duplicates.add(call.id);
    names.set(call.id, call.function?.name);
  }
  for (const id of duplicates) names.delete(id);
  return messages.filter(message => message.role === 'tool' && names.has(message.tool_call_id))
    .slice(-12).map(message => {
      const tool = names.get(message.tool_call_id);
      if (typeof tool !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(tool)) return null;
      let result;
      try {
        if (typeof message.content !== 'string' || message.content.length > 50000) return { tool };
        result = JSON.parse(agent._unwrapUntrusted?.(message.content) ?? message.content);
      } catch { return { tool }; }
      if (!result || typeof result !== 'object' || Array.isArray(result)) return { tool };
      const entry = { tool };
      for (const key of ['success', 'dispatched', 'noDispatch', 'denied', 'cancelled', 'outcomeUnknown',
        'verified', 'remoteStateVerified', 'stable', 'deletionDeclined', 'submitConfirmationRequired',
        'permissionRequired']) if (typeof result[key] === 'boolean') entry[key] = result[key];
      for (const key of ['error', 'attachmentState', 'previousUrl', 'currentUrl']) {
        if (typeof result[key] === 'string') entry[key] = text(result[key]);
      }
      // The user's own refusal on a WebBrain card (a deletion, a submit or a
      // permission), as structured data the continuation judge can rely on.
      if (result.deletionDeclined === true
          || (result.denied === true && (result.submitConfirmationRequired === true || result.permissionRequired === true))) {
        entry.userDeclined = true;
      }
      return entry;
    }).filter(Boolean);
}

export async function incompleteCompletionBlock(agent, tabId, { outcome, summary, pageState, pageUrl = '', terminalOnly = false }) {
  const guard = agent._planExecutionGuards.get(tabId);
  const run = agent.completionInvariants.get(tabId);
  if (terminalOnly || !['partial', 'failed'].includes(outcome) || !guard?.enabled || guard.taskDrifted
      || !run?.runToken || !pageState || agent._checkAbort(tabId)
      || agent._captchaGateStates?.get(tabId)?.status === 'manual_required'
      || Number(guard.incompleteCompletionRedirects || 0) >= INCOMPLETE_COMPLETION_REDIRECT_LIMIT) return null;
  const signal = agent._runAbortSignal(tabId);
  agent._throwIfAborted(signal);
  const provider = agent._activeProvider(tabId), taskKey = agent._progressTaskKeyHash(tabId);
  const runToken = run.runToken;
  const current = () => !agent._checkAbort(tabId) && !agent._hasPendingSteering(tabId)
    && !agent._hasUnvalidatedSteering(tabId) && agent._planExecutionGuards.get(tabId) === guard
    && agent.completionInvariants.get(tabId)?.runToken === runToken
    && agent._progressTaskKeyHash(tabId) === taskKey && agent._activeProvider(tabId) === provider;
  const changed = () => ({ success: false, blockedDone: true, recoverableIncomplete: true,
    error: 'The task or observed document changed while the incomplete result was checked. Reconsider the current task and fresh page before finishing.' });
  if (!current()) return changed();
  try {
    // The agent stamp also binds a submitted iframe when present. Keep that
    // composed identity intact across the await; the page probe identifies
    // only the parent document, and must be compared to its parent component.
    const identity = await agent._completionDocumentStamp(tabId, true);
    if (!identity) return null;
    let parentIdentity = identity;
    try { const composed = JSON.parse(identity); if (Array.isArray(composed)) parentIdentity = composed[0]; } catch {}
    if (pageState.documentIdentity && pageState.documentIdentity !== parentIdentity) return changed();
    // A refusal settles only the action it answered. The judge still decides
    // whether other requested work remains; it never reopens the refused one.
    const results = recordedResults(agent, tabId, run);
    const declined = results.some(entry => entry.userDeclined === true);
    const request = agent._progressTaskAnchorText(tabId) || agent._latestTaskText(tabId) || '';
    const reading = await agent._semanticDecision(tabId, 'incomplete_task', { request, page: {
      candidate_summary_not_proof: text(summary),
      requested_outcome: outcome,
      observed_url: text(pageUrl),
      starting_source_url: text(guard.siteWorkflowUrl),
      approved_plan: parts(guard.approvedPlanText),
      observed_page: parts(pageState.workflowPageText),
      observed_status: (pageState.liveRegionMessages || []).slice(0, 6).map(text),
      observed_controls: (pageState.incompleteTaskControls || []).slice(0, 8).map(control => ({
        label: text(control?.label), disabled: control?.disabled === true,
        busy: control?.busy === true, progress: text(control?.progress),
      })),
      recorded_current_results: results,
      recorded_task_progress: { successfulTools: Number(guard.successfulTaskToolCalls || 0),
        consequentialTools: Number(guard.successfulConsequentialToolCalls || 0),
        verifiedSubmission: guard.verifiedSubmissionEvidence === true },
      latest_action: run.lastAction ? { tool: run.lastAction.name, uncertain: run.lastAction.uncertain === true } : null,
      redirects_remaining: INCOMPLETE_COMPLETION_REDIRECT_LIMIT - Number(guard.incompleteCompletionRedirects || 0),
    } }, { provider, signal });
    agent._throwIfAborted(signal);
    if (!current() || await agent._completionDocumentStamp(tabId, true) !== identity) return changed();
    if (!['continue_now', 'wait_then_check'].includes(reading?.choice)) return null;
    guard.incompleteCompletionRedirects = Number(guard.incompleteCompletionRedirects || 0) + 1;
    return { success: false, blockedDone: true, recoverableIncomplete: true,
      recovery: reading.choice,
      error: reading.choice === 'wait_then_check'
        ? 'The authorized task is still in progress. Wait for the relevant completion control or state with wait_for_element, or use a bounded wait_for_stable followed by a fresh page/status read. Continue the authorized flow when ready. Do not re-upload or repeat a submission already dispatched. For a longer external wait, use schedule_resume only when available and appropriate; otherwise explain the concrete remaining blocker after checking.'
        : (declined ? 'The user declined one action on WebBrain\'s card; that refusal is final. Do not retry it, ask again or reach it another way. ' : '')
          + 'The authorized task still has a reasonable next step. Inspect the current page and available source/history, retrieve the missing information when possible, and continue with the permitted tools. Use clarify for essential information only the user can provide. Do not repeat a consequential action already dispatched. Finish partial or failed only for a concrete blocker or after reasonable recovery has been tried.',
    };
  } catch (error) {
    if (completionStopError(error, signal) || agent._isCostAllowanceError(error) || agent._checkAbort(tabId)) throw error;
    return null;
  }
}
