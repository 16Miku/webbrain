import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
let contentTransport = async () => ({ success: true, verified: true, dispatched: true });
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://owned/${value}` },
  tabs: { sendMessage: (...args) => contentTransport(...args) },
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const url = 'https://web.telegram.org/k/#@owned_qa';
const proof = () => ({ success: true, conclusive: true, messageSend: false,
  nativeTelegramRepair: true, nativeTelegramReadRepairBinding: { token: 'owned-single-use-proof' } });

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const bidi = build === 'firefox' ? (await import('../src/firefox/src/bidi/client.js')).firefoxBidi : null;
  function fixture() {
    const agent = new Agent({ getActive: () => ({ model: 'owned-model' }) });
    let owner = 'owned-task-run-provider';
    agent._nativeChatOwnerScope = () => owner;
    agent._nativeChatPendingRestore = () => null;
    agent._currentUrl = async () => url;
    agent._sendDevContentAction = async (_tab, action, params) => contentTransport(17, { action, params });
    agent._planExecutionGuards.set(17, { messaging: { target_kind: 'active_conversation' } });
    agent._withContentActionDeadline = async fn => fn(null);
    agent._clickProgressSnapshot = async () => '';
    agent._beginClickAxSideEffectWatch = () => ({ stop() {} });
    agent._captureClickAxObservation = async () => ({});
    agent._settleContentFilePickerGuard = async (_tab, result) => result;
    agent._maybeFallbackClickAxWithCdp = async (_tab, _args, result) => result;
    agent._annotateClickProgress = async () => {};
    agent._recordInteractionRect = () => {};
    agent._annotateCredentialField = () => {};
    agent._clearUploadSelectorRecoveryAfterInspection = () => {};
    if (bidi) bidi.sendContent = (...args) => contentTransport(...args);
    return { agent, changeOwner: value => { owner = value; } };
  }
  async function prepare(f, ref_id = 'ref_12') {
    const context = {};
    contentTransport = async () => proof();
    const block = await f.agent._messageRecipientGuardBlock(17, 'click_ax', { ref_id }, url, context);
    assert.equal(block, null);
    return context;
  }

  test(`${build}: actual recipient guard carries a scoped readonly Telegram preparation proof`, async () => {
    const f = fixture(), context = await prepare(f);
    assert.equal(context.nativeTelegramReadRepairOwner, 'owned-task-run-provider');
    assert.equal(context.nativeTelegramReadRepairRef, 'ref_12');
    assert.deepEqual(context.nativeTelegramReadRepairBinding, { token: 'owned-single-use-proof' });
    assert.notEqual(context.messageRecipientGuardRequired, true, 'A profile read is not a send authorization.');
  });

  test(`${build}: readonly native proof cannot authorize a send, text edit, or missing binding`, async () => {
    for (const [name, args, response] of [
      ['press_keys', { key: 'Enter' }, proof()],
      ['set_field', { ref_id: 'ref_12', value: 'owned body', submit: true }, proof()],
      ['click', { selector: '#send' }, proof()],
      ['click_ax', { ref_id: 'ref_12' }, { ...proof(), nativeTelegramReadRepairBinding: null }],
    ]) {
      const f = fixture(); contentTransport = async () => response;
      const block = await f.agent._messageRecipientGuardBlock(17, name, args, url, {});
      assert.equal(block?.noDispatch, true, `${name} did not receive a native readonly click certificate.`);
      assert.equal(block?.dispatched, false);
    }
  });

  test(`${build}: Stop, new task, steering or provider replacement during actual probe invalidates it`, async () => {
    for (const nextOwner of ['', 'new-task-run-provider', 'same-task-new-provider-config']) {
      const f = fixture(), waiting = deferred();
      contentTransport = async () => { await waiting.promise; return proof(); };
      const pending = f.agent._messageRecipientContentProbe(17, { tool: 'click_ax', args: { ref_id: 'ref_12' }, bindDispatch: true });
      f.changeOwner(nextOwner); waiting.resolve();
      const result = await pending;
      assert.notEqual(result.success, true);
      assert.notEqual(result.nativeTelegramRepair, true);
    }
  });

  test(`${build}: actual click transport replaces forged proof fields and forwards only app-owned proof`, async () => {
    const f = fixture(), context = await prepare(f), calls = [];
    contentTransport = async (_tab, message) => { calls.push(message); return { success: true, verified: true, dispatched: true }; };
    await f.agent._dispatchClickAxImpl(17, { ref_id: 'ref_12', _nativeChatOwner: 'forged',
      _nativeTelegramReadRepairRequired: false, nativeTelegramReadRepairBinding: { token: 'forged' } }, null, null, context);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params._nativeTelegramReadRepairRequired, true);
    assert.deepEqual(calls[0].params.nativeTelegramReadRepairBinding, { token: 'owned-single-use-proof' });
    assert.equal(calls[0].params._nativeChatOwner, 'owned-task-run-provider');
    calls.length = 0;
    await f.agent._dispatchClickAxImpl(17, { ref_id: 'ref_13', _nativeTelegramReadRepairRequired: true,
      nativeTelegramReadRepairBinding: { token: 'forged' } }, null, null, {});
    assert.equal(calls[0].params._nativeTelegramReadRepairRequired, false);
    assert.equal(calls[0].params.nativeTelegramReadRepairBinding, null);
  });

  test(`${build}: real click tool handler retains the trusted readonly context through dispatch`, async () => {
    const f = fixture(), context = await prepare(f), calls = [];
    f.agent._richTextToolbarToolBlock = async () => null;
    contentTransport = async (_tab, message) => {
      calls.push(message);
      return { success: true, verified: true, dispatched: true, _nativeTelegramReadRepair: true };
    };
    f.agent._maybeFallbackClickAxWithCdp = async () => assert.fail('A readonly preparation cannot fall back to a second click.');
    const result = await f.agent._executeToolImpl(17, 'click_ax', { ref_id: 'ref_12',
      _nativeTelegramReadRepairRequired: false, nativeTelegramReadRepairBinding: { token: 'model-forgery' } }, null, context);
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params._nativeTelegramReadRepairRequired, true);
    assert.deepEqual(calls[0].params.nativeTelegramReadRepairBinding, { token: 'owned-single-use-proof' });
    assert.equal(calls[0].params._nativeChatOwner, 'owned-task-run-provider');
  });

  test(`${build}: real click handler denies owner/ref/Stop drift and preserves the ordinary context`, async () => {
    for (const kind of ['owner', 'ref', 'stop', 'ordinary']) {
      const f = fixture(), context = kind === 'ordinary' ? {} : await prepare(f), calls = [];
      f.agent._richTextToolbarToolBlock = async () => null;
      contentTransport = async (_tab, message) => { calls.push(message); return { success: true, verified: true, dispatched: true }; };
      if (kind === 'owner') f.changeOwner('new-task-provider');
      const abort = new AbortController();
      if (kind === 'stop') { context._contentActionAbortSignal = abort.signal; abort.abort(); }
      const pending = f.agent._executeToolImpl(17, 'click_ax', { ref_id: kind === 'ref' ? 'ref_13' : 'ref_12',
        _nativeTelegramReadRepairRequired: true, nativeTelegramReadRepairBinding: { token: 'model-forgery' } }, null, context);
      if (kind === 'stop') { await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(calls.length, 0); continue; }
      const result = await pending;
      if (kind === 'ordinary') {
        assert.equal(result.success, true); assert.equal(calls.length, 1);
        assert.equal(calls[0].params._nativeTelegramReadRepairRequired, false);
        assert.equal(calls[0].params.nativeTelegramReadRepairBinding, null);
      } else { assert.equal(result.noDispatch, true); assert.equal(calls.length, 0); }
    }
  });

  test(`${build}: old owner or changed target never reaches the actual click transport`, async () => {
    for (const change of ['owner', 'ref']) {
      const f = fixture(), context = await prepare(f); let calls = 0;
      contentTransport = async () => { calls++; return { success: true, dispatched: true }; };
      if (change === 'owner') f.changeOwner('new-task-run-provider');
      const result = await f.agent._dispatchClickAxImpl(17, { ref_id: change === 'ref' ? 'ref_13' : 'ref_12' }, null, null, context);
      assert.equal(result.noDispatch, true); assert.equal(result.dispatched, false); assert.equal(calls, 0);
    }
  });

  test(`${build}: ownership drift in late click preparation cannot dispatch or fall back`, async () => {
    const f = fixture(), context = await prepare(f); let calls = 0, fallback = 0;
    contentTransport = async () => { calls++; return { success: true, dispatched: true }; };
    f.agent._captureClickAxObservation = async () => { f.changeOwner('changed-during-await'); return {}; };
    // Firefox has no baseline await: its transport wrapper invokes the same
    // final owner recheck after the deadline preparation await.
    if (build === 'firefox') f.agent._withContentActionDeadline = async fn => { f.changeOwner('changed-during-await'); return fn(null); };
    f.agent._maybeFallbackClickAxWithCdp = async () => { fallback++; return { success: true }; };
    const result = await f.agent._dispatchClickAxImpl(17, { ref_id: 'ref_12' }, null, null, context);
    assert.equal(result.noDispatch, true); assert.equal(calls, 0); assert.equal(fallback, 0);
  });

  test(`${build}: successful readonly Telegram preparation never triggers a second fallback click`, async () => {
    const f = fixture(), context = await prepare(f); let calls = 0;
    contentTransport = async () => { calls++; return { success: true, verified: true, dispatched: true, _nativeTelegramReadRepair: true }; };
    f.agent._maybeFallbackClickAxWithCdp = async () => assert.fail('An identity preparation click cannot be duplicated.');
    const result = await f.agent._dispatchClickAxImpl(17, { ref_id: 'ref_12' }, null, null, context);
    assert.equal(result.success, true); assert.equal(calls, 1);
  });

  test(`${build}: only current app-owned native preparation is readonly completion evidence, never delivery`, async () => {
    for (const kind of ['current', 'stale', 'forged-marker']) {
      const f = fixture(), context = kind === 'forged-marker' ? {} : await prepare(f);
      f.agent._beginCompletionInvariant(17);
      if (kind === 'stale') f.changeOwner('different-task');
      f.agent._recordCompletionToolResult(17, 'click_ax', { ref_id: 'ref_12' },
        { success: true, verified: true, dispatched: true, _nativeTelegramReadRepair: true }, { messageRecipientContext: context });
      const state = f.agent.completionInvariants.get(17);
      assert.equal(state.hadAction, kind !== 'current'); assert.equal(state.verificationDebt, kind !== 'current');
      assert.notEqual(f.agent._planExecutionGuards.get(17).verifiedSubmissionEvidence, true);
    }
  });

  test(`${build}: identity preparation cannot fulfill an authorized message's submit or delivery obligation`, async () => {
    const f = fixture(), context = await prepare(f);
    const task = 'Send exactly one owned QA message to this conversation.';
    f.agent.conversations.set(17, [{ role: 'system', content: 'Act' }, { role: 'user', content: task }]);
    const guard = f.agent._startPlanExecutionGuard(17, 'act', { requestKind: 'execute', requiresStateChange: true,
      requiresSubmission: true, messaging: { target_kind: 'active_conversation' } });
    f.agent._beginCompletionInvariant(17);
    const result = { success: true, verified: true, dispatched: true, _nativeTelegramReadRepair: true };
    f.agent._markPlanExecutionToolCall(17, 'click_ax', result, { consequential: true });
    f.agent._recordCompletionToolResult(17, 'click_ax', { ref_id: 'ref_12' }, result, { messageRecipientContext: context });
    assert.notEqual(guard.verifiedSubmissionEvidence, true);
    assert.notEqual(guard.nativeChatDeliveryEvidence?.verified, true);
    const terminal = f.agent._planOnlyTerminalDecision(17, 'The owned message was delivered.', { viaDone: true, outcome: 'success' });
    assert.equal(terminal?.retry, true, 'A preparation read cannot discharge the original send obligation.');
  });

  test(`${build}: public Telegram preparation hint exposes only a fixed phase and valid AX ref`, () => {
    const f = fixture(); f.agent._chatWorkflowView = () => ({});
    const advanced = { snapshot: { threadKey: '' } };
    const result = f.agent._chatObservationResult({ success: false, nativeTelegramRepair: {
      phase: 'open_profile_or_settings', ref_id: 'ref_12', token: 'private-proof', peer: 'private-peer', owner: 'private-owner' } }, advanced);
    assert.deepEqual(result.nativeTelegramRepair, { phase: 'open_profile_or_settings', ref_id: 'ref_12' });
    assert.equal(JSON.stringify(result).includes('private-'), false);
    const invalid = f.agent._chatObservationResult({ nativeTelegramRepair: { phase: 'send', ref_id: 'ref_12' } }, advanced);
    assert.equal(invalid.nativeTelegramRepair, undefined);
  });
}


