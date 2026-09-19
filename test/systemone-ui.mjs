import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('.');
const server = createServer(async (req, res) => {
  try { const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname); if (!file.startsWith(root + '/')) throw Error();
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'text/plain'); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = process.env.JEV_UI_OUTPUT || '/tmp/jev-ui-review'; await mkdir(output, { recursive: true });
try {
  for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    const browser = await engine.launch();
    try {
      for (const lang of ['en', 'tr']) for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ lang, build }) => {
          localStorage.setItem('wbLocale', lang);
          const data = { wbLocale: lang, typesafeApiKey: '', systemOneEnabled: false, systemOneWatchEnabled: true, systemOneCompletionEnabled: true };
          window.testStore = data; window.testRequests = [];
          const listeners = [];
          const storage = {
            async get(keys) { return keys == null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys)).map(k => [k, data[k]])); },
            async set(values) { Object.assign(data, values); listeners.forEach(fn => fn(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }])), 'local')); },
            async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
          };
          window.chrome = window.browser = {
            storage: { local: storage, onChanged: { addListener: fn => listeners.push(fn) } },
            runtime: { getURL: path => `${location.origin}/src/${build}/${path}`, getManifest: () => ({ version: 'test' }), onMessage: { addListener() {} }, sendMessage(msg, callback) {
              window.testRequests.push(msg);
              const result = msg.action === 'get_providers' ? { providers: {}, active: null } : msg.action === 'test_system_one' ? { success: true, model: 'jev-1.13.0' } : {};
              callback?.(result); return Promise.resolve(result);
            } },
            commands: { getAll: async () => [] }, tabs: { create: async () => ({}) },
          };
        }, { lang, build });
        await page.goto(`${origin}/src/${build}/src/ui/settings.html`);
        await page.locator('[data-tab="providers"]').click();
        await page.waitForFunction(() => document.querySelector('#system-one-card h3')?.textContent === 'Jev (TypeSafe)');
        assert.equal(await page.locator('#providers #system-one-card').count(), 0);
        assert.equal(await page.evaluate(() => testRequests.filter(r => r.action === 'test_system_one').length), 0);
        await page.locator('#system-one-api-key').fill('synthetic-test-key');
        await page.locator('#btn-save-system-one').click();
        await page.waitForFunction(() => testStore.typesafeApiKey === 'synthetic-test-key');
        assert.equal(await page.evaluate(() => testStore.systemOneWatchEnabled), true);
        await page.locator('#btn-test-system-one').click();
        await page.waitForFunction(() => testRequests.filter(r => r.action === 'test_system_one').length === 1);
        await page.locator('#system-one-card details').evaluate(el => { el.open = true; });
        await page.screenshot({ path: `${output}/${build}-${lang}-${width}.png`, fullPage: true });
        await page.locator('#btn-clear-system-one').click();
        assert.equal(await page.locator('#range-system-one-watch-threshold').inputValue(), '70');
        assert.equal(await page.locator('#toggle-system-one-watch').isChecked(), false);
        assert.equal(await page.evaluate(() => testStore.typesafeApiKey), undefined);
        assert.deepEqual(errors, []);
        await page.close(); console.log(`${build} ${lang} ${width}: settings save/test/clear passed`);
      }
    } finally { await browser.close(); }
  }
} finally { server.close(); }
