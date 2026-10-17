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
 *   - Act: the task is filled in and the panel switches to Act, but nothing is
 *     sent. Act always needs the user's own Enter in the panel.
 *
 * Nothing is claimed until start() is called, after the panel has finished
 * restoring its chat: sending earlier would be overwritten by the restore. The
 * freshness window is extended by however long that startup took.
 *
 * The Chrome and Firefox copies of this file are identical — edit both together.
 */

export const NEWTAB_HANDOFF_PREFIX = 'wbNewtabHandoff:';
export const newtabHandoffKey = (tabId) => `${NEWTAB_HANDOFF_PREFIX}${tabId}`;
export const NEWTAB_HANDOFF_MAX_AGE_MS = 30_000;
export const NEWTAB_HANDOFF_MAX_STARTUP_ALLOWANCE_MS = 120_000;
export const NEWTAB_HANDOFF_MAX_TEXT = 4000;

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
    const key = newtabHandoffKey(Number(tabId));
    consuming = true;
    // Only the first attempt after start() gets the startup allowance.
    const allowance = startupAllowanceMs;
    startupAllowanceMs = 0;
    try {
      const stored = (await storage.get(key))?.[key];
      if (stored == null) return false;
      const handoff = normalizeNewtabHandoff(stored, now(), NEWTAB_HANDOFF_MAX_AGE_MS + allowance);
      if (!handoff) {
        await storage.remove(key);
        return false;
      }
      if (handoff.tabId !== Number(tabId) || handled.has(handoff.id)) return false;

      handled.add(handoff.id);
      await storage.remove(key);

      setMode(handoff.mode);
      const input = getInputEl();
      const fill = () => {
        input.value = handoff.text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        autoResizeInput();
      };
      fill();
      input.focus?.();
      if (handoff.mode === 'ask' && !getIsBlocked()) {
        // sendMessage reads the composer synchronously when called, so starting it
        // here captures this task. It is not awaited: a send can last a whole run,
        // and that must not hold up later hand-offs or the panel's own startup.
        let sending;
        try {
          sending = Promise.resolve(sendMessage(getIsProcessing() ? { __deliveryMode: 'queue' } : undefined));
        } catch (error) {
          sending = Promise.reject(error);
        }
        sending
          .then((result) => result !== false, () => false)
          .then((sent) => {
            // Declined or failed: the new tab already showed success and cleared its
            // box, so make sure the text is still sitting in the composer.
            if (!sent && !String(input.value || '').trim()) fill();
          });
      }
      return true;
    } catch {
      return false;
    } finally {
      consuming = false;
      if (rerun) {
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
      if (tabId != null && changes?.[newtabHandoffKey(Number(tabId))]?.newValue) consume();
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
