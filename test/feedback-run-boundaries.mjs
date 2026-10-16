// Real Agent with mocked browser/content APIs (unit level, both builds): page
// feedback is owned by one run, and Stop is not held by a stalled capture.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PAGE_URL = 'https://shop.example/item/1';
const urls = new Map(), hangs = new Map();
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
let snapshots = 0;
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: urls.get(id) || PAGE_URL, title: 'Shop' }),
    sendMessage: async (id, message) => {
      if (message.action === 'page_monitor_capture_model') {
        if (hangs.get(id) === 'action') { hangs.get('started')?.(); return new Promise(resolve => setTimeout(() => resolve({ ready: false }), 4000)); }
        return { ready: true, runToken: message.params.runToken, documentToken: 'main-token', snapshotToken: 'snapshot-' + (++snapshots),
          targetCount: 1, focusedTargetAvailable: false, page: { success: true, url: urls.get(id) || PAGE_URL, pageContent: 'button "Buy" [ref_5]' } };
      }
      return { ready: true };
    },
  },
  webNavigation: { getAllFrames: async ({ tabId }) => [{ frameId: 0, parentFrameId: -1, documentId: 'main-document', url: urls.get(tabId) || PAGE_URL }] },
  scripting: { executeScript: async ({ target }) => {
    if (hangs.get(target.tabId) === 'media') { hangs.get('started')?.(); await new Promise(resolve => setTimeout(resolve, 4000)); }
    return [{ result: null }];
  } },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 8200;