for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import('../src/' + build + '/src/agent/agent.js');
  const { createOwnedNativeChatReadRepair, chatRunEndedNotice } = await import('../src/' + build + '/src/agent/chat-workflow.js');
  const threadKey = 'dom:telegram:k:123456:0', documentToken = 'owned-repair-document';
  test(build + ': ended-chat notice covers every supported UI language, regional tags and unknown locale fallback', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/' + build + '/src/ui/i18n.js', import.meta.url), 'utf8');
    const catalog = source.match(/export const LANGUAGES = \[([\s\S]*?)\];/);
    assert.ok(catalog);
    const codes = [...catalog[1].matchAll(/code: '([^']+)'/g)].map(match => match[1]);
    assert.ok(codes.length > 1);
    const english = 'This run has ended. No automatic continuation is scheduled.';
    assert.equal(chatRunEndedNotice('en'), english);
    for (const code of codes) {
      const notice = chatRunEndedNotice(code);
      assert.equal(typeof notice, 'string');
      assert.ok(notice.trim());
      if (code !== 'en') assert.notEqual(notice, english, code + ' has localized truthful copy.');
      assert.equal(chatRunEndedNotice(code.toUpperCase() + '_QA'), notice);
    }
    for (const unknown of ['', null, 'unknown', '__proto__', 'constructor']) {
      assert.equal(chatRunEndedNotice(unknown), english);
    }
  });
  function ownedRepair(phase = 'read_latest') {
    let provider = { model: 'owned', config: { model: 'owned' } };
    const agent = new Agent({ getActive: () => provider }), tabId = 29;
    agent._persist = () => {}; agent._persistNow = async () => true;
    agent.conversations.set(tabId, [{ role: 'system', content: 'Owned fixture runtime.' },
      { role: 'user', content: 'Continue the authorized conversation, without changing recipients.' }]);
    agent._beginCompletionInvariant(tabId);
    agent._lastAxScopes.set(tabId, { documentToken, pageUrl: url });
    agent.chatSessions.set(tabId, { threadKey, pendingOutbound: { key: 'retain-owned-pending' } });
    const abort = new AbortController();
    agent._runAbortStates.set(tabId, { controller: abort, dispose() {} });
    const owner = agent._nativeChatOwnerScope(tabId);
    assert.ok(owner);
    const authority = { owner, documentToken, url, threadKey, signal: agent._runAbortSignal(tabId),
      isCurrent: scope => scope.owner === agent._nativeChatOwnerScope(tabId)
        && agent._runAbortSignal(tabId) === abort.signal
        && scope.documentToken === agent._lastAxScopes.get(tabId)?.documentToken
        && scope.url === agent._lastAxScopes.get(tabId)?.pageUrl
        && scope.threadKey === agent.chatSessions.get(tabId)?.threadKey };
    const source = phase === 'read_latest'
      ? { success: true, threadKey, nativeChatReadRepair: { phase, ref_id: 'ref_41', direction: 'bottom' } }
      : { success: false, reason: 'native_telegram_alias_binding_required',
          nativeTelegramRepair: { phase, ref_id: 'ref_31' } };
    const controller = createOwnedNativeChatReadRepair(), record = controller.issue(source, authority);
    assert.ok(record);
    const calls = [];
    const dispatch = async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_accessibility_tree') return { pageContent: 'Owned exact pane.' };
      if (name === 'scroll') return { success: true, dispatched: true };
      if (name === 'click_ax') return { success: true, _nativeTelegramReadRepair: true, dispatched: true };
      assert.equal(name, 'chat_observe');
      return { success: true, threadKey, composer: { available: true, empty: false },
        chatWorkflow: { pendingOutbound: true, pendingOutboundKey: 'retain-owned-pending' } };
    };
    return { agent, tabId, abort, controller, record, source, authority, calls, dispatch,
      replaceProvider() { provider = { ...provider }; } };
  }

  test(build + ': owned latest repair performs scoped read, bottom scroll and observation once, without sending', async () => {
    const f = ownedRepair(), result = await f.controller.run(f.record, f.dispatch);
    assert.equal(result.success, true);
    assert.equal(result.sendCalls, 0);
    assert.deepEqual(f.calls, [
      { name: 'get_accessibility_tree', args: { ref_id: 'ref_41' } },
      { name: 'scroll', args: { ref_id: 'ref_41', direction: 'bottom' } },
      { name: 'chat_observe', args: { reconcile_pending_outbound: false } },
    ]);
    assert.equal(result.result.chatWorkflow.pendingOutbound, true, 'Viewport repair does not clear or reconcile an unknown send.');
    assert.equal(f.agent.chatSessions.get(f.tabId).pendingOutbound.key, 'retain-owned-pending');
    const repeat = await f.controller.run(f.record, f.dispatch);
    assert.equal(repeat.noDispatch, true);
    assert.equal(f.controller.issue(f.source, f.authority), null, 'Repeated observations cannot automatically retry this same repair.');
    assert.equal(f.calls.length, 3);
  });

  test(build + ': all issued alias identity phases read the exact control before the privately guarded click and fresh observation', async () => {
    for (const phase of ['open_profile_or_settings', 'open_profile', 'open_menu', 'open_self_settings']) {
      const f = ownedRepair(phase), result = await f.controller.run(f.record, f.dispatch);
      assert.equal(result.success, true);
      assert.deepEqual(f.calls, [
        { name: 'get_accessibility_tree', args: { ref_id: 'ref_31' } },
        { name: 'click_ax', args: { ref_id: 'ref_31' } },
        { name: 'chat_observe', args: { reconcile_pending_outbound: false } },
      ]);
      assert.equal(result.sendCalls, 0);
    }
  });

  test(build + ': an issued menu phase can expose a distinct settings phase without retrying the consumed control', async () => {
    const f = ownedRepair('open_menu');
    const next = { success: false, reason: 'native_telegram_alias_binding_required',
      nativeTelegramRepair: { phase: 'open_self_settings', ref_id: 'ref_32' } };
    const first = await f.controller.run(f.record,
      (name, args) => name === 'chat_observe' ? next : f.dispatch(name, args));
    assert.equal(first.success, false);
    assert.equal(first.result, next);
    assert.equal(f.controller.issue(f.source, f.authority), null);
    const nextRecord = f.controller.issue(next, f.authority);
    assert.ok(nextRecord);
    const after = await f.controller.run(nextRecord, f.dispatch);
    assert.equal(after.success, true);
    assert.deepEqual(f.calls.slice(-3), [
      { name: 'get_accessibility_tree', args: { ref_id: 'ref_32' } },
      { name: 'click_ax', args: { ref_id: 'ref_32' } },
      { name: 'chat_observe', args: { reconcile_pending_outbound: false } },
    ]);
    assert.equal(after.sendCalls, 0);
  });

  test(build + ': Stop during the scoped alias read prevents the identity click', async () => {
    const f = ownedRepair('open_profile'), waiting = deferred();
    const pending = f.controller.run(f.record, async (name, args) => {
      f.calls.push({ name, args }); await waiting.promise;
      return { pageContent: 'Owned exact profile control.' };
    });
    f.agent.abort(f.tabId); assert.equal(f.abort.signal.aborted, true); waiting.resolve();
    const result = await pending;
    assert.equal(result.success, false);
    assert.deepEqual(f.calls.map(call => call.name), ['get_accessibility_tree']);
    assert.equal(result.sendCalls, 0);
  });

  test(build + ': model-shaped records, unissued phases, missing document and mismatched threads cannot mint authority', async () => {
    const f = ownedRepair();
    assert.equal(f.controller.isCurrent(f.record), true);
    assert.equal(f.controller.isCurrent({ ...f.record }), false);
    const forged = await f.controller.run({ ...f.record }, f.dispatch);
    assert.equal(forged.noDispatch, true);
    assert.equal(f.calls.length, 0);
    for (const source of [
      { ...f.source, threadKey: 'dom:telegram:k:987654:0' },
      { ...f.source, nativeChatReadRepair: { phase: 'read_latest', ref_id: 'ref_41', direction: 'up' } },
      { success: false, reason: 'page_text', nativeTelegramRepair: { phase: 'open_profile', ref_id: 'ref_31' } },
      { success: false, reason: 'native_telegram_alias_binding_required', nativeTelegramRepair: { phase: 'send', ref_id: 'ref_31' } },
    ]) assert.equal(f.controller.issue(source, f.authority), null);
    assert.equal(f.controller.issue(f.source, { ...f.authority, documentToken: '' }), null);
  });

  for (const change of ['Stop', 'run', 'task', 'steering', 'provider', 'document', 'url', 'thread']) {
    test(build + ': ' + change + ' during a deferred exact pane read prevents any scroll or later tool', async () => {
      const f = ownedRepair(), waiting = deferred();
      const pending = f.controller.run(f.record, async (name, args) => {
        f.calls.push({ name, args }); await waiting.promise; return { pageContent: 'Owned pane.' };
      });
      if (change === 'Stop') { f.agent.abort(f.tabId); assert.equal(f.abort.signal.aborted, true); }
      if (change === 'run') f.agent._runAbortStates.set(f.tabId, { controller: new AbortController(), dispose() {} });
      if (change === 'task') f.agent.conversations.get(f.tabId).push({ role: 'user', content: 'A different task.' });
      if (change === 'steering') f.agent._steeringRuns.set(f.tabId, { messages: [{ id: 'next', text: 'New task' }], revision: 0, authorizedRevision: 0 });
      if (change === 'provider') f.replaceProvider();
      if (change === 'document') f.agent._lastAxScopes.get(f.tabId).documentToken = 'replacement-document';
      if (change === 'url') f.agent._lastAxScopes.get(f.tabId).pageUrl = 'https://example.test/other';
      if (change === 'thread') f.agent.chatSessions.get(f.tabId).threadKey = 'dom:telegram:k:987654:0';
      assert.equal(f.controller.isCurrent(f.record), false);
      waiting.resolve();
      const result = await pending;
      assert.equal(result.success, false);
      assert.equal(f.calls.length, 1);
      assert.equal(result.sendCalls, 0);
    });
  }

  test(build + ': unknown or failed scroll is retained and cannot trigger observation or repeat', async () => {
    for (const result of [
      { success: false, noDispatch: true, dispatched: false },
      { success: false, dispatched: true, outcomeUnknown: true },
    ]) {
      const f = ownedRepair(), outcome = await f.controller.run(f.record, async (name, args) => {
        f.calls.push({ name, args }); return name === 'get_accessibility_tree' ? { pageContent: 'Owned pane.' } : result;
      });
      assert.equal(outcome.success, false);
      assert.equal(outcome.result, result);
      assert.equal(outcome.outcomeUnknown, result.outcomeUnknown === true);
      assert.deepEqual(f.calls.map(call => call.name), ['get_accessibility_tree', 'scroll']);
      assert.equal((await f.controller.run(f.record, f.dispatch)).noDispatch, true);
      assert.equal(f.calls.length, 2);
    }
  });

  test(build + ': a generic identity anchor and a lost identity ACK cannot masquerade as private repair', async () => {
    for (const kind of ['generic', 'lost-ack']) {
      const f = ownedRepair('open_profile'), outcome = await f.controller.run(f.record, async (name, args) => {
        f.calls.push({ name, args });
        if (name === 'get_accessibility_tree') return { pageContent: 'Owned exact identity control.' };
        if (kind === 'lost-ack') throw new Error('Owned receiver closed after dispatch.');
        return { success: true, trusted: false, verified: false };
      });
      assert.equal(outcome.success, false);
      assert.equal(outcome.outcomeUnknown, kind === 'lost-ack');
      assert.equal(f.calls.length, 2);
      assert.equal(outcome.sendCalls, 0);
    }
  });

  test(build + ': fresh observation must establish the same thread and composer; repair never supplies delivery', async () => {
    for (const after of [
      { success: false, reason: 'native_telegram_alias_binding_required' },
      { success: true, threadKey: 'dom:telegram:k:987654:0', composer: { available: true } },
      { success: true, threadKey, composer: { available: false } },
      { success: true, threadKey, composer: { available: true }, nativeChatReadRepair: { phase: 'read_latest', ref_id: 'ref_41', direction: 'bottom' } },
    ]) {
      const f = ownedRepair(), result = await f.controller.run(f.record,
        (name, args) => name === 'chat_observe' ? after : f.dispatch(name, args));
      assert.equal(result.success, false);
      assert.equal(result.sendCalls, 0);
      assert.notEqual(result.deliveryVerified, true);
    }
  });
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import('../src/' + build + '/src/agent/agent.js');
  const tabId = 43, threadKey = 'dom:telegram:k:123456:0', documentToken = 'owned-loop-document';
  const allowed = new Set(['chat_observe', 'get_accessibility_tree', 'scroll', 'click_ax', 'calculate', 'done']);
  const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

  async function loopFixture(phase = 'read_latest') {
    const provider = { name: 'owned-loop-fixture', model: 'owned', config: { model: 'owned' } };
    const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
    const messages = [{ role: 'system', content: 'Owned fixture runtime.' },
      { role: 'user', content: 'Read the authorized current conversation and report the result.' }];
    agent.conversations.set(tabId, messages); agent.conversationModes.set(tabId, 'act');
    agent._persist = () => {}; agent._persistNow = async () => true;
    // This fixture isolates normal tool recording and the private repair path.
    // Unrelated external permission/UI/captcha/form services are absent.
    agent._skipPermissionGate = true;
    agent._ensureGateSetting = async () => true;
    agent._chromeProtectedPageFailure = async () => null;
    agent._captchaMutationPreflight = async () => null;
    agent._adoptLiveSocialPublishWorkflow = async () => false;
    agent._workflowPreSubmitDispatchBlock = async () => null;
    agent._detectLikelySubmitAction = async () => null;
    agent._isFormValidationCandidate = () => false;
    agent._preflightRichTextToolbarTarget = async () => ({ block: null });
    agent._socialPublicationPreSubmitBlock = async () => null;
    agent._auditRichTextToolbarTarget = async () => {};
    agent._observeCaptchaChallenge = async () => ({ gate: null, loopCheck: { kind: 'none' } });
    agent._shouldAutoScreenshot = () => false;
    agent._currentUrl = async () => url;
    agent._clickProgressSnapshot = async () => '';
    agent._beginClickAxSideEffectWatch = () => ({ stop() {} });
    agent._captureClickAxObservation = async () => ({});
    agent._settleContentFilePickerGuard = async (_tab, result) => result;
    agent._annotateClickProgress = async (_tab, _name, _args, result) => result;
    agent._recordInteractionRect = () => {};
    agent._annotateCredentialField = () => {};
    agent._clearUploadSelectorRecoveryAfterInspection = () => {};
    const api = globalThis.chrome, oldGet = api.tabs.get, oldNav = api.webNavigation;
    api.tabs.get = async id => ({ id, url, title: 'Owned neutral conversation' });
    api.webNavigation = { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: documentToken, url }] };
    const calls = [], updates = [];
    let repaired = false, onRead = null, snapshots = 0;
    contentTransport = async (_tab, message) => {
      const run = agent._pageFeedbackRuns.get(tabId), name = message.action, args = message.params || {};
      if (name === 'page_monitor_state') {
        if (message.active) agent.pageMonitorState({ tab: { id: tabId }, frameId: 0, url, documentId: documentToken }, documentToken);
        return { ready: true, active: message.active, runToken: run?.token, documentToken };
      }
      if (name === 'page_monitor_capture_model') return { ready: true, runToken: run.token, documentToken,
        snapshotToken: 'snapshot-' + (++snapshots), targetCount: 2,
        page: { success: true, url, pageContent: 'button "Owned identity" [ref_31]\nregion "Owned messages" [ref_41]' } };
      if (name === 'page_monitor_validate_model') return { ready: true, runToken: run.token, documentToken,
        snapshotToken: args.snapshotToken, modelBindingValid: true };
      if (/^page_monitor_/.test(name)) return { ready: true, runToken: run?.token, documentToken,
        revision: 0, modelBindingValid: true, originalTarget: true };
      if (name === 'probe_message_recipient_guard') {
        assert.equal(args.tool, 'click_ax');
        assert.equal(args.args.ref_id, 'ref_31');
        assert.ok(args._nativeChatOwner);
        return proof();
      }
      if (name === 'get_accessibility_tree') {
        calls.push({ name, ref: args.ref_id });
        if (onRead) await onRead();
        return { pageContent: 'Owned exact current repair control.', documentToken, refScopeUrl: url, hasMore: false, truncated: false };
      }
      if (name === 'scroll') {
        assert.equal(phase, 'read_latest'); assert.equal(args.ref_id, 'ref_41'); assert.equal(args.direction, 'bottom');
        calls.push({ name, ref: args.ref_id }); repaired = true;
        return { success: true, dispatched: true };
      }
      if (name === 'click_ax') {
        assert.equal(phase, 'open_profile'); assert.equal(args.ref_id, 'ref_31');
        assert.equal(args._nativeTelegramReadRepairRequired, true);
        assert.deepEqual(args.nativeTelegramReadRepairBinding, { token: 'owned-single-use-proof' });
        calls.push({ name, ref: args.ref_id }); repaired = true;
        return { success: true, verified: true, dispatched: true, _nativeTelegramReadRepair: true };
      }
      assert.fail('Unexpected page operation: ' + name);
    };
    await agent._claimRunEntry(tabId, 'interactive');
    agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute', requiresStateChange: false,
      requiresSubmission: false, messaging: { target_kind: 'active_conversation' } });
    agent._beginCompletionInvariant(tabId);
    agent._readChatObservation = async () => {
      calls.push({ name: 'chat_observe' });
      if (!repaired && phase === 'open_profile') return { success: false,
        reason: 'native_telegram_alias_binding_required', nativeTelegramRepair: { phase, ref_id: 'ref_31' } };
      return { success: true, url, threadKey, composer: { available: repaired, empty: true, ref: 'ref_composer' },
        messages: [{ id: 'telegram:k:123456:0:1', direction: 'incoming', text: 'Owned fixture question.' }],
        ...(!repaired ? { nativeChatReadRepair: { phase: 'read_latest', ref_id: 'ref_41', direction: 'bottom' } } : {}) };
    };
    const update = (type, data) => updates.push({ type, data });
    const runBatch = async (list, options = {}) => {
      messages.push({ role: 'assistant', content: null, tool_calls: list });
      return agent._executeToolBatch(tabId, list, messages, update, provider, null, allowed, 1, options);
    };
    const assertPaired = () => {
      const issued = messages.flatMap(message => message.role === 'assistant' ? message.tool_calls || [] : []);
      const results = messages.filter(message => message.role === 'tool');
      assert.equal(results.length, issued.length);
      for (const call of issued) assert.equal(results.filter(result => result.tool_call_id === call.id).length, 1);
    };
    return { agent, messages, calls, updates, runBatch, assertPaired,
      setReadHook(value) { onRead = value; },
      setRepaired(value) { repaired = value; },
      close() { agent._releaseRunEntry(tabId); api.tabs.get = oldGet; api.webNavigation = oldNav; } };
  }

  for (const phase of ['read_latest', 'open_profile']) {
    test(build + ': actual recorded batch preempts ignored ' + phase + ' repair before stale pane click or partial done', async () => {
      const f = await loopFixture(phase);
      try {
        const result = await f.runBatch([
          tool('initial-read', 'chat_observe', { reconcile_pending_outbound: false }),
          tool('wrong-pane', 'click_ax', { ref_id: 'ref_wrong' }),
          tool('premature-done', 'done', { outcome: 'partial', summary: 'I will continue later.' }),
        ], { ownedNativeChatReadRepair: true }); // Model-shaped boolean cannot bypass the private Symbol.
        assert.equal(result.action, 'continue');
        assert.deepEqual(f.calls.map(call => call.name),
          ['chat_observe', 'get_accessibility_tree', phase === 'read_latest' ? 'scroll' : 'click_ax', 'chat_observe'],
          JSON.stringify(f.updates.filter(value => value.type === 'tool_result').map(value => ({ name: value.data.name, result: value.data.result }))));
        assert.equal(f.agent._ownedNativeChatReadRepairs.get(tabId)?.pending, null);
        for (const id of ['wrong-pane', 'premature-done']) {
          const message = f.messages.find(value => value.role === 'tool' && value.tool_call_id === id);
          assert.ok(message); assert.match(message.content, /Skipped while the app completes/);
        }
        assert.equal(f.updates.filter(value => value.type === 'tool_call' && value.data.name === 'chat_send').length, 0);
        assert.equal(f.updates.filter(value => value.type === 'tool_result' && value.data.result?.done === true).length, 0);
        f.assertPaired();
      } finally { f.close(); }
    });

    test(build + ': actual issued ' + phase + ' repair survives the adjacent model turn but cannot repeat its consumed control', async () => {
      const f = await loopFixture(phase);
      try {
        await f.runBatch([tool('first-turn-read', 'chat_observe', { reconcile_pending_outbound: false })]);
        assert.ok(f.agent._ownedNativeChatReadRepairs.get(tabId)?.pending);
        assert.deepEqual(f.calls.map(call => call.name), ['chat_observe']);
        // This is the same ordinary model-state refresh used before a next
        // inference; it neither fabricates a repair nor resets its once guard.
        await f.agent._capturePageFeedbackModelState(tabId, f.messages);
        const next = await f.runBatch([tool('next-turn-stale-click', 'click_ax', { ref_id: 'ref_wrong' })]);
        assert.equal(next.action, 'continue');
        assert.deepEqual(f.calls.map(call => call.name),
          ['chat_observe', 'get_accessibility_tree', phase === 'read_latest' ? 'scroll' : 'click_ax', 'chat_observe']);
        assert.equal(f.agent._ownedNativeChatReadRepairs.get(tabId)?.pending, null);
        f.setRepaired(false);
        await f.runBatch([tool('same-consumed-hint', 'chat_observe', { reconcile_pending_outbound: false })]);
        assert.equal(f.agent._ownedNativeChatReadRepairs.get(tabId)?.pending, null);
        assert.deepEqual(f.calls.map(call => call.name),
          ['chat_observe', 'get_accessibility_tree', phase === 'read_latest' ? 'scroll' : 'click_ax', 'chat_observe', 'chat_observe']);
        assert.equal(f.updates.filter(value => value.type === 'tool_call' && value.data.name === 'chat_send').length, 0);
        f.assertPaired();
      } finally { f.close(); }
    });
  }

  for (const phase of ['read_latest', 'open_profile']) {
    test(build + ': applied task replacement retires the old ' + phase + ' repair before the first revised calculation', async () => {
      const f = await loopFixture(phase);
      try {
        await f.runBatch([tool('before-replacement-read', 'chat_observe', {})]);
        assert.ok(f.agent._ownedNativeChatReadRepairs.get(tabId)?.pending);
        const session = f.agent.chatSessions.get(tabId) || {};
        f.agent.chatSessions.set(tabId, session);
        const pendingOutbound = { key: 'retain-dispatched-send', outcomeUnknown: true };
        session.pendingOutbound = pendingOutbound;
        f.agent._beginSteeringRun(tabId, () => {}, { detachedRequestId: 'owned-replacement' });
        assert.equal(f.agent.steerMessage(tabId,
          'Replace the previous task: calculate 2 + 2. Do not use the website or conversation tools.',
          { requestId: 'owned-replacement', messageId: 'replacement' }).accepted, true);
        assert.equal(f.agent._applyPendingSteering(tabId, f.messages,
          (type, data) => f.updates.push({ type, data })), true);
        const steering = f.agent._steeringRuns.get(tabId);
        // The installed MV3 fixture separately exercises planner revalidation.
        // This case isolates the ordinary batch after that boundary is accepted.
        steering.authorizedRevision = steering.revision;
        await f.runBatch([tool('first-revised-calculation', 'calculate', { expression: '2 + 2' })]);
        const calculations = f.updates.filter(value => value.type === 'tool_result' && value.data.name === 'calculate');
        assert.equal(calculations.length, 1);
        assert.equal(calculations[0].data.result.success, true);
        assert.equal(calculations[0].data.result.result, '4');
        assert.equal(calculations[0].data.result.skipped, undefined);
        assert.equal(f.agent._ownedNativeChatReadRepairs.has(tabId), false);
        assert.deepEqual(f.calls.map(call => call.name), ['chat_observe']);
        assert.equal(f.agent.chatSessions.get(tabId), session);
        assert.equal(session.pendingOutbound, pendingOutbound);
        f.assertPaired();
      } finally { f.close(); }
    });
  }

  test(build + ': actual batch Stop during the scoped repair read dispatches no scroll, identity click or send', async () => {
    const f = await loopFixture(), waiting = deferred();
    try {
      f.setReadHook(async () => { f.agent.abort(tabId); await waiting.promise; });
      const pending = f.runBatch([tool('initial-stop-read', 'chat_observe', {}),
        tool('stale-after-stop', 'click_ax', { ref_id: 'ref_wrong' })]);
      waiting.resolve();
      await assert.rejects(pending, error => error?.name === 'AbortError' && /Stopped by user/.test(error.message));
      assert.deepEqual(f.calls.map(call => call.name), ['chat_observe', 'get_accessibility_tree']);
      assert.equal(f.agent._ownedNativeChatReadRepairs.has(tabId), false);
      f.assertPaired();
    } finally { f.close(); }
  });

  test(build + ': an obsolete document repair cannot synthesize a skipped current calculation', async () => {
    const f = await loopFixture();
    try {
      await f.runBatch([tool('old-document-read', 'chat_observe', {})]);
      const entry = f.agent._ownedNativeChatReadRepairs.get(tabId);
      const owner = f.agent._nativeChatOwnerScope(tabId);
      assert.ok(entry.pending);
      f.agent._pageFeedbackRuns.get(tabId).frames.get(0).token = 'replacement-document';
      assert.equal(f.agent._nativeChatOwnerScope(tabId), owner);
      await f.runBatch([tool('current-document-calculation', 'calculate', { expression: '2 + 2' })]);
      const calculations = f.updates.filter(value => value.type === 'tool_result' && value.data.name === 'calculate');
      assert.equal(calculations.length, 1);
      assert.equal(calculations[0].data.result.success, true);
      assert.equal(calculations[0].data.result.result, '4');
      assert.equal(calculations[0].data.result.skipped, undefined);
      assert.equal(entry.pending, null);
      assert.equal(f.agent._ownedNativeChatReadRepairs.get(tabId), entry);
      assert.deepEqual(f.calls.map(call => call.name), ['chat_observe']);
      f.assertPaired();
    } finally { f.close(); }
  });

  for (const phase of ['read_latest', 'open_profile']) for (const change of ['document', 'thread']) {
    test(build + ': late ' + change + ' change during ' + phase + ' model capture cannot dispatch the issued repair', async () => {
      const f = await loopFixture(phase);
      const originalCapture = f.agent._capturePageFeedbackModelState.bind(f.agent);
      const originalTransport = contentTransport;
      let captures = 0, replacementDocument = null;
      contentTransport = async (...args) => {
        const result = await originalTransport(...args);
        return replacementDocument && result?.documentToken
          ? { ...result, documentToken: replacementDocument } : result;
      };
      f.agent._capturePageFeedbackModelState = async (...args) => {
        // The scoped AX read has completed. Before the mutation's fresh model
        // capture settles, the same URL now belongs to a different document or
        // thread. A new generic action certificate cannot renew the old repair.
        if (++captures === 2) {
          await Promise.resolve();
          if (change === 'document') {
            replacementDocument = 'replacement-owned-loop-document';
            const run = f.agent._pageFeedbackRuns.get(tabId);
            run.frames.set(0, { ...run.frames.get(0), token: replacementDocument, id: replacementDocument });
            run.documents.set(0, { ...run.documents.get(0), id: replacementDocument });
            globalThis.chrome.webNavigation.getAllFrames = async () => [{ frameId: 0, parentFrameId: -1,
              documentId: replacementDocument, url }];
          } else {
            f.agent.chatSessions.set(tabId, { ...f.agent.chatSessions.get(tabId), threadKey: 'dom:telegram:k:654321:0' });
          }
        }
        return originalCapture(...args);
      };
      try {
        const result = await f.runBatch([tool('late-capture-read', 'chat_observe', {}),
          tool('late-capture-premature-done', 'done', { outcome: 'partial', summary: 'Continue later.' })]);
        assert.equal(captures, 2);
        assert.equal(result.action, 'continue');
        assert.deepEqual(f.calls.map(call => call.name), ['chat_observe', 'get_accessibility_tree']);
        assert.equal(f.updates.filter(value => value.type === 'tool_call'
          && ['scroll', 'click_ax', 'chat_send'].includes(value.data.name)).length, 0);
        assert.equal(f.agent._ownedNativeChatReadRepairs.get(tabId)?.pending, null);
        f.assertPaired();
      } finally { contentTransport = originalTransport; f.close(); }
    });
  }

  test(build + ': current partial chat done is terminal with truthful localized no-resume notice and zero created jobs', async () => {
    const f = await loopFixture();
    try {
      f.setRepaired(true);
      await f.runBatch([tool('read-before-partial', 'chat_observe', {})]);
      f.agent.responseLanguagePolicies.set(tabId, { framing_locale: 'tr' });
      let cancelled = 0, created = 0;
      f.agent.scheduler = { cancelPendingResumes: async () => { cancelled++; },
        createResumeJob: async () => { created++; assert.fail('Partial completion cannot silently schedule work.'); } };
      const result = await f.runBatch([tool('terminal-partial', 'done', { outcome: 'partial', summary: 'The dialogue could not continue.' })]);
      assert.equal(result.action, 'return');
      const done = f.updates.findLast(value => value.type === 'tool_result' && value.data.name === 'done')?.data.result;
      assert.equal(done.done, true); assert.equal(done.outcome, 'partial');
      assert.equal(done.runEnded, true); assert.equal(done.autoResumeScheduled, false);
      assert.match(result.value, /Bu çalışma sona erdi/);
      assert.equal(created, 0); assert.equal(cancelled, 1);
      f.assertPaired();
    } finally { f.close(); }
  });
}
