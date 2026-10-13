import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: path => `chrome-extension://owned/${path}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/', title: 'Owned' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const bounded = promise => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve('timeout'), 500))]);

// Reuse the existing unrelated browser/trace fixture. The permission manager,
// permission wait, public steering route, batch, and both outer loops are real.
const fixture = fs.readFileSync(new URL('./chat-steering.mjs', import.meta.url), 'utf8');
const fixtureFunction = (name, next) => vm.runInNewContext(`(${fixture.slice(fixture.indexOf(`function ${name}(`), fixture.indexOf(`function ${next}(`)).trim()})`);
const setup = fixtureFunction('setup', 'allowBatchPreparation');
const prepare = fixtureFunction('allowBatchPreparation', 'actSetup');

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const source = fs.readFileSync(new URL(`../src/${build}/src/background.js`, import.meta.url), 'utf8');
  const start = source.indexOf('async function handleMessage('), end = source.indexOf('\n}', start) + 2;
  const tabId = 771, options = { detachedRequestId: 'owned-current-request', askStreamingEnabled: false };
  const make = implementation => {
    const agent = setup(Agent, implementation);
    prepare(agent);
    agent._skipPermissionGate = false;
    agent._ensureGateSetting = async () => false;
    const events = [], update = (type, data) => events.push({ type, data });
    const handler = vm.runInNewContext(`(${source.slice(start, end)})`, { agent, chrome: api, browser: api });
    const steer = (text = 'Cancel the old navigation; just acknowledge the corrected task.', extra = {}, sender = api.runtime.getURL('src/ui/sidepanel.html')) => handler({ action: 'chat_steer', tabId, requestId: options.detachedRequestId, messageId: 'genuine-correction', text, ...extra }, { url: sender });
    return { agent, events, update, steer };
  };
  const claimed = async () => {
    const h = make();
    await h.agent._claimRunEntry(tabId, 'interactive', options, h.update);
    h.agent.conversations.set(tabId, [{ role: 'user', content: 'Open the original controlled page.' }]);
    return h;
  };
  const finish = h => { h.agent._cancelClarifications(tabId, 'fixture finished'); h.agent._finishSteeringRun(tabId); h.agent._releaseRunEntry(tabId); };
  const batch = h => {
    const calls = [1, 2].map(number => ({ id: `old-${number}`, function: { name: 'navigate', arguments: JSON.stringify({ url: `https://example.com/old-${number}` }) } }));
    const messages = h.agent.conversations.get(tabId);
    messages.push({ role: 'assistant', content: null, tool_calls: calls });
    let physical = 0;
    h.agent.executeTool = async () => { physical++; return { success: true }; };
    return { calls, messages, physical: () => physical, result: h.agent._executeToolBatch(tabId, calls, messages, h.update, {}, null, new Set(['navigate']), 1, options) };
  };
  const waitPrompt = async h => {
    const deadline = Date.now() + 1000;
    while (!h.events.some(e => e.type === 'clarify') && Date.now() < deadline) await new Promise(r => setTimeout(r, 1));
    const prompt = h.events.find(e => e.type === 'clarify')?.data;
    assert.ok(prompt, 'The real permission prerequisite must be reached');
    return prompt;
  };

  for (const grouped of [false, true]) for (const streaming of [false, true]) test(`${build}: actual ${streaming ? 'stream' : 'chat'} loop consumes public correction without answering old ${grouped ? 'grouped ' : ''}permission`, async () => {
    let calls = 0, plans = 0, physical = 0;
    const next = async () => ++calls === 1
      ? { toolCalls: [{ id: 'old-action', function: { name: 'navigate', arguments: JSON.stringify({ url: grouped ? 'https://example.com/search?q=quality' : 'https://example.com/old' }) } }] }
      : { content: 'Corrected task acknowledged.' };
    const h = make({ chat: next, async *chatStream() { const result = await next(); if (result.content) yield { type: 'text', content: result.content }; if (result.toolCalls) yield { type: 'tool_call', content: result.toolCalls }; yield { type: 'done' }; } });
    delete h.agent._maybeRunPlannerGate;
    h.agent._plannerMode = () => 'off';
    h.agent._runPlannerIntentGate = async () => ++plans === 1
      ? { proceed: true, requestKind: 'execute', requiresStateChange: true, requiresSubmission: false }
      : { proceed: true, requestKind: 'respond', responseOnly: true };
    h.agent._persistSubmittedTurn = async () => {};
    h.agent._getTabUrlTitle = async () => ({ tabUrl: 'https://example.com/', tabTitle: 'Owned' });
    h.agent._ensureProgressSessionForCurrentTask = async () => {};
    h.agent.executeTool = async () => { physical++; assert.fail('The superseded physical action must not run'); };
    const run = streaming
      ? h.agent.processMessageStream(tabId, 'Open the old controlled page', h.update, 'act', options)
      : h.agent.processMessage(tabId, 'Open the old controlled page', h.update, 'act', [], options);
    try {
      const prompt = await waitPrompt(h);
      assert.equal(prompt.permission?.grouped === true, grouped);
      assert.equal((await h.steer()).accepted, true);
      assert.equal(h.agent.submitClarifyResponse(tabId, prompt.clarifyId, 'always'), false);
      assert.equal(await bounded(run), 'Corrected task acknowledged.');
      assert.equal(plans, 2); assert.equal(physical, 0);
      assert.equal(h.events.filter(e => e.type === 'steering_applied').length, 1);
      assert.equal(h.agent.permissions.check('example.com', 'navigate', tabId).allowed, false);
    } finally { if (h.agent.isRunning(tabId)) h.agent.abort(tabId); await run.catch(() => {}); }
  });

  test(`${build}: canceled wait closes every old tool pair and never grants stale permission`, async () => {
    const h = await claimed(); const b = batch(h);
    try {
      const prompt = await waitPrompt(h);
      assert.equal((await h.steer()).accepted, true);
      assert.equal(h.agent.submitClarifyResponse(tabId, prompt.clarifyId, 'always'), false);
      assert.equal((await bounded(b.result)).action, 'continue'); assert.equal(b.physical(), 0);
      for (const call of b.calls) { const result = JSON.parse(b.messages.find(m => m.tool_call_id === call.id).content); assert.equal(result.noDispatch, true); assert.equal(result.skipped, true); }
      h.agent._applyPendingSteering(tabId, b.messages, h.update);
      assert.equal(h.events.filter(e => e.type === 'steering_applied').length, 1);
      assert.equal(h.agent.permissions.check('example.com', 'navigate', tabId).allowed, false);
    } finally { finish(h); await b.result.catch(() => {}); }
  });

  test(`${build}: resolved answer queued before correction cannot record old grant`, async () => {
    const h = await claimed(); const b = batch(h);
    try { const prompt = await waitPrompt(h); assert.equal(h.agent.submitClarifyResponse(tabId, prompt.clarifyId, 'always'), true); assert.equal((await h.steer()).accepted, true); assert.equal((await b.result).action, 'continue'); assert.equal(h.agent.permissions.check('example.com', 'navigate', tabId).allowed, false); assert.equal(b.physical(), 0); }
    finally { finish(h); }
  });

  test(`${build}: correction during refreshed gate settings is checked before grant`, async () => {
    const h = await claimed(), entered = deferred(), release = deferred();
    h.agent._ensureGateSetting = async argument => { if (argument?.force) { entered.resolve(); await release.promise; } return false; };
    const b = batch(h);
    try { const prompt = await waitPrompt(h); h.agent.submitClarifyResponse(tabId, prompt.clarifyId, 'always'); await entered.promise; await h.steer(); release.resolve(); assert.equal((await b.result).action, 'continue'); assert.equal(b.physical(), 0); assert.equal(h.agent.permissions.check('example.com', 'navigate', tabId).allowed, false); }
    finally { release.resolve(); finish(h); }
  });

  test(`${build}: stale request, content sender and invalid correction keep genuine permission wait`, async () => {
    const h = await claimed(); const wait = h.agent._promptPermission(tabId, 'navigate', 'example.com', h.update); const prompt = h.events.at(-1).data;
    try { assert.equal((await h.steer(undefined, { requestId: 'old-request' })).accepted, false); await assert.rejects(h.steer(undefined, {}, 'https://example.com/'), /chat panel/); assert.equal((await h.steer(' ')).accepted, false); assert.equal(h.agent._pendingClarifications.get(tabId).has(prompt.clarifyId), true); assert.equal(h.agent.submitClarifyResponse(tabId, prompt.clarifyId, 'once'), true); assert.equal(await wait, 'once'); }
    finally { finish(h); }
  });

  test(`${build}: Stop stays cancellation and rejects late answer and steering`, async () => {
    const h = await claimed(); const wait = h.agent._promptPermission(tabId, 'navigate', 'example.com', h.update), id = h.events.at(-1).data.clarifyId;
    try { h.agent.abort(tabId); assert.equal(await wait, null); assert.equal(h.agent.submitClarifyResponse(tabId, id, 'always'), false); assert.equal((await h.steer()).accepted, false); }
    finally { finish(h); }
  });

  test(`${build}: duplicate correction does not cancel a newer prompt or clear uncertain native send`, async () => {
    const h = await claimed(), pending = { pendingOutbound: { state: 'unknown', body: 'Owned pending body' } }; h.agent.chatSessions.set(tabId, pending);
    try { const first = h.agent._promptPermission(tabId, 'navigate', 'example.com', h.update); await h.steer(); assert.equal(await first, null); h.agent._applyPendingSteering(tabId, h.agent.conversations.get(tabId), h.update); const second = h.agent._promptPermission(tabId, 'navigate', 'example.com', h.update); const id = h.events.at(-1).data.clarifyId; assert.equal((await h.steer()).accepted, true); assert.equal(h.agent._pendingClarifications.get(tabId).has(id), true); assert.equal(h.agent.chatSessions.get(tabId), pending); h.agent.submitClarifyResponse(tabId, id, 'deny'); assert.equal(await second, 'deny'); }
    finally { finish(h); }
  });

  test(`${build}: grouped permission is canceled without recording intent authorization`, async () => {
    const h = await claimed();
    try { const wait = h.agent._authorizeGroupedSearch(tabId, 'example.com', 'owned-search', ['navigate', 'type', 'click'], h.update); const id = h.events.at(-1).data.clarifyId; await h.steer(); assert.equal(h.agent.submitClarifyResponse(tabId, id, 'once'), false); assert.equal(await wait, null); assert.equal(h.agent.permissions.checkIntent('owned-search', tabId).allowed, false); }
    finally { finish(h); }
  });
}
