import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area },
  runtime: { getURL: value => `extension://owned/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.test/', title: 'Owned terminal lab' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] } };
const deferred = () => {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
};

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const scheduler = await import(`../src/${build}/src/agent/scheduler.js`);
  const { verifyBrowserCompletion } = await import(`../src/${build}/src/agent/completion-runtime.js`);
  const cases = ['current', 'no-terminal', 'no-private-verdict', 'wrong-verdict-scope', 'wrong-verdict-document', 'no-fresh-read', 'partial-done', 'uncertain', 'pending', 'failed', 'task', 'run', 'source',
    'provider', 'later-action', 'content', 'document', 'steering', 'stop', 'persistence', 'task-during-persist',
    'document-during-settlement-write', 'stop-during-settlement-write', 'acknowledged-write-error', 'later-operation'];

  for (const scenario of cases) test(`${build}: scheduled unknown checkpoint ${scenario} requires current durable independent terminal proof`, async () => {
    const h = { key: 'owned-watch-task', identity: 'owned-watch-document', tree: 'status "Acknowledgement recorded for release-11"',
      stopped: false, steering: false, requests: 0, persists: 0, sourceId: '', cancel: null };
    h.provider = { name: 'Owned fixture', model: 'owned-model', supportsVision: false, config: { category: 'local' }, chat() {} };
    const agent = new Agent({ getActive: () => h.provider });
    const harness = makeSchedulerHarness(scheduler, { requireConfirmation: false });
    harness.manager.agent = agent;
    agent._checkAbort = () => h.stopped; agent._hasPendingSteering = () => h.steering;
    agent._hasUnvalidatedSteering = () => h.steering;
    agent._progressTaskKeyHash = () => h.key; agent._progressTaskAnchorText = () => 'Acknowledge only the new owned release.';
    agent._completionDocumentStamp = async () => h.identity;
    agent._completionLiveStatusMessages = async () => [h.tree];
    agent.executeTool = async () => ({ success: true, pageContent: h.tree });
    agent.recordSystemOneVerdict = () => {};
    agent.abort = () => { h.stopped = true; };
    agent._persistNow = async () => {
      h.persists++;
      if (scenario === 'task-during-persist') h.key = 'superseding-task';
      return scenario === 'persistence' ? { ok: false } : { ok: true };
    };
    agent._chatWithCostAllowance = async () => {
      h.requests++;
      return { content: JSON.stringify({ outcome: ['uncertain', 'pending', 'failed'].includes(scenario) ? scenario : 'succeeded',
        reason: 'The owned current native confirmation matches the task.' }) };
    };
    const write = harness.manager.api.storage.local.set;
    let settlementWrite = false;
    harness.manager.api.storage.local.set = async values => {
      const job = values[scheduler.SCHEDULED_JOBS_KEY]?.find(job => job.id === h.sourceId);
      await write(values);
      if (!settlementWrite && job?.pendingToolCall == null
          && job?.completedConsequentialAction?.verification === 'independent_completion') {
        settlementWrite = true;
        if (scenario === 'document-during-settlement-write') h.identity = 'same-url-new-document';
        if (scenario === 'stop-during-settlement-write') h.cancel = harness.manager.cancelJob(h.sourceId, 'Owned Stop');
        if (scenario === 'acknowledged-write-error') throw new Error('Storage acknowledged the write but response was unavailable.');
      }
    };
    agent.processMessage = async (tabId, text, onUpdate, _mode, _attachments, runOptions) => {
      const messages = [{ role: 'system', content: 'Owned scheduled test.' }, { role: 'user', content: text }];
      agent.conversations.set(tabId, messages); agent.conversationModes.set(tabId, 'act');
      agent._systemOneGenerations = new Map([[tabId, 1]]);
      agent._beginCompletionInvariant(tabId);
      const policy = agent.scheduledRunPolicies.get(tabId);
      assert.equal(policy.resumeTaskId, h.sourceId);
      assert.equal(await runOptions.beforeConsequentialTool({ name: 'click_ax' }), true);
      h.originalPending = structuredClone(harness.jobs().find(job => job.id === h.sourceId).pendingToolCall);
      const click = { success: true, dispatched: true, verified: false, inconclusive: true, observedEffects: ['network_request'] };
      agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_1' }, click);
      assert.equal(await runOptions.afterConsequentialTool({ name: 'click_ax', result: click, outcomeUnknown: true }), false);
      if (scenario !== 'no-fresh-read') agent._recordCompletionToolResult(tabId, 'get_accessibility_tree', {}, { pageContent: h.tree });
      messages.push({ role: 'assistant', tool_calls: [{ id: 'owned-click', function: { name: 'click_ax', arguments: '{"ref_id":"ref_1"}' } }] },
        { role: 'tool', tool_call_id: 'owned-click', content: JSON.stringify(click) },
        { role: 'assistant', tool_calls: [{ id: 'owned-read', function: { name: 'get_accessibility_tree', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'owned-read', content: JSON.stringify({ pageContent: h.tree }) });
      const pageUrl = 'https://example.com/';
      const verdict = await verifyBrowserCompletion(agent, tabId, { pageUrl, pageState: {}, summary: 'Observed release-11; acknowledgement count 1.' });
      const result = { done: true, outcome: scenario === 'partial-done' ? 'partial' : 'success',
        summary: 'Observed release-11; acknowledgement count 1.',
        verification: { pageUrl, pageState: {}, completionWarning: null, decision: { outcome: verdict.outcome, engine: verdict.engine } } };
      messages.push({ role: 'assistant', tool_calls: [{ id: 'owned-done', function: { name: 'done', arguments: JSON.stringify({ outcome: result.outcome, summary: result.summary }) } }] },
        { role: 'tool', tool_call_id: 'owned-done', content: agent._wrapUntrusted('done', JSON.stringify(result)) });
      agent._recordCompletionToolResult(tabId, 'done', {}, result);
      onUpdate('tool_result', { name: 'done', result });
      if (scenario === 'no-private-verdict') agent._completionVerdicts.delete(tabId);
      if (scenario === 'wrong-verdict-scope') agent._completionVerdicts.get(tabId).scope = 'an-unrelated-accepted-task';
      if (scenario === 'wrong-verdict-document') agent._completionVerdicts.get(tabId).identity = 'an-older-native-document';
      if (scenario === 'no-terminal') messages.splice(-2);
      if (scenario === 'task') h.key = 'another-task';
      if (scenario === 'run') agent._beginCompletionInvariant(tabId);
      if (scenario === 'source') agent.setScheduledRunPolicy(tabId, { resumeTaskId: 'another-source' });
      if (scenario === 'provider') h.provider = { ...h.provider, model: 'another-provider' };
      if (scenario === 'later-action') agent._recordCompletionToolResult(tabId, 'click_ax', {}, { success: true, dispatched: true });
      if (scenario === 'content') h.tree = 'status "Acknowledgement failed"';
      if (scenario === 'document') h.identity = 'same-url-new-document';
      if (scenario === 'steering') h.steering = true;
      if (scenario === 'stop') await harness.manager.cancelJob(h.sourceId, 'Owned Stop');
      if (scenario === 'later-operation') {
        const jobs = structuredClone(harness.jobs());
        jobs.find(job => job.id === h.sourceId).pendingToolCall.operationId = 'a-later-owned-operation';
        await harness.manager.api.storage.local.set({ [scheduler.SCHEDULED_JOBS_KEY]: jobs });
      }
      h.settled = await agent._settleVerifiedScheduledCompletion(tabId, messages,
        { action: 'return', value: result.summary, rawSummary: result.summary }, runOptions);
      return result.summary;
    };
    const created = await harness.manager.createWatchJob({ args: { prompt: 'When a new release appears, acknowledge it once.', keep: true,
      interval_seconds: 30, beep: false }, currentUrl: 'https://example.com/' });
    h.sourceId = created.jobId;
    await harness.manager.handleAlarm(harness.alarmName(created.jobId));
    await h.cancel;
    const finished = harness.jobs().find(job => job.id === created.jobId);
    assert.equal(h.requests, 1, 'Settlement must refresh the accepted proof without paying for another judgment.');
    if (scenario === 'current') {
      assert.equal(h.settled, true); assert.equal(finished.status, 'pending'); assert.equal(finished.runCount, 1);
      assert.equal(finished.lastOutcome, 'success'); assert.equal(finished.pendingToolCall, null);
      assert.equal(finished.watch.baselineEstablished, true); assert.ok(harness.alarms.has(harness.alarmName(created.jobId)));
    } else if (scenario === 'stop' || scenario === 'stop-during-settlement-write') {
      assert.equal(h.settled, false); assert.equal(finished.status, 'cancelled');
      assert.equal(harness.alarms.has(harness.alarmName(created.jobId)), false);
    } else {
      assert.equal(h.settled, false); assert.equal(finished.status, 'needs_user_input');
      assert.equal(finished.runCount, 0, 'A stale or absent proof cannot complete or rearm the watch.');
      assert.equal(finished.watch.baselineEstablished, false);
      if (scenario !== 'acknowledged-write-error') assert.deepEqual(finished.pendingToolCall,
        scenario === 'later-operation' ? { ...h.originalPending, operationId: 'a-later-owned-operation' } : h.originalPending,
        'Preserve precisely the still-owned uncertain action rather than clearing another operation.');
      else assert.equal(finished.reconciliationRequired, true, 'Ambiguous storage completion retains an explicit recovery boundary.');
    }
  });

  for (const streaming of [false, true]) {
    const loop = streaming ? 'stream' : 'chat';
    for (const boundary of ['persistence', 'callback', 'ordinary']) {
      for (const command of boundary === 'ordinary' ? ['none'] : ['steering', 'stop']) {
        test(`${build}: real ${loop} terminal ${boundary} boundary preserves latest ${command} ownership`, async () => {
          const entered = deferred(), release = deferred(), plans = [], updates = [], closed = [];
          let agent, generations = 0, terminalPersist = false, helperCalls = 0;
          const tabId = 74;
          const provider = { name: 'fixture', model: 'fixture', contextWindow: 128000, supportsTools: false, supportsVision: false,
            chat: async messages => {
              if (++generations === 1) return { toolCalls: [{ id: 'owned-done', function: { name: 'done', arguments: '{"outcome":"success","summary":"Original terminal summary"}' } }] };
              assert.equal(generations, 2);
              assert.match(JSON.stringify(messages), /Use the corrected task instead/);
              return { content: 'Corrected task answer' };
            },
            async *chatStream(messages) { const result = await this.chat(messages);
              if (result.toolCalls) yield { type: 'tool_call', content: result.toolCalls };
              if (result.content) yield { type: 'text', content: result.content };
              yield { type: 'done' }; },
          };
          agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
          agent._hydrate = async () => {}; agent._persist = () => {};
          agent._persistNow = async () => {
            if (terminalPersist && boundary === 'persistence') { terminalPersist = false; entered.resolve(); await release.promise; }
            return { ok: true };
          };
          agent._startTraceRun = async () => null;
          agent._endTraceRun = async (_tab, _run, status, response) => closed.push({ status, response });
          agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
          agent._beginReadCompleteness = async () => null; agent._manageContext = async () => {};
          agent._checkCostAllowance = async () => null; agent._recordCostUsage = async () => null;
          agent._plannerMode = () => 'off'; agent._persistSubmittedTurn = async () => {};
          agent._getTabUrlTitle = async () => ({ tabUrl: 'https://example.test/', tabTitle: 'Owned terminal lab' });
          agent._currentUrl = async () => 'https://example.test/';
          agent._ensureProgressSessionForCurrentTask = async () => {}; agent._maybeEmitAskModeHandoff = async () => {};
          agent._runPlannerIntentGate = async (_tab, enriched) => {
            plans.push(enriched.content);
            return plans.length === 1 ? { proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false }
              : { proceed: true, requestKind: 'respond', responseOnly: true, requiresStateChange: false, requiresSubmission: false };
          };
          agent._completionDocumentStamp = async () => 'owned-terminal-document';
          agent._completionLiveStatusMessages = async () => ['Acknowledgement recorded for release-11'];
          agent.executeTool = async () => ({ success: true, pageContent: 'Acknowledgement recorded for release-11' });
          agent._chatWithCostAllowance = async (_provider, messages) =>
            String(messages[0]?.content || '').startsWith('Evaluate only the observable requirements of the genuine user task')
              ? { content: '{"outcome":"succeeded","reason":"Fresh owned native acknowledgement."}' }
              : provider.chat(messages);
          const settle = agent._settleVerifiedScheduledCompletion;
          agent._settleVerifiedScheduledCompletion = async (...args) => { helperCalls++; return settle.apply(agent, args); };
          // Only the already accepted native tool result is isolated. Both real
          // outer loops, the private verifier/settlement helper, durable wait,
          // AbortController and accepted steering revalidation remain intact.
          agent._executeToolBatch = async (_tab, calls, messages) => {
            assert.equal(calls[0].function.name, 'done');
            agent.setScheduledRunPolicy(tabId, { resumeTaskId: 'owned-terminal-source' });
            agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_1' }, { success: true, dispatched: true });
            agent._recordCompletionToolResult(tabId, 'get_accessibility_tree', {}, { pageContent: 'Acknowledgement recorded for release-11' });
            const pageUrl = 'https://example.test/';
            const verdict = await verifyBrowserCompletion(agent, tabId, { pageUrl, pageState: {}, summary: 'Original terminal summary' });
            assert.equal(verdict.outcome, 'succeeded');
            const result = { done: true, outcome: 'success', summary: 'Original terminal summary',
              verification: { pageUrl, pageState: {}, completionWarning: null, decision: { outcome: verdict.outcome, engine: verdict.engine } } };
            messages.push({ role: 'tool', tool_call_id: calls[0].id, content: agent._wrapUntrusted('done', JSON.stringify(result)) });
            agent._recordCompletionToolResult(tabId, 'done', {}, result);
            terminalPersist = true;
            return { action: 'return', value: result.summary, rawSummary: result.summary };
          };
          const options = { detachedRequestId: 'terminal-boundary-run', askStreamingEnabled: false,
            ...(boundary === 'ordinary' ? {} : { afterVerifiedCompletion: async proof => {
              if (boundary === 'callback') { entered.resolve(); await release.promise; }
              return proof.isCurrent();
            } }),
          };
          const update = (type, data) => updates.push({ type, data });
          const pending = streaming ? agent.processMessageStream(tabId, 'Original task', update, 'act', options)
            : agent.processMessage(tabId, 'Original task', update, 'act', [], options);
          if (boundary !== 'ordinary') {
            await Promise.race([entered.promise, pending.then(value => assert.fail(`Terminal ended before deferred ${boundary}: ${value}`))]);
            if (command === 'steering') assert.equal(agent.steerMessage(tabId, 'Use the corrected task instead',
              { requestId: 'terminal-boundary-run', messageId: 'terminal-correction' }).accepted, true);
            else agent.abort(tabId);
            release.resolve();
          }
          const response = await pending;
          if (command === 'steering') {
            assert.equal(response, 'Corrected task answer');
            assert.equal(plans.length, 2); assert.equal(generations, 2);
            assert.match(plans[1], /Use the corrected task instead/);
            assert.equal(updates.some(update => update.type === 'text' && update.data.content === 'Original terminal summary'), false);
            assert.equal(closed.at(-1).response, 'Corrected task answer');
          } else if (command === 'stop') {
            assert.equal(response, '[Stopped by user]');
            assert.equal(closed.at(-1).status, 'cancelled');
            assert.equal(generations, 1);
            assert.equal(updates.some(update => update.type === 'run_status' && update.data.status === 'cancelled'), true);
          } else {
            assert.equal(response, 'Original terminal summary');
            assert.equal(helperCalls, 0, 'Ordinary terminal returns must not create a new settlement await boundary.');
          }
          assert.equal(agent.isRunning(tabId), false);
        });
      }
    }
  }
}
