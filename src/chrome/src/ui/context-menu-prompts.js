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
  onHeldPromptsChange = () => {},
}) {
  const acceptedContextMenuPromptIds = new Set();
  const trackedContextMenuPromptIds = new Set();
  const deferredContextMenuPrompts = [];
  const queuedContextMenuPrompts = [];
  // Prompts paused by a user Stop. They stay tracked and listed until the user
  // runs or deletes them; nothing starts them automatically.
  const heldContextMenuPrompts = [];
  const heldPromptActionIds = new Set();
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
    const restoreSelectionScope = !sourceGrounding && payload?.restoreSelectionScope === true;
    const createdAt = Number(payload?.createdAt);
    return {
      id,
      tabId,
      text,
      ...(sourceGrounding ? { sourceGrounding } : {}),
      ...(selectionAction ? { selectionAction } : {}),
      ...(restoreSelectionScope ? { restoreSelectionScope: true } : {}),
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
      ...(payload?.held === true ? { held: true } : {}),
    };
  }

  function contextMenuPromptMatchesCurrentTab(payload) {
    const currentTabId = getCurrentTabId();
    return payload?.tabId == null || currentTabId == null || Number(payload.tabId) === Number(currentTabId);
  }

  function promptBelongsToTab(prompt, numericTabId) {
    return prompt?.tabId == null || Number(prompt.tabId) === numericTabId;
  }

  function notifyHeldPromptsChange(tabId) {
    try { onHeldPromptsChange(tabId); } catch { /* the list is redrawn on the next change */ }
  }

  // List a prompt as paused by Stop. It stays tracked, so repeated deliveries
  // of the same prompt cannot start it.
  function addHeldPrompt(payload) {
    clearClaimRetry(payload.id);
    trackedContextMenuPromptIds.add(payload.id);
    if (!heldContextMenuPrompts.some(prompt => prompt.id === payload.id)) {
      heldContextMenuPrompts.push({ ...payload, held: true });
    }
    notifyHeldPromptsChange(payload.tabId);
  }

  // The prompt is gone for good (deleted, cleared, replaced or already run);
  // late deliveries of its ID are ignored.
  function forgetHeldPrompt(promptId) {
    const index = heldContextMenuPrompts.findIndex(prompt => prompt.id === promptId);
    const [prompt] = index === -1 ? [] : heldContextMenuPrompts.splice(index, 1);
    trackedContextMenuPromptIds.delete(promptId);
    acceptedContextMenuPromptIds.add(promptId);
    clearClaimRetry(promptId);
    if (prompt) notifyHeldPromptsChange(prompt.tabId);
  }

  // The background keeps one pending prompt per tab, so a newer prompt for
  // the tab has replaced any older held one.
  function forgetReplacedHeldPrompts(payload) {
    const createdAt = Number(payload?.createdAt);
    if (payload?.tabId == null || !Number.isFinite(createdAt)) return;
    for (const prompt of heldContextMenuPrompts.slice()) {
      if (prompt.id !== payload.id && prompt.tabId != null
          && Number(prompt.tabId) === Number(payload.tabId)
          && Number(prompt.createdAt) < createdAt) forgetHeldPrompt(prompt.id);
    }
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
    forgetReplacedHeldPrompts(payload);
    // Held by an earlier Stop (reopened panel, another panel instance).
    if (payload.held) {
      addHeldPrompt(payload);
      return;
    }
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

  function hasQueuedForTab(tabId) {
    const numericTabId = Number(tabId);
    if (!Number.isFinite(numericTabId)) return false;
    const matchesTab = (prompt) => (
      prompt?.tabId == null || Number(prompt.tabId) === numericTabId
    );
    return queuedContextMenuPrompts.some(matchesTab)
      || deferredContextMenuPrompts.some(matchesTab);
  }

  // A user Stop holds every prompt this panel queued for the tab, here and in
  // durable storage, so nothing starts on its own afterwards. Prompts that
  // arrive later run as usual.
  function holdQueuedForTab(tabId) {
    const numericTabId = Number(tabId);
    if (!Number.isFinite(numericTabId)) return;
    const prompts = [];
    for (const list of [queuedContextMenuPrompts, deferredContextMenuPrompts]) {
      prompts.push(...list.filter(prompt => promptBelongsToTab(prompt, numericTabId)));
      list.splice(0, list.length, ...list.filter(prompt => !promptBelongsToTab(prompt, numericTabId)));
    }
    for (const prompt of prompts) {
      addHeldPrompt(prompt);
      Promise.resolve()
        .then(() => sendToBackground('hold_context_menu_prompt', {
          tabId: prompt.tabId ?? numericTabId,
          promptId: prompt.id,
        }))
        .then((result) => {
          // Already run, cleared or replaced by a newer prompt.
          if (result?.held === false && result.reason === 'missing') forgetHeldPrompt(prompt.id);
        })
        .catch(() => { /* the background hold taken at Stop still applies */ });
    }
  }

  function getHeldForTab(tabId) {
    const numericTabId = Number(tabId);
    if (!Number.isFinite(numericTabId)) return [];
    return heldContextMenuPrompts
      .filter(prompt => promptBelongsToTab(prompt, numericTabId))
      .map(prompt => ({ id: prompt.id, tabId: prompt.tabId, text: prompt.text }));
  }

  // Explicit Run: release the durable hold, then claim and run the prompt
  // through the normal path, keeping its grounding and selection action. A
  // failed request leaves it paused.
  async function runHeldPrompt(promptId) {
    const heldPrompt = heldContextMenuPrompts.find(prompt => prompt.id === String(promptId));
    if (!heldPrompt || heldPromptActionIds.has(heldPrompt.id)) return false;
    heldPromptActionIds.add(heldPrompt.id);
    try {
      const result = await sendToBackground('resume_context_menu_prompt', {
        tabId: heldPrompt.tabId ?? getCurrentTabId(),
        promptId: heldPrompt.id,
      });
      // Navigation or a conversation clear may have dropped it meanwhile.
      const index = heldContextMenuPrompts.indexOf(heldPrompt);
      if (index === -1) return false;
      if (!result?.resumed) {
        forgetHeldPrompt(heldPrompt.id);
        return false;
      }
      heldContextMenuPrompts.splice(index, 1);
      notifyHeldPromptsChange(heldPrompt.tabId);
      const payload = { ...heldPrompt };
      delete payload.held;
      routeTrackedContextMenuPrompt(payload);
      return true;
    } finally {
      heldPromptActionIds.delete(heldPrompt.id);
    }
  }

  // Explicit Delete: clear the prompt durably before dropping it from the list.
  async function deleteHeldPrompt(promptId) {
    const heldPrompt = heldContextMenuPrompts.find(prompt => prompt.id === String(promptId));
    if (!heldPrompt || heldPromptActionIds.has(heldPrompt.id)) return false;
    heldPromptActionIds.add(heldPrompt.id);
    try {
      await sendToBackground('clear_context_menu_prompt', {
        tabId: heldPrompt.tabId ?? getCurrentTabId(),
        promptId: heldPrompt.id,
      });
      forgetHeldPrompt(heldPrompt.id);
      return true;
    } finally {
      heldPromptActionIds.delete(heldPrompt.id);
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
        return await sendToBackground('release_context_menu_prompt_claim', {
          tabId: clearPayload.tabId,
          promptId: payload.id,
          claimantId,
        });
      } catch { return null; /* the durable lease still expires if release fails */ }
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
      if (claimResult?.reason === 'held' && getIsDocumentVisible()) {
        // A Stop paused it: list it for an explicit run instead of retrying.
        addHeldPrompt(payload);
      } else {
        trackedContextMenuPromptIds.delete(payload.id);
        // A different panel instance owns an active lease. A repeated delivery
        // may re-check the lease, but it cannot submit until the lease expires.
        scheduleClaimRetry(payload, claimResult?.leaseExpiresAt, claimResult?.retryAfterMs);
      }
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
    // Generic failures are normally delivery-ambiguous and must not replay a
    // prompt that the background already cleared. If releasing this exact claim
    // proves the durable prompt survived a pre-run cleanup failure, however,
    // schedule a fresh claim instead of stranding it until a panel remount.
    let accepted = false;
    let rejectedClaim = null;
    try {
      accepted = await sendMessage({
        // Automatic mode selection never routes these prompts out of Ask.
        ...(getAgentMode() === 'auto' ? { __mode: 'ask' } : {}),
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
        ...(payload.restoreSelectionScope === true ? { restoreSelectionScope: true } : {}),
      });
    } catch { /* confirm durable ownership below before retrying */ }
    if (!accepted && !rejectedClaim) {
      const releaseResult = await releasePromptClaim();
      if (releaseResult?.released || releaseResult?.reason === 'storage') {
        rejectedClaim = {
          reason: 'start-failed',
          leaseExpiresAt: releaseResult.leaseExpiresAt,
          retryAfterMs: releaseResult.retryAfterMs || (releaseResult.released ? 250 : 1_000),
        };
      }
    }
    runningContextMenuPromptId = null;
    if (!accepted && rejectedClaim?.reason === 'held' && getIsDocumentVisible()) {
      // A Stop landed between the claim and the run start.
      addHeldPrompt(payload);
    } else {
      trackedContextMenuPromptIds.delete(payload.id);
      if (accepted) {
        acceptedContextMenuPromptIds.add(payload.id);
        clearClaimRetry(payload.id);
      } else if (rejectedClaim) {
        scheduleClaimRetry(payload, rejectedClaim.leaseExpiresAt, rejectedClaim.retryAfterMs);
      }
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

  // Navigation drops every prompt for the tab. Conversation clear passes the
  // exact durably removed prompt ID so work created behind that transaction
  // remains queued for the fresh conversation.
  function clearQueuedForTab(tabId, { promptId = null } = {}) {
    const numericTabId = Number(tabId);
    if (!Number.isFinite(numericTabId)) return;
    const normalizedPromptId = promptId == null ? '' : String(promptId);
    const matchesTarget = (prompt) => Number(prompt?.tabId) === numericTabId
      && (!normalizedPromptId || prompt?.id === normalizedPromptId);
    const keep = (prompt) => !matchesTarget(prompt);
    if (normalizedPromptId) {
      // A notification already in flight for the durably cleared prompt may
      // arrive after this sweep. Treat its ID as consumed without suppressing
      // a newer prompt created behind the clear transaction.
      acceptedContextMenuPromptIds.add(normalizedPromptId);
      clearClaimRetry(normalizedPromptId);
    }
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
    const heldCount = heldContextMenuPrompts.length;
    for (const p of heldContextMenuPrompts) {
      if (!keep(p)) trackedContextMenuPromptIds.delete(p.id);
    }
    heldContextMenuPrompts.splice(0, heldContextMenuPrompts.length,
      ...heldContextMenuPrompts.filter(keep));
    if (heldContextMenuPrompts.length !== heldCount) notifyHeldPromptsChange(numericTabId);
    for (const [promptId, retry] of claimRetryTimers) {
      if (Number(retry?.tabId) === numericTabId
          && (!normalizedPromptId || promptId === normalizedPromptId)) clearClaimRetry(promptId);
    }
  }

  return {
    acceptContextMenuPrompt,
    drainQueuedContextMenuPrompts,
    hasQueuedForTab,
    consumePendingContextMenuPrompt,
    clearQueuedForTab,
    holdQueuedForTab,
    getHeldForTab,
    runHeldPrompt,
    deleteHeldPrompt,
  };
}
