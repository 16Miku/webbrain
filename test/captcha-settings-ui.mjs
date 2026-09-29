import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('.');
const output = process.env.CAPTCHA_UI_OUTPUT || '/tmp/webbrain-captcha-review';
await mkdir(output, { recursive: true });
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + '/')) throw Error('outside root');
    res.setHeader('Content-Type', mime[extname(file)] || 'text/plain'); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    if (process.env.CAPTCHA_UI_BROWSER && process.env.CAPTCHA_UI_BROWSER !== build) continue;
    const browser = await engine.launch();
    try {
      for (const lang of ['en', 'tr', 'de', 'zh', 'ar']) for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        page.setDefaultTimeout(10_000);
        await page.addInitScript(({ build, lang }) => {
          localStorage.setItem('wbLocale', lang);
          const data = JSON.parse(sessionStorage.getItem('captchaTestStore') || '{}'); data.wbLocale = lang; const listeners = [];
          window.testRequests = []; window.testStore = data;
          const storage = {
            async get(keys) { return keys == null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys)).map(k => [k, data[k]])); },
            async set(values) { Object.assign(data, values); sessionStorage.setItem('captchaTestStore', JSON.stringify(data)); listeners.forEach(fn => fn(Object.fromEntries(Object.entries(values).map(([k,v]) => [k, { newValue: v }])), 'local')); },
            async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; sessionStorage.setItem('captchaTestStore', JSON.stringify(data)); },
          };
          window.chrome = window.browser = {
            storage: { local: storage, onChanged: { addListener: fn => listeners.push(fn) } },
            runtime: { getURL: path => `${location.origin}/src/${build}/${path}`, getManifest: () => ({ version: '36.7.5' }), onMessage: { addListener() {} }, sendMessage(msg, callback) {
              testRequests.push(msg);
              const result = msg.action === 'get_providers' ? { providers: {}, active: '' }
                : msg.action === 'test_captcha_provider_balance' || msg.action === 'test_two_captcha_balance' || msg.action === 'test_capsolver_balance' ? { ok: !window.failBalance, balance: 2.5, error: window.failBalance ? 'Synthetic balance failure' : undefined }
                : {};
              callback?.(result); return Promise.resolve(result);
            } }, commands: { getAll: async () => [] }, tabs: { create: async () => ({}) },
          };
        }, { build, lang });

        const openSettings = async () => {
          await page.goto(`${origin}/src/${build}/src/ui/settings.html#display`);
          await page.reload();
          await page.waitForFunction(() => testRequests.some(r => r.action === 'get_providers'));
          await page.locator('details.advanced-settings').first().locator(':scope > summary').click();
        };
        await openSettings();
        const card = page.locator('#captcha-card');
        await card.scrollIntoViewIfNeeded();
        assert.equal(await card.locator('section').count(), 5);
        assert.equal(await card.evaluate(el => el.textContent.includes('st.captcha.') || el.textContent.includes('{provider}')), false);
        assert.equal(await card.locator('.captcha-advanced[open]').count(), 0);
        for (const [id, defaultWeight] of [['captcha', 100], ['two-captcha', 99], ['capmonster', 98], ['solve-captcha', 97], ['anti-captcha', 96]]) {
          assert.equal(await page.locator(`#${id}-weight`).isVisible(), false);
          assert.equal(await page.locator(`#${id}-weight`).locator('xpath=ancestor::details[1]/summary').evaluate(el => getComputedStyle(el, '::after').content), '"+"');
          assert.equal(await page.locator(`#${id}-weight`).inputValue(), String(defaultWeight));
        }
        assert.equal(await page.evaluate(() => testStore.twoCaptchaEnabled), undefined);
        await card.screenshot({ path: `${output}/${build}-${lang}-${width}.png`, style: '.tabs { visibility: hidden; }' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.locator('#two-captcha-api-key').fill('invalid');
        await page.locator('#btn-save-two-captcha').click();
        assert.equal(await page.evaluate(() => testStore.twoCaptchaEnabled), undefined);
        assert.ok(await page.locator('#test-two-captcha').evaluate(el => el.classList.contains('fail')));
        const key = '0123456789abcdef0123456789abcdef';
        await page.locator('#two-captcha-api-key').fill(key);
        await page.locator('#btn-test-two-captcha').click();
        await page.waitForFunction(() => document.querySelector('#test-two-captcha').textContent.includes('2.5000'));
        assert.equal(await page.evaluate(() => testStore.twoCaptchaEnabled), undefined, 'balance check is not consent');
        assert.equal(await page.locator('#two-captcha-enabled').isChecked(), true);
        await page.locator('#two-captcha-enabled').uncheck();
        await page.locator('#btn-save-two-captcha').click();
        assert.equal(await page.evaluate(() => testStore.twoCaptchaEnabled), false, 'save respects an explicit opt-out');
        assert.equal(await page.evaluate(() => testStore.twoCaptchaApiKey), key);
        await page.locator('#two-captcha-enabled').check();
        assert.equal(await page.evaluate(() => testStore.twoCaptchaEnabled), true);
        assert.equal(await page.evaluate(() => testStore.captchaSolverEnabled), undefined);
        await page.locator('#captcha-api-key').fill('CAP-0123456789abcdefghij');
        await page.locator('#btn-save-captcha').click();
        assert.equal(await page.evaluate(() => testStore.captchaSolverEnabled), true);
        assert.equal(await page.evaluate(() => testStore.twoCaptchaEnabled), true);
        await page.locator('#btn-clear-captcha').click();
        assert.equal(await page.evaluate(() => testStore.captchaSolverEnabled), undefined);
        assert.equal(await page.evaluate(() => testStore.twoCaptchaEnabled), true);
        await openSettings();
        assert.equal(await page.locator('#two-captcha-api-key').inputValue(), key);
        assert.equal(await page.locator('#captcha-api-key').inputValue(), '');
        await page.evaluate(() => { window.failBalance = true; });
        await page.locator('#btn-test-two-captcha').click();
        await page.waitForFunction(() => document.querySelector('#test-two-captcha').textContent.includes('Synthetic balance failure'));
        await page.locator('#btn-clear-two-captcha').click();
        assert.equal(await page.evaluate(() => testStore.twoCaptchaEnabled), undefined);
        assert.equal(await page.evaluate(() => testStore.twoCaptchaApiKey), undefined);
        for (const [id, keyName, enabledName, weightName] of [
          ['capmonster', 'capmonsterApiKey', 'capmonsterEnabled', 'capmonsterWeight'],
          ['solve-captcha', 'solveCaptchaApiKey', 'solveCaptchaEnabled', 'solveCaptchaWeight'],
          ['anti-captcha', 'antiCaptchaApiKey', 'antiCaptchaEnabled', 'antiCaptchaWeight'],
        ]) {
          await page.locator(`#${id}-api-key`).fill(key);
          assert.equal(await page.locator(`#${id}-enabled`).isChecked(), true);
          await page.locator(`#btn-save-${id}`).click();
          assert.equal(await page.evaluate(name => testStore[name], enabledName), true);
          await page.locator(`#${id}-enabled`).uncheck();
          await page.locator(`#${id}-api-key`).fill('f'.repeat(32));
          assert.equal(await page.locator(`#${id}-enabled`).isChecked(), false, 'manual opt-out survives further typing');
          await page.locator(`#btn-save-${id}`).click();
          assert.equal(await page.evaluate(name => testStore[name], enabledName), false);
          await page.locator(`#${id}-weight`).locator('xpath=ancestor::details[1]/summary').click();
          await page.locator(`#${id}-weight`).fill('110');
          await page.locator(`#${id}-weight`).blur();
          await page.waitForFunction(name => testStore[name] === 110, weightName);
          await openSettings();
          assert.equal(await page.locator(`#${id}-enabled`).isChecked(), false);
          assert.equal(await page.locator(`#${id}-api-key`).inputValue(), 'f'.repeat(32));
          assert.equal(await page.locator(`#${id}-weight`).inputValue(), '110');
          assert.equal(await page.locator(`#${id}-weight`).isVisible(), false);
          await page.locator(`#${id}-enabled`).check();
          await page.locator(`#btn-test-${id}`).click();
          await page.waitForFunction(dom => document.querySelector(`#test-${dom}`).textContent.includes('2.5000'), id);
          assert.equal(await page.evaluate(name => testStore[name], enabledName), true);
        }
        await page.evaluate(() => chrome.storage.local.set({ webbrainCloudManaged: true }));
        await openSettings();
        assert.equal(await card.isVisible(), false, 'managed settings keep broker-only UI');
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${build} ${lang} ${width}: settings, validation, independent consent, persistence, balance, and managed mode`);
      }
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
