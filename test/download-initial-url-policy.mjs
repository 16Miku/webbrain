import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

const root = process.env.WEBBRAIN_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url));

// Exercise the complete production module and download entry points. Browser
// API mocks record what would be dispatched; this makes no network requests.
async function fixture(browser, { allowLocalNetwork = false, resource, finalUrl, size = 3,
    redirects = {}, ambiguous = false, foreign = false, quotaError = false, fault = '', holdNative = false, afterNativeStart, disposition = '', contentType = 'application/octet-stream' } = {}) {
  const calls = [], requests = [], released = [], stages = new Map(), files = new Map();
  const items = new Map();
  let settingListener;
  const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: d => { for (const fn of listeners) fn(d); }, get count() { return listeners.size; } }; };
  const storage = { local: { get: async () => ({ agentAllowLocalNetwork: allowLocalNetwork }) }, onChanged: { addListener(fn) { settingListener = fn; } } };
  const downloads = {
    onChanged: event(),
    download(opts, callback) {
      calls.push({ ...opts }); const id = calls.length;
      items.set(id, { id, state: holdNative ? 'in_progress' : 'complete', exists: true, filename: opts.filename || 'fixture/output.bin',
        url: opts.url, finalUrl: opts.url, bytesReceived: size, totalBytes: size });
      callback?.(id); if (afterNativeStart) setTimeout(afterNativeStart,0); return Promise.resolve(id);
    },
    cancel(id, callback) { items.get(id).state = 'interrupted'; downloads.onChanged.emit({id,state:{current:'interrupted'}}); callback?.(); return Promise.resolve(); },
    search({ id }, callback) { const found = items.has(id) ? [items.get(id)] : []; callback?.(found); return Promise.resolve(found); },
  };
  const extensionOrigin = browser === 'chrome' ? 'chrome-extension://owned-fixture' : 'moz-extension://owned-fixture';
  const documentUrl = extensionOrigin + '/src/background.html';
  const api = { storage, downloads, webRequest: { onBeforeRequest: event(), onHeadersReceived: event() },
    runtime: { getURL: suffix => extensionOrigin + '/' + suffix, getContexts: async () => [{ documentId: 'owned-offscreen' }] },
    scripting: { executeScript: async () => [{ result: resource }] }, tabs: { executeScript: async () => [resource] } };
  const directory = { async *keys() { yield* files.keys(); }, async removeEntry(name) { files.delete(name); },
    async getFileHandle(name) { const chunks = []; files.set(name, chunks); if(fault==='open') throw new Error('owned opening fault'); return {
      async createWritable() { if(fault==='writable') throw new Error('owned writable fault'); return { async write(chunk) { if (quotaError) throw new Error('QuotaExceededError'); chunks.push(chunk); }, async close() {}, async abort() {} }; },
      async getFile() { if(fault==='finalize') throw new Error('owned finalization fault'); return new Blob(chunks); } }; } };
  let requestId = 0;
  const fetch = async (url, options) => {
    requests.push({ url, credentials: options.credentials, redirect: options.redirect, signal: options.signal });
    if (options.signal.aborted) throw new Error('stopped');
    const id = String(++requestId), metadata = { url, method: 'GET', type: 'xmlhttprequest', requestId: id,
      initiator: foreign ? 'https://foreign.example' : extensionOrigin, documentId: foreign ? 'foreign-doc' : 'owned-offscreen', documentUrl: foreign ? 'moz-extension://foreign/background.html' : documentUrl, originUrl: foreign ? 'moz-extension://foreign/background.html' : documentUrl };
    api.webRequest.onBeforeRequest.emit(metadata);
    if (ambiguous) api.webRequest.onBeforeRequest.emit({ ...metadata, requestId: 'concurrent' });
    const destination = redirects[url] || (finalUrl && requests.length === 1 ? finalUrl : null);
    const responseHeaders = destination ? [{ name: 'Location', value: destination }] : [];
    api.webRequest.onHeadersReceived.emit({ ...metadata, statusCode: destination ? 302 : 200, responseHeaders });
    if (destination) return { type: 'opaqueredirect', status: 0, body: { cancel: async () => {} } };
    const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': contentType, 'content-disposition': disposition } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  };
  const FixtureURL=class extends URL { static createObjectURL(blob) { if(fault==='blob')throw new Error('owned Blob creation fault');return URL.createObjectURL(blob); } };
  const context = vm.createContext({ chrome: api, browser: api, URL:FixtureURL, Blob, Response, AbortController, crypto: globalThis.crypto,
    navigator: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) } },
    document: {}, performance: { timeOrigin: 42 }, Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval, console, fetch,
    ensureOffscreen: async () => {} });
  const helper = await readFile(path.join(root, `src/${browser}/src/network/download-staging.js`), 'utf8');
  vm.runInContext(helper.replace(/^export /gm, ''), context);
  vm.runInContext('const qaDisk=createDiskDownloadStore(); globalThis.qaJobs=createAuthenticatedDownloadJobs(qaDisk.stage,async token=>{released.push(token);await qaDisk.release(token);});', Object.assign(context,{released}));
  api.runtime.sendMessage = (message, callback) => {
    const jobs = context.qaJobs;
    const promise = message.type === 'authenticated-download-start' ? jobs.start(message.jobId, message.url)
      : message.type === 'authenticated-download-status' ? jobs.status(message.jobId)
      : message.type === 'authenticated-download-cancel' ? jobs.cancel(message.jobId)
      : message.type === 'authenticated-download-forget' ? jobs.forget(message.jobId)
      : message.type === 'authenticated-download-release' ? jobs.release(message.releaseToken).then(()=>({success:true}))
      : Promise.reject(new Error('Unexpected message'));
    promise.then(result => callback(result || {success:true}));
  };
  const source = await readFile(path.join(root, `src/${browser}/src/network/network-tools.js`), 'utf8');
  { const directorySource = await readFile(path.join(root, `src/${browser}/src/download-directory.js`), 'utf8'); vm.runInContext(directorySource.replace(/^export /gm, ''), context); }
  const runnable = source.replace(/^import .*;\r?\n/gm, '').replace(/^export (?=(?:async )?function |(?:const|let|class) )/gm, '');
  vm.runInContext(runnable + '\n globalThis.entry = { downloadFiles, downloadResourceFromPage };', context);
  await Promise.resolve();
  return { calls, requests, stages, files, released, api, entry: context.entry,
    setLocal(value) { settingListener({ agentAllowLocalNetwork: { newValue: value } }, 'local'); } };
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser}: direct local and obfuscated IP downloads are refused before browser dispatch`, async () => {
    const f = await fixture(browser);
    const urls = ['http://localhost/x', 'http://127.0.0.1/x', 'http://2130706433/x',
      'http://0x7f000001/x', 'http://10.0.0.1/x', 'http://192.168.1.2/x',
      'http://[::1]/x', 'http://[::ffff:127.0.0.1]/x'];
    const result = await f.entry.downloadFiles({ urls });
    assert.equal(f.calls.length, 0);
    assert.equal(result.failed, urls.length);
    assert.ok(result.downloads.every(item => item.success === false && item.blocked === true));
  });

  test(`${browser}: metadata and link-local downloads stay blocked with local networking enabled`, async () => {
    const f = await fixture(browser, { allowLocalNetwork: true });
    const urls = ['http://169.254.169.254/latest/', 'http://metadata.google.internal/x',
      'http://service.internal/x', 'http://service.local/x', 'http://[fe80::1]/x'];
    const result = await f.entry.downloadFiles({ urls });
    assert.equal(f.calls.length, 0);
    assert.equal(result.failed, urls.length);
  });

  test(`${browser}: unsupported schemes and malformed tool URLs cannot reach downloads`, async () => {
    const f = await fixture(browser);
    const urls = ['file:///C:/private.txt', 'ftp://public.example/data',
      'data:text/plain,tool-data', 'blob:https://public.example/unowned', 'not a URL'];
    const result = await f.entry.downloadFiles({ urls });
    assert.equal(f.calls.length, 0);
    assert.equal(result.failed, urls.length);
  });

  test(`${browser}: explicit local-network changes use the existing setting without permitting metadata`, async () => {
    const f = await fixture(browser);
    f.setLocal(true);
    const allowed = await f.entry.downloadFiles({ urls: ['http://127.0.0.1/authorized', 'http://10.2.3.4/authorized'] });
    assert.equal(allowed.succeeded, 2);
    assert.equal(f.calls.length, 2);
    f.setLocal(false);
    const denied = await f.entry.downloadFiles({ urls: ['http://127.0.0.1/again'] });
    assert.equal(denied.failed, 1);
    assert.equal(f.calls.length, 2);
  });

  test(`${browser}: authorized HTTPS downloads stage authenticated bytes and preserve multi-gigabyte native byte counts`, async () => {
    const size = 2 * 1024 ** 3 + 17;
    const f = await fixture(browser, { size });
    const url = 'https://files.example/authenticated/export?download=1';
    const result = await f.entry.downloadFiles({ urls: [url], filename: 'export.bin' });
    assert.equal(result.succeeded, 1);
    assert.ok(f.calls[0].url.startsWith('blob:'));
    assert.equal(f.requests[0].url, url);
    assert.equal(f.requests[0].credentials, 'include');
    assert.equal(f.requests[0].redirect, 'manual');
    assert.equal(f.calls[0].conflictAction, 'uniquify');
    assert.equal(f.calls[0].filename, 'export.bin');
    assert.equal(result.downloads[0].bytesReceived, size);
    assert.equal(result.downloads[0].totalBytes, size);
    assert.equal(result.downloads[0].state, 'complete');
  });

  test(`${browser}: mixed public/private batches retain indexes and dispatch only public URLs`, async () => {
    const f = await fixture(browser);
    const urls = ['https://one.example/a', 'http://10.0.0.2/b', 'https://two.example/c'];
    const result = await f.entry.downloadFiles({ urls });
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    assert.deepEqual(Array.from(result.downloads, item => item.url), urls);
    assert.deepEqual(f.requests.map(item => item.url), [urls[0], urls[2]]);
    assert.ok(f.calls.every(item => item.url.startsWith('blob:')));
  });

  test(`${browser}: a page resource on a local origin uses the same network policy`, async () => {
    const resource = { ok: true, url: 'http://127.0.0.1/report', isBlob: false, crossOrigin: false };
    const f = await fixture(browser, { resource });
    const result = await f.entry.downloadResourceFromPage(7, { selector: '#report' });
    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
    assert.equal(f.calls.length, 0);
  });

  test(`${browser}: an already extracted page-owned blob keeps its local download path`, async () => {
    const resource = { ok: true, url: 'data:image/png;base64,AAAA', isBlob: true, mime: 'image/png' };
    const f = await fixture(browser, { resource });
    const result = await f.entry.downloadResourceFromPage(7, { selector: '#preview', filename: 'preview.png' });
    assert.equal(result.success, true);
    assert.equal(result.blob, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, resource.url);
  });

  test(`${browser}: page resources still require the initial same-origin permission boundary`, async () => {
    const f = await fixture(browser, { resource: { ok: true, url: 'https://other.example/report', isBlob: false, crossOrigin: true } });
    const result = await f.entry.downloadResourceFromPage(7, { selector: '#report' });
    assert.equal(result.success, false);
    assert.equal(f.calls.length, 0);
  });

  test(`${browser}: a private redirect is refused before its destination or native saving`, async () => {
    const f = await fixture(browser, { finalUrl: 'http://127.0.0.1/redirect-destination' });
    const result = await f.entry.downloadFiles({ urls: ['https://permitted.example/redirect'] });
    assert.equal(result.failed, 1);
    assert.equal(result.downloads[0].blocked, true);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.requests.map(item => item.url), ['https://permitted.example/redirect']);
  });
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser}: exact same-origin redirects are followed once before a single local save`, async () => {
    const start = 'https://files.example/redirect?token=owned';
    const final = 'https://files.example/exact/file.bin?token=owned';
    const f = await fixture(browser, { redirects: { [start]: final } });
    const result = await f.entry.downloadFiles({urls:[start]});
    assert.equal(result.succeeded,1); assert.deepEqual(f.requests.map(r=>r.url),[start,final]);
    assert.equal(f.calls.length,1); assert.ok(f.calls[0].url.startsWith('blob:'));
  });
  test(`${browser}: a public cross-origin redirect requires a fresh download decision`, async () => {
    const start='https://files.example/start', destination='https://cdn.example/owned.bin';
    const f=await fixture(browser,{redirects:{[start]:destination}});
    const result=await f.entry.downloadFiles({urls:[start]});
    assert.equal(result.failed,1); assert.equal(result.downloads[0].redirectRequiresPermission,true);
    assert.equal(result.downloads[0].redirectUrl,destination); assert.equal(f.calls.length,0);
    assert.deepEqual(f.requests.map(r=>r.url),[start]);
    const next=await f.entry.downloadFiles({urls:[destination]});
    assert.equal(next.succeeded,1); assert.deepEqual(f.requests.map(r=>r.url),[start,destination]);
  });
  test(`${browser}: ambiguous concurrent or foreign-document redirect evidence cannot be adopted`, async () => {
    for (const flags of [{ambiguous:true},{foreign:true}]) {
      const start='https://files.example/start'; const f=await fixture(browser,{...flags,redirects:{[start]:'https://files.example/end'}});
      const result=await f.entry.downloadFiles({urls:[start]});
      assert.equal(result.failed,1); assert.equal(f.calls.length,0); assert.equal(f.requests.length,1);
      assert.equal(f.api.webRequest.onBeforeRequest.count,0); assert.equal(f.api.webRequest.onHeadersReceived.count,0);
    }
  });
  test(`${browser}: cycles have a bounded hop count and never reach browser download dispatch`, async () => {
    const url='https://files.example/cycle'; const f=await fixture(browser,{redirects:{[url]:url}});
    const result=await f.entry.downloadFiles({urls:[url]});
    assert.equal(result.failed,1); assert.equal(f.requests.length,9); assert.equal(f.calls.length,0);
  });
  test(`${browser}: Stop before staging dispatches no fetch or native download`, async () => {
    const f=await fixture(browser); const controller=new AbortController(); controller.abort();
    const result=await f.entry.downloadFiles({urls:['https://files.example/file.bin']},{signal:controller.signal});
    assert.equal(result.failed,1); assert.equal(f.requests.length,0); assert.equal(f.calls.length,0);
  });
  test(`${browser}: OPFS quota errors fail without native save and release temporary files`, async () => {
    const f=await fixture(browser,{quotaError:true});
    const result=await f.entry.downloadFiles({urls:['https://files.example/file.bin']});
    assert.equal(result.failed,1); assert.equal(f.calls.length,0); assert.equal(f.stages.size,0); assert.equal(f.files.size,0);
  });
  test(`${browser}: attachment UTF-8 filenames and explicit user filenames survive local staging`, async () => {
    const url='https://files.example/export';const f=await fixture(browser,{disposition:"attachment; filename=fallback.bin; filename*=UTF-8''r%C3%A9sum%C3%A9.bin"});
    assert.equal((await f.entry.downloadFiles({urls:[url]})).succeeded,1); assert.equal(f.calls[0].filename,'résumé.bin');
    assert.equal((await f.entry.downloadFiles({urls:[url],filename:'chosen.bin'})).succeeded,1); assert.equal(f.calls[1].filename,'chosen.bin');
  });
  test(`${browser}: URL basename and MIME fallback survive local staging`, async () => {
    const f=await fixture(browser,{contentType:'image/png'});
    await f.entry.downloadFiles({urls:['https://files.example/my%20image.png']}); assert.equal(f.calls[0].filename,'my image.png');
    await f.entry.downloadFiles({urls:['https://files.example/']}); assert.equal(f.calls[1].filename,'download.png');
  });
}

