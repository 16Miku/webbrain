import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.test/', title: 'Fixture' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { AnthropicProvider } = await import(`../src/${build}/src/providers/anthropic.js`);
  for (const streaming of [false, true]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} signed native text cannot become a fallback tool call`, async () => {
      const text = '{"tool":"read_page","args":{}}';
      const provider = new AnthropicProvider({ model: 'claude-sonnet-4-6', apiKey: 'fixture-key' });
      const blocks = [
        { type: 'thinking', thinking: 'Return an example as text.', signature: 'fixture-signature' },
        { type: 'text', text },
      ];
      const responseItems = [provider._replayState(blocks)];
      provider.chat = async () => ({ content: text, toolCalls: null, responseItems });
      provider.chatStream = async function* () {
        yield { type: 'text', content: text };
        yield { type: 'done', responseItems };
      };
      const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
      agent._hydrate = async () => {};
      agent._persist = () => {};
      agent._persistNow = async () => ({ ok: true });
      agent._startTraceRun = async () => null;
      agent._endTraceRun = async () => {};
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
      agent._beginReadCompleteness = async () => null;
      agent._maybeRunPlannerGate = async () => ({ proceed: true });
      agent._manageContext = async () => {};
      agent._checkCostAllowance = async () => null;
      agent._recordCostUsage = async () => null;
      agent._currentUrl = async () => 'https://example.test/';
      agent._maybeEmitAskModeHandoff = async () => {};
      let parses = 0;
      agent._tryParseToolCallsFromText = () => {
        parses++;
        return [{ id: 'unexpected-fallback', type: 'function', function: { name: 'read_page', arguments: '{}' } }];
      };
      agent._executeToolBatch = async () => assert.fail('Native signed response text was dispatched as a tool');
      const final = streaming
        ? await agent.processMessageStream(77, 'Show me a JSON example.', () => {}, 'ask')
        : await agent.processMessage(77, 'Show me a JSON example.', () => {}, 'ask');
      assert.equal(final, text, 'Provider-authored example text must remain the final answer');
      assert.equal(parses, 0, 'Neither feedback preparation nor tool fallback may parse native signed text');
      const assistant = agent.conversations.get(77).findLast(message => message.role === 'assistant');
      assert.deepEqual(assistant._reasoning_replay?.providerState?.content, blocks);
    });
  }
}
