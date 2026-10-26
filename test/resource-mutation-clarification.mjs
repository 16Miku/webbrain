import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installModelStub } from './semantic-decision-stub.mjs';

const tab = 42;
const originalUrl = 'https://x.com/owner/status/900';
const replyTarget = 'https://x.com/hey_mujeebahmed/status/901';
const question = 'Post this reply to @hey_mujeebahmed even though the sponsored tweet quotes Charles Maddock?';
const yes = 'Post reply anyway';
const no = 'Do not post this reply';
const user = (content, kind) => ({ role: 'user', content, webbrainUserAuthoredText: content,
  ...(kind ? { webbrainTurnKind: kind } : {}) });
const pair = (answer, { source = 'option', name = 'clarify', success = true, id = 'reply' } = {}) => [
  { role: 'assistant', content: null, tool_calls: [{ id, type: 'function',
    function: { name, arguments: JSON.stringify({ question }) } }] },
  { role: 'tool', tool_call_id: id, content: JSON.stringify({ success, answer, source }) },
];

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { resolveAdapterWorkflowJob } = await import(`../src/${build}/src/agent/adapters.js`);

  function fixture(request = 'Reply about WebBrain, but skip sponsored posts quoting Charles Maddock.', authorize = null) {
    const provider = { model: 'clarification-authorization-fixture', chat: async () => ({ content: '{}' }) };
    const agent = new Agent({ getActive: () => provider });
    agent._persist = () => {};
    const messages = [{ role: 'system', content: 'system' }, user(request)];
    agent.conversations.set(tab, messages);
    const guard = agent._startPlanExecutionGuard(tab, 'act', {
      requestKind: 'execute', requiresStateChange: true, requiresSubmission: true,
    });
    const record = { complete: true, url: originalUrl, textValues: ['Earlier post'] };
    const receipt = { dispatched: true, actionSequence: 7,
      publicationSnapshot: { complete: true, account: 'twitter:owner',
        posts: [{ complete: true, bodyText: 'Earlier post', attachments: [], context: { kind: 'post', target: null } }] },
      mutationWorkflow: resolveAdapterWorkflowJob('https://x.com/', 'publish-post'),
      workflowBinding: { preDispatchPublishedResourceIdentities: [] } };
    guard.steeringPriorSubmission = structuredClone(receipt);
    agent._completionSubmitStates.set(tab, structuredClone(receipt));
    const detected = { isSubmit: true, publicationControl: true, frameDocumentIdentity: 'document-1',
      actionResource: record, reconciliationResources: [record], reconciliationResourceScanComplete: true,
      publicationSnapshot: { complete: true, account: 'twitter:owner',
        posts: [{ complete: true, bodyText: 'Disclosure: I make WebBrain.', attachments: [],
          context: { kind: 'reply', target: replyTarget } }] } };
    agent._detectLikelySubmitAction = async () => structuredClone(detected);
    const calls = installModelStub(agent, { provider, authorize: authorize || (({ input, authority }) => {
      const latestAnswer = authority.latestClarifications.at(-1)?.answer;
      return { key: input.key, authorized: latestAnswer === yes, latestRequestEvidence: latestAnswer || '' };
    }) });
    return { agent, messages, guard, calls, detected,
      check: () => agent._resourceMutationPreSubmitBlock(tab, 'click_ax', { ref_id: 'reply-button' }, detected, provider),
      answer: (answer, source = 'option') => agent._recordTaskClarification(tab, question, answer, source) };
  }

  function plannerAnswer(f, prompt, answer) {
    const task = f.agent._activeTaskBinding(f.messages);
    f.messages.push({ role: 'assistant', content: prompt,
      webbrainPlannerClarification: { taskText: task.text } }, user(answer));
  }

  function prepareDeletion(f) {
    f.guard = f.agent._startPlanExecutionGuard(tab, 'act', {
      requestKind: 'execute', requiresStateChange: true, requiresSubmission: true,
    });
    delete f.guard.steeringPriorSubmission;
    f.agent._completionSubmitStates.delete(tab);
    Object.assign(f.detected, { mutationKind: 'delete', publicationControl: false,
      publicationSnapshot: null, url: originalUrl });
  }

  test(`${build}: planner account clarification preserves the original deletion instruction`, async () => {
    const request = `Delete the post ${originalUrl}`;
    const prompt = 'Use your owner account?';
    const answer = 'Yes, use @owner';
    const f = fixture(request);
    plannerAnswer(f, prompt, answer);
    prepareDeletion(f);
    const authority = f.agent._resourceMutationRequestContext(f.messages);
    assert.equal(authority.latestAcceptedRequest, request);
    assert.deepEqual(authority.clarifications, [{ question: prompt, answer }]);
    assert.deepEqual(authority.humanTexts, [request, answer]);
    assert.equal(await f.check(), null);
    const decision = f.calls.find(call => call.kind === 'deletion_request');
    assert.deepEqual(JSON.parse(decision.request), { request, answers: [answer] });
    assert.ok(!decision.request.includes(prompt), 'Question text cannot become deletion authority');
  });

  test(`${build}: planner clarification can supply the deletion target URL`, async () => {
    const request = 'Delete the selected post.';
    const f = fixture(request);
    plannerAnswer(f, 'Which post should I delete?', originalUrl);
    prepareDeletion(f);
    assert.equal(await f.check(), null);
    assert.deepEqual(JSON.parse(f.calls.find(call => call.kind === 'deletion_request').request),
      { request, answers: [originalUrl] });
  });

  test(`${build}: clarification chains preserve the latest actual correction and subsequent answers`, async () => {
    const f = fixture(`Delete the post ${originalUrl}`);
    f.answer(yes);
    plannerAnswer(f, 'Which account?', '@old-owner');
    const correction = 'Do not delete anything; inspect only.';
    f.messages.push(user(correction, 'update'));
    plannerAnswer(f, 'Inspect your owner account?', 'Yes, use @owner');
    f.answer(no);
    plannerAnswer(f, 'Which post should I inspect?', originalUrl);
    prepareDeletion(f);
    const authority = f.agent._resourceMutationRequestContext(f.messages);
    assert.equal(authority.latestAcceptedRequest, correction);
    assert.deepEqual(authority.clarifications, [
      { question: 'Inspect your owner account?', answer: 'Yes, use @owner' },
      { question, answer: no },
      { question: 'Which post should I inspect?', answer: originalUrl },
    ]);
    assert.ok(!authority.humanTexts.includes(yes));
    assert.ok(!authority.humanTexts.includes('@old-owner'));
    assert.equal((await f.check()).actionGuard.reason, 'resource_not_bound_to_request');
    const decision = f.calls.find(call => call.kind === 'deletion_request');
    assert.deepEqual(JSON.parse(decision.request),
      { request: correction, answers: ['Yes, use @owner', no, originalUrl] });
  });

  test(`${build}: exact human clarification authorizes the previously rejected reply`, async () => {
    const f = fixture();
    assert.equal((await f.check()).actionGuard.reason, 'latest_request_not_authorized');
    const taskKey = f.guard.taskKey;
    f.answer(yes);
    assert.equal(await f.check(), null);
    const authorization = f.calls.filter(call => call.kind === 'authorization').at(-1);
    assert.deepEqual(authorization.authority.latestClarifications, [{ question, answer: yes }]);
    assert.ok(authorization.authority.currentTask.includes(yes));
    assert.equal(f.guard.taskKey, taskKey, 'An answer does not create a new task or discard earlier receipts');
    assert.equal(f.guard.resourceMutationAuthorization.authorityKey,
      f.agent._resourceMutationRequestContext(f.messages).key);
    assert.equal(await f.check(), null);
    assert.equal(f.calls.filter(call => call.kind === 'authorization').length, 2, 'An unchanged approval can be reused');
  });

  test(`${build}: a later human refusal revokes the cached approval`, async () => {
    const f = fixture();
    f.answer(yes);
    assert.equal(await f.check(), null);
    f.answer(no);
    assert.equal(f.guard.resourceMutationAuthorization, undefined);
    assert.equal((await f.check()).actionGuard.reason, 'latest_request_not_authorized');
    assert.deepEqual(f.calls.filter(call => call.kind === 'authorization').at(-1).authority.latestClarifications,
      [{ question, answer: yes }, { question, answer: no }]);
  });

  test(`${build}: a clarification arriving during authorization invalidates the verdict`, async () => {
    let f;
    f = fixture(undefined, ({ input }) => {
      f.answer(no);
      return { key: input.key, authorized: true, latestRequestEvidence: yes };
    });
    f.answer(yes);
    assert.equal((await f.check()).actionGuard.reason, 'task_changed_during_authorization');
    assert.equal(f.guard.resourceMutationAuthorization, undefined);
  });

  test(`${build}: a clarification arriving during final target validation invalidates the verdict`, async () => {
    const f = fixture();
    f.answer(yes);
    let probes = 0;
    f.agent._detectLikelySubmitAction = async () => {
      if (++probes === 2) f.answer(no);
      return structuredClone(f.detected);
    };
    assert.equal((await f.check()).actionGuard.reason, 'resource_changed_after_authorization');
    assert.equal(f.guard.resourceMutationAuthorization, undefined);
  });

  test(`${build}: model question text cannot serve as a human authorization quotation`, async () => {
    const f = fixture(undefined, ({ input }) => ({ key: input.key, authorized: true, latestRequestEvidence: question }));
    f.answer(no);
    assert.equal((await f.check()).actionGuard.reason, 'latest_request_not_authorized');
    assert.equal(f.guard.resourceMutationAuthorization, undefined);
  });

  test(`${build}: earlier answers cannot authorize an action after a new correction`, async () => {
    const f = fixture(undefined, ({ input }) => ({ key: input.key, authorized: true, latestRequestEvidence: yes }));
    f.answer(yes);
    f.messages.push(user('Inspect only; leave this reply unposted.', 'update'));
    const context = f.agent._resourceMutationRequestContext(f.messages);
    assert.equal(context.latestAcceptedRequest, 'Inspect only; leave this reply unposted.');
    assert.deepEqual(context.clarifications, []);
    assert.deepEqual(context.humanTexts, ['Inspect only; leave this reply unposted.']);
    const corrected = f.agent._startPlanExecutionGuard(tab, 'act', {
      requestKind: 'execute', requiresStateChange: true, requiresSubmission: true,
    });
    corrected.steeringPriorSubmission = structuredClone(f.guard.steeringPriorSubmission);
    assert.equal((await f.check()).actionGuard.reason, 'latest_request_not_authorized',
      'Quoting the old approval cannot authorize the corrected task');
  });

  test(`${build}: old transcripts recover paired explicit answers but reject defaults and unrelated tool data`, async () => {
    const f = fixture();
    f.messages.push(...pair(yes));
    assert.equal(await f.check(), null);
    const approvedKey = f.guard.resourceMutationAuthorization.authorityKey;
    f.messages.push(...pair(no, { id: 'new-answer' }));
    assert.notEqual(f.agent._resourceMutationRequestContext(f.messages).key, approvedKey);
    assert.equal((await f.check()).actionGuard.reason, 'latest_request_not_authorized',
      'A recovered later answer also invalidates a cached approval');

    for (const options of [{ source: 'auto' }, { source: 'timeout' }, { source: 'page' },
      { name: 'read_page' }, { success: false }]) {
      const ignored = fixture();
      ignored.messages.push(...pair(yes, options));
      assert.deepEqual(ignored.agent._resourceMutationRequestContext(ignored.messages).clarifications, [], JSON.stringify(options));
      assert.equal((await ignored.check()).actionGuard.reason, 'latest_request_not_authorized');
    }
  });

  test(`${build}: persisted answers deduplicate paired results while preserving repeated yes/no order`, () => {
    const f = fixture();
    for (const [index, answer] of [no, yes, no].entries()) {
      f.answer(answer);
      f.messages.push(...pair(answer, { id: `answer-${index}` }));
    }
    assert.deepEqual(f.agent._resourceMutationRequestContext(f.messages).clarifications.map(reply => reply.answer), [no, yes, no]);
    const restored = JSON.parse(JSON.stringify(f.messages));
    assert.deepEqual(f.agent._resourceMutationRequestContext(restored), f.agent._resourceMutationRequestContext(f.messages));
  });

  function projectedAnswers(f) {
    const resource = f.agent._resourceMutationRequestContext(f.messages).clarifications.map(reply => reply.answer);
    const text = f.agent._plannerAuthenticTaskText(f.messages);
    const planner = JSON.parse(text.slice(text.indexOf('{'))).updates
      .filter(update => update.kind === 'clarification').map(update => update.text);
    assert.deepEqual(planner, resource, 'Both authority projections retain the same human answer order');
    return resource;
  }

  test(`${build}: legacy approval cannot supersede a newer recorded refusal`, async () => {
    const f = fixture();
    f.messages.push(...pair(yes, { id: 'legacy-yes' }));
    assert.equal(await f.check(), null);
    f.answer(no);
    assert.equal(f.guard.resourceMutationAuthorization, undefined);
    assert.deepEqual(projectedAnswers(f), [yes, no], 'New refusal is authoritative before its tool result is appended');
    assert.equal((await f.check()).actionGuard.reason, 'latest_request_not_authorized');
    const authorityKey = f.agent._resourceMutationRequestContext(f.messages).key;
    f.messages.push(...pair(no, { id: 'recorded-no' }));
    assert.deepEqual(projectedAnswers(f), [yes, no]);
    assert.equal(f.agent._resourceMutationRequestContext(f.messages).key, authorityKey,
      'Appending the tool copy does not change human authority');
  });

  test(`${build}: repeated new answers never match an older identical legacy answer`, () => {
    for (const answers of [[yes, no, yes], [no, yes, no]]) {
      const f = fixture();
      f.messages.push(...pair(answers[0], { id: 'legacy-first' }), ...pair(answers[1], { id: 'legacy-second' }));
      f.answer(answers[2]);
      assert.deepEqual(projectedAnswers(f), answers, 'The last answer is still pending its tool result');
      f.messages.push(...pair(answers[2], { id: 'new-third' }));
      assert.deepEqual(projectedAnswers(f), answers);
      assert.deepEqual(f.messages[1].webbrainTaskClarifications.map(reply => reply.answer), answers,
        'Legacy chronology is backfilled before adding the new answer');
      f.messages.splice(2);
      assert.deepEqual(projectedAnswers(f), answers, 'Metadata alone preserves chronology after compaction');
    }
  });

  test(`${build}: existing mixed metadata merges with retained transcript suffixes`, () => {
    const cases = [
      { stored: [no], retained: [yes, no], expected: [yes, no] },
      { stored: [yes], retained: [yes, no], expected: [yes, no, yes] },
      { stored: [no], retained: [no, yes], expected: [no, yes, no] },
      { stored: [no, yes], retained: [yes, no, yes], expected: [yes, no, yes] },
      { stored: [no, yes, no], retained: [yes, no], expected: [no, yes, no] },
      { stored: [no, yes, no], retained: [no], expected: [no, yes, no] },
      { stored: [no, yes, no], retained: [], expected: [no, yes, no] },
    ];
    for (const { stored, retained, expected } of cases) {
      const f = fixture();
      f.messages[1].webbrainTaskClarifications = stored.map(answer => ({ question, answer, source: 'option' }));
      for (const [index, answer] of retained.entries()) f.messages.push(...pair(answer, { id: `retained-${index}` }));
      assert.deepEqual(projectedAnswers(f), expected, JSON.stringify({ stored, retained }));
    }
  });

  test(`${build}: backfill stops at the next genuine user turn and rejects nonhuman tool data`, () => {
    const f = fixture();
    const owner = f.messages[1];
    f.messages.push(...pair(yes, { id: 'legacy' }));
    for (const [index, options] of [{ source: 'auto' }, { source: 'timeout' }, { source: 'page' },
      { name: 'read_page' }, { success: false }].entries()) {
      f.messages.push(...pair('untrusted answer', { ...options, id: `invalid-${index}` }));
    }
    f.messages.push(user('Inspect a separate task.', 'request'), ...pair('Other task answer', { id: 'other-task' }));
    f.agent._recordTaskClarification(tab, question, no, 'option', owner);
    assert.deepEqual(owner.webbrainTaskClarifications.map(reply => reply.answer), [yes, no]);
    assert.deepEqual(projectedAnswers(f), ['Other task answer']);
  });

  test(`${build}: an unanswered model question and automatic defaults leave cached human authority unchanged`, async () => {
    const f = fixture();
    f.answer(yes);
    assert.equal(await f.check(), null);
    const cached = f.guard.resourceMutationAuthorization;
    f.messages.push(pair(no)[0]);
    for (const source of ['auto', 'timeout', 'page']) f.answer(no, source);
    assert.equal(f.guard.resourceMutationAuthorization, cached);
    assert.equal(await f.check(), null);
  });
}
