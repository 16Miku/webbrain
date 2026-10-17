/**
 * Give the new tab its own slice of localStorage.
 *
 * The new tab is an extension page, so it shares an origin (and therefore
 * localStorage) with the side panel, settings, history and install pages.
 * Upstream Mue assumes it owns the whole store: first run, "reset settings",
 * and a few other paths call localStorage.clear(), which would delete
 * WebBrain's own keys (wbLocale, UI scale, ...). Every key the new tab touches
 * is therefore stored as "wbnt:<key>", and clear()/key()/length/enumeration
 * only see that prefix.
 *
 * Import this first, before any module that reads localStorage.
 */
export const NAMESPACE_PREFIX = 'wbnt:';

export function createNamespacedStorage(real, prefix = NAMESPACE_PREFIX) {
  const ownKeys = () => {
    const keys = [];
    for (let i = 0; i < real.length; i += 1) {
      const key = real.key(i);
      if (key != null && key.startsWith(prefix)) keys.push(key.slice(prefix.length));
    }
    return keys;
  };

  const methods = {
    getItem: (key) => real.getItem(prefix + String(key)),
    setItem: (key, value) => real.setItem(prefix + String(key), String(value)),
    removeItem: (key) => real.removeItem(prefix + String(key)),
    clear: () => ownKeys().forEach((key) => real.removeItem(prefix + key)),
    key: (index) => ownKeys()[index] ?? null,
  };

  return new Proxy(Object.create(null), {
    get(_target, prop) {
      if (prop === 'length') return ownKeys().length;
      if (Object.prototype.hasOwnProperty.call(methods, prop)) return methods[prop];
      if (typeof prop !== 'string') return undefined;
      const value = real.getItem(prefix + prop);
      return value === null ? undefined : value;
    },
    set(_target, prop, value) {
      if (typeof prop !== 'string') return false;
      real.setItem(prefix + prop, String(value));
      return true;
    },
    deleteProperty(_target, prop) {
      if (typeof prop === 'string') real.removeItem(prefix + prop);
      return true;
    },
    has(_target, prop) {
      return Object.prototype.hasOwnProperty.call(methods, prop)
        || prop === 'length'
        || (typeof prop === 'string' && real.getItem(prefix + prop) !== null);
    },
    ownKeys: () => ownKeys(),
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      const value = real.getItem(prefix + prop);
      return value === null
        ? undefined
        : { value, enumerable: true, configurable: true, writable: true };
    },
  });
}

export function installNamespacedLocalStorage(win = globalThis) {
  const real = win.localStorage;
  const shim = createNamespacedStorage(real);
  Object.defineProperty(win, 'localStorage', { configurable: true, get: () => shim });
  return { real, shim };
}

// In-memory stand-in used when localStorage is unavailable (blocked site data,
// some private windows). Settings then last for the page only, but the page
// still renders instead of crashing on the first read.
function createMemoryStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(String(k)); },
    clear: () => map.clear(),
  };
}

// The un-namespaced store, for the few WebBrain keys the new tab may read.
let rawStorage = null;
try {
  // Getting the Storage object is not proof it works: blocked or full storage can hand one
  // out whose methods throw. Probe a write and a read before relying on it.
  const probeKey = `${NAMESPACE_PREFIX}__probe`;
  window.localStorage.setItem(probeKey, '1');
  const readBack = window.localStorage.getItem(probeKey);
  window.localStorage.removeItem(probeKey);
  if (readBack !== '1') throw new Error('localStorage did not keep a value');
  rawStorage = installNamespacedLocalStorage(window).real;
} catch {
  try {
    const memory = createMemoryStorage();
    const shim = createNamespacedStorage(memory);
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => shim });
  } catch {
    // nothing more we can do; the page falls back to its defaults
  }
  rawStorage = null;
}
export { rawStorage };
