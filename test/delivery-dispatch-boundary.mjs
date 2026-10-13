// Delivery regression: hover, drag_drop and set_checked mark dispatch at the
// input transport boundary, never before their fences.
// - Chrome: the trusted CDP command that is the tool's first consequential
//   input (hover: the pointer move; drag_drop and set_checked: the press, the
//   no-button move before it being pointer preparation as for every click).
// - Firefox: the native BiDi request after its preparation probe and
//   page-feedback fence, or the content message for content-script tools.
// A refusal before that boundary reports noDispatch; a failure after it
// reports dispatched with an unknown outcome, and nothing is resent.
//
// [mocked transport] The real Agent of each build. Chrome runs the real
// cdpClient.sendCommand: its pre-protocol check (_beforeCommand, where the
// page-feedback fence runs) is wrapped to refuse, and chrome.debugger is a
// recorder that can lose an acknowledgement after the command arrived.
// Firefox runs the real FirefoxBidiClient with a mocked native request and
// content messaging; its page-feedback fences use the real page-feedback run.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, getManifest: () => ({ version: 'test' }), lastError: null },
  tabs: { get: async () => ({ id: 17, url: 'https://boundary.test/start' }), query: async () => [{ id: 17 }],
    sendMessage: async () => ({}), update: async () => ({}) },
  scripting: { executeScript: async () => [{}] },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'boundary-document', url: 'https://boundary.test/start' }] },
  debugger: { sendCommand: () => { throw new Error('debugger recorder not installed'); },
    onEvent: { addListener() {}, removeListener() {} }, onDetach: { addListener() {}, removeListener() {} } },
};
globalThis.chrome = api;
globalThis.browser = api;
const { Agent: ChromeAgent } = await import('../src/chrome/src/agent/agent.js');
const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
const { Agent: FirefoxAgent } = await import('../src/firefox/src/agent/agent.js');
const { firefoxBidi } = await import('../src/firefox/src/bidi/client.js');

const pageFeedbackVeto = () => Object.assign(
  new Error('The browser changed during action preparation. Re-observe the page before acting.'),
  { code: 'page_feedback_pending' },
);
const notAttached = () => new Error('Not attached to tab 17');
const lostAck = 'Detached while handling command.';

// ── Chrome ─────────────────────────────────────────────────────────────────
const original = { attach: cdpClient.attach, beforeCommand: cdpClient._beforeCommand,
  resolveSelector: cdpClient.resolveSelector, arm: cdpClient.armFileInputClickGuard, consume: cdpClient.consumeFileInputClickGuard };

// `refuse(params, index)` rejects an Input command before the protocol call
// (the fence or the session check); `lose(params, index)` loses the
// acknowledgement of an Input command that reached the page. Returns the
// Input commands that reached chrome.debugger.
function chromeTransport({ refuse = () => null, lose = () => false } = {}) {
  const delivered = [];
  let index = 0;
  cdpClient.sessions.set(17, { tabId: 17, attached: true });
  cdpClient.attach = async () => {};
  cdpClient.armFileInputClickGuard = async () => {};
  cdpClient.consumeFileInputClickGuard = async () => ({ blocked: false });
  cdpClient._beforeCommand = async function (tabId, method, params, sessionId) {
    if (method === 'Input.dispatchMouseEvent') {
      const refusal = refuse(params, index);
      if (refusal) { index++; throw refusal(); }
    }
    return original.beforeCommand.call(this, tabId, method, params, sessionId);
  };
  api.debugger.sendCommand = (_target, method, params, callback) => {
    let lost = false;
    if (method === 'Input.dispatchMouseEvent') {
      delivered.push({ type: params.type, x: params.x, y: params.y, buttons: params.buttons });
      lost = lose(params, index++);
    }
    Promise.resolve().then(() => {
      if (lost) api.runtime.lastError = { message: lostAck };
      try { callback({}); } finally { api.runtime.lastError = null; }
    });
  };
  return delivered;
}

function restoreChrome() {
  Object.assign(cdpClient, { attach: original.attach, _beforeCommand: original.beforeCommand,
    resolveSelector: original.resolveSelector, armFileInputClickGuard: original.arm, consumeFileInputClickGuard: original.consume });
  cdpClient.sessions.delete(17);
  api.debugger.sendCommand = () => { throw new Error('debugger recorder not installed'); };
  api.tabs.sendMessage = async () => ({});
}

