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

  // A restart is a new Agent given the conversation as it was saved.
  async function fixture(task, { pageUrl = formUrl, gate: gateOverrides = {}, messages = null, tab: fixedTab = null } = {}) {
    const tab = fixedTab ?? nextTab++, options = { detachedRequestId: `guards-${tab}`, askStreamingEnabled: false };
    const provider = { model: 'owned-offline', supportsVision: false, supportsTools: true, promptTier: 'full',
      contextWindow: 128000, config: { category: 'local' }, chat() {} };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider });
    agent.conversations.set(tab, messages ? JSON.parse(JSON.stringify(messages))
      : [{ role: 'system', content: 'System' }, { role: 'user', content: task }]);
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
    // WebBrain restarted: only the saved conversation is left.
    h.restart = async (extra = []) => {
      h.close();
      return fixture(task, { pageUrl, gate: gateOverrides, tab, messages: [...agent.conversations.get(tab), ...extra] });
    };
    // A page read, the way the automatic screenshot after an action reads one.
    h.read = (url = pageUrl) => agent._recordCompletionToolResult(tab, 'auto_screenshot', {},
      { success: true, method: 'image_attach', _attachImage: true, pageUrl: url });
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
        // Only the list of platforms the task attempted is added, at the correction.
        assert.deepEqual(guard.steeringPriorSubmission, { ...archived, taskAttemptPlatforms: ['example.test'] }, 'the original receipt stays immutable');
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

  // X and Bluesky composers are the publication controls WebBrain reads; a
  // Mastodon composer or a newsletter is an ordinary form.
  const xPublish = (body, account = 'twitter:alice') => ({ ...publish(snap(body, account)), url: 'https://x.com/home', host: 'x.com' });
  const bskyPublish = (body, account = 'bluesky:alice.bsky.social') => ({ ...publish(snap(body, account)), url: 'https://bsky.app/', host: 'bsky.app' });
  const newsletter = () => ({ ...formOn('https://newsletter.test/subscribe'), actionUrl: 'https://newsletter.test/subscribe/save',
    fields: [{ label: 'Email', type: 'email', value: 'alice@example.test' }] });
  const xSearch = () => ({ ...formOn('https://x.com/explore'), nonCommittingControl: true, method: 'GET',
    fields: [{ label: 'Search', type: 'search', value: 'webbrain' }] });
  // An action's result, recorded the way every action's result is.
  let nextRef = 60;
  const attempt = (h, detected, result = { success: true, dispatched: true }) => h.agent._recordCompletionSubmitAttempt(h.tab,
    detected, 'click_ax', { ref_id: `ref_${nextRef++}` }, detected.url, detected.url, result, `${detected.url}|doc`, `${detected.url}|doc`);
  const refused = { success: false, dispatched: false, noDispatch: true };

  // "Post 'Hello wrold' on X, then sign me up for the newsletter", then "fix
  // the typo in the tweet": the latest attempt is the newsletter, which can
  // never be found on X, and the X post before it is what a new X post may
  // repeat. WebBrain stops there once, instead of sending the model to look
  // for the newsletter on X until the step limit.
  test(`${build}: after a correction a post is held to an earlier attempt on its own platform, and says so once`, async () => {
    const mastodon = mastodonCompose;
    const cases = {
      'x-form-x': { before: [[xPublish('Hello wrold')], [newsletter()]], correction: 'fix the typo in the tweet',
        now: xPublish('Hello world'), reason: 'earlier_attempt_on_platform' },
      // The same post again is still not repeated.
      'x-form-same-x': { before: [[xPublish('Hello wrold')], [newsletter()]], correction: 'post it again',
        now: xPublish('Hello wrold'), reason: 'earlier_attempt_on_platform' },
      'x-form-bluesky': { before: [[xPublish('Hello wrold')], [newsletter()]], correction: 'now post it on Bluesky too',
        now: bskyPublish('Hello world'), allowed: true },
      // A search on X sends nothing and a refused click sent nothing.
      'x-search-mastodon-x': { before: [[xSearch()], [mastodon, deliveredUnobserved]], correction: 'ok now on X',
        now: xPublish('WebBrain test post', ''), allowed: true },
      'x-refused-mastodon-x': { before: [[xPublish('WebBrain test post'), refused], [mastodon, deliveredUnobserved]], correction: 'ok now on X',
        now: xPublish('WebBrain test post'), allowed: true },
      // An attempt with no usable address may have been on X.
      'unknown-mastodon-x': { before: [[{ ...formSubmit('x'), url: '' }], [mastodon, deliveredUnobserved]], correction: 'ok now on X',
        now: xPublish('WebBrain test post', ''), reason: 'attempt_history_unknown' },
    };
    for (const [variant, spec] of Object.entries(cases)) {
      const h = await fixture('Post "Hello wrold" on X, then sign me up for the newsletter.', { pageUrl: spec.now.url });
      try {
        for (const [detected, result] of spec.before) attempt(h, detected, result);
        const guard = await h.steer(spec.correction);
        h.read();
        const blocked = await h.check(spec.now);
        if (spec.allowed) {
          assert.equal(blocked, null, `${variant}: ${blocked?.error}`);
          assert.equal(guard.steeringPriorSubmissionReconciliation.verificationKind, 'cross_platform', variant);
          continue;
        }
        assert.equal(blocked?.noDispatch, true, variant);
        assert.equal(blocked.actionGuard.reason, spec.reason, `${variant}: ${blocked.error}`);
        assert.equal(blocked.retryable, false, variant);
        assert.match(blocked.error, /^The consequential action was not dispatched \([a-z_]+\)\. Nothing was published\./, variant);
        assert.match(blocked.error, /Do not publish it again\. Tell the user what was not done/, variant);
        assert.doesNotMatch(blocked.error, /then retry/, `${variant}: no instruction that loops`);
        assert.equal(h.audits.length, 0, variant);
        assert.equal(h.steeringBlock(spec.now)?.noDispatch, true, variant);
        // Reading more pages changes nothing: the same answer, not a new search.
        h.read();
        assert.equal((await h.check(spec.now)).actionGuard.reason, spec.reason, variant);
      } finally { h.close(); }
    }
  });

  // "Post on X and Bluesky": the X page did not open, so nothing was sent
  // there; the Bluesky post went out; then "now retry the X post".
  test(`${build}: an X attempt that sent nothing does not hold a later X post`, async () => {
    for (const xOutcome of ['failed', 'pending']) {
      for (const account of ['twitter:alice', '']) {
        const variant = `${xOutcome}${account ? '' : '-account-unread'}`;
        const h = await fixture('Post "Hello world" on X and Bluesky.', { pageUrl: 'https://x.com/home' });
        try {
          h.agent._planExecutionGuards.get(h.tab).socialPublication = { key: 'contract-1',
            contract: { actions: [{ id: 'x-post', platform: 'twitter' }, { id: 'bsky-post', platform: 'bluesky' }] },
            outcomes: { 'x-post': xOutcome === 'failed' ? { status: 'failed', cause: 'unavailable' } : { status: 'pending', cause: 'publish_failed' } } };
          attempt(h, bskyPublish('Hello world'));
          await h.steer('now retry the X post');
          h.read();
          const blocked = await h.check(xPublish('Hello world', account));
          // Both accounts read: another platform by account, as before.
          if (xOutcome === 'failed' || account) assert.equal(blocked, null, `${variant}: ${blocked?.error}`);
          else assert.equal(blocked?.actionGuard.reason, 'earlier_attempt_on_platform', variant);
        } finally { h.close(); }
      }
    }
  });

  // "Post on X": the X page did not open and nothing was sent anywhere; then
  // "try again". The receipt is the outcome alone, and it holds nothing.
  test(`${build}: a correction after an attempt that sent nothing lets the post go ahead`, async () => {
    for (const status of ['failed', 'pending']) {
      const h = await fixture('Post "Hello world" on X.', { pageUrl: 'https://x.com/home' });
      try {
        h.agent._planExecutionGuards.get(h.tab).socialPublication = { key: 'contract-1',
          contract: { actions: [{ id: 'x-post', platform: 'twitter' }] },
          outcomes: { 'x-post': status === 'failed' ? { status, cause: 'unavailable' } : { status, cause: 'publish_failed' } } };
        const guard = await h.steer('try again');
        assert.deepEqual(Object.keys(guard.steeringPriorSubmission.publicationOutcomes), ['x-post'], status);
        h.read();
        const blocked = await h.check(xPublish('Hello world'));
        if (status === 'failed') assert.equal(blocked, null, blocked?.error);
        // An outcome that may have been delivered could be on X itself.
        else assert.equal(blocked?.noDispatch, true, status);
      } finally { h.close(); }
    }
  });

  test(`${build}: a correction's receipt lists the platforms the task attempted, so a restart keeps them`, async () => {
    // The trace, with WebBrain restarted after the correction.
    for (const afterCorrection of ['nothing', 'tool steps']) {
      const h = await fixture('go to mastoturk.org and try to post something', { pageUrl: 'https://x.com/home' });
      let r;
      try {
        attempt(h, mastodonCompose, deliveredUnobserved);
        await h.steer('ok now on X');
        r = await h.restart(afterCorrection === 'nothing' ? [] : [
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_nav', type: 'function', function: { name: 'navigate', arguments: '{"url":"https://x.com/home"}' } }] },
          { role: 'tool', tool_call_id: 'call_nav', content: '{"success":true}' }]);
        const guard = r.agent._planExecutionGuards.get(r.tab);
        assert.deepEqual(guard.steeringPriorSubmission?.taskAttemptPlatforms, ['mastoturk.org'], afterCorrection);
        assert.equal(guard.steeringPriorReadAfterCorrection, false, 'a restarted run reads again');
        assert.equal((await r.check(xPublish('WebBrain test post', ''))).actionGuard.reason, 'prior_effect_unreconciled', afterCorrection);
        r.read();
        assert.equal(await r.check(xPublish('WebBrain test post', '')), null, afterCorrection);
        // Only steps after the correction leave the record incomplete, which
        // matters for the next correction.
        attempt(r, xPublish('WebBrain test post'));
        await r.steer('now on Bluesky too');
        r.read();
        const next = await r.check(bskyPublish('WebBrain test post', ''));
        if (afterCorrection === 'nothing') assert.equal(next, null, next?.error);
        else assert.equal(next?.actionGuard.reason, 'attempt_history_unknown', afterCorrection);
        // With both accounts read the platforms differ by account, as before.
        assert.equal(await r.check(bskyPublish('WebBrain test post')), null, afterCorrection);
      } finally { (r || h).close(); }
    }
    // The X post and the newsletter, then "fix the typo in the tweet", then a
    // restart: the X post before the newsletter still holds a new X post.
    {
      const h = await fixture('Post "Hello wrold" on X, then sign me up for the newsletter.', { pageUrl: 'https://x.com/home' });
      let r;
      try {
        attempt(h, xPublish('Hello wrold'));
        attempt(h, newsletter());
        await h.steer('fix the typo in the tweet');
        r = await h.restart();
        r.read();
        assert.equal((await r.check(xPublish('Hello world'))).actionGuard.reason, 'earlier_attempt_on_platform');
      } finally { (r || h).close(); }
    }
    // A conversation saved before the record existed: WebBrain cannot know,
    // so it says so once instead of looking for the Mastodon post on X.
    {
      const h = await fixture('go to mastoturk.org and try to post something', { pageUrl: 'https://x.com/home' });
      let r;
      try {
        attempt(h, mastodonCompose, deliveredUnobserved);
        await h.steer('ok now on X');
        const saved = h.agent.conversations.get(h.tab);
        delete saved.findLast(message => message.webbrainSteering).webbrainSteering.priorSubmission.taskAttemptPlatforms;
        r = await h.restart();
        r.read();
        const blocked = await r.check(xPublish('WebBrain test post', ''));
        assert.equal(blocked.actionGuard.reason, 'attempt_history_unknown', blocked.error);
        assert.equal(blocked.retryable, false);
      } finally { (r || h).close(); }
    }
  });

  // The trace's shape: the Mastodon post, "ok now on X", a page read, a search
  // on X that replaces the live receipt, then the X post.
  test(`${build}: a page read under the correction counts after a later receipt or run replaces the live one`, async () => {
    for (const variant of ['search-after-read', 'no-read', 'continue', 'typed-continue']) {
      const h = await fixture('go to mastoturk.org and try to post something', { pageUrl: 'https://x.com/home' });
      try {
        attempt(h, mastodonCompose, deliveredUnobserved);
        await h.steer('ok now on X');
        if (variant !== 'no-read') h.read();
        if (variant === 'search-after-read') attempt(h, xSearch());
        if (variant === 'continue' || variant === 'typed-continue') {
          h.agent._storeContinuationExecutionEvidence(h.tab);
          h.agent._beginCompletionInvariant(h.tab);
          h.agent._startPlanExecutionGuard(h.tab, 'act', h.gate, variant === 'continue' ? { trustedContinuation: true } : {});
          assert.equal(h.agent._planExecutionGuards.get(h.tab).steeringPriorReadAfterCorrection, variant === 'continue', variant);
          if (variant === 'typed-continue') h.read();
        }
        const blocked = await h.check(xPublish('WebBrain test post'));
        if (variant === 'no-read') {
          assert.equal(blocked.actionGuard.reason, 'prior_effect_unreconciled');
          assert.match(blocked.error, /on mastoturk\.org, has not been observed yet: no page was read since it was sent\. Read the current page, then retry/);
        } else assert.equal(blocked, null, `${variant}: ${blocked?.error}`);
      } finally { h.close(); }
    }
  });

  test(`${build}: the task's record holds what may have changed something, through every correction`, async () => {
    const h = await fixture('Post on X, then sign me up for the newsletter.', { pageUrl: 'https://bsky.app/' });
    try {
      attempt(h, xPublish('Hello wrold'));
      attempt(h, newsletter(), refused);
      attempt(h, xSearch());
      attempt(h, newsletter());
      // A request that changes something is recorded at its own address.
      h.agent._recordCompletionSubmitAttempt(h.tab, null, 'fetch_url', { url: 'https://api.example.org/v1/items', method: 'POST' },
        'https://newsletter.test/thanks', 'https://newsletter.test/thanks', { success: true, status: 201 });
      h.agent._recordCompletionSubmitAttempt(h.tab, null, 'fetch_url', { url: 'https://read.example.net/v1/items' },
        'https://newsletter.test/thanks', 'https://newsletter.test/thanks', { success: true, status: 200 });
      let guard = await h.steer('fix the typo in the tweet');
      assert.deepEqual(guard.steeringPriorSubmission.taskAttemptPlatforms, ['twitter', 'newsletter.test', 'example.org']);
      assert.deepEqual(h.agent.conversations.get(h.tab).findLast(message => message.webbrainSteering).webbrainSteering
        .priorSubmission.taskAttemptPlatforms, ['twitter', 'newsletter.test', 'example.org'], 'the saved receipt lists them too');
      h.read();
      assert.equal(await h.check(bskyPublish('Hello world')), null);
      attempt(h, bskyPublish('Hello world'));
      guard = await h.steer('and on Mastodon');
      assert.deepEqual(guard.steeringPriorSubmission.taskAttemptPlatforms, ['twitter', 'newsletter.test', 'example.org', 'bluesky']);
    } finally { h.close(); }
  });

  test(`${build}: an over-long record counts as unknown, and receipts from two runs stay two`, async () => {
    const h = await fixture('Sign me up on every site.', { pageUrl: 'https://x.com/home' });
    try {
      for (let index = 0; index < 65; index++) attempt(h, formOn(`https://site${index}.test/subscribe`));
      const guard = await h.steer('ok now on X');
      assert.equal(guard.steeringPriorSubmission.taskAttemptPlatforms, null, 'past 64 sites the record is not kept');
      h.read();
      assert.equal((await h.check(xPublish('Hello', ''))).actionGuard.reason, 'attempt_history_unknown');
    } finally { h.close(); }
    // Action sequences restart with each run: the same sequence and page in
    // two runs are two attempts, and both are archived.
    const r = await fixture('Post "Hello world" on X.', { pageUrl: 'https://x.com/home' });
    try {
      r.agent._completionSubmitStates.set(r.tab, { ...publicationReceipt(), runToken: 'completion_run_1' });
      await r.steer('Also send me the link.');
      r.agent._completionSubmitStates.set(r.tab, { ...publicationReceipt(), publicationSnapshot: snap('Hello again'), runToken: 'completion_run_2' });
      const guard = await r.steer('And keep it short.');
      assert.deepEqual(guard.steeringMutationReceipts.map(receipt => receipt.runToken), ['completion_run_1', 'completion_run_2']);
    } finally { r.close(); }
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
