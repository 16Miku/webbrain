// Providers → Decision with D1 selected: one button downloads what is
// missing and loads, and reads "Load" once the package is cached; Unload is
// short. Firefox runs only where its Playwright browser is installed.
import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const root = resolve('.');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const server = createServer(async (req, res) => {
  try {
    const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + sep)) throw Error();
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'text/plain');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: D1 has one Download and load button that reads Load once cached`, async t => {
    let browser;
    try { browser = await engine.launch(); } catch (error) { t.skip(`${build} browser unavailable: ${error.message.split('\n')[0]}`); return; }
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ build, version }) => {
        localStorage.setItem('wbLocale', 'en');
        const data = { wbLocale: 'en', decisionMode: 'on', systemOneEnabled: true, decisionProvider: 'webgpu_d1', d1WebgpuConsentVersion: 1 };
        window.testRequests = []; window.d1Status = 'idle';
        const storage = {
          async get(keys) { return keys == null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys)).map(k => [k, data[k]])); },
          async set(values) { Object.assign(data, values); },
          async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
        };
        window.chrome = window.browser = {
          storage: { local: storage, onChanged: { addListener() {} } },
          runtime: { getURL: path => `${location.origin}/src/${build}/${path}`, getManifest: () => ({ version }), onMessage: { addListener() {} }, sendMessage(msg, callback) {
            window.testRequests.push(msg);
            const result = msg.action === 'd1_control'
              ? { success: true, result: msg.command === 'status' ? { status: window.d1Status, ready: window.d1Status === 'ready', loaded: window.d1Status === 'ready', cached: window.d1Cached === true } : { started: true } }
              : msg.action === 'get_providers' ? { providers: {}, active: '' } : { success: true };
            callback?.(result); return Promise.resolve(result);
          } },
          commands: { getAll: async () => [] }, tabs: { create: async () => ({}) },
        };
      }, { build, version });
      await page.goto(`${origin}/src/${build}/src/ui/providers.html#decision`);
      await page.waitForFunction(() => !document.querySelector('#d1-controls')?.hidden);
      const commands = await page.locator('#d1-controls button[data-d1-command]').evaluateAll(buttons => buttons.map(button => button.dataset.d1Command));
      assert.deepEqual(commands, ['download', 'stop', 'reset', 'clear'], 'Download and Load share one button');
      assert.equal(await page.locator('#d1-controls button[data-d1-command="reset"]').textContent(), 'Unload');
      const load = page.locator('#d1-load');
      await page.waitForFunction(() => document.querySelector('#d1-load').textContent === 'Download and load');
      assert.equal(await load.getAttribute('data-d1-command'), 'download');
      // Once the package is cached, the same button only loads it.
      await page.evaluate(() => { window.d1Status = 'cached'; });
      await page.waitForFunction(() => document.querySelector('#d1-load').textContent === 'Load', null, { timeout: 5000 });
      assert.equal(await load.getAttribute('data-d1-command'), 'load');
      // A transient load error keeps the cache: retrying still only loads.
      await page.evaluate(() => { window.d1Status = 'error'; window.d1Cached = true; });
      await page.waitForFunction(() => document.querySelector('#d1-status').textContent.startsWith('error'), null, { timeout: 5000 });
      assert.equal(await load.getAttribute('data-d1-command'), 'load', 'a cached model with an error retries with Load');
      await page.evaluate(() => { window.d1Cached = false; });
      await page.waitForFunction(() => document.querySelector('#d1-load').dataset.d1Command === 'download', null, { timeout: 5000 });
      await page.evaluate(() => { window.d1Status = 'cached'; window.d1Cached = false; });
      await page.waitForFunction(() => document.querySelector('#d1-load').textContent === 'Load', null, { timeout: 5000 });
      await page.locator('#d1-consent').check();
      await load.click();
      await page.waitForFunction(() => window.testRequests.some(msg => msg.action === 'd1_control' && msg.command === 'load'));
      const sent = await page.evaluate(() => window.testRequests.find(msg => msg.action === 'd1_control' && msg.command === 'load'));
      assert.equal(sent.consent, true); assert.equal(sent.consentVersion, 1);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

test.after(() => server.close());
