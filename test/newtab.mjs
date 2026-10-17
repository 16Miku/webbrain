import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nt = (...p) => path.join(root, 'newtab', 'src', ...p);
const load = (file) => import(pathToFileURL(file).href);

const { createNamespacedStorage, NAMESPACE_PREFIX } = await load(nt('lib/storage-namespace.js'));
const { buildHandoff, toNavigableUrl, submitTask, handoffKey, HANDOFF_PREFIX, isHandoffPending, whenClaimed } = await load(nt('features/agent/handoff.js'));
const { getTitleFromUrl } = await load(nt('utils/links/getTitleFromUrl.js'));
const { normalizeLinkUrl } = await load(nt('utils/links/normalizeLinkUrl.js'));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    _map: map,
  };
}

test('new tab storage is namespaced and cannot touch WebBrain keys', () => {
  const real = memoryStorage({ wbLocale: 'fr', apiKey: 'secret' });
  const ls = createNamespacedStorage(real);
  ls.setItem('theme', 'dark');
  assert.equal(real.getItem(`${NAMESPACE_PREFIX}theme`), 'dark');
  assert.equal(ls.getItem('wbLocale'), null);
  assert.equal(ls.getItem('theme'), 'dark');
  ls.clear();
  assert.equal(real.getItem('wbLocale'), 'fr');
  assert.equal(real.getItem('apiKey'), 'secret');
  assert.equal(ls.length, 0);
});

test('toNavigableUrl only accepts http(s) and bare hosts', () => {
  assert.equal(toNavigableUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(toNavigableUrl('example.com'), 'https://example.com/');
  assert.equal(toNavigableUrl('localhost:3000/x'), 'https://localhost:3000/x');
  assert.equal(toNavigableUrl('javascript:alert(1)'), null);
  assert.equal(toNavigableUrl('data:text/html,hi'), null);
  assert.equal(toNavigableUrl('chrome://settings'), null);
  assert.equal(toNavigableUrl('file:///etc/passwd'), null);
  assert.equal(toNavigableUrl('how do i cook rice'), null);
  assert.equal(toNavigableUrl(''), null);
});

test('buildHandoff clamps text and defaults to ask', () => {
  const h = buildHandoff({ text: 'x'.repeat(9000), mode: 'whatever', tabId: 7, now: 1000 });
  assert.equal(h.text.length, 4000);
  assert.equal(h.mode, 'ask');
  assert.equal(h.tabId, 7);
  assert.equal(buildHandoff({ text: 'a', mode: 'act', tabId: 1 }).mode, 'act');
});

test('submitTask stores the task, opens the panel from the same tick, then announces it', async () => {
  const calls = [];
  const api = {
    storage: { local: { set: (v) => { calls.push(['set', v]); return Promise.resolve(); } } },
    sidePanel: {
      setOptions: () => { calls.push(['setOptions']); return Promise.resolve(); },
      open: (o) => { calls.push(['open', o]); return Promise.resolve(); },
    },
    runtime: { sendMessage: (m) => { calls.push(['msg', m]); return Promise.resolve(); } },
  };
  const p = submitTask({ text: 'hello', mode: 'act' }, api, { id: 42 });
  // Everything needed for the user gesture must have happened synchronously.
  assert.deepEqual(calls.map((c) => c[0]), ['set', 'setOptions', 'open']);
  assert.equal(calls[0][1][handoffKey(42)].mode, 'act');
  assert.deepEqual(calls[2][1], { tabId: 42 });
  await p;
  assert.deepEqual(calls.at(-1)[1], { type: 'WB_NEWTAB_PANEL_OPENED', tabId: 42 });
  await assert.rejects(() => submitTask({ text: 'x', mode: 'ask' }, api, null));
});

function failingApi({ open, withSidePanel = true } = {}) {
  const store = new Map();
  const listeners = [];
  const api = {
    storage: {
      local: {
        set: async (v) => { for (const [k, val] of Object.entries(v)) store.set(k, val); },
        get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {}),
        remove: async (k) => { store.delete(k); },
      },
    },
    runtime: { sendMessage: async () => {} },
    _store: store,
    _claim(tabId) {
      const key = handoffKey(tabId);
      const oldValue = store.get(key);
      store.delete(key);
      [...listeners].forEach((fn) => fn({ [key]: { oldValue } }, 'local'));
    },
  };
  api.storage.onChanged = {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
  };
  if (withSidePanel) api.sidePanel = { setOptions: async () => {}, open };
  return api;
}

test('a failed panel open removes the stored task so it cannot be sent later', async () => {
  const rejected = failingApi({ open: () => Promise.reject(new Error('no gesture')) });
  await assert.rejects(() => submitTask({ text: 'secret plan', mode: 'ask' }, rejected, { id: 1 }), /no gesture/);
  assert.equal(rejected._store.has(handoffKey(1)), false);

  const threw = failingApi({ open: () => { throw new Error('sync failure'); } });
  await assert.rejects(() => submitTask({ text: 'x', mode: 'ask' }, threw, { id: 1 }), /sync failure/);
  assert.equal(threw._store.has(handoffKey(1)), false);
});

