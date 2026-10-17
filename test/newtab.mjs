import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nt = (...p) => path.join(root, 'newtab', 'src', ...p);
const load = (file) => import(pathToFileURL(file).href);

const { createNamespacedStorage, NAMESPACE_PREFIX } = await load(nt('lib/storage-namespace.js'));
const { buildHandoff, toNavigableUrl, submitTask, HANDOFF_KEY } = await load(nt('features/agent/handoff.js'));
const { getTitleFromUrl } = await load(nt('utils/links/getTitleFromUrl.js'));
const { normalizeLinkUrl } = await load(nt('utils/links/normalizeLinkUrl.js'));

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
  assert.equal(calls[0][1][HANDOFF_KEY].mode, 'act');
  assert.deepEqual(calls[2][1], { tabId: 42 });
  await p;
  assert.deepEqual(calls.at(-1)[1], { type: 'WB_NEWTAB_PANEL_OPENED', tabId: 42 });
  await assert.rejects(() => submitTask({ text: 'x', mode: 'ask' }, api, null));
});

function failingApi({ open, withSidePanel = true } = {}) {
  const store = new Map();
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
  };
  if (withSidePanel) api.sidePanel = { setOptions: async () => {}, open };
  return api;
}

test('a failed panel open removes the stored task so it cannot be sent later', async () => {
  const rejected = failingApi({ open: () => Promise.reject(new Error('no gesture')) });
  await assert.rejects(() => submitTask({ text: 'secret plan', mode: 'ask' }, rejected, { id: 1 }), /no gesture/);
  assert.equal(rejected._store.has(HANDOFF_KEY), false);

  const threw = failingApi({ open: () => { throw new Error('sync failure'); } });
  await assert.rejects(() => submitTask({ text: 'x', mode: 'ask' }, threw, { id: 1 }), /sync failure/);
  assert.equal(threw._store.has(HANDOFF_KEY), false);
});

test('an unavailable side panel API never stores the task', async () => {
  const api = failingApi({ withSidePanel: false });
  await assert.rejects(() => submitTask({ text: 'x', mode: 'ask' }, api, { id: 1 }));
  assert.equal(api._store.has(HANDOFF_KEY), false);
});

test('cleanup never removes a newer task written by another submit', async () => {
  const api = failingApi({
    open: async () => {
      api._store.set(HANDOFF_KEY, { id: 'newer', tabId: 1, text: 'later', mode: 'ask', createdAt: Date.now() });
      throw new Error('late failure');
    },
  });
  await assert.rejects(() => submitTask({ text: 'first', mode: 'ask' }, api, { id: 1 }));
  assert.equal(api._store.get(HANDOFF_KEY)?.id, 'newer');
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
  const { normalizeNewtabHandoff, createNewtabHandoff, NEWTAB_HANDOFF_KEY } =
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

  function harness({ tabId = 3, processing = false, blocked = false, record, visible = true }) {
    const store = { [NEWTAB_HANDOFF_KEY]: record };
    const log = { mode: null, sent: [], value: '' };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const listeners = [];
    const state = { visible };
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
      },
      getCurrentTabId: () => tabId,
      getIsProcessing: () => processing,
      getIsBlocked: () => blocked,
      getIsDocumentVisible: () => state.visible,
      doc: { addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.push(fn); } },
      setMode: (m) => { log.mode = m; },
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async (params) => { log.sent.push(params); log.value = input.value; },
      now: () => 100_000,
    });
    return { handoff, store, log, input, state, listeners };
  }
  const rec = (over = {}) => ({ id: 'r1', tabId: 3, text: 'summarise', mode: 'ask', createdAt: 99_000, ...over });

  test(`${browser}: Ask is sent automatically and the record is claimed once`, async () => {
    const h = harness({ record: rec() });
    assert.equal(await h.handoff.consume(), true);
    assert.deepEqual([h.log.mode, h.log.sent, h.log.value], ['ask', [undefined], 'summarise']);
    assert.equal(NEWTAB_HANDOFF_KEY in h.store, false);
    assert.equal(await h.handoff.consume(), false);
    assert.equal(h.log.sent.length, 1);
  });

  test(`${browser}: Act is pre-filled but never sent`, async () => {
    const h = harness({ record: rec({ mode: 'act', text: 'book a table' }) });
    assert.equal(await h.handoff.consume(), true);
    assert.equal(h.log.mode, 'act');
    assert.equal(h.log.sent.length, 0);
    assert.equal(h.input.value, 'book a table');
  });

  test(`${browser}: a record for another tab is left alone; a stale one is dropped`, async () => {
    const other = harness({ record: rec({ tabId: 99 }) });
    assert.equal(await other.handoff.consume(), false);
    assert.equal(NEWTAB_HANDOFF_KEY in other.store, true);
    assert.equal(other.log.sent.length, 0);

    const stale = harness({ record: rec({ createdAt: 1 }) });
    assert.equal(await stale.handoff.consume(), false);
    assert.equal(NEWTAB_HANDOFF_KEY in stale.store, false);
  });

  test(`${browser}: Ask during an active run is queued behind it, not dropped`, async () => {
    const h = harness({ processing: true, record: rec() });
    assert.equal(await h.handoff.consume(), true);
    assert.deepEqual(h.log.sent, [{ __deliveryMode: 'queue' }]);
    assert.equal(h.input.value, 'summarise');
    assert.equal(NEWTAB_HANDOFF_KEY in h.store, false);
  });

  test(`${browser}: Ask while the conversation is being cleared is only pre-filled`, async () => {
    const h = harness({ blocked: true, record: rec() });
    await h.handoff.consume();
    assert.equal(h.log.sent.length, 0);
    assert.equal(h.input.value, 'summarise');
  });

  test(`${browser}: a hidden panel claims the task as soon as it becomes visible`, async () => {
    const h = harness({ visible: false, record: rec() });
    h.handoff.watch();
    assert.equal(await h.handoff.consume(), false);
    assert.equal(NEWTAB_HANDOFF_KEY in h.store, true);
    h.state.visible = true;
    h.listeners.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(h.log.sent.length, 1);
    assert.equal(NEWTAB_HANDOFF_KEY in h.store, false);
  });

  test(`${browser}: manifest and background are wired`, () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'src', browser, 'manifest.json'), 'utf8'));
    assert.equal(manifest.chrome_url_overrides?.newtab, 'newtab/index.html');
    assert.ok(manifest.permissions.includes('search'));
    assert.ok(existsSync(path.join(root, 'src', browser, 'newtab/index.html')), 'run npm run build:newtab');
    const bg = readFileSync(path.join(root, 'src', browser, 'src/background.js'), 'utf8');
    assert.match(bg, /WB_NEWTAB_PANEL_OPENED/);
  });
}

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
