import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('.');
const output = process.env.SAFESOCIAL_UI_OUTPUT || '/tmp/webbrain-safesocial-review';
await mkdir(output, { recursive: true });
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/fixture') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body><main><article><img id="media" width="300" height="300" src="https://scontent.cdninstagram.com/fixture.png"></article></main></body></html>'); return; }
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + '/')) throw Error('outside root');
    res.setHeader('Content-Type', mime[extname(file)] || 'text/plain'); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    const browser = await engine.launch();
    try {
      for (const lang of ['en', 'tr']) for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(({ build, lang }) => {
          localStorage.setItem('wbLocale', lang);
          const data = { wbLocale: lang }; const listeners = [];
          window.testRequests = []; window.testStore = data;
          const storage = {
            async get(keys) { return keys == null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys)).map(k => [k, data[k]])); },
            async set(values) { Object.assign(data, values); listeners.forEach(fn => fn(Object.fromEntries(Object.entries(values).map(([k,v]) => [k, { newValue: v }])), 'local')); },
            async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
          };
          window.chrome = window.browser = {
            storage: { local: storage, onChanged: { addListener: fn => listeners.push(fn) } },
            runtime: { getURL: path => `${location.origin}/src/${build}/${path}`, getManifest: () => ({ version: '36.7.5' }), onMessage: { addListener() {} }, sendMessage(msg, callback) {
              testRequests.push(msg);
              const result = msg.action === 'get_providers' ? { providers: {}, active: '' }
                : msg.target === 'safesocial' ? { ok: !window.failModel, status: 'ready', error: window.failModel ? 'Synthetic download failure' : '' } : {};
              callback?.(result); return Promise.resolve(result);
            } }, commands: { getAll: async () => [] }, tabs: { create: async () => ({}) },
          };
        }, { build, lang });
        await page.goto(`${origin}/src/${build}/src/ui/settings.html#multimodal`);
        await page.waitForFunction(() => document.querySelector('#safesocial-status')?.textContent.length > 0);
        const card = page.locator('#safesocial-card');
        assert.equal(await page.locator('#safesocial-heading').textContent(), lang === 'tr'
          ? 'SafeSocial · Görsel sınıflandırıcı' : 'SafeSocial · Image classifier');
        assert.equal(await card.evaluate(el => el.textContent.includes('st.safesocial.')), false, 'all copy resolves');
        await card.scrollIntoViewIfNeeded();
        assert.equal(await page.locator('#safesocial-enabled').isChecked(), false);
        assert.equal(await page.evaluate(() => testRequests.filter(x => x.target === 'safesocial').length), 0, 'opening disabled settings does no work');
        assert.equal(await card.locator('input[type=checkbox]:checked').count(), 3);
        await page.locator('#safesocial-enabled').locator('..').click();
        await page.waitForFunction(() => testStore.safeSocialSettings?.enabled && testRequests.some(x => x.command === 'prepare'));
        assert.equal(await page.locator('#safesocial-remove').isDisabled(), true);
        await page.locator('#safesocial-action').selectOption('hide');
        await page.locator('input[name=body_beauty_comparison]').check();
        await page.waitForFunction(() => testStore.safeSocialSettings.action === 'hide' && testStore.safeSocialSettings.labels.body_beauty_comparison);
        await page.locator('#safesocial-threshold').fill('80');
        await page.locator('#safesocial-threshold').dispatchEvent('change');
        await page.waitForFunction(() => testStore.safeSocialSettings.threshold === .8);
        await page.evaluate(() => { window.failModel = true; });
        await page.locator('#safesocial-retry').click();
        await page.waitForFunction(() => document.querySelector('#safesocial-status').textContent.includes('Synthetic download failure'));
        await page.locator('#safesocial-enabled').locator('..').click();
        await page.waitForFunction(() => !testStore.safeSocialSettings.enabled);
        await page.evaluate(() => { window.failModel = false; });
        await page.locator('#safesocial-remove').click();
        assert.equal(await page.evaluate(() => testRequests.at(-1).command), 'remove');
        await page.locator('#safesocial-heading').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${build}-${lang}-${width}.png` });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
        await page.close();
      }
      const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
      await page.route('https://scontent.cdninstagram.com/**', route => route.fulfill({ path: resolve('src/chrome/icons/icon128.png'), contentType: 'image/png' }));
      await page.goto(`${origin}/fixture`);
      await page.addStyleTag({ path: `src/${build}/src/safesocial/content.css` });
      await page.evaluate(() => {
        let settings = {}; const listeners = [];
        window.calls = []; window.classifyWait = null; window.failClassification = false;
        const storage = {
          get: async () => ({ safeSocialSettings: settings }),
          set: async patch => { settings = patch.safeSocialSettings; listeners.forEach(fn => fn({ safeSocialSettings: { newValue: settings } }, 'local')); },
        };
        window.chrome = window.browser = { storage: { local: storage, onChanged: { addListener: fn => listeners.push(fn) } }, runtime: {
          async sendMessage(message) {
            calls.push(message);
            if (window.classifyWait) await window.classifyWait;
            return window.failClassification ? { ok: false, error: 'unavailable' } : { ok: true, labels: ['luxury_status'], action: settings.action || 'blur' };
          },
        } };
      });
      await page.addScriptTag({ path: `src/${build}/src/safesocial/content.js` });
      assert.equal(await page.evaluate(() => calls.length), 0);
      await page.evaluate(() => chrome.storage.local.set({ safeSocialSettings: { enabled: true } }));
      await page.waitForSelector('.wb-safesocial-blur');
      await page.locator('.wb-safesocial-overlay button').click();
      assert.equal(await page.locator('.wb-safesocial-blur').count(), 0);
      await page.evaluate(() => { document.querySelector('#media').src = 'https://scontent.cdninstagram.com/second.png'; });
      await page.waitForSelector('.wb-safesocial-blur');
      await page.evaluate(() => chrome.storage.local.set({ safeSocialSettings: { enabled: false } }));
      assert.equal(await page.locator('.wb-safesocial-overlay').count(), 0);
      assert.equal(await page.locator('#media').evaluate(e => getComputedStyle(e).filter), 'none');
      // A result delivered after opt-out must never touch the page.
      await page.evaluate(() => {
        window.classifyWait = new Promise(resolve => { window.finishClassification = resolve; });
        return chrome.storage.local.set({ safeSocialSettings: { enabled: true } });
      });
      await page.waitForFunction(() => calls.length >= 3);
      await page.evaluate(() => chrome.storage.local.set({ safeSocialSettings: { enabled: false } }));
      await page.evaluate(() => { finishClassification(); window.classifyWait = null; });
      await page.waitForTimeout(250);
      assert.equal(await page.locator('.wb-safesocial-blur').count(), 0);
      await page.evaluate(() => { window.failClassification = true; return chrome.storage.local.set({ safeSocialSettings: { enabled: true } }); });
      await page.waitForSelector('.wb-safesocial-notice');
      assert.equal(await page.locator('.wb-safesocial-blur').count(), 0, 'no mock classifications on failure');
      await page.evaluate(() => chrome.storage.local.set({ safeSocialSettings: { enabled: false } }));
      assert.equal(await page.locator('.wb-safesocial-notice').count(), 0);
      await page.close();
      console.log(`${build}: responsive EN/TR settings and feed lifecycle passed`);

      if (process.env.SAFESOCIAL_MODEL_DIR) {
        const modelPage = await browser.newPage();
        await modelPage.route('https://huggingface.co/**', async route => {
          const name = new URL(route.request().url()).pathname.split('/').at(-1);
          const file = name === 'model.onnx' ? 'webbrain-safesocial-model.onnx' : 'webbrain-safesocial-model.json';
          await route.fulfill({ path: resolve(process.env.SAFESOCIAL_MODEL_DIR, file), headers: { 'Access-Control-Allow-Origin': '*' } });
        });
        await modelPage.route('https://scontent.cdninstagram.com/**', route => route.fulfill({ path: resolve('src/chrome/icons/icon128.png'), contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
        await modelPage.goto(`${origin}/fixture`);
        const actual = await modelPage.evaluate(async ({ build }) => {
          const { createSafeSocialHost } = await import(`/src/${build}/src/safesocial/host.js`);
          const host = createSafeSocialHost();
          await host.handle('prepare');
          const status = await host.handle('status');
          const result = await host.handle('classify', { url: 'https://scontent.cdninstagram.com/fixture.png' });
          await host.handle('stop');
          const { CACHE_NAME, MODEL_BASE } = await import(`/src/${build}/src/safesocial/config.js`);
          const cache = await caches.open(CACHE_NAME);
          await cache.put(MODEL_BASE + 'model.onnx', new Response(new Uint8Array([1, 2, 3])));
          let verificationError;
          try { await host.handle('prepare'); } catch (error) { verificationError = error.message; }
          await host.handle('prepare');
          await host.handle('stop');
          return { status, result, verificationError };
        }, { build });
        assert.equal(actual.status.status, 'ready');
        assert.equal(Object.keys(actual.result.scores).length, 10);
        assert.ok(Object.values(actual.result.scores).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
        assert.match(actual.verificationError, /verification failed/, 'corrupt cached weights cannot run and a retry recovers');
        console.log(`${build}: actual pinned ONNX/WASM inference passed (10 finite scores)`);
        await modelPage.close();
      }
    } finally { await browser.close(); }
  }
} finally { server.close(); }
