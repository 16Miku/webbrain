// Settings is split across settings.html (General, Budgets, Memory, Skills,
// CAPTCHA, Bridge, Advanced), providers.html (LLM and the assistive models)
// and permissions.html. This drives all three pages in both builds with a
// stubbed extension API: tab layout, deep links from the old tabs, the
// cross-tab search, the single Record traces switch and the moved controls.
import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.');
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(root, '.' + decodeURIComponent(path));
    if (!file.startsWith(root + sep)) throw Error('outside root');
    res.setHeader('Content-Type', mime[extname(file)] || 'text/plain');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const SETTINGS_TABS = ['display', 'budgets', 'memory', 'skills', 'captcha', 'cloudbridge', 'advanced'];
const PROVIDER_TABS = ['llm', 'vision', 'speech', 'generative', 'decision', 'safesocial'];
const BUDGET_CONTROLS = [
  'input-cost-session-limit', 'input-cost-total-limit', 'range-clarify-timeout', 'select-clarify-timeout-policy',
  'range-max-steps', 'range-request-timeout', 'select-image-detail', 'select-max-screenshots', 'select-max-image-dimension',
];

function stub({ build, lang, seed }) {
  localStorage.setItem('wbLocale', lang);
  const key = 'settings-pages-store';
  const data = JSON.parse(sessionStorage.getItem(key) || 'null') || { wbLocale: lang, ...seed };
  const listeners = [];
  const save = () => sessionStorage.setItem(key, JSON.stringify(data));
  save();
  window.testStore = data;
  window.testRequests = [];
  const pick = keys => keys == null ? { ...data }
    : Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys))
      .map(k => [k, data[k] ?? (keys && typeof keys === 'object' && !Array.isArray(keys) ? keys[k] : undefined)]));
  const storage = {
    async get(keys) { return structuredClone(pick(keys)); },
    async set(values) {
      const changes = {};
      for (const [k, v] of Object.entries(values)) { changes[k] = { oldValue: data[k], newValue: v }; data[k] = structuredClone(v); }
      save();
      listeners.forEach(fn => fn(changes, 'local'));
    },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; save(); },
  };
  let managerPromise;
  const reply = async msg => {
    window.testRequests.push(msg);
    if (msg.action === 'get_providers') {
      managerPromise ||= import(`/src/${build}/src/providers/manager.js`).then(async ({ ProviderManager }) => {
        const manager = new ProviderManager();
        if (!data.providers) {
          const defaults = manager._defaultConfigs();
          data.providers = { llamacpp: { ...defaults.llamacpp, configured: true, model: 'qwen' } };
          data.activeProvider = 'llamacpp';
          save();
        }
        await manager.load();
        return manager;
      });
      const manager = await managerPromise;
      return { providers: manager.getAll(), active: manager.activeProviderId };
    }
    if (msg.action === 'get_user_memory') return { ok: true, enabled: true, records: [] };
    if (msg.action === 'get_webgpu_vision_choice') return { ok: true, choice: 'auto', bonsaiReady: false };
    return {};
  };
  window.chrome = window.browser = {
    storage: { local: storage, onChanged: { addListener: fn => listeners.push(fn) } },
    runtime: {
      id: 'settings-pages-test',
      getURL: path => `${location.origin}/src/${build}/${path}`,
      getManifest: () => ({ version: '42.0.6' }),
      getPlatformInfo: async () => ({ os: 'test', arch: 'x64' }),
      onMessage: { addListener() {} },
      sendMessage(msg, callback) {
        const pending = reply(msg).catch(error => ({ error: error.message }));
        pending.then(result => callback?.(result));
        return pending;
      },
    },
    commands: { getAll: async () => [] },
    tabs: { create: async () => ({}) },
  };
}

async function open(browser, build, path, { lang = 'en', seed = {}, width = 1280 } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await page.addInitScript(stub, { build, lang, seed });
  await page.goto(`${origin}/src/${build}/src/ui/${path}`);
  return { page, errors };
}

const tabsOf = page => page.locator('.tab-btn').evaluateAll(buttons => buttons.map(b => b.dataset.tab));
const activeTab = page => page.locator('.tab-btn.active').getAttribute('data-tab');
const store = (page, key) => page.evaluate(k => window.testStore[k], key);
const visible = (page, selector) => page.locator(selector).isVisible();
// Keys that resolved to nothing: i18n.js renders a missing key as the key itself.
const untranslated = page => page.evaluate(() => {
  const missing = [];
  for (const [attribute, read] of [
    ['i18n', el => el.textContent], ['i18nHtml', el => el.innerHTML], ['i18nTitle', el => el.title],
    ['i18nPlaceholder', el => el.placeholder], ['i18nAriaLabel', el => el.getAttribute('aria-label')],
  ]) {
    const selector = `[data-${attribute.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}]`;
    for (const el of document.querySelectorAll(selector)) {
      if ((read(el) || '').trim() === el.dataset[attribute]) missing.push(el.dataset[attribute]);
    }
  }
  return missing;
});

