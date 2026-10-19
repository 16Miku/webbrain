// The mode the composer's "!" menu keeps for a tab's conversation: Ask, Act
// or Dev, or none, which is Automatic (each message is routed on its own).
// Each tab's choice is its own session-storage key, so the per-tab side panel
// documents never overwrite each other and a reopened panel finds it again.
// A new chat or a recovered history record clears it; a browser restart
// drops it with the rest of session storage.

export const COMPOSER_MODE_PIN_PREFIX = 'composerModePin:';
export const COMPOSER_PINNED_MODES = Object.freeze(['ask', 'act', 'dev']);

export function normalizeComposerModePin(mode) {
  return COMPOSER_PINNED_MODES.includes(mode) ? mode : null;
}

export function createComposerModePins(storageArea) {
  const area = typeof storageArea === 'function' ? storageArea : () => storageArea;
  const pins = new Map();
  // Tabs whose choice this document made: storage can no longer override it.
  const decided = new Set();
  // Tabs already read from storage, and reads still going (shared).
  const loaded = new Set();
  const loading = new Map();
  const key = tabId => `${COMPOSER_MODE_PIN_PREFIX}${tabId}`;
  return {
    get(tabId) {
      return tabId == null ? null : pins.get(String(tabId)) || null;
    },
    // Records the choice at once; storage follows best-effort.
    set(tabId, mode) {
      if (tabId == null) return Promise.resolve(false);
      const id = String(tabId);
      const pin = normalizeComposerModePin(mode);
      decided.add(id);
      // Clearing always reaches storage: another panel document may have stored one.
      if (pin && pins.get(id) === pin) return Promise.resolve(false);
      if (pin) pins.set(id, pin);
      else pins.delete(id);
      return Promise.resolve()
        .then(() => (pin ? area()?.set?.({ [key(id)]: pin }) : area()?.remove?.(key(id))))
        .then(() => true, () => true);
    },
    clear(tabId) {
      return this.set(tabId, null);
    },
    // A choice made in this document wins over a stored one. Each tab is read
    // once; later calls return at once (a send waits on this).
    async load(tabId) {
      if (tabId == null) return null;
      const id = String(tabId);
      if (decided.has(id) || loaded.has(id)) return pins.get(id) || null;
      if (!loading.has(id)) {
        loading.set(id, (async () => {
          try {
            const stored = await area()?.get?.(key(id));
            const pin = normalizeComposerModePin(stored?.[key(id)]);
            if (pin && !decided.has(id)) pins.set(id, pin);
          } catch {}
          loaded.add(id);
          loading.delete(id);
        })());
      }
      await loading.get(id);
      return pins.get(id) || null;
    },
  };
}
