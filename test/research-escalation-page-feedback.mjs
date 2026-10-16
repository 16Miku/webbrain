// Real feedback response/dispatch fences and research authorization handler.
// Browser responses and the external research helper are the only action stubs.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PAGE_URL = 'https://research.example/article';
const APPROVED_REQUEST = 'Explain how the network token relates to its AI inference business. Use web research and link sources.';
const PAGE = { success: true, url: PAGE_URL, pageContent: 'main [ref_main]\n heading "Network research" [ref_title]\n text "Article text"' };
const fixtures = new Map();
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
let nextTab = 9700;
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: fixtures.get(id)?.url || PAGE_URL, title: 'Research' }),
    sendMessage: async (id, message) => {
      const fixture = fixtures.get(id);
      if (message.action === 'page_monitor_capture_model') {
        return { ready: true, runToken: message.params.runToken, documentToken: 'main-token',
          snapshotToken: 'research-snapshot', targetCount: 0, focusedTargetAvailable: false,
          page: structuredClone(PAGE) };
      }
      if (message.action === 'get_accessibility_tree') {
        fixture.reads++;
        fixture.onRead?.();
        return structuredClone(PAGE);
      }
      if (message.action === 'page_monitor_prepare') {
        fixture.preparations++;
        fixture.onPrepare?.();
      }
      return { ready: true };
    },
  },
  webNavigation: { getAllFrames: async ({ tabId }) => [{ frameId: 0, parentFrameId: -1,
    documentId: fixtures.get(tabId)?.documentId || 'main-document', url: fixtures.get(tabId)?.url || PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: { url: PAGE_URL, contentType: 'text/html' } }] },
};
globalThis.chrome = api;
globalThis.browser = api;

function makeFixture(Agent) {
  const tab = nextTab++;
  const provider = { name: 'research feedback fixture', model: 'test', supportsTools: true, supportsVision: false };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  // Storage is outside this test's response and dispatch boundary.
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._pageFeedbackIdleMs = 0;
  agent.researchEscalationEnabled = true;
  agent.conversationIds.set(tab, `research-conversation-${tab}`);
  agent.conversationModes.set(tab, 'ask');
  const messages = [{ role: 'system', content: 'Research fixture.' }, { role: 'user', content: 'Explain the token and inference business.' }];
  agent.conversations.set(tab, messages);
  const fixture = { agent, tab, messages, url: PAGE_URL, documentId: 'main-document', reads: 0,
    preparations: 0, approvals: 0, helpers: [], emit: null, onRead: null, onPrepare: null };
  agent._runResearchEscalation = async (sourceTab, authorization, args) => {
    fixture.helpers.push({ sourceTab, authorization: structuredClone(authorization), args: structuredClone(args) });
    return { success: true, answer: 'Research answer with sources.', links: ['https://sources.example/research'] };
  };
  fixtures.set(tab, fixture);
  return fixture;
}

async function start(fixture) {
  const { agent, tab } = fixture;
  await agent._claimRunEntry(tab, 'interactive');
  const from = { tab: { id: tab }, frameId: 0, documentId: fixture.documentId, url: fixture.url };
  const state = agent.pageMonitorState(from, 'main-token');
  assert.equal(state.active, true);
  let seq = 0;
  fixture.emit = event => {
    const revision = ++seq;
    const response = agent.observePageFeedback(from, { ...state, seq: revision, revision,
      kind: 'dom', source: 'page', target: 'span#counter', ...event });
    assert.equal(response.accepted, true);
  };
}

function cleanup(fixture) {
  fixture.agent._finishSteeringRun(fixture.tab);
  fixture.agent._releaseRunEntry(fixture.tab);
  fixtures.delete(fixture.tab);
}

async function approve(fixture) {
  const { agent, tab } = fixture;
  const result = await agent.executeTool(tab, 'clarify', {
    question: 'Delegate this research question?', purpose: 'research_escalation',
    options: ['Continue here', 'Use ChatGPT'], approve_option: 'Use ChatGPT', research_request: APPROVED_REQUEST,
  }, (type, data) => {
    if (type !== 'clarify') return;
    fixture.approvals++;
    assert.equal(data.requireExplicitAnswer, true);
    assert.equal(data.researchEscalation.request, APPROVED_REQUEST);
    queueMicrotask(() => agent.submitClarifyResponse(tab, data.clarifyId, 'Use ChatGPT', 'option'));
  });
  assert.equal(result.researchEscalationApproved, true);
  assert.ok(result.authorization_token);
  return result.authorization_token;
}

