/**
 * Context-menu prompt handling shared between Chrome and Firefox sidepanel.js.
 * The Chrome and Firefox copies of this file are identical — edit both together.
 */

import { normalizeSelectionAction, normalizeSelectionSourceGrounding } from '../context-menu-storage.js';

export function createContextMenuPromptHandler({
  getCurrentTabId,
  getIsProcessing,
  getAgentMode,
  setMode,
  getInputEl,
  autoResizeInput,
  sendMessage,
  sendToBackground,
  getIsDocumentVisible = () => true,
}) {
  const acceptedContextMenuPromptIds = new Set();
  const trackedContextMenuPromptIds = new Set();
  const deferredContextMenuPrompts = [];
  const queuedContextMenuPrompts = [];
  const claimRetryTimers = new Map();
  const claimantId = `sidepanel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let runningContextMenuPromptId = null;

  function normalizeContextMenuPromptPayload(raw) {
    const payload = raw?.prompt || raw;
    const text = String(payload?.text || '').trim();
    if (!text) return null;
    const numericTabId = payload?.tabId == null ? null : Number(payload.tabId);
    const tabId = Number.isFinite(numericTabId) ? numericTabId : null;
    const id = payload?.id
      ? String(payload.id)
      : `ctx-${tabId ?? 'unknown'}-${payload?.createdAt || Date.now()}-${text.length}`;
    const sourceGrounding = normalizeSelectionSourceGrounding(payload?.sourceGrounding) || null;
    // Only a source-bound prompt has a shortcut action to report; anything
    // else would be an unattributed id riding into the run options.
    const selectionAction = sourceGrounding ? normalizeSelectionAction(payload?.selectionAction) : '';
    return {
      id,
      tabId,
      text,
      ...(sourceGrounding ? { sourceGrounding } : {}),
      ...(selectionAction ? { selectionAction } : {}),
    };
  }

  function contextMenuPromptMatchesCurrentTab(payload) {
    const currentTabId = getCurrentTabId();
    return payload?.tabId == null || currentTabId == null || Number(payload.tabId) === Number(currentTabId);
  }

  function clearClaimRetry(promptId) {
    const retry = claimRetryTimers.get(promptId);
    if (retry?.timerId) clearTimeout(retry.timerId);
    claimRetryTimers.delete(promptId);
  }

  function scheduleClaimRetry(payload, leaseExpiresAt, retryAfterMs) {
    const expiry = Number(leaseExpiresAt);
    const retryDelay = Number(retryAfterMs);
    const retryAt = Number.isFinite(expiry) && expiry > 0
      ? expiry
      : Number.isFinite(retryDelay) && retryDelay > 0
        ? Date.now() + retryDelay
        : NaN;
    if (!payload?.id || !Number.isFinite(retryAt)) return;
    clearClaimRetry(payload.id);
    const delay = Math.max(50, retryAt - Date.now() + 25);
    const timerId = setTimeout(() => {
      claimRetryTimers.delete(payload.id);
      if (!getIsDocumentVisible()
          || acceptedContextMenuPromptIds.has(payload.id)
          || trackedContextMenuPromptIds.has(payload.id)
          || runningContextMenuPromptId === payload.id) return;
      acceptContextMenuPrompt(payload);
    }, delay);
    claimRetryTimers.set(payload.id, { tabId: payload.tabId, timerId });
  }

  function routeTrackedContextMenuPrompt(payload) {
    if (!getIsDocumentVisible()) {
      trackedContextMenuPromptIds.delete(payload.id);
      return;
    }
    if (getCurrentTabId() == null) {
      deferredContextMenuPrompts.push(payload);
      return;
    }

    // Queue prompts that belong to a different tab or arrive while busy.
    // drainQueuedContextMenuPrompts picks them up on tab switch or run completion.
    if (!contextMenuPromptMatchesCurrentTab(payload) || runningContextMenuPromptId || getIsProcessing()) {
      queuedContextMenuPrompts.push(payload);
      return;
    }
    runContextMenuPrompt(payload);
  }

  function acceptContextMenuPrompt(rawPayload) {
    const payload = normalizeContextMenuPromptPayload(rawPayload);
    if (!payload) return;
    if (!getIsDocumentVisible()) return;
    if (acceptedContextMenuPromptIds.has(payload.id) || trackedContextMenuPromptIds.has(payload.id)) return;
    trackedContextMenuPromptIds.add(payload.id);
    routeTrackedContextMenuPrompt(payload);
  }

  function flushDeferredContextMenuPrompts() {
    if (getCurrentTabId() == null || deferredContextMenuPrompts.length === 0) return;
    const deferred = deferredContextMenuPrompts.splice(0);
    queuedContextMenuPrompts.push(...deferred);
  }

  function drainQueuedContextMenuPrompts() {
    if (getCurrentTabId() == null || runningContextMenuPromptId || getIsProcessing()) return;
    flushDeferredContextMenuPrompts();
    if (runningContextMenuPromptId || getIsProcessing() || queuedContextMenuPrompts.length === 0) return;

    // Find first queued prompt that belongs to the currently active tab and run it.
    // Non-matching entries stay in the queue for when the user returns to that tab.
    const idx = queuedContextMenuPrompts.findIndex(p => contextMenuPromptMatchesCurrentTab(p));
    if (idx !== -1) {
      const [payload] = queuedContextMenuPrompts.splice(idx, 1);
      runContextMenuPrompt(payload);
    }
  }

  async function runContextMenuPrompt(payload) {
    if (!payload?.text) return;
    clearClaimRetry(payload.id);
    if (!getIsDocumentVisible()) {
      trackedContextMenuPromptIds.delete(payload.id);
      return;
    }
    if (runningContextMenuPromptId || getIsProcessing()) {
      queuedContextMenuPrompts.push(payload);
      return;
    }
    runningContextMenuPromptId = payload.id;

    const currentTabId = getCurrentTabId();
    const clearPayload = { tabId: payload.tabId ?? currentTabId, promptId: payload.id };
    const releasePromptClaim = async () => {
      try {
        await sendToBackground('release_context_menu_prompt_claim', {
          tabId: clearPayload.tabId,
          promptId: payload.id,
          claimantId,
        });
      } catch { /* the durable lease still expires if release fails */ }
    };
    let claimResult = null;
    try {
      claimResult = await sendToBackground('claim_context_menu_prompt', {
        tabId: clearPayload.tabId,
        promptId: payload.id,
        claimantId,
      });
    } catch {
      // Leave the durable prompt untouched. A visible panel can reclaim it
      // after this background connection or lease attempt recovers.
      claimResult = { claimed: false, reason: 'connection', retryAfterMs: 1_000 };
    }
    if (claimResult?.claimed && !getIsDocumentVisible()) {
      await releasePromptClaim();
      claimResult = { claimed: false, reason: 'panel-hidden', retryAfterMs: 250 };
    }
    if (!claimResult?.claimed || !getIsDocumentVisible()) {
      runningContextMenuPromptId = null;
      trackedContextMenuPromptIds.delete(payload.id);
      // A different panel instance owns an active lease. A repeated delivery
      // may re-check the lease, but it cannot submit until the lease expires.
      scheduleClaimRetry(payload, claimResult?.leaseExpiresAt, claimResult?.retryAfterMs);
      drainQueuedContextMenuPrompts();
      return;
    }
    const promptTabStillActive = getCurrentTabId() != null
      && contextMenuPromptMatchesCurrentTab(payload);
    if (getIsProcessing() || !promptTabStillActive) {
      await releasePromptClaim();
      runningContextMenuPromptId = null;
      queuedContextMenuPrompts.push(payload);
      drainQueuedContextMenuPrompts();
      return;
    }

    if (getAgentMode() !== 'ask') setMode('ask');
    getInputEl().value = payload.text;
    getInputEl().dispatchEvent(new Event('input', { bubbles: true }));
    autoResizeInput();

    // Pass clearPayload to sendMessage() so the background can clear storage
    // immediately when it starts the run — after receiving the request (so a
    // pre-acceptance crash preserves the prompt) but before the agent loop
    // (so a mid-run panel close does not replay it on reopen).
    // Don't re-queue on failure: by the time sendMessage() resolves or rejects,
    // the user message is already shown in the UI and the background has already
    // cleared storage, so re-queuing would duplicate the submission on the next
    // drain.  On a pre-receipt SW crash, storage is still intact and
    // consumePendingContextMenuPrompt() recovers the prompt on the next panel load.
    let accepted = false;
    let rejectedClaim = null;
    try {
      accepted = await sendMessage({
        contextMenuClear: clearPayload,
        contextMenuClaim: {
          promptId: payload.id,
          claimantId,
        },
        __onContextMenuClaimRejected: (result) => {
          rejectedClaim = result || { reason: 'claim-lost' };
        },
        ...(payload.sourceGrounding ? { sourceGrounding: payload.sourceGrounding } : {}),
        ...(payload.selectionAction ? { selectionAction: payload.selectionAction } : {}),
      });
    } catch { /* storage recovery can retry the prompt later */ }
    runningContextMenuPromptId = null;
    trackedContextMenuPromptIds.delete(payload.id);
    if (accepted) {
      acceptedContextMenuPromptIds.add(payload.id);
      clearClaimRetry(payload.id);
    } else if (rejectedClaim) {
      scheduleClaimRetry(payload, rejectedClaim.leaseExpiresAt, rejectedClaim.retryAfterMs);
    }
    drainQueuedContextMenuPrompts();
  }

  async function consumePendingContextMenuPrompt() {
    if (!getIsDocumentVisible()) return;
    const currentTabId = getCurrentTabId();
    if (currentTabId == null) return;
    try {
      const res = await sendToBackground('consume_context_menu_prompt', { tabId: currentTabId });
      if (res?.prompt) acceptContextMenuPrompt(res.prompt);
    } catch { /* best effort */ }
  }

  // Called when the background reports that a tab navigated to a new URL.
  // Drops any in-panel queued/deferred prompts for that tab so they aren't
  // submitted against the wrong page.
  function clearQueuedForTab(tabId) {
    const numericTabId = Number(tabId);
    if (!Number.isFinite(numericTabId)) return;
    const keep = (p) => Number(p.tabId) !== numericTabId;
    for (const p of queuedContextMenuPrompts) {
      if (!keep(p)) trackedContextMenuPromptIds.delete(p.id);
    }
    for (const p of deferredContextMenuPrompts) {
      if (!keep(p)) trackedContextMenuPromptIds.delete(p.id);
    }
    queuedContextMenuPrompts.splice(0, queuedContextMenuPrompts.length,
      ...queuedContextMenuPrompts.filter(keep));
    deferredContextMenuPrompts.splice(0, deferredContextMenuPrompts.length,
      ...deferredContextMenuPrompts.filter(keep));
    for (const [promptId, retry] of claimRetryTimers) {
      if (Number(retry?.tabId) === numericTabId) clearClaimRetry(promptId);
    }
  }

  return {
    acceptContextMenuPrompt,
    drainQueuedContextMenuPrompts,
    consumePendingContextMenuPrompt,
    clearQueuedForTab,
  };
}
