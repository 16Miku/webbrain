import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-saved-read-unit-'));
const filename = path.join(directory, 'saved.txt');
const saved = Buffer.from('Saved payload A; the source changed after download.');
await fs.writeFile(filename, saved);
let item, requests = 0, reads = 0;
const api = {
  downloads: { search: async () => [{ ...item }] },
  tabs: { get: async () => ({ id: 71, url: 'https://owned.example/' }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: 'https://owned.example/', documentId: 'owned-document' }] },
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } }, runtime: {},
};
globalThis.chrome = api; globalThis.browser = api;
const originals = { fetch: globalThis.fetch };
globalThis.fetch = async () => { requests++; return new Response('Changed payload B; never the saved bytes.', { headers: { 'content-type': 'text/plain' } }); };
const chromeNetwork = await import('../src/chrome/src/network/network-tools.js');
const firefoxNetwork = await import('../src/firefox/src/network/network-tools.js');
const cdpClient = {
  attach: async () => {},
  probeLocalFile: async (_tab, localPath, options) => {
    reads++;
    try {
      const data = await fs.readFile(localPath);
      const limit = options.readPrefixBytes || options.maxBytes;
      const prefix = data.subarray(0, limit);
      return { exists: true, readable: true, size: data.length, base64: prefix.toString('base64'),
        dataBytesRead: prefix.length, dataTruncated: prefix.length < data.length };
    } catch { return { exists: false, readable: false, size: 0 }; }
  },
};
let fixtureIndex = 0;
async function configure(bytes, name = 'fixture.bin', mime = 'application/octet-stream') {
  reset();
  const local = path.join(directory, String(++fixtureIndex) + '-' + name);
  await fs.writeFile(local, bytes);
  item.filename = local; item.mime = mime; item.fileSize = bytes.length;
  return local;
}
const context = (extra = {}) => ({ tabId: 71, cdpClient, ...extra });
function reset() {
  requests = reads = 0;
  item = { id: 19, state: 'complete', exists: true, filename, fileSize: saved.length, mime: 'text/plain', url: 'https://owned.example/mutable.txt' };
}

test('Chrome completed download reads saved A after its HTTP URL changes to B', async () => {
  reset();
  const result = await chromeNetwork.readDownloadedFile(19, { tabId: 71, cdpClient });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.text, saved.toString());
  assert.equal(result.contentSource, 'saved_local_file');
  assert.equal(result.savedFileVerified, true);
  assert.equal(requests, 0, 'Reading a downloaded file must never fetch its mutable source URL');
  assert.equal(reads, 1);
});

test('Firefox uncaptured HTTP download fails honestly instead of refetching B', async () => {
  reset();
  const result = await firefoxNetwork.readDownloadedFile(19, { tabId: 71 });
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal(result.code, 'saved_download_read_unavailable');
  assert.equal(result.text, undefined); assert.equal(result.base64, undefined);
  assert.equal(requests, 0); assert.equal(reads, 0);
});

