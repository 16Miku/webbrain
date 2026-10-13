import test from 'node:test';
import assert from 'node:assert/strict';

const key1 = '00000000-0000-4000-8000-000000000001';
const key2 = '00000000-0000-4000-8000-000000000002';
for (const browser of ['chrome', 'firefox']) {
  const { createCloudRunController } = await import(`../src/${browser}/src/cloud-runs.js`);
  test(`${browser}: keyed roots isolate expired guards, reuse tabs after restart, and retain child conversations`, async () => {
    const stored = {}, tabs = new Map([[7, { id: 7, url: 'https://example.com' }]]);
    const guards = new Set([7]), clears = [], observed = [];
    let tabSeq = 20, runSeq = 0, hold = null;
    const api = {
      storage: { session: { get: async key => ({ [key]: stored[key] }), set: async data => Object.assign(stored, data) } },
      tabs: { get: async id => { if (!tabs.has(id)) throw new Error('Closed tab'); return tabs.get(id); },
        query: async () => [tabs.get(7)], update: async id => tabs.get(id),
        create: async options => { const tab = { id: tabSeq++, url: options.url }; tabs.set(tab.id, tab); return tab; } },
    };
    const agent = { isRunning: () => false,
      clearConversation: async id => { clears.push(id); guards.delete(id); },
      processMessage: async (id, task) => { observed.push({ id, task, guarded: guards.has(id) }); if (hold) await hold; return task; },
    };
    const make = () => createCloudRunController({ chromeApi: api, agent, ensureOffscreen: async () => {}, makeRunId: () => 'run_' + (++runSeq) });
    let c = make();
    async function finished(run) {
      for (let i = 0; i < 50 && c.runs.get(run.runId).status === 'running'; i++) await new Promise(r => setTimeout(r, 5));
      assert.equal(c.runs.get(run.runId).status, 'completed');
    }
    const first = await c.startRun({ conversationKey: key1, task: 'first' }); await finished(first);
    assert.equal(first.tabId, 20); assert.ok(guards.has(7));
    guards.add(20);
    const second = await c.startRun({ conversationKey: key1, task: 'second' }); await finished(second);
    assert.equal(second.tabId, 20); assert.equal(observed.at(-1).guarded, false);
    const chat = await c.startRun({ conversationKey: key2, task: 'chat' }); await finished(chat);
    assert.equal(chat.tabId, 21);
    const before = clears.length;
    const child = await c.startRun({ parentRunId: chat.runId, task: 'continue' }); await finished(child);
    assert.equal(child.tabId, 21); assert.equal(clears.length, before);
    c = make();
    const restarted = await c.startRun({ conversationKey: key1, task: 'after restart' }); await finished(restarted);
    assert.equal(restarted.tabId, 20);
    tabs.delete(20);
    const reopened = await c.startRun({ conversationKey: key1, task: 'closed tab' }); await finished(reopened);
    assert.equal(reopened.tabId, 22);
    let release;
    hold = new Promise(r => { release = r; });
    const racing = await Promise.allSettled([c.startRun({ conversationKey: key1, task: 'held' }), c.startRun({ conversationKey: key1, task: 'race' })]);
    assert.equal(racing.filter(r => r.status === 'fulfilled').length, 1);
    const clearCount = clears.length;
    await assert.rejects(c.startRun({ conversationKey: key1, task: 'busy' }), error => error.status === 409 && /busy|starting/.test(error.message));
    assert.equal(clears.length, clearCount);
    release(); hold = null; await finished(racing.find(r => r.status === 'fulfilled').value);
    await assert.rejects(c.startRun({ conversationKey: key1, tabId: 7, task: 'conflict' }), /independent/);
    await assert.rejects(c.startRun({ conversationKey: 'secret-not-a-uuid', task: 'invalid' }), /UUID/);
    assert.ok(guards.has(7), 'unrelated conversation never reset');
  });
}
