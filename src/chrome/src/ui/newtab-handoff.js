/**
 * Receives a task typed into the WebBrain new tab (newtab/src/features/agent).
 *
 * The new tab stores { id, tabId, text, mode, createdAt } under one storage
 * key and opens this panel from its own click handler. The panel claims the
 * record only if it is fresh and addressed to the tab it is showing:
 *   - Ask: the task is filled in and sent (Ask is read-only);
 *   - Act: the task is filled in and the panel switches to Act, but nothing is
 *     sent. Act always needs the user's own Enter in the panel.
 *
 * The Chrome and Firefox copies of this file are identical — edit both together.
 */

export const NEWTAB_HANDOFF_KEY = 'wbNewtabHandoff';
export const NEWTAB_HANDOFF_MAX_AGE_MS = 30_000;
export const NEWTAB_HANDOFF_MAX_TEXT = 4000;

/** Returns a clean record, or null when it is malformed, stale or from the future. */
export function normalizeNewtabHandoff(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text ?? '').replace(/\r\n/g, '\n').trim();
  if (!text || text.length > NEWTAB_HANDOFF_MAX_TEXT) return null;
  const mode = raw.mode === 'act' ? 'act' : raw.mode === 'ask' ? 'ask' : null;
  if (!mode) return null;
  const tabId = Number(raw.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  const createdAt = Number(raw.createdAt);
  if (!Number.isFinite(createdAt)) return null;
  if (now - createdAt > NEWTAB_HANDOFF_MAX_AGE_MS || createdAt - now > 5_000) return null;
  const id = String(raw.id ?? '');
  if (!id) return null;
  return { id, tabId, text, mode, createdAt };
}

export function createNewtabHandoff({
  storage,
  onChanged,
  getCurrentTabId,
  getIsProcessing,
  getIsDocumentVisible = () => true,
  setMode,
  getInputEl,
  autoResizeInput,
  sendMessage,
  now = Date.now,
}) {
  const handled = new Set();
  let consuming = false;

  async function consume() {
    if (consuming || !getIsDocumentVisible()) return false;
    const tabId = getCurrentTabId();
    if (tabId == null) return false;
    consuming = true;
    try {
      const stored = (await storage.get(NEWTAB_HANDOFF_KEY))?.[NEWTAB_HANDOFF_KEY];
      if (stored == null) return false;
      const handoff = normalizeNewtabHandoff(stored, now());
      if (!handoff) {
        await storage.remove(NEWTAB_HANDOFF_KEY);
        return false;
      }
      // Addressed to another tab's panel: leave it for that panel.
      if (handoff.tabId !== Number(tabId) || handled.has(handoff.id)) return false;

      handled.add(handoff.id);
      await storage.remove(NEWTAB_HANDOFF_KEY);

      setMode(handoff.mode);
      const input = getInputEl();
      input.value = handoff.text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      autoResizeInput();
      input.focus?.();
      if (handoff.mode === 'ask' && !getIsProcessing()) await sendMessage();
      return true;
    } catch {
      return false;
    } finally {
      consuming = false;
    }
  }

  function watch() {
    onChanged?.addListener((changes, area) => {
      if (area && area !== 'local') return;
      if (changes?.[NEWTAB_HANDOFF_KEY]?.newValue) consume();
    });
  }

  return { consume, watch };
}
