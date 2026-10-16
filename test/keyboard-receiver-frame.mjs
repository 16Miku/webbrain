import assert from 'node:assert/strict';
import { test } from 'node:test';

// Chrome attributes native keyboard input to the document whose node has
// focus. If a page moves focus into an iframe while WebBrain types into a
// certified text field of the top document, the text command must not be
// sent into that iframe: the top document is asked whether its operation can
// take input in another document, and a text field never can. Before this,
// the child document's monitor, which knows nothing of the operation, let it
// through.
const PAGE_URL = 'https://x.com/compose/post';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
let replies = null;
const messages = [];
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: PAGE_URL, title: 'Compose post' }),
    sendMessage: async (_id, message, options) => {
      messages.push({ action: message.action, frameId: options?.frameId, params: message.params });
      if (message.action === 'page_monitor_receiver_frame') {
        if (replies.receiver instanceof Error) throw replies.receiver;
        return replies.receiver;
      }
      if (message.action === 'page_monitor_dispatch') return { ready: true, guard: { operationId: message.params.operationId } };
      return { ready: true };
    },
  },
  webNavigation: { getAllFrames: async () => [
    { frameId: 0, parentFrameId: -1, documentId: 'document-top', url: PAGE_URL },
    { frameId: 7, parentFrameId: 0, documentId: 'document-child', url: 'about:srcdoc' },
  ] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 8300;

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { beforePageAgentDispatch } = await import(`../src/${build}/src/agent/page-feedback.js`);

  async function dispatch({ receiver, details, call = { name: 'type_ax', args: { ref_id: 'ref_editor', text: 'x' }, expectedModelSnapshot: 'snapshot-1' } }) {
    const tab = nextTab++;
    const agent = new Agent({ getActive: () => null, getProvider: () => null, getVisionProvider: async () => null });
    agent._runningTabs.add(tab);
    await agent._beginPageFeedbackRun(tab, 'act');
    try {
      for (const [frameId, documentId, url, token] of [[0, 'document-top', PAGE_URL, 'top-doc'], [7, 'document-child', 'about:srcdoc', 'child-doc']]) {
        assert.equal(agent.pageMonitorState({ tab: { id: tab }, frameId, documentId, url }, token).active, true);
      }
      // Only the receiver rule is under test here.
      agent._pageFeedbackBlocksCall = () => false;
      const run = agent._pageFeedbackRuns.get(tab);
      run.dispatchCall = { ...call, allowPassiveRebase: true, dispatchState: { started: true } };
      replies = { receiver };
      messages.length = 0;
      let error = null;
      try { await beforePageAgentDispatch(api, tab, { operationId: 'op-typing', ...details }); } catch (caught) { error = caught; }
      return { error, sent: messages.filter(message => message.action !== 'page_monitor_state') };
    } finally {
      agent._finishPageFeedbackRun(tab);
      agent._runningTabs.delete(tab);
    }
  }
  const text = { kind: 'input', nativeInput: true, nativeTarget: 'marker', documentRevision: 1, eventTypes: ['beforeinput', 'input', 'change'] };

  test(`${build}: certified text input whose receiver has focus in a child document is not sent there`, async () => {
    const { error, sent } = await dispatch({ receiver: { ready: true, foreignReceiverAllowed: false },
      details: { ...text, documentToken: 'child-doc' } });
    assert.equal(error?.code, 'page_feedback_pending', String(error));
    assert.equal(error.pagePreparationVeto?.cause, 'receiver_frame_changed');
    assert.deepEqual(sent.map(item => [item.action, item.frameId]), [['page_monitor_receiver_frame', 0]]);
    assert.equal(sent[0].params.operationId, 'op-typing');
  });

  test(`${build}: without an answer from the top document such input is not sent either`, async () => {
    const { error, sent } = await dispatch({ receiver: new Error('Receiving end does not exist.'),
      details: { ...text, documentToken: 'child-doc' } });
    assert.equal(error?.pagePreparationVeto?.cause, 'receiver_frame_changed', String(error));
    assert.equal(sent.some(item => item.action === 'page_monitor_dispatch'), false);
  });

  test(`${build}: an operation that allows a child-document receiver still reaches that document`, async () => {
    const { error, sent } = await dispatch({ receiver: { ready: true, foreignReceiverAllowed: true },
      details: { ...text, documentToken: 'child-doc' } });
    assert.equal(error, null, String(error));
    assert.deepEqual(sent.map(item => [item.action, item.frameId]), [['page_monitor_receiver_frame', 0], ['page_monitor_dispatch', 7]]);
  });

  test(`${build}: top-document receivers, releases and uncertified calls are not asked`, async () => {
    for (const [details, call] of [
      [{ ...text, documentToken: 'top-doc' }, undefined],
      [{ ...text, documentToken: 'child-doc', release: true }, undefined],
      [{ ...text, documentToken: 'child-doc' }, { name: 'iframe_type', args: { selector: 'input', text: 'x' } }],
    ]) {
      const { error, sent } = await dispatch({ receiver: { ready: true, foreignReceiverAllowed: false }, details, ...(call ? { call } : {}) });
      assert.equal(error, null, String(error));
      assert.equal(sent.some(item => item.action === 'page_monitor_receiver_frame'), false, JSON.stringify(sent));
      assert.equal(sent.filter(item => item.action === 'page_monitor_dispatch').length, 1);
    }
  });
}
