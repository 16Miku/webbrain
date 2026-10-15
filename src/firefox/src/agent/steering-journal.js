// Corrections a run accepted from the chat panel, kept per tab in session
// storage so that a background restart (MV3 service worker or Firefox
// background reload) cannot silently drop one that was accepted but not yet
// applied. An entry leaves the journal once its correction is durable in the
// saved conversation, once the run that accepted it hands it back to the
// panel, or when the conversation or tab is discarded. Operations on one tab
// run strictly in order, so acceptance, restart recovery and a panel reclaim
// never observe each other's partial state.

export const STEERING_JOURNAL_PREFIX = 'agentSteer:';
export const STEERING_JOURNAL_MAX_ENTRIES = 100;

function normalizeEntries(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const entries = [];
  for (const entry of value) {
    const requestId = String(entry?.requestId || '');
    const id = String(entry?.id || '');
    const text = typeof entry?.text === 'string' ? entry.text : '';
    if (!requestId || !id || !text.trim() || seen.has(id)) continue;
    seen.add(id);
    entries.push({ requestId, id, text, acceptedAt: Number(entry.acceptedAt) || 0 });
  }
  return entries.slice(0, STEERING_JOURNAL_MAX_ENTRIES);
}

const copy = entries => entries.map(entry => ({ ...entry }));

export class SteeringJournal {
  constructor(storageArea) {
    // Resolved per operation: the extension storage area may be unavailable
    // in some contexts, and a missing area simply makes the journal volatile.
    this._area = typeof storageArea === 'function' ? storageArea : () => storageArea;
    this._entries = new Map();
    this._tails = new Map();
  }

  _key(tabId) {
    return `${STEERING_JOURNAL_PREFIX}${tabId}`;
  }

  // Never rejects: a failed operation resolves to `fallback`.
  _queue(tabId, operation, fallback) {
    const result = (this._tails.get(tabId) || Promise.resolve()).then(async () => {
      if (!this._entries.has(tabId)) {
        let stored = [];
        try {
          const key = this._key(tabId);
          stored = normalizeEntries((await this._area()?.get(key))?.[key]?.entries);
        } catch { /* storage unavailable: start empty */ }
        this._entries.set(tabId, stored);
      }
      return operation(this._entries.get(tabId));
    }).catch(() => fallback);
    const tail = result.then(() => {});
    this._tails.set(tabId, tail);
    tail.then(() => { if (this._tails.get(tabId) === tail) this._tails.delete(tabId); });
    return result;
  }

  // The in-memory copy changes synchronously, before any later operation on
  // this tab can run; the storage write follows.
  async _write(tabId, entries) {
    this._entries.set(tabId, entries);
    try {
      const area = this._area();
      if (!area) return false;
      if (entries.length) await area.set({ [this._key(tabId)]: { entries } });
      else await area.remove(this._key(tabId));
      return true;
    } catch {
      return false;
    }
  }

  accept(tabId, requestId, { id, text } = {}) {
    return this._queue(tabId, entries => {
      const entryId = String(id || '');
      if (!entryId || entries.some(entry => entry.id === entryId)) return true;
      if (entries.length >= STEERING_JOURNAL_MAX_ENTRIES) return false;
      return this._write(tabId, normalizeEntries([...entries, {
        requestId, id: entryId, text, acceptedAt: Date.now(),
      }]));
    }, false);
  }

  forget(tabId, ids) {
    const drop = new Set([...(ids || [])].map(String));
    if (!drop.size) return Promise.resolve(true);
    return this._queue(tabId, entries => {
      const kept = entries.filter(entry => !drop.has(entry.id));
      return kept.length === entries.length || this._write(tabId, kept);
    }, false);
  }

  list(tabId) {
    return this._queue(tabId, copy, []);
  }

  // Removes and returns every entry, but only if `canRelease()` still holds
  // when this operation runs: no live run may apply them anymore.
  release(tabId, canRelease = () => true) {
    return this._queue(tabId, async entries => {
      if (!entries.length || !canRelease()) return [];
      const released = copy(entries);
      await this._write(tabId, []);
      return released;
    }, []);
  }

  discard(tabId) {
    return this._queue(tabId, () => this._write(tabId, []), false);
  }

  // Resolves once every operation already requested for this tab finished.
  settled(tabId) {
    return Promise.resolve(this._tails.get(tabId)).then(() => {});
  }
}
