import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { getToolsForMode, SYSTEM_PROMPT_ACT, SYSTEM_PROMPT_ACT_MID } = await import(`../src/${build}/src/agent/tools.js`);
  const tabId = 766;
  const task = 'Have an authorized bounded dialogue with the owned QA contact; answer each new question once and durably wait.';
  function fixture({ fixedOverhead = 22000, liveText = 'Owned fresh question 2.', history = 24 } = {}) {
    const provider = { contextWindow: 32768, maxOutputTokens: 4096, config: { maxOutputTokens: 4096 } };
    const agent = new Agent({ getActive: () => provider });
    agent._chatWithCostAllowance = async () => ({ content: 'Earlier owned checks completed; follow the pinned genuine task and fresh native observation.' });
    const messages = [{ role: 'system', content: 'Owned system instructions.' },
      { role: 'user', content: task, webbrainResumeTaskId: 'owned-original-turn' }];
    for (let index = 0; index < history; index++) {
      messages.push({ role: 'assistant', tool_calls: [{ id: `old-${index}`, type: 'function', function: { name: 'read_page', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: `old-${index}`, content: JSON.stringify({ success: true, text: `Prior owned page ${index}: ${'historical text '.repeat(35)}` }) });
    }
    const liveCall = { role: 'assistant', tool_calls: [{ id: 'fresh-observe', type: 'function', function: { name: 'chat_observe', arguments: '{}' } }] };
    const liveResult = { role: 'tool', tool_call_id: 'fresh-observe', content: JSON.stringify({ success: true,
      threadKey: 'dom:telegram:k:123456:0', chatWorkflow: { newMessages: [{ id: 'telegram:k:123456:0:3:rqa', direction: 'incoming', text: liveText }] } }) };
    messages.push(liveCall, liveResult);
    agent.conversations.set(tabId, messages);
    const chars = agent._estimateContextChars(messages);
    agent._lastEstCharsAtReport.set(tabId, chars);
    agent._lastInputTokens.set(tabId, Math.ceil(chars / 4) + fixedOverhead);
    return { agent, messages, liveCall, liveResult, fixedOverhead };
  }

  test(`${build}: fixed schemas above soft budget compact old groups while preserving the unseen native delta`, async () => {
    const { agent, messages, liveCall, liveResult, fixedOverhead } = fixture();
    const exact = liveResult.content;
    const result = await agent._manageContext(tabId, messages);
    assert.equal(result.compacted, true);
    assert.ok(result.summarized > 0);
    assert.equal(result.reason, 'live_tool_group_above_soft_budget');
    assert.equal(result.hardPromptBudget, 32768 - 4096);
    assert.equal(result.reservedOutputTokens, 4096);
    assert.ok(messages.includes(liveCall) && messages.includes(liveResult));
    assert.equal(liveResult.content, exact, 'The already-consumed native question must reach the next model call verbatim.');
    assert.ok(messages.some(message => message.content === task && message.webbrainResumeTaskId === 'owned-original-turn'));
    assert.ok(Math.ceil(agent._estimateContextChars(messages) / 4) + fixedOverhead <= result.hardPromptBudget);
    const calls = new Set(messages.flatMap(message => (message.tool_calls || []).map(call => call.id)));
    assert.ok(messages.filter(message => message.role === 'tool').every(message => calls.has(message.tool_call_id)), 'No orphaned result survives.');
  });

  test(`${build}: a lone fresh group above soft budget remains intact without destructive compaction`, async () => {
    const { agent, messages } = fixture({ history: 0 });
    const before = JSON.stringify(messages);
    const result = await agent._manageContext(tabId, messages);
    assert.equal(result.compacted, false);
    assert.equal(result.reason, 'live_tool_group_above_soft_budget');
    assert.equal(JSON.stringify(messages), before);
  });

  test(`${build}: native delta exceeding hard headroom remains intact and reports the output-reserved limit`, async () => {
    const { agent, messages } = fixture({ fixedOverhead: 27000, liveText: 'Owned incoming data '.repeat(800), history: 0 });
    const before = JSON.stringify(messages);
    const result = await agent._manageContext(tabId, messages);
    assert.equal(result.compacted, false);
    assert.equal(result.reason, 'over_budget_live_chat_observation');
    assert.equal(result.hardPromptBudget, 28672);
    assert.equal(result.reservedOutputTokens, 4096);
    assert.equal(JSON.stringify(messages), before, 'A consumed incoming delta is not a truncatable historical blob.');
  });

  test(`${build}: all results in the latest completed multi-tool group remain paired`, async () => {
    const { agent, messages, liveCall } = fixture();
    liveCall.tool_calls.push({ id: 'fresh-second', type: 'function', function: { name: 'read_page', arguments: '{}' } });
    const second = { role: 'tool', tool_call_id: 'fresh-second', content: 'Owned second fresh observation.' };
    messages.push(second);
    const result = await agent._manageContext(tabId, messages);
    assert.equal(result.compacted, true);
    assert.ok(messages.includes(liveCall) && messages.includes(second));
    assert.equal(messages.filter(message => message.role === 'tool').filter(message => message.tool_call_id.startsWith('fresh')).length, 2);
  });

  test(`${build}: first exact assembled request counts dynamic schemas before any provider usage exists`, async () => {
    const { agent, messages, liveCall, liveResult } = fixture({ history: 0 });
    messages[0].content = SYSTEM_PROMPT_ACT_MID;
    agent._lastInputTokens.clear(); agent._lastEstCharsAtReport.clear();
    const tools = getToolsForMode('act', { tier: 'mid', webMcpAvailable: true,
      skillTools: [{ type: 'function', function: { name: 'owned_readonly_skill', description: 'Owned schema details. '.repeat(400),
        parameters: { type: 'object', properties: { reference: { type: 'string' } } } } }] });
    const originalMessages = JSON.stringify(messages), originalTools = JSON.stringify(tools);
    const expectedTokens = Math.ceil(agent._estimateContextChars(messages) / 4) + Math.ceil(JSON.stringify(tools).length / 4);
    const result = await agent._manageContext(tabId, messages, null, null, { tools });
    assert.equal(result.tokens, expectedTokens);
    assert.ok(result.tokens > result.budget, 'Actual enabled WebMCP and custom skill schemas exceed this soft budget.');
    assert.equal(result.compacted, false); assert.equal(result.reason, 'live_tool_group_above_soft_budget');
    assert.equal(result.reservedOutputTokens, 4096);
    assert.equal(JSON.stringify(messages), originalMessages); assert.equal(JSON.stringify(tools), originalTools);
    assert.ok(messages.includes(liveCall) && messages.includes(liveResult));
  });

  test(`${build}: restored history without usage metrics compacts against exact schemas and preserves the current group`, async () => {
    const { agent, messages, liveCall, liveResult } = fixture({ history: 40 });
    messages[0].content = SYSTEM_PROMPT_ACT_MID;
    agent._lastInputTokens.clear(); agent._lastEstCharsAtReport.clear();
    const tools = getToolsForMode('act', { tier: 'mid', webMcpAvailable: true,
      skillTools: [{ type: 'function', function: { name: 'owned_readonly_skill', description: 'Owned schema details. '.repeat(300),
        parameters: { type: 'object', properties: { reference: { type: 'string' } } } } }] });
    const expectedTokens = Math.ceil(agent._estimateContextChars(messages) / 4) + Math.ceil(JSON.stringify(tools).length / 4);
    const result = await agent._manageContext(tabId, messages, null, null, { tools });
    assert.equal(result.compacted, true); assert.ok(result.summarized > 0);
    assert.equal(result.tokens, expectedTokens);
    assert.ok(messages.includes(liveCall) && messages.includes(liveResult));
    assert.ok(messages.some(message => message.content === task && message.webbrainResumeTaskId === 'owned-original-turn'));
    const ids = new Set(messages.flatMap(message => (message.tool_calls || []).map(call => call.id)));
    assert.ok(messages.filter(message => message.role === 'tool').every(message => ids.has(message.tool_call_id)));
  });

  test(`${build}: provider-reported usage already includes schemas and is never counted twice`, async () => {
    const { agent, messages } = fixture({ history: 0, fixedOverhead: 22000 });
    const tools = getToolsForMode('act', { tier: 'mid', webMcpAvailable: true });
    const reported = agent._lastInputTokens.get(tabId);
    messages.push({ role: 'system', content: 'Fresh app-owned observation context.' });
    const expected = reported + Math.ceil((agent._estimateContextChars(messages) - agent._lastEstCharsAtReport.get(tabId)) / 4);
    const result = await agent._manageContext(tabId, messages, null, null, { tools });
    assert.equal(result.tokens, expected, 'Do not add the tool-schema estimate to provider usage that already includes it.');
  });

  test(`${build}: tool-free request has zero schema estimate and never invents default Act tools`, async () => {
    for (const promptTier of ['full', 'mid']) {
      const provider = { contextWindow: 32768, maxOutputTokens: 512, promptTier, supportsTools: false };
      const agent = new Agent({ getActive: () => provider });
      const messages = [{ role: 'system', content: 'Owned tool-free instructions.' }, { role: 'user', content: task }];
      agent.conversations.set(tabId, messages);
      const expected = Math.ceil(agent._estimateContextChars(messages) / 4);
      const result = await agent._manageContext(tabId, messages, null, null, { tools: [] });
      assert.equal(result.tokens, expected); assert.equal(result.reason, 'not_needed');
    }
  });

  test(`${build}: unshrinkable fixed Full prompt and schemas report a too-small configuration without deleting authority`, async () => {
    const provider = { contextWindow: 16384, maxOutputTokens: 4096, promptTier: 'full', supportsTools: true };
    const agent = new Agent({ getActive: () => provider });
    const messages = [{ role: 'system', content: SYSTEM_PROMPT_ACT },
      { role: 'user', content: task, webbrainResumeTaskId: 'owned-original-turn' }];
    agent.conversations.set(tabId, messages);
    const tools = getToolsForMode('act', { tier: 'full' }), before = JSON.stringify(messages);
    const result = await agent._manageContext(tabId, messages, null, null, { tools });
    assert.equal(result.compacted, false); assert.equal(result.reason, 'fixed_prompt_above_context_budget');
    assert.ok(result.fixedPromptTokens > result.hardPromptBudget); assert.equal(result.reservedOutputTokens, 4096);
    assert.equal(JSON.stringify(messages), before, 'Fixed capacity is a configuration limit, not truncatable genuine task data.');
  });
}
