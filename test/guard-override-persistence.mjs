import assert from 'node:assert/strict';
import { test } from 'node:test';

const stored = new Map();
const area = {
  async get(key) { return stored.has(key) ? { [key]: structuredClone(stored.get(key)) } : {}; },
  async set(entries) { for (const [key, value] of Object.entries(entries)) stored.set(key, structuredClone(value)); },
  async remove(key) { stored.delete(key); },
};
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area },
  runtime: { getURL: path => `extension://test/${path}` } };

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { serializeConversationForSession } = await import(`../src/${build}/src/agent/conversation-persistence.js`);
  const tab = build === 'chrome' ? 91 : 92;
  const args = { selector: '#reply' };
  const detected = { isSubmit: true, publicationControl: true, url: 'https://x.com/compose/post',
    frameDocumentIdentity: 'owned-document', frameId: 0,
    publicationSnapshot: { complete: true, account: 'twitter:owner', posts: [{ complete: true,
      bodyText: 'Approved reply', attachments: [], context: { kind: 'reply', target: 'https://x.com/author/status/1' } }] } };
  const directive = () => ({ role: 'user', content: 'override that guard!',
    webbrainUserAuthoredText: 'override that guard!', webbrainTurnKind: 'update' });
  const startGuard = agent => agent._startPlanExecutionGuard(tab, 'act', {
    requestKind: 'execute', requiresStateChange: true, requiresSubmission: true,
  });
  function fixture(messages) {
    const provider = { model: 'override-persistence-fixture', chat: async () => ({ content: 'Earlier observations summarized.' }) };
    const agent = new Agent({ getActive: () => provider });
    agent._persist = () => {};
    agent.conversations.set(tab, messages || [{ role: 'system', content: 'System' },
      { role: 'user', content: 'Reply to this post.' }, directive()]);
    agent.conversationModes.set(tab, 'act');
    agent.conversationIds.set(tab, `override-persistence-${build}`);
    startGuard(agent);
    return agent;
  }
  const request = agent => agent._publicationGuardOverrideRequest(tab, 'click', args, detected);

  test(`${build}: a spent direct override survives real persistence and cold hydration`, async () => {
    const agent = fixture();
    const approval = await agent._directUserGuardOverrideApproval(tab, request(agent));
    assert.equal(approval.directUser, true);
    const marker = agent.conversations.get(tab).at(-1).webbrainGuardOverride;
    assert.equal(marker.spent, true);
    assert.deepEqual(stored.get(agent._convKey(tab)).messages.at(-1).webbrainGuardOverride, marker);

    const cold = fixture();
    cold.conversations.delete(tab);
    cold._planExecutionGuards.delete(tab);
    await cold._hydrateFromSession(tab);
    startGuard(cold);
    assert.deepEqual(cold.conversations.get(tab).at(-1).webbrainGuardOverride, marker);
    assert.equal(await cold._directUserGuardOverrideApproval(tab, request(cold)), null,
      'A fresh worker cannot mint another receipt from the same consumed user turn');
    assert.deepEqual(cold._unverifiedStepDecisions(tab), []);
  });

  test(`${build}: bounded recovery and live context compaction preserve the consumed marker`, async () => {
    const agent = fixture();
    const messages = agent.conversations.get(tab);
    await agent._directUserGuardOverrideApproval(tab, request(agent));
    const original = messages.at(-1);
    const marker = structuredClone(original.webbrainGuardOverride);
    for (let index = 0; index < 35; index++) messages.push({ role: 'assistant', content: 'Observed page content. '.repeat(1200) });
    const snapshot = serializeConversationForSession(messages, { maxBytes: 100000,
      preserveMessageIndices: agent._activeTaskBinding(messages).pinnedIndices });
    assert.equal(snapshot.compacted, true);
    const restored = fixture(JSON.parse(JSON.stringify(snapshot.messages)));
    assert.deepEqual(restored.conversations.get(tab).find(message => message.webbrainGuardOverride)?.webbrainGuardOverride, marker);
    assert.equal(await restored._directUserGuardOverrideApproval(tab, request(restored)), null);

    const compacted = await agent._manageContext(tab, messages, null, null, { force: true });
    assert.equal(compacted.compacted, true);
    assert.ok(messages.includes(original), 'Compaction pins the original genuine user turn');
    assert.deepEqual(original.webbrainGuardOverride, marker);
    startGuard(agent);
    assert.equal(await agent._directUserGuardOverrideApproval(tab, request(agent)), null);
    messages.push({ role: 'user', content: 'Continue', webbrainTurnKind: 'continue' });
    startGuard(agent);
    assert.equal(await agent._directUserGuardOverrideApproval(tab, request(agent)), null,
      'Continue cannot reactivate the earlier override command');
  });

  test(`${build}: quota retry persists the consumed marker before returning approval`, async () => {
    const agent = fixture();
    const set = area.set;
    let writes = 0;
    area.set = async entries => {
      writes++;
      assert.equal(entries[agent._convKey(tab)].messages.at(-1).webbrainGuardOverride.spent, true);
      if (writes === 1) throw Error('QUOTA_BYTES exceeded');
      return set(entries);
    };
    try {
      assert.ok(await agent._directUserGuardOverrideApproval(tab, request(agent)));
      assert.equal(writes, 2);
      const recovered = fixture(structuredClone(stored.get(agent._convKey(tab)).messages));
      assert.equal(await recovered._directUserGuardOverrideApproval(tab, request(recovered)), null);
    } finally {
      area.set = set;
    }
  });
}
