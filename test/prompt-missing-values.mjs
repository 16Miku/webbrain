// The Act prompts (full, mid and compact; a lean run uses its tier's) tell the model to ask for a value the user did not give
// instead of choosing one: QA G1 filled a booking date nobody named, G2
// opened one of two contacts called Alex.
import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const tools = await import(`../src/${build}/src/agent/tools.js`);
  test(`${build}: full and mid Act prompts ask for a missing value instead of choosing one`, () => {
    for (const [name, prompt] of [['full', tools.SYSTEM_PROMPT_ACT], ['mid', tools.SYSTEM_PROMPT_ACT_MID]]) {
      assert.match(prompt, /which of two (?:contacts|people) with the same name/, name);
      assert.match(prompt, /never (?:choose one yourself|fill one in yourself)|instead of choosing one/, name);
    }
    // A value the page pre-fills (a default date) is not one the user gave.
    for (const [name, prompt] of [['full', tools.SYSTEM_PROMPT_ACT], ['mid', tools.SYSTEM_PROMPT_ACT_MID], ['compact', tools.SYSTEM_PROMPT_ACT_COMPACT]]) {
      assert.match(prompt, /pre-fills/, name);
      assert.doesNotMatch(prompt, /Type only values the user gave or the page already shows/, name);
    }
    // A timeout or Instant must not answer for the user, so every tier asks for an explicit answer.
    for (const [name, prompt] of [['full', tools.SYSTEM_PROMPT_ACT], ['mid', tools.SYSTEM_PROMPT_ACT_MID], ['compact', tools.SYSTEM_PROMPT_ACT_COMPACT]]) {
      assert.match(prompt, /require_explicit_answer:true/, name);
    }
    assert.match(tools.SYSTEM_PROMPT_ACT, /purpose message_recipient/);
  });
  // The compact tier has the clarify tool, so it pauses for the answer instead of ending the run.
  test(`${build}: the compact Act prompt asks for a missing value with clarify instead of choosing one`, () => {
    const prompt = tools.SYSTEM_PROMPT_ACT_COMPACT;
    assert.match(prompt, /which of two people with the same name/);
    assert.match(prompt, /ask with clarify\(\{question, options, require_explicit_answer:true\}\) before filling or opening anything; never choose one yourself/);
    assert.match(prompt, /purpose message_recipient/);
    assert.doesNotMatch(prompt.match(/Type only values[^\n]*/)[0], /done\(/);
    const names = tools.getToolsForMode('act', { tier: 'compact' }).map(tool => tool.function.name);
    assert.ok(names.includes('clarify'), 'compact exposes clarify');
    assert.match(prompt, /^- clarify\(\{question[^\n]*\n- done\(/m, 'the compact tool list names clarify (it says use ONLY these)');
});
}
