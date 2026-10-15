import assert from 'node:assert/strict';
import { test } from 'node:test';

// A requested message or post body used to be cut out of the request by word
// lists of command verbs, negations and conjunctions in a dozen languages.
// The intent model now reads the request: it returns a short value as is and
// quotes a long one by its first and last words, and the exact text between
// them is copied from the user's own request. Nothing here reads words.
const xUrl = 'https://x.com/i/chat/123-456';

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  async function classify(task, reply, { approvedPlanText = '' } = {}) {
    const agent = new Agent({ getActive: () => ({ chat: async () => ({ content: '{}' }) }) });
    agent.useSiteAdapters = true;
    agent._persist = () => {};
    const tabId = 4100;
    const siteWorkflow = agent._resolvePlannerSiteWorkflow(xUrl, { request_kind: 'execute', requires_submission: true,
      messaging: { target_kind: 'named', recipients: ['@altryne'] } });
    assert.equal(siteWorkflow?.job?.id, 'send-message');
    agent.conversations.set(tabId, [{ role: 'system', content: 'system' }, { role: 'user', content: task }]);
    const guard = agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute', requiresStateChange: true,
      requiresSubmission: true, messaging: { target_kind: 'named', recipients: ['@altryne'] }, siteWorkflow });
    if (approvedPlanText) guard.approvedPlanText = approvedPlanText;
    const seen = [];
    agent._chatWithCostAllowance = async (_provider, messages) => {
      seen.push(messages);
      if (reply instanceof Error) throw reply;
      return { content: JSON.stringify({ mode: 'inactive', allowedActions: [], forbiddenActions: [], targets: [],
        workflowFields: reply, confidence: 0.99, pageScopePolicy: 'page' }) };
    };
    await agent._classifyProgressIntentWithProvider(tabId, { taskText: task, provider: { chat: async () => ({}) }, pageScope: xUrl });
    return { agent, guard, seen };
  }

  const longBody = 'Selam Alex: yarınki toplantı 10:00\'da. "Gündem" ekte; sonra da şunu söyle: hazırım! '
    + 'それから、資料は共有フォルダにあります。Then we launched it, and nobody posted anything else.';
  const task = `Send Alex this message: ${longBody} Let me know when it is sent.`;

  test(`${build}: a long body is copied exactly from the request between the quoted first and last words`, async () => {
    const { guard, seen } = await classify(task, [{ field: 'body', start: 'Selam Alex:', end: 'nobody posted anything else.' }]);
    assert.deepEqual(guard.workflowMetadataRequirements, [{ field: 'body', value: longBody }]);
    assert.equal(guard.workflowMetadataRequirementsResolved, true);
    assert.equal(guard.workflowMetadataRequirementsIncomplete, false);
    assert.match(seen[0][0].content, /never translate, shorten or paraphrase an anchor/);
    assert.equal(JSON.parse(seen[0][1].content).taskText, task, 'The model reads the request as written');
  });

  test(`${build}: a short body is taken as the model read it`, async () => {
    const { guard } = await classify('Send Alex: Hello there', [{ field: 'body', value: 'Hello there' }]);
    assert.deepEqual(guard.workflowMetadataRequirements, [{ field: 'body', value: 'Hello there' }]);
    assert.equal(guard.workflowMetadataRequirementsResolved, true);
  });

  test(`${build}: repeated anchors need an occurrence number; the plan can be the source`, async () => {
    const repeated = 'Send Alex: Hi. Hi again, see you at noon. Thanks!';
    let { guard } = await classify(repeated, [{ field: 'body', start: 'Hi', end: 'noon.' }]);
    assert.deepEqual(guard.workflowMetadataRequirements, [], 'An ambiguous anchor binds nothing');
    assert.equal(guard.workflowMetadataRequirementsIncomplete, true);
    assert.equal(guard.workflowMetadataRequirementsResolved, false);
    ({ guard } = await classify(repeated, [{ field: 'body', start: 'Hi', startOccurrence: 2, end: 'noon.' }]));
    assert.deepEqual(guard.workflowMetadataRequirements, [{ field: 'body', value: 'Hi again, see you at noon.' }]);
    const plan = 'Step 1: open the chat. Step 2: send "Draft from the plan, kept exactly as reviewed."';
    ({ guard } = await classify('Do the reviewed plan.', [{ field: 'body', source: 'plan', start: 'Draft from', end: 'as reviewed.' }],
      { approvedPlanText: plan }));
    assert.deepEqual(guard.workflowMetadataRequirements, [{ field: 'body', value: 'Draft from the plan, kept exactly as reviewed.' }]);
  });

  test(`${build}: anchors that are not in the request never invent a body`, async () => {
    // Translated or paraphrased anchors resolve to nothing.
    let { guard } = await classify(task, [{ field: 'body', start: 'Hello Alex:', end: 'nobody posted anything else.' }]);
    assert.deepEqual(guard.workflowMetadataRequirements, []);
    assert.equal(guard.workflowMetadataRequirementsIncomplete, true);
    // An end before the start, or a missing end, is no answer either.
    ({ guard } = await classify(task, [{ field: 'body', start: 'nobody posted', end: 'Selam Alex:' }]));
    assert.equal(guard.workflowMetadataRequirementsIncomplete, true);
    ({ guard } = await classify(task, [{ field: 'body', start: 'Selam Alex:' }]));
    assert.equal(guard.workflowMetadataRequirementsIncomplete, true);
    // A value the model also gave is kept and compared exactly later.
    ({ guard } = await classify(task, [{ field: 'body', start: 'Hello Alex:', end: 'else.', value: 'Selam Alex' }]));
    assert.deepEqual(guard.workflowMetadataRequirements, [{ field: 'body', value: 'Selam Alex' }]);
  });

  test(`${build}: without the intent model the requested body stays unresolved`, async () => {
    const { guard } = await classify('Send Alex: Hello there', new Error('provider down'));
    assert.deepEqual(guard.workflowMetadataRequirements || [], [], 'No body is guessed from the words');
    assert.notEqual(guard.workflowMetadataRequirementsResolved, true);
  });
}
