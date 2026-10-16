import assert from 'node:assert/strict';
import { withFixtureCalculationReadings } from './calculation-fixture-readings.mjs';
import { test } from 'node:test';

// Trace 61282dbf: on x.com/compose/post the model chose
// type_text({selector: '[data-testid="tweetTextarea_0"]'}). X uses that test
// id for the composer AND the hidden timeline composer behind it, so the
// action can never be bound. Because the timeline kept updating, each such
// decision was discarded as stale before it could answer, the model saw the
// same view and decided the same again, and after five rounds the run ended
// with "the page kept changing". The call must answer for itself instead.
const PAGE_URL = 'https://x.com/compose/post';
const SELECTOR = '[data-testid="tweetTextarea_0"]';
const POST = 'Owned QA support is coming soon https://example.com/qa/pull/3195';
const TREE = 'dialog [ref_dialog]\n textbox "Post text" [ref_editor]\n button "Post" [ref_post] type="button"\n'
  + 'textbox "Post text" [ref_hidden_editor] hidden=true occluded=true';
const documents = new Map();
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Compose post' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async ({ tabId }) => [{ frameId: 0, parentFrameId: -1, documentId: documents.get(tabId) || 'document-1', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 7300;

function makeAgent(Agent, next) {
  const provider = {
    name: 'unbindable target test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false,
    chat: withFixtureCalculationReadings(messages => messages[0]?.content?.startsWith('You classify whether one proposed terminal WebBrain Ask answer')
      ? Promise.resolve({ content: '{"pageIndependent":false}' }) : next(messages)),
    async *chatStream(messages) {
      const response = await next(messages);
      if (response.content) yield { type: 'text', content: response.content };
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { type: 'done' };
    },
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent._hydrate = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._persistSubmittedTurn = async () => {};
  agent._startTraceRun = async () => null;
  agent._endTraceRun = async () => {};
  agent._beginReadCompleteness = async () => null;
  agent._manageContext = async () => {};
  agent._checkCostAllowance = async () => null;
  agent._recordCostUsage = async () => null;
  agent._currentUrl = async () => PAGE_URL;
  agent._getTabUrlTitle = async () => ({ tabUrl: PAGE_URL, tabTitle: 'Compose post' });
  agent._maybeEmitAskModeHandoff = async () => {};
  agent._maybeReinjectAdapter = async () => {};
  agent._ensureProgressSessionForCurrentTask = async () => {};
  agent._plannerMode = () => 'off';
  agent._runPlannerIntentGate = async () => ({
    proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
  });
  agent._skipPermissionGate = true;
  agent._ensureGateSetting = async () => true;
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  agent._adoptLiveSocialPublishWorkflow = async () => false;
  agent._isFormValidationCandidate = () => false;
  agent._preflightRichTextToolbarTarget = async () => ({ block: null });
  agent._auditRichTextToolbarTarget = async () => {};
  agent._shouldAutoScreenshot = () => false;
  agent._pageFeedbackIdleMs = 0;
  agent._completionDoneBlock = () => null;
  agent.maxSteps = Infinity;
  return agent;
}

function bind(agent, tab) {
  const from = { tab: { id: tab }, frameId: 0, documentId: 'document-1', url: PAGE_URL };
  const state = agent.pageMonitorState(from, 'content-1');
  assert.equal(state.active, true);
  let seq = 0;
  return value => {
    const current = ++seq;
    assert.equal(agent.observePageFeedback(from, {
      ...state, seq: current, revision: current, kind: 'dom', source: 'page', target: 'div#timeline', ...value,
    }).accepted, true);
  };
}

const calls = (...list) => ({ toolCalls: list.map(([id, name, args]) => ({ id, function: { name, arguments: JSON.stringify(args) } })) });
const toolResults = messages => messages.filter(message => message.role === 'tool');
// Tool results may carry appended notes or an untrusted-data envelope.
function parse(message) {
  const text = typeof message?.content === 'string' ? message.content : '';
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let cursor = start; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, cursor + 1)); } catch { break; }
      }
    }
  }
  return null;
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const pageFeedbackExecute = Agent.prototype.executeTool;
  for (const streaming of [false, true]) for (const reason of ['target_ambiguous', 'target_unresolved']) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} an unbindable ${reason} target under live page updates answers for itself`, async () => {
      const tab = nextTab++, updates = [], modelMessages = [], validations = [];
      const oldSend = api.tabs.sendMessage;
      let agent, send, requests = 0, captures = 0, typed = 0, clicked = 0, terminalStatus;
      api.tabs.sendMessage = async (_id, message) => {
        if (message.action === 'page_monitor_capture_model') {
          captures++;
          return { ready: true, runToken: message.params.runToken, documentToken: 'content-1',
            snapshotToken: 'owned-' + captures, targetCount: 3, focusedTargetAvailable: false,
            page: { success: true, url: PAGE_URL, pageContent: TREE } };
        }
        if (message.action === 'page_monitor_validate_model') {
          validations.push(message.params);
          const unbindable = message.params.selector === SELECTOR;
          return { ready: !unbindable, ...(unbindable ? { reason } : {}), runToken: message.params.runToken,
            documentToken: 'content-1', snapshotToken: message.params.snapshotToken };
        }
        if (message.action === 'page_monitor_prepare') return { ready: true, modelBindingValid: true };
        return { ready: true };
      };
      const next = async messages => {
        modelMessages.push(structuredClone(messages)); requests++;
        assert.ok(requests <= 4, 'An unbindable target must not loop on page updates.');
        // X's timeline updates during every inference.
        send({});
        const answered = toolResults(messages).map(parse).find(result => result?.errorCode === 'action_binding_unavailable');
        if (!answered) return calls(['by-selector-' + requests, 'type_text', { selector: SELECTOR, text: POST, clear: true }],
          ['post-' + requests, 'click_ax', { ref_id: 'ref_post' }]);
        if (!typed) return calls(['by-ref', 'type_ax', { ref_id: 'ref_editor', text: POST, clear: true }]);
        return calls(['finished', 'done', { summary: 'Typed the post into the composer.', outcome: 'success' }]);
      };
      agent = makeAgent(Agent, next);
      agent._endTraceRun = async (_tab, _run, status) => { terminalStatus = status; };
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { send = bind(agent, tab); return { role: 'user', content }; };
      agent.executeTool = async function(id, name, args, onUpdate, context) {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: TREE };
        if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
        // The production page-feedback gate answers before any dispatch.
        if (name === 'type_text') return pageFeedbackExecute.call(this, id, name, args, onUpdate, context);
        if (name === 'click_ax') { clicked++; return { success: true, dispatched: true, verified: true }; }
        assert.equal(name, 'type_ax'); typed++;
        return { success: true, dispatched: true, verified: true };
      };
      try {
        const run = streaming
          ? agent.processMessageStream(tab, 'Type the post into the X composer.', (type, data) => updates.push({ type, data }), 'act',
            { detachedRequestId: 'unbindable-' + tab, askStreamingEnabled: false })
          : agent.processMessage(tab, 'Type the post into the X composer.', (type, data) => updates.push({ type, data }), 'act', [],
            { detachedRequestId: 'unbindable-' + tab, askStreamingEnabled: false });
        const result = await run;
        assert.equal(requests, 3, JSON.stringify({ result, terminalStatus }));
        assert.doesNotMatch(String(result), /page kept changing/);
        assert.notEqual(terminalStatus, 'page_unstable');
        assert.equal(updates.some(update => update.type === 'run_status' && update.data.status === 'page_unstable'), false);
        assert.equal(updates.some(update => update.type === 'failure_recovery'), false);
        const answers = toolResults(modelMessages[1]).map(parse);
        const answer = answers.find(item => item?.errorCode === 'action_binding_unavailable');
        assert.ok(answer, JSON.stringify(answers));
        assert.equal(answer.noDispatch, true); assert.equal(answer.dispatched, false);
        if (reason === 'target_ambiguous') {
          assert.equal(answer.bindingFailure, 'target_ambiguous');
          assert.match(answer.error, /matches more than one element/);
          assert.match(answer.error, /ref_id/);
        } else assert.equal(answer.bindingFailure, undefined);
        assert.ok(answers.some(item => item?.skipped === true && item.skippedBecause === 'fresh_turn_required'),
          'The Post click planned with the unbindable write must not run.');
        assert.equal(clicked, 0);
        assert.equal(typed, 1);
        assert.ok(validations.some(params => params.selector === SELECTOR));
        assert.equal(agent._pageFeedbackRuns.size, 0);
      } finally { api.tabs.sendMessage = oldSend; documents.delete(tab); }
    });
  }

  for (const streaming of [false, true]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} user input during inference still supersedes an unbindable target`, async () => {
      const tab = nextTab++, updates = [], modelMessages = [];
      const oldSend = api.tabs.sendMessage;
      let agent, send, requests = 0, captures = 0;
      api.tabs.sendMessage = async (_id, message) => {
        if (message.action === 'page_monitor_capture_model') {
          captures++;
          return { ready: true, runToken: message.params.runToken, documentToken: 'content-1',
            snapshotToken: 'owned-' + captures, targetCount: 3, focusedTargetAvailable: false,
            page: { success: true, url: PAGE_URL, pageContent: TREE } };
        }
        if (message.action === 'page_monitor_validate_model') {
          const unbindable = message.params.selector === SELECTOR;
          return { ready: !unbindable, ...(unbindable ? { reason: 'target_ambiguous' } : {}), runToken: message.params.runToken,
            documentToken: 'content-1', snapshotToken: message.params.snapshotToken };
        }
        return { ready: true };
      };
      const next = async messages => {
        modelMessages.push(structuredClone(messages)); requests++;
        if (requests === 1) {
          send({ kind: 'click', source: 'user', target: 'button' });
          return calls(['by-selector', 'type_text', { selector: SELECTOR, text: POST, clear: true }]);
        }
        return calls(['finished', 'done', { summary: 'Stopped after the user acted.', outcome: 'partial' }]);
      };
      agent = makeAgent(Agent, next);
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { send = bind(agent, tab); return { role: 'user', content }; };
      let executedTypeText = 0;
      agent.executeTool = async function(id, name, args, onUpdate, context) {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: TREE };
        if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
        if (name === 'type_text') { executedTypeText++; return pageFeedbackExecute.call(this, id, name, args, onUpdate, context); }
        assert.fail(`Unexpected ${name}`);
      };
      try {
        const run = streaming
          ? agent.processMessageStream(tab, 'Type the post into the X composer.', (type, data) => updates.push({ type, data }), 'act',
            { detachedRequestId: 'unbindable-user-' + tab, askStreamingEnabled: false })
          : agent.processMessage(tab, 'Type the post into the X composer.', (type, data) => updates.push({ type, data }), 'act', [],
            { detachedRequestId: 'unbindable-user-' + tab, askStreamingEnabled: false });
        await run;
        assert.equal(executedTypeText, 0, 'A decision made before the user acted is discarded, not answered.');
        assert.equal(toolResults(modelMessages[1]).some(message => /action_binding_unavailable/.test(message.content)), false);
        assert.equal(requests, 2);
      } finally { api.tabs.sendMessage = oldSend; documents.delete(tab); }
    });
  }
}