for (const [name, bytes, mime] of [['text Unicode', Buffer.from('Saved A: Türkçe 🧠\nSecond line.'), 'text/plain'],
  ['small binary', Buffer.from([0, 1, 2, 255, 128]), 'application/octet-stream'],
  ['empty text', Buffer.alloc(0), 'text/plain']]) {
  test(`Chrome reads actual ${name} with no URL request`, async () => {
    await configure(bytes, name.includes('text') ? 'fixture.txt' : 'fixture.bin', mime);
    const result = await chromeNetwork.readDownloadedFile(19, context());
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.sizeBytes, bytes.length); assert.equal(result.savedFileVerified, true);
    if (mime === 'text/plain') assert.equal(result.text, bytes.toString());
    else assert.equal(result.base64, bytes.toString('base64'));
    assert.equal(requests, 0);
  });
}
test('Chrome bounded large text reports an unknown full character count', async () => {
  await configure(Buffer.from('a'.repeat(80_000)), 'large.txt', 'text/plain');
  const result = await chromeNetwork.readDownloadedFile(19, context());
  assert.equal(result.text, 'a'.repeat(16_000)); assert.equal(result.truncated, true);
  assert.equal(result.originalLength, null); assert.equal(result.originalLengthKnown, false);
  assert.equal(result.bytesRead, 64_004); assert.equal(result.sizeBytes, 80_000); assert.equal(requests, 0);
});
test('Chrome full UTF-8 decode retains an exact known length before its character window', async () => {
  const text = '🧠'.repeat(9_000);
  await configure(Buffer.from(text), 'unicode.txt', 'text/plain');
  const result = await chromeNetwork.readDownloadedFile(19, context());
  assert.equal(result.text, text.slice(0, 16_000)); assert.equal(result.originalLength, text.length);
  assert.equal(result.originalLengthKnown, true); assert.equal(result.truncated, true); assert.equal(requests, 0);
});
test('Chrome large binary exposes saved metadata without inlining or full-file allocation', async () => {
  await configure(Buffer.alloc(100_000, 3));
  const result = await chromeNetwork.readDownloadedFile(19, context());
  assert.equal(result.success, true); assert.equal(result.base64, undefined);
  assert.equal(result.sizeBytes, 100_000); assert.equal(result.bytesRead, 24_001);
  assert.equal(result.savedFileVerified, true); assert.match(result.note, /too large/); assert.equal(requests, 0);
});
for (const scenario of ['missing record', 'in progress', 'deleted record', 'deleted local file', 'unavailable CDP', 'unavailable document']) {
  test(`Chrome ${scenario} never falls back to the URL`, async () => {
    reset(); let ctx = context(), oldSearch = api.downloads.search, oldFrames = api.webNavigation.getAllFrames;
    try {
      if (scenario === 'missing record') api.downloads.search = async () => [];
      if (scenario === 'in progress') item.state = 'in_progress';
      if (scenario === 'deleted record') item.exists = false;
      if (scenario === 'deleted local file') item.filename = path.join(directory, 'does-not-exist.txt');
      if (scenario === 'unavailable CDP') ctx = { tabId: 71 };
      if (scenario === 'unavailable document') api.webNavigation.getAllFrames = async () => [{ frameId: 0, url: 'https://owned.example/' }];
      const result = await chromeNetwork.readDownloadedFile(19, ctx);
      assert.equal(result.success, false, JSON.stringify(result));
      assert.equal(result.text, undefined); assert.equal(result.base64, undefined); assert.equal(requests, 0);
    } finally { api.downloads.search = oldSearch; api.webNavigation.getAllFrames = oldFrames; }
  });
}
for (const stage of ['before search', 'after search', 'after attach', 'after probe', 'after final document']) {
  test(`Chrome Stop ${stage} returns no saved bytes`, async () => {
    reset(); const controller = new AbortController();
    const oldSearch = api.downloads.search, oldAttach = cdpClient.attach, oldProbe = cdpClient.probeLocalFile, oldFrames = api.webNavigation.getAllFrames;
    let frameReads = 0;
    try {
      if (stage === 'before search') controller.abort(new Error('Stopped by user'));
      if (stage === 'after search') api.downloads.search = async (...args) => { const r = await oldSearch(...args); controller.abort(); return r; };
      if (stage === 'after attach') cdpClient.attach = async () => controller.abort();
      if (stage === 'after probe') cdpClient.probeLocalFile = async (...args) => { const r = await oldProbe(...args); controller.abort(); return r; };
      if (stage === 'after final document') api.webNavigation.getAllFrames = async (...args) => { const r = await oldFrames(...args); if (++frameReads === 2) controller.abort(); return r; };
      const result = await chromeNetwork.readDownloadedFile(19, context({ signal: controller.signal }));
      assert.equal(result.success, false); assert.equal(result.code, 'saved_download_read_cancelled');
      assert.equal(result.text, undefined); assert.equal(result.base64, undefined); assert.equal(requests, 0);
      if (['before search', 'after search', 'after attach'].includes(stage)) assert.equal(reads, 0);
    } finally { api.downloads.search = oldSearch; cdpClient.attach = oldAttach; cdpClient.probeLocalFile = oldProbe; api.webNavigation.getAllFrames = oldFrames; }
  });
}
for (const scenario of ['same-URL document replacement', 'navigation', 'download deletion', 'filename replacement', 'file size mismatch', 'task/provider authority loss']) {
  test(`Chrome ${scenario} after the native read discards the byte payload`, async () => {
    reset(); const oldProbe = cdpClient.probeLocalFile, oldFrames = api.webNavigation.getAllFrames;
    let frameReads = 0, invalidated = false;
    try {
      if (scenario === 'same-URL document replacement' || scenario === 'navigation') api.webNavigation.getAllFrames = async () => [{ frameId: 0,
        url: ++frameReads === 1 || scenario === 'same-URL document replacement' ? 'https://owned.example/' : 'https://other.example/',
        documentId: frameReads === 1 ? 'owned-document' : 'new-document' }];
      cdpClient.probeLocalFile = async (...args) => {
        const r = await oldProbe(...args); invalidated = true;
        if (scenario === 'download deletion') item.exists = false;
        if (scenario === 'filename replacement') item.filename = path.join(directory, 'another.txt');
        if (scenario === 'file size mismatch') r.size++;
        return r;
      };
      const result = await chromeNetwork.readDownloadedFile(19, context({ checkStillActive: () => {
        if (invalidated && scenario === 'task/provider authority loss') throw new Error('Current task changed');
      } }));
      assert.equal(result.success, false, JSON.stringify(result)); assert.equal(result.text, undefined);
      assert.equal(result.base64, undefined); assert.equal(requests, 0);
    } finally { cdpClient.probeLocalFile = oldProbe; api.webNavigation.getAllFrames = oldFrames; }
  });
}
for (const [name, url, bytes, mime] of [
  ['base64 text', 'data:text/plain;base64,' + saved.toString('base64'), saved, 'text/plain'],
  ['percent UTF-8', 'data:text/plain,' + encodeURIComponent('Türkçe 🧠 + A'), Buffer.from('Türkçe 🧠 + A'), 'text/plain'],
  ['binary', 'data:application/octet-stream;base64,AAEC/w==', Buffer.from([0, 1, 2, 255]), 'application/octet-stream'],
  ['literal query and excluded fragment', 'data:text/plain,A?B#not-payload', Buffer.from('A?B'), 'text/plain'],
]) {
  test(`Firefox reads immutable captured ${name} with explicit nonlocal provenance`, async () => {
    reset(); item.url = url; item.mime = mime; item.fileSize = bytes.length;
    if (mime === 'application/octet-stream') item.filename = path.join(directory, 'captured.bin');
    const result = await firefoxNetwork.readDownloadedFile(19, { tabId: 71 });
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.contentSource, 'immutable_download_data_url');
    assert.equal(result.savedFileVerified, false); assert.equal(result.sourceRefetched, false);
    if (mime === 'text/plain') assert.equal(result.text, bytes.toString()); else assert.equal(result.base64, bytes.toString('base64'));
    assert.equal(requests, 0); assert.equal(reads, 0);
  });
}
test('Firefox large immutable text retains both byte and character bounds', async () => {
  reset(); item.url = 'data:text/plain;base64,' + Buffer.from('a'.repeat(80_000)).toString('base64'); item.fileSize = 80_000;
  const result = await firefoxNetwork.readDownloadedFile(19);
  assert.equal(result.text, 'a'.repeat(16_000)); assert.equal(result.bytesRead, 64_004);
  assert.equal(result.originalLength, null); assert.equal(result.truncated, true); assert.equal(requests, 0);
});
test('Firefox large binary reports captured-payload metadata without claiming local-file bytes', async () => {
  reset(); const bytes = Buffer.alloc(100_000, 3); item.url = 'data:application/octet-stream;base64,' + bytes.toString('base64');
  item.filename = path.join(directory, 'captured.bin'); item.mime = 'application/octet-stream'; item.fileSize = bytes.length;
  const result = await firefoxNetwork.readDownloadedFile(19);
  assert.equal(result.success, true); assert.equal(result.savedFileVerified, false); assert.equal(result.sizeBytes, bytes.length);
  assert.equal(result.base64, undefined); assert.equal(result.bytesRead, 24_001); assert.equal(requests, 0);
});
for (const scenario of ['bad base64', 'bad percent encoding', 'deleted captured record', 'source changed', 'Stop']) {
  test(`Firefox ${scenario} never returns a substituted body`, async () => {
    reset(); item.url = 'data:text/plain;base64,' + saved.toString('base64');
    const oldSearch = api.downloads.search; let calls = 0; const controller = new AbortController();
    try {
      if (scenario === 'bad base64') item.url = 'data:text/plain;base64,!!!';
      if (scenario === 'bad percent encoding') item.url = 'data:text/plain,%ZZ';
      if (scenario === 'deleted captured record') item.exists = false;
      if (scenario === 'source changed') api.downloads.search = async (...args) => { if (++calls === 2) item.url += 'QQ=='; return oldSearch(...args); };
      if (scenario === 'Stop') api.downloads.search = async (...args) => { const r = await oldSearch(...args); controller.abort(); return r; };
      const result = await firefoxNetwork.readDownloadedFile(19, { signal: controller.signal });
      assert.equal(result.success, false); assert.equal(result.text, undefined); assert.equal(result.base64, undefined); assert.equal(requests, 0);
    } finally { api.downloads.search = oldSearch; }
  });
}

