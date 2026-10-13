// Real Agent stream loop with the real one-shot local vision fallback (browser
// APIs, vision route and local describer mocked), both builds. When page
// feedback is applied at the start of the retry step, the fallback must be
// kept (never resend the image the provider rejected) and must carry the new
// browser observation instead of the superseded one.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PAGE_URL = 'https://example.com/photo/1';
const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Photo' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 8700;
const hasImage = messages => messages.some(message => Array.isArray(message.content)
  && message.content.some(block => block?.type === 'image_url'));
const text = messages => JSON.stringify(messages);

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  for (const feedback of [false, true]) {
    test(`${build}: stream keeps the one-shot vision fallback ${feedback ? 'and adds the new page observation' : 'without page feedback'}`, async () => {
      const tab = nextTab++, requests = [], updates = [];
      let agent, send;
      const next = async messages => {
        requests.push(structuredClone(messages));
        if (requests.length === 1) {
          assert.equal(hasImage(messages), true, 'fixture: the first request carries the image');
          if (feedback) send({}); // an ordinary page update while the request fails
          const error = new Error('Invalid request: image input is not supported by this model.');
          error.status = 400;
          throw error;
        }
        return { content: 'The capture shows the photo settings page.' };
      };
      const provider = {
        name: 'vision fallback test', model: 'test', promptTier: 'full', contextWindow: 128000,
        supportsTools: true, supportsVision: true,
        chat: messages => messages[0]?.content?.startsWith?.('You classify whether one proposed terminal WebBrain Ask answer')
          ? Promise.resolve({ content: '{"pageIndependent":false}' }) : next(messages),
        async *chatStream(messages) {
          const response = await next(messages);
          if (response.content) yield { type: 'text', content: response.content };
          yield { type: 'done' };
        },
      };
      const local = { name: 'local vision', config: { model: 'lfm' } };
      agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null,
        getLocalVisionFallbackProvider: async () => local });
      Object.assign(agent, {
        _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
        _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
        _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
        _currentUrl: async () => PAGE_URL, _getTabUrlTitle: async () => ({ tabUrl: PAGE_URL, tabTitle: 'Photo' }),
        _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {}, _shouldAutoScreenshot: () => false,
        _pageFeedbackIdleMs: 0,
        _resolveVisionRoute: async (_tab, active) => ({ route: 'active_raw', provider: active, rawImage: true }),
        _describeScreenshot: async () => ({ text: 'local description of the capture', model: 'lfm' }),
      });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
        const from = { tab: { id: tab }, frameId: 0, documentId: 'document-1', url: PAGE_URL };
        const state = agent.pageMonitorState(from, 'content-1');
        let seq = 0;
        send = value => agent.observePageFeedback(from, { ...state, seq: ++seq, revision: seq, kind: 'dom', source: 'page', target: 'span#views', ...value });
        return { role: 'user', content: [{ type: 'text', text: content }, { type: 'image_url', image_url: { url: IMAGE } }] };
      };
      agent._executeToolWithLifecycle = async () => ({ success: true, pageContent: 'main [ref_0]\n img "Photo" [ref_1]' });
      const result = await agent.processMessageStream(tab, 'Describe the attached capture', (type, data) => updates.push({ type, data }),
        'ask', { detachedRequestId: 'vision-' + tab, askStreamingEnabled: false });
      assert.equal(result, 'The capture shows the photo settings page.');
      assert.equal(requests.length, 2);
      assert.ok(updates.some(update => update.data?.code === 'vision_local_fallback_retry'));
      const retry = requests[1];
      assert.equal(hasImage(retry), false, 'The rejected image is never resent');
      assert.match(text(retry), /local description of the capture/);
      if (feedback) {
        assert.equal((text(retry).match(/BROWSER STATE UPDATE/g) || []).length, 1, 'The applied page observation reaches the retry exactly once');
      }
    });
  }
}
