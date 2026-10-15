import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const session = {};
let writeSession = async values => Object.assign(session, structuredClone(values));
let removeSession = async key => { delete session[key]; };
globalThis.chrome = {
  alarms: {}, runtime: { getURL: value => value },
  storage: { local: { get: async value => value || {}, set: async () => {} }, session: {
    get: async key => ({ [key]: session[key] }),
    set: async values => writeSession(values), remove: async key => removeSession(key),
  } },
};
globalThis.browser = globalThis.chrome;
const archive = { id: 'archive', messages: [
  { role: 'user', text: 'Remember the blue bicycle', userTextSource: 'verbatim' },
  { role: 'assistant', text: 'Your bicycle is blue.' },
] };

function seededConversation(Agent, createChatSession, tabId) {
  const agent = new Agent({ getActive: () => ({ supportsVision: false }) });
  agent.hydratedTabs.add(tabId);
  agent.getConversation(tabId, 'act').push({ role: 'user', content: 'Keep working on the current task' });
  const conversationId = agent.conversationIds.get(tabId);
  agent._latestWorkflowDrafts.set(tabId, { conversationId, workflow: { name: 'Existing draft', steps: [] } });
  agent.chatSessions.set(tabId, createChatSession({ threadKey: 'current-chat', now: 123 }));
  agent._continuationResponseLanguagePolicies.set(tabId, { conversationId, policy: { response_locale: 'tr', deliverable_locales: [] } });
  agent.responseLanguagePolicies.set(tabId, { response_locale: 'tr' });
  agent.submittedRunRequestIds.set(tabId, 'current-request');
  agent.progressLedgers.set(tabId, [{ key: 'one', label: 'Pending work', status: 'pending' }]);
  agent.apiAllowedTabs.add(tabId);
  const cancelled = [];
  agent._pendingPlans.set(tabId, new Map([['plan', { resolve: value => cancelled.push(value) }]]));
  return { agent, cancelled, conversationId };
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { createChatSession } = await import(`../src/${build}/src/agent/chat-workflow.js`);

  for (const errorMessage of ['Storage unavailable', 'QUOTA_BYTES quota exceeded']) {
    test(`${build}: failed recovery preserves the complete current conversation (${errorMessage})`, async () => {
      const tabId = build === 'chrome' ? 141 : 142;
      const { agent, cancelled } = seededConversation(Agent, createChatSession, tabId);
      await agent._persistNow(tabId);
      const originalStored = structuredClone(session[agent._convKey(tabId)]);
      const originalState = Object.entries(agent).filter(([, value]) => value instanceof Map || value instanceof Set)
        .map(([name, value]) => [name, value instanceof Map ? new Map(value) : new Set(value)]);
      let writeAttempts = 0, removed = false;
      const write = writeSession, remove = removeSession;
      writeSession = async () => { writeAttempts++; throw new Error(errorMessage); };
      removeSession = async () => { removed = true; };
      try {
        await assert.rejects(agent.recoverChatHistory(tabId, archive), /Unable to persist/);
        for (const [name, previous] of originalState) assert.deepEqual(agent[name], previous, `${name} must survive failed recovery`);
        assert.deepEqual(session[agent._convKey(tabId)], originalStored);
        assert.equal(removed, false, 'Old durable state must never be deleted before replacement commits');
        assert.equal(cancelled.length, 0, 'Pending plan callbacks must remain usable');
        assert.equal(writeAttempts, errorMessage.includes('quota') ? 2 : 1);
      } finally { writeSession = write; removeSession = remove; }
    });
  }

  test(`${build}: recovery keeps old state until commit, then clears stale workflow and continuation state`, async () => {
    const tabId = build === 'chrome' ? 143 : 144;
    const { agent, cancelled, conversationId } = seededConversation(Agent, createChatSession, tabId);
    await agent._persistNow(tabId);
    const previousMessages = agent.conversations.get(tabId);
    let releaseWrite, notifyWrite;
    const started = new Promise(resolve => { notifyWrite = resolve; });
    const write = writeSession, remove = removeSession;
    let removed = false;
    writeSession = async values => {
      notifyWrite();
      await new Promise(resolve => { releaseWrite = resolve; });
      return write(values);
    };
    removeSession = async () => { removed = true; };
    try {
      const recovery = agent.recoverChatHistory(tabId, archive);
      await started;
      assert.equal(agent.conversationIds.get(tabId), conversationId);
      assert.equal(agent.conversations.get(tabId), previousMessages);
      assert.equal(agent._latestWorkflowDrafts.has(tabId), true);
      assert.equal(cancelled.length, 0);
      releaseWrite();
      const result = await recovery;
      assert.notEqual(result.conversationId, conversationId);
      assert.equal(agent._latestWorkflowDrafts.has(tabId), false);
      assert.equal(agent.chatSessions.has(tabId), false);
      assert.equal(agent._continuationResponseLanguagePolicies.has(tabId), false);
      assert.equal(agent.submittedRunRequestIds.has(tabId), false);
      assert.equal(agent.apiAllowedTabs.has(tabId), false);
      assert.equal(cancelled.length, 1);
      assert.equal(removed, false, 'Committing the in-memory replacement must preserve its durable snapshot');
      const stored = session[agent._convKey(tabId)];
      assert.equal(stored.conversationId, result.conversationId);
      assert.deepEqual(stored.messages, agent.conversations.get(tabId));
      for (const key of ['workflowDraft', 'chatWorkflow', 'continuationResponseLanguagePolicy', 'submittedRunRequestId']) {
        assert.equal(stored[key] ?? null, null, `Recovered context must not inherit ${key}`);
      }
      const restarted = new Agent({ getActive: () => ({ supportsVision: false }) });
      await restarted._hydrate(tabId);
      assert.equal(restarted.conversationIds.get(tabId), result.conversationId);
      assert.deepEqual(restarted.conversations.get(tabId), agent.conversations.get(tabId));
      assert.equal(restarted.chatSessions.has(tabId), false);
    } finally { writeSession = write; removeSession = remove; }
  });

  test(`${build}: recovery only cancels schedules after a successful context commit`, async () => {
    const source = await readFile(`src/${build}/src/background.js`, 'utf8');
    const body = source.slice(source.indexOf("    case 'recover_chat_history': {") + "    case 'recover_chat_history': ".length,
      source.indexOf("    case 'restore_selection_scope':"));
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const handle = new AsyncFunction('msg', 'sender', 'agent', 'scheduler', 'recoveringHistoryTabs',
      'assertNoActiveTabRun', 'getChatHistoryRecord', 'chrome', 'browser', 'clearRunUiSnapshot', 'console', 'tabChatHandoff', body);
    let recoverFails = true, cancelFails = false;
    const events = [], locks = new Set();
    const agent = { getConversationId: async () => 'old', recoverChatHistory: async () => {
      events.push('recover');
      if (recoverFails) throw new Error('Unable to persist');
      return { conversationId: 'new' };
    } };
    const scheduler = { cancelForConversation: async (tabId, conversationId) => {
      assert.equal(conversationId, 'old'); events.push('cancel');
      if (cancelFails) throw new Error('Scheduler storage unavailable');
    } };
    const api = { tabs: { get: async () => ({ url: 'https://example.com/' }) } };
    const invoke = () => handle({ tabId: 1, recordId: 'archive' }, {}, agent, scheduler, locks,
      () => {}, async () => ({ ...archive, url: 'https://example.com/' }), api, api,
      () => events.push('clear-ui'), { warn: () => events.push('warning') },
      { replace: async (id, html, { commit }) => commit({}) });
    await assert.rejects(invoke(), /Unable to persist/);
    assert.deepEqual(events, ['recover']);
    assert.equal(locks.size, 0);
    recoverFails = false;
    events.length = 0;
    assert.equal((await invoke()).conversationId, 'new');
    assert.deepEqual(events, ['recover', 'cancel', 'clear-ui']);
    events.length = 0;
    cancelFails = true;
    assert.equal((await invoke()).ok, true, 'Scheduler cleanup failure must not hide a committed recovery');
    assert.deepEqual(events, ['recover', 'cancel', 'warning', 'clear-ui']);
  });
}
