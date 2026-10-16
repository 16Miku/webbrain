import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const { getToolsForMode, SYSTEM_PROMPT_ACT_COMPACT, SYSTEM_PROMPT_BATCHING } = await import(`../src/${build}/src/agent/tools.js`);
  const { validateToolArguments } = await import(`../src/${build}/src/agent/tool-arguments.js`);
  const { capabilityFor, UNTRUSTED_CONTENT_TOOLS } = await import(`../src/${build}/src/agent/permission-gate.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  test(`${build}: batching is exposed only in enabled Mid/Full action modes`, () => {
    for (const mode of ['ask', 'act', 'dev']) {
      for (const tier of ['compact', 'mid', 'full']) {
        const tools = getToolsForMode(mode, { tier });
        const batch = tools.find(tool => tool.function.name === 'browser_batch');
        assert.equal(!!batch, mode !== 'ask' && tier !== 'compact', `${mode}/${tier}`);
        assert.equal(getToolsForMode(mode, { tier, browserBatchEnabled: false }).some(tool => tool.function.name === 'browser_batch'), false);
        if (!batch) continue;
        const schema = batch.function.parameters;
        assert.equal(schema.properties.actions.maxItems, tier === 'mid' ? 6 : 10);
        assert.equal(schema.properties.actions.minItems, 1);
        const names = new Set(tools.map(tool => tool.function.name));
        const actionNames = schema.properties.actions.items.properties.name.enum;
        assert.ok(actionNames.every(name => names.has(name)), 'Only advertised sub-tools can be selected.');
        assert.ok(!actionNames.includes('browser_batch'));
        assert.ok(!actionNames.includes('execute_js'));
        assert.ok(!actionNames.includes('chat_send'));
        assert.equal(actionNames.includes('hover'), tier === 'full');
        // The parent schema must not close the child tool's arguments to {}.
        assert.equal(validateToolArguments('browser_batch', {
          actions: [{ name: 'set_field', input: { ref_id: 'ref_1', text: 'hello', submit: false } }],
        }, schema).ok, true);
        assert.equal(validateToolArguments('browser_batch', {
          actions: [{ name: 'browser_batch', input: {} }],
        }, schema).ok, false);
      }
    }
  });

  test(`${build}: batch guidance follows the feature switch and leaves Compact small`, () => {
    const provider = { promptTier: 'mid', config: { promptTier: 'mid' } };
    const agent = new Agent({ getActive: () => provider });
    assert.equal(agent.browserBatchEnabled, true);
    assert.ok(agent._buildSystemPrompt('act').includes(SYSTEM_PROMPT_BATCHING));
    assert.ok(agent._buildSystemPrompt('dev').includes(SYSTEM_PROMPT_BATCHING));
    assert.ok(!agent._buildSystemPrompt('ask').includes(SYSTEM_PROMPT_BATCHING));
    agent.setBrowserBatchEnabled(false);
    assert.ok(!agent._buildSystemPrompt('act').includes(SYSTEM_PROMPT_BATCHING));
    agent.setBrowserBatchEnabled(true);
    provider.promptTier = provider.config.promptTier = 'compact';
    assert.ok(!agent._buildSystemPrompt('act').includes(SYSTEM_PROMPT_BATCHING));
    assert.ok(!SYSTEM_PROMPT_ACT_COMPACT.includes('browser_batch'));
  });

  test(`${build}: batch results are classified as untrusted while children own permissions`, () => {
    assert.equal(UNTRUSTED_CONTENT_TOOLS.has('browser_batch'), true);
    assert.equal(capabilityFor('browser_batch', {}), null);
    assert.notEqual(capabilityFor('set_field', { ref_id: 'ref_1', text: 'value' }), null);
  });

  test(`${build}: every locale labels the batch tool`, async () => {
    const directory = new URL(`../src/${build}/src/ui/locales/`, import.meta.url);
    const locales = fs.readdirSync(directory).filter(file => file.endsWith('.js'));
    assert.equal(locales.length, 23);
    for (const file of locales) {
      const text = fs.readFileSync(new URL(file, directory), 'utf8');
      assert.match(text, /'tool\.browser_batch':\s*["'][^"']+["']/u, file);
    }
  });
}
