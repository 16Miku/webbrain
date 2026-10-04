// Runs in MAIN at document_start: render callbacks are often closures, with
// no data-callback attribute or global name to discover after a paid solve.
// This bridge only remembers page registrations. It never buys a solve or
// treats a callback invocation as proof that the site accepted an answer.
(() => {
  const bridgeName = '__webbrainCaptchaCallbacks';
  if (window[bridgeName]) return;
  const registrations = new Set();
  const watched = new WeakMap();
  const apis = new WeakMap();
  const resolveCallback = value => typeof value === 'function' ? value
    : typeof value === 'string' ? value.split('.').reduce((object, key) => object?.[key], window) : null;
  const containerElement = value => typeof value === 'string'
    ? document.getElementById(value) || (() => { try { return document.querySelector(value); } catch { return null; } })()
    : value;
  const live = record => record.container?.isConnected === true
    && record.records.get(record.id) === record;

  // Preserve native calls, receivers and return values. Setters also catch SDKs
  // which first publish a ready() stub and install render() later in the load.
  function watch(object, key, transform) {
    if (!object || !['object', 'function'].includes(typeof object)) return;
    let keys = watched.get(object);
    if (!keys) watched.set(object, keys = new Set());
    if (keys.has(key)) return;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set || descriptor.writable === false)) return;
    keys.add(key);
    const prepare = next => { try { return transform(next); } catch { return next; } };
    let value = prepare(descriptor?.value);
    Object.defineProperty(object, key, {
      configurable: true, enumerable: descriptor?.enumerable ?? true,
      get: () => value,
      set: next => { value = prepare(next); },
    });
  }

  function instrument(api, family) {
    if (!api || !['object', 'function'].includes(typeof api)) return api;
    if (apis.has(api)) {
      // hCaptcha can publish the same API as grecaptcha for compatibility.
      if (family === 'hcaptcha') apis.get(api).family = family;
      return api;
    }
    const records = new Map();
    const state = { records, family };
    apis.set(api, state);
    const find = id => id == null ? records.values().next().value
      : records.get(String(id)) || [...records.values()].find(record => record.container === containerElement(id));
    const clear = record => {
      if (!record) return;
      record.token = null;
      record.tokenAt = 0;
      record.respKey = null;
      record.delivered = false;
      record.generation += 1;
      record.pending.clear();
    };
    const wrap = (key, factory) => watch(api, key, original =>
      typeof original === 'function' ? factory(original) : original);

    wrap('render', original => function (container, params, ...rest) {
      const element = containerElement(container);
      // Capture before render: SDKs are allowed to mutate the options object.
      const callback = params?.callback ?? element?.getAttribute?.('data-callback');
      const sitekey = String(params?.sitekey || element?.getAttribute?.('data-sitekey') || '');
      let record;
      const options = params && typeof params === 'object' ? { ...params } : params;
      for (const event of ['expired-callback', 'chalexpired-callback', 'error-callback']) {
        if (!options || !options[event]) continue;
        const handler = options[event];
        options[event] = function (...args) {
          clear(record);
          const fn = resolveCallback(handler);
          if (typeof fn === 'function') return Reflect.apply(fn, this, args);
        };
      }
      const args = [...arguments];
      if (args.length > 1) args[1] = options;
      const id = Reflect.apply(original, this, args);
      if (id == null || !element || !sitekey) return id;
      for (const previous of registrations) if (previous.container === element || (previous.records === records && previous.id === String(id))) {
        registrations.delete(previous);
        previous.records.delete(previous.id);
      }
      record = { family: state.family, records, id: String(id), container: element, sitekey, callback,
        generation: 0, delivered: false, token: null, respKey: null, pending: new Set() };
      records.set(record.id, record);
      registrations.add(record);
      // Bound memory to widgets still owned by the document.
      for (const old of registrations) if (!live(old)) {
        registrations.delete(old);
        old.records.delete(old.id);
      }
      return id;
    });
    for (const method of ['reset', 'remove']) wrap(method, original => function (id, ...rest) {
      const record = find(id);
      const result = Reflect.apply(original, this, arguments);
      clear(record);
      if (method === 'remove' && record) {
        registrations.delete(record);
        records.delete(record.id);
      }
      return result;
    });
    wrap('getResponse', original => function (id, ...rest) {
      const record = find(id);
      if (record && live(record) && record.token && Date.now() - record.tokenAt <= 180_000) return record.token;
      return Reflect.apply(original, this, arguments);
    });
    {
      wrap('getRespKey', original => function (id, ...rest) {
        const record = find(id);
        if (record && live(record) && record.token && record.respKey && Date.now() - record.tokenAt <= 180_000) return record.respKey;
        return Reflect.apply(original, this, arguments);
      });
      wrap('execute', original => function (id, options, ...rest) {
        const record = find(id);
        const result = Reflect.apply(original, this, arguments);
        if (state.family !== 'hcaptcha' || !record || options?.async !== true || typeof result?.then !== 'function') return result;
        // Invisible integrations may await execute() instead of registering a
        // callback. Resolve that original page continuation with the same answer.
        return new Promise((resolve, reject) => {
          const pending = { resolve, generation: record.generation };
          record.pending.add(pending);
          Promise.resolve(result).then(resolve, reject).finally(() => record.pending.delete(pending));
        });
      });
    }
    return api;
  }

  Object.defineProperty(window, bridgeName, { configurable: true, value: {
    callbacks(type, sitekey, fieldName, fieldId, fieldIndex) {
      const family = String(type).startsWith('recaptcha') ? 'recaptcha' : type;
      const fields = [...document.querySelectorAll(`textarea[name="${fieldName}"], input[name="${fieldName}"]`)];
      const field = fieldId ? fields.find(element => element.id === fieldId)
        : Number.isInteger(fieldIndex) ? fields[fieldIndex] : fields.length === 1 ? fields[0] : null;
      return [...registrations].filter(record => {
        if (!live(record) || record.family !== family || record.sitekey !== sitekey) return false;
        if (typeof resolveCallback(record.callback) !== 'function' && !record.pending.size) return false;
        // Site keys are shared across widgets. Never use one alone when the
        // solver selected a particular response field.
        if (field && !record.container.contains(field)) return false;
        if ((fieldId || Number.isInteger(fieldIndex)) && !field) return false;
        return true;
      }).map(record => {
        const generation = record.generation;
        return {
          source: `${record.family}.render`,
          fn: (token, respKey) => {
            if (!live(record) || record.generation !== generation || record.delivered) {
              throw new Error('The registered CAPTCHA widget changed or its callback was already delivered.');
            }
            const callback = resolveCallback(record.callback);
            const pending = [...record.pending].filter(item => item.generation === generation);
            if (typeof callback !== 'function' && !pending.length) {
              throw new Error('The registered CAPTCHA widget has no completion callback or pending execute promise.');
            }
            record.delivered = true;
            record.token = token;
            record.tokenAt = Date.now();
            record.respKey = respKey || null;
            for (const item of pending) { item.resolve({ response: token, key: respKey || '' }); record.pending.delete(item); }
            if (typeof callback === 'function') Reflect.apply(callback, window, [token]);
          },
        };
      });
    },
  } });
  try { watch(window, 'hcaptcha', api => instrument(api, 'hcaptcha')); } catch {}
  try { watch(window, 'turnstile', api => instrument(api, 'turnstile')); } catch {}
  try { watch(window, 'grecaptcha', api => {
    instrument(api, 'recaptcha');
    watch(api, 'enterprise', enterprise => instrument(enterprise, 'recaptcha'));
    return api;
  }); } catch {}
})();
