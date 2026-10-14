import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stubPageTextReadings } from './semantic-decision-stub.mjs';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area }, runtime: { getURL: value => `extension://test/${value}` },
};

for (const browser of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  // A submit on an inline form leaves the form on screen; a status the page
  // showed afterwards can still prove it. What the status says is read by a
  // model in any language, never matched against words.
  function inlineSubmit(agent, tabId, url, status) {
    agent.conversationModes.set(tabId, 'act');
    agent._planExecutionGuards.set(tabId, { requiresSubmission: true, requiresStateChange: true });
    agent._beginCompletionInvariant(tabId);
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_5' }, { success: true, verified: true });
    agent._recordCompletionSubmitAttempt(tabId, { isSubmit: true }, 'click_ax', { ref_id: 'ref_5' },
      url, url, { success: true, dispatched: true, verified: true }, 'document-1', 'document-1');
    agent._recordCompletionToolResult(tabId, 'get_accessibility_tree', {}, {
      success: true, pageUrl: url, pageContent: `form "Başvuru" [ref_2]\n status "${status}" [ref_6] dom_id="result"`,
    });
  }

  test(`${browser}: a status observed after an inline submit counts only as a model reads it, in any language`, async () => {
    const url = 'https://owned.example.test/form';
    const pageState = () => ({ relevantFormCount: 1, visibleFormCount: 1, openDialogCount: 0, liveRegionMessages: [] });
    const cases = [
      ['Başvurunuz alındı', 'success', true],
      ['Başvurunuz reddedildi', 'error', false],
      ['Başvurunuz kaydediliyor…', 'other', false],
      ['Başvurunuz alındı', null, false],
    ];
    for (const [index, [status, reading, verified]] of cases.entries()) {
      const agent = new Agent({});
      const tabId = 720 + index;
      inlineSubmit(agent, tabId, url, status);
      const before = pageState();
      assert.equal(agent._completionSubmissionEvidence(tabId, before, url).verifiedFinalSubmit, false,
        'An unread status proves nothing');
      const asked = stubPageTextReadings(agent, (kind, item) => (kind === 'status_message' && item.text === status ? reading : null));
      const state = pageState();
      await agent._readCompletionStatusTexts(tabId, state);
      assert.deepEqual(asked.map(item => [item.kind, item.text]), [['status_message', status]]);
      assert.equal(agent._completionSubmissionEvidence(tabId, state, url).verifiedFinalSubmit, verified, `${status}: ${reading}`);
      assert.equal(agent._completionPageWarning(tabId, 'Submitted.', 'success', state, url) === null, verified, `${status}: ${reading}`);
    }
  });

  test(`${browser}: live messages at completion count only as a model reads them`, async () => {
    const url = 'https://owned.example.test/form';
    const agent = new Agent({});
    const tabId = 730;
    inlineSubmit(agent, tabId, url, '');
    const live = ['Votre demande a été enregistrée.', 'Chargement…'];
    const asked = stubPageTextReadings(agent, (kind, item) => (item.text === live[0] ? 'success' : 'other'));
    const state = { relevantFormCount: 1, liveRegionMessages: live };
    await agent._readCompletionStatusTexts(tabId, state);
    assert.deepEqual(asked.map(item => item.text), live);
    assert.deepEqual(state.successMessages, [live[0]]);
    assert.equal(agent._completionSubmissionEvidence(tabId, state, url).verifiedFinalSubmit, true);
    // Read once: the remembered readings answer the next completion check.
    await agent._readCompletionStatusTexts(tabId, { relevantFormCount: 1, liveRegionMessages: live });
    assert.equal(asked.length, live.length);
  });

  test(`${browser}: a run with nothing to prove does not read status messages`, async () => {
    const agent = new Agent({});
    const tabId = 731;
    agent._planExecutionGuards.set(tabId, { requiresSubmission: false, requiresStateChange: false });
    const asked = stubPageTextReadings(agent, () => 'success');
    const state = { liveRegionMessages: ['Saved'] };
    await agent._readCompletionStatusTexts(tabId, state);
    assert.deepEqual(asked, []);
    assert.deepEqual(state.successMessages, []);
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
