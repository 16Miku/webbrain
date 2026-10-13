import assert from 'node:assert/strict';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);
const PAGE = 'https://owned.example.test/settings';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = { storage: { local: area, session: area }, runtime: { getURL: p => `extension://test/${p}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE, title: 'Owned page' }), sendMessage: async (_id, m) => {
    if (m.action === 'page_monitor_capture_model') return { ready: true, runToken: m.params.runToken, documentToken: 'doc', snapshotToken: 'snapshot', targetCount: 1,
      page: { success: true, url: PAGE, pageContent: 'button "Change" [ref_1]' } };
    if (m.action === 'page_monitor_validate_model') return { ready: true, runToken: m.params.runToken, documentToken: 'doc', snapshotToken: m.params.snapshotToken };
    return { ready: true };
  } }, scripting: { executeScript: async () => [{ result: null }] },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'doc', url: PAGE }] } };
globalThis.chrome = api; globalThis.browser = api;
let nextTab = 9800;
const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
const pair = (id, name, result, args = {}) => [
  { role: 'assistant', tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] },
  { role: 'tool', tool_call_id: id, content: JSON.stringify(result) },
];
const prior = () => [{ role: 'system', content: 'ordinary system' }, { role: 'user', content: 'Continue the same authorized task.' },
  ...pair('earlier-asset', 'download_files', { success: true, downloadId: 552 }),
  ...pair('earlier-upload', 'upload_file', { success: true, attachmentState: 'page_consumed', remoteStateVerified: false, attached: { name: 'earlier.png' } })];
function fixture(Agent) {
  const a = new Agent({}), tab = nextTab++;
  a.conversationModes.set(tab, 'act'); a.conversations.set(tab, prior()); a._beginCompletionInvariant(tab);
  return { a, tab, messages: a.conversations.get(tab) };
}
function context(a, tab, messages = a.conversations.get(tab), options = {}) {
  const view = a._jevModelMessages(tab, messages, options);
  return { view, note: view.find(m => m.webbrainAppOwned === true && m.webbrainAppOwnedKind === 'completion_reporting') };
}
function facts(note) { assert.ok(note, 'Actual model projection must expose current execution evidence'); return JSON.parse(note.content.slice(note.content.lastIndexOf('\n') + 1)); }
function add(a, tab, id, name, result, args = {}) {
  a.conversations.get(tab).push(...pair(id, name, result, args));
  a._recordCompletionToolResult(tab, name, args, result);
}
function setup(Agent, next) {
  const provider = { name: 'execution evidence fixture', model: 'fixture', contextWindow: 128000, promptTier: 'full', supportsTools: true, supportsVision: false,
    chat: next, async *chatStream(messages, options) { const r = await next(messages, options); if (r.content) yield { type: 'text', content: r.content };
      if (r.toolCalls) yield { type: 'tool_call', content: r.toolCalls.map((c, index) => ({ ...c, index })) };
      if (r.usage) yield { type: 'usage', usage: r.usage }; yield { type: 'done' }; } };
  const a = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  for (const name of ['_hydrate', '_recordCostUsage', '_maybeEmitAskModeHandoff', '_maybeReinjectAdapter', '_ensureProgressSessionForCurrentTask']) a[name] = async () => {};
  a._persist = () => {}; a._persistNow = async () => ({ ok: true }); a._persistSubmittedTurn = async () => {};
  a._startTraceRun = async () => null; a._endTraceRun = async () => {}; a._beginReadCompleteness = async () => null;
  a._checkCostAllowance = async () => null; a._currentUrl = async () => PAGE; a._getTabUrlTitle = async () => ({ tabUrl: PAGE, tabTitle: 'Owned page' });
  a._enrichUserMessageWithCurrentPage = async (tab, _messages, content) => {
    a.pageMonitorState({ tab: { id: tab }, frameId: 0, documentId: 'doc', url: PAGE }, 'content-doc');
    return { role: 'user', content };
  };
  a._plannerMode = () => 'off'; a._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: true,
    requiresSubmission: true, ...a._plannerCompletionGateFields({ read_scope: 'none', deliverables: ['The requested current page state'] }) });
  a._skipPermissionGate = true; a._ensureGateSetting = async () => true;
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock', '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) a[name] = async () => null;
  a._adoptLiveSocialPublishWorkflow = async () => false; a._isFormValidationCandidate = () => false;
  a._preflightRichTextToolbarTarget = async () => ({ block: null }); a._auditRichTextToolbarTarget = async () => {};
  a._shouldAutoScreenshot = () => false; a._pageFeedbackIdleMs = 0; a.maxSteps = 5;
  return a;
}
for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(new URL(`src/${build}/src/agent/agent.js`, ROOT));
  test(`${build}: earlier upload and orphan receipts cannot become current effects`, () => {
    const { a, tab, messages } = fixture(Agent); const original = structuredClone(messages);
    add(a, tab, 'current-chooser', 'click_ax', { success: false, dispatched: true, filePickerBlocked: true, selector: '#private' });
    messages.push({ role: 'tool', tool_call_id: 'orphan', content: JSON.stringify({ success: true, attachmentState: 'page_consumed' }) });
    const before = structuredClone(messages), { view, note } = context(a, tab), f = facts(note);
    assert.deepEqual(f.recordedCurrentResults, [{ tool: 'click_ax', success: false, dispatched: true, filePickerBlocked: true }]);
    assert.deepEqual(f.latestConsequentialAction, { tool: 'click_ax', uncertain: true });
    assert.equal(f.verificationPending, true); assert.match(note.content, /same continuing task/);
    assert.deepEqual(messages, before); assert.deepEqual(view.slice(0, original.length), original);
    assert.equal(view.find(m => m.tool_call_id === 'earlier-asset'), messages.find(m => m.tool_call_id === 'earlier-asset'));
  });
  test(`${build}: genuine local attachment is reported without certifying remote save`, () => {
    const { a, tab } = fixture(Agent);
    add(a, tab, 'current-upload', 'upload_file', { success: true, dispatched: true, verified: false, remoteStateVerified: false, attachmentState: 'page_consumed', attached: { name: 'PRIVATE_FILENAME' } });
    const before = a.completionInvariants.get(tab), { note } = context(a, tab), f = facts(note);
    assert.deepEqual(f.recordedCurrentResults, [{ tool: 'upload_file', success: true, dispatched: true, verified: false, remoteStateVerified: false, attachmentState: 'page_consumed' }]);
    assert.match(note.content, /distinct from remote submission/); assert.doesNotMatch(note.content, /PRIVATE_FILENAME/);
    assert.equal(a.completionInvariants.get(tab), before); assert.equal(a._completionVerdicts?.size || 0, 0);
    assert.equal(a._completionDoneBlock(tab, 'done', { outcome: 'partial' }), null);
    assert.ok(a._completionDoneBlock(tab, 'done', { outcome: 'success' }));
  });
  test(`${build}: unknown provenance remains unknown instead of promoting retained history`, () => {
    const { a, tab } = fixture(Agent); delete a.completionInvariants.get(tab).historyToolCallIdsBeforeRun;
    const f = facts(context(a, tab).note); assert.equal(f.executionProvenance, 'unavailable'); assert.deepEqual(f.recordedCurrentResults, []);
    assert.match(f.evidenceWindow, /omission_is_not_proof/);
  });
  test(`${build}: compaction keeps paired current IDs and excludes old unpaired results`, () => {
    const { a, tab } = fixture(Agent); add(a, tab, 'current-read', 'get_accessibility_tree', { success: true, pageContent: 'PRIVATE_PAGE' });
    a.conversations.set(tab, a.conversations.get(tab).filter(m => m.role !== 'assistant' || !m.tool_calls.some(c => c.id.startsWith('earlier-'))));
    const f = facts(context(a, tab).note); assert.deepEqual(f.recordedCurrentResults, [{ tool: 'get_accessibility_tree', success: true }]);
  });
  test(`${build}: same-task resume preserves durable chat/progress/calculation and scratchpad`, () => {
    const { a, tab, messages } = fixture(Agent);
    const chat = { pendingOutbound: true, completionReceipt: { threadKey: 'existing-thread', delivered: true } };
    const guard = { pureCalculationReceipt: { result: '123' }, verifiedSubmissionEvidence: true, progress: ['valid earlier task progress'] };
    a.chatSessions.set(tab, chat); a._planExecutionGuards.set(tab, guard);
    const pad = a._appOwnedUserMessage('[Agent scratchpad] Earlier upload used downloadId 552; earlier reply was verified.', 'scratchpad'); messages.push(pad);
    const before = structuredClone(messages), { view, note } = context(a, tab);
    facts(note); assert.match(note.content, /Durable delivery, progress, calculation/); assert.match(note.content, /neither resets them nor requires repeating/);
    assert.equal(a.chatSessions.get(tab), chat); assert.equal(a._planExecutionGuards.get(tab), guard); assert.equal(view.includes(pad), true); assert.deepEqual(messages, before);
    assert.deepEqual(a._activeTaskBinding(view), a._activeTaskBinding(messages)); assert.equal(a._latestTaskText(tab), 'Continue the same authorized task.');
  });
  test(`${build}: no raw arguments, labels, page prose or secrets enter reporting facts`, () => {
    const { a, tab } = fixture(Agent);
    add(a, tab, 'secret-result', 'type_ax', { success: true, note: 'PRIVATE_PAGE_COMMAND', value: 'PRIVATE_VALUE', error: 'PRIVATE_ERROR' }, { text: 'PRIVATE_ARGUMENT' });
    const { note } = context(a, tab); facts(note); assert.doesNotMatch(note.content, /PRIVATE_/);
    assert.deepEqual(JSON.parse(a.conversations.get(tab).at(-2).tool_calls[0].function.arguments), { text: 'PRIVATE_ARGUMENT' });
  });
  test(`${build}: result window and unparseable evidence stay bounded`, () => {
    const { a, tab } = fixture(Agent);
    for (let i = 0; i < 100; i++) add(a, tab, `current-${i}`, 'get_accessibility_tree', { success: true, pageContent: 'x'.repeat(51000) });
    const { note } = context(a, tab), f = facts(note); assert.equal(f.recordedCurrentResults.length, 8); assert.ok(note.content.length < 3000);
    assert.equal(f.recordedCurrentResults.every(x => x.result === 'not_available_as_structured_evidence'), true);
    for (let i = 0; i < 8; i++) add(a, tab, `max-${i}`, 'a'.repeat(64), Object.fromEntries(['success', 'dispatched', 'noDispatch', 'skipped', 'cancelled', 'outcomeUnknown', 'verified', 'remoteStateVerified', 'filePickerBlocked'].map(key => [key, true])));
    const maximum = context(a, tab).note; facts(maximum); assert.ok(maximum.content.length <= 3000);
  });
  test(`${build}: ambiguous duplicate call IDs do not certify a result`, () => {
    const { a, tab, messages } = fixture(Agent); messages.push(...pair('duplicate', 'upload_file', { success: true, attachmentState: 'page_consumed' }));
    messages.push({ role: 'assistant', tool_calls: [{ id: 'duplicate', function: { name: 'click_ax', arguments: '{}' } }] });
    assert.deepEqual(facts(context(a, tab).note).recordedCurrentResults, []);
  });
  test(`${build}: Ask, selection and standalone receive no extra context`, () => {
    const { a, tab, messages } = fixture(Agent);
    a.conversationModes.set(tab, 'ask'); assert.equal(context(a, tab).view, messages);
    a.conversationModes.set(tab, 'act');
    assert.equal(context(a, tab, messages, { sourceGrounding: 'selection_only' }).note, undefined);
    assert.equal(context(a, tab, messages, { sourceGrounding: 'selection_context' }).note, undefined);
    assert.equal(context(a, tab, messages, { standaloneChat: true }).note, undefined);
  });
  test(`${build}: cleared execution preserves original projection`, () => {
    const { a, tab, messages } = fixture(Agent); a._clearCompletionInvariant(tab); assert.equal(context(a, tab).view, messages);
  });
  test(`${build}: fresh projection replaces only genuine transient app context`, () => {
    const { a, tab, messages } = fixture(Agent); const authored = { role: 'user', content: 'Genuine task remains authoritative', webbrainAppOwnedKind: 'completion_reporting' }; messages.push(authored);
    const first = context(a, tab); facts(first.note); add(a, tab, 'next', 'read_page', { success: true });
    const next = context(a, tab, first.view); assert.equal(next.view.filter(m => m.webbrainAppOwned === true && m.webbrainAppOwnedKind === 'completion_reporting').length, 1);
    assert.equal(next.view.includes(authored), true); assert.equal(a._isAgentInjectedUserMessage(next.note), true); assert.equal(a._isAgentInjectedUserMessage(authored), false);
    assert.deepEqual(facts(next.note).recordedCurrentResults, [{ tool: 'read_page', success: true }]);
    a._jevSessions = new Map([[tab, { completionCandidate: true }]]); const projected = context(a, tab); facts(projected.note);
    assert.match(projected.view[0].content, /Runtime completion candidate/); assert.equal(messages[0].content, 'ordinary system');
  });
  for (const streaming of [false, true]) test(`${build} ${streaming ? 'stream' : 'chat'}: actual MAIN gets fresh evidence after chooser block and retains upload capability/partial escape`, async () => {
    const tab = nextTab++, seen = [], budgets = []; let a;
    const task = 'Set the requested state, preserving already-correct state. Output only recorded current-execution actions.';
    a = setup(Agent, async (messages, options) => {
      const note = messages.find(m => m.webbrainAppOwnedKind === 'completion_reporting');
      const rawChars = a._estimateContextChars(messages.filter(m => m !== note));
      const requestChars = a._estimateContextChars(messages);
      assert.equal(a._activeTaskBinding(messages).text, task); assert.equal(a._latestTaskText(tab), task);
      assert.equal(messages.at(-1), note); assert.ok(requestChars - rawChars > 0 && requestChars - rawChars <= 3000);
      const usage = a._estimateAskStreamUsage(messages, options, '', '', []);
      assert.equal(usage.prompt_tokens, Math.ceil((requestChars + JSON.stringify(options.tools).length) / 4));
      seen.push({ messages: structuredClone(messages), tools: options.tools.map(x => x.function.name), requestChars, reportingChars: requestChars - rawChars, estimatedPromptTokens: usage.prompt_tokens });
      return { ...(seen.length === 1 ? call('current-chooser', 'click_ax', { ref_id: 'ref_1' }) : call('partial', 'done', { summary: 'Partial: current page result has not been verified.', outcome: 'partial' })), usage };
    });
    a.conversations.set(tab, prior()); a.conversationModes.set(tab, 'act'); const dispatch = [];
    const manageContext = a._manageContext.bind(a);
    a._manageContext = async (...args) => {
      const projected = a._completionEvidenceMessages?.(args[0], args[1]) || args[1];
      const chars = a._estimateContextChars(projected);
      const r = await manageContext(...args);
      if (projected !== args[1]) { assert.ok(r.tokens >= Math.ceil(chars / 4)); budgets.push({ chars, tokens: r.tokens }); }
      return r;
    };
    a.executeTool = async (_tab, name, args) => { dispatch.push(name); return name === 'done' ? { done: true, summary: args.summary, outcome: args.outcome } : { success: false, dispatched: true, filePickerBlocked: true, selector: '#file' }; };
    const options = { detachedRequestId: `execution-${tab}`, askStreamingEnabled: false };
    const result = streaming ? await a.processMessageStream(tab, task, () => {}, 'act', options)
      : await a.processMessage(tab, task, () => {}, 'act', [], options);
    assert.equal(result, 'Partial: current page result has not been verified.'); assert.deepEqual(dispatch, ['click_ax', 'done']); assert.equal(seen.length, 2); assert.ok(budgets.length >= 2);
    console.info(JSON.stringify({ build, streaming, providerMeasurements: seen.map(({ requestChars, reportingChars, estimatedPromptTokens }) => ({ requestChars, reportingChars, estimatedPromptTokens })), normalBudgetMeasurements: budgets }));
    for (const s of seen) assert.ok(s.tools.includes('upload_file'));
    const f = facts(seen[1].messages.find(m => m.webbrainAppOwnedKind === 'completion_reporting'));
    assert.equal(f.recordedCurrentResults.some(r => r.tool === 'click_ax' && r.filePickerBlocked === true), true);
    assert.equal(f.recordedCurrentResults.some(r => r.tool === 'upload_file'), false);
    assert.equal(a.conversations.get(tab).some(m => m.webbrainAppOwnedKind === 'completion_reporting'), false);
    assert.equal(a.conversations.get(tab).some(m => m.role === 'user' && m.content === task), true);
  });
  test(`${build}: forced delivery exposes current facts without adding actions or success outcome`, async () => {
    const { a, tab, messages } = fixture(Agent); add(a, tab, 'current-read', 'read_page', { success: true, text: 'PRIVATE_PAGE' });
    a._persist = () => {}; let request; a._chatWithCostAllowance = async (_p, sent, options) => {
      request = { sent, options }; return call('forced-partial', 'done', { summary: 'Partial useful result.', outcome: 'partial' });
    };
    const r = await a._recoverDeliveryCheckpointTurn(tab, messages, () => {}, { model: 'fixture' }, {}, null, 8, 'fallback');
    assert.equal(r.status, 'partial'); assert.deepEqual(request.options.tools.map(x => x.function.name), ['done']);
    assert.deepEqual(request.options.tools[0].function.parameters.properties.outcome.enum, ['partial', 'failed']);
    const f = facts(request.sent.find(m => m.webbrainAppOwnedKind === 'completion_reporting'));
    assert.deepEqual(f.recordedCurrentResults, [{ tool: 'read_page', success: true }]); assert.doesNotMatch(request.sent.at(-1).content, /PRIVATE_PAGE/);
  });
}
