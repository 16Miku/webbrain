import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area }, runtime: { getURL: value => `extension://test/${value}` },
};

for (const browser of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  test(`${browser}: completion recognizes bounded submission acknowledgements`, () => {
    const agent = new Agent({});
    for (const text of ['QA submission recorded', 'Your application was accepted', 'Your request has been recorded', 'Response successfully recorded']) {
      assert.equal(agent._completionTextSignalsSuccess(text), true, text);
    }
    for (const text of ['Voice note recorded', 'Recorded submissions: 42', 'Your submission will be recorded',
      'Your submission is being recorded', 'Your submission was not recorded', 'Application rejected',
      'Request could not be accepted', 'Done']) {
      assert.equal(agent._completionTextSignalsSuccess(text), false, text);
    }
    assert.equal(agent._completionTextSignalsSuccess('Done', { allowBare: true }), true);
  });

  test(`${browser}: a fresh inline submission acknowledgement lets the still-visible form finish`, () => {
    const agent = new Agent({});
    const tabId = 710, url = 'https://owned.example.test/form';
    agent.conversationModes.set(tabId, 'act');
    agent._planExecutionGuards.set(tabId, { requiresSubmission: true, requiresStateChange: true });
    agent._beginCompletionInvariant(tabId);
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_5' }, { success: true, verified: true });
    agent._recordCompletionSubmitAttempt(tabId, { isSubmit: true }, 'click_ax', { ref_id: 'ref_5' },
      url, url, { success: true, dispatched: true, verified: true }, 'document-1', 'document-1');
    agent._recordCompletionToolResult(tabId, 'get_accessibility_tree', {}, {
      success: true, pageUrl: url, pageContent: 'status "QA submission recorded" [ref_6] dom_id="result"',
    });
    const pageState = { relevantFormCount: 1, visibleFormCount: 1, openDialogCount: 0, successMessages: [] };
    const evidence = agent._completionSubmissionEvidence(tabId, pageState, url);
    assert.equal(evidence.submit.observedAfterSubmit, true);
    assert.equal(evidence.submit.completionSignalObserved, true, 'The explicit returned read must retain the acknowledgement');
    assert.equal(evidence.verifiedFinalSubmit, true);
    assert.equal(agent._completionPageWarning(tabId, 'The owned submission is recorded.', 'success', pageState, url), null);
  });

  test(`${browser}: a live acknowledgement still requires dispatched, observed, document-bound submission evidence`, () => {
    const agent = new Agent({});
    const tabId = 711, url = 'https://owned.example.test/form';
    const pageState = { relevantFormCount: 1, successMessages: ['QA submission recorded'] };
    assert.equal(agent._completionSubmissionEvidence(tabId, pageState, url).verifiedFinalSubmit, false);
    const submit = { currentUrl: url, dispatched: true, observedAfterSubmit: true, formValidationFailed: false };
    agent._completionSubmitStates.set(tabId, submit);
    assert.equal(agent._completionSubmissionEvidence(tabId, pageState, url).verifiedFinalSubmit, true);
    for (const change of [{ dispatched: false }, { observedAfterSubmit: false }, { formValidationFailed: true }, { currentUrl: `${url}/unrelated` }]) {
      agent._completionSubmitStates.set(tabId, { ...submit, ...change });
      assert.equal(agent._completionSubmissionEvidence(tabId, pageState, url).verifiedFinalSubmit, false, JSON.stringify(change));
    }
  });

  test(`${browser}: fully acknowledged native confirmation survives interrupted observation without certifying completion`, () => {
    const agent = new Agent({}), tabId = 712, url = 'https://owned.example.test/resource';
    const task = 'Delete the owned resource and verify its absence';
    agent.conversationModes.set(tabId, 'act');
    agent._progressTaskKeyHash = () => 'owned-task';
    agent._progressTaskAnchorText = () => task;
    agent._checkAbort = () => false; agent._hasPendingSteering = () => false;
    agent._planExecutionGuards.set(tabId, { enabled: true, requiresSubmission: true, requiresStateChange: true });
    agent._beginCompletionInvariant(tabId);
    agent._lastAxScopes.set(tabId, { pageUrl: url, documentToken: 'owned-document' });
    const result = { success: false, dispatched: true, nativeInputAcknowledged: true,
      observationInterrupted: true, outcomeUnknown: true, retryable: false, error: 'Post-input observation interrupted' };
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_5' }, result);
    const submit = agent._recordCompletionSubmitAttempt(tabId, { isSubmit: true, semanticCommit: true }, 'click_ax',
      { ref_id: 'ref_5' }, url, url, result, 'owned-document', 'owned-document');
    assert.ok(submit, 'Acknowledged input must retain provenance for read-only recovery');
    assert.equal(submit.dispatched, true);
    assert.equal(submit.observedAfterSubmit, false);
    assert.equal(agent.completionInvariants.get(tabId).lastAction.uncertain, true, 'Retaining input provenance must preserve the unknown outcome');
    assert.equal(agent._completionSemanticCommitCurrent(tabId, submit, url), false, 'Native ACK does not prove the resulting state');
    agent._recordCompletionToolResult(tabId, 'get_accessibility_tree', {}, { success: true, pageUrl: url, pageContent: 'Owned resource absent' });
    const observed = agent._completionSubmitStates.get(tabId);
    assert.equal(agent._completionSemanticCommitCurrent(tabId, observed, url), true);
    assert.equal(agent._completionSubmissionEvidence(tabId, { relevantFormCount: 1, successMessages: [] }, url).verifiedFinalSubmit, false,
      'Fresh observation still needs an independent semantic verdict; an unrelated form cannot certify deletion');
    agent._progressTaskKeyHash = () => 'replacement-task';
    assert.equal(agent._completionSemanticCommitCurrent(tabId, observed, url), false);
  });

  test(`${browser}: lost native acknowledgement and cancelled confirmation cannot acquire recovery provenance`, () => {
    for (const change of [{ nativeInputAcknowledged: false }, { nativeInputAcknowledged: undefined },
      { observationInterrupted: false }, { dispatched: false }, { noDispatch: true }, { missingToolResponse: true },
      { cancelled: true }, { formValidationFailed: true }]) {
      const agent = new Agent({}), tabId = 713, url = 'https://owned.example.test/resource';
      agent._beginCompletionInvariant(tabId);
      const result = { success: false, dispatched: true, nativeInputAcknowledged: true,
        observationInterrupted: true, outcomeUnknown: true, error: 'Interrupted', ...change };
      const submit = agent._recordCompletionSubmitAttempt(tabId, { isSubmit: true, semanticCommit: true }, 'click_ax',
        { ref_id: 'ref_5' }, url, url, result, 'owned-document', 'owned-document');
      assert.equal(submit, null, JSON.stringify(change));
      assert.equal(agent._completionSubmitStates.has(tabId), false);
    }
  });
}
