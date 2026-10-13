import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BidiSession } from '../firefox-companion/session.mjs';
import { nativeReplyMessages } from '../firefox-companion/native-messages.mjs';
import { FirefoxBidiClient } from '../src/firefox/src/bidi/client.js';
import { saveScreenshot } from '../src/firefox/src/ui/screenshot-download.js';

function pngHeader(width, height) {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
  return png.toString('base64');
}
function captureSession() {
  const session = new BidiSession(), calls = [];
  const document = { url: 'https://example.com/', timeOrigin: 123, width: 800, height: 3000, dpr: 2, scrollX: 0, scrollY: 700 };
  session.locate = async () => ({ context: 'selected', node: { sharedId: 'document' } });
  session.call = async (_match, fn) => ({ result: { value: fn.includes('JSON.stringify') ? JSON.stringify(document) : true } });
  session.send = async (method, params) => { calls.push({ method, params }); return { data: pngHeader(1600, 6000) }; };
  return { session, calls, document };
}

test('full-page capture binds the document, preserves CSS bounds and leaves the active run alone', async () => {
  const { session, calls } = captureSession();
  const owner = { context: 'selected', navigation: false };
  session.runs.set('existing', owner);
  const result = await session.captureFullPage(crypto.randomUUID(), 'https://example.com/');
  assert.deepEqual(calls, [{ method: 'browsingContext.captureScreenshot', params: { context: 'selected', origin: 'document', format: { type: 'image/png' } } }]);
  assert.deepEqual(result.captureBounds, { x: 0, y: 0, width: 800, height: 3000 });
  assert.equal(session.runs.get('existing'), owner);
});
test('navigation or layout changes during capture discard the image', async () => {
  for (const changed of [{ timeOrigin: 456 }, { width: 900 }, { scrollY: 0 }]) {
    const { session, document } = captureSession();
    session.send = async () => { Object.assign(document, changed); return { data: pngHeader(1600, 6000) }; };
    await assert.rejects(session.captureFullPage(crypto.randomUUID(), document.url), /changed/);
  }
});
test('oversized pages and truncated native images fail explicitly', async () => {
  const { session, calls, document } = captureSession();
  document.height = 1e9;
  await assert.rejects(session.captureFullPage(crypto.randomUUID(), document.url), /too large/);
  assert.equal(calls.length, 0);
  document.height = 3000;
  session.send = async () => ({ data: pngHeader(1600, 900) });
  await assert.rejects(session.captureFullPage(crypto.randomUUID(), document.url), /whole document/);
});
test('a stale document binding never triggers native capture', async () => {
  const { session, calls } = captureSession();
  session.call = async () => ({ result: { type: 'null' } });
  await assert.rejects(session.captureFullPage(crypto.randomUUID(), 'https://example.com/'), /document changed/);
  assert.equal(calls.length, 0);
});

