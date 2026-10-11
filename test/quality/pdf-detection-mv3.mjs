import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// A server may process HEAD exactly as GET and replace a one-use session
// token. The installed Agent must inspect a normal document without issuing
// either request, then follow the acceptance link that was actually observed.
const requests = [];
let generation = 0, accepted = 0, blockedMutations = 0;
const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (!['GET', 'HEAD'].includes(request.method)) {
    blockedMutations++;
    response.writeHead(405).end();
    return;
  }
  if (url.pathname !== '/rules') { response.writeHead(404).end(); return; }
  requests.push({ method: request.method, path: url.pathname, queryKeys: [...url.searchParams.keys()] });
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'HEAD') {
    generation++;
    response.end();
    return;
  }
  if (url.searchParams.get('accept') === String(generation) && generation > 0) {
    accepted++;
    response.end('<!doctype html><title>Owned account details</title><h1>QA account details</h1><form><label>Username <input name="username"></label><label>Email <input name="email" type="email"></label><button>Register</button></form>');
    return;
  }
  generation++;
  response.end(`<!doctype html><title>Owned one-use rules</title><h1>QA registration rules</h1><p>Read these rules, then accept them.</p><a href="/rules?accept=${generation}">Accept QA rules</a>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-mime-mv3-'));
let context;
try {
  const extension = path.join(profile, 'owned-extension');
  await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  // Expose the existing background instance in a disposable installed copy.
  // No Agent detection, dispatch, verification or content method is mocked.
  await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.mimeFixtureAgent = agent;\n');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (/^https?:$/.test(url.protocol) && url.origin !== origin) return route.abort('blockedbyclient');
    return route.continue();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  await harness.evaluate(() => chrome.storage.local.set({
    helpImproveWebBrain: false, tracingEnabled: false, autoScreenshot: false,
    screenshotFallback: false, agentAllowLocalNetwork: true,
  }));
  const page = await context.newPage();
  await page.goto(`${origin}/rules`);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  assert.ok(Number.isInteger(tabId));
  const observation = await worker.evaluate(tabId => mimeFixtureAgent.executeTool(tabId, 'get_accessibility_tree', { filter: 'all' }), tabId);
  const ref = observation.pageContent?.split('\n').find(line => /link "Accept QA rules"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(ref, 'The actual Agent must read the current rules document.');
  assert.deepEqual(requests.map(row => row.method), ['GET'], 'Reading HTML must not perform a session-mutating MIME probe.');
  const action = await worker.evaluate(({ tabId, ref }) => mimeFixtureAgent.executeTool(tabId, 'click_ax', { ref_id: ref }), { tabId, ref });
  assert.equal(action.success, true);
  await page.locator('input[name="username"]').waitFor({ timeout: 5000 });
  assert.equal(new URL(page.url()).origin, origin);
  assert.equal(accepted, 1);
  assert.equal(blockedMutations, 0);
  assert.deepEqual(requests, [
    { method: 'GET', path: '/rules', queryKeys: [] },
    { method: 'GET', path: '/rules', queryKeys: ['accept'] },
  ]);
  console.log(JSON.stringify({ passed: true, installedMV3: true, accepted, submitted: 0, requests }));
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-mime-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
