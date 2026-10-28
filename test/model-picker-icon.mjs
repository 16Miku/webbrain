// The composer's model picker shows the selected provider's logo, with an
// engine fallback; the model's name remains in the tooltip and accessible name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = (build, file) => readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8');
const extract = (source, name) => {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};

for (const build of ['chrome', 'firefox']) {
  test(`${build}: the closed model picker keeps an engine fallback and connection badge`, () => {
    const html = read(build, 'src/ui/sidepanel.html');
    const button = html.match(/<button type="button" id="provider-picker-btn"[\s\S]*?<\/button>/)[0];
    assert.match(button, /<span class="provider-picker-engine">\s*<span class="provider-picker-icon" aria-hidden="true">\s*<svg class="provider-picker-fallback"[^>]*aria-hidden="true">[\s\S]*?<\/svg>\s*<\/span>\s*<span id="status-dot" class="status-dot offline"><\/span>\s*<\/span>\s*<span class="provider-picker-label" id="provider-picker-label"><\/span>/,
      'the icon comes first, hidden from assistive technology, with the connection dot on it');
    assert.match(button, /aria-describedby="status-dot"/, 'the connection status describes the button');
    assert.equal(html.match(/id="status-dot"/g).length, 1, 'the dot is no longer a separate toolbar item');
    // applyDOMTranslations would reset a data-i18n-title to its first value on
    // every language change; the live status is rendered by sidepanel.js.
    assert.doesNotMatch(button, /id="status-dot"[^>]*data-i18n/, 'the dot title is not a fixed translation');
    const css = read(build, 'styles/sidepanel.css');
    assert.match(css, /\.composer-toolbar \.provider-picker-label \{\s*display: none;\s*\}/, 'the name is not shown in the composer');
    assert.doesNotMatch(css, /\.composer-toolbar \.provider-picker \{\s*\/\* 100% minus/, 'the picker no longer claims a whole row at large scales');
  });

  test(`${build}: the picker's tooltip and accessible name say which model is active`, async () => {
    const en = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    const panel = read(build, 'src/ui/sidepanel.js');
    const attributes = {};
    const options = [{ dataset: { value: 'openrouter' }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
      { dataset: { value: 'local' }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }];
    const context = vm.createContext({
      syncProviderPickerIcon() {},
      t: (key, params = {}) => String(en[key] || key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? ''),
      // The option text carries the provider's status, never its model.
      providerSelect: { value: 'openrouter', selectedOptions: [{ textContent: 'OpenRouter — Active' }] },
      providerPickerLabel: { textContent: '' },
      providerPickerLabelById: new Map([['openrouter', 'OpenRouter'], ['webbrain_cloud', 'WebBrain Compass'], ['local', 'gpt-6-luna']]),
      providerPickerModelById: new Map([['openrouter', 'openai/gpt-6-luna'], ['local', 'gpt-6-luna']]),
      providerPickerBtn: { title: '', setAttribute(k, v) { attributes[k] = v; } },
      providerPickerMenu: { querySelectorAll: () => options },
      statusDot: { title: '' },
      statusDotTitle: () => en['sp.status.connecting'],
      statusDotProviderId: 'openrouter',
      markSelectedProviderUntested() {},
    });
    vm.runInContext(extract(panel, 'syncProviderPickerButton'), context);
    context.syncProviderPickerButton();
    assert.equal(context.providerPickerBtn.title, 'Model: OpenRouter · openai/gpt-6-luna');
    assert.equal(attributes['aria-label'], 'Model: OpenRouter · openai/gpt-6-luna');
    assert.deepEqual(options.map(option => option.attrs['aria-selected']), ['true', 'false'], 'the open menu marks it');
    assert.match(panel, /if \(typeof config\.model === 'string' && config\.model\.trim\(\)\) providerPickerModelById\.set\(id, config\.model\.trim\(\)\);/, 'loadProviders records each configured model');
    // A provider without a configured model, and a label that already names it.
    context.providerSelect = { value: 'webbrain_cloud', selectedOptions: [{ textContent: 'WebBrain Compass — No setup' }] };
    context.syncProviderPickerButton();
    assert.equal(attributes['aria-label'], 'Model: WebBrain Compass');
    context.providerSelect = { value: 'local', selectedOptions: [{ textContent: 'gpt-6-luna — Active' }] };
    context.syncProviderPickerButton();
    assert.equal(attributes['aria-label'], 'Model: gpt-6-luna');
    // Nothing selected yet.
    context.providerSelect = { value: '', selectedOptions: [] };
    context.syncProviderPickerButton();
    assert.equal(attributes['aria-label'], 'Choose a model');
    // A locale change renders the name again.
    for (const handler of ['applyDOMTranslations(document);\n    syncLanguagePicker();\n    syncProviderPickerButton();', 'languageSelect.value = getLocale();\n    syncLanguagePicker();\n    syncProviderPickerButton();']) {
      assert.ok(panel.includes(handler), handler.split('\n')[0]);
    }
  });
}

for (const build of ['chrome', 'firefox']) {
  // The dot's title is the picker button's accessible description, so a check
  // in progress must not keep announcing the previous result.
  test(`${build}: while a connection check runs, the dot's title says so`, async () => {
    const en = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    const panel = read(build, 'src/ui/sidepanel.js');
    let answer;
    const context = vm.createContext({
      syncProviderPickerIcon() {},
      t: (key, params = {}) => String(en[key] || key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? ''),
      providerSelect: { value: 'openrouter' },
      providerTestRequestId: 0,
      statusDot: { className: 'status-dot offline', title: en['sp.status.disconnected'] },
      sendToBackground: async () => new Promise((resolve) => { answer = resolve; }),
      markSelectedProviderUntested() { throw new Error('openrouter is tested'); },
    });
    vm.runInContext(extract(panel, 'setStatusDot') + extract(panel, 'testConnection'), context);
    const pending = context.testConnection();
    assert.equal(context.statusDot.className, 'status-dot connecting');
    assert.equal(context.statusDot.title, 'Checking connection…');
    answer({ ok: true, model: 'gpt-6-luna' });
    await pending;
    assert.equal(context.statusDot.className, 'status-dot online');
    assert.equal(context.statusDot.title, 'Connected (gpt-6-luna)');
  });

  test(`${build}: a language change says the live status again, not "Disconnected"`, async () => {
    const dicts = {
      en: (await import(`../src/${build}/src/ui/locales/en.js`)).default,
      tr: (await import(`../src/${build}/src/ui/locales/tr.js`)).default,
    };
    const panel = read(build, 'src/ui/sidepanel.js');
    let locale = 'en';
    let answer;
    const context = vm.createContext({
      syncProviderPickerIcon() {},
      t: (key, params = {}) => String(dicts[locale][key] || key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? ''),
      providerSelect: { value: 'openrouter', selectedOptions: [{ textContent: 'OpenRouter — Active' }] },
      providerTestRequestId: 0,
      providerPickerLabel: { textContent: '' },
      providerPickerLabelById: new Map([['openrouter', 'OpenRouter']]),
      providerPickerModelById: new Map(),
      providerPickerBtn: { title: '', setAttribute() {} },
      providerPickerMenu: null,
      statusDot: { className: 'status-dot offline', title: '' },
      statusDotProviderId: null,
      sendToBackground: async () => new Promise((resolve) => { answer = resolve; }),
    });
    vm.runInContext(['setStatusDot', 'testConnection', 'syncProviderPickerButton', 'markSelectedProviderFailed', 'markSelectedProviderUntested']
      .map((name) => extract(panel, name)).join('\n'), context);
    const relabel = (code) => { locale = code; context.syncProviderPickerButton(); return context.statusDot.title; };

    const pending = context.testConnection();
    assert.equal(relabel('tr'), dicts.tr['sp.status.connecting'], 'checking, in the new language');
    answer({ ok: true, model: 'gpt-6-luna' });
    await pending;
    assert.equal(context.statusDot.title, 'Bağlı (gpt-6-luna)');
    assert.equal(relabel('en'), 'Connected (gpt-6-luna)');
    assert.equal(context.statusDot.className, 'status-dot online', 'the state is kept');

    context.markSelectedProviderFailed(new Error('401 Unauthorized'));
    assert.equal(relabel('tr'), 'Hata: 401 Unauthorized');
    context.markSelectedProviderFailed(null);
    assert.equal(relabel('en'), 'Error: Connection failed');
    assert.equal(relabel('tr'), 'Hata: Bağlantı başarısız');

    context.markSelectedProviderUntested();
    assert.equal(context.statusDot.className, 'status-dot');
    assert.equal(relabel('en'), 'OpenRouter — Active', 'untested: the provider row, as before');
  });
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: picking another provider never shows the previous provider's result`, async () => {
    const en = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    const panel = read(build, 'src/ui/sidepanel.js');
    const pending = {};
    const options = { openrouter: 'OpenRouter — Active', local: 'Local proxy — Active' };
    const providerSelect = {
      value: 'openrouter',
      get selectedOptions() { return [{ textContent: options[this.value] }]; },
    };
    const wait = (name) => new Promise((resolve) => { pending[name] = resolve; });
    const context = vm.createContext({
      syncProviderPickerIcon() {},
      t: (key, params = {}) => String(en[key] || key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? ''),
      providerSelect,
      MORE_PROVIDERS_OPTION_VALUE: '__more_providers__',
      selectedProviderId: 'openrouter',
      providerSelectionRequestId: 0,
      providerTestRequestId: 0,
      providerPickerLabel: { textContent: '' },
      providerPickerLabelById: new Map([['openrouter', 'OpenRouter'], ['local', 'Local proxy']]),
      providerPickerModelById: new Map(),
      providerPickerBtn: { title: '', setAttribute() {} },
      providerPickerMenu: null,
      statusDot: { className: 'status-dot offline', title: '' },
      statusDotProviderId: null,
      setActiveChatProvider: () => wait('activate'),
      sendToBackground: (action) => wait(action === 'set_active_provider' ? 'activate' : 'test'),
      openProvidersSettingsPage: async () => {},
    });
    vm.runInContext(['setStatusDot', 'testConnection', 'syncProviderPickerButton', 'markSelectedProviderFailed', 'markSelectedProviderUntested']
      .map((name) => extract(panel, name)).join('\n'), context);
    const start = panel.indexOf("providerSelect.addEventListener('change', async () => {");
    const handler = vm.runInContext(`(${panel.slice(panel.indexOf('async () => {', start), panel.indexOf('\n});', start) + 2)})`, context);
    const dot = () => [context.statusDot.className, context.statusDot.title];

    // OpenRouter was checked and answered.
    const first = context.testConnection();
    pending.test({ ok: true, model: 'openai/gpt-6-luna' });
    await first;
    assert.deepEqual(dot(), ['status-dot online', 'Connected (openai/gpt-6-luna)']);

    // The user picks the local proxy: while it is activated, the button that
    // now names it says the check is under way, not OpenRouter's result.
    providerSelect.value = 'local';
    const change = handler();
    assert.deepEqual(dot(), ['status-dot connecting', 'Checking connection…']);
    pending.activate({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(dot(), ['status-dot connecting', 'Checking connection…'], 'then its own check runs');
    pending.test({ ok: false, error: 'connect ECONNREFUSED' });
    await change;
    assert.deepEqual(dot(), ['status-dot offline', 'Error: connect ECONNREFUSED']);

    // Settings switches back to OpenRouter: loadProviders() selects it and
    // syncs the button, with no check of its own, so the local proxy's
    // error is not shown for OpenRouter.
    providerSelect.value = 'openrouter';
    context.syncProviderPickerButton();
    assert.deepEqual(dot(), ['status-dot', 'OpenRouter — Active']);
    context.syncProviderPickerButton();
    assert.deepEqual(dot(), ['status-dot', 'OpenRouter — Active'], 'and stays so');
  });
}

test('every language names the active model', async () => {
  for (const build of ['chrome', 'firefox']) {
    for (const code of ['en', 'tr', 'es', 'fr', 'de', 'nl', 'pt', 'pl', 'ru', 'uk', 'zh', 'ja', 'ko', 'ar', 'he', 'fa', 'hi', 'bn', 'id', 'ms', 'tl', 'th', 'vi']) {
      const dict = (await import(`../src/${build}/src/ui/locales/${code}.js`)).default;
      assert.match(dict['sp.provider_picker.current'] || '', /\{name\}/, `${build} ${code}`);
      assert.ok(dict['sp.provider_picker.none'], `${build} ${code}`);
      assert.ok(dict['sp.status.connecting'], `${build} ${code}: a check in progress has a description`);
    }
  }
});