function clientHarness({ enabled = true, reply } = {}) {
  let receive;
  const sent = [];
  const api = {
    storage: { local: { get: async () => ({ firefoxBidiEnabled: enabled }) } },
    tabs: { get: async () => ({ url: 'https://example.com/' }), executeScript: async () => [{ token: crypto.randomUUID(), url: 'https://example.com/' }] },
    runtime: { connectNative: () => ({
      onMessage: { addListener: fn => { receive = fn; } }, onDisconnect: { addListener() {} },
      postMessage: request => {
        sent.push(request);
        const result = reply?.(request) || {};
        queueMicrotask(() => { for (const message of nativeReplyMessages({ id: request.id, result })) receive(message); });
      }, disconnect() {},
    }) },
  };
  return { client: new FirefoxBidiClient(api), api, sent, receive: message => receive(message) };
}
test('native replies larger than 1 MiB are reassembled without oversized messages', async () => {
  const dataUrl = 'data:image/png;base64,' + 'a'.repeat(2 * 1024 * 1024);
  for (const message of nativeReplyMessages({ id: 1, result: { dataUrl } })) {
    assert.ok(Buffer.byteLength(JSON.stringify(message)) < 1024 * 1024);
  }
  const { client } = clientHarness({ reply: () => ({ dataUrl }) });
  assert.deepEqual(await client.request('captureFullPage'), { dataUrl });
});
test('native framing remains below the cap for escaped Unicode data', () => {
  const result = '\u0000😀'.repeat(200000);
  const messages = [...nativeReplyMessages({ id: 5, result })];
  assert.ok(messages.length > 1);
  assert.ok(messages.every(message => Buffer.byteLength(JSON.stringify(message)) < 1024 * 1024));
  assert.equal(JSON.parse(messages.map(message => message.chunk).join('')).result, result);
});
test('out-of-order chunks reject and release the pending request', async () => {
  const { client, api } = clientHarness();
  api.runtime.connectNative = () => ({ onMessage: { addListener: fn => { api.deliver = fn; } }, onDisconnect: { addListener() {} }, postMessage() {} });
  const promise = client.request('captureFullPage');
  api.deliver({ id: 1, index: 1, chunk: 'bad', last: true });
  await assert.rejects(promise, /Invalid screenshot transfer/);
  assert.equal(client.pending.size, 0);
});
test('disabled BiDi fails before connecting or inspecting a tab', async () => {
  const { client, sent, api } = clientHarness({ enabled: false });
  api.tabs.get = () => assert.fail('must not inspect the tab');
  await assert.rejects(client.captureFullPage(7), /require Firefox trusted automation/);
  assert.equal(sent.length, 0);
});
test('standalone capture cannot replace or end an active automation run', async () => {
  const { client, sent } = clientHarness({ reply: () => ({ dataUrl: 'data:image/png;base64,example' }) });
  const owner = { runId: 'active', bound: true };
  client.runs.set(7, owner);
  let prepared = false;
  await client.captureFullPage(7, async () => { prepared = true; });
  assert.equal(prepared, true);
  assert.equal(client.runs.get(7), owner);
  assert.deepEqual(sent.map(item => item.command), ['connect', 'captureFullPage']);
  assert.equal(client.captures.size, 0);
});
test('disabling the connection during privacy preparation prevents screenshot dispatch', async () => {
  const { client, sent } = clientHarness();
  await assert.rejects(client.captureFullPage(7, async () => client.disconnect()), /connection changed/);
  assert.deepEqual(sent.map(item => item.command), ['connect']);
  assert.equal(client.captures.size, 0);
});
test('Firefox saving uses a live blob URL and releases it on completion', async () => {
  let listener, savedUrl;
  const api = { downloads: {
    onChanged: { addListener(fn) { listener = fn; }, removeListener(fn) { assert.equal(fn, listener); listener = null; } },
    download: async options => {
      savedUrl = options.url;
      assert.ok(savedUrl.startsWith('blob:'));
      assert.equal(options.saveAs, true);
      assert.equal(options.conflictAction, 'uniquify');
      assert.equal((await fetch(savedUrl)).status, 200);
      return 4;
    },
    search: async () => [{ state: 'in_progress' }],
  } };
  assert.equal(await saveScreenshot(`data:image/png;base64,${pngHeader(10, 10)}`, 'page.png', { api }), 4);
  assert.equal((await fetch(savedUrl)).status, 200);
  listener({ id: 4, state: { current: 'complete' } });
  assert.equal(listener, null);
  await assert.rejects(fetch(savedUrl));
});
test('cancelling Save as immediately releases its blob and download listener', async () => {
  let savedUrl, listener;
  const api = { downloads: {
    onChanged: { addListener(fn) { listener = fn; }, removeListener() { listener = null; } },
    download: async ({ url }) => { savedUrl = url; throw new Error('cancelled'); },
  } };
  await assert.rejects(saveScreenshot(`data:image/png;base64,${pngHeader(10, 10)}`, 'page.png', { api }), /cancelled/);
  assert.equal(listener, null);
  await assert.rejects(fetch(savedUrl));
});

// Exercise the production Agent method with deterministic capture/scan results.
const agentSource = readFileSync(new URL('../src/firefox/src/agent/agent.js', import.meta.url), 'utf8');
const captureMethod = agentSource.slice(agentSource.indexOf('  async captureFullPageScreenshotForUser('), agentSource.indexOf('  async captureViewportScreenshotForUser('));
test('full-page captures stage only stable, complete privacy geometry', async () => {
  const snapshot = { coordinateSpace: 'page', viewport: { width: 800, height: 3000 }, regions: [{ kind: 'input', rect: { x: 1, y: 2400, w: 50, h: 20 } }] };
  for (const after of [{ ok: true, snapshot }, { ok: false }, { ok: true, snapshot: { ...snapshot, regions: [] } }]) {
    const method = Function('firefoxBidi', `return ({${captureMethod}}).captureFullPageScreenshotForUser` )({
      captureFullPage: async (_tab, prepare) => { await prepare(); return { dataUrl: 'original', captureBounds: { x: 0, y: 0, width: 800, height: 3000 } }; },
    });
    let scans = 0;
    const result = await method.call({ screenshotRedaction: true, _withIndicatorsHidden: (_tab, fn) => fn(), captureScreenshotRedactionSnapshotForUser: async () => ++scans === 1 ? { ok: true, snapshot } : after }, 7);
    assert.equal(result.ok, true);
    assert.equal(result.dataUrl, 'original', 'local preview remains available');
    if (after.snapshot === snapshot) {
      assert.equal(result.redactionSnapshotReady, true);
      assert.equal(result.redactionUnavailable, undefined);
    } else {
      assert.equal(result.redactionUnavailable, true);
      assert.equal(result.redactionSnapshot, undefined);
    }
  }
});
