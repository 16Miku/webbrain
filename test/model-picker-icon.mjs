// The composer's model picker shows an engine icon instead of the model's
// name; the name is its tooltip and accessible name (src/*/src/ui/sidepanel.*).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = (build, file) => readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8');
const extract = (source, name) => {
  const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};

for (const build of ['chrome', 'firefox']) {
  test(`${build}: the closed model picker is an engine icon`, () => {
    const html = read(build, 'src/ui/sidepanel.html');
    const button = html.match(/<button type="button" id="provider-picker-btn"[\s\S]*?<\/button>/)[0];
    assert.match(button, /<svg class="provider-picker-icon"[^>]*aria-hidden="true">[\s\S]*?<\/svg>\s*<span class="provider-picker-label" id="provider-picker-label"><\/span>/,
      'the icon comes first, hidden from assistive technology');
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
      providerSelect: { value: 'openrouter', selectedOptions: [{ textContent: 'OpenRouter · openai/gpt-6-luna' }] },
      providerPickerLabel: { textContent: '' },
      providerPickerLabelById: new Map([['openrouter', 'OpenRouter']]),
      providerPickerBtn: { title: '', setAttribute(k, v) { attributes[k] = v; } },
      providerPickerMenu: { querySelectorAll: () => options },
    });
    vm.runInContext(extract(panel, 'syncProviderPickerButton'), context);
    context.syncProviderPickerButton();
    assert.equal(context.providerPickerBtn.title, 'Model: OpenRouter · openai/gpt-6-luna');
    assert.equal(attributes['aria-label'], 'Model: OpenRouter · openai/gpt-6-luna');
    assert.deepEqual(options.map(option => option.attrs['aria-selected']), ['true', 'false'], 'the open menu marks it');
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

test('every language names the active model', async () => {
  for (const build of ['chrome', 'firefox']) {
    for (const code of ['en', 'tr', 'es', 'fr', 'de', 'nl', 'pt', 'pl', 'ru', 'uk', 'zh', 'ja', 'ko', 'ar', 'he', 'fa', 'hi', 'bn', 'id', 'ms', 'tl', 'th', 'vi']) {
      const dict = (await import(`../src/${build}/src/ui/locales/${code}.js`)).default;
      assert.match(dict['sp.provider_picker.current'] || '', /\{name\}/, `${build} ${code}`);
      assert.ok(dict['sp.provider_picker.none'], `${build} ${code}`);
    }
  }
});
