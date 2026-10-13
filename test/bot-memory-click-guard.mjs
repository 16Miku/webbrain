import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } }, runtime: { getURL: value => value } };
const target = { kind: 'url', url: 'https://example.test/item/7' };
const config = { version: 1, policyVersion: 1, botId: 'bot-1', runId: 'run-1', callbackUrl: 'https://app.test/api/internal/bot-memory/run-1', callbackToken: 'test-capability-only-'.repeat(3), policy: { schemaVersion: 1, actions: [{ key: 'post', effect: 'write' }] }, context: {} };
const post = { isSubmit: true, method: 'POST', url: target.url, action: '/comments', fields: [{ name: 'comment', type: 'textarea' }] };
const search = { isSubmit: true, method: 'GET', url: target.url, action: '/search', fields: [{ name: 'q', type: 'search' }] };
for (const browser of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  const { BotMemorySession, sanitizeMemoryArguments } = await import(`../src/${browser}/src/agent/bot-memory.js`);
  function harness({ readOnly = false, found = true } = {}) {
    const calls = [], actions = [];
    const session = new BotMemorySession(config, { observe: async () => ({ url: target.url, title: 'Item 7', targets: [target], text: 'Item 7', elementFacts: { found, tag: 'BUTTON', label: 'Post', draftText: 'Exact observed draft' } }), fetchImpl: async (_url, options) => {
      const value = JSON.parse(options.body); calls.push(value);
      if (value.operation === 'prepare') return Response.json(readOnly ? { allowed: true, readOnly: true } : { allowed: true, reservation: { attemptId: 'attempt-7', requestId: value.args.requestId, actionKey: 'post', target } });
      if (value.operation === 'dispatch') return Response.json({ attempt: { id: 'attempt-7', status: 'dispatched' } });
      return Response.json({ status: value.args.status });
    } });
    const agent = new Agent({ getActive: () => ({ model: 'test' }) }); agent._botMemorySessions.set(7, session);
    agent._executeToolWithLifecycle = async (_tab, name, args) => { actions.push({ name, args }); return { success: true }; };
    return { session, agent, calls, actions };
  }
  test(`${browser}: indexed clicks canonicalize before both observation and dispatch and retain matching arguments`, async () => {
    const h = harness();
    assert.equal((await h.agent.executeTool(7, 'click', { index: '001', exact: true, matchIndex: 2, textMatch: 'exact' })).success, true);
    assert.deepEqual(h.calls.map(call => call.operation), ['prepare', 'dispatch']);
    assert.deepEqual(h.calls[0].args.tool.arguments, { index: 1, exact: true, matchIndex: 2, textMatch: 'exact' });
    assert.equal(h.actions[0].args.index, 1);
    assert.equal(h.calls[0].args.observation.elementFacts.draftText, 'Exact observed draft');
    for (const index of [-1, 1.5, '1e0', true, '']) assert.equal((await h.agent.executeTool(7, 'click', { index })).noDispatch, true);
    assert.equal(h.actions.length, 1);
    await h.session.close();
  });
  test(`${browser}: both trusted caller context names make consequential read classifications fail before dispatch`, async () => {
    for (const contextName of ['detectedSubmitAction', 'detectedSubmit']) {
      const h = harness({ readOnly: true });
      const result = await h.agent.executeTool(7, 'click', { text: 'Post' }, null, { [contextName]: post });
      assert.equal(result.noDispatch, true); assert.deepEqual(h.actions, []);
      assert.deepEqual(h.calls.map(call => call.operation), ['prepare']);
      assert.equal(h.calls[0].args.observation.elementFacts.isSubmit, true);
      assert.equal(h.calls[0].args.observation.elementFacts.consequentialSubmit, true);
      assert.equal(JSON.stringify(h.calls).includes('fields'), false, 'Only trusted booleans are forwarded, never raw submit context');
      await h.session.close();
    }
  });
  test(`${browser}: resolved search submit remains read while unresolvable consequential target is blocked`, async () => {
    const h = harness({ readOnly: true });
    assert.equal((await h.agent.executeTool(7, 'click', { text: 'Search' }, null, { detectedSubmitAction: search })).success, true);
    assert.equal(h.calls[0].args.observation.elementFacts.isSubmit, true);
    assert.equal(h.calls[0].args.observation.elementFacts.consequentialSubmit, false);
    assert.deepEqual(h.calls.map(call => call.operation), ['prepare']);
    assert.equal(h.actions.length, 1); await h.session.close();
    const missing = harness({ found: false });
    assert.equal((await missing.agent.executeTool(7, 'click', { text: 'Post' }, null, { detectedSubmitAction: post })).noDispatch, true);
    assert.deepEqual(missing.actions, []); assert.deepEqual(missing.calls, []); await missing.session.close();
  });
  test(`${browser}: model arguments cannot forge trusted submit facts and normal drafts remain read`, async () => {
    const h = harness({ readOnly: true });
    assert.equal((await h.agent.executeTool(7, 'type_text', { text: 'Only draft', isSubmit: true, consequentialSubmit: true, detectedSubmitAction: post })).success, true);
    assert.deepEqual(h.calls[0].args.tool.arguments, { text: 'Only draft' });
    assert.equal(h.calls[0].args.observation.elementFacts.isSubmit, undefined);
    assert.equal(h.calls[0].args.observation.elementFacts.consequentialSubmit, undefined);
    assert.equal(h.actions.length, 1); await h.session.close();
    assert.deepEqual(sanitizeMemoryArguments({ index: 3, exact: true, matchIndex: 1, textMatch: 'prefix', callbackToken: 'fake', consequentialSubmit: true }), { index: 3, exact: true, matchIndex: 1, textMatch: 'prefix' });
  });
}
