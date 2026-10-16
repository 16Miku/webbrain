import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/', title: 'Example', status: 'complete' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
const call = (id, name, input) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } });
const field = n => ({ name: 'set_field', input: { ref_id: `ref_${n}`, text: `value ${n}` } });
const batch = (actions, id = 'batch') => call(id, 'browser_batch', { actions });

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { getToolsForMode } = await import(`../src/${build}/src/agent/tools.js`);
  const { AnthropicProvider } = await import(`../src/${build}/src/providers/anthropic.js`);
  const { OpenAICompatibleProvider } = await import(`../src/${build}/src/providers/openai.js`);
  function setup(calls, tier = 'full') {
    const provider = { name: 'test', model: 'test', promptTier: tier, contextWindow: 128000, supportsVision: false };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    agent._currentUrl = async () => 'https://example.com/';
    agent._ensureGateSetting = async () => false;
    agent._chromeProtectedPageFailure = async () => null;
    agent._captchaMutationPreflight = async () => null;
    agent._adoptLiveSocialPublishWorkflow = async () => false;
    agent._workflowPreSubmitDispatchBlock = async () => null;
    agent._messageRecipientGuardBlock = async () => null;
    agent._detectLikelySubmitAction = async () => null;
    agent._isFormValidationCandidate = () => false;
    agent._preflightRichTextToolbarTarget = async () => ({ block: null });
    agent._socialPublicationPreSubmitBlock = async () => null;
    agent._auditRichTextToolbarTarget = async () => {};
    agent._shouldAutoScreenshot = () => false;
    agent._resolveVisionRoute = async () => ({ provider: null });
    const gates = [], dispatched = [], updates = [], snapshots = [];
    agent.permissions.hydrate = async () => {};
    agent.permissions.check = (host, capability, tabId) => { gates.push({ host, capability, tabId }); return { allowed: true }; };
    agent.executeTool = async (_tab, name, args) => { dispatched.push({ name, args }); return { success: true, verified: true }; };
    const messages = [{ role: 'user', content: 'Fill the known fields.' }, { role: 'assistant', content: '', tool_calls: calls }];
    agent.conversations.set(1, messages);
    agent._persist = () => snapshots.push(agent._conversationStorageEntry(1));
    const tools = getToolsForMode('act', { tier });
    const run = () => agent._executeToolBatch(1, calls, messages, (type, data) => updates.push({ type, data }), provider, null,
      new Set(tools.map(tool => tool.function.name)), 1, {}, new Map(tools.map(tool => [tool.function.name, tool.function.parameters])));
    return { agent, messages, run, gates, dispatched, updates, snapshots, provider };
  }
  function assertPaired(messages) {
    let pending = new Set();
    for (const message of messages) {
      if (message.role === 'tool') assert.ok(pending.delete(message.tool_call_id), `unexpected result ${message.tool_call_id}`);
      else {
        assert.equal(pending.size, 0, 'attachments must follow all results');
        pending = new Set(message.tool_calls?.map(call => call.id) || []);
      }
    }
    assert.equal(pending.size, 0);
    assert.ok(messages.every(message => !message.tool_call_id?.includes('::')));
  }

  test(`${build}: explicit Mid batch uses each normal permission gate and folds one parent result`, async () => {
    const parent = batch([field(1), field(2), { name: 'get_window_info', input: {} }]);
    const h = setup([parent], 'mid');
    const before = structuredClone(parent);
    await h.run();
    assert.deepEqual(h.dispatched.map(item => item.name), ['set_field', 'set_field', 'get_window_info']);
    assert.equal(h.gates.filter(gate => gate.capability === 'type').length, 2);
    assert.ok(h.gates.every(gate => gate.host === 'example.com'));
    assert.deepEqual(parent, before);
    assertPaired(h.messages);
    assert.equal(h.messages.filter(message => message.role === 'tool').length, 1);
    assert.match(h.messages.at(-1).content, /ran 3 of 3/);
    assert.equal(h.updates.filter(event => event.type === 'tool_call' && event.data.name === 'browser_batch').length, 1);
    assert.equal(h.updates.filter(event => event.type === 'tool_result' && event.data.name === 'browser_batch').length, 1);
  });

  test(`${build}: malformed later input prevents every dispatch`, async () => {
    const h = setup([batch([field(1), { name: 'set_field', input: { ref_id: 'ref_2' } }])]);
    await h.run();
    assert.equal(h.dispatched.length, 0);
    assert.equal(h.gates.length, 0);
    assert.equal(h.messages.filter(message => message.role === 'tool').length, 1);
    assert.match(h.messages.at(-1).content, /invalid_browser_batch/);
  });

  test(`${build}: malformed parent JSON uses native transcript repair without changing the original call`, async () => {
    const parent = batch([field(1)]);
    parent.function.arguments = 'not a JSON object';
    const h = setup([parent]);
    const reasoning = { type: 'reasoning', encrypted_content: 'original-reasoning' };
    const item = { type: 'function_call', name: 'browser_batch', call_id: parent.id, arguments: parent.function.arguments };
    h.messages[1].response_items = [reasoning, item];
    await h.run();
    assert.equal(h.dispatched.length, 0);
    assert.equal(parent.function.arguments, 'not a JSON object');
    assert.equal(h.messages[1].tool_calls[0].function.arguments, '{}');
    assert.equal(h.messages[1].response_items[0], reasoning);
    assert.equal(h.messages[1].response_items[1].arguments, '{}');
    assert.equal(item.arguments, 'not a JSON object');
    assertPaired(h.messages);
    const wire = new OpenAICompatibleProvider({ apiKey: 'test', model: 'test' })._buildChatCompletionsBody(h.messages);
    for (const message of wire.messages) for (const tool of message.tool_calls || []) assert.doesNotThrow(() => JSON.parse(tool.function.arguments));
  });

  test(`${build}: permission denial stops the batch before any dispatch`, async () => {
    const h = setup([batch([field(1), field(2)]), call('sibling', 'get_window_info', {})]);
    h.agent.permissions.check = () => ({ allowed: false, needsPrompt: false });
    await h.run();
    assert.equal(h.dispatched.length, 0);
    assertPaired(h.messages);
    assert.match(h.messages.find(message => message.tool_call_id === 'batch').content, /ran 0 of 2/);
    assert.equal(JSON.parse(h.messages.at(-1).content).skipped, true);
  });

  test(`${build}: a preparation failure that normally continues still ends an explicit batch`, async () => {
    const h = setup([batch([field(1), field(2)]), call('sibling', 'get_window_info', {})]);
    let checks = 0;
    h.agent._pureCalculationToolBlock = () => {
      checks++;
      return { success: false, noDispatch: true, error: 'fixture preflight rejection' };
    };
    await h.run();
    assert.equal(checks, 1);
    assert.equal(h.dispatched.length, 0);
    assertPaired(h.messages);
    assert.match(h.messages.find(message => message.tool_call_id === 'batch').content, /ran 0 of 2/);
  });

  test(`${build}: inserted progress notes cannot shift the wrapper result lookup`, async () => {
    const h = setup([batch([field(1), field(2)])]);
    h.messages[1] = structuredClone(h.messages[1]);
    let count = 0;
    h.agent.executeTool = async () => {
      if (!count++) h.messages.unshift({ role: 'system', content: 'app-owned progress fixture' });
      return { success: true, verified: true };
    };
    await h.run();
    assertPaired(h.messages);
    const wrapper = h.updates.find(event => event.type === 'tool_result' && event.data.name === 'browser_batch');
    assert.equal(wrapper.data.result.success, true);
    assert.equal(wrapper.data.result.summary, '[browser_batch] ran 2 of 2 actions');
  });

  test(`${build}: content-free traces preserve bounded batch membership`, async () => {
    const { projectTraceEventData } = await import(`../src/${build}/src/trace/privacy.js`);
    const metadata = { parentId: 'parent_1', index: 1, total: 3 };
    const projected = projectTraceEventData('tool', { name: 'set_field', batch: { ...metadata, input: 'PRIVATE' }, args: { text: 'PRIVATE' }, result: { success: true, text: 'PRIVATE' } });
    assert.deepEqual(projected.batch, metadata);
    assert.ok(!JSON.stringify(projected).includes('PRIVATE'));
    assert.equal(projectTraceEventData('tool', { name: 'set_field' }).batch, undefined);
    assert.equal(projectTraceEventData('tool', { name: 'set_field', batch: { ...metadata, index: 4 } }).batch, undefined);
  });

  for (const problem of [{ success: false, error: 'failed' }, { success: true, verified: false }]) {
    test(`${build}: ${problem.success ? 'unverified' : 'failed'} action stops children and siblings`, async () => {
      const h = setup([batch([field(1), field(2), field(3)]), call('sibling', 'get_window_info', {})]);
      let count = 0;
      h.agent.executeTool = async () => ++count === 2 ? problem : { success: true, verified: true };
      await h.run();
      assert.equal(count, 2);
      assertPaired(h.messages);
      assert.match(h.messages.find(message => message.tool_call_id === 'batch').content, /ran 2 of 3/);
      assert.equal(JSON.parse(h.messages.find(message => message.tool_call_id === 'sibling').content).skipped, true);
    });
  }

  for (const observation of [false, true]) test(`${build}: navigation ${observation ? 'permits trailing observations' : 'stops remaining mutations'}`, async () => {
    const next = observation ? { name: 'get_window_info', input: {} } : field(2);
    const h = setup([batch([{ name: 'navigate', input: { url: 'https://example.com/next' } }, next])], 'mid');
    await h.run();
    assert.equal(h.dispatched.length, observation ? 2 : 1);
    assertPaired(h.messages);
  });

  for (const submit of [
    { name: 'set_field', input: { ref_id: 'ref_1', text: 'search', submit: true } },
    { name: 'press_keys', input: { key: 'Enter' } },
  ]) test(`${build}: ${submit.name} submit stops before the next action`, async () => {
    const h = setup([batch([submit, field(2)])]);
    h.agent._isFormValidationCandidate = () => true;
    h.agent._detectLikelySubmitAction = async () => ({ isSubmit: true, validationSubmitEvidence: 'strong' });
    h.agent._captureFormValidationState = async () => [];
    h.agent._readCompletionResult = async () => null;
    h.agent._waitForFormValidationFailure = async () => null;
    h.agent._skipPermissionGate = true;
    await h.run();
    assert.equal(h.dispatched.length, 1);
    assert.match(h.messages.at(-1).content, /submit_boundary/);
  });

  test(`${build}: Mid boundary still skips a sibling after trailing observation`, async () => {
    const h = setup([batch([field(1), { name: 'get_window_info', input: {} }]), call('sibling', 'get_window_info', {})], 'mid');
    await h.run();
    assert.equal(h.dispatched.length, 2);
    assertPaired(h.messages);
    assert.equal(JSON.parse(h.messages.at(-1).content).reason, 'small_model_action_boundary');
  });

  test(`${build}: navigate then read cannot authorize a stale Full-tier sibling`, async () => {
    const h = setup([batch([{ name: 'navigate', input: { url: 'https://example.com/next' } }, { name: 'get_window_info', input: {} }]), call('sibling', 'set_field', field(2).input)]);
    await h.run();
    assert.deepEqual(h.dispatched.map(item => item.name), ['navigate', 'get_window_info']);
    assertPaired(h.messages);
    assert.equal(JSON.parse(h.messages.at(-1).content).reason, 'navigation_changed');
  });

  test(`${build}: two Full batches and a native sibling retain paired results`, async () => {
    const h = setup([batch([field(1), field(2)], 'first'), batch([field(3)], 'second'), call('native', 'get_window_info', {})]);
    await h.run();
    assert.equal(h.dispatched.length, 4);
    assertPaired(h.messages);
    assert.deepEqual(h.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['first', 'second', 'native']);
  });

  test(`${build}: actual mid-batch storage and provider boundaries fold copies without modifying live execution`, async () => {
    const h = setup([batch([field(1), field(2)])]);
    let count = 0;
    h.agent.executeTool = async () => {
      if (++count === 2) {
        const snapshot = h.agent._conversationStorageEntry(1);
        assertPaired(snapshot.messages);
        assert.match(snapshot.messages.at(-1).content, /ran 1 of 2/);
        assert.match(snapshot.messages.at(-1).content, /not run \(interrupted\)/);
        assert.ok(h.messages.some(message => message.tool_call_id === 'batch::0'));
        h.agent._checkCostAllowance = async () => null;
        h.agent._recordCostUsage = async () => null;
        const wire = { chat: async messages => { assertPaired(messages); return { content: '' }; }, async *chatStream(messages) { assertPaired(messages); yield { type: 'done' }; } };
        await h.agent._chatWithCostAllowance(wire, h.messages, {}, null);
        await h.agent._chatStreamWithCostAllowance(wire, h.messages, {}, null);
        new AnthropicProvider({ apiKey: 'test', model: 'claude-test' })._convertMessages(snapshot.messages);
        new OpenAICompatibleProvider({ apiKey: 'test', model: 'test' })._buildChatCompletionsBody(snapshot.messages);
      }
      return { success: true, verified: true };
    };
    await h.run();
    assert.equal(count, 2);
    assertPaired(h.messages);
  });

  test(`${build}: cancellation after first dispatch repairs children then folds without nested wrapping`, async () => {
    const h = setup([batch([field(1), field(2)])]);
    await h.agent._claimRunEntry(1, 'interactive');
    let count = 0;
    h.agent.executeTool = async (_tab, _name, _args, _update, context) => {
      count++;
      context._contentActionDispatchState.started = true;
      h.agent.abort(1);
      throw context._contentActionAbortSignal.reason;
    };
    await assert.rejects(h.run(), { name: 'AbortError' });
    assert.equal(count, 1);
    assertPaired(h.messages);
    const result = h.messages.at(-1).content;
    assert.ok(result.startsWith('[browser_batch]'));
    assert.match(result, /outcomeUnknown/);
    assert.match(result, /not run/);
    assert.ok((result.match(/<untrusted_page_content id=/g) || []).length >= 1);
    h.agent._releaseRunEntry(1);
  });

  test(`${build}: one auto screenshot after several mutations, paired before supplemental image`, async () => {
    const h = setup([batch([field(1), field(2)])]);
    let shots = 0;
    h.agent._shouldAutoScreenshot = () => true;
    h.agent._advanceAutoScreenshotBurst = () => true;
    h.agent._resolveVisionRoute = async () => ({ provider: h.provider, rawImage: true });
    h.agent._captureBudgetedAutoScreenshot = async () => { shots++; return { dataUrl: 'data:image/png;base64,AAAA' }; };
    h.agent._getVisibleInteractiveElements = async () => [];
    await h.run();
    assert.equal(shots, 1);
    assertPaired(h.messages);
    assert.equal(h.messages.at(-1).role, 'user');
  });
}