try {
  for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    if (process.env.SETTINGS_PAGES_BROWSER && process.env.SETTINGS_PAGES_BROWSER !== build) continue;
    const browser = await engine.launch();
    try {
      // --- settings.html: tabs, moved controls, defaults ---
      for (const lang of ['en', 'tr', 'ar']) {
        const { page, errors } = await open(browser, build, 'settings.html', { lang });
        await page.waitForFunction(() => document.getElementById('select-auto-screenshot')?.value === 'navigation');
        assert.deepEqual(await tabsOf(page), SETTINGS_TABS, `${build} ${lang}: settings tabs`);
        assert.equal(await activeTab(page), 'display', `${build} ${lang}: Settings opens on General`);
        for (const label of await page.locator('.tab-btn').allTextContents()) {
          assert.ok(label.trim() && !/^st\./.test(label.trim()), `${build} ${lang}: untranslated tab label ${label}`);
        }
        assert.equal(await page.locator('#select-language, #settings-ui-scale-value, #toggle-lossless-tracing, [data-tab="providers"], [data-tab="multimodal"], [data-tab="permissions"]').count(), 0,
          `${build} ${lang}: removed controls and tabs are gone`);
        assert.ok(await page.locator('#providers-page-link').getAttribute('href') === 'providers.html', `${build} ${lang}: header links to Providers`);
        assert.deepEqual(await untranslated(page), [], `${build} ${lang}: every settings.html string resolves`);
        assert.deepEqual(errors, [], `${build} ${lang}: settings.html page errors`);
        await page.close();
      }

      const { page, errors } = await open(browser, build, 'settings.html');
      await page.waitForFunction(() => document.getElementById('select-auto-screenshot')?.value === 'navigation');
      assert.deepEqual(
        await page.locator('[data-panel="budgets"] [id]').evaluateAll((els, ids) => els.map(el => el.id).filter(id => ids.includes(id)), BUDGET_CONTROLS),
        BUDGET_CONTROLS, `${build}: Budgets holds the moved limits in order`);
      for (const id of ['toggle-tracing', 'toggle-screenshot-redaction', 'toggle-help-improve', 'select-lean-mode', 'toggle-strict-secret']) {
        assert.equal(await page.locator(`[data-panel="advanced"] #${id}`).count(), 1, `${build}: Advanced has #${id}`);
      }
      assert.equal(await page.locator('[data-panel="captcha"] #captcha-card').count(), 1, `${build}: CAPTCHA has its own tab`);
      assert.equal(await page.locator('[data-panel="display"] #select-auto-screenshot').count(), 1, `${build}: Auto-screenshot stays in General`);
      assert.equal(await page.locator('details.advanced-settings > summary[data-i18n="st.display.advanced"]').count(), 0, `${build}: General has no Advanced drawer`);
      if (build === 'firefox') assert.equal(await page.locator('[data-panel="advanced"] #firefox-bidi-card').count(), 1, 'firefox: BiDi card stays in Advanced');

      // One switch records traces with full request details, or neither.
      await page.locator('[data-tab="advanced"]').click();
      await page.locator('#toggle-tracing').locator('..').click();
      assert.equal(await store(page, 'tracingEnabled'), true, `${build}: Record traces on`);
      assert.equal(await store(page, 'losslessTrace'), true, `${build}: full details follow Record traces`);
      await page.locator('#toggle-tracing').locator('..').click();
      assert.equal(await store(page, 'tracingEnabled'), false, `${build}: Record traces off`);
      assert.equal(await store(page, 'losslessTrace'), false, `${build}: full details off with Record traces`);
      await page.locator('#toggle-screenshot-redaction').locator('..').click();
      assert.equal(await store(page, 'screenshotRedaction'), true, `${build}: redaction toggle saves from Advanced`);

      // The search covers General, Budgets, CAPTCHA and Advanced at once.
      await page.locator('[data-tab="display"]').click();
      await page.locator('#input-general-search').fill('timeout');
      assert.ok(await page.evaluate(() => document.body.classList.contains('settings-searching')), `${build}: search mode`);
      for (const id of ['range-clarify-timeout', 'select-clarify-timeout-policy', 'range-request-timeout']) {
        assert.ok(await visible(page, `#${id}`), `${build}: search shows #${id} from Budgets`);
      }
      assert.equal(await visible(page, '#select-theme'), false, `${build}: search hides non-matching General rows`);
      assert.equal(await visible(page, '[data-panel="memory"]'), false, `${build}: search leaves Memory out`);
      assert.ok(await visible(page, '[data-panel="budgets"] .search-panel-heading'), `${build}: matches sit under their tab name`);
      await page.locator('#input-general-search').fill('redact');
      assert.ok(await visible(page, '#screenshot-redaction-setting'), `${build}: search finds Advanced settings`);
      assert.equal(await visible(page, '[data-panel="budgets"]'), false, `${build}: a tab without matches is hidden`);
      await page.locator('#input-general-search').fill('zzzz-no-such-setting');
      assert.ok(await visible(page, '#general-search-empty'), `${build}: empty search result notice`);
      await page.locator('[data-tab="memory"]').click();
      assert.equal(await page.locator('#input-general-search').inputValue(), '', `${build}: picking a tab ends the search`);
      assert.equal(await page.evaluate(() => document.body.classList.contains('settings-searching')), false, `${build}: search mode ends`);
      assert.equal(await activeTab(page), 'memory');
      assert.equal(await visible(page, '#settings-search'), false, `${build}: no search box on Memory`);
      await page.locator('[data-tab="captcha"]').click();
      assert.ok(await visible(page, '#settings-search'), `${build}: search box on CAPTCHA`);

      // The language is picked in the side panel; an open Settings page follows it.
      await page.evaluate(() => chrome.storage.local.set({ wbLocale: 'tr' }));
      await page.waitForFunction(() => document.querySelector('[data-tab="budgets"]').textContent === 'Bütçeler');
      assert.match(await page.locator('#subtitle').textContent(), /WebBrain/, `${build}: subtitle re-rendered`);
      assert.deepEqual(await untranslated(page), [], `${build}: every string resolves after a language change`);
      await page.evaluate(() => chrome.storage.local.set({ wbLocale: 'en' }));
      await page.waitForFunction(() => document.querySelector('[data-tab="budgets"]').textContent === 'Budgets');
      assert.deepEqual(errors, [], `${build}: settings.html interaction errors`);
      await page.close();

      // Old Settings deep links land where those tabs live now.
      for (const [hash, target, tab] of [['providers', 'providers.html#llm', 'llm'], ['multimodal', 'providers.html#vision', 'vision'], ['permissions', 'permissions.html', null]]) {
        const { page: redirected, errors: redirectErrors } = await open(browser, build, `settings.html#${hash}`);
        await redirected.waitForURL(url => String(url).endsWith(`/src/${build}/src/ui/${target}`));
        if (tab) await redirected.waitForFunction(name => document.querySelector('.tab-btn.active')?.dataset.tab === name, tab);
        else await redirected.locator('#permissions-card').waitFor();
        assert.deepEqual(redirectErrors, [], `${build}: #${hash} redirect errors`);
        await redirected.close();
      }

      // --- providers.html ---
      const { page: providers, errors: providerErrors } = await open(browser, build, 'providers.html');
      await providers.locator('.provider-card[data-provider-id="llamacpp"]').first().waitFor();
      assert.deepEqual(await tabsOf(providers), PROVIDER_TABS, `${build}: provider tabs`);
      assert.equal(await activeTab(providers), 'llm', `${build}: Providers opens on LLM`);
      for (const [tab, card] of [['vision', '#vision-card'], ['speech', '#transcription-card'], ['generative', '#image-gen-card'], ['decision', '#system-one-card'], ['safesocial', '#safesocial-card']]) {
        assert.equal(await providers.locator(`[data-panel="${tab}"] ${card}`).count(), 1, `${build}: ${tab} tab holds ${card}`);
      }
      assert.equal(await providers.locator('#image-budget-card, #toggle-screenshot-redaction').count(), 0, `${build}: image budget and redaction left Vision`);
      assert.equal(await providers.locator('[data-panel="vision"] #webgpu-vision-choice').count(), build === 'chrome' ? 1 : 0, `${build}: in-browser vision only in Chrome`);
      assert.equal(await providers.locator('#settings-page-link').getAttribute('href'), 'settings.html', `${build}: header links back to Settings`);
      assert.deepEqual(await untranslated(providers), [], `${build}: every providers.html string resolves`);
      await providers.locator('[data-tab="decision"]').click();
      assert.ok(await visible(providers, '#decision-mode'), `${build}: decision modes on the Decision tab`);
      assert.deepEqual(providerErrors, [], `${build}: providers.html page errors`);
      await providers.close();

      const { page: aliased, errors: aliasErrors } = await open(browser, build, 'providers.html#multimodal');
      await aliased.waitForFunction(() => document.querySelector('.tab-btn.active')?.dataset.tab === 'vision');
      assert.deepEqual(aliasErrors, [], `${build}: providers.html alias errors`);
      await aliased.close();

      // --- permissions.html ---
      const grant = { host: 'example.com', capability: 'click', action: 'allow' };
      const { page: permissions, errors: permissionErrors } = await open(browser, build, 'permissions.html', { seed: { wb_permissions: [grant] } });
      await permissions.locator('#permissions-list button[data-host="example.com"]').waitFor();
      await permissions.locator('#toggle-permission-gate').locator('..').click();
      assert.equal(await store(permissions, 'askBeforeConsequentialActions'), false, `${build}: master switch saves`);
      assert.ok(await visible(permissions, '#permission-gate-warning'), `${build}: master switch warning`);
      await permissions.locator('#permissions-list button[data-host="example.com"]').click();
      await permissions.waitForFunction(() => window.testStore.wb_permissions.length === 0);
      assert.equal(await permissions.locator('#settings-page-link').getAttribute('href'), 'settings.html', `${build}: permissions links back to Settings`);
      assert.deepEqual(await untranslated(permissions), [], `${build}: every permissions.html string resolves`);
      assert.deepEqual(permissionErrors, [], `${build}: permissions.html page errors`);
      await permissions.close();
      console.log(`PASS ${build}: settings, providers and permissions pages`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}
