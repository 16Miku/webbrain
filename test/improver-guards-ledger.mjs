import assert from 'node:assert/strict';
import { test } from 'node:test';

// Progress-ledger guards, in both builds:
// - a model-written "acted" row is refused while the latest action attempt
//   was never sent and nothing was dispatched since the model's last ledger
//   update, counted across steering revisions and continuation runs;
// - read-only named targets of a read-only run can reach processed;
// - runtime-recorded clicks fill unnamed expected slots instead of adding a
//   second row per item, live and when a persisted ledger is restored.
const BUILDS = ['chrome', 'firefox'];
const modules = {};
for (const build of BUILDS) {
  modules[build] = {
    Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
    intent: await import(`../src/${build}/src/agent/progress-intent.js`),
    ledger: await import(`../src/${build}/src/agent/progress-ledger.js`),
  };
}

function makeAgent(Agent, tabId, task) {
  const agent = new Agent({ getActive: () => ({ contextWindow: 128000, supportsVision: false }) });
  agent._persist = () => {};
  agent.conversationModes.set(tabId, 'act');
  agent.conversations.set(tabId, [{ role: 'system', content: 'sys' }, { role: 'user', content: task }]);
  return agent;
}

function seedRows(agent, tabId, sessionId, ids, fields = undefined) {
  const seeded = agent._progressUpdate(tabId, {
    items: ids.map(id => ({ id, label: id, action: 'follow', status: 'pending', ...(fields ? { fields } : {}) })),
  }, { source: 'classifier', sessionId });
  assert.equal(seeded.success, true);
}

const rowStatus = (agent, tabId, sessionId, id) => agent._rowsForProgressSession(tabId, sessionId)
  .find(row => row.id === id)?.status;

// An in-memory storage.session (JSON round-trip, like the browser's) under
// both globals, since each build reads its own, plus the few tab and runtime
// calls an interrupted batch's cleanup makes.
async function withSessionStorage(fn) {
  const store = new Map();
  const copy = value => JSON.parse(JSON.stringify(value));
  const area = {
    get: async key => Object.fromEntries((Array.isArray(key) ? key : [key])
      .filter(name => store.has(name)).map(name => [name, copy(store.get(name))])),
    set: async items => { for (const [name, value] of Object.entries(items)) store.set(name, copy(value)); },
    remove: async key => { for (const name of Array.isArray(key) ? key : [key]) store.delete(name); },
  };
  const saved = { chrome: globalThis.chrome, browser: globalThis.browser };
  globalThis.chrome = globalThis.browser = {
    storage: { session: area, local: area },
    runtime: { getURL: value => value, sendMessage: async () => ({}) },
    tabs: { get: async id => ({ id, url: 'https://example.test/' }), sendMessage: async () => ({}) },
    scripting: { executeScript: async () => [{ result: null }] },
  };
  try {
    return await fn(store);
  } finally {
    for (const name of ['chrome', 'browser']) {
      if (saved[name] === undefined) delete globalThis[name];
      else globalThis[name] = saved[name];
    }
  }
}

// A worker restart: a new Agent hydrates the tab's saved conversation.
async function restart(Agent, tabId) {
  const agent = new Agent({ getActive: () => ({ contextWindow: 128000, supportsVision: false }) });
  agent._persist = () => {};
  await agent._hydrate(tabId);
  return agent;
}

// What agent-lifecycle.mjs stubs to run a real tool batch without a page:
// the page preflights, the permission prompt and screenshots.
function allowRealBatch(agent) {
  Object.assign(agent, {
    _persistNow: async () => ({ ok: true }),
    _currentUrl: async () => 'https://example.test/',
    _skipPermissionGate: true,
    _ensureGateSetting: async () => true,
    _chromeProtectedPageFailure: async () => null,
    _captchaMutationPreflight: async () => null,
    _adoptLiveSocialPublishWorkflow: async () => false,
    _workflowPreSubmitDispatchBlock: async () => null,
    _messageRecipientGuardBlock: async () => null,
    _detectLikelySubmitAction: async () => null,
    _isFormValidationCandidate: () => false,
    _preflightRichTextToolbarTarget: async () => ({ block: null }),
    _socialPublicationPreSubmitBlock: async () => null,
    _auditRichTextToolbarTarget: async () => {},
    _shouldAutoScreenshot: () => false,
  });
}

// One call (a click_ax by default) through the real _executeToolBatch, in a
// claimed run; resolves to { value } or { error }.
async function realBatch(agent, tabId, step, name = 'click_ax', args = { ref_id: `ref_${step}` }) {
  const call = { id: `real_${step}`, function: { name, arguments: JSON.stringify(args) } };
  await agent._claimRunEntry(tabId, 'interactive');
  try {
    return await agent._executeToolBatch(tabId, [call], [{ role: 'assistant', tool_calls: [call] }], () => {},
      agent._activeProvider(tabId), null, new Set([name]), step, {}).then(value => ({ value }), error => ({ error }));
  } finally {
    agent._releaseRunEntry(tabId);
  }
}

// One tool batch whose first call reached `active` (the batch's record of the
// call in flight) and was then cut short, by Stop or by an ordinary error;
// `more` are later calls of the batch it never reached.
async function interruptBatch(agent, tabId, active, { stop, more = [] }) {
  const messages = agent.conversations.get(tabId);
  const [call, ...rest] = [active, ...more].map((entry, index) => ({ id: `call_${messages.length}_${index}`, type: 'function',
    function: { name: entry.name, arguments: JSON.stringify(entry.args || {}) } }));
  messages.push({ role: 'assistant', content: '', tool_calls: [call, ...rest] });
  agent._executeToolBatchInner = async (...params) => {
    params[10].active = { index: 0, consequential: true, result: null, ...active };
    if (!stop) throw new Error('The page connection was lost after the action was sent.');
    agent._checkAbort = () => true;
    throw new DOMException('Stopped', 'AbortError');
  };
  try {
    await assert.rejects(agent._executeToolBatch(tabId, [call, ...rest], messages, () => {}, {}, null));
  } finally {
    delete agent._executeToolBatchInner;
    delete agent._checkAbort;
  }
  return messages.filter(message => message.tool_call_id === call.id);
}
const blocked = { success: false, noDispatch: true, dispatched: false, error: 'Blocked before dispatch.' };
const sent = { success: true, dispatched: true };

