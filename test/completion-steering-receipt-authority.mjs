import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';

// Offline actual-method fixture: page transport and the independent judge are
// simulated, while dispatch receipts, trusted steering, and done use real code.
const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: v => `extension://fixture/${v}` } };
const url = 'https://owned.example.test/settings';
const originalTask = 'Save the owned profile name as Original and verify the saved result.';
const correction = 'Change the profile name to Revised and save that correction instead.';
let nextTab = 8900;

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const cdp = build === 'chrome' ? (await import('../src/chrome/src/cdp/cdp-client.js')).cdpClient : null;

  async function fixture() {
    const tab = nextTab++, options = { detachedRequestId: `receipt-${tab}`, askStreamingEnabled: false };
    const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
    const savedCdp = cdp ? Object.fromEntries(['attach', 'sendCommand', 'evaluate'].map(k => [k, cdp[k]])) : null;
    const h = { tab, options, value: 'Original', savedValue: 'Original', requests: [], reads: [] };
    const element = (tag, attributes = {}) => ({ tagName: tag, innerText: attributes.text || '',
      value: attributes.value || '', required: true, parentElement: null,
      getAttribute: key => attributes[key] ?? null, closest: () => null,
      getBoundingClientRect: () => ({ width: 200, height: 30 }), querySelector: () => null,
      querySelectorAll: () => [] });
    const input = element('INPUT', { name: 'profile_name', type: 'text' });
    const button = element('BUTTON', { text: 'Save', type: 'submit' });
    const form = element('FORM', { name: 'Owned profile settings', method: 'post' });
    form.querySelectorAll = selector => selector.startsWith('input:not') ? [input]
      : selector.startsWith('button,') ? [button] : [];
    const status = element('DIV', { text: 'Saved successfully.' });
    const tree = () => `form "Owned profile settings" [ref_7]\n textbox "Profile name" value="${h.value}"\n button "Save"\n status "Saved successfully."`;
    const evaluate = code => {
      input.value = h.value;
      return vm.runInNewContext(code, { location: { href: url }, performance: { timeOrigin: 1000 },
        document: { title: 'Owned profile settings', readyState: 'complete', activeElement: input,
          body: { innerText: tree() }, querySelector: () => null,
          querySelectorAll: selector => selector === 'form' ? [form] : /role=status|aria-live/.test(selector) ? [status] : [] },
        window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) }, URL, Map, Set });
    };
    const api = { storage: { local: area, session: area }, runtime: { getURL: v => `extension://fixture/${v}` },
      tabs: { get: async () => ({ id: tab, url, title: 'Owned profile settings' }),
        executeScript: async (_tab, { code }) => [evaluate(code)] } };
    globalThis.chrome = globalThis.browser = api;
    if (cdp) { cdp.attach = async () => {}; cdp.sendCommand = async () => ({});
      cdp.evaluate = async (_tab, code) => ({ result: { value: evaluate(code) } }); }
    h.provider = { model: 'owned-offline', supportsVision: false, supportsTools: true,
      promptTier: 'full', contextWindow: 128000, config: { category: 'local' }, chat() {} };
    const agent = h.agent = new Agent({ getActive: () => h.provider, getProvider: () => h.provider });
    agent.conversations.set(tab, [{ role: 'system', content: 'System' }, { role: 'user', content: originalTask }]);
    agent.conversationModes.set(tab, 'act');
    agent._persist = () => {}; agent._persistNow = async () => ({ ok: true });
    agent._ensureProgressSessionForCurrentTask = async () => {};
    agent._currentUrl = async () => url;
    agent._captureViewportProbe = async () => ({ url, title: 'Owned profile settings', readyState: 'complete' });
    agent._completionDocumentStamp = async () => 'owned-form-document';
    agent._completionLiveStatusMessages = async () => ['Saved successfully.'];
    agent.systemOneContext = () => ({ isCurrent: () => !agent._checkAbort(tab) && !agent._hasUnvalidatedSteering(tab) });
    agent.recordSystemOneVerdict = () => {};
    agent._plannerMode = () => 'off';
    h.gate = { proceed: true, requestKind: 'execute', requiresStateChange: true, requiresSubmission: true };
    agent._runPlannerIntentGate = async () => h.gate;
    agent._chatWithCostAllowance = async (_provider, messages, requestOptions) => {
      assert.equal(requestOptions.tools, undefined);
      h.requests.push(JSON.parse(messages[1].content)[0]);
      // Even a permissive independent judge cannot turn a prior-revision save
      // into proof that the new task submitted its edited fields.
      return { content: JSON.stringify({ outcome: 'succeeded', reason: 'Owned fixture judge verdict.' }) };
    };
    agent.executeTool = async (_tab, name, args) => {
      assert.equal(name, 'get_accessibility_tree'); h.reads.push(args);
      return { success: true, pageUrl: url, pageContent: tree() };
    };
    await agent._claimRunEntry(tab, 'interactive', options);
    agent._beginSteeringRun(tab, () => {}, options);
    agent._beginCompletionInvariant(tab);
    agent._startPlanExecutionGuard(tab, 'act', h.gate);
    const scope = () => agent._lastAxScopes.set(tab, { pageUrl: url, documentToken: 'owned-form-document' });
    const record = (name, args, result, consequential = false) => {
      agent._markPlanExecutionToolCall(tab, name, result, { consequential });
      agent._recordCompletionToolResult(tab, name, args, result);
    };
    h.read = () => { scope(); record('get_accessibility_tree', {}, { success: true, pageUrl: url, pageContent: tree() }); };
    h.edit = () => { h.value = 'Revised'; scope(); record('set_field', { ref_id: 'ref_8', value: h.value }, { success: true, dispatched: true }, true); h.read(); };
    h.save = () => {
      scope(); const result = { success: true, dispatched: true, verified: true };
      record('click_ax', { ref_id: 'ref_9' }, result, true);
      agent._recordCompletionSubmitAttempt(tab, { isSubmit: true, formRef: 'ref_7', url }, 'click_ax',
        { ref_id: 'ref_9' }, url, url, result, 'owned-form-document', 'owned-form-document');
      h.savedValue = h.value; h.read();
    };
    h.steer = async () => {
      assert.equal(agent.steerMessage(tab, correction, { requestId: options.detachedRequestId, messageId: 'profile-correction' }).accepted, true);
      assert.equal((await agent._revalidatePendingSteering(tab, agent.conversations.get(tab), () => {}, 'act', null, null, options)).changed, true);
    };
    h.done = () => agent._executeToolImpl(tab, 'done', { outcome: 'success', summary: `The profile name was saved as ${h.value}.` });
    h.close = () => { agent._finishSteeringRun(tab); agent._releaseRunEntry(tab);
      globalThis.chrome = savedChrome; globalThis.browser = savedBrowser; if (cdp) Object.assign(cdp, savedCdp); };
    h.save(); return h;
  }

  for (const legacy of [false, true]) test(`${build}: ${legacy ? 'legacy' : 'bound'} save receipt survives steering but cannot complete an unsaved edit`, async () => {
    const h = await fixture(), { agent, tab } = h;
    try {
      if (legacy) delete agent._completionSubmitStates.get(tab).taskKey;
      const original = structuredClone(agent._completionSubmitStates.get(tab));
      assert.equal(agent._currentCompletionSubmitState(tab), agent._completionSubmitStates.get(tab));
      assert.equal((await h.done()).done, true, 'Unchanged normal and legacy completion still succeed.');
      await h.steer(); h.edit();
      assert.equal(agent.completionInvariants.get(tab).verificationDebt, false, 'The unsaved edited form was explicitly observed.');
      assert.equal(agent._completionDoneBlock(tab, 'done', { outcome: 'success' }), null);
      const physical = agent._completionSubmitStates.get(tab), guard = agent._planExecutionGuards.get(tab);
      assert.equal(physical.dispatched, true); assert.equal(physical.taskKey, original.taskKey);
      // The correction adds only the list of platforms the task attempted.
      assert.deepEqual(guard.steeringPriorSubmission, { ...original, taskAttemptPlatforms: ['example.test'] });
      assert.deepEqual(guard.steeringMutationReceipts, [original]);
      assert.equal(agent._currentCompletionSubmitState(tab), null);
      const evidence = agent._completionSubmissionEvidence(tab, { relevantFormCount: 1, successMessages: ['Saved successfully.'] }, url);
      assert.equal(evidence.submit, null); assert.equal(evidence.verifiedFinalSubmit, false);
      h.reads.length = 0;
      const rejected = await h.done();
      assert.equal(rejected.blockedDone, true); assert.equal(rejected.completionPageBlock, true);
      assert.notEqual(guard.verifiedSubmissionEvidence, true);
      assert.match(h.requests.at(-1).action, /"submit":null/);
      assert.ok(h.reads.every(args => args.ref_id === undefined), 'The old receipt cannot select the revised judge form scope.');
      assert.equal(agent._completionSubmitStates.get(tab), physical, 'Completion cannot erase the physical reconciliation receipt.');
      assert.equal(h.savedValue, 'Original');
      h.save();
      const fresh = agent._completionSubmitStates.get(tab);
      assert.equal(fresh.taskKey, guard.taskKey); assert.notEqual(fresh.taskKey, original.taskKey);
      assert.equal(agent._currentCompletionSubmitState(tab), fresh);
      assert.equal((await h.done()).done, true); assert.equal(guard.verifiedSubmissionEvidence, true);
      assert.equal(h.savedValue, 'Revised'); assert.deepEqual(guard.steeringPriorSubmission, { ...original, taskAttemptPlatforms: ['example.test'] });
      assert.deepEqual(guard.steeringMutationReceipts, [original], 'A new save leaves the prior receipt available for reconciliation.');
    } finally { h.close(); }
  });

  for (const revised of [false, true]) test(`${build}: Continue preserves ${revised ? 'prior-revision exclusion' : 'same-task completion'} and receipt authority`, async () => {
    const h = await fixture(), { agent, tab } = h;
    try {
      const originalKey = agent._completionSubmitStates.get(tab).taskKey;
      if (revised) { await h.steer(); h.edit(); }
      agent._storeContinuationExecutionEvidence(tab);
      assert.equal(agent._continuationExecutionEvidence.get(tab).completionSubmitState.taskKey, originalKey);
      const beforeRun = agent.completionInvariants.get(tab).runToken;
      agent._beginCompletionInvariant(tab);
      const continued = agent._startPlanExecutionGuard(tab, 'act', h.gate, { trustedContinuation: true });
      assert.notEqual(agent.completionInvariants.get(tab).runToken, beforeRun);
      assert.equal(agent._completionSubmitStates.get(tab).taskKey, originalKey);
      if (revised) {
        assert.ok(continued.steeringPriorSubmission);
        assert.equal(agent._currentCompletionSubmitState(tab), null);
        assert.equal((await h.done()).blockedDone, true); assert.notEqual(continued.verifiedSubmissionEvidence, true);
        h.save(); assert.equal((await h.done()).done, true);
      } else {
        assert.ok(agent._currentCompletionSubmitState(tab));
        assert.equal((await h.done()).done, true); assert.equal(continued.verifiedSubmissionEvidence, true);
      }
    } finally { h.close(); }
  });
}
