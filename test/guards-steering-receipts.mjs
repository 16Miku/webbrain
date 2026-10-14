import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultDecide, installModelStub } from './semantic-decision-stub.mjs';

// Offline actual-method fixture: browser transport, the page probe result and
// the independent authorization reply are simulated; receipts, accepted
// steering, revision guards, reconciliation and done use the real Agent.
const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: v => `extension://fixture/${v}` } };
const formUrl = 'https://owned.example.test/settings';
const saveUrl = 'https://owned.example.test/settings/save';
const xPost = 'https://x.com/alice/status/900';
let nextTab = 9700;

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { resolveAdapterWorkflowJob } = await import(`../src/${build}/src/agent/adapters.js`);
  const xWorkflow = resolveAdapterWorkflowJob('https://x.com/', 'publish-post');

  async function fixture(task, { pageUrl = formUrl, gate: gateOverrides = {} } = {}) {
    const tab = nextTab++, options = { detachedRequestId: `guards-${tab}`, askStreamingEnabled: false };
    const provider = { model: 'owned-offline', supportsVision: false, supportsTools: true, promptTier: 'full',
      contextWindow: 128000, config: { category: 'local' }, chat() {} };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider });
    agent.conversations.set(tab, [{ role: 'system', content: 'System' }, { role: 'user', content: task }]);
    agent.conversationModes.set(tab, 'act');
    agent._persist = () => {}; agent._persistNow = async () => ({ ok: true });
    agent._ensureProgressSessionForCurrentTask = async () => {};
    agent._currentUrl = async () => pageUrl;
    agent._plannerMode = () => 'off';
    const h = { agent, tab, options, provider, authorize: true, decide: defaultDecide, probe: null,
      gate: { proceed: true, requestKind: 'execute', requiresStateChange: true, requiresSubmission: true, ...gateOverrides } };
    agent._runPlannerIntentGate = async () => h.gate;
    agent._detectLikelySubmitAction = async () => structuredClone(h.probe);
    // The model: fixed-choice decisions about the request, then the
    // consequential-action authorization.
    h.calls = installModelStub(agent, { decide: (kind, question) => h.decide(kind, question),
      authorize: ({ input, authority }) => ({ key: input.key, authorized: h.authorize, latestRequestEvidence: authority.latestAcceptedRequest }) });
    Object.defineProperty(h, 'audits', { get: () => h.calls.filter(call => call.kind === 'authorization') });
    h.decisions = kind => h.calls.filter(call => call.kind === kind);
    await agent._claimRunEntry(tab, 'interactive', options);
    agent._beginSteeringRun(tab, () => {}, options);
    agent._beginCompletionInvariant(tab);
    agent._startPlanExecutionGuard(tab, 'act', h.gate);
    h.steer = async (text, id = `c${Math.random()}`) => {
      assert.equal(agent.steerMessage(tab, text, { requestId: options.detachedRequestId, messageId: id }).accepted, true);
      await agent._revalidatePendingSteering(tab, agent.conversations.get(tab), () => {}, 'act', null, null, options);
      return agent._planExecutionGuards.get(tab);
    };
    h.check = (detected, name = 'click_ax', args = { ref_id: 'ref_9' }) => {
      h.probe = detected;
      return agent._resourceMutationPreSubmitBlock(tab, name, args, structuredClone(detected), provider);
    };
    h.steeringBlock = (detected, name = 'click_ax', args = { ref_id: 'ref_9' }) => agent._steeringPriorSubmissionBlock(tab, name, args, detected);
    h.close = () => { agent._finishSteeringRun(tab); agent._releaseRunEntry(tab); };
    return h;
  }

  const formSubmit = (value, actionUrl = saveUrl) => ({ isSubmit: true, validationSubmitEvidence: 'strong', url: formUrl,
    formRef: 'ref_7', method: 'POST', actionUrl, frameDocumentIdentity: 'owned-form-document',
    fields: [{ label: 'Profile name', type: 'text', value }] });
  // Real receipt: the production recorder, then an explicit page read.
  function savedReceipt(h, { observe = true, afterUrl = formUrl } = {}) {
    h.agent._recordCompletionSubmitAttempt(h.tab, formSubmit('Original'), 'click_ax', { ref_id: 'ref_9' }, formUrl, afterUrl,
      { success: true, dispatched: true, verified: true }, 'owned-form-document', 'owned-form-document');
    if (observe) h.agent._completionSubmitStates.set(h.tab, { ...h.agent._completionSubmitStates.get(h.tab),
      observedAfterSubmit: true, completionSignalObserved: true, currentUrl: afterUrl });
  }
  const snap = (body, account = 'twitter:alice') => ({ complete: true, account,
    posts: [{ complete: true, bodyText: body, attachments: [], context: { kind: 'post', target: null } }] });
  const publicationReceipt = ({ observed = true } = {}) => ({ dispatched: true, actionSequence: 7, mutationKind: 'publish',
    publicationSnapshot: snap('Hello world'), mutationWorkflow: xWorkflow, observedAfterSubmit: observed,
    originatingUrl: 'https://x.com/home', currentUrl: 'https://x.com/home', originatingDocument: 'x-doc',
    workflowBinding: { preDispatchPublishedResourceIdentities: [], socialPublication: { contractKey: 'contract-1', actionId: 'x-post', snapshot: snap('Hello world') } } });
  const publish = (snapshot, resources = []) => ({ isSubmit: true, publicationControl: true, frameDocumentIdentity: 'publish-doc',
    publicationSnapshot: snapshot, reconciliationResources: resources, reconciliationResourceScanComplete: true });
  const record = (url = xPost, body = 'Hello world') => ({ url, complete: true, textValues: [body] });

  test(`${build}: an additive correction cannot replay a verified save; the run can finish honestly`, async () => {
    const h = await fixture('Save the owned profile name as Original and verify the saved result.');
    try {
      savedReceipt(h);
      const guard = await h.steer('Also tell me the exact saved profile name when you are done.');
      assert.equal(guard.steeringPriorSubmission.submittedActionUrl, saveUrl);
      const blocked = await h.check(formSubmit('Original'));
      assert.equal(blocked.actionGuard.reason, 'duplicate_submission');
      assert.match(blocked.error, /already made under the user's earlier instruction and its result was observed/);
      assert.match(blocked.error, /done outcome "partial"/);
      assert.equal(h.audits.length, 0, 'a duplicate never reaches authorization');
      const done = await h.agent._executeToolImpl(h.tab, 'done', { outcome: 'partial', summary: 'The profile name was already saved as Original under your earlier instruction.' });
      assert.equal(done.done, true);
    } finally { h.close(); }
  });

  test(`${build}: a corrected save of the same in-place form needs its observed result and the latest request`, async () => {
    for (const variant of ['authorized', 'unobserved', 'denied', 'navigated-create']) {
      const h = await fixture('Save the owned profile name as Original and verify the saved result.');
      try {
        savedReceipt(h, { observe: variant !== 'unobserved', afterUrl: variant === 'navigated-create' ? 'https://owned.example.test/profiles/42' : formUrl });
        const archived = structuredClone(h.agent._completionSubmitStates.get(h.tab));
        const guard = await h.steer('Change the profile name to Revised and save that correction instead.');
        h.authorize = variant !== 'denied';
        const corrected = formSubmit('Revised');
        const blocked = await h.check(corrected);
        if (variant === 'authorized') {
          assert.equal(blocked, null, variant);
          assert.equal(guard.steeringPriorSubmissionReconciliation.verificationKind, 'form_observation');
          assert.equal(guard.steeringPriorSubmissionReconciliation.resourceUrl, '', 'form observation never invents a resource URL');
          assert.equal(h.steeringBlock(corrected), null, 'the authorized key also clears the steering gate');
          assert.deepEqual(h.audits[0].input.previousSubmission.fields.map(field => field.value), ['Original']);
          assert.equal(h.audits[0].input.proposedSubmission.fields[0].value, 'Revised');
        } else {
          assert.equal(blocked.noDispatch, true, variant);
          assert.equal(blocked.actionGuard.reason, variant === 'denied' ? 'latest_request_not_authorized' : 'prior_effect_unreconciled', variant);
          assert.equal(h.steeringBlock(corrected).noDispatch, true, variant);
        }
        assert.deepEqual(guard.steeringPriorSubmission, archived, 'the original receipt stays immutable');
      } finally { h.close(); }
    }
  });

  test(`${build}: a distinct form after a correction needs a known earlier outcome, not a resource URL`, async () => {
    for (const observe of [true, false]) {
      const h = await fixture('Save the owned profile name as Original.');
      try {
        savedReceipt(h, { observe });
        await h.steer('Also turn on the weekly digest in the notification form and save it.');
        const blocked = await h.check({ ...formSubmit('on', 'https://owned.example.test/notifications/save'),
          fields: [{ label: 'Weekly digest', type: 'checkbox', value: 'checked' }] });
        if (observe) assert.equal(blocked, null);
        else assert.equal(blocked.actionGuard.reason, 'prior_effect_unreconciled');
      } finally { h.close(); }
    }
  });

  test(`${build}: a separately requested post on another platform is not a changed-account replacement`, async () => {
    for (const variant of ['observed', 'unobserved', 'verified-outcome', 'cached', 'same-platform-account', 'duplicate']) {
      const h = await fixture('Post "Hello world" on X.', { pageUrl: 'https://bsky.app/' });
      try {
        const receipt = publicationReceipt({ observed: variant !== 'unobserved' && variant !== 'verified-outcome' && variant !== 'cached' });
        h.agent._completionSubmitStates.set(h.tab, structuredClone(receipt));
        if (variant === 'verified-outcome') h.agent._planExecutionGuards.get(h.tab).socialPublication = { key: 'contract-1', outcomes: { 'x-post': { status: 'verified' } } };
        const guard = await h.steer('Also post the same text on Bluesky.');
        if (variant === 'cached') guard.steeringPriorSubmissionReconciliation = { verified: true, verificationKind: 'resource_identity',
          taskKey: guard.taskKey, actionSequence: 7, resourceUrl: xPost, resourceScopeToken: '', deleted: false, document: 'x-doc' };
        const proposed = variant === 'same-platform-account' ? snap('Hello world', 'twitter:bob')
          : variant === 'duplicate' ? snap('Hello world') : snap('Hello world', 'bluesky:alice.bsky.social');
        const blocked = await h.check(publish(proposed));
        if (['observed', 'verified-outcome', 'cached'].includes(variant)) {
          assert.equal(blocked, null, variant);
          assert.equal(h.audits.at(-1).input.action, 'publish');
          assert.equal(h.steeringBlock(publish(proposed)), null, variant);
        } else {
          assert.equal(blocked.noDispatch, true, variant);
          assert.equal(blocked.actionGuard.reason, { unobserved: 'prior_effect_unreconciled', 'same-platform-account': 'replacement_account_changed',
            duplicate: 'duplicate_publication' }[variant], variant);
          assert.equal(h.audits.length, 0, variant);
        }
      } finally { h.close(); }
    }
  });

  test(`${build}: an unchanged post under a revision reports the earlier publication instead of repeating it`, async () => {
    for (const variant of ['found-on-page', 'not-found', 'verified-outcome']) {
      const h = await fixture('Post "Hello world" on X.', { pageUrl: 'https://x.com/home' });
      try {
        h.agent._completionSubmitStates.set(h.tab, structuredClone(publicationReceipt({ observed: false })));
        if (variant === 'verified-outcome') h.agent._planExecutionGuards.get(h.tab).socialPublication = { key: 'contract-1', outcomes: { 'x-post': { status: 'verified' } } };
        let guard = await h.steer('Also send me the link when you are done.');
        // A second correction that attempts nothing keeps the earlier outcome.
        if (variant === 'verified-outcome') guard = await h.steer('And keep the reply short.');
        const blocked = await h.check(publish(snap('Hello world'), variant === 'found-on-page' ? [record()] : []));
        assert.equal(blocked.actionGuard.reason, 'duplicate_publication', variant);
        assert.equal(blocked.priorPublication.status, variant === 'not-found' ? 'unverified' : 'verified', variant);
        if (variant === 'found-on-page') {
          assert.equal(blocked.priorPublication.url, xPost);
          assert.match(blocked.error, /already published under the user's earlier instruction \(https:\/\/x\.com\/alice\/status\/900\)/);
          assert.equal(guard.steeringPriorSubmissionReconciliation.resourceUrl, xPost);
        }
        if (variant === 'not-found') assert.match(blocked.error, /not verified/);
        assert.equal(h.audits.length, 0, 'a duplicate never reaches authorization');
        assert.equal(guard.verifiedSubmissionEvidence === true, false, 'the earlier receipt does not certify the revision');
      } finally { h.close(); }
    }
  });

  test(`${build}: whether a correction asks to delete the earlier post first is read by a model, in any language`, async t => {
    assert.equal(typeof new Agent({ getActive: () => null })._correctionRequestsResourceDeletion, 'undefined', 'No word list reads corrections');
    const cases = [
      // An edit to the text, in two languages: the corrected post may go out.
      ['Remove the > characters from the post and publish the corrected version.', { choice: 'keep_previous', evidence: '' }, null],
      ['> işaretlerini kaldır ve düzeltilmiş halini paylaş.', { choice: 'keep_previous', evidence: '' }, null],
      // Replacing the earlier post: delete it first.
      ['Delete the old post and publish the corrected one.', { choice: 'delete_previous', evidence: 'Delete the old post' }, 'deletion_prerequisite_unverified'],
      ['eski gönderiyi sil ve yenisini paylaş', { choice: 'delete_previous', evidence: 'eski gönderiyi sil' }, 'deletion_prerequisite_unverified'],
      ['删除旧帖子然后重新发布', { choice: 'delete_previous', evidence: '删除旧帖子' }, 'deletion_prerequisite_unverified'],
      // Unsure is never permission for a second copy.
      ['Delete the post with the > signs.', { choice: 'unclear', evidence: '' }, 'correction_unclear'],
      // No usable answer: nothing goes out, and a later retry asks again.
      ['Post the corrected version.', null, 'authorization_unavailable'],
      ['Post the corrected version.', { choice: 'maybe', evidence: '' }, 'authorization_unavailable'],
    ];
    for (const [correction, answer, reason] of cases) {
      await t.test(`${correction} → ${answer?.choice ?? 'no answer'}`, async () => {
        const h = await fixture('Post "Hello world" on X.', { pageUrl: 'https://x.com/home' });
        try {
          h.agent._completionSubmitStates.set(h.tab, structuredClone(publicationReceipt()));
          await h.steer(correction);
          h.decide = () => answer;
          const blocked = await h.check(publish(snap('Hello world corrected'), [record()]));
          assert.equal(blocked?.actionGuard?.reason || null, reason, correction);
          const [question] = h.decisions('deletion_prerequisite');
          assert.equal(question.request, correction, 'The correction reaches the model as written');
          assert.equal(question.page.previous.link, xPost, 'with the earlier post it may replace');
          assert.match(question.wrapped, /^<untrusted_page_content id="/);
          assert.equal(h.audits.length, reason ? 0 : 1, 'Only a correction that keeps the earlier post reaches authorization');
          if (reason === 'correction_unclear') assert.equal(blocked.retryable, false);
          if (reason === 'authorization_unavailable') {
            assert.notEqual(blocked.retryable, false);
            h.decide = () => ({ choice: 'keep_previous', evidence: '' });
            assert.equal(await h.check(publish(snap('Hello world corrected'), [record()])), null, 'A failed answer is not remembered');
          }
        } finally { h.close(); }
      });
    }
  });

  test(`${build}: after a correction an unidentified target says so; commits still need reconciliation`, async () => {
    const h = await fixture('Save the owned profile name as Original.');
    try {
      savedReceipt(h, { observe: false });
      await h.steer('Use the other spelling.');
      const unresolved = h.steeringBlock(null);
      assert.equal(unresolved.actionGuard.reason, 'target_unresolved');
      assert.match(unresolved.error, /could not be identified/);
      assert.equal(h.steeringBlock({ isSubmit: true, method: 'GET', url: 'https://docs.example/', actionUrl: 'https://docs.example/search',
        fields: [{ label: 'q', name: 'q', type: 'search', value: 'webhooks' }] }), null, 'a same-site search reads only');
      assert.equal(h.steeringBlock({ isSubmit: true, validationSubmitEvidence: 'heuristic', nonCommittingControl: true }), null);
      const commit = h.steeringBlock(formSubmit('Revised'));
      assert.equal(commit.actionGuard.reason, 'prior_effect_unreconciled');
      const keyboard = await h.check({ ...formSubmit('Revised') }, 'press_keys', { key: 'Enter' });
      assert.equal(keyboard.actionGuard.reason, 'click_required');
    } finally { h.close(); }
  });
}