for (const build of BUILDS) {
  const { Agent, intent, ledger } = modules[build];

  test(`${build}: the tab keeps a dispatch record across steering revisions and runs`, async () => {
    const tabId = 40;
    const agent = makeAgent(Agent, tabId, 'Follow alice.');
    const record = () => agent.progressActionDispatches.get(tabId);
    const token = agent._beginCompletionInvariant(tabId);

    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_3' }, blocked);
    assert.deepEqual(record(), { sent: 0, unsent: { name: 'click_ax' }, fence: null });
    assert.equal(agent.completionInvariants.get(tabId).hadAction, false, 'a blocked attempt is still not an action');
    agent._recordCompletionToolResult(tabId, 'read_page', {}, { success: true, content: 'page' });
    agent._recordCompletionToolResult(tabId, 'get_accessibility_tree', {}, { success: false, error: 'x' });
    assert.deepEqual(record().unsent, { name: 'click_ax' }, 'a read does not clear the mark');

    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_3' }, sent);
    assert.deepEqual(record(), { sent: 1, unsent: null, fence: null }, 'a dispatch supersedes the blocked attempt');
    agent._recordCompletionToolResult(tabId, 'type_ax', { ref_id: 'ref_4', text: 'hi' },
      { success: false, dispatched: false, error: 'Composer is not the bound recipient.' });
    assert.deepEqual(record().unsent, { name: 'type_ax' });
    // A verified no-op leaves the requested state in place.
    agent._recordCompletionToolResult(tabId, 'set_checked', { ref_id: 'ref_5', checked: true }, {
      success: true, idempotent: true, verified: true, dispatched: false, noDispatch: true, checkedAfter: true,
    });
    assert.equal(record().unsent, null);
    // An error after dispatch counts as sent; a benign key is not an action.
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_6' }, { success: false, error: 'Lost response.' });
    agent._recordCompletionToolResult(tabId, 'press_keys', { key: 'Tab' }, { success: false, dispatched: false });
    assert.deepEqual(record(), { sent: 2, unsent: null, fence: null });
    agent._recordCompletionToolResult(tabId, 'navigate', { url: 'https://example.test/' }, { success: false, dispatched: false, denied: true });
    assert.deepEqual(record(), { sent: 2, unsent: { name: 'navigate' }, fence: null });

    // Steering revisions and new runs keep the record; a cleared conversation drops it.
    agent._resetCompletionForSteeringRevision(tabId);
    agent._clearCompletionInvariant(tabId, token);
    agent._beginCompletionInvariant(tabId);
    assert.deepEqual(record(), { sent: 2, unsent: { name: 'navigate' }, fence: null });
    await agent.clearConversation(tabId);
    assert.equal(agent.progressActionDispatches.has(tabId), false);
  });

  test(`${build}: a model cannot mark a row acted after an action that was never sent`, async () => {
    const tabId = 41;
    const sessionId = `${build}-acted-guard`;
    const agent = makeAgent(Agent, tabId, 'Follow alice, bob and carol.');
    seedRows(agent, tabId, sessionId, ['alice', 'bob', 'carol']);
    agent._beginCompletionInvariant(tabId);
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_7' }, blocked);

    const rejected = agent._progressUpdate(tabId, { items: [{ id: 'alice', status: 'acted' }] }, { sessionId });
    assert.equal(rejected.success, false);
    assert.equal(rejected.actionNotDispatched, true);
    assert.deepEqual(rejected.ids, ['alice']);
    assert.deepEqual(rejected.undispatchedAction, { name: 'click_ax' });
    assert.match(rejected.error, /^progress_update: alice cannot be marked acted now\. Your latest click_ax call was not sent/);
    assert.match(rejected.error, /no action call has been sent yet\. Check the page first and record what it shows/);
    assert.match(rejected.error, /failed or skipped/);
    assert.match(rejected.error, /Send an action again only if the page shows it did not happen\.$/);
    assert.doesNotMatch(rejected.error, /retry the action/i, 'a refusal must not send the model to repeat the action');
    assert.equal(rowStatus(agent, tabId, sessionId, 'alice'), 'pending', 'the refused update changed nothing');
    assert.equal(agent._deliveryCheckpointMadeMeaningfulProgress('progress_update', rejected), false,
      'a refused update is not delivery progress');

    // The tool path is model-sourced too, and a concrete id reconciled to a
    // seeded row is the same claim.
    const viaTool = await agent.executeTool(tabId, 'progress_update', { items: [{ id: 'bob', status: 'acted' }], sessionId });
    assert.equal(viaTool.success, false);
    assert.equal(viaTool.actionNotDispatched, true);
    const brandNew = agent._progressUpdate(tabId, { items: [{ id: 'dave', label: 'dave', action: 'follow', status: 'acted' }] }, { sessionId });
    assert.equal(brandNew.success, false, 'a new row created as acted is the same claim');

    // Honest exits and runtime evidence stay open.
    const failed = agent._progressUpdate(tabId, { items: [{ id: 'alice', status: 'failed', reason: 'The follow was blocked.' }] }, { sessionId });
    assert.equal(failed.success, true);
    const auto = agent._progressUpdate(tabId, { items: [{ id: 'bob', status: 'acted' }] }, { source: 'auto', sessionId });
    assert.equal(auto.success, true, 'runtime-recorded rows carry their own evidence');
    const repeated = agent._progressUpdate(tabId, { items: [{ id: 'bob', status: 'acted' }] }, { sessionId });
    assert.equal(repeated.success, true, 'a row already acted is not a new claim');

    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_8' }, sent);
    const accepted = agent._progressUpdate(tabId, { items: [{ id: 'carol', status: 'acted' }] }, { sessionId });
    assert.equal(accepted.success, true, 'acted after a real dispatch is accepted');
    assert.equal(rowStatus(agent, tabId, sessionId, 'carol'), 'acted');
  });

  test(`${build}: a dispatch after the model's last update backs a claim, in this run or the previous one`, () => {
    const tabId = 42;
    const sessionId = `${build}-acted-fence`;
    const agent = makeAgent(Agent, tabId, 'Follow alice, bob, carol and dave.');
    seedRows(agent, tabId, sessionId, ['alice', 'bob', 'carol', 'dave']);
    const firstRun = agent._beginCompletionInvariant(tabId);

    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_1' }, sent);
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_2' }, blocked);
    const mixed = agent._progressUpdate(tabId, { items: [{ id: 'alice', status: 'acted' }] }, { sessionId });
    assert.equal(mixed.success, true, 'the dispatch before the blocked attempt is new since the last update');

    // The reported case: the next attempt is blocked and its row claimed anyway.
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_3' }, blocked);
    const fenced = agent._progressUpdate(tabId, { items: [{ id: 'bob', status: 'acted' }] }, { sessionId });
    assert.equal(fenced.success, false, 'the earlier dispatch was already recorded by the last update');
    assert.equal(fenced.actionNotDispatched, true);
    assert.match(fenced.error, /^progress_update: bob cannot be marked acted now\. Your latest click_ax call was not sent/);
    assert.match(fenced.error, /no action call has been sent since your last successful progress_update\. Check the page first/);
    assert.match(fenced.error, /Send an action again only if the page shows it did not happen\.$/);
    assert.doesNotMatch(fenced.error, /retry the action/i, 'a refusal must not send the model to repeat the action');
    assert.doesNotMatch(fenced.error, /the last click_ax call|bob[^.]*was not sent/, 'the refusal says this row\'s action was never sent');

    // Runtime rows (observe, auto) are not the model recording its dispatches.
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_4' }, sent); // bob, really sent
    assert.equal(agent._progressUpdate(tabId, { items: [{ id: 'erin', label: 'erin', action: 'follow', status: 'pending' }] },
      { source: 'observe', sessionId }).success, true);
    assert.equal(agent._progressUpdate(tabId, { items: [{ id: 'erin', status: 'acted' }] }, { source: 'auto', sessionId }).success, true);
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_5' }, blocked); // carol, blocked
    const afterRuntime = agent._progressUpdate(tabId, { items: [{ id: 'bob', status: 'acted' }] }, { sessionId });
    assert.equal(afterRuntime.success, true, `a runtime row moved the model's fence (${afterRuntime.error || ''})`);
    assert.equal(agent._progressUpdate(tabId, { items: [{ id: 'carol', status: 'acted' }] }, { sessionId }).success, false,
      'the model\'s own update moves the fence');

    // A continuation run keeps counting: a dispatch the previous run sent after
    // the model's last update backs a claim even when the first attempt of
    // the new run is blocked, and that update's fence still holds.
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_6' }, sent); // dave, really sent
    agent._clearCompletionInvariant(tabId, firstRun);
    agent._beginCompletionInvariant(tabId);
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_7' }, blocked);
    const continued = agent._progressUpdate(tabId, { items: [{ id: 'dave', status: 'acted' }] }, { sessionId });
    assert.equal(continued.success, true, `a dispatch from the previous run was refused (${continued.error || ''})`);
    assert.equal(agent._progressUpdate(tabId, { items: [{ id: 'carol', status: 'acted' }] }, { sessionId }).success, false,
      'a new run reopened the fence');

    // Without completion state (no Act run) the guard has nothing to read,
    // and a state carrying no run token or mark is read safely.
    const idle = makeAgent(Agent, 43, 'Follow alice and bob.');
    seedRows(idle, 43, `${build}-idle`, ['alice', 'bob']);
    assert.equal(idle._progressUpdate(43, { items: [{ id: 'alice', status: 'acted' }] }, { sessionId: `${build}-idle` }).success, true);
    idle.completionInvariants.set(43, { hadAction: true, verificationDebt: false });
    assert.equal(idle._progressUpdate(43, { items: [{ id: 'bob', status: 'acted' }] }, { sessionId: `${build}-idle` }).success, true);
  });

  test(`${build}: a steering revision keeps the dispatch count`, () => {
    const tabId = 44;
    const sessionId = `${build}-acted-steer`;
    const agent = makeAgent(Agent, tabId, 'Follow alice and bob.');
    seedRows(agent, tabId, sessionId, ['alice', 'bob', 'carol', 'dave']);
    agent._beginCompletionInvariant(tabId);
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'r1' }, sent);
    agent._recordCompletionToolResult(tabId, 'get_accessibility_tree', {}, { success: true, pageContent: 'x' });
    assert.equal(agent._progressUpdate(tabId, { items: [{ id: 'alice', status: 'acted' }] }, { sessionId }).success, true);
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'r2' }, sent); // bob, really sent
    agent._recordCompletionToolResult(tabId, 'get_accessibility_tree', {}, { success: true, pageContent: 'y' });
    agent._resetCompletionForSteeringRevision(tabId); // the user adds carol
    assert.equal(agent.completionInvariants.get(tabId).lastAction, null, 'the revision did not reset the run state');
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'r3' }, blocked); // carol, blocked
    const bob = agent._progressUpdate(tabId, { items: [{ id: 'bob', status: 'acted' }] }, { sessionId });
    assert.equal(bob.success, true, `a real follow sent before the revision was refused (${bob.error || ''})`);
    assert.equal(agent._progressUpdate(tabId, { items: [{ id: 'carol', status: 'acted' }] }, { sessionId }).success, false,
      'the blocked attempt after the revision was accepted');
    // An attempt blocked before a revision is still unsent after it.
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'r4' }, blocked); // dave, blocked
    agent._resetCompletionForSteeringRevision(tabId);
    assert.equal(agent._progressUpdate(tabId, { items: [{ id: 'dave', status: 'acted' }] }, { sessionId }).success, false);
  });

  test(`${build}: a worker restart keeps the dispatch record with the conversation`, async () => {
    await withSessionStorage(async store => {
      const tabId = 46;
      const sessionId = `${build}-restart`;
      const before = makeAgent(Agent, tabId, 'Follow alice, bob and carol.');
      seedRows(before, tabId, sessionId, ['alice', 'bob', 'carol']);
      before._beginCompletionInvariant(tabId);
      before._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_1' }, sent); // alice, not yet in the ledger
      assert.equal((await before._persistNow(tabId)).ok, true);
      assert.deepEqual(store.get(`agentConv:${tabId}`).progressActionDispatches, { sent: 1, unsent: null, fence: null });

      const after = await restart(Agent, tabId);
      assert.deepEqual(after.progressActionDispatches.get(tabId), { sent: 1, unsent: null, fence: null });
      after._beginCompletionInvariant(tabId);
      after._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_2' }, blocked); // bob, blocked
      const alice = after._progressUpdate(tabId, { items: [{ id: 'alice', status: 'acted' }] }, { sessionId });
      assert.equal(alice.success, true, `a follow sent before the restart was refused (${alice.error || ''})`);
      const bob = after._progressUpdate(tabId, { items: [{ id: 'bob', status: 'acted' }] }, { sessionId });
      assert.equal(bob.success, false, 'the blocked attempt after the restart was accepted');
      assert.match(bob.error, /since your last successful progress_update/);

      // The fence survives the next restart as well.
      assert.equal((await after._persistNow(tabId)).ok, true);
      const again = await restart(Agent, tabId);
      again._beginCompletionInvariant(tabId);
      again._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_3' }, blocked);
      assert.equal(again._progressUpdate(tabId, { items: [{ id: 'carol', status: 'acted' }] }, { sessionId }).success, false);

      // A conversation counted from its start still refuses the reported case
      // after a restart: nothing was ever sent.
      const freshTab = 47;
      const freshSession = `${build}-restart-fresh`;
      const fresh = makeAgent(Agent, freshTab, 'Follow alice and bob.');
      seedRows(fresh, freshTab, freshSession, ['alice', 'bob']);
      fresh._beginCompletionInvariant(freshTab);
      fresh._recordCompletionToolResult(freshTab, 'click_ax', { ref_id: 'ref_1' }, blocked);
      assert.equal((await fresh._persistNow(freshTab)).ok, true);
      const freshAfter = await restart(Agent, freshTab);
      freshAfter._beginCompletionInvariant(freshTab);
      const reported = freshAfter._progressUpdate(freshTab, { items: [{ id: 'alice', status: 'acted' }] }, { sessionId: freshSession });
      assert.equal(reported.success, false);
      assert.match(reported.error, /no action call has been sent yet/);
    });
  });

  test(`${build}: a restored conversation without a dispatch record refuses nothing until the model's next update`, async () => {
    await withSessionStorage(async store => {
      const sourceTab = 53;
      const sessionId = `${build}-legacy`;
      const source = makeAgent(Agent, sourceTab, 'Follow alice and bob.');
      seedRows(source, sourceTab, sessionId, ['alice', 'bob']);
      assert.equal((await source._persistNow(sourceTab)).ok, true);
      const saved = store.get(`agentConv:${sourceTab}`);

      // An entry from an older version: history, but no record of its action calls.
      const legacyTab = 54;
      const legacy = { ...saved };
      delete legacy.progressActionDispatches;
      store.set(`agentConv:${legacyTab}`, legacy);
      const restored = await restart(Agent, legacyTab);
      assert.deepEqual(restored.progressActionDispatches.get(legacyTab), { sent: 0, unsent: null, fence: null, historyUnknown: true });
      restored._beginCompletionInvariant(legacyTab);
      restored._recordCompletionToolResult(legacyTab, 'click_ax', { ref_id: 'ref_2' }, blocked);
      const unknown = restored._progressUpdate(legacyTab, { items: [{ id: 'alice', status: 'acted' }] }, { sessionId });
      assert.equal(unknown.success, true, `a claim over uncounted history was refused (${unknown.error || ''})`);
      // That update covers the earlier history, so the guard is back, without
      // ever saying that nothing was sent.
      restored._recordCompletionToolResult(legacyTab, 'click_ax', { ref_id: 'ref_3' }, blocked);
      const next = restored._progressUpdate(legacyTab, { items: [{ id: 'bob', status: 'acted' }] }, { sessionId });
      assert.equal(next.success, false);
      assert.doesNotMatch(next.error, /sent yet/);

      // A damaged record is treated the same; a saved null means no action call.
      for (const [index, value] of [{ sent: -1 }, { sent: 2, fence: 5 }, { sent: 1, unsent: { name: '' } }, 'x'].entries()) {
        store.set(`agentConv:${60 + index}`, { ...saved, progressActionDispatches: value });
        assert.equal((await restart(Agent, 60 + index)).progressActionDispatches.get(60 + index)?.historyUnknown, true, JSON.stringify(value));
      }
      assert.equal(saved.progressActionDispatches, null);
      assert.equal((await restart(Agent, sourceTab)).progressActionDispatches.has(sourceTab), false);
    });
  });

  test(`${build}: a fork takes a copy of its source's dispatch record`, async () => {
    await withSessionStorage(async store => {
      const sourceTab = 55;
      const forkTab = 56;
      const agent = makeAgent(Agent, sourceTab, 'Follow alice and bob.');
      agent._beginCompletionInvariant(sourceTab);
      agent._recordCompletionToolResult(sourceTab, 'click_ax', { ref_id: 'ref_1' }, sent);
      agent._recordCompletionToolResult(sourceTab, 'click_ax', { ref_id: 'ref_2' }, blocked);
      agent.progressActionDispatches.set(forkTab, { sent: 9, unsent: null, fence: 9 }); // stale, from an earlier use of the tab id
      await agent.forkConversation(sourceTab, forkTab);
      const expected = { sent: 1, unsent: { name: 'click_ax' }, fence: null };
      assert.deepEqual(agent.progressActionDispatches.get(forkTab), expected);
      assert.notEqual(agent.progressActionDispatches.get(forkTab), agent.progressActionDispatches.get(sourceTab), 'the fork shares its source\'s record');
      assert.deepEqual(store.get(`agentConv:${forkTab}`).progressActionDispatches, expected);

      // A source with no action call gives its fork none.
      const quiet = makeAgent(Agent, 57, 'Summarize this page.');
      quiet.progressActionDispatches.set(58, { sent: 3, unsent: null, fence: 1 });
      await quiet.forkConversation(57, 58);
      assert.equal(quiet.progressActionDispatches.has(58), false);
    });
  });

  test(`${build}: an action cut short after it may have been sent backs an acted row`, async () => {
    await withSessionStorage(async () => {
      const cases = [
        ['Stop after dispatch', true, { dispatchState: { started: true, rawToolResult: { success: true, dispatched: true } } }],
        ['an error after dispatch', false, { dispatchState: { started: true } }],
        ['Stop with an unknown outcome', true, { result: { success: false, outcomeUnknown: true, error: 'No response.' }, dispatchState: {} }],
      ];
      for (const [index, [label, stop, state]] of cases.entries()) {
        const tabId = 80 + index;
        const sessionId = `${build}-interrupted-${index}`;
        const agent = makeAgent(Agent, tabId, 'Follow alice.');
        seedRows(agent, tabId, sessionId, ['alice']);
        agent._beginCompletionInvariant(tabId);
        agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_1' }, blocked); // an earlier blocked attempt
        const results = await interruptBatch(agent, tabId, {
          name: 'click_ax', args: { ref_id: 'ref_2' }, invoked: true, ...state,
        }, { stop });
        if (stop) assert.equal(JSON.parse(results[0].content.replace(/^[^\n]*\n|\n[^\n]*$/g, '')).cancelled, true, label);
        assert.deepEqual(agent.progressActionDispatches.get(tabId), { sent: 1, unsent: null, fence: null }, label);
        agent._beginCompletionInvariant(tabId); // the next run records the row
        const claim = agent._progressUpdate(tabId, { items: [{ id: 'alice', status: 'acted' }] }, { sessionId });
        assert.equal(claim.success, true, `${label}: ${claim.error || ''}`);
      }

      // Stop also answers the calls the batch never reached; they were not sent.
      const tailTab = 84;
      const tailSession = `${build}-interrupted-tail`;
      const tailAgent = makeAgent(Agent, tailTab, 'Follow alice and bob.');
      seedRows(tailAgent, tailTab, tailSession, ['alice', 'bob']);
      tailAgent._beginCompletionInvariant(tailTab);
      const answered = await interruptBatch(tailAgent, tailTab, { name: 'click_ax', args: { ref_id: 'ref_1' }, invoked: true,
        dispatchState: { started: true, rawToolResult: sent } }, { stop: true, more: [{ name: 'click_ax', args: { ref_id: 'ref_2' } }] });
      assert.equal(answered.length, 1);
      assert.deepEqual(tailAgent.progressActionDispatches.get(tailTab), { sent: 1, unsent: { name: 'click_ax' }, fence: null });
      tailAgent._beginCompletionInvariant(tailTab);
      assert.equal(tailAgent._progressUpdate(tailTab, { items: [{ id: 'alice', status: 'acted' }] }, { sessionId: tailSession }).success, true);
      assert.equal(tailAgent._progressUpdate(tailTab, { items: [{ id: 'bob', status: 'acted' }] }, { sessionId: tailSession }).success, false);

      // A call cut short before it was invoked was not sent; a call whose own
      // bookkeeping already ran is not counted twice.
      const tabId = 85;
      const sessionId = `${build}-interrupted-unsent`;
      const agent = makeAgent(Agent, tabId, 'Follow alice and bob.');
      seedRows(agent, tabId, sessionId, ['alice', 'bob']);
      agent._beginCompletionInvariant(tabId);
      agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_1' }, sent);
      assert.equal(agent._progressUpdate(tabId, { items: [{ id: 'alice', status: 'acted' }] }, { sessionId }).success, true);
      await interruptBatch(agent, tabId, { name: 'click_ax', args: { ref_id: 'ref_2' }, invoked: false }, { stop: true });
      assert.deepEqual(agent.progressActionDispatches.get(tabId), { sent: 1, unsent: { name: 'click_ax' }, fence: 1 });
      await interruptBatch(agent, tabId, { name: 'click_ax', args: { ref_id: 'ref_3' }, invoked: true, dispatchNoted: true,
        dispatchState: { started: true, rawToolResult: sent } }, { stop: false });
      assert.deepEqual(agent.progressActionDispatches.get(tabId), { sent: 1, unsent: { name: 'click_ax' }, fence: 1 });
      agent._beginCompletionInvariant(tabId);
      const refused = agent._progressUpdate(tabId, { items: [{ id: 'bob', status: 'acted' }] }, { sessionId });
      assert.equal(refused.success, false);
      assert.match(refused.error, /Check the page first and record what it shows/);
      assert.doesNotMatch(refused.error, /retry the action/i);
    });
  });

  test(`${build}: the real batch path notes an interrupted call once, judged by what it returned`, async () => {
    await withSessionStorage(async () => {
      const tabId = 100;
      const sessionId = `${build}-real-batch`;
      const agent = makeAgent(Agent, tabId, 'Follow alice.');
      allowRealBatch(agent);
      seedRows(agent, tabId, sessionId, ['alice']);
      agent._beginCompletionInvariant(tabId);
      const record = () => agent.progressActionDispatches.get(tabId) || { sent: 0, unsent: null, fence: null };
      const stop = () => { agent.abort(tabId); throw agent._runAbortSignal(tabId).reason; };
      const stale = { success: false, fallbackAttempted: false, error: 'Stale ref.' };
      let step = 0;
      const expectNoted = (before, wasSent, label) => assert.deepEqual(record(), wasSent
        ? { sent: before + 1, unsent: null, fence: null } : { sent: before, unsent: { name: 'click_ax' }, fence: null }, label);

      // Stop or an error after the call's own bookkeeping: counted once.
      for (const [label, interrupt] of [['Stop', stop], ['an error', () => { throw new Error('Observer failed.'); }]]) {
        agent.executeTool = async () => ({ ...sent });
        agent._autoRecordProgressAction = async () => interrupt();
        const before = record().sent;
        assert.ok((await realBatch(agent, tabId, ++step)).error, `${label}: the batch was not interrupted`);
        expectNoted(before, true, `${label} after the bookkeeping counted the call twice`);
      }
      delete agent._autoRecordProgressAction;

      // Stop as the call returns, before its bookkeeping: judged by what it returned.
      for (const [label, returned, wasSent] of [
        ['a dispatched click', sent, true],
        ['a stale ref', stale, false],
        ['a skipped click', { success: false, skipped: true, error: 'Skipped.' }, false],
        ['a denied click', { success: false, denied: true, error: 'Denied.' }, false],
      ]) {
        agent.executeTool = async () => { agent.abort(tabId); return { ...returned }; };
        const before = record().sent;
        assert.equal((await realBatch(agent, tabId, ++step)).error?.name, 'AbortError', label);
        expectNoted(before, wasSent, `Stop before the bookkeeping of ${label}`);
      }

      // An error before the bookkeeping is judged the same way.
      agent._captureCompletionSemanticNavigation = async () => { throw new Error('Capture failed.'); };
      for (const [label, returned, wasSent] of [['a dispatched click', sent, true], ['a stale ref', stale, false]]) {
        agent.executeTool = async () => ({ ...returned });
        const before = record().sent;
        assert.equal((await realBatch(agent, tabId, ++step)).error?.message, 'Capture failed.', label);
        expectNoted(before, wasSent, `an error before the bookkeeping of ${label}`);
      }
      delete agent._captureCompletionSemanticNavigation;

      // Stop while the call is in flight leaves no result: it may have been sent.
      agent.executeTool = async (_tab, _name, _args, _update, context) => {
        agent.abort(tabId);
        throw context._contentActionAbortSignal.reason;
      };
      const before = record().sent;
      assert.equal((await realBatch(agent, tabId, ++step)).error?.name, 'AbortError');
      expectNoted(before, true, 'Stop with no result');

      agent._beginCompletionInvariant(tabId);
      assert.equal(agent._progressUpdate(tabId, { items: [{ id: 'alice', status: 'acted' }] }, { sessionId }).success, true);
    });
  });

  test(`${build}: an interrupted app-owned chat read repair is not the model's dispatch`, async () => {
    await withSessionStorage(async () => {
      const tabId = 102;
      const agent = makeAgent(Agent, tabId, 'Reply to the latest message.');
      allowRealBatch(agent);
      // The native chat owner scope is tied to the provider object, which a
      // real run keeps stable.
      const provider = agent._activeProvider(tabId);
      agent._activeProvider = () => provider;
      agent._beginCompletionInvariant(tabId);
      agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_1' }, blocked); // the model's own blocked click
      const before = { sent: 0, unsent: { name: 'click_ax' }, fence: null };
      const repaired = { success: true, dispatched: true, _nativeWhatsappReadRepair: true };
      // The recipient guard marks a click as the app's own read repair.
      agent._messageRecipientGuardBlock = async (tab, _name, _args, _url, context) => {
        context.nativeWhatsappReadRepairOwner = agent._nativeChatOwnerScope(tab);
        assert.ok(context.nativeWhatsappReadRepairOwner, 'no native chat owner in this fixture');
        return null;
      };
      agent.executeTool = async () => ({ ...repaired });
      assert.ok((await realBatch(agent, tabId, 1)).value, 'the repair did not complete');
      assert.deepEqual(agent.progressActionDispatches.get(tabId), before, 'the normal path counted the repair');
      // An error after the repair returned, before its bookkeeping: the same exemption.
      agent._captureCompletionSemanticNavigation = async () => { throw new Error('Capture failed.'); };
      assert.equal((await realBatch(agent, tabId, 2)).error?.message, 'Capture failed.');
      assert.deepEqual(agent.progressActionDispatches.get(tabId), before, 'an interrupted repair counted as sent');
      delete agent._captureCompletionSemanticNavigation;
      delete agent._messageRecipientGuardBlock;

      // Stop during the batch the app runs as its own repair clears the owner
      // scope; the batch is still the app's, whatever the click returned, and
      // so it is when the batch ends normally.
      const failed = { success: false, error: 'The pane closed.' };
      for (const [step, returned, stop] of [[3, repaired, true], [4, failed, true], [5, failed, false]]) {
        await agent._claimRunEntry(tabId, 'interactive');
        try {
          const owner = agent._nativeChatOwnerScope(tabId);
          agent.chatSessions.set(tabId, { threadKey: 'thread-1' });
          agent._captureOwnedNativeChatReadAuthority = () => ({ threadKey: 'thread-1', isCurrent: () => true });
          agent._ownedNativeChatReadRepairs.set(tabId, { pending: { scope: { owner } },
            controller: { isCurrent: () => true, run: (_record, dispatch) => dispatch('click_ax', { ref_id: `ref_${step}` }) } });
          agent.executeTool = async () => { if (stop) agent.abort(tabId); return { ...returned }; };
          const failure = await agent._runOwnedNativeChatReadRepair(tabId, [], () => {}, agent._activeProvider(tabId),
            new Set(['click_ax']), step, {}, null).then(() => null, error => error);
          assert.equal(failure?.name, stop ? 'AbortError' : undefined, `step ${step}: the owned repair ended unexpectedly`);
        } finally {
          agent._releaseRunEntry(tabId);
        }
        assert.deepEqual(agent.progressActionDispatches.get(tabId), before, `step ${step}: a stopped owned repair counted`);
      }
    });
  });

  test(`${build}: an interrupted skill download is judged as a download, like the normal path`, async () => {
    await withSessionStorage(async () => {
      const tabId = 103;
      const agent = makeAgent(Agent, tabId, 'Save the monthly report.');
      allowRealBatch(agent);
      agent._activeSkillToolForName = (_tab, name) => (name === 'save_report' ? { name, requiresDownloadPermission: true,
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } : null);
      agent._beginCompletionInvariant(tabId);
      const record = () => agent.progressActionDispatches.get(tabId) || { sent: 0, unsent: null, fence: null };
      const save = step => realBatch(agent, tabId, step, 'save_report', { url: 'https://example.test/report.pdf' });
      // The normal path counts it as a download action.
      agent.executeTool = async () => ({ success: true, downloadId: 7 });
      assert.ok((await save(1)).value);
      assert.deepEqual(record(), { sent: 1, unsent: null, fence: null });
      // Stop as it returns, and Stop with no result, count it the same way.
      agent.executeTool = async () => { agent.abort(tabId); return { success: true, downloadId: 8 }; };
      assert.equal((await save(2)).error?.name, 'AbortError');
      assert.deepEqual(record(), { sent: 2, unsent: null, fence: null }, 'a stopped download was not noted');
      agent.executeTool = async (_tab, _name, _args, _update, context) => {
        agent.abort(tabId);
        throw context._contentActionAbortSignal.reason;
      };
      assert.equal((await save(3)).error?.name, 'AbortError');
      assert.deepEqual(record(), { sent: 3, unsent: null, fence: null }, 'a download stopped in flight was not noted');
    });
  });

  test(`${build}: an interrupted upload that returned without dispatching is noted as unsent`, async () => {
    await withSessionStorage(async () => {
      const tabId = 101;
      const agent = makeAgent(Agent, tabId, 'Upload the report.');
      agent._beginCompletionInvariant(tabId);
      agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_1' }, sent);
      // The same predicate as the normal path: an upload_file failure that
      // never set dispatched did not reach the page.
      await interruptBatch(agent, tabId, { name: 'upload_file', args: { selector: '#file', filePath: '/tmp/report.pdf' }, invoked: true,
        result: { success: false, error: 'The file could not be read.' }, dispatchState: { started: false } }, { stop: true });
      assert.deepEqual(agent.progressActionDispatches.get(tabId), { sent: 1, unsent: { name: 'upload_file' }, fence: null });
    });
  });

  test(`${build}: a call answered as not sent without running is noted as unsent`, () => {
    const tabId = 86;
    const agent = makeAgent(Agent, tabId, 'Follow alice.');
    agent._beginCompletionInvariant(tabId);
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_1' }, sent);
    const calls = [
      { id: 'skip_1', function: { name: 'read_page', arguments: '{}' } },
      { id: 'skip_2', function: { name: 'click_ax', arguments: '{"ref_id":"ref_2"}' } },
    ];
    const messages = [];
    agent._appendSyntheticToolResults(tabId, calls, 0, messages, () => {}, 1, () => ({
      success: false, dispatched: false, noDispatch: true, errorCode: 'checkpoint_not_durable', error: 'Not saved.',
    }));
    assert.equal(messages.length, 2);
    assert.deepEqual(agent.progressActionDispatches.get(tabId), { sent: 1, unsent: { name: 'click_ax' }, fence: null });
    // A synthetic answer that does not say the call went unsent changes nothing.
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_3' }, sent);
    agent._appendSyntheticToolResults(tabId, [calls[1]], 0, [], () => {}, 1, () => ({ success: false, skipped: true, error: 'skipped' }));
    assert.deepEqual(agent.progressActionDispatches.get(tabId), { sent: 2, unsent: null, fence: null });
  });

  test(`${build}: a restored history ending in an action without a known outcome refuses nothing`, async () => {
    await withSessionStorage(async store => {
      const sessionId = `${build}-trailing`;
      const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      const tails = [
        ['a missing result', [{ role: 'assistant', content: '', tool_calls: [call('t1', 'click_ax', { ref_id: 'ref_2' })] }], true],
        ['an unknown outcome', [{ role: 'assistant', content: '', tool_calls: [call('t1', 'click_ax', { ref_id: 'ref_2' })] },
          { role: 'tool', tool_call_id: 't1', content: JSON.stringify({ success: false, outcomeUnknown: true, cancelled: true }) }], true],
        ['a read without a result', [{ role: 'assistant', content: '', tool_calls: [call('t1', 'read_page', {})] }], false],
        ['an action proven unsent', [{ role: 'assistant', content: '', tool_calls: [call('t1', 'click_ax', { ref_id: 'ref_2' })] },
          { role: 'tool', tool_call_id: 't1', content: JSON.stringify(blocked) }], false],
      ];
      for (const [index, [label, tail, unknown]] of tails.entries()) {
        const tabId = 90 + index;
        const before = makeAgent(Agent, tabId, 'Follow alice.');
        seedRows(before, tabId, sessionId, ['alice']);
        before._beginCompletionInvariant(tabId);
        before._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_1' }, blocked);
        before.conversations.get(tabId).push(...tail); // the worker stopped here
        assert.equal((await before._persistNow(tabId)).ok, true);
        const after = await restart(Agent, tabId);
        assert.deepEqual(after.progressActionDispatches.get(tabId), unknown
          ? { sent: 0, unsent: null, fence: null, historyUnknown: true }
          : { sent: 0, unsent: { name: 'click_ax' }, fence: null }, label);
        after._beginCompletionInvariant(tabId);
        after._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_3' }, blocked);
        const claim = after._progressUpdate(tabId, { items: [{ id: 'alice', status: 'acted' }] }, { sessionId });
        assert.equal(claim.success, unknown, `${label}: ${claim.error || ''}`);
        if (!unknown) assert.doesNotMatch(claim.error, /retry the action/i);
      }
      assert.ok(store.size >= tails.length);
    });
  });

  test(`${build}: a refused claim creates and activates no progress session`, () => {
    const tabId = 45;
    const task = 'Follow alice.';
    const agent = makeAgent(Agent, tabId, task);
    agent._beginCompletionInvariant(tabId);
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_1' }, blocked);
    const claim = { items: [{ id: 'alice', label: 'alice', action: 'follow', status: 'acted' }] };
    assert.equal(agent._progressUpdate(tabId, claim).success, false);
    assert.equal(agent.progressSessions.has(tabId), false, 'a refused update created a session');
    assert.deepEqual(agent.progressLedgers.get(tabId) || [], []);

    const inactive = agent._setProgressSession(tabId, {
      mode: 'inactive', allowedActions: [], forbiddenActions: [], confidence: 0,
    }, { taskText: task, source: 'classifier' });
    assert.equal(agent._progressUpdate(tabId, claim).success, false);
    assert.equal(agent.progressSessions.get(tabId), inactive, 'a refused update replaced the session');
    assert.equal(intent.isProgressIntentActive(agent.progressSessions.get(tabId)), false, 'a refused update activated the session');

    // The same update after a real dispatch goes through and activates it.
    agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_1' }, sent);
    assert.equal(agent._progressUpdate(tabId, claim).success, true);
    assert.equal(intent.isProgressIntentActive(agent.progressSessions.get(tabId)), true);
  });

  test(`${build}: read-only named targets of a read-only run can be processed after reads`, () => {
    for (const withExpectedRows of [false, true]) {
      const tabId = withExpectedRows ? 52 : 51;
      const task = 'Collect the public emails of alice and bob.';
      const agent = makeAgent(Agent, tabId, task);
      agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute', requiresStateChange: false });
      const session = agent._setProgressSession(tabId, {
        mode: 'active', allowedActions: ['collect_email'], forbiddenActions: [], targets: ['alice', 'bob'], confidence: 0.9,
      }, { taskText: task, source: 'classifier' });
      if (withExpectedRows) {
        agent._seedExpectedProgressItems(tabId, session, { count: 2, item_type: 'profile', ordered: true, required_fields: [] });
      }
      agent._seedClassifierProgressTargets(tabId, session);
      const rows = agent._rowsForProgressSession(tabId, session.sessionId);
      assert.deepEqual(rows.map(row => row.id), withExpectedRows
        ? ['expected:1', 'expected:2'] : ['requirement:1:alice', 'requirement:2:bob']);
      assert.deepEqual(rows.map(row => row.target), ['alice', 'bob']);
      assert.ok(rows.every(row => row.fields?.classifierTarget === true), 'targets still bind as classifier rows');
      assert.ok(rows.every(row => row.fields?.completionRequirement !== true),
        'a read-only target is not held to a consequential action');

      agent._beginCompletionInvariant(tabId);
      agent._recordCompletionToolResult(tabId, 'read_page', {}, { success: true, content: 'alice: alice@example.test' });
      const processed = agent._progressUpdate(tabId, {
        items: [{ id: rows[0].id, status: 'processed', fields: { email: 'alice@example.test' } }],
      }, { sessionId: session.sessionId });
      assert.equal(processed.success, true, `processed was out of reach (${processed.error || ''})`);
      assert.equal(rowStatus(agent, tabId, session.sessionId, rows[0].id), 'processed');
    }
  });

  test(`${build}: state-changing named targets still need a consequential action`, () => {
    for (const [index, [requiresStateChange, action]] of [[true, 'collect_email'], [false, 'follow'], [null, 'collect_email']].entries()) {
      const tabId = 60 + index;
      const task = 'Handle alice and bob.';
      const agent = makeAgent(Agent, tabId, task);
      agent._startPlanExecutionGuard(tabId, 'act', {
        requestKind: 'execute', ...(requiresStateChange === null ? {} : { requiresStateChange }),
      });
      const session = agent._setProgressSession(tabId, {
        mode: 'active', allowedActions: [action], forbiddenActions: [], targets: ['alice', 'bob'], confidence: 0.9,
      }, { taskText: task, source: 'classifier' });
      agent._seedClassifierProgressTargets(tabId, session);
      const rows = agent._rowsForProgressSession(tabId, session.sessionId);
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.fields?.completionRequirement === true),
        `${action} with requiresStateChange=${requiresStateChange} lost its evidence requirement`);
      agent._beginCompletionInvariant(tabId);
      agent._recordCompletionToolResult(tabId, 'read_page', {}, { success: true, content: 'profile' });
      const processed = agent._progressUpdate(tabId, { items: [{ id: rows[0].id, status: 'processed' }] }, { sessionId: session.sessionId });
      assert.equal(processed.success, false);
      assert.equal(processed.completionInvariant, true);
    }
  });

  test(`${build}: auto-recorded clicks fill bare expected slots in order`, () => {
    const { upsertLedgerItems } = ledger;
    const sessionId = 'bare-slots';
    const placeholders = [1, 2, 3].map(ordinal => ({
      id: `expected:${ordinal}`, label: `profile ${ordinal}`, action: 'follow', status: 'pending',
      fields: { expectedOrdinal: ordinal, completionRequirement: true },
    }));
    let state = upsertLedgerItems([], placeholders, { source: 'classifier', sessionId, now: 100 });
    for (const [index, name] of ['alice', 'bob'].entries()) {
      state = upsertLedgerItems(state.rows, [{
        id: name, label: `follow ${name}`, action: 'follow', status: 'acted', url: `https://example.test/${name}`,
      }], { source: 'auto', sessionId, now: 200 + index });
      assert.deepEqual(state.reconciled, [{ incomingId: name, canonicalId: `expected:${index + 1}` }]);
    }
    assert.equal(state.rows.length, 3, '3 slots + 2 clicks must stay 3 rows');
    assert.deepEqual(state.rows.map(row => row.target || null), ['alice', 'bob', null]);
    assert.deepEqual(state.rows.map(row => row.status), ['acted', 'acted', 'pending']);
    assert.ok(state.rows.slice(0, 2).every(row => row.source === 'auto' && row.fields.completionRequirement === true));

    // The same item again never takes a fresh slot.
    state = upsertLedgerItems(state.rows, [{
      id: 'alice-again', label: 'follow alice', action: 'follow', status: 'acted', url: 'https://example.test/alice',
    }], { source: 'auto', sessionId, now: 300 });
    assert.deepEqual(state.reconciled, [{ incomingId: 'alice-again', canonicalId: 'expected:1' }]);
    assert.equal(state.rows.length, 3);

    // An item already finished as its own row does not take a slot either.
    let finished = upsertLedgerItems([], [placeholders[0], {
      id: 'dave', label: 'dave', target: 'dave', action: 'follow', status: 'processed',
    }], { source: 'model', sessionId, now: 100 });
    finished = upsertLedgerItems(finished.rows, [{
      id: 'dave-click', label: 'follow dave', action: 'follow', status: 'acted',
    }], { source: 'auto', sessionId, now: 200 });
    assert.equal(finished.rows.find(row => row.id === 'expected:1').status, 'pending');

    // A slot already acted on without a target (a carousel step) is skipped.
    let skipped = upsertLedgerItems([], placeholders.slice(0, 2), { source: 'classifier', sessionId, now: 100 });
    skipped = upsertLedgerItems(skipped.rows, [{ id: 'expected:1', status: 'acted', fields: { carousel_position: 1 } }],
      { source: 'auto', sessionId, now: 150 });
    skipped = upsertLedgerItems(skipped.rows, [{ id: 'erin', label: 'follow erin', action: 'follow', status: 'acted' }],
      { source: 'auto', sessionId, now: 200 });
    assert.deepEqual(skipped.reconciled, [{ incomingId: 'erin', canonicalId: 'expected:2' }]);

    // Named classifier targets keep the identity requirement.
    let named = upsertLedgerItems([], [placeholders[0], {
      id: 'requirement:1:carol', label: 'carol', target: 'carol', action: 'follow', status: 'pending',
      fields: { completionRequirement: true, classifierTarget: true },
    }], { source: 'classifier', sessionId, now: 100 });
    named = upsertLedgerItems(named.rows, [{ id: 'stray-bob', label: 'follow bob', action: 'follow', status: 'acted' }],
      { source: 'auto', sessionId, now: 200 });
    assert.deepEqual(named.reconciled, []);
    assert.equal(named.rows.find(row => row.id === 'expected:1').status, 'pending');

    // Unchanged: an observer batch larger than the remaining slots binds nothing.
    let observed = upsertLedgerItems([], placeholders.slice(0, 2), { source: 'classifier', sessionId, now: 100 });
    observed = upsertLedgerItems(observed.rows, ['p', 'q', 'r'].map(name => ({
      id: name, label: name, target: name, action: 'follow', status: 'pending',
    })), { source: 'observe', sessionId, now: 200 });
    assert.deepEqual(observed.reconciled, []);
    assert.equal(observed.rows.length, 5);
  });

  test(`${build}: restoring a ledger binds bare slots in order only when counts match`, () => {
    const { reconcilePersistedLedgerRows } = ledger;
    const sessionId = 'restored-slots';
    const slot = ordinal => ({
      id: `expected:${ordinal}`, label: `profile ${ordinal}`, action: 'follow', status: 'pending', sessionId,
      fields: { expectedOrdinal: ordinal, completionRequirement: true },
    });
    const click = name => ({ id: name, label: `follow ${name}`, action: 'follow', status: 'acted', sessionId, source: 'auto' });

    const restored = reconcilePersistedLedgerRows([slot(1), slot(2), click('carol'), click('dave')]);
    assert.deepEqual(restored.reconciled, [
      { incomingId: 'carol', canonicalId: 'expected:1' },
      { incomingId: 'dave', canonicalId: 'expected:2' },
    ]);
    assert.deepEqual(restored.rows.map(row => [row.id, row.target, row.status]),
      [['expected:1', 'carol', 'acted'], ['expected:2', 'dave', 'acted']]);
    assert.ok(restored.rows.every(row => row.fields.expectedOrdinal && row.fields.completionRequirement === true));

    const mismatch = reconcilePersistedLedgerRows([slot(1), slot(2), slot(3), click('carol'), click('dave')]);
    assert.equal(mismatch.changed, false, 'without an identity, only an exact count binds by order');
    assert.equal(mismatch.rows.length, 5);

    const finished = reconcilePersistedLedgerRows([slot(1), slot(2), click('carol'), { ...click('dave'), status: 'processed' }]);
    assert.equal(finished.changed, false, 'order alone must not carry a finished outcome into a slot');
    assert.equal(finished.rows.find(row => row.id === 'expected:2').status, 'pending');

    const named = reconcilePersistedLedgerRows([slot(1), slot(2), click('carol'), click('dave'), {
      id: 'requirement:1:erin', label: 'erin', target: 'erin', action: 'follow', status: 'pending', sessionId,
      fields: { completionRequirement: true, classifierTarget: true },
    }]);
    assert.ok(!named.reconciled.some(entry => entry.incomingId === 'carol'),
      'with classifier targets, a slot still needs identity agreement');
  });

  test(`${build}: runtime-recorded clicks fill unnamed expected rows instead of doubling the ledger`, async () => {
    const tabId = 70;
    const taskText = 'Follow the first three people in this list.';
    const agent = makeAgent(Agent, tabId, taskText);
    agent._classifyProgressIntentWithProvider = async () => ({
      mode: 'active', allowedActions: ['follow'], forbiddenActions: [], targets: [], confidence: 0.9, pageScopePolicy: 'page',
    });
    const session = await agent._ensureProgressSessionForCurrentTask(tabId, {
      taskText,
      pageScope: 'https://example.test/people',
      progressLedgerPolicy: 'enabled',
      progressAction: 'follow',
      expectedItems: { count: 3, item_type: 'profile', ordered: true, required_fields: [] },
    });
    assert.equal(agent._rowsForProgressSession(tabId, session.sessionId).length, 3);
    const names = ['alice', 'bob', 'carol'];
    let clicked = 0;
    agent._progressItemFromClickedLabel = async () => {
      const name = names[clicked++];
      return { id: name, label: `follow ${name}`, action: 'follow', status: 'acted', url: `https://example.test/${name}` };
    };
    for (let index = 0; index < names.length; index++) {
      const recorded = await agent._autoRecordProgressAction(tabId, 'click_ax', { ref_id: `ref_${index + 1}` }, sent);
      assert.equal(recorded?.item?.id, `expected:${index + 1}`, `click ${index + 1} did not fill its slot`);
    }
    const rows = agent._rowsForProgressSession(tabId, session.sessionId);
    assert.equal(rows.length, 3, `${names.length} clicks on ${names.length} unnamed slots doubled the ledger`);
    assert.deepEqual(rows.map(row => row.target), names);
    assert.deepEqual(rows.map(row => row.status), ['acted', 'acted', 'acted']);
  });
}
