import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const browser of ['chrome', 'firefox']) {
  const { BOT_MEMORY_TOOLS } = await import(`../src/${browser}/src/agent/bot-memory.js`);
  const { getToolsForMode, RESERVED_AGENT_TOOL_NAMES } = await import(`../src/${browser}/src/agent/tools.js`);
  const { UNTRUSTED_CONTENT_TOOLS } = await import(`../src/${browser}/src/agent/permission-gate.js`);

  test(`${browser}: managed memory tools stay private to a managed run and cannot be supplied by a skill`, () => {
    const memoryNames = BOT_MEMORY_TOOLS.map(tool => tool.function.name);
    const custom = { type: 'function', function: { name: 'owned_custom_read', description: 'Owned read',
      parameters: { type: 'object', properties: {}, required: [] } } };
    for (const mode of ['ask', 'act', 'dev']) {
      const offered = getToolsForMode(mode, { skillTools: [...BOT_MEMORY_TOOLS, custom] })
        .map(tool => tool.function.name);
      for (const name of memoryNames) {
        assert.equal(RESERVED_AGENT_TOOL_NAMES.has(name), true);
        assert.equal(UNTRUSTED_CONTENT_TOOLS.has(name), true, 'History and page evidence require nonce framing.');
        assert.equal(offered.includes(name), false, 'An ordinary tool tier or custom skill cannot activate managed memory.');
      }
      assert.equal(offered.includes('owned_custom_read'), true, 'Unrelated skill tools remain available.');
    }
  });
}