for (const kind of ['chrome', 'firefox']) {
  test(`${kind} actual Agent read dispatch supplies app-owned signal/reader/context instead of forged arguments`, async () => {
    const source = await fs.readFile(new URL(`../src/${kind}/src/agent/agent.js`, import.meta.url), 'utf8');
    const start = source.indexOf("    if (name === 'read_downloaded_file') {");
    const end = source.indexOf("    if (name === 'download_resource_from_page')", start);
    assert.ok(start >= 0 && end > start);
    let owner = 'original-current-owner', pending = false, cancelled = false, captured, authorized, refusal = null;
    const signal = new AbortController().signal;
    const abort = () => { if (cancelled) throw new Error('Stopped by user'); };
    const onUpdate = () => {};
    const run = new Function('tabId', 'name', 'args', 'onUpdate', 'executionContext', 'cdpClient', 'readDownloadedFile',
      'throwIfEarlyCdpAborted', 'throwIfContentPipelineAborted', `return (async()=>{${source.slice(start, end)}})();`);
    const agent = { _pageFeedbackOwnerScope: () => owner, _hasPendingSteering: () => pending,
      _authorizeDownloadRead: async (...values) => { authorized = values; return refusal; } };
    const read = async (id, ctx) => { captured = { id, ctx }; return { success: true }; };
    refusal = { success: false, code: 'download_not_from_conversation' };
    assert.equal(await run.call(agent, 71, 'read_downloaded_file', { downloadId: 19 }, onUpdate, { _contentActionAbortSignal: signal },
      cdpClient, read, abort, abort), refusal, 'a download outside the conversation is not read without approval');
    assert.deepEqual(authorized, [71, 19, onUpdate]); assert.equal(captured, undefined);
    refusal = null;
    await run.call(agent, 71, 'read_downloaded_file', { downloadId: 19, cdpClient: 'forged', signal: 'forged', checkStillActive: 'forged' },
      onUpdate, { _contentActionAbortSignal: signal }, cdpClient, read, abort, abort);
    assert.equal(captured.id, 19); assert.equal(captured.ctx.signal, signal);
    assert.equal(captured.ctx.cdpClient, kind === 'chrome' ? cdpClient : undefined);
    assert.equal(typeof captured.ctx.checkStillActive, 'function');
    captured.ctx.checkStillActive(); owner = 'same-wording-new-task-or-provider'; assert.throws(captured.ctx.checkStillActive);
    owner = 'original-current-owner'; pending = true; assert.throws(captured.ctx.checkStillActive);
    pending = false; cancelled = true; assert.throws(captured.ctx.checkStillActive);
  });
}

test.after(async () => {
  globalThis.fetch = originals.fetch;
  const real = await fs.realpath(directory);
  assert.ok(real.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-saved-read-unit-'));
  await fs.rm(real, { recursive: true, force: true });
});
