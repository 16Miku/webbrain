/**
 * Receives a task typed into the WebBrain new tab (newtab/src/features/agent).
 *
 * The new tab stores { id, tabId, text, mode, createdAt } under a per-tab key
 * (`wbNewtabHandoff:<tabId>`, so two submissions can never overwrite each other)
 * and opens this panel from its own click handler. The panel claims the record
 * only if it is fresh and addressed to the tab it is showing:
 *   - Ask: the task is filled in and sent (Ask is read-only). If a run is already
 *     active in that tab it is queued behind it, exactly like pressing Send then.
 *     If the panel declines to send (plan review pending, state refresh, ...) the
 *     text stays in the composer for the user to send.
 *     If the composer already holds a different draft (the user's own, or an
 *     unconfirmed Act task) nothing is overwritten, the mode is left as it is, and
 *     nothing is sent: the task is added below the draft for the user to review
 *     and send.
 *   - Act: the task is filled in and the panel switches to Act, but nothing is
 *     sent. Act always needs the user's own Enter in the panel.
 *
 * A second hand-off is held back while an earlier Ask is still being sent (its text
 * is still sitting in the composer): filling the composer again would make that
 * send see a changed draft and drop it.
 *
 * Nothing is claimed until start() is called, after the panel has finished
 * restoring its chat: sending earlier would be overwritten by the restore. The
 * freshness window is extended by however long that startup took.
 *
 * The Chrome and Firefox copies of this file are identical — edit both together.
 */

export const NEWTAB_HANDOFF_PREFIX = 'wbNewtabHandoff:';
export const newtabHandoffKey = (tabId) => `${NEWTAB_HANDOFF_PREFIX}${tabId}`;
// A task the panel has to hand back (its tab lost focus mid-send, ...) goes to a key only the
// panel writes. Reusing the new tab's key could overwrite a newer task stored there meanwhile,
// and chrome.storage has no compare-and-set to guard that.
export const newtabHandoffRetryKey = (tabId) => `${NEWTAB_HANDOFF_PREFIX}retry:${tabId}`;
export const NEWTAB_HANDOFF_MAX_AGE_MS = 30_000;
export const NEWTAB_HANDOFF_MAX_STARTUP_ALLOWANCE_MS = 120_000;
export const NEWTAB_HANDOFF_MAX_TEXT = 4000;
export const NEWTAB_HANDOFF_SEND_RETRY_MS = 150;
// Give up holding a later hand-off back after this many retries (~30 s).
export const NEWTAB_HANDOFF_SEND_HOLD_MAX_RETRIES = 200;

/** Returns a clean record, or null when it is malformed, stale or from the future. */
export function normalizeNewtabHandoff(raw, now = Date.now(), maxAgeMs = NEWTAB_HANDOFF_MAX_AGE_MS) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text ?? '').replace(/\r\n/g, '\n').trim();
  if (!text || text.length > NEWTAB_HANDOFF_MAX_TEXT) return null;
  const mode = raw.mode === 'act' ? 'act' : raw.mode === 'ask' ? 'ask' : null;
  if (!mode) return null;
  const tabId = Number(raw.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  const createdAt = Number(raw.createdAt);
  if (!Number.isFinite(createdAt)) return null;
  if (now - createdAt > maxAgeMs || createdAt - now > 5_000) return null;
  const id = String(raw.id ?? '');
  if (!id) return null;
  return { id, tabId, text, mode, createdAt };
}