function chromeAgent() {
  const agent = new ChromeAgent({ getActive: () => ({ model: 'boundary-test' }) });
  agent._currentUrl = async () => 'https://boundary.test/start';
  agent._clickProgressSnapshot = async () => '';
  agent._annotateClickProgress = async (_t, _n, _a, response) => response;
  agent._recordInteractionRect = () => {};
  agent._isPdfTab = async () => false;
  agent._getDevDocumentIdentity = async () => ({ documentId: 'boundary-document', pageUrl: 'https://boundary.test/start' });
  return agent;
}

function chromeContent(extra = {}) {
  const messages = [];
  api.tabs.sendMessage = async (_tab, message) => {
    messages.push(message.action);
    if (message.action === 'ax_resolve_rect') {
      return { success: true, ref_id: 'ref_1', tag: 'button', name: 'Menu', x: 60, y: 40, inViewport: true, rect: { x: 20, y: 20, w: 80, h: 40 } };
    }
    if (message.action === 'ax_resolve_two_rects') {
      return { success: true, from: { ref_id: 'ref_1', x: 60, y: 40, inViewport: true, name: 'Card A' },
        to: { ref_id: 'ref_2', x: 60, y: 240, inViewport: true, name: 'Lane B' } };
    }
    if (message.action === 'set_checked') return extra.setChecked?.(message.params) ?? { success: true };
    return { success: true };
  };
  return messages;
}

const presses = delivered => delivered.filter(event => event.type === 'mousePressed');
const run = (agent, name, args) => {
  const state = { started: false };
  return agent.executeTool(17, name, args, null, { _contentActionDispatchState: state }).then(result => ({ result, state }));
};

function assertNotDispatched({ result, state }, label) {
  assert.equal(result.success, false, `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.dispatched, false, `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.noDispatch, true, label);
  assert.notEqual(result.outcomeUnknown, true, label);
  assert.equal(state.started, false, `${label}: the call never entered dispatch`);
}

