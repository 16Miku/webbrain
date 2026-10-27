import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Chrome has no DNS API for extensions, so fetch_url, read_page_source and
// research_url rely on webRequest reporting details.ip for the extension's
// own service-worker fetch and its hidden tab. This runs the real Chrome
// network tools in a disposable browser whose resolver maps a public-looking
// name onto this loopback server, the DNS answer the URL text cannot reveal.
const root = path.resolve(process.env.WEBBRAIN_TEST_ROOT || '.');
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-resolved-address-'));
const extension = path.join(out, 'extension');
const profile = path.join(out, 'profile');
const copied = new Set();
async function copy(relative) {
  if (copied.has(relative)) return;
  copied.add(relative);
  const bytes = await fs.readFile(path.join(root, 'src/chrome', relative));
  const dest = path.join(extension, relative);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
  for (const m of bytes.toString().matchAll(/^import\s+(?:[\s\S]*?)\sfrom\s+['"]([^'"]+)['"];?/gm)) {
    await copy(path.posix.normalize(path.posix.join(path.posix.dirname(relative), m[1])));
  }
}
await copy('src/network/network-tools.js');
await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Resolved address fixture', version: '1.0',
  permissions: ['storage', 'tabs', 'scripting', 'webRequest'], host_permissions: ['<all_urls>'],
  background: { service_worker: 'src/background.js', type: 'module' },
}));
await fs.writeFile(path.join(extension, 'src/background.js'),
  "import * as network from './network/network-tools.js'; globalThis.network = network;");

const secret = 'LOOPBACK-ADMIN-SECRET';
const hits = [];
let port;
const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: `http://public.rebind.test:${port}/admin` });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>Admin</title><main>${secret}</main>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
port = server.address().port;

let browser;
let chrome;
const rows = [];
try {
  chrome = spawn(chromium.executablePath(), [
    '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--no-proxy-server', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    '--host-resolver-rules=MAP public.rebind.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let endpoint;
  for (let n = 0; n < 100 && !endpoint; n++) {
    try {
      const [p, u] = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      endpoint = `ws://127.0.0.1:${p}${u}`;
    } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(endpoint, 'disposable browser endpoint');
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const worker = context.serviceWorkers().find(w => w.url().endsWith('/src/background.js'))
    || await context.waitForEvent('serviceworker', { predicate: w => w.url().endsWith('/src/background.js') });
  for (let n = 0; n < 100 && !(await worker.evaluate(() => Boolean(globalThis.network))); n++) {
    await new Promise(r => setTimeout(r, 100));
  }

  const admin = `http://public.rebind.test:${port}/admin`;
  const run = (tool, url) => worker.evaluate(({ tool, url }) => (
    tool === 'fetch_url' ? network.fetchUrl(url)
      : tool === 'read_page_source' ? network.readPageSource(url)
        : network.researchUrl(url, { timeout: 10000 })
  ), { tool, url });
  const openTabs = () => worker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.length));
  const tabsBefore = await openTabs();

  for (const [tool, url] of [
    ['fetch_url', admin],
    ['read_page_source', admin],
    ['research_url', admin],
    ['research_url', `http://public.rebind.test:${port}/redirect`],
  ]) {
    const before = hits.length;
    const result = await run(tool, url);
    rows.push({ tool, url, allowLocalNetwork: false, success: result.success, error: result.error, requests: hits.slice(before) });
    assert.equal(result.success, false, `${tool} ${url}: a name resolving to loopback must be blocked`);
    assert.match(result.error, /^public\.rebind\.test resolved to a blocked address\. Blocked loopback IPv4: 127\.0\.0\.1/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret), `${tool}: loopback content must not be returned`);
  }
  assert.equal(await openTabs(), tabsBefore, 'research_url must close its hidden tab');

  // The user's local-network opt-in relaxes the resolved address as it does
  // a loopback literal.
  await worker.evaluate(() => chrome.storage.local.set({ agentAllowLocalNetwork: true }));
  for (let n = 0; n < 50 && !(await worker.evaluate(() => network.getAllowLocalNetwork())); n++) {
    await new Promise(r => setTimeout(r, 50));
  }
  for (const tool of ['fetch_url', 'read_page_source', 'research_url']) {
    const result = await run(tool, admin);
    rows.push({ tool, url: admin, allowLocalNetwork: true, success: result.success, error: result.error });
    assert.equal(result.success, true, `${tool}: local-network access should permit loopback (${result.error || ''})`);
    assert.match(JSON.stringify(result), new RegExp(secret), `${tool}: permitted content should be returned`);
  }
  console.log(JSON.stringify({ passed: true, chrome: browser.version(), rows }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ passed: false, error: String(error.stack || error), rows }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (chrome && !chrome.killed) chrome.kill();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