test('an unavailable side panel API never stores the task', async () => {
  const api = failingApi({ withSidePanel: false });
  await assert.rejects(() => submitTask({ text: 'x', mode: 'ask' }, api, { id: 1 }));
  assert.equal(api._store.has(handoffKey(1)), false);
});

test('cleanup never removes a newer task written by another submit', async () => {
  const api = failingApi({
    open: async () => {
      api._store.set(handoffKey(1), { id: 'newer', tabId: 1, text: 'later', mode: 'ask', createdAt: Date.now() });
      throw new Error('late failure');
    },
  });
  await assert.rejects(() => submitTask({ text: 'first', mode: 'ask' }, api, { id: 1 }));
  assert.equal(api._store.get(handoffKey(1))?.id, 'newer');
});

test('two submits in the same tick: the second is refused before anything is written', async () => {
  const writes = [];
  const api = {
    storage: {
      local: {
        set: (v) => { writes.push(v); return new Promise(() => {}); }, // never settles: the first submit is still in flight
        get: async () => ({}),
        remove: async () => {},
      },
    },
    sidePanel: { setOptions: async () => {}, open: () => new Promise(() => {}) },
    runtime: { sendMessage: async () => {} },
  };
  const tab = { id: 88 };
  submitTask({ text: 'first', mode: 'ask' }, api, tab);
  assert.equal(isHandoffPending(88), true, 'locked synchronously');
  await assert.rejects(() => submitTask({ text: 'second', mode: 'ask' }, api, tab), /still being handed over/);
  assert.equal(writes.length, 1, 'only the first task was written');
});

test('a failed submit releases the lock so the next one can go through', async () => {
  const api = failingApi({ open: () => Promise.reject(new Error('blocked')) });
  await assert.rejects(() => submitTask({ text: 'a', mode: 'ask' }, api, { id: 91 }));
  assert.equal(isHandoffPending(91), false);
  api.sidePanel.open = async () => {};
  await submitTask({ text: 'b', mode: 'ask' }, api, { id: 91 });
  assert.equal(api._store.get(handoffKey(91)).text, 'b');
  api._claim(91);
  await whenClaimed({ id: 91 });
  assert.equal(isHandoffPending(91), false);
});

test('a second submit from the same tab waits until the first task has been claimed', async () => {
  const store = new Map();
  const listeners = [];
  const api = {
    storage: {
      local: {
        set: async (v) => { for (const [k, val] of Object.entries(v)) store.set(k, val); },
        get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {}),
        remove: async (k) => { store.delete(k); },
      },
      onChanged: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      },
    },
    sidePanel: { setOptions: async () => {}, open: async () => {} },
    runtime: { sendMessage: async () => {} },
  };
  const tab = { id: 77 };
  const claim = () => {
    const key = handoffKey(77);
    const oldValue = store.get(key);
    store.delete(key);
    [...listeners].forEach((fn) => fn({ [key]: { oldValue } }, 'local'));
  };

  await submitTask({ text: 'first', mode: 'ask' }, api, tab);
  assert.equal(isHandoffPending(77), true);
  const first = store.get(handoffKey(77));
  await assert.rejects(() => submitTask({ text: 'second', mode: 'ask' }, api, tab), /still being handed over/);
  assert.equal(store.get(handoffKey(77)).id, first.id, 'the first task was not replaced');

  claim();
  await whenClaimed(tab);
  assert.equal(isHandoffPending(77), false);
  assert.equal(listeners.length, 0, 'the storage listener is removed');

  await submitTask({ text: 'second', mode: 'ask' }, api, tab);
  assert.equal(store.get(handoffKey(77)).text, 'second');
  claim();
  await whenClaimed(tab);
});

test('quick link style option values match what the renderer checks', () => {
  const options = readFileSync(nt('features/quicklinks/options/QuickLinksOptions.jsx'), 'utf8');
  const renderer = readFileSync(nt('features/quicklinks/QuickLinks.jsx'), 'utf8');
  const offered = [...options.slice(options.indexOf('name="quickLinksStyle"')).matchAll(/value: '([a-z_]+)'/g)]
    .map((m) => m[1]).slice(0, 3);
  assert.deepEqual(offered, ['icon', 'text', 'metro']);
  for (const style of ['text', 'metro']) {
    assert.match(renderer, new RegExp(`quickLinksStyle'\\)\\s*===\\s*'${style}'`));
  }
});

