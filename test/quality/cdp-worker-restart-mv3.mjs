import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Real Chrome extension namespaces, actual worker loss and native debugger
// ownership. The second extension and every page belong to this local lab.
const output = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-07/cdp-worker-restart-mv3');
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-cdp-worker-mv3-'));
const extension = path.join(profile, 'product'), foreign = path.join(profile, 'other-extension');
const started = Date.now(), evidence = { installedMV3: true, externalMessages: 0, externalRequests: 0 };
let context;
const server = http.createServer((_request, response) => response.end('<!doctype html><title>Owned debugger lab</title><main>Owned debugger test page</main>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/owned-debugger`;
try {
  await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  evidence.cdpSourceSha256 = createHash('sha256').update(await fs.readFile(path.join(extension, 'src/cdp/cdp-client.js'))).digest('hex');
  await fs.appendFile(path.join(extension, 'src/background.js'), `
import { CDPClient as OwnedLabCdpClient } from './cdp/cdp-client.js';
globalThis.__ownedCdpBoot = crypto.randomUUID();
globalThis.ownedCdp = new OwnedLabCdpClient();
`);
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Owned foreign debugger lab',
    version: '1.0', permissions: ['debugger', 'tabs'], background: { service_worker: 'worker.js' } }));
  await fs.writeFile(path.join(foreign, 'worker.js'), "chrome.runtime.onMessage.addListener((_message,_sender,respond)=>{respond({owned:true});});");
  await fs.writeFile(path.join(foreign, 'harness.html'), '<!doctype html><title>Owned secondary extension</title>');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension},${foreign}`, `--load-extension=${extension},${foreign}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', route => {
    const parsed = new URL(route.request().url());
    if (parsed.hostname === '127.0.0.1' || parsed.protocol === 'chrome-extension:') return route.continue();
    evidence.externalRequests++; return route.abort('blockedbyclient');
  });
  const startupDeadline = Date.now() + 5000;
  while (context.serviceWorkers().length < 2 && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  const workers = context.serviceWorkers(); assert.equal(workers.length, 2);
  let worker = workers.find(item => item.url().endsWith('/src/background.js'));
  const otherWorker = workers.find(item => item !== worker); assert.ok(worker && otherWorker);
  const extensionId = new URL(worker.url()).host, foreignId = new URL(otherWorker.url()).host;
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
  const otherHarness = await context.newPage(); await otherHarness.goto(`chrome-extension://${foreignId}/harness.html`);
  const page = await context.newPage(); await page.goto(url);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  assert.ok(tabId);
  await worker.evaluate(tabId => ownedCdp.attach(tabId), tabId);
  const oldBoot = await worker.evaluate(() => __ownedCdpBoot);
  const devtools = await context.newCDPSession(harness), versions = new Map();
  devtools.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => updates.forEach(version => versions.set(version.versionId, version)));
  await devtools.send('ServiceWorker.enable');
  let version; const deadline = Date.now() + 5000;
  while (!version && Date.now() < deadline) {
    version = [...versions.values()].find(item => item.runningStatus === 'running'
      && item.scriptURL.startsWith(`chrome-extension://${extensionId}/`));
    if (!version) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(version); await devtools.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await harness.evaluate(() => chrome.runtime.sendMessage({ target: 'background', action: 'get_providers' }));
  worker = context.serviceWorkers().find(item => item.url().startsWith(`chrome-extension://${extensionId}/`));
  assert.notEqual(await worker.evaluate(() => __ownedCdpBoot), oldBoot);
  evidence.ownWorkerRecovery = await worker.evaluate(async tabId => {
    const emptyBefore = ownedCdp.sessions.size === 0;
    await ownedCdp.attach(tabId);
    const result = await ownedCdp.sendCommand(tabId, 'Runtime.evaluate', { expression: 'void 0', returnByValue: true });
    return { emptyBefore, adopted: ownedCdp.sessions.has(tabId), nativeCommandSucceeded: result?.result?.type === 'undefined' };
  }, tabId);
  assert.deepEqual(evidence.ownWorkerRecovery, { emptyBefore: true, adopted: true, nativeCommandSucceeded: true });
  await worker.evaluate(tabId => ownedCdp.detach(tabId), tabId);
  const rawProbe = tabId => harness.evaluate(async tabId => {
    try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: 'void 0', returnByValue: true }); return { accepted: true }; }
    catch (error) { return { accepted: false, nativeNotAttached: /^Debugger is not attached/.test(error.message) }; }
  }, tabId);
  evidence.detachedProbe = await rawProbe(tabId);
  assert.deepEqual(evidence.detachedProbe, { accepted: false, nativeNotAttached: true });
  await otherHarness.evaluate(tabId => chrome.debugger.attach({ tabId }, '1.3'), tabId);
  evidence.foreignOnlyProbe = await rawProbe(tabId);
  assert.deepEqual(evidence.foreignOnlyProbe, { accepted: false, nativeNotAttached: true },
    'An attached foreign extension cannot authorize this extension’s ownership command.');
  evidence.normalAttachAlongsideForeign = await worker.evaluate(async tabId => {
    try { await ownedCdp.attach(tabId); return { accepted: true, ownSession: ownedCdp.sessions.has(tabId) }; }
    catch { return { accepted: false, ownSession: ownedCdp.sessions.has(tabId) }; }
  }, tabId);
  // Chrome may allow independent native clients. A new successful native
  // attach is valid; the foreign client must remain intact in either case.
  if (evidence.normalAttachAlongsideForeign.accepted) await worker.evaluate(tabId => ownedCdp.detach(tabId), tabId);
  const foreignResult = await otherHarness.evaluate(tabId => chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate',
    { expression: 'void 0', returnByValue: true }), tabId);
  evidence.foreignStillAttached = foreignResult?.result?.type === 'undefined'; assert.equal(evidence.foreignStillAttached, true);
  await otherHarness.evaluate(tabId => chrome.debugger.detach({ tabId }), tabId);
  evidence.finalDetachedProbe = await rawProbe(tabId);
  assert.deepEqual(evidence.finalDetachedProbe, { accepted: false, nativeNotAttached: true });
  evidence.passed = true; evidence.elapsedMs = Date.now() - started;
  await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, installedMV3: true, actualWorkerRestart: true,
    foreignOwnerRejected: true, detachedRejected: true, foreignConnectionPreserved: true, elapsedMs: evidence.elapsedMs }));
} catch (error) {
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ ...evidence, error: error.message }, null, 2)); throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  if (!path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-cdp-worker-mv3-')) throw Error('Unexpected profile.');
  await fs.rm(profile, { recursive: true, force: true });
}