function assertUncertain({ result, state }, label) {
  assert.equal(result.success, false, `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.dispatched, true, `${label}: ${JSON.stringify(result)}`);
  assert.notEqual(result.noDispatch, true, label);
  assert.equal(result.outcomeUnknown, true, label);
  assert.equal(result.retryable, false, label);
  assert.equal(state.started, true, label);
}

test('Chrome hover: dispatch starts at the first pointer move\'s transport boundary', async t => {
  await t.test('a fence veto before the first move is not dispatched', async () => {
    const delivered = chromeTransport({ refuse: () => pageFeedbackVeto });
    chromeContent();
    try {
      const outcome = await run(chromeAgent(), 'hover', { ref_id: 'ref_1' });
      assertNotDispatched(outcome, 'hover fence veto');
      assert.equal(outcome.result.pageFeedbackPending, true);
      assert.deepEqual(delivered, [], 'no pointer input reached the page');
    } finally { restoreChrome(); }
  });

  await t.test('a transport refusal before the protocol call is not dispatched', async () => {
    const delivered = chromeTransport({ refuse: () => notAttached });
    chromeContent();
    try {
      assertNotDispatched(await run(chromeAgent(), 'hover', { ref_id: 'ref_1' }), 'hover transport refusal');
      assert.deepEqual(delivered, []);
    } finally { restoreChrome(); }
  });

  await t.test('a lost acknowledgement after the first move is dispatched with an unknown outcome and not resent', async () => {
    const delivered = chromeTransport({ lose: (_params, index) => index === 1 });
    chromeContent();
    try {
      assertUncertain(await run(chromeAgent(), 'hover', { ref_id: 'ref_1' }), 'hover lost acknowledgement');
      assert.deepEqual(delivered.map(event => event.type), ['mouseMoved', 'mouseMoved'], 'each move was sent once');
    } finally { restoreChrome(); }
  });

  await t.test('a refusal of the second move after the first was sent stays uncertain', async () => {
    const delivered = chromeTransport({ refuse: (_params, index) => index === 1 ? pageFeedbackVeto : null });
    chromeContent();
    try {
      const outcome = await run(chromeAgent(), 'hover', { ref_id: 'ref_1' });
      assertUncertain(outcome, 'hover second-move veto');
      assert.deepEqual(delivered.map(event => event.type), ['mouseMoved']);
    } finally { restoreChrome(); }
  });

  await t.test('a normal hover sends two moves once and is dispatched', async () => {
    const delivered = chromeTransport();
    chromeContent();
    try {
      const { result, state } = await run(chromeAgent(), 'hover', { ref_id: 'ref_1' });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(state.started, true);
      assert.deepEqual(delivered.map(event => [event.type, event.x, event.y]), [['mouseMoved', 50, 40], ['mouseMoved', 60, 40]]);
    } finally { restoreChrome(); }
  });
});

test('Chrome drag_drop: dispatch starts when the press passes its fences', async t => {
  for (const [label, refuse] of [
    ['a fence veto on the pointer move before the press', (_params, index) => index === 0 ? pageFeedbackVeto : null],
    ['a fence veto on the press', params => params.type === 'mousePressed' ? pageFeedbackVeto : null],
  ]) await t.test(`${label} is not dispatched`, async () => {
    const delivered = chromeTransport({ refuse });
    chromeContent();
    try {
      const outcome = await run(chromeAgent(), 'drag_drop', { fromRefId: 'ref_1', toRefId: 'ref_2', steps: 3 });
      assertNotDispatched(outcome, label);
      assert.equal(outcome.result.pageFeedbackPending, true);
      assert.equal(presses(delivered).length, 0, 'no press reached the page');
    } finally { restoreChrome(); }
  });

  await t.test('a transport refusal before the press protocol call is not dispatched', async () => {
    const delivered = chromeTransport({ refuse: params => params.type === 'mousePressed' ? notAttached : null });
    chromeContent();
    try {
      assertNotDispatched(await run(chromeAgent(), 'drag_drop', { fromRefId: 'ref_1', toRefId: 'ref_2', steps: 3 }), 'drag transport refusal');
      assert.equal(presses(delivered).length, 0);
    } finally { restoreChrome(); }
  });

  for (const [label, lose] of [
    ['a lost press acknowledgement', params => params.type === 'mousePressed'],
    ['a lost waypoint acknowledgement after the press', params => params.type === 'mouseMoved' && params.buttons === 1 && params.x >= 0],
  ]) await t.test(`${label} is dispatched with an unknown outcome, released, and never resent`, async () => {
    const delivered = chromeTransport({ lose });
    chromeContent();
    try {
      assertUncertain(await run(chromeAgent(), 'drag_drop', { fromRefId: 'ref_1', toRefId: 'ref_2', steps: 3 }), label);
      assert.equal(presses(delivered).length, 1, 'exactly one press');
      assert.equal(delivered.at(-1).type, 'mouseReleased', 'the possibly held button was released');
      assert.equal(delivered.filter(event => event.type === 'mouseMoved' && event.buttons === 1 && event.x >= 0).length,
        label.includes('waypoint') ? 1 : 0, 'no waypoint was resent');
    } finally { restoreChrome(); }
  });

  await t.test('a normal drag presses once and is dispatched', async () => {
    const delivered = chromeTransport();
    chromeContent();
    try {
      const { result, state } = await run(chromeAgent(), 'drag_drop', { fromRefId: 'ref_1', toRefId: 'ref_2', steps: 3 });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(state.started, true);
      assert.deepEqual(delivered.map(event => event.type),
        ['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseReleased']);
    } finally { restoreChrome(); }
  });
});

test('Chrome set_checked: the trusted click is dispatched at its press transport boundary', async t => {
  const checkbox = { setChecked: params => params.cleanupMarker
    ? { success: true, method: 'set_checked', tag: 'input', type: 'checkbox', checkboxIdentity: 'id:agree', checkedBefore: false, checkedAfter: false }
    : { success: true, dispatched: false, noDispatch: true, needsTrustedClick: true, marker: 'boundary-marker',
      trustedSelector: '[data-webbrain-set-checked-target="boundary-marker"]', method: 'set_checked', tag: 'input', type: 'checkbox',
      checkboxIdentity: 'id:agree', checkedBefore: false, checkedAfter: false, desiredChecked: true, rect: { x: 20, y: 20, w: 16, h: 16 } } };
  const resolveCheckbox = () => {
    cdpClient.resolveSelector = async () => ({ inViewport: true, hitOk: true, x: 28, y: 28, width: 16, height: 16, tag: 'INPUT', text: '' });
  };

  for (const [label, refuse] of [
    ['a fence veto on the press', params => params.type === 'mousePressed' ? pageFeedbackVeto : null],
    ['a transport refusal before the press protocol call', params => params.type === 'mousePressed' ? notAttached : null],
  ]) await t.test(`${label} is not dispatched`, async () => {
    const delivered = chromeTransport({ refuse });
    const messages = chromeContent(checkbox);
    resolveCheckbox();
    try {
      const outcome = await run(chromeAgent(), 'set_checked', { ref_id: 'ref_3', checked: true });
      assertNotDispatched(outcome, label);
      assert.equal(presses(delivered).length, 0, 'no press reached the page');
      assert.deepEqual(messages, ['set_checked', 'set_checked'], 'probe and read-only verification only');
    } finally { restoreChrome(); }
  });

  await t.test('a lost release acknowledgement after the press is dispatched with an unknown outcome and never resent', async () => {
    const delivered = chromeTransport({ lose: params => params.type === 'mouseReleased' && params.x >= 0 });
    chromeContent(checkbox);
    resolveCheckbox();
    try {
      assertUncertain(await run(chromeAgent(), 'set_checked', { ref_id: 'ref_3', checked: true }), 'set_checked lost release');
      assert.equal(presses(delivered).length, 1, 'exactly one trusted press, no fallback click');
    } finally { restoreChrome(); }
  });
});

// ── Firefox ────────────────────────────────────────────────────────────────
function firefoxAgent() {
  const agent = new FirefoxAgent({ getActive: () => ({ model: 'boundary-test' }) });
  agent._runningTabs.add(17);
  agent._currentUrl = async () => 'https://boundary.test/start';
  agent._isPdfTab = async () => false;
  agent._injectCoreContentScripts = async () => {};
  return agent;
}

// `monitor(action, params)` answers page-monitor fences; `content(message)`
// answers content messages (or throws a browser messaging error).
function firefoxMessaging({ monitor = () => ({ ready: true }), content = () => ({ success: true }) } = {}) {
  const contentMessages = [];
  api.tabs.sendMessage = async (_tab, message) => {
    if (message.action?.startsWith('page_monitor_')) return monitor(message.action, message.params || {});
    contentMessages.push({ action: message.action, prepare: !!message.params?._bidiPrepare });
    return content(message);
  };
  return contentMessages;
}

function bidiRun({ request } = {}) {
  const requests = [];
  firefoxBidi.runs.set(17, { runId: 'boundary-run', bound: true });
  firefoxBidi.request = async (command, args) => { requests.push({ command, action: args.action }); return request?.(command, args) ?? { success: true, dispatched: true, method: 'firefox-bidi' }; };
  return requests;
}

function restoreFirefox() {
  firefoxBidi.runs.delete(17);
  delete firefoxBidi.request;
  api.tabs.sendMessage = async () => ({});
}

const bidiPrepared = message => message.params?._bidiPrepare
  ? { bidiPrepared: true, success: false, dispatched: false, noDispatch: true, url: 'https://boundary.test/start', rect: { x: 20, y: 20, w: 80, h: 40 } }
  : { success: true, method: 'synthetic-hover' };

async function withFeedbackRun(agent, body) {
  await agent._beginPageFeedbackRun(17, 'interactive');
  try { return await body(); } finally { agent._finishPageFeedbackRun(17); }
}

test('Firefox hover through BiDi: dispatch starts when the native request is posted', async t => {
  await t.test('a fence veto at the native request is not dispatched', async () => {
    let prepared = false;
    const contentMessages = firefoxMessaging({ content: bidiPrepared, monitor: (action, params) => {
      if (action === 'page_monitor_prepare' && params.fenceOnly) { prepared = true; return { ready: true, modelBindingValid: true }; }
      // The native request's own fence (after its preparation probe) refuses.
      return action === 'page_monitor_dispatch' && prepared
        ? { ready: false, pageFeedbackPending: true, preparationVeto: { predicate: 'geometry_changed' } } : { ready: true };
    } });
    const requests = bidiRun();
    const agent = firefoxAgent();
    try {
      const outcome = await withFeedbackRun(agent, () => run(agent, 'hover', { ref_id: 'ref_1' }));
      assertNotDispatched(outcome, 'BiDi hover fence veto');
      assert.equal(outcome.result.pageFeedbackPending, true);
      assert.deepEqual(requests, [], 'no native input request was posted');
      assert.deepEqual(contentMessages, [{ action: 'hover', prepare: true }], 'only the read-only preparation probe');
    } finally { restoreFirefox(); }
  });

  await t.test('a native port that cannot accept the request is not dispatched', async () => {
    firefoxMessaging({ content: bidiPrepared });
    firefoxBidi.runs.set(17, { runId: 'boundary-run', bound: true });
    const previous = firefoxBidi.apiOverride;
    firefoxBidi.apiOverride = { ...api, runtime: { connectNative: () => ({
      onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {},
      postMessage() { throw new Error('Attempt to postMessage on disconnected port'); },
    }) } };
    try {
      assertNotDispatched(await run(firefoxAgent(), 'hover', { ref_id: 'ref_1' }), 'BiDi hover port refusal');
    } finally { firefoxBidi.apiOverride = previous; firefoxBidi.port = null; restoreFirefox(); }
  });

  await t.test('a companion refusal before any input is not dispatched', async () => {
    firefoxMessaging({ content: bidiPrepared });
    bidiRun({ request: () => { throw Object.assign(new Error('Page changed during native preparation; no further input sent'), {
      code: 'page_feedback_pending', dispatchState: { dispatched: false, noDispatch: true, outcomeUnknown: false, retryable: true } }); } });
    try {
      const outcome = await run(firefoxAgent(), 'hover', { ref_id: 'ref_1' });
      assertNotDispatched(outcome, 'BiDi hover companion refusal');
      assert.equal(outcome.result.pageFeedbackPending, true);
    } finally { restoreFirefox(); }
  });

  await t.test('a lost native reply after the request was posted is dispatched with an unknown outcome and never resent', async () => {
    const contentMessages = firefoxMessaging({ content: bidiPrepared });
    const requests = bidiRun({ request: () => { throw new Error('Firefox companion disconnected; do not retry an uncertain action'); } });
    try {
      assertUncertain(await run(firefoxAgent(), 'hover', { ref_id: 'ref_1' }), 'BiDi hover lost reply');
      assert.deepEqual(requests.map(request => request.action), ['hover'], 'one native request');
      assert.equal(contentMessages.filter(message => !message.prepare).length, 0, 'no synthetic content-script fallback');
    } finally { restoreFirefox(); }
  });

  await t.test('a delivered native hover is dispatched', async () => {
    firefoxMessaging({ content: bidiPrepared });
    const requests = bidiRun();
    try {
      const { result, state } = await run(firefoxAgent(), 'hover', { ref_id: 'ref_1' });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(state.started, true);
      assert.equal(requests.length, 1);
    } finally { restoreFirefox(); }
  });
});

test('Firefox content-script hover, drag_drop and set_checked: dispatch starts at the content message', async t => {
  const lostResponse = "Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved";
  const missingReceiver = 'Could not establish connection. Receiving end does not exist.';
  for (const [name, args] of [
    ['hover', { ref_id: 'ref_1' }],
    ['drag_drop', { fromRefId: 'ref_1', toRefId: 'ref_2' }],
    ['set_checked', { ref_id: 'ref_3', checked: true }],
  ]) {
    await t.test(`${name}: a fence veto before the content message is not dispatched`, async () => {
      const contentMessages = firefoxMessaging({ monitor: action => action === 'page_monitor_dispatch'
        ? { ready: false, pageFeedbackPending: true, preparationVeto: { predicate: 'pending_feedback' } } : { ready: true } });
      const agent = firefoxAgent();
      try {
        const outcome = await withFeedbackRun(agent, () => run(agent, name, args));
        assertNotDispatched(outcome, `${name} fence veto`);
        assert.deepEqual(contentMessages, [], 'no content message was sent');
      } finally { restoreFirefox(); }
    });

    await t.test(`${name}: a content-side fence veto is not dispatched`, async () => {
      firefoxMessaging({ content: () => ({ success: false, dispatched: false, noDispatch: true, pageFeedbackPending: true,
        error: `${name} failed: Browser changed during action preparation. Re-observe before acting.` }) });
      try {
        assertNotDispatched(await run(firefoxAgent(), name, args), `${name} content veto`);
      } finally { restoreFirefox(); }
    });

    await t.test(`${name}: a missing receiver is not dispatched`, async () => {
      const contentMessages = firefoxMessaging({ content: () => { throw new Error(missingReceiver); } });
      try {
        assertNotDispatched(await run(firefoxAgent(), name, args), `${name} missing receiver`);
        assert.equal(contentMessages.length, 2, 'one reinjected attempt; nothing was delivered');
      } finally { restoreFirefox(); }
    });

    await t.test(`${name}: a lost content response is dispatched with an unknown outcome and never resent`, async () => {
      const contentMessages = firefoxMessaging({ content: () => { throw new Error(lostResponse); } });
      try {
        assertUncertain(await run(firefoxAgent(), name, args), `${name} lost response`);
        assert.equal(contentMessages.length, 1, 'the content action was sent once');
      } finally { restoreFirefox(); }
    });
  }
});