export function createNewtabHandoff({
  storage,
  onChanged,
  getCurrentTabId,
  getIsProcessing,
  getIsBlocked = () => false,
  getIsDocumentVisible = () => true,
  doc = globalThis.document,
  setMode,
  getInputEl,
  autoResizeInput,
  sendMessage,
  now = Date.now,
}) {
  const handled = new Set();
  const startedAt = now();
  let ready = false;
  let startupAllowanceMs = 0;
  let consuming = false;
  let rerun = false;
  let retryTimer = null;
  let retries = 0;
  // The Ask most recently handed to sendMessage, while its text may still be in
  // the composer waiting for the send's own checks to finish.
  let pendingSend = null;
  // Writes to the retry slot (a list, written only by this panel) run one after another, so
  // two hand-backs or a hand-back and a claim never overwrite each other.
  let retrySlotWrites = Promise.resolve();
  const serialRetryWrite = (fn) => {
    retrySlotWrites = retrySlotWrites.then(fn, fn);
    return retrySlotWrites;
  };
  const asList = (raw) => (Array.isArray(raw) ? raw : raw == null ? [] : [raw]);

  const sendStillHoldsComposer = () => {
    if (!pendingSend || pendingSend.settled) return false;
    return String(getInputEl()?.value ?? '') === pendingSend.text;
  };

  function retrySoon() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      // A send that never commits must not hold later hand-offs back forever.
      if (++retries > NEWTAB_HANDOFF_SEND_HOLD_MAX_RETRIES && pendingSend) pendingSend.settled = true;
      consume();
    }, NEWTAB_HANDOFF_SEND_RETRY_MS);
  }

  async function consume() {
    if (!ready || !getIsDocumentVisible()) return false;
    // A record can arrive while another is being claimed (the new tab unlocks as
    // soon as the first is removed). Remember it and look again when this ends.
    if (consuming) {
      rerun = true;
      return false;
    }
    const tabId = getCurrentTabId();
    if (tabId == null) return false;
    if (sendStillHoldsComposer()) {
      retrySoon();
      return false;
    }
    retries = 0;
    const primaryKey = newtabHandoffKey(Number(tabId));
    const retryKey = newtabHandoffRetryKey(Number(tabId));
    let key = primaryKey;
    let claimedOne = false;
    consuming = true;
    // Only the first attempt after start() gets the startup allowance.
    const allowance = startupAllowanceMs;
    startupAllowanceMs = 0;
    // The shared composer belongs to whichever tab is active now. If the user switches
    // tabs while storage is being read or written, this tab's task must not be applied
    // to the other tab's composer; the switch's own consume() picks up the right one.
    const sameTab = () => Number(getCurrentTabId()) === Number(tabId);
    // Hand a task back for when this tab is shown again, without touching the key the new tab
    // writes to (it unlocks as soon as a record is removed and may already hold the next task).
    const stashForLater = (record) => serialRetryWrite(async () => {
      try {
        const queue = asList((await storage.get(retryKey))?.[retryKey]);
        if (queue.some((entry) => entry?.id === record.id)) return;
        await storage.set?.({ [retryKey]: [...queue, record] });
      } catch { /* best effort */ }
    });
    // Takes the record just read out of storage: the primary key is simply removed, the retry
    // slot drops that one entry and keeps the others.
    const removeClaimed = (record) => {
      if (key !== retryKey) return storage.remove(key);
      return serialRetryWrite(async () => {
        const rest = asList((await storage.get(retryKey))?.[retryKey]).filter((entry) => entry?.id !== record?.id);
        if (rest.length) await storage.set?.({ [retryKey]: rest });
        else await storage.remove(retryKey);
      });
    };
    try {
      let stored = (await storage.get(primaryKey))?.[primaryKey];
      if (stored == null && sameTab()) {
        stored = asList((await storage.get(retryKey))?.[retryKey])[0];
        key = retryKey;
      }
      if (stored == null || !sameTab()) return false;
      const handoff = normalizeNewtabHandoff(stored, now(), NEWTAB_HANDOFF_MAX_AGE_MS + allowance);
      if (!handoff) {
        await removeClaimed(stored);
        return false;
      }
      if (handoff.tabId !== Number(tabId) || handled.has(handoff.id)) return false;

      handled.add(handoff.id);
      await removeClaimed(stored);
      if (!sameTab()) {
        // Switched during the removal: put the record back for when this tab is shown again.
        handled.delete(handoff.id);
        await stashForLater(stored);
        return false;
      }

      const input = getInputEl();
      // Never overwrite what is already in the composer. The task goes below it,
      // and the panel keeps the mode that draft was written in: switching it would
      // change what confirming the combined draft does (an Ask draft would become
      // an Act, or the reverse).
      const existing = String(input.value || '').trim();
      const keepsDraft = Boolean(existing) && existing !== handoff.text;
      if (!keepsDraft) setMode(handoff.mode);
      const composerText = keepsDraft ? `${existing}\n\n${handoff.text}` : handoff.text;
      const fill = () => {
        input.value = composerText;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        autoResizeInput();
      };
      fill();
      input.focus?.();
      if (handoff.mode === 'ask' && !getIsBlocked() && !keepsDraft) {
        // sendMessage reads the composer synchronously when called, so starting it
        // here captures this task. It is not awaited: a send can last a whole run,
        // and that must not hold up later hand-offs or the panel's own startup.
        const send = { text: handoff.text, settled: false };
        pendingSend = send;
        let sending;
        try {
          sending = Promise.resolve(sendMessage(getIsProcessing() ? { __deliveryMode: 'queue' } : undefined));
        } catch (error) {
          sending = Promise.reject(error);
        }
        sending
          .then((result) => result !== false, () => false)
          .then((sent) => {
            send.settled = true;
            // Declined or failed: the new tab already showed success and cleared its
            // box, so make sure the text is still sitting in the composer.
            if (sent) return;
            if (sameTab()) {
              const current = String(input.value || '').trim();
              if (!current) {
                fill();
              } else if (current !== handoff.text && !current.endsWith(`\n\n${handoff.text}`)) {
                // The user typed something else while the send was pending: keep their draft and
                // put the task below it (the record is gone, so this is the only copy left).
                input.value = `${current}\n\n${handoff.text}`;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                autoResizeInput();
              }
            } else {
              // The user moved to another tab while the send was being declined, and the
              // composer now belongs to that tab. Hand the task back for its own tab instead.
              stashForLater({ ...stored, id: `${handoff.id}-retry`, createdAt: now() });
            }
          });
      }
      // A task handed back earlier may be waiting behind the one just claimed (removing a
      // primary record raises no change event this panel acts on), so look again if so.
      if (key === primaryKey) {
        try {
          claimedOne = asList((await storage.get(retryKey))?.[retryKey]).length > 0;
        } catch { /* best effort */ }
      }
      return true;
    } catch {
      return false;
    } finally {
      consuming = false;
      if (rerun || claimedOne) {
        rerun = false;
        queueMicrotask(() => { consume(); });
      }
    }
  }

  /** Call once the panel has finished restoring its chat. */
  function start() {
    startupAllowanceMs = Math.min(
      Math.max(0, now() - startedAt),
      NEWTAB_HANDOFF_MAX_STARTUP_ALLOWANCE_MS,
    );
    ready = true;
    return consume();
  }

  function watch() {
    onChanged?.addListener((changes, area) => {
      if (area && area !== 'local') return;
      const tabId = getCurrentTabId();
      if (tabId == null) return;
      if (
        changes?.[newtabHandoffKey(Number(tabId))]?.newValue ||
        changes?.[newtabHandoffRetryKey(Number(tabId))]?.newValue
      ) consume();
    });
    // The record can arrive just before an already-loaded panel becomes visible
    // (the new tab writes it, then opens the panel). consume() skips hidden
    // panels, so try again the moment this one is shown.
    doc?.addEventListener?.('visibilitychange', () => {
      if (getIsDocumentVisible()) consume();
    });
  }

  return { consume, start, watch };
}