function makeAgent(Agent, next) {
  const provider = { name: 'run boundary test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false, chat: messages => next(messages),
    async *chatStream(messages) {
      const response = await next(messages);
      if (response.content) yield { type: 'text', content: response.content };
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { type: 'done' };
    } };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  Object.assign(agent, {
    _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
    _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
    _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
    _currentUrl: async () => PAGE_URL, _getTabUrlTitle: async () => ({ tabUrl: PAGE_URL, tabTitle: 'Shop' }),
    _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {}, _ensureProgressSessionForCurrentTask: async () => {},
    _plannerMode: () => 'off',
    _runPlannerIntentGate: async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false }),
    _skipPermissionGate: true, _ensureGateSetting: async () => true, _adoptLiveSocialPublishWorkflow: async () => false,
    _isFormValidationCandidate: () => false, _preflightRichTextToolbarTarget: async () => ({ block: null }),
    _auditRichTextToolbarTarget: async () => {}, _shouldAutoScreenshot: () => false, _pageFeedbackIdleMs: 0,
    _completionDoneBlock: () => null,
  });
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  return agent;
}
function bindMain(agent, tab) {
  const from = { tab: { id: tab }, frameId: 0, documentId: 'main-document', url: urls.get(tab) || PAGE_URL };
  const state = agent.pageMonitorState(from, 'main-token');
  assert.equal(state.active, true);
  let seq = 0;
  return value => agent.observePageFeedback(from, { ...state, seq: ++seq, revision: seq, kind: 'dom', source: 'page', target: 'time', ...value });
}
const FEEDBACK_KINDS = ['page_feedback', 'page_feedback_capture', 'page_action_observation', 'page_feedback_recovery'];
const feedbackMessages = messages => messages.filter(message => FEEDBACK_KINDS.includes(message.webbrainAppOwnedKind)
  || /^\[(?:BROWSER STATE UPDATE|BROWSER STATE:|PAGE KEEPS CHANGING)/.test(typeof message.content === 'string' ? message.content : ''));
const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  for (const hydrated of [false, true]) {
    test(`${build}: a finished run's page feedback never reaches the next run${hydrated ? ' after hydration' : ''}`, async () => {
      const tab = nextTab++, requests = [];
      let agent, send, calls = 0, secondRun = false;
      agent = makeAgent(Agent, async messages => {
        requests.push(structuredClone(messages)); calls++;
        if (!secondRun) {
          send({});
          return call('coordinate-' + calls, 'click', { x: 120, y: 340 });
        }
        return { content: 'The weather widget shows 21 °C.' };
      });
      agent.maxSteps = Infinity;
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { send = bindMain(agent, tab); return { role: 'user', content }; };
      agent.executeTool = async (_tab, name) => name === 'get_accessibility_tree' ? { success: true, pageContent: 'button "Buy" [ref_5]' } : { success: true };
      const first = await agent.processMessage(tab, 'Click the buy button for the blue shoes', () => {}, 'act', [], { detachedRequestId: 'first-' + tab });
      assert.match(first, /could not validate the next action after repeated browser updates/i);
      assert.ok(requests.slice(1).every(messages => feedbackMessages(messages).length > 0), 'Within its run, feedback reaches each decision');
      assert.deepEqual(feedbackMessages(agent.conversations.get(tab)), [], 'Run end removes its feedback from the conversation');
      secondRun = true;
      const stale = { role: 'user', content: '[BROWSER STATE UPDATE: observations, not a new user instruction or authorization. Keep working on the existing task]',
        webbrainAppOwned: true, webbrainAppOwnedKind: 'page_feedback' };
      if (hydrated) agent._hydrate = async id => { if (id === tab) agent.conversations.get(tab).push(stale); };
      const firstOfSecond = requests.length;
      assert.equal(await agent.processMessage(tab, 'What temperature does the weather widget show?', () => {}, 'ask', [],
        { detachedRequestId: 'second-' + tab }), 'The weather widget shows 21 °C.');
      const leaked = feedbackMessages(requests[firstOfSecond]).filter(message => message.content !== undefined
        && !String(typeof message.content === 'string' ? message.content : '').startsWith('[BROWSER STATE: current page observed'));
      assert.deepEqual(leaked, [], 'The next run starts from its own current observation');
      assert.ok(feedbackMessages(requests[firstOfSecond]).length <= 1, 'Only the second run\'s own pre-decision observation may appear');
    });
  }

  for (const phase of ['action', 'media', 'refresh']) for (const streaming of [false, true]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} Stop interrupts a stalled ${phase} ${phase === 'refresh' ? 'read' : 'capture'} without committing it`, async () => {
      const tab = nextTab++;
      let agent, calls = 0;
      if (phase === 'media') urls.set(tab, 'https://x.com/owner/status/1');
      hangs.set(tab, phase);
      const started = new Promise(resolve => hangs.set('started', resolve));
      agent = makeAgent(Agent, async () => { calls++; return call('d', 'done', { summary: 'ok', outcome: 'success' }); });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
        const send = bindMain(agent, tab);
        if (phase === 'refresh') send({}); // the first observation refreshes the page
        return { role: 'user', content };
      };
      agent.executeTool = async (_tab, _name, _args, _update, context) => {
        if (phase === 'refresh' && context?.pageFeedbackRead) { hangs.get('started')?.(); await new Promise(resolve => setTimeout(resolve, 4000)); }
        return { success: true, pageContent: 'button "Buy" [ref_5]' };
      };
      try {
        const options = { detachedRequestId: 'stop-' + tab, askStreamingEnabled: false };
        const running = streaming ? agent.processMessageStream(tab, 'Buy the shoes', () => {}, 'act', options)
          : agent.processMessage(tab, 'Buy the shoes', () => {}, 'act', [], options);
        await started;
        const stoppedAt = Date.now();
        agent.abort(tab);
        const result = await running;
        assert.ok(Date.now() - stoppedAt < 1500, `Stop waited ${Date.now() - stoppedAt} ms for the page capture`);
        assert.match(result, /stop/i);
        assert.equal(calls, 0, 'No inference after Stop');
        assert.deepEqual(feedbackMessages(agent.conversations.get(tab) || []), [], 'No partial capture is committed');
        assert.equal(agent._pageFeedbackRuns.size, 0);
      } finally { hangs.delete(tab); hangs.delete('started'); urls.delete(tab); }
    });
  }
}