const proposal = args => ({ id: 'delegate-approved-research', function: {
  name: 'delegate_research', arguments: JSON.stringify(args),
} });
const applyResponse = (fixture, call) => fixture.agent._applyPendingPageFeedback(fixture.tab, fixture.messages, () => {}, {
  responseToolCalls: [call],
});
const capture = fixture => fixture.agent._capturePageFeedbackModelState(fixture.tab, fixture.messages);

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  test(`${build}: approved research dispatches once through DOM churn during inference, refresh and preparation`, async () => {
    const fixture = makeFixture(Agent), { agent, tab } = fixture;
    try {
      await start(fixture);
      const token = await approve(fixture);
      await capture(fixture);
      // These updates arrive after the pre-inference observation, before the
      // model's delegation proposal reaches its response freshness fence.
      fixture.emit({}); fixture.emit({});
      fixture.onRead = () => fixture.emit({});
      fixture.onPrepare = () => fixture.emit({});
      const args = { authorization_token: token, research_request: 'A model-added replacement must never be submitted.' };
      const call = proposal(args);
      assert.equal(await applyResponse(fixture, call), false, 'The original approved proposal survives counter churn');
      assert.equal(fixture.helpers.length, 0, 'Retaining a proposal does not submit it or consume authorization');
      assert.equal(agent._researchEscalationAuthorization(tab, token).ok, true);
      assert.equal(await agent._refreshPageFeedbackForCall(tab, call), false);
      const result = await agent.executeTool(tab, 'delegate_research', args);
      assert.equal(result.success, true);
      assert.ok(fixture.reads >= 2, 'New counter updates during both response and per-call refresh are exercised');
      assert.equal(fixture.preparations, 1, 'The real state-changing wrapper prepares the call');
      assert.equal(fixture.helpers.length, 1);
      assert.equal(fixture.helpers[0].sourceTab, tab);
      assert.equal(fixture.helpers[0].authorization.request, APPROVED_REQUEST);
      assert.equal(fixture.approvals, 1, 'DOM churn does not request fresh consent');
      assert.equal(agent._researchEscalationAuthorization(tab, token).ok, false);

      const duplicate = await agent.executeTool(tab, 'delegate_research', args);
      assert.equal(duplicate.denied, true);
      assert.match(duplicate.error, /already-used research authorization/);
      assert.equal(fixture.helpers.length, 1, 'Reusing a dispatched token cannot send the prompt again');
    } finally { cleanup(fixture); }
  });

  test(`${build}: same-conversation continuation preserves consent while resize requires a new decision`, async () => {
    const fixture = makeFixture(Agent), { agent, tab } = fixture;
    const resize = { kind: 'resize', source: 'unknown', target: 'viewport',
      viewport: { width: 1280, height: 745 }, before: { width: 1280, height: 801 } };
    try {
      await start(fixture);
      const token = await approve(fixture), call = proposal({ authorization_token: token });
      await capture(fixture);
      fixture.emit(resize);
      assert.equal(await applyResponse(fixture, call), true, 'A top-level resize supersedes the first proposal');
      assert.equal(agent._researchEscalationAuthorization(tab, token).ok, true);
      const previousRun = agent._pageFeedbackRuns.get(tab).token;
      agent._releaseRunEntry(tab);
      await start(fixture);
      assert.notEqual(agent._pageFeedbackRuns.get(tab).token, previousRun);
      assert.equal(agent._researchEscalationAuthorization(tab, token).ok, true, 'A new run in the same conversation retains unused consent');

      await capture(fixture);
      fixture.emit(resize);
      assert.equal(await agent._refreshPageFeedbackForCall(tab, call), true, 'Continue does not bypass a new resize');
      assert.equal(fixture.helpers.length, 0);
      assert.equal(agent._researchEscalationAuthorization(tab, token).ok, true);
      await agent._applyPendingPageFeedback(tab, fixture.messages);
      await capture(fixture); // A new decision follows the resize observation.
      fixture.emit({});
      fixture.onRead = () => fixture.emit({});
      fixture.onPrepare = () => fixture.emit({});
      assert.equal(await applyResponse(fixture, call), false);
      assert.equal((await agent.executeTool(tab, 'delegate_research', { authorization_token: token })).success, true);
      assert.equal(fixture.helpers.length, 1);
      assert.equal(fixture.approvals, 1);
      assert.equal(fixture.helpers[0].authorization.request, APPROVED_REQUEST);
    } finally { cleanup(fixture); }
  });

  for (const intervention of ['user_input', 'viewport', 'navigation', 'steering']) {
    test(`${build}: ${intervention} during delegation preparation blocks dispatch without consuming consent`, async () => {
      const fixture = makeFixture(Agent), { agent, tab } = fixture;
      try {
        await start(fixture);
        const token = await approve(fixture);
        if (intervention === 'steering') agent._beginSteeringRun(tab, () => {}, { detachedRequestId: 'research-steering' });
        await capture(fixture);
        fixture.onPrepare = () => {
          if (intervention === 'user_input') fixture.emit({ kind: 'input', source: 'user', target: 'input#search' });
          if (intervention === 'viewport') fixture.emit({ kind: 'resize', source: 'unknown', target: 'viewport' });
          if (intervention === 'navigation') {
            fixture.url = 'https://research.example/another-article';
            fixture.documentId = 'replacement-document';
            agent.observePageNavigation({ tabId: tab, frameId: 0, parentFrameId: -1,
              documentId: fixture.documentId, url: fixture.url, transitionType: 'link', transitionQualifiers: [] }, 'committed');
          }
          if (intervention === 'steering') {
            assert.equal(agent.steerMessage(tab, 'Continue the research locally.', {
              requestId: 'research-steering', messageId: 'local-research-correction',
            }).accepted, true);
            fixture.emit({});
          }
        };
        const result = await agent.executeTool(tab, 'delegate_research', { authorization_token: token });
        assert.equal(result.noDispatch, true);
        assert.equal(result.dispatched, false);
        assert.equal(fixture.helpers.length, 0);
        assert.equal(agent._researchEscalationAuthorization(tab, token).ok, true);
      } finally { cleanup(fixture); }
    });
  }

  test(`${build}: DOM retention preserves missing, expired, consumed, scope and feature authorization checks`, async () => {
    for (const invalid of ['missing', 'unknown', 'expired', 'consumed', 'wrong_tab', 'wrong_conversation', 'disabled']) {
      const fixture = makeFixture(Agent), { agent, tab } = fixture;
      try {
        await start(fixture);
        const token = await approve(fixture);
        const args = { authorization_token: token };
        if (invalid === 'missing') delete args.authorization_token;
        if (invalid === 'unknown') args.authorization_token = 'research_not-issued';
        if (invalid === 'expired') agent._researchEscalationAuthorizations.get(token).createdAt = Date.now() - 5 * 60 * 1000 - 1;
        if (invalid === 'consumed') agent._researchEscalationAuthorization(tab, token, { consume: true });
        if (invalid === 'wrong_tab') agent._researchEscalationAuthorizations.get(token).tabId = tab + 1;
        if (invalid === 'wrong_conversation') agent.conversationIds.set(tab, 'another-conversation');
        if (invalid === 'disabled') agent.researchEscalationEnabled = false;
        await capture(fixture);
        fixture.emit({});
        fixture.onRead = () => fixture.emit({});
        fixture.onPrepare = () => fixture.emit({});
        assert.equal(await applyResponse(fixture, proposal(args)), false, `${invalid}: retention only preserves the proposal`);
        const result = await agent.executeTool(tab, 'delegate_research', args);
        assert.equal(result.success, false, invalid);
        assert.equal(result.denied, invalid === 'disabled' ? undefined : true, invalid);
        assert.equal(fixture.helpers.length, 0, `${invalid}: invalid consent must never open the research helper`);
      } finally { cleanup(fixture); }
    }
  });
}
