import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/', title: 'Example' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/src/${file}`, import.meta.url), 'utf8');

function setup(Agent, implementation = {}) {
  const provider = {
    name: 'steering test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: false, supportsVision: false, ...implementation,
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
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
  agent._currentUrl = async () => 'https://example.com/';
  agent._maybeEmitAskModeHandoff = async () => {};
  return agent;
}

function allowBatchPreparation(agent) {
  agent._skipPermissionGate = true;
  agent._ensureGateSetting = async () => true;
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
}

function assertPairedTools(messages) {
  let pending = new Set();
  for (const message of messages) {
    if (message.role === 'tool') assert.ok(pending.delete(message.tool_call_id));
    else {
      assert.equal(pending.size, 0, 'User steering must follow every tool result');
      pending = new Set((message.tool_calls || []).map(call => call.id));
    }
  }
  assert.equal(pending.size, 0);
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const tabId = 77;
  const options = { detachedRequestId: 'run-1', askStreamingEnabled: false };
  const steer = (agent, text, id = 'correction-1', tab = tabId, requestId = 'run-1') =>
    agent.steerMessage(tab, text, { requestId, messageId: id });

  test(`${build}: steering is bound to one interactive run and deduplicated`, async () => {
    const agent = setup(Agent);
    assert.equal(steer(agent, 'Use blue').accepted, false);
    await agent._claimRunEntry(tabId, 'interactive', options);
    const updates = [];
    agent._beginSteeringRun(tabId, (type, data) => updates.push({ type, data }), options);
    assert.equal(steer(agent, 'Use blue', 'a', tabId + 1).accepted, false);
    assert.equal(steer(agent, 'Use blue', 'a', tabId, 'old-run').reason, 'run-changed');
    assert.equal(steer(agent, ' ').reason, 'invalid-message');
    assert.equal(steer(agent, 'Use blue', 'a').accepted, true);
    assert.equal(steer(agent, 'Use blue', 'a').accepted, true);
    assert.equal(steer(agent, 'Keep the logo', 'b').accepted, true);
    agent._jevSettings = async () => assert.fail('A superseded fast-path task was scheduled');
    assert.equal(await agent._maybeJevFastTurn(tabId, 'Original task', [], 'act', new Set(), {}, null), null);
    const messages = [];
    assert.ok(agent._applyPendingSteering(tabId, messages, (type, data) => updates.push({ type, data })));
    assert.deepEqual(messages, [{ role: 'user', content: 'Use blue' }, { role: 'user', content: 'Keep the logo' }]);
    assert.equal(updates.filter(update => update.type === 'steering_applied').length, 2);
    agent._finishSteeringRun(tabId);
    assert.equal(steer(agent, 'Too late').accepted, false);
    agent._releaseRunEntry(tabId);
  });

  for (const streaming of [false, true]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} corrects an in-flight response before dispatch`, async () => {
      const entered = deferred();
      const release = deferred();
      const requests = [];
      const oldCall = { id: 'stale-call', function: { name: 'navigate', arguments: '{"url":"https://example.com/old"}' } };
      const implementation = {
        chat: async messages => {
          requests.push(structuredClone(messages));
          if (requests.length === 1) {
            entered.resolve();
            await release.promise;
            return { content: 'Old answer', toolCalls: [oldCall] };
          }
          return { content: 'Corrected answer' };
        },
        async *chatStream(messages) {
          requests.push(structuredClone(messages));
          if (requests.length === 1) {
            yield { type: 'text', content: 'Old answer' };
            entered.resolve();
            await release.promise;
            yield { type: 'tool_call', content: [{ ...oldCall, index: 0 }] };
          } else yield { type: 'text', content: 'Corrected answer' };
          yield { type: 'done' };
        },
      };
      const agent = setup(Agent, implementation);
      agent.executeTool = async () => assert.fail('A superseded tool call was dispatched');
      const updates = [];
      const update = (type, data) => updates.push({ type, data });
      const run = streaming
        ? agent.processMessageStream(tabId, 'Original request', update, 'ask', options)
        : agent.processMessage(tabId, 'Original request', update, 'ask', [], options);
      await Promise.race([entered.promise, run.then(result => assert.fail(`Early completion: ${result}`))]);
      assert.equal(steer(agent, 'Use the revised request').accepted, true);
      release.resolve();
      assert.equal(await run, 'Corrected answer');
      assert.equal(requests.length, 2);
      assert.equal(requests[1].at(-1).content, 'Use the revised request');
      assert.equal(requests[1].at(-1).role, 'user');
      assertPairedTools(requests[1]);
      assert.equal(updates.filter(update => update.type === 'steering_applied').length, 1);
      assert.ok(updates.some(update => update.type === 'text' && update.data.replace && update.data.content === ''));
      assert.equal(agent.isRunning(tabId), false);
    });

    test(`${build}: ${streaming ? 'stream' : 'chat'} returns unconsumed steering when the step budget ends`, async () => {
      const entered = deferred(); const release = deferred();
      const agent = setup(Agent, {
        chat: async () => { entered.resolve(); await release.promise; return { content: 'Finished' }; },
        async *chatStream() { entered.resolve(); await release.promise; yield { type: 'text', content: 'Finished' }; yield { type: 'done' }; },
      });
      agent.maxSteps = 1;
      const updates = [];
      const update = (type, data) => updates.push({ type, data });
      const run = streaming
        ? agent.processMessageStream(tabId, 'Original request', update, 'ask', options)
        : agent.processMessage(tabId, 'Original request', update, 'ask', [], options);
      await Promise.race([entered.promise, run.then(result => assert.fail(`Early completion: ${result}`))]);
      assert.equal(steer(agent, 'Follow-up').accepted, true);
      release.resolve();
      await run;
      assert.deepEqual(updates.find(update => update.type === 'steering_queued').data.messages,
        [{ id: 'correction-1', text: 'Follow-up' }]);
      assert.equal(updates.filter(update => update.type === 'steering_applied').length, 0);
      assert.equal(agent._steeringRuns.size, 0);
    });
  }

  test(`${build}: steering during a tool call waits for its result and skips remaining calls`, async () => {
    const agent = setup(Agent);
    allowBatchPreparation(agent);
    const updates = [];
    const update = (type, data) => updates.push({ type, data });
    await agent._claimRunEntry(tabId, 'interactive', options);
    agent._beginSteeringRun(tabId, update, options);
    const entered = deferred(); const release = deferred();
    const dispatched = [];
    agent.executeTool = async (_tab, _name, args) => {
      dispatched.push(args.maxChars);
      entered.resolve();
      await release.promise;
      return { success: true, pageContent: 'Example page' };
    };
    const calls = [1, 2].map(index => ({ id: `tool-${index}`, function: { name: 'get_accessibility_tree', arguments: JSON.stringify({ maxChars: index * 1000 }) } }));
    const messages = [{ role: 'assistant', content: null, tool_calls: calls }];
    const batch = agent._executeToolBatch(tabId, calls, messages, update, {}, null, new Set(['get_accessibility_tree']), 1);
    await Promise.race([entered.promise, batch.then(result => assert.fail(`Early completion: ${JSON.stringify(result)}`))]);
    assert.equal(steer(agent, 'Stop navigating; summarize instead').accepted, true);
    release.resolve();
    assert.equal((await batch).action, 'continue');
    assert.deepEqual(dispatched, [1000]);
    assert.ok(messages.find(message => message.tool_call_id === 'tool-2').content.includes('Skipped because the user steered'));
    agent._applyPendingSteering(tabId, messages, update);
    assertPairedTools(messages);
    assert.equal(messages.at(-1).content, 'Stop navigating; summarize instead');
    agent._finishSteeringRun(tabId);
    agent._releaseRunEntry(tabId);
  });

  for (const [phase, sharedDeadline] of ['permission', 'checkpoint', 'toolbar', 'publication'].flatMap(phase =>
    [false, true].map(sharedDeadline => [phase, sharedDeadline]))) {
    test(`${build}: steering during ${phase} preparation prevents dispatch${sharedDeadline ? ' with a shared deadline' : ''}`, async () => {
      const agent = setup(Agent);
      allowBatchPreparation(agent);
      agent._needsSharedActionPipelineDeadline = () => sharedDeadline;
      const entered = deferred(); const release = deferred();
      const pause = async () => { entered.resolve(); await release.promise; };
      const runOptions = { ...options };
      if (phase === 'permission') {
        agent._skipPermissionGate = false;
        agent._ensureGateSetting = async () => false;
        agent.permissions.hydrate = async () => {};
        agent.permissions.check = () => ({ allowed: false, needsPrompt: true });
        agent.permissions.record = async () => {};
        agent._promptPermission = async () => { await pause(); return 'once'; };
      } else if (phase === 'checkpoint') {
        runOptions.beforeConsequentialTool = async () => { await pause(); return { ok: true }; };
      } else if (phase === 'toolbar') {
        agent._preflightRichTextToolbarTarget = async () => { await pause(); return { block: null }; };
      } else {
        agent._socialPublicationPreSubmitBlock = async () => { await pause(); return null; };
      }
      agent.executeTool = async () => assert.fail('A superseded navigation was dispatched');
      const update = () => {};
      await agent._claimRunEntry(tabId, 'interactive', runOptions);
      agent._beginSteeringRun(tabId, update, runOptions);
      const calls = [1, 2].map(index => ({ id: `navigate-${index}`, function: {
        name: 'navigate', arguments: JSON.stringify({ url: `https://example.com/old-${index}` }),
      } }));
      const messages = [{ role: 'assistant', content: null, tool_calls: calls }];
      const batch = agent._executeToolBatch(tabId, calls, messages, update, {}, null, new Set(['navigate']), 1, runOptions);
      await Promise.race([entered.promise, batch.then(result => assert.fail(`Early completion: ${JSON.stringify(result)}`))]);
      assert.equal(steer(agent, 'Cancel navigation; summarize instead').accepted, true);
      release.resolve();
      assert.equal((await batch).action, 'continue');
      for (const call of calls) {
        const result = JSON.parse(messages.find(message => message.tool_call_id === call.id).content);
        assert.equal(result.noDispatch, true);
        assert.equal(result.skipped, true);
        assert.match(result.error, /user steered/);
      }
      agent._applyPendingSteering(tabId, messages, update);
      assertPairedTools(messages);
      agent._finishSteeringRun(tabId);
      agent._releaseRunEntry(tabId);
    });
  }

  test(`${build}: setup failure releases the inbox without losing an accepted correction`, async () => {
    const agent = setup(Agent);
    const entered = deferred(); const release = deferred();
    agent._hydrate = async () => { entered.resolve(); await release.promise; throw new Error('storage failed'); };
    const updates = [];
    const run = agent.processMessage(tabId, 'Original request', (type, data) => updates.push({ type, data }), 'ask', [], options);
    await entered.promise;
    assert.equal(steer(agent, 'Correction').accepted, true);
    release.resolve();
    await assert.rejects(run, /storage failed/);
    assert.equal(updates.at(-1).type, 'steering_queued');
    assert.equal(agent.isRunning(tabId), false);
  });

  test(`${build}: only the extension chat panel can submit a trusted correction`, async () => {
    const source = read(build, 'background.js');
    const start = source.indexOf("  if (msg.action === 'chat_steer') {");
    const end = source.indexOf('\n  // Only Settings', start);
    const calls = [];
    const context = vm.createContext({
      chrome: api, browser: api,
      agent: { steerMessage: (...args) => { calls.push(args); return { accepted: true }; } },
    });
    vm.runInContext(`async function handle(msg, sender) { ${source.slice(start, end)} }`, context);
    const message = { action: 'chat_steer', tabId, text: 'Correction', requestId: 'run-1', messageId: 'a' };
    await assert.rejects(context.handle(message, { url: 'https://example.com/', tab: { id: tabId } }), /chat panel only/);
    assert.equal(calls.length, 0);
    assert.equal((await context.handle(message, { url: `${api.runtime.getURL('src/ui/sidepanel.html')}?standalone=1` })).accepted, true);
    assert.equal(calls.length, 1);
  });
}
