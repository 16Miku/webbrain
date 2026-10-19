// The Act prompts (full, mid, lean and compact) tell the model to ask for a value the user did not give
// instead of choosing one: QA G1 filled a booking date nobody named, G2
// opened one of two contacts called Alex.
import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const tools = await import(`../src/${build}/src/agent/tools.js`);
  test(`${build}: full, mid and lean Act prompts ask for a missing value instead of choosing one`, () => {
    for (const [name, prompt] of [['full', tools.SYSTEM_PROMPT_ACT], ['mid', tools.SYSTEM_PROMPT_ACT_MID], ['lean', tools.SYSTEM_PROMPT_ACT_LEAN]]) {
      assert.match(prompt, /which of two (?:contacts|people) with the same name/, name);
      assert.match(prompt, /never (?:choose one yourself|fill one in yourself)|instead of choosing one/, name);
    }
    assert.match(tools.SYSTEM_PROMPT_ACT, /purpose message_recipient/);
  });
  // The compact tier has no clarify tool: it stops with a partial done and asks.
  test(`${build}: the compact Act prompt asks for a missing value instead of choosing one`, () => {
    const prompt = tools.SYSTEM_PROMPT_ACT_COMPACT;
    assert.match(prompt, /which of two people with the same name/);
    assert.match(prompt, /outcome:"partial"\}\) asking the user for it instead of choosing one yourself/);
    assert.doesNotMatch(prompt.match(/Type only values[^\n]*/)[0], /clarify/);
  });
}