test('link titles are derived locally and never fetched', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network call'); };
  try {
    assert.equal(await getTitleFromUrl('https://www.example.com/a/b?q=1'), 'example.com');
    assert.equal(await getTitleFromUrl('docs.example.org/path'), 'docs.example.org');
    assert.equal(await getTitleFromUrl('not a url at all'), 'not a url at all');
    assert.equal(await getTitleFromUrl(''), '');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('link URLs are normalised the same way for add and edit', () => {
  assert.equal(normalizeLinkUrl('example.com'), 'https://example.com');
  assert.equal(normalizeLinkUrl('  http://example.com/x '), 'http://example.com/x');
  assert.equal(normalizeLinkUrl('HTTPS://Example.com'), 'https://Example.com');
  assert.equal(normalizeLinkUrl('javascript:alert(1)'), null);
  assert.equal(normalizeLinkUrl('javascript:alert(1)//https://a.bc'), null);
  assert.equal(normalizeLinkUrl('data:text/html,hi'), null);
  assert.equal(normalizeLinkUrl('ftp://example.com'), null);
  assert.equal(normalizeLinkUrl('nodots'), null);
  assert.equal(normalizeLinkUrl(''), null);
  assert.equal(normalizeLinkUrl(undefined), null);
});

test('editing a link uses the same normalisation as adding one', () => {
  for (const file of ['features/quicklinks/options/QuickLinksOptions.jsx', 'features/navbar/options/AppsOptions.jsx']) {
    const src = readFileSync(nt(file), 'utf8');
    const start = src.indexOf('const editLink');
    const edit = src.slice(start, start + 1500);
    assert.match(src, /normalizeLinkUrl/, file);
    assert.match(edit, /normalizeLinkUrl\(url\)/, `${file}: editLink must normalise`);
  }
});

test('the only remaining fetch in the new tab source loads the chosen background image', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const hits = walk(nt()).filter((f) => /\.(jsx?|mjs)$/.test(f))
    .filter((f) => /\bfetch\(|XMLHttpRequest|sendBeacon|new WebSocket/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(nt(), f).split(path.sep).join('/'));
  assert.deepEqual(hits, ['features/background/api/blobUrl.js']);
});

for (const browser of ['chrome', 'firefox']) {
  const { normalizeNewtabHandoff, createNewtabHandoff, newtabHandoffKey, NEWTAB_HANDOFF_PREFIX } =
    await load(path.join(root, 'src', browser, 'src/ui/newtab-handoff.js'));

  test(`${browser}: handoff normalisation rejects stale, malformed or oversized records`, () => {
    const now = 1_000_000;
    const ok = { id: 'a', tabId: 3, text: ' hi ', mode: 'ask', createdAt: now - 1000 };
    assert.equal(normalizeNewtabHandoff(ok, now).text, 'hi');
    assert.equal(normalizeNewtabHandoff({ ...ok, createdAt: now - 60_000 }, now), null);
    assert.equal(normalizeNewtabHandoff({ ...ok, createdAt: now + 60_000 }, now), null);
    assert.equal(normalizeNewtabHandoff({ ...ok, mode: 'dev' }, now), null);
    assert.equal(normalizeNewtabHandoff({ ...ok, text: '   ' }, now), null);
    assert.equal(normalizeNewtabHandoff({ ...ok, text: 'x'.repeat(4001) }, now), null);
    assert.equal(normalizeNewtabHandoff({ ...ok, tabId: 'x' }, now), null);
    assert.equal(normalizeNewtabHandoff(null, now), null);
  });

  async function harness({
    tabId = 3, processing = false, blocked = false, records, record, visible = true,
    start = true, sendResult, clock,
  }) {
    const seed = records ?? (record ? { [newtabHandoffKey(record.tabId)]: record } : {});
    const store = start ? {} : { ...seed };
    const log = { mode: null, sent: [], value: '' };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const listeners = [];
    const state = { visible, tabId, time: clock ?? 100_000 };
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
      },
      getCurrentTabId: () => state.tabId,
      getIsProcessing: () => processing,
      getIsBlocked: () => blocked,
      getIsDocumentVisible: () => state.visible,
      doc: { addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.push(fn); } },
      setMode: (m) => { log.mode = m; },
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async (params) => {
        log.sent.push(params);
        log.value = input.value;
        if (sendResult === false) return false;
        input.value = '';
        return undefined;
      },
      now: () => state.time,
    });
    // A started panel with nothing waiting; the record then "arrives".
    if (start) {
      await handoff.start();
      Object.assign(store, seed);
    }
    return { handoff, store, log, input, state, listeners };
  }
  const rec = (over = {}) => ({ id: 'r1', tabId: 3, text: 'summarise', mode: 'ask', createdAt: 99_000, ...over });
  const KEY = newtabHandoffKey(3);

  test(`${browser}: Ask is sent automatically and the record is claimed once`, async () => {
    const h = await harness({ record: rec() });
    assert.equal(await h.handoff.consume(), true);
    assert.equal(h.log.mode, 'ask');
    assert.deepEqual(h.log.sent, [undefined]);
    assert.equal(h.log.value, 'summarise');
    assert.equal(KEY in h.store, false);
    assert.equal(await h.handoff.consume(), false);
    assert.equal(h.log.sent.length, 1);
  });

  test(`${browser}: Act is pre-filled but never sent`, async () => {
    const h = await harness({ record: rec({ mode: 'act', text: 'book a table' }) });
    assert.equal(await h.handoff.consume(), true);
    assert.equal(h.log.mode, 'act');
    assert.equal(h.log.sent.length, 0);
    assert.equal(h.input.value, 'book a table');
  });

  test(`${browser}: a record for another tab is left alone; a stale one is dropped`, async () => {
    const other = await harness({ record: rec({ tabId: 99 }) });
    assert.equal(await other.handoff.consume(), false);
    assert.equal(newtabHandoffKey(99) in other.store, true);
    // A record filed under this tab's key but naming another tab is refused too.
    const mismatched = await harness({ records: { [KEY]: rec({ tabId: 99 }) } });
    assert.equal(await mismatched.handoff.consume(), false);
    assert.equal(mismatched.log.sent.length, 0);
    assert.equal(other.log.sent.length, 0);

    const stale = await harness({ record: rec({ createdAt: 1 }), start: false });
    await stale.handoff.start();
    assert.equal(await stale.handoff.consume(), false);
    assert.equal(KEY in stale.store, false);
  });

  test(`${browser}: Ask during an active run is queued behind it, not dropped`, async () => {
    const h = await harness({ processing: true, record: rec() });
    assert.equal(await h.handoff.consume(), true);
    assert.deepEqual(h.log.sent, [{ __deliveryMode: 'queue' }]);
    assert.equal(h.log.value, 'summarise');
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: Ask while the conversation is being cleared is only pre-filled`, async () => {
    const h = await harness({ blocked: true, record: rec() });
    await h.handoff.consume();
    assert.equal(h.log.sent.length, 0);
    assert.equal(h.input.value, 'summarise');
  });

  test(`${browser}: a hidden panel claims the task as soon as it becomes visible`, async () => {
    const h = await harness({ visible: false, record: rec() });
    h.handoff.watch();
    assert.equal(await h.handoff.consume(), false);
    assert.equal(KEY in h.store, true);
    h.state.visible = true;
    h.listeners.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(h.log.sent.length, 1);
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: nothing is claimed before start(), and a slow startup does not make the task stale`, async () => {
    const h = await harness({ record: rec({ createdAt: 99_000 }), start: false, clock: 100_000 });
    assert.equal(await h.handoff.consume(), false);
    assert.equal(KEY in h.store, true);
    assert.equal(h.log.sent.length, 0);
    // Startup took 45 s: the record is now 46 s old, beyond the normal 30 s window.
    h.state.time = 145_000;
    assert.equal(await h.handoff.start(), true);
    assert.deepEqual(h.log.sent, [undefined]);
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: the startup allowance applies once and is capped`, async () => {
    const h = await harness({ record: rec({ createdAt: 99_000 }), start: false, clock: 100_000 });
    h.state.time = 100_000 + 10 * 60_000; // ten minutes of startup
    assert.equal(await h.handoff.start(), false); // allowance capped at 2 min, record far older
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: submissions for different tabs never overwrite each other`, async () => {
    const a = rec({ id: 'a', tabId: 3, text: 'first' });
    const b = rec({ id: 'b', tabId: 4, text: 'second' });
    const h = await harness({ records: { [newtabHandoffKey(3)]: a, [newtabHandoffKey(4)]: b } });
    await h.handoff.consume();
    assert.equal(h.log.value, 'first');
    assert.equal(newtabHandoffKey(4) in h.store, true, "tab 4's task is untouched");
    h.state.tabId = 4;
    await h.handoff.consume();
    assert.equal(h.log.value, 'second');
    assert.equal(Object.keys(h.store).length, 0);
  });

  test(`${browser}: a declined send leaves the text in the composer`, async () => {
    const h = await harness({ record: rec(), sendResult: false });
    h.input.value = '';
    assert.equal(await h.handoff.consume(), true);
    assert.equal(h.log.sent.length, 1);
    await flush();
    assert.equal(h.input.value, 'summarise');
  });

  test(`${browser}: a send that lasts a whole run does not block the next hand-off`, async () => {
    const h = await harness({ record: rec() });
    let finishRun;
    const slow = createNewtabHandoff({
      storage: {
        get: async (k) => (k in h.store ? { [k]: h.store[k] } : {}),
        remove: async (k) => { delete h.store[k]; },
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsDocumentVisible: () => true,
      doc: null,
      setMode() {},
      getInputEl: () => h.input,
      autoResizeInput() {},
      // Like the real send: commits (clears the composer) quickly, then runs for a long time.
      sendMessage: () => new Promise((resolve) => { h.input.value = ''; finishRun = resolve; }),
      now: () => 100_000,
    });
    await slow.start();
    const result = await Promise.race([slow.consume(), new Promise((r) => setTimeout(() => r('blocked'), 200))]);
    assert.equal(result, false); // record was already claimed by start(); nothing hangs
    h.store[KEY] = rec({ id: 'r2', text: 'next' });
    const second = await Promise.race([slow.consume(), new Promise((r) => setTimeout(() => r('blocked'), 200))]);
    assert.equal(second, true, 'the second task is claimed while the first run is still going');
    finishRun();
  });

  test(`${browser}: a record that arrives while another is being claimed is retried`, async () => {
    const h = await harness({ record: rec({ id: 'r1', text: 'first' }) });
    const sent = [];
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in h.store ? { [k]: h.store[k] } : {}),
        remove: async (k) => { delete h.store[k]; },
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsDocumentVisible: () => true,
      doc: null,
      setMode: () => {
        // The new tab unlocks once the first record is removed, so the next one
        // lands (and its storage event calls consume) while this claim is running.
        if (!h.store[KEY] && !sent.length) {
          h.store[KEY] = rec({ id: 'r2', text: 'second' });
          handoff.consume();
        }
      },
      getInputEl: () => h.input,
      autoResizeInput() {},
      sendMessage: async () => { sent.push(h.input.value); h.input.value = ''; },
      now: () => 100_000,
    });
    await handoff.start();
    h.store[KEY] = rec({ id: 'r1', text: 'first' });
    await handoff.consume();
    await flush();
    await flush();
    assert.deepEqual(sent, ['first', 'second']);
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: a second hand-off waits while the first Ask still holds the composer`, async () => {
    const h = await harness({ record: rec({ id: 'r1', text: 'first' }) });
    const sent = [];
    let commitFirst;
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in h.store ? { [k]: h.store[k] } : {}),
        remove: async (k) => { delete h.store[k]; },
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsDocumentVisible: () => true,
      doc: null,
      setMode() {},
      getInputEl: () => h.input,
      autoResizeInput() {},
      // The send checks the composer, so the draft stays put until it has committed.
      sendMessage: () => new Promise((resolve) => {
        sent.push(h.input.value);
        commitFirst = () => { h.input.value = ''; resolve(undefined); };
      }),
      now: () => 100_000,
    });
    await handoff.start();
    h.store[KEY] = rec({ id: 'r1', text: 'first' });
    await handoff.consume();
    assert.deepEqual(sent, ['first']);

    // The next task lands before the first send has committed.
    h.store[KEY] = rec({ id: 'r2', text: 'second' });
    assert.equal(await handoff.consume(), false);
    assert.equal(h.input.value, 'first', "the first task's text was not replaced");
    assert.equal(KEY in h.store, true, 'the second task is still waiting');

    commitFirst();
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(sent, ['first', 'second']);
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: Act never replaces what is already in the composer`, async () => {
    const h = await harness({ record: rec({ mode: 'act', text: 'book a table at 8' }) });
    h.input.value = 'book a table';
    assert.equal(await h.handoff.consume(), true);
    assert.equal(h.input.value, 'book a table\n\nbook a table at 8');
    assert.equal(h.log.sent.length, 0);
    assert.equal(h.log.mode, null, 'the draft keeps the mode it was written in');

    // The same text twice is not duplicated; an empty composer is simply filled.
    const same = await harness({ record: rec({ mode: 'act', text: 'x' }) });
    same.input.value = 'x';
    await same.handoff.consume();
    assert.equal(same.input.value, 'x');
    const empty = await harness({ record: rec({ mode: 'act', text: 'y' }) });
    await empty.handoff.consume();
    assert.equal(empty.input.value, 'y');
  });

  test(`${browser}: Ask never overwrites an existing draft and is not sent over it`, async () => {
    const h = await harness({ record: rec({ text: 'summarise this' }) });
    h.input.value = 'my half-written email to Sam';
    assert.equal(await h.handoff.consume(), true);
    assert.equal(h.input.value, 'my half-written email to Sam\n\nsummarise this');
    assert.equal(h.log.sent.length, 0, 'the combined text is left for the user to review and send');
    assert.equal(h.log.mode, null, 'an Act draft is not turned into an Ask (or the reverse)');
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: manifest and background are wired`, () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'src', browser, 'manifest.json'), 'utf8'));
    assert.equal(manifest.chrome_url_overrides?.newtab, 'newtab/index.html');
    assert.ok(manifest.permissions.includes('search'));
    assert.ok(existsSync(path.join(root, 'src', browser, 'newtab/index.html')), 'run npm run build:newtab');
    const bg = readFileSync(path.join(root, 'src', browser, 'src/background.js'), 'utf8');
    assert.match(bg, /WB_NEWTAB_PANEL_OPENED/);
    // Unclaimed records are cleaned up without waiting for another submission.
    assert.match(bg, /tabs\.onRemoved\.addListener\(\(closedTabId\)[^]*?wbNewtabHandoff:\$\{closedTabId\}/);
    assert.match(bg, /\nsweepStaleNewtabHandoffs\(\);/);
  });
}

test('new tab and side panel agree on the hand-off key', async () => {
  const { NEWTAB_HANDOFF_PREFIX: panelPrefix, newtabHandoffKey } =
    await load(path.join(root, 'src/chrome/src/ui/newtab-handoff.js'));
  assert.equal(HANDOFF_PREFIX, panelPrefix);
  assert.equal(handoffKey(12), newtabHandoffKey(12));
  for (const b of ['chrome', 'firefox']) {
    const bg = readFileSync(path.join(root, 'src', b, 'src/background.js'), 'utf8');
    assert.ok(bg.includes(`'${panelPrefix}'`), `${b} background sweeps ${panelPrefix}*`);
  }
});

test('both extensions ship an identical handoff module', () => {
  const a = readFileSync(path.join(root, 'src/chrome/src/ui/newtab-handoff.js'), 'utf8');
  const b = readFileSync(path.join(root, 'src/firefox/src/ui/newtab-handoff.js'), 'utf8');
  assert.equal(a, b);
});

test('built new tab is identical in both extensions and calls no external host', () => {
  const dirs = ['chrome', 'firefox'].map((b) => path.join(root, 'src', b, 'newtab'));
  const html = dirs.map((d) => readFileSync(path.join(d, 'index.html'), 'utf8'));
  assert.equal(html[0], html[1]);
  assert.doesNotMatch(html[0], /https?:\/\//);
  assert.doesNotMatch(html[0], /<script(?![^>]*src=)[^>]*>[^<]/, 'no inline script (MV3 CSP)');
});

test('every WebBrain locale has every new tab string', async (t) => {
  let esbuild;
  try {
    esbuild = await import(pathToFileURL(path.join(root, 'newtab/node_modules/esbuild/lib/main.js')).href);
  } catch {
    return t.skip('newtab dependencies are not installed');
  }
  const out = await esbuild.build({
    entryPoints: [nt('lib/wb-strings.js')],
    bundle: true,
    write: false,
    format: 'esm',
    nodePaths: [nt()],
    platform: 'node',
  });
  const code = `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`;
  const { WB_STRINGS } = await import(code);
  const expected = 'en zh ar bn nl tl fr de he hi id ja ko ms fa pl pt ru es th tr uk vi'.split(' ');
  assert.deepEqual(Object.keys(WB_STRINGS).sort(), [...expected].sort());
  const keys = Object.keys(WB_STRINGS.en);
  assert.equal(keys.length, 18);
  for (const lang of expected) {
    for (const k of keys) {
      assert.ok(String(WB_STRINGS[lang][k] ?? '').trim(), `${lang} is missing ${k}`);
    }
  }
});

test('first run on an empty store writes the defaults instead of throwing', async (t) => {
  let esbuild;
  try {
    esbuild = await import(pathToFileURL(path.join(root, 'newtab/node_modules/esbuild/lib/main.js')).href);
  } catch {
    return t.skip('newtab dependencies are not installed');
  }
  const out = await esbuild.build({
    stdin: {
      contents: "import variables from 'config/variables'; export { moveSettings } from 'utils/settings/move'; export { variables };",
      resolveDir: nt(),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    nodePaths: [nt()],
    platform: 'node',
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  mod.variables.getMessage = () => 'New Tab';

  const real = globalThis.localStorage;
  const store = memoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new Proxy(store, {
    ownKeys: () => [...store._map.keys()],
    getOwnPropertyDescriptor: (_t, k) => (store._map.has(k) ? { value: store._map.get(k), enumerable: true, configurable: true } : undefined),
  }) });
  try {
    assert.doesNotThrow(() => mod.moveSettings());
    assert.equal(store.getItem('firstRun'), 'true');
    assert.equal(store.getItem('taskBox'), 'true');

    // A store that already has values keeps them over the defaults.
    store.clear();
    store.setItem('taskBoxMode', 'act');
    mod.moveSettings();
    assert.equal(store.getItem('taskBoxMode'), 'act');
    assert.equal(store.getItem('firstRun'), 'true');
  } finally {
    if (real === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: real });
  }
});

test('recent chats open the clicked conversation by id', () => {
  const recent = readFileSync(nt('features/agent/RecentChats.jsx'), 'utf8');
  assert.match(recent, /\?id=\$\{encodeURIComponent\(chat\.id\)\}/);
  for (const b of ['chrome', 'firefox']) {
    const history = readFileSync(path.join(root, 'src', b, 'src/ui/history.js'), 'utf8');
    assert.match(history, /get\('id'\)/, `${b} history reads ?id=`);
    assert.match(history, /renderRecord\(initialRecordId\)/, `${b} history opens it`);
  }
});

test('EventBus.off removes the listener that was really registered', async () => {
  const doc = new EventTarget();
  const hadDocument = 'document' in globalThis;
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    const { default: EventBus } = await load(nt('utils/eventbus.js'));
    const calls = [];
    const handler = (detail) => calls.push(detail);

    EventBus.on('refresh', handler);
    EventBus.emit('refresh', 'a');
    EventBus.off('refresh', handler);
    EventBus.emit('refresh', 'b');
    assert.deepEqual(calls, ['a'], 'off() stops further calls (cleanup in React effects works)');
    assert.equal(EventBus.getListeners('refresh').length, 0);

    // Re-subscribing on every render must not pile handlers up.
    for (let i = 0; i < 5; i += 1) {
      EventBus.on('refresh', handler);
      EventBus.off('refresh', handler);
    }
    calls.length = 0;
    EventBus.emit('refresh', 'c');
    assert.deepEqual(calls, []);

    EventBus.once('ping', handler);
    EventBus.emit('ping', 1);
    EventBus.emit('ping', 2);
    assert.deepEqual(calls, [1]);

    calls.length = 0;
    EventBus.prepend('cap', handler);
    EventBus.emit('cap', 'x');
    EventBus.off('cap', handler);
    EventBus.emit('cap', 'y');
    assert.deepEqual(calls, ['x'], 'capture-phase listeners are removed too');
  } finally {
    if (hadDocument) globalThis.document = previous;
    else delete globalThis.document;
  }
});

test('picking a colour refreshes the visible background even though the type is unchanged', () => {
  const hook = readFileSync(nt('features/background/hooks/useBackgroundEvents.js'), 'utf8');
  assert.match(hook, /type === 'colour'/);
});

test('the producer lock and the background sweep outlast the panel\'s accepted record age', async () => {
  const { NEWTAB_HANDOFF_MAX_AGE_MS, NEWTAB_HANDOFF_MAX_STARTUP_ALLOWANCE_MS } =
    await load(path.join(root, 'src/chrome/src/ui/newtab-handoff.js'));
  const longest = NEWTAB_HANDOFF_MAX_AGE_MS + NEWTAB_HANDOFF_MAX_STARTUP_ALLOWANCE_MS;
  const number = (text, re) => Number(re.exec(text)[1].replace(/_/g, ''));

  const lock = number(readFileSync(nt('features/agent/handoff.js'), 'utf8'), /CLAIM_TIMEOUT_MS = ([\d_]+)/);
  assert.ok(lock > longest, `producer lock ${lock} must exceed ${longest}`);
  for (const b of ['chrome', 'firefox']) {
    const bg = readFileSync(path.join(root, 'src', b, 'src/background.js'), 'utf8');
    const cutoff = number(bg, /const cutoff = Date\.now\(\) - ([\d_]+);/);
    assert.ok(cutoff > longest, `${b} sweep cutoff ${cutoff} must exceed ${longest}`);
  }
});

test('the recent-chats switch refreshes the widgets', () => {
  const src = readFileSync(nt('features/agent/TaskBoxOptions.jsx'), 'utf8');
  assert.match(src, /<Switch name="recentChats" category="widgets"/);
  assert.doesNotMatch(src, /element=/, 'a missing .other element made the switch bail out');
});

test('components unsubscribe the handler they registered', () => {
  for (const file of [
    'features/greeting/Greeting.jsx', 'features/navbar/components/Notes.jsx', 'features/navbar/Navbar.jsx',
    'features/misc/views/Widgets.jsx', 'features/message/Message.jsx', 'features/time/Clock.jsx', 'features/time/Date.jsx',
  ]) {
    assert.doesNotMatch(readFileSync(nt(file), 'utf8'), /EventBus\.off\('refresh'\)/, file);
  }
});

test('the task box can be hidden from settings', () => {
  const src = readFileSync(nt('features/agent/TaskBoxOptions.jsx'), 'utf8');
  assert.match(src, /setting="taskBox"[^>]*visibilityToggle=\{true\}/);
});

test('deleting a custom background does not also select a card', () => {
  const src = readFileSync(nt('features/background/options/Custom.jsx'), 'utf8');
  assert.match(src, /closest\('\.delete-button'\)/);
  assert.match(src, /e\.stopPropagation\(\);\s*modifyCustomBackground\('remove', originalIndex\)/);
});

test('reset also deletes the uploaded backgrounds', () => {
  const src = readFileSync(nt('components/Elements/ResetModal/ResetModal.jsx'), 'utf8');
  assert.match(src, /import \{ clearAllBackgrounds \} from 'utils\/customBackgroundDB'/);
  assert.ok(src.indexOf('await clearAllBackgrounds()') < src.indexOf("setDefaultSettings('reset')"));
});

test('the gallery has no arrows that emit a URL the event bus drops', () => {
  const src = readFileSync(nt('features/background/options/Custom.jsx'), 'utf8');
  assert.doesNotMatch(src, /image-nav-buttons|nav-prev|nav-next/);
  assert.doesNotMatch(src, /EventBus\.emit\('refresh', 'background', [^)]*\.url\)/);
});

test('the unreachable custom-URL background flow is gone', () => {
  const src = readFileSync(nt('features/background/options/Custom.jsx'), 'utf8');
  assert.doesNotMatch(src, /addCustomURL|CustomURLModal|setCustomURLModal/);
  assert.equal(existsSync(nt('features/background/options/CustomURLModal.jsx')), false);
});

test('a superseded background load is cancelled instead of painting over the newer one', () => {
  const src = readFileSync(nt('features/background/hooks/useBackgroundRenderer.js'), 'utf8');
  assert.match(src, /let cancelled = false/);
  assert.match(src, /cancelled = true;\s*clearTimeout\(swapTimer\)/);
  assert.equal((src.match(/if \(cancelled\)/g) || []).length >= 2, true);
  assert.doesNotMatch(src, /abortControllerRef/);
});

test('the background settings header has a Hide/Show toggle', () => {
  const src = readFileSync(nt('features/background/options/BackgroundOptions.jsx'), 'utf8');
  assert.match(src, /setting="background"[\s\S]{0,120}visibilityToggle=\{true\}/);
});

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName}: Act can bootstrap navigation away from WebBrain's own new tab page`, async () => {
    const { BotMemorySession } = await import(
      pathToFileURL(path.join(root, 'src', browserName, 'src/agent/bot-memory.js')).href
    );
    const base = browserName === 'chrome' ? 'chrome-extension://abc123/' : 'moz-extension://uuid-1/';
    const api = { runtime: { getURL: (p) => base + p } };
    const prev = { chrome: globalThis.chrome, browser: globalThis.browser };
    globalThis.chrome = api;
    globalThis.browser = api;
    try {
      const check = (url) => {
        const s = Object.create(BotMemorySession.prototype);
        s.getTab = async () => ({ url });
        return s.canBootstrapNavigation(1, 'navigate', { url: 'https://example.com/' });
      };
      assert.equal(await check(`${base}newtab/index.html`), true);
      assert.equal(await check(`${base}newtab/index.html?x=1#y`), true);
      assert.equal(await check(`${base}src/ui/history.html`), false); // other extension pages: no
      assert.equal(await check('chrome-extension://evil/newtab/index.html'), browserName === 'chrome' ? false : false);
      assert.equal(await check('https://example.com/newtab/index.html'), false);
    } finally {
      globalThis.chrome = prev.chrome;
      globalThis.browser = prev.browser;
      if (prev.chrome === undefined) delete globalThis.chrome;
      if (prev.browser === undefined) delete globalThis.browser;
    }
  });
}

test('chrome agent treats the extension new tab page as a browser new tab', () => {
  const src = readFileSync(path.join(root, 'src/chrome/src/agent/agent.js'), 'utf8');
  const fn = src.slice(src.indexOf('function isBrowserNewTabUrl'), src.indexOf('function isBrowserNewTabUrl') + 700);
  assert.match(fn, /runtime\.getURL\('newtab\/index\.html'\)/);
});

test('a background refresh requested mid-load is not dropped (latest request wins)', () => {
  const src = readFileSync(nt('features/background/hooks/useBackgroundLoader.js'), 'utf8');
  assert.doesNotMatch(src, /isLoadingRef/);
  assert.match(src, /requestRef\.current/);
  assert.match(src, /await getBackgroundData\(\);\s*if \(isStale\(\)\) return;/);
});

test('PreferencesWrapper subscribes to toggle in an effect and unsubscribes', () => {
  const src = readFileSync(nt('components/Layout/Settings/PreferencesWrapper/PreferencesWrapper.jsx'), 'utf8');
  assert.match(src, /useEffect\(/);
  assert.match(src, /EventBus\.off\('toggle', handleToggle\)/);
  // the only subscription lives inside the effect body
  assert.equal((src.match(/EventBus\.on\('toggle'/g) || []).length, 1);
  assert.ok(src.indexOf("EventBus.on('toggle'") > src.indexOf('useEffect('));
});

test('enabling quick links refreshes the widget tree so the widget mounts', () => {
  const src = readFileSync(nt('features/quicklinks/options/QuickLinksOptions.jsx'), 'utf8');
  assert.match(src, /setting="quicklinksenabled"\s*category="widgets"/);
  assert.doesNotMatch(src, /element="\.quicklinks-container"/);
});