for(const browser of ['chrome','firefox']) {
  test(`${browser}: every opening and finalization failure removes its unique OPFS file`, async()=>{
    for(const fault of ['open','writable','finalize','blob']) {
      const f=await fixture(browser,{fault});const result=await f.entry.downloadFiles({urls:['https://files.example/owned.bin']});
      assert.equal(result.failed,1);assert.equal(f.calls.length,0);assert.equal(f.files.size,0);
    }
  });
  test(`${browser}: accepted Stop cancels an in-progress local save without deleting a completed file`, async()=>{
    const controller=new AbortController();const f=await fixture(browser,{holdNative:true,afterNativeStart:()=>controller.abort()});
    const result=await f.entry.downloadFiles({urls:['https://files.example/owned.bin']},{signal:controller.signal});
    assert.equal(f.calls.length,1);assert.equal(result.failed,1);assert.equal(result.downloads[0].cancelled,true);
    assert.equal(result.downloads[0].state,'interrupted');assert.equal(result.downloads[0].savedBeforeStop,false);assert.equal(f.files.size,0);
  });
}

// Use the public production executeTool wrapper and its actual run Stop signal.
// Only browser capture APIs are neutral mocks; no network or browser is opened.
async function agentSaveDuringPreferenceRead(route, stop) {
  const previousChrome = globalThis.chrome;
  const calls = [], scriptCalls = [];
  let releasePreference, preferenceStarted;
  const started = new Promise(resolve => { preferenceStarted = resolve; });
  const listeners = new Set();
  const api = {
    runtime: { getURL: suffix => `chrome-extension://owned-save-fixture/${suffix}` },
    storage: { local: { get(key) {
      if (key !== 'downloadDirectory') return Promise.resolve({});
      preferenceStarted();
      return new Promise(resolve => { releasePreference = resolve; });
    } }, onChanged: { addListener() {} } },
    tabs: { get: async () => ({ url: 'https://example.invalid/owned', active: true, windowId: 1 }) },
    scripting: { executeScript: async params => { scriptCalls.push(params); return [{ result: { success: false } }]; } },
    downloads: {
      onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      download: async opts => { calls.push({ ...opts }); return 1; },
      search: async () => [{ id: 1, exists: true, state: 'complete', filename: calls[0]?.filename,
        url: calls[0]?.url, finalUrl: calls[0]?.url, totalBytes: 3, bytesReceived: 3 }],
    },
  };
  globalThis.chrome = api;
  const { Agent } = await import(new URL('../src/chrome/src/agent/agent.js', import.meta.url));
  const { cdpClient } = await import(new URL('../src/chrome/src/cdp/cdp-client.js', import.meta.url));
  const oldCdp = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand, stopDialogHandling: cdpClient.stopDialogHandling };
  const agent = new Agent({});
  const tabId = 701;
  const pixels = 'data:image/png;base64,AQID';
  cdpClient.attach = async () => {};
  cdpClient.sendCommand = async (_tab, method) => method === 'Page.captureScreenshot' ? { data: 'AQID' } : {};
  cdpClient.stopDialogHandling = () => {};
  agent._beginPageFeedbackRun = async () => {};
  agent._richTextToolbarToolBlock = async () => null;
  agent._chromeProtectedPageFailure = async () => null;
  agent._activeProvider = () => null;
  agent._resolveVisionRoute = async () => ({ provider: route === 'crop' ? {} : null, rawImage: false, route: 'neutral' });
  agent._recordVisionRouteTrace = () => {};
  agent._captureViewportProbe = async () => ({ innerWidth: 10, innerHeight: 10 });
  agent._preparePageForCapture = async () => {};
  agent._withIndicatorsHidden = async (_tab, action) => action();
  agent._retryBlankScreenshotCapture = async first => first;
  agent._shrinkImageForBudget = async dataUrl => ({ dataUrl, width: 10, height: 10 });
  agent._measureScreenshotDataUrl = async () => ({ width: 10, height: 10 });
  agent._getFullPageCapturePolicy = async () => ({});
  agent._captureFullPageWithBlankRetry = async () => ({ dataUrl: pixels, capture: { captureBounds: { width: 10, height: 10 } } });
  agent._captureVisibleMediaScreenshot = async () => ({ dataUrl: pixels });
  agent._locateVisibleMediaWithVision = async () => ({ success: true, rect: { x: 0, y: 0, width: 10, height: 10 } });
  agent._cropDataUrl = async () => ({ dataUrl: pixels, mimeType: 'image/png', bytes: 3, width: 10, height: 10 });
  try {
    await agent._claimRunEntry(tabId, 'interactive');
    const runSignal = agent._runAbortSignal(tabId);
    assert.equal(runSignal.aborted, false);
    const name = route === 'crop' ? 'download_social_media' : route === 'full' ? 'full_page_screenshot' : 'screenshot';
    const args = route === 'crop' ? { strategy: 'vision', filename: 'chosen.png' } : { save: true, filename: 'chosen.png' };
    const resultPromise = agent.executeTool(tabId, name, args);
    await started;
    assert.equal(calls.length, 0, `${route}: native save must await its filename preference`);
    if (stop) {
      agent.abort(tabId);
      assert.equal(runSignal.aborted, true, `${route}: public Stop must cancel this claimed run`);
    }
    releasePreference({ downloadDirectory: 'Owned/Exports' });
    const result = await resultPromise;
    if (stop) {
      assert.equal(calls.length, 0, `${route}: cancelled preference read must not dispatch a native save`);
      assert.equal(result.success, false, `${route}: cancelled save must not report saved-file success`);
      assert.equal(scriptCalls.length, 0, `${route}: cancellation must not start a fallback downloader`);
    } else {
      assert.equal(calls.length, 1, `${route}: live save must dispatch exactly once`);
      assert.equal(calls[0].filename, 'Owned/Exports/chosen.png');
      assert.equal(calls[0].url, pixels);
      assert.equal(calls[0].saveAs, false);
      assert.equal(result.success, true);
    }
    return { calls, result };
  } finally {
    agent._releaseRunEntry(tabId);
    Object.assign(cdpClient, oldCdp);
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
}

for (const route of ['screenshot', 'full', 'crop']) {
  test(`chrome: ${route} save preserves a delayed configured filename on the actual executeTool path`, async () => {
    await agentSaveDuringPreferenceRead(route, false);
  });
  test(`chrome: ${route} save stops before native dispatch when public Stop cancels a delayed preference read`, async () => {
    await agentSaveDuringPreferenceRead(route, true);
  });
}
