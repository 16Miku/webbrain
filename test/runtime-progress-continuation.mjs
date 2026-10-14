import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: value => `extension://test/${value}` } };

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  for (const continuation of ['Please continue from where you left off.', 'continue']) {
    test(`${build}: ${continuation} retains completed ordered rows under enabled planner progress`, async () => {
      const provider = { name: 'owned classifier', model: 'test', config: { category: 'local' },
        chat: async () => ({ content: JSON.stringify({ mode: 'active', allowedActions: ['process_item'],
          forbiddenActions: [], targets: [], confidence: 1, pageScopePolicy: 'page' }) }) };
      const agent = new Agent({ getActive: () => provider }); agent._persist = () => {};
      const task = 'Process the 20 owned QA rows in order and retain each verified receipt.';
      agent.conversations.set(1, [{ role: 'system', content: 'Act' }, { role: 'user', content: task, webbrainUserAuthoredText: task }]);
      const options = { provider, pageScope: 'https://owned.example.test/rows', progressLedgerPolicy: 'enabled',
        progressAction: 'process_item', expectedItems: { count: 20, item_type: 'row', ordered: true, required_fields: ['receipt'] } };
      const first = await agent._ensureProgressSessionForCurrentTask(1, options);
      assert.equal(agent._progressUpdate(1, { items: Array.from({ length: 5 }, (_, index) => ({
        id: `expected:${index + 1}`, status: 'processed', fields: { receipt: `owned-${index + 1}` },
      })) }).success, true);
      // The runtime marks the Continue command, and a model reads a typed
      // "continue", as a continuation of the earlier task.
      agent.conversations.get(1).push({ role: 'user', content: continuation, webbrainUserAuthoredText: continuation,
        webbrainTurnKind: 'continue' });
      const continued = await agent._ensureProgressSessionForCurrentTask(1, options);
      assert.equal(continued.sessionId, first.sessionId, 'Continuation cannot reseed a new session for the same ordered task.');
      assert.equal(continued.taskText, task);
      const ledger = agent._progressRead(1, { currentTaskOnly: true });
      assert.equal(ledger.counts.total, 20); assert.equal(ledger.counts.processed, 5);
      assert.equal(ledger.rows.find(row => row.status === 'pending').id, 'expected:6');
      assert.equal(agent._progressTaskAnchorText(1), task);

      const newTask = 'Process 20 different rows for a new independent QA job.';
      agent.conversations.get(1).push({ role: 'user', content: newTask, webbrainUserAuthoredText: newTask });
      const fresh = await agent._ensureProgressSessionForCurrentTask(1, options);
      assert.notEqual(fresh.sessionId, first.sessionId, 'A genuinely new task cannot inherit the old completion statuses.');
      const newLedger = agent._progressRead(1, { currentTaskOnly: true });
      assert.equal(newLedger.counts.total, 20); assert.equal(newLedger.counts.pending, 20); assert.equal(newLedger.counts.processed, 0);
      assert.equal(agent._progressRead(1, { sessionId: first.sessionId }).counts.processed, 5, 'The independent task must retain the old task history.');
    });
  }
}
