// A page that failed to load was never read, so the prompts report its value as
// unverified, and only a value missing from a page that was read as not found.
import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const tools = await import(`../src/${build}/src/agent/tools.js`);
  test(`${build}: prompts keep a failed page load apart from a value the page did not show`, () => {
    assert.match(tools.SYSTEM_PROMPT_ASK, /page failed to load or could not be read, say that item is unverified, not "not found"/);
    for (const [name, prompt] of [['ask', tools.SYSTEM_PROMPT_ASK], ['act', tools.SYSTEM_PROMPT_ACT], ['mid', tools.SYSTEM_PROMPT_ACT_MID], ['lean', tools.SYSTEM_PROMPT_ACT_LEAN]]) {
      assert.doesNotMatch(prompt, /a page failed to load, the field is not there/, name);
      assert.match(prompt, /not found/, name);
    }
    for (const [name, prompt] of [['act', tools.SYSTEM_PROMPT_ACT], ['mid', tools.SYSTEM_PROMPT_ACT_MID], ['lean', tools.SYSTEM_PROMPT_ACT_LEAN]]) {
      assert.match(prompt, /not found \(or as unverified when its page could not be read\)/, name);
    }
  });
}
