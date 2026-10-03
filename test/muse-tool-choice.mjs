import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const browser of ['chrome', 'firefox']) {
  const { OpenAICompatibleProvider } = await import(`../src/${browser}/src/providers/openai.js`);
  const config = { providerName: 'webbrain_me', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta/muse-spark-1.3-contributor' };
  const tools = ['read_page', 'done'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }));
  test(`${browser}: Muse uses auto and preserves restricted tools in chat and streaming`, () => {
    const provider = new OpenAICompatibleProvider(config);
    for (const stream of [false, true]) {
      for (const choice of [undefined, 'auto', 'required']) {
        const body = provider._buildChatCompletionsBody([], { tools, toolChoice: choice }, stream);
        assert.equal(body.tool_choice, 'auto');
        assert.deepEqual(body.tools, tools);
      }
      const body = provider._buildChatCompletionsBody([], { tools, toolChoice: { type: 'function', function: { name: 'done' } } }, stream);
      assert.equal(body.tool_choice, 'auto');
      assert.deepEqual(body.tools, [tools[1]]);
      const none = provider._buildChatCompletionsBody([], { tools, toolChoice: 'none' }, stream);
      assert.equal(Object.hasOwn(none, 'tools'), false);
      assert.equal(Object.hasOwn(none, 'tool_choice'), false);
    }
    assert.throws(() => provider._buildChatCompletionsBody([], { tools, toolChoice: { function: { name: 'missing' } } }), /not available/);
  });
  test(`${browser}: other models/endpoints retain their tool choices`, () => {
    const named = { type: 'function', function: { name: 'done' } };
    for (const other of [{ ...config, model: 'other-model' }, { ...config, baseUrl: 'https://api.example.com/v1' }, { ...config, baseUrl: 'https://openrouter.ai.example.com/v1' }]) {
      const body = new OpenAICompatibleProvider(other)._buildChatCompletionsBody([], { tools, toolChoice: named });
      assert.deepEqual(body.tool_choice, named);
      assert.deepEqual(body.tools, tools);
    }
    const variant = new OpenAICompatibleProvider({ ...config, model: config.model + ':nitro' });
    assert.equal(variant._buildChatCompletionsBody([], { tools, toolChoice: 'required' }).tool_choice, 'auto');
  });
  test(`${browser}: Muse Responses builder applies the same tool restriction`, () => {
    const provider = new OpenAICompatibleProvider(config);
    const body = provider._buildResponsesBody([], { tools, toolChoice: { function: { name: 'done' } } });
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].name, 'done');
  });
}
