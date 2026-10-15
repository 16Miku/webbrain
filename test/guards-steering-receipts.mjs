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

  // Your trace: a Mastodon post whose Publish click was delivered while the
  // page moved on, then "ok now on X". WebBrain reads account names only on
  // X and Bluesky, so the site each post is made on decides whether the
  // second post is on another platform.
  const mastodonCompose = { isSubmit: true, validationSubmitEvidence: 'strong', url: 'https://mastoturk.org/publish',
    host: 'mastoturk.org', formRef: 'ref_5', method: 'POST', actionUrl: '', frameDocumentIdentity: 'https://mastoturk.org/publish|1',
    fields: [{ label: 'Aklında ne var?', type: 'textarea', value: 'WebBrain test gönderisi' }] };
  const formOn = url => ({ ...mastodonCompose, url, host: new URL(url).hostname, frameDocumentIdentity: `${url}|1` });
  const publishOn = (url, account) => ({ ...publish(snap('WebBrain test post', account)), url, host: new URL(url).hostname });
  const deliveredUnobserved = { success: false, dispatched: true, outcomeUnknown: true, nativeInputAcknowledged: true };

  test(`${build}: a post on another site after a correction goes ahead once the earlier result is known, without an account reader there`, async () => {
    const cases = {
      // The trace itself, with the next automatic screenshot read after it.
      'mastodon-then-x': { earlier: mastodonCompose, at: 'https://mastoturk.org/publish', read: true,
        now: publishOn('https://x.com/home', 'twitter:emresokullu'), allowed: true },
      // Nothing was read after the Mastodon click: its result is unknown.
      'mastodon-unread': { earlier: mastodonCompose, at: 'https://mastoturk.org/publish', read: false,
        now: publishOn('https://x.com/home', 'twitter:emresokullu'), reason: 'prior_effect_unreconciled', guidance: /has not been observed yet/ },
      // An X post, then Bluesky whose account could not be read.
      'x-then-bluesky': { earlierReceipt: true, read: true, now: publishOn('https://bsky.app/', ''), allowed: true },
      // The same platform stays the same, whatever the host is called.
      'twitter-form-then-x': { earlier: formOn('https://mobile.twitter.com/settings/profile'), at: 'https://mobile.twitter.com/settings/profile',
        read: true, now: publishOn('https://x.com/home', 'twitter:alice'), reason: 'prior_effect_unreconciled', guidance: /on this platform/ },
      'same-site-www': { earlier: formOn('https://www.mastoturk.org/publish'), at: 'https://www.mastoturk.org/publish', read: true,
        now: publishOn('https://mastoturk.org/publish', ''), reason: 'prior_effect_unreconciled', guidance: /on this platform/ },
      'x-then-x-unread-account': { earlierReceipt: true, read: true, now: publishOn('https://x.com/home', ''), reason: 'replacement_account_changed' },
    };
    for (const [variant, spec] of Object.entries(cases)) {
      const h = await fixture('go to mastoturk.org and try to post something', { pageUrl: spec.now.url });
      try {
        // An X post's receipt, as the X tests above build it, carries its own
        // page read; the others are recorded the way a real click records them.
        if (spec.earlierReceipt) h.agent._completionSubmitStates.set(h.tab, structuredClone(publicationReceipt({ observed: spec.read })));
        else h.agent._recordCompletionSubmitAttempt(h.tab, spec.earlier, 'click_ax', { ref_id: 'ref_50' }, spec.at,
          spec.at.replace(/\/[^/]*$/, '/home'), deliveredUnobserved, 'earlier-doc', 'earlier-doc');
        const guard = await h.steer('ok now on X');
        assert.equal(guard.steeringPriorSubmission?.dispatched, true, variant);
        // The next page read, here the automatic screenshot after the
        // navigation, is what makes the earlier result known.
        if (spec.read && !spec.earlierReceipt) h.agent._recordCompletionToolResult(h.tab, 'auto_screenshot', {},
          { success: true, method: 'image_attach', _attachImage: true, pageUrl: spec.now.url });
        const blocked = await h.check(spec.now);
        if (spec.allowed) {
          assert.equal(blocked, null, `${variant}: ${blocked?.error}`);
          assert.equal(guard.steeringPriorSubmissionReconciliation.verificationKind, 'cross_platform', variant);
          assert.equal(guard.steeringPriorSubmissionReconciliation.resourceUrl, '', variant);
          assert.equal(h.audits.length, 1, variant);
          assert.equal(h.audits[0].input.action, 'publish', variant);
          assert.equal(h.steeringBlock(spec.now), null, `${variant}: the steering gate accepts the authorized post`);
        } else {
          assert.equal(blocked?.noDispatch, true, variant);
          assert.equal(blocked.actionGuard.reason, spec.reason, `${variant}: ${blocked.error}`);
          if (spec.guidance) assert.match(blocked.error, spec.guidance, variant);
          assert.equal(h.audits.length, 0, variant);
          assert.equal(h.steeringBlock(spec.now)?.noDispatch, true, variant);
        }
      } finally { h.close(); }
    }
  });

  // An earlier post on the same platform still counts when something on
  // another site came after it: "Post 'Hello wrold' on X, then sign me up for
  // the newsletter", then "fix the typo in the tweet".
  const typoReceipt = () => ({ ...publicationReceipt(), publicationSnapshot: snap('Hello wrold'),
    workflowBinding: { preDispatchPublishedResourceIdentities: [], socialPublication: { contractKey: 'contract-1', actionId: 'x-post', snapshot: snap('Hello wrold') } } });
  const newsletterReceipt = (urls = true) => ({ dispatched: true, actionSequence: 9, mutationKind: 'submit',
    originatingUrl: urls ? 'https://news.example.test/subscribe' : '', currentUrl: urls ? 'https://news.example.test/thanks' : '',
    originatingDocument: 'news-doc', submittedActionUrl: urls ? 'https://news.example.test/subscribe/save' : '',
    submittedFields: [{ label: 'Email', type: 'email', value: 'alice@example.test' }], observedAfterSubmit: true });

  test(`${build}: an earlier post on the same platform holds a new one there, whatever came after it`, async () => {
    const cases = {
      // The earlier X post is not on the page: it has to be found first.
      'x-form-x-unread': { earlier: [typoReceipt(), newsletterReceipt()], now: publishOn('https://x.com/home', 'twitter:alice'),
        reason: 'prior_effect_unreconciled', guidance: /on this platform/ },
      // Found on the page, the X post itself is reconciled, not the form.
      'x-form-x-found': { earlier: [typoReceipt(), newsletterReceipt()], now: { ...publishOn('https://x.com/home', 'twitter:alice'),
        reconciliationResources: [record(xPost, 'Hello wrold')] }, allowed: 'resource_identity' },
      // Bluesky after an X post and a form elsewhere is another platform.
      'x-form-bluesky': { earlier: [typoReceipt(), newsletterReceipt()], now: publishOn('https://bsky.app/', 'bluesky:alice.bsky.social'),
        allowed: 'cross_platform' },
      // An attempt whose site is unknown could have been on this platform.
      'unknown-site-x': { earlier: [newsletterReceipt(false)], now: publishOn('https://x.com/home', 'twitter:alice'),
        reason: 'prior_effect_unreconciled', guidance: /on this platform/ },
    };
    for (const [variant, spec] of Object.entries(cases)) {
      const h = await fixture('Post "Hello wrold" on X, then sign me up for the newsletter.', { pageUrl: spec.now.url });
      try {
        // As the real recorder keeps them: every attempt of the revision, the
        // latest also as the live receipt.
        h.agent._planExecutionGuards.get(h.tab).dispatchedAttempts = structuredClone(spec.earlier);
        h.agent._completionSubmitStates.set(h.tab, structuredClone(spec.earlier.at(-1)));
        const guard = await h.steer(variant === 'x-form-bluesky' ? 'now post it on Bluesky too' : 'fix the typo in the tweet');
        assert.deepEqual(guard.steeringMutationReceipts.map(receipt => receipt.actionSequence), spec.earlier.map(receipt => receipt.actionSequence), variant);
        const blocked = await h.check(spec.now);
        if (spec.allowed) {
          assert.equal(blocked, null, `${variant}: ${blocked?.error}`);
          assert.equal(guard.steeringPriorSubmissionReconciliation.verificationKind, spec.allowed, variant);
          if (spec.allowed === 'resource_identity') {
            assert.equal(guard.steeringPriorSubmissionReconciliation.resourceUrl, xPost, variant);
            assert.equal(guard.steeringPriorSubmissionReconciliation.actionSequence, 7, `${variant}: the X post, not the form`);
            // The deletion question describes the X post, not the form.
            assert.deepEqual([h.decisions('deletion_prerequisite').at(-1).page.previous.link,
              h.decisions('deletion_prerequisite').at(-1).page.previous.snapshot.account], [xPost, 'twitter:alice'], variant);
          }
        } else {
          assert.equal(blocked?.noDispatch, true, variant);
          assert.equal(blocked.actionGuard.reason, spec.reason, `${variant}: ${blocked.error}`);
          assert.match(blocked.error, spec.guidance, variant);
          assert.equal(h.audits.length, 0, variant);
        }
      } finally { h.close(); }
    }
  });

  test(`${build}: every dispatched attempt of a revision is archived at the correction, the live receipt last`, async () => {
    const h = await fixture('Post on X, then sign me up for the newsletter.', { pageUrl: 'https://x.com/home' });
    try {
      const xNow = body => ({ ...publish(snap(body, 'twitter:alice')), url: 'https://x.com/home', host: 'x.com' });
      h.agent._recordCompletionSubmitAttempt(h.tab, xNow('Hello wrold'), 'click_ax', { ref_id: 'ref_1' },
        'https://x.com/home', 'https://x.com/home', { success: true, dispatched: true }, 'x-doc', 'x-doc');
      // A preparation the browser refused sends nothing and is not archived.
      h.agent._recordCompletionSubmitAttempt(h.tab, formOn('https://news.example.test/subscribe'), 'click_ax', { ref_id: 'ref_2' },
        'https://news.example.test/subscribe', 'https://news.example.test/subscribe', { success: false, dispatched: false, noDispatch: true }, 'news-doc', 'news-doc');
      h.agent._recordCompletionSubmitAttempt(h.tab, formOn('https://news.example.test/subscribe'), 'click_ax', { ref_id: 'ref_2' },
        'https://news.example.test/subscribe', 'https://news.example.test/thanks', { success: true, dispatched: true }, 'news-doc', 'news-doc');
      assert.deepEqual(h.agent._planExecutionGuards.get(h.tab).dispatchedAttempts.map(receipt => receipt.originatingUrl),
        ['https://x.com/home', 'https://news.example.test/subscribe']);
      h.agent._completionSubmitStates.set(h.tab, { ...h.agent._completionSubmitStates.get(h.tab), observedAfterSubmit: true });
      const guard = await h.steer('fix the typo in the tweet');
      assert.deepEqual(guard.steeringMutationReceipts.map(receipt => receipt.originatingUrl),
        ['https://x.com/home', 'https://news.example.test/subscribe']);
      assert.equal(guard.steeringMutationReceipts.at(-1).observedAfterSubmit, true, 'The live receipt replaces its archived copy');
      assert.deepEqual(guard.dispatchedAttempts || [], [], 'The revision starts its own list');
      // The corrected post is held to the X post; the same post again is a
      // duplicate.
      const blocked = await h.check(xNow('Hello world'));
      assert.equal(blocked.actionGuard.reason, 'prior_effect_unreconciled', blocked.error);
      assert.match(blocked.error, /on this platform/);
      assert.equal((await h.check(xNow('Hello wrold'))).actionGuard.reason, 'duplicate_publication');
    } finally { h.close(); }
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
