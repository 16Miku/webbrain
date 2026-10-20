// The composer's model picker shows an engine icon instead of the model's
// name; the name is its tooltip and accessible name (src/*/src/ui/sidepanel.*).
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
  test(`${build}: the closed model picker is an engine icon`, () => {
    const html = read(build, 'src/ui/sidepanel.html');
    const button = html.match(/<button type="button" id="provider-picker-btn"[\s\S]*?<\/button>/)[0];
    assert.match(button, /<span class="provider-picker-engine">\s*<svg class="provider-picker-icon"[^>]*aria-hidden="true">[\s\S]*?<\/svg>\s*<span id="status-dot" class="status-dot offline" data-i18n-title="sp\.status\.disconnected"><\/span>\s*<\/span>\s*<span class="provider-picker-label" id="provider-picker-label"><\/span>/,
      'the icon comes first, hidden from assistive technology, with the connection dot on it');
    assert.match(button, /aria-describedby="status-dot"/, 'the connection status describes the button');
    assert.equal(html.match(/id="status-dot"/g).length, 1, 'the dot is no longer a separate toolbar item');
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
      t: (key, params = {}) => String(en[key] || key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? ''),
      // The option text carries the provider's status, never its model.
      providerSelect: { value: 'openrouter', selectedOptions: [{ textContent: 'OpenRouter — Active' }] },
      providerPickerLabel: { textContent: '' },
      providerPickerLabelById: new Map([['openrouter', 'OpenRouter'], ['webbrain_cloud', 'WebBrain Compass'], ['local', 'gpt-6-luna']]),
      providerPickerModelById: new Map([['openrouter', 'openai/gpt-6-luna'], ['local', 'gpt-6-luna']]),
      providerPickerBtn: { title: '', setAttribute(k, v) { attributes[k] = v; } },
      providerPickerMenu: { querySelectorAll: () => options },
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
      t: (key, params = {}) => String(en[key] || key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? ''),
      providerSelect: { value: 'openrouter' },
      providerTestRequestId: 0,
      statusDot: { className: 'status-dot offline', title: en['sp.status.disconnected'] },
      sendToBackground: async () => new Promise((resolve) => { answer = resolve; }),
      markSelectedProviderUntested() { throw new Error('openrouter is tested'); },
    });
    vm.runInContext(extract(panel, 'testConnection'), context);
    const pending = context.testConnection();
    assert.equal(context.statusDot.className, 'status-dot connecting');
    assert.equal(context.statusDot.title, 'Checking connection…');
    answer({ ok: true, model: 'gpt-6-luna' });
    await pending;
    assert.equal(context.statusDot.className, 'status-dot online');
    assert.equal(context.statusDot.title, 'Connected (gpt-6-luna)');
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
