// Real Agent loop with mocked browser APIs (unit level, both builds): a
// read-only Ask answer survives what the person does on the page while it is
// written (viewing, clicking, typing) and scrolls or resizes from anywhere;
// a navigation of the page to another address, and Act decisions, stay strict.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PAGE_URL = 'https://shop.example/products';
const TREE = 'list "Products" [ref_1]\n listitem "A $9" [ref_2]\n listitem "B $5" [ref_3]';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Products' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'main-document', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 8600;
const ANSWER = 'The page lists A and B; B is the cheapest at $5.';

function makeAgent(Agent, respond) {
  let agent;
  const provider = { name: 'ask viewing test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false, _supportsInteractiveAskStreaming: () => true,
    chat: async messages => messages[0]?.content?.startsWith('You classify whether one proposed terminal WebBrain Ask answer')
      ? { content: '{"pageIndependent":false}' } : respond(agent, false),
    async *chatStream(messages) {
      const response = await respond(agent, true);
      for (const chunk of response.chunks || []) {
        yield { type: 'text', content: chunk.text };
        chunk.after?.();
      }
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { type: 'done' };
    } };
  agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  Object.assign(agent, {
    _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
    _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
    _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
    _currentUrl: async () => PAGE_URL, _getTabUrlTitle: async () => ({ tabUrl: PAGE_URL, tabTitle: 'Products' }),
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
  const begin = agent._beginPageFeedbackRun.bind(agent);
  agent._beginPageFeedbackRun = async (tab, ...rest) => {
    await begin(tab, ...rest);
    const from = { tab: { id: tab }, frameId: 0, documentId: 'main-document', url: PAGE_URL };
    const state = agent.pageMonitorState(from, 'main-token');
    assert.equal(state.active, true);
    let seq = 0;
    agent.__send = value => assert.equal(agent.observePageFeedback(from, { ...state, seq: ++seq, revision: seq, ...value }).accepted, true);
  };
  agent.executeTool = async (_tab, name, args) => {
    if (name === 'get_accessibility_tree') return { success: true, pageContent: TREE };
    assert.equal(name, 'done', 'Ask answers dispatch nothing else');
    return { done: true, success: true, summary: args.summary };
  };
  return agent;
}

const VIEWING = {
  'the person scrolling': { kind: 'scroll', source: 'user', target: 'html', viewport: { x: 0, y: 400 } },
  'the person selecting text': { kind: 'selection', source: 'user', target: 'p' },
  'the person using the wheel or keys': { kind: 'activity', source: 'user', target: 'div#list' },
  // What the person does on the page while the answer is written, as in
  // the WhatsApp trace: they typed a draft and clicked around.
  'the person clicking': { kind: 'click', source: 'user', target: 'button#sort' },
  'the person typing': { kind: 'input', source: 'user', target: 'input#filter' },
  'the page changing from their typing': { kind: 'dom', source: 'user', target: 'div#composer' },
  // A page that scrolls itself, such as a chat showing a new message, and a
  // resized viewport show the same content.
  'the page scrolling itself': { kind: 'scroll', source: 'unknown', target: 'div#messages', viewport: { x: 0, y: 900 } },
  'the viewport resizing': { kind: 'resize', source: 'unknown', target: 'viewport', viewport: { width: 900, height: 700 } },
};
const CHANGING = {
  'the person navigating to another address': { kind: 'navigation', source: 'user' },
};
const emit = (agent, tab, event) => event.kind === 'navigation'
  ? agent._queuePageFeedback(tab, { ...event, frameId: 0, before: PAGE_URL, after: PAGE_URL + '?sorted' })
  : agent.__send(event);
const retracted = updates => updates.some(update => update.type === 'text' && update.data?.replace === true && update.data.content === '');

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  for (const [name, event] of [...Object.entries(VIEWING), ...Object.entries(CHANGING)]) {
    const survives = name in VIEWING;
    test(`${build}: a streamed Ask answer ${survives ? 'survives' : 'is regenerated after'} ${name}`, async () => {
      const tab = nextTab++, updates = [];
      let calls = 0;
      const agent = makeAgent(Agent, (owner, streamed) => {
        assert.equal(streamed, true);
        if (++calls === 1) return { chunks: [{ text: 'The page lists A and B; ', after: () => emit(owner, tab, event) }, { text: 'B is the cheapest at $5.' }] };
        return { chunks: [{ text: 'Regenerated: ' + ANSWER }] };
      });
      const result = await agent.processMessage(tab, 'Which product is cheapest?', (type, data) => updates.push({ type, data }), 'ask', [],
        { detachedRequestId: 'ask-' + tab, interactiveChat: true, askStreamingEnabled: true });
      assert.equal(calls, survives ? 1 : 2);
      assert.equal(result, survives ? ANSWER : 'Regenerated: ' + ANSWER);
      assert.equal(retracted(updates), !survives, survives ? 'What the person does on the page must not retract a visible answer' : 'A navigation invalidates it');
      assert.equal(agent._pageFeedbackRuns.size, 0);
    });
  }

  // The trace's person typed a long draft while the answer was written; the
  // answer is delivered without waiting for them to stop typing.
  for (const entry of ['chat', 'chat_stream']) test(`${build}: a streamed Ask answer is delivered while the person keeps typing (${entry})`, async () => {
    const tab = nextTab++, updates = [];
    let calls = 0, typing = null, answered = 0;
    const agent = makeAgent(Agent, (owner, streamed) => {
      assert.equal(streamed, true);
      calls++;
      // They type for three seconds, longer than the answer takes.
      const type = () => owner.__send({ kind: 'input', source: 'user', target: 'div#composer' });
      const until = Date.now() + 3000;
      return { chunks: [{ text: 'The page lists A and B; ', after: () => {
        type(); typing = setInterval(() => { if (Date.now() < until) type(); else clearInterval(typing); }, 150);
      } },
        { text: 'B is the cheapest at $5.', after: () => { answered = Date.now(); } }] };
    });
    agent._pageFeedbackIdleMs = 1000;
    try {
      const options = { detachedRequestId: 'ask-' + tab, interactiveChat: true, askStreamingEnabled: true };
      const update = (type, data) => updates.push({ type, data });
      const result = entry === 'chat' ? await agent.processMessage(tab, 'Which product is cheapest?', update, 'ask', [], options)
        : await agent.processMessageStream(tab, 'Which product is cheapest?', update, 'ask', options);
      const settled = Date.now() - answered;
      assert.equal(result, ANSWER);
      assert.equal(calls, 1);
      assert.equal(retracted(updates), false);
      assert.ok(settled < 900, `The run finished ${settled} ms after the answer, while the person was still typing`);
    } finally { clearInterval(typing); }
  });

  for (const streaming of [false, true]) for (const [name, event] of [['the person scrolling', VIEWING['the person scrolling']],
    ['the person clicking', VIEWING['the person clicking']], ...Object.entries(CHANGING)]) {
    const survives = name in VIEWING;
    test(`${build}: ${streaming ? 'stream' : 'chat'} Ask done summary ${survives ? 'survives' : 'is reconsidered after'} ${name}`, async () => {
      const tab = nextTab++, delivered = [];
      let calls = 0;
      const agent = makeAgent(Agent, owner => {
        calls++;
        if (calls === 1) emit(owner, tab, event);
        return { toolCalls: [{ id: 'answer-' + calls, function: { name: 'done', arguments: JSON.stringify({ summary: calls === 1 ? ANSWER : 'Fresh: ' + ANSWER }) } }] };
      });
      const execute = agent.executeTool;
      agent.executeTool = async (tab_, tool, args) => { if (tool === 'done') delivered.push(args.summary); return execute(tab_, tool, args); };
      const options = { detachedRequestId: 'ask-done-' + tab, askStreamingEnabled: false };
      const result = streaming ? await agent.processMessageStream(tab, 'Which product is cheapest?', () => {}, 'ask', options)
        : await agent.processMessage(tab, 'Which product is cheapest?', () => {}, 'ask', [], options);
      assert.equal(calls, survives ? 1 : 2);
      assert.deepEqual(delivered, [survives ? ANSWER : 'Fresh: ' + ANSWER]);
      assert.equal(result, delivered[0]);
    });
  }

  test(`${build}: Act decisions stay strict for a user scroll`, async () => {
    const tab = nextTab++, dispatched = [];
    let calls = 0;
    const agent = makeAgent(Agent, owner => {
      calls++;
      if (calls === 1) emit(owner, tab, VIEWING['the person scrolling']);
      return calls <= 2 ? { toolCalls: [{ id: 'read-' + calls, function: { name: 'extract_data', arguments: '{"type":"headings"}' } }] }
        : { toolCalls: [{ id: 'finished', function: { name: 'done', arguments: JSON.stringify({ summary: ANSWER, outcome: 'success' }) } }] };
    });
    agent.executeTool = async (_tab, name, args) => {
      if (name === 'get_accessibility_tree') return { success: true, pageContent: TREE };
      dispatched.push(name);
      return name === 'done' ? { done: true, success: true, summary: args.summary, outcome: args.outcome } : { success: true, headings: ['Products'] };
    };
    assert.equal(await agent.processMessage(tab, 'Read the product headings', () => {}, 'act', [], { detachedRequestId: 'act-' + tab }), ANSWER);
    assert.equal(calls, 3, 'The Act decision made before the user scroll is reconsidered');
    assert.deepEqual(dispatched, ['extract_data', 'done']);
  });
}
