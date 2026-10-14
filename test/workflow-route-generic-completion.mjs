import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { fixtureFixedChoiceReply } from './semantic-decision-stub.mjs';

// Offline actual-method protocol fixture. Only page capture/transport and the
// independent provider are simulated; no browser, network, image, or upload opens.
const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: v => `extension://fixture/${v}` } };
const profileUrl = 'https://studio.youtube.com/channel/owned-qa/editing/profile';
const videoUrl = 'https://studio.youtube.com/video/owned-qa/edit';
const task = 'Upload the owned PNG as this channel profile picture and verify the saved result.';

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const cdp = build === 'chrome' ? (await import('../src/chrome/src/cdp/cdp-client.js')).cdpClient : null;

  async function fixture({ url = profileUrl, dispatch = true, outcome = 'succeeded', duringJudge = null, postRead = true,
    semanticCommit = false, dispatchResult = null } = {}) {
    const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
    const savedCdp = cdp ? Object.fromEntries(['attach', 'sendCommand', 'evaluate'].map(k => [k, cdp[k]])) : null;
    const h = { url, key: 'owned-profile-task', stopped: false, steering: false, identityEpoch: 1000,
      tree: 'main "Channel profile"\n image "Owned profile picture"\n button "Publish" disabled\n status "All changes saved."', judges: 0, reads: 0 };
    const status = { innerText: 'All changes saved.', hidden: false, parentElement: null,
      getBoundingClientRect: () => ({ width: 200, height: 20 }), getAttribute: () => null };
    const context = () => ({ location: { href: h.url }, performance: { timeOrigin: h.identityEpoch },
      document: { title: 'Owned profile', readyState: 'complete', body: { innerText: h.tree },
        querySelector: () => null, querySelectorAll: selector => /role=status|aria-live/.test(selector) ? [status] : [] },
      window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), URL, Map, Set });
    const evaluate = code => vm.runInNewContext(code, context());
    const api = { storage: { local: area, session: area }, runtime: { getURL: v => `extension://fixture/${v}` },
      tabs: { get: async () => ({ id: 51, url: h.url }), executeScript: async (_tab, { code }) => [evaluate(code)] } };
    globalThis.chrome = globalThis.browser = api;
    if (cdp) { cdp.attach = async () => {}; cdp.sendCommand = async () => ({}); cdp.evaluate = async (_tab, code) => ({ result: { value: evaluate(code) } }); }
    h.provider = { model: 'owned-offline', supportsVision: false, config: { category: 'local' }, chat() {} };
    const agent = h.agent = new Agent({ getActive: () => h.provider });
    agent.useSiteAdapters = true;
    agent.conversationModes.set(51, 'act');
    agent._progressTaskKeyHash = () => h.key;
    agent._progressTaskAnchorText = () => task;
    agent._captureViewportProbe = async () => ({ url: h.url, title: 'Owned profile', readyState: 'complete' });
    agent.systemOneContext = () => ({ isCurrent: () => !h.stopped && !h.steering && h.key === 'owned-profile-task' });
    agent._checkAbort = () => h.stopped;
    agent._hasPendingSteering = () => h.steering;
    agent.recordSystemOneVerdict = () => {};
    agent._chatWithCostAllowance = async (_provider, messages, options) => {
      // The page's status message is read with its own fixed-choice question,
      // the way a model would read this fixture's "All changes saved.".
      const reading = fixtureFixedChoiceReply(messages);
      if (reading) { h.readings = (h.readings || 0) + 1; return { content: reading }; }
      h.judges++;
      assert.equal(options.tools, undefined, 'The independent completion provider must never receive action tools.');
      assert.match(messages[0].content, /^Evaluate only the observable requirements/);
      const [info, observation] = JSON.parse(messages[1].content);
      assert.match(observation.observation, /Owned profile picture/);
      assert.match(info.page_status_messages, /All changes saved/);
      await duringJudge?.(h);
      return { content: JSON.stringify({ outcome, reason: 'Fresh bounded owned profile result.' }) };
    };
    const siteWorkflow = agent._resolvePlannerSiteWorkflow(url, { request_kind: 'execute', site_job: 'update-metadata' });
    h.guard = agent._startPlanExecutionGuard(51, 'act', { requestKind: 'execute', siteWorkflow, siteWorkflowUrl: url,
      requiresStateChange: true, requiresSubmission: true });
    h.guard.workflowMetadataRequirementsResolved = true;
    agent._beginCompletionInvariant(51);
    const scope = () => agent._lastAxScopes.set(51, { pageUrl: h.url, documentToken: 'owned-profile-document' });
    const record = (name, args, result, consequential = false) => {
      agent._markPlanExecutionToolCall(51, name, result, { consequential });
      agent._recordCompletionToolResult(51, name, args, result);
    };
    scope();
    if (dispatch) {
      const result = dispatchResult || { success: true, tag: 'button', name: 'Publish', verified: true };
      // After a dispatched click in a run that has to prove a submission, the
      // pipeline reads what the clicked control's caption means, as a model
      // would read this fixture's "Publish".
      await agent._readControlEffect(51, agent._controlCaption('click_ax', { ref_id: 'ref_51' }, result));
      record('click_ax', { ref_id: 'ref_51' }, result, true);
      h.submit = agent._recordCompletionSubmitAttempt(51, semanticCommit ? { isSubmit: true, semanticCommit: true } : null,
        'click_ax', { ref_id: 'ref_51' }, url, url, result,
        'owned-profile-document', 'owned-profile-document');
      if (!dispatchResult) assert.equal(h.submit?.dispatched, true, 'The actual post-result Publish classifier arms the genuine submit state.');
    }
    h.read = () => { scope(); record('get_accessibility_tree', {}, { success: true, pageUrl: h.url, pageContent: h.tree }); };
    if (postRead) h.read();
    agent.executeTool = async (_tab, name) => {
      assert.equal(name, 'get_accessibility_tree'); h.reads++;
      return { success: true, pageUrl: h.url, pageContent: h.tree };
    };
    h.done = () => agent._executeToolImpl(51, 'done', { outcome: 'success', summary: 'The owned channel profile picture was saved.' });
    h.close = () => { globalThis.chrome = savedChrome; globalThis.browser = savedBrowser; if (cdp) Object.assign(cdp, savedCdp); };
    return h;
  }

  test(`${build}: unrelated video metadata contract cannot block an independently verified form-less profile Publish`, async () => {
    const h = await fixture();
    try {
      const result = await h.done();
      assert.equal(result.done, true);
      assert.equal(result.outcome, 'success');
      assert.equal(h.judges, 1, 'Normal completion must still call the independent provider.');
      assert.equal(h.reads, 2, 'The exact judge evidence is refreshed after its await.');
      assert.equal(h.guard.verifiedSubmissionEvidence, true, 'The normal independent verdict and actual Publish/read must earn the applicable generic certificate.');
      assert.equal(h.guard.siteWorkflow, null, 'A planner-selected video contract is inapplicable to this channel URL.');
      assert.equal(h.agent._executionEvidenceSatisfied(h.guard), true);
      assert.equal(h.agent._planOnlyTerminalDecision(51, result.summary, { viaDone: true, outcome: result.outcome }), null);
    } finally { h.close(); }
  });

  test(`${build}: an applicable video contract retains nonempty exact metadata readback requirements`, async () => {
    const h = await fixture({ url: videoUrl });
    try {
      assert.equal(h.guard.siteWorkflow?.job.id, 'update-metadata');
      const result = await h.done();
      assert.equal(result.done, true, 'The provider verdict alone is not the structured job certificate.');
      assert.equal(h.guard.verifiedSubmissionEvidence, false);
      assert.equal(h.agent._executionEvidenceSatisfied(h.guard), false);
      assert.equal(h.agent._workflowMetadataRequirementsMatchInventory([], { complete: true, documents: { root: { complete: true, rootObservationSequence: 10 } }, items: [] }, 1), false);
    } finally { h.close(); }
  });

  for (const outcome of ['failed', 'pending']) test(`${build}: ${outcome} independent verdict cannot certify profile completion`, async () => {
    const h = await fixture({ outcome });
    try { const result = await h.done(); assert.equal(result.blockedDone, true); assert.notEqual(h.guard.verifiedSubmissionEvidence, true); }
    finally { h.close(); }
  });

  test(`${build}: an uncertain judgment cannot certify a native semantic commit from a saved-status message`, async () => {
    const h = await fixture({ outcome: 'uncertain', semanticCommit: true });
    try { await h.done(); assert.notEqual(h.guard.verifiedSubmissionEvidence, true);
      assert.equal(h.agent._executionEvidenceSatisfied(h.guard), false);
      assert.ok(h.agent._planOnlyTerminalDecision(51, 'The profile was saved.', { viaDone: true, outcome: 'success' })); }
    finally { h.close(); }
  });

  test(`${build}: unobserved editor changes retain the actual pre-done verification-debt block`, async () => {
    const h = await fixture();
    try { h.agent._recordCompletionToolResult(51, 'set_field', { ref_id: 'ref_52', value: 'Another value' },
      { success: true, dispatched: true, verified: true });
      assert.ok(h.agent._completionDoneBlock(51, 'done', { outcome: 'success' }));
      assert.equal(h.judges, 0, 'The normal pre-done debt gate rejects completion before the independent provider is called.');
      assert.notEqual(h.guard.verifiedSubmissionEvidence, true); }
    finally { h.close(); }
  });

  for (const [kind, options, mutate] of [
    ['missing actual submit', { dispatch: false }, null],
    ['missing post-submit observation', { postRead: false }, null],
    ['explicit no-dispatch', { dispatchResult: { success: true, tag: 'button', name: 'Publish', noDispatch: true, dispatched: false } }, null],
    ['wrong current route', {}, h => { h.url = 'https://studio.youtube.com/channel/another/editing/profile'; }],
    ['task changes during judge', { duringJudge: h => { h.key = 'different task'; } }, null],
    ['document changes during judge', { duringJudge: h => { h.identityEpoch++; } }, null],
    ['evidence changes during judge', { duringJudge: h => { h.tree += '\nalert "Save rejected"'; } }, null],
    ['Stop during judge', { duringJudge: h => { h.stopped = true; } }, null],
    ['steering during judge', { duringJudge: h => { h.steering = true; } }, null],
  ]) test(`${build}: ${kind} cannot grant generic submission completion`, async () => {
    const h = await fixture(options);
    try { mutate?.(h); const result = await h.done(); assert.notEqual(h.guard.verifiedSubmissionEvidence, true); assert.equal(h.agent._executionEvidenceSatisfied(h.guard), false);
      if (options.duringJudge) assert.notEqual(result.done, true); }
    finally { h.close(); }
  });
}
