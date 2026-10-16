import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AGENT_TOOLS as CHROME_TOOLS } from '../src/chrome/src/agent/tools.js';
import { AGENT_TOOLS as FIREFOX_TOOLS } from '../src/firefox/src/agent/tools.js';

// Hints are instructions the model follows literally. A press_keys call they
// suggest must fit the tool's real schema: one `key` from its enum per call.
const ROOT = fileURLToPath(new URL('../', import.meta.url));

for (const [build, tools] of [['chrome', CHROME_TOOLS], ['firefox', FIREFOX_TOOLS]]) {
  test(`${build}: content hints suggest only press_keys calls the tool accepts`, () => {
    const schema = tools.find(tool => tool.function.name === 'press_keys')?.function.parameters;
    const keys = new Set(schema?.properties?.key?.enum || []);
    assert.ok(keys.has('ArrowDown') && keys.has('Enter') && schema.required.includes('key'));
    const source = fs.readFileSync(path.join(ROOT, 'src', build, 'src/content/content.js'), 'utf8');
    // Each hint is one template literal on one line.
    const hints = source.split('\n').map(line => line.trim())
      .filter(line => line.startsWith('resp.hint = `') && line.endsWith('`;') && line.includes('press_keys'))
      .map(line => line.slice('resp.hint = `'.length, -2));
    assert.ok(hints.length >= 2, 'the select and combobox hints mention press_keys');
    for (const hint of hints) {
      assert.doesNotMatch(hint, /press_keys\(\[/, `array form is rejected by the schema: ${hint}`);
      assert.doesNotMatch(hint, /first letter/i, `letter keys are not in the schema: ${hint}`);
      for (const [, call] of hint.matchAll(/press_keys\(([^)]*)\)/g)) {
        const key = call.match(/^\{key: "([^"]+)"\}$/)?.[1];
        assert.ok(key && keys.has(key), `${build}: unsupported press_keys usage in hint: press_keys(${call})`);
      }
    }
    const combobox = hints.find(hint => hint.includes('popup-opener'));
    assert.match(combobox, /press_keys\(\{key: "ArrowDown"\}\)[^.]*then press_keys\(\{key: "Enter"\}\)/);
  });
}
