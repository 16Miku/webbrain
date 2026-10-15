import test from 'node:test';
import assert from 'node:assert/strict';
import { CDPClient } from '../src/chrome/src/cdp/cdp-client.js';

function harness() {
  const calls = [];
  const client = new CDPClient();
  client.sessions.set(7, { tabId: 7 });
  client.attach = async id => client.sessions.set(id, { tabId: id });
  client.sendCommand = async (...args) => { calls.push(args); };
  return { client, calls };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('unmatched dialogs are dismissed, including child sessions and supplied prompt defaults', async () => {
  const { client, calls } = harness();
  const handled = [];
  await client.startDialogHandling(7, { onHandled: type => handled.push(type) });
  assert.equal(calls[0][1], 'Page.enable');
  for (const type of ['alert', 'confirm', 'beforeunload', 'prompt']) {
    client._onDebuggerEvent({ tabId: 7, sessionId: 'child' }, 'Page.javascriptDialogOpening', {
      type, defaultPrompt: 'existing answer', message: 'untrusted instructions',
    });
  }
  await tick();
  assert.deepEqual(handled, ['alert', 'confirm', 'beforeunload', 'prompt']);
  assert.deepEqual(calls.slice(1), ['alert', 'confirm', 'beforeunload', 'prompt'].map(type => [
    7, 'Page.handleJavaScriptDialog',
    { accept: type === 'alert' }, 'child',
  ]));
});

test('inactive tabs, stop, abort, and cleanup never auto-answer dialogs', async () => {
  const { client, calls } = harness();
  const emit = id => client._onDebuggerEvent({ tabId: id }, 'Page.javascriptDialogOpening', { type: 'confirm' });
  emit(7);
  client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogClosed', {});
  const controller = new AbortController();
  await client.startDialogHandling(7, { signal: controller.signal });
  emit(8);
  controller.abort();
  emit(7);
  client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogClosed', {});
  await client.startDialogHandling(7);
  client.stopDialogHandling(7);
  emit(7);
  client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogClosed', {});
  await client.startDialogHandling(7);
  client.devDiagnostics.set(7, {}); // debugger survives the run
  client.disableWebMCP = async () => {};
  await client.cleanupRun(7);
  emit(7);
  client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogClosed', {});
  await tick();
  assert.ok(calls.every(call => call[1] === 'Page.enable'));
});

test('failed startup and already-aborted runs arm nothing; a failed start keeps only the run\'s wish until it stops', async () => {
  const { client } = harness();
  await client.startDialogHandling(7, { signal: AbortSignal.abort() });
  assert.equal(client.dialogRuns.size, 0);
  assert.equal(client.dialogIntents.size, 0, 'An aborted run has no wish to answer dialogs');
  client.sendCommand = async () => { throw new Error('detached'); };
  await assert.rejects(client.startDialogHandling(7));
  assert.equal(client.dialogRuns.size, 0, 'Nothing answers dialogs after a failed start');
  assert.equal(client.dialogIntents.has(7), true, 'The run may arm on a later connection');
  client.stopDialogHandling(7);
  assert.equal(client.dialogIntents.size, 0);
});

test('dialog races consume protocol failures without retrying the next dialog', async () => {
  const { client, calls } = harness();
  await client.startDialogHandling(7);
  client.sendCommand = async (...args) => { calls.push(args); throw new Error('No dialog'); };
  client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogOpening', { type: 'alert' });
  await tick();
  assert.equal(calls.length, 2);
});

test('a new action run resumes an already-observed dialog exactly once', async () => {
  const { client, calls } = harness();
  client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogOpening', { type: 'beforeunload' });
  assert.equal(calls.length, 0);
  await client.startDialogHandling(7);
  await client.startDialogHandling(7);
  assert.deepEqual(calls.filter(call => call[1] === 'Page.handleJavaScriptDialog').map(call => call[2]), [{ accept: false }]);
  client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogClosed', {});
  assert.equal(client.pendingDialogs.size, 0);
});

test('cached dialog is answered before renderer-dependent Page.enable', async () => {
  const { client } = harness();
  client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogOpening', { type: 'alert' });
  let answered = false;
  client.sendCommand = async (_tabId, method) => {
    if (method === 'Page.handleJavaScriptDialog') answered = true;
    if (method === 'Page.enable') assert.equal(answered, true);
  };
  await client.startDialogHandling(7);
});

for (const target of ['attach', 'Page.enable']) {
  for (const action of ['abort', 'stop', 'timeout']) {
    test(`${action} releases blocked ${target} startup`, async () => {
      const { client } = harness();
      const controller = new AbortController();
      let entered;
      const ready = new Promise(resolve => { entered = resolve; });
      let finish;
      const block = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
      if (target === 'attach') client.attach = block;
      else client.sendCommand = block;
      const startup = client.startDialogHandling(7, { signal: controller.signal, timeoutMs: 20 });
      const rejected = assert.rejects(startup, error => action === 'timeout'
        ? error.code === 'dialog_startup_timeout' : error.name === 'AbortError');
      await ready;
      if (action === 'abort') controller.abort();
      if (action === 'stop') client.stopDialogHandling(7);
      await rejected;
      assert.equal(client.dialogRuns.has(7), false);
      finish();
      await tick();
      assert.equal(client.dialogRuns.has(7), false);
    });
  }
}

test('failed workflow setup releases its debugger but preserves a Dev owner', async () => {
  const previousChrome = globalThis.chrome;
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  let detaches = 0;
  globalThis.chrome = {
    storage: { local: area, session: area },
    runtime: { getURL: value => value },
    tabs: { get: async id => ({ id, url: 'https://example.com/' }) },
    debugger: { detach: (_target, callback) => { detaches++; callback(); } },
  };
  const { Agent } = await import('../src/chrome/src/agent/agent.js');
  const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
  const originalAttach = cdpClient.attach;
  const originalSend = cdpClient.sendCommand;
  try {
    cdpClient.attach = async id => cdpClient.sessions.set(id, { tabId: id });
    cdpClient.sendCommand = async () => ({});
    for (const preserveDev of [false, true]) {
      const tabId = preserveDev ? 92 : 91;
      const agent = new Agent({ getActive: () => ({ promptTier: 'full' }) });
      agent._hydrate = async () => {};
      agent._currentUrl = async () => { throw new Error('workflow setup failure'); };
      if (preserveDev) cdpClient.devDiagnostics.set(tabId, {});
      await assert.rejects(agent.replaySavedWorkflow(tabId, { id: 'test', steps: [{}] }), /workflow setup failure/);
      assert.equal(agent.isRunning(tabId), false);
      assert.equal(cdpClient.dialogRuns.has(tabId), false);
      assert.equal(cdpClient.sessions.has(tabId), preserveDev);
      assert.equal(cdpClient.devDiagnostics.has(tabId), preserveDev);
      cdpClient.devDiagnostics.delete(tabId);
      cdpClient.sessions.delete(tabId);
    }
    assert.equal(detaches, 1);
    for (const streaming of [false, true]) {
      const tabId = streaming ? 94 : 93;
      const agent = new Agent({ getActive: () => ({ promptTier: 'full' }) });
      agent._hydrate = async () => {};
      agent._persistNow = async () => ({});
      agent._beginReadCompleteness = async () => '';
      let entered;
      const ready = new Promise(resolve => { entered = resolve; });
      cdpClient.sendCommand = async (_id, method) => {
        if (method === 'Page.enable') { entered(); return new Promise(() => {}); }
        return {};
      };
      const run = streaming
        ? agent.processMessageStream(tabId, 'Continue', () => {}, 'act')
        : agent.processMessage(tabId, 'Continue', () => {}, 'act');
      await ready;
      agent.abort(tabId);
      assert.match(await run, /Stopped by user/);
      assert.equal(agent.isRunning(tabId), false);
      assert.equal(cdpClient.sessions.has(tabId), false);
      assert.equal(cdpClient.dialogRuns.has(tabId), false);
    }

  } finally {
    cdpClient.attach = originalAttach;
    cdpClient.sendCommand = originalSend;
    globalThis.chrome = previousChrome;
  }
});

test('only a current matching navigation can accept Leave once', async () => {
  const { client, calls } = harness();
  await client.startDialogHandling(7);
  const emit = (type, url = 'https://example.com/') => {
    client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogOpening', { type, url });
    client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogClosed', {});
  };
  const release = client.authorizeNavigationDialog(7, 'https://example.com/');
  emit('confirm');
  emit('prompt');
  emit('beforeunload', 'https://other.example/');
  emit('beforeunload');
  emit('beforeunload');
  release();
  assert.deepEqual(calls.filter(call => call[1] === 'Page.handleJavaScriptDialog').map(call => call[2].accept),
    [false, false, false, true, false]);
});

test('cached dialogs and ended navigation cannot inherit authorization', async () => {
  const { client, calls } = harness();
  client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogOpening', { type: 'beforeunload', url: 'https://example.com/' });
  await client.startDialogHandling(7);
  client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogClosed', {});
  const controller = new AbortController();
  client.authorizeNavigationDialog(7, 'https://example.com/', controller.signal);
  controller.abort();
  client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogOpening', { type: 'beforeunload', url: 'https://example.com/' });
  assert.ok(calls.filter(call => call[1] === 'Page.handleJavaScriptDialog').every(call => !call[2].accept));
});

test('cleanupRun and teardown do not re-await timed-out or aborted debugger attachments', async () => {
  const previousChrome = globalThis.chrome;
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  let detaches = 0;
  let attachCallback = null;
  globalThis.chrome = {
    storage: { local: area, session: area },
    runtime: { getURL: value => value },
    tabs: { get: async id => ({ id, url: 'https://example.com/' }) },
    debugger: {
      attach: (_target, _version, callback) => { attachCallback = callback; },
      detach: (_target, callback) => { detaches++; callback?.(); },
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} },
    },
  };
  const { Agent } = await import('../src/chrome/src/agent/agent.js');
  const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');

  try {
    // 1. Direct startDialogHandling timeout on cdpClient
    const startup = cdpClient.startDialogHandling(71, { timeoutMs: 20 });
    await assert.rejects(startup, error => error.code === 'dialog_startup_timeout');

    // cleanupRun and detach must NOT hang awaiting the never-settling attach
    let cleanupCompleted = false;
    const cleanup = cdpClient.cleanupRun(71).then(() => { cleanupCompleted = true; });
    await tick();
    assert.equal(cleanupCompleted, true);
    await cleanup;

    // Late attach callback execution should immediately detach and not add session
    if (attachCallback) {
      attachCallback();
      assert.equal(cdpClient.sessions.has(71), false);
    }

    // 2. Saved workflow replay timeout releases run entry and tab
    const agent = new Agent({ getActive: () => ({ promptTier: 'full' }) });
    agent._hydrate = async () => {};
    const origStart = cdpClient.startDialogHandling.bind(cdpClient);
    cdpClient.startDialogHandling = (tabId, opts = {}) => origStart(tabId, { ...opts, timeoutMs: 20 });
    try {
      const workflowRun = agent.replaySavedWorkflow(72, { id: 'test', steps: [{}] });
      await assert.rejects(workflowRun, error => error.code === 'dialog_startup_timeout');
      assert.equal(agent.isRunning(72), false);
      assert.equal(cdpClient.sessions.has(72), false);
    } finally {
      cdpClient.startDialogHandling = origStart;
    }
  } finally {
    cdpClient.stopDialogHandling(71);
    cdpClient.stopDialogHandling(72);
    globalThis.chrome = previousChrome;
  }
});

test('canceled attachments are evicted immediately and allow fresh retries', async () => {
  const previousChrome = globalThis.chrome;
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  let attachCalls = 0;
  let detachCalls = 0;
  let firstAttachCallback = null;
  let secondAttachCallback = null;
  let detachListener = null;
  globalThis.chrome = {
    storage: { local: area, session: area },
    runtime: { getURL: value => value },
    tabs: { get: async id => ({ id, url: 'https://example.com/' }) },
    debugger: {
      attach: (_target, _version, callback) => {
        attachCalls++;
        if (attachCalls === 1) firstAttachCallback = callback;
        else secondAttachCallback = callback;
      },
      detach: ({ tabId }, callback) => {
        detachCalls++;
        callback?.();
        detachListener?.({ tabId }, 'canceled');
      },
      onEvent: { addListener: () => {} },
      onDetach: { addListener: fn => { detachListener = fn; } },
    },
  };
  const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');

  try {
    // 1. First startDialogHandling times out during attach
    const startup = cdpClient.startDialogHandling(81, { timeoutMs: 20 });
    await assert.rejects(startup, error => error.code === 'dialog_startup_timeout');
    assert.equal(attachCalls, 1);
    assert.equal(cdpClient.attachPromises.has(81), false);

    // 2. Subsequent attach starts a fresh attach attempt instead of returning the hung promise
    const secondAttach = cdpClient.attach(81);
    assert.equal(attachCalls, 2);

    secondAttachCallback?.();
    const session = await secondAttach;
    assert.equal(session.tabId, 81);
    assert.equal(cdpClient.sessions.has(81), true);

    // Late callback from the first attach must not detach or corrupt the active retry session
    firstAttachCallback?.();
    assert.equal(detachCalls, 0);
    assert.equal(cdpClient.sessions.has(81), true);

    await cdpClient.detach(81);
    assert.equal(detachCalls, 1);
    assert.equal(cdpClient.sessions.has(81), false);
  } finally {
    cdpClient.stopDialogHandling(81);
    globalThis.chrome = previousChrome;
  }
});

test('stale attach success detaches from Chrome when retry has failed', async () => {
  const previousChrome = globalThis.chrome;
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  let attachCalls = 0;
  let detachCalls = 0;
  let firstAttachCallback = null;
  globalThis.chrome = {
    storage: { local: area, session: area },
    runtime: { getURL: value => value, lastError: null },
    tabs: { get: async id => ({ id, url: 'https://example.com/' }) },
    debugger: {
      attach: (_target, _version, callback) => {
        attachCalls++;
        if (attachCalls === 1) {
          firstAttachCallback = callback;
        } else {
          globalThis.chrome.runtime.lastError = { message: 'Another debugger is already attached' };
          callback?.();
          globalThis.chrome.runtime.lastError = null;
        }
      },
      detach: (_target, callback) => {
        detachCalls++;
        callback?.();
      },
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} },
    },
  };
  const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');

  try {
    // 1. First startDialogHandling times out during attach
    const startup = cdpClient.startDialogHandling(82, { timeoutMs: 20 });
    await assert.rejects(startup, error => error.code === 'dialog_startup_timeout');
    assert.equal(attachCalls, 1);

    // 2. Retry fails because debugger was attached by the first attempt
    await assert.rejects(cdpClient.attach(82), /Another debugger is already attached/);
    assert.equal(attachCalls, 2);
    assert.equal(cdpClient.sessions.has(82), false);

    // 3. Stale success callback from first attempt arrives; because no newer session exists, it detaches
    assert.equal(detachCalls, 0);
    firstAttachCallback?.();
    assert.equal(detachCalls, 1);
    assert.equal(cdpClient.sessions.has(82), false);
  } finally {
    cdpClient.stopDialogHandling(82);
    globalThis.chrome = previousChrome;
  }
});

test('go_back authorizes beforeunload for the current page and cleans up on completion and failure', async () => {
  const previousChrome = globalThis.chrome;
  const previousBrowser = globalThis.browser;
  delete globalThis.browser;
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  const calls = [];
  const tabId = 42;
  const beforeUrl = 'https://example.com/page2';
  const targetUrl = 'https://example.com/page1';
  const createEvent = () => {
    const listeners = new Set();
    return {
      addListener(fn) { listeners.add(fn); },
      removeListener(fn) { listeners.delete(fn); },
      emit(...args) { for (const fn of [...listeners]) fn(...args); },
      get listenerCount() { return listeners.size; },
    };
  };
  const events = {
    history: createEvent(),
    committed: createEvent(),
    updated: createEvent(),
  };

  const { Agent } = await import('../src/chrome/src/agent/agent.js');
  const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
  const originalAttach = cdpClient.attach;
  const originalSend = cdpClient.sendCommand;

  try {
    cdpClient.attach = async id => cdpClient.sessions.set(id, { tabId: id });
    cdpClient.sendCommand = async (...args) => { calls.push(args); };

    let currentUrl = beforeUrl;
    let failInjection = false;
    globalThis.chrome = {
      storage: { local: area, session: area },
      runtime: { getURL: value => value },
      tabs: {
        get: async id => ({ id, url: currentUrl, status: 'complete' }),
        onUpdated: events.updated,
      },
      webNavigation: {
        onHistoryStateUpdated: events.history,
        onCommitted: events.committed,
      },
      scripting: {
        executeScript: async () => {
          if (failInjection) throw new Error('injection failed');
          cdpClient._onDebuggerEvent({ tabId }, 'Page.javascriptDialogOpening', {
            type: 'beforeunload',
            url: beforeUrl,
          });
          cdpClient._onDebuggerEvent({ tabId }, 'Page.javascriptDialogClosed', {});
          currentUrl = targetUrl;
          events.committed.emit({
            tabId,
            frameId: 0,
            url: targetUrl,
            transitionQualifiers: ['forward_back'],
          });
          return [{ result: { before: beforeUrl } }];
        },
      },
    };

    await cdpClient.startDialogHandling(tabId);
    const agent = new Agent({ getActive: () => ({ promptTier: 'full' }) });

    // 1. Successful go_back: authorizes beforeunload dialog and accepts Leave
    const result = await agent.executeTool(tabId, 'go_back', { force: true });
    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(result.url, targetUrl);
    const dialogCalls = calls.filter(c => c[1] === 'Page.handleJavaScriptDialog');
    assert.equal(dialogCalls.length, 1);
    assert.deepEqual(dialogCalls[0][2], { accept: true });
    assert.equal(cdpClient.dialogRuns.get(tabId)?.navigation, undefined);
    assert.equal(events.committed.listenerCount, 0);

    // 2. Failed injection: cleans up the authorization permit
    failInjection = true;
    const failedResult = await agent.executeTool(tabId, 'go_back', { force: true });
    assert.equal(failedResult.success, false);
    assert.equal(cdpClient.dialogRuns.get(tabId)?.navigation, undefined);
    assert.equal(events.committed.listenerCount, 0);

    cdpClient.stopDialogHandling(tabId);
  } finally {
    cdpClient.stopDialogHandling(tabId);
    cdpClient.attach = originalAttach;
    cdpClient.sendCommand = originalSend;
    globalThis.chrome = previousChrome;
    if (previousBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = previousBrowser;
  }
});

// Your trace: a run that started on chrome://extensions, where the debugger
// cannot attach, left every later "Leave site?" prompt for the person to
// answer, the first one for 70 seconds. The run's dialog handling is armed
// again once it can be: before and after its own navigations, and at any
// later debugger attach.
function navigationFixture(tabId, startUrl) {
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  const event = () => {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
      emit: (...args) => [...listeners].forEach(fn => fn(...args)) };
  };
  const events = { committed: event(), errors: event(), updated: event() };
  const state = { url: startUrl, leavePrompt: false, calls: [], events };
  state.answers = () => state.calls.filter(call => call[1] === 'Page.handleJavaScriptDialog').map(call => call[2]);
  state.chrome = {
    storage: { local: area, session: area }, runtime: { getURL: value => value },
    tabs: {
      get: async id => ({ id, url: state.url, status: 'complete' }),
      onUpdated: events.updated,
      // A page with an unsent draft asks before it is left. The browser
      // leaves only once the prompt is answered with Leave.
      update: async (_id, { url }) => {
        if (state.leavePrompt) {
          const before = state.answers().length;
          state.client._onDebuggerEvent({ tabId }, 'Page.javascriptDialogOpening', { type: 'beforeunload', url: state.url });
          await new Promise(resolve => setTimeout(resolve, 0));
          const answer = state.answers()[before];
          // An unanswered prompt waits for the person; here it is closed
          // unanswered, so the page stays.
          state.client._onDebuggerEvent({ tabId }, 'Page.javascriptDialogClosed', {});
          if (!answer?.accept) return {};
        }
        state.url = url;
        events.committed.emit({ tabId, frameId: 0, url });
        return {};
      },
    },
    webNavigation: { onCommitted: events.committed, onErrorOccurred: events.errors, onHistoryStateUpdated: event() },
    scripting: { executeScript: async () => [{ result: { attachedFiles: 0, dirtyFields: 0 } }] },
  };
  return state;
}

async function withNavigationFixture(tabId, startUrl, body) {
  const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
  delete globalThis.browser;
  const state = navigationFixture(tabId, startUrl);
  globalThis.chrome = state.chrome;
  const { Agent } = await import('../src/chrome/src/agent/agent.js');
  const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
  state.client = cdpClient;
  const originalAttach = cdpClient.attach, originalSend = cdpClient.sendCommand;
  try {
    // The debugger cannot attach to chrome:// pages.
    cdpClient.attach = async id => {
      if (/^chrome:/.test(state.url)) throw new Error('Cannot access a chrome:// URL');
      cdpClient.sessions.set(id, { tabId: id });
      return cdpClient.sessions.get(id);
    };
    cdpClient.sendCommand = async (...args) => { state.calls.push(args); return {}; };
    await body({ state, cdpClient, agent: new Agent({ getActive: () => ({ promptTier: 'full' }) }) });
  } finally {
    cdpClient.stopDialogHandling(tabId);
    cdpClient.sessions.delete(tabId);
    cdpClient.attach = originalAttach;
    cdpClient.sendCommand = originalSend;
    globalThis.chrome = previousChrome;
    if (previousBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = previousBrowser;
  }
}

test('a run that starts where the debugger cannot attach answers its leave prompts once it reaches a page', async () => {
  const tabId = 4301;
  await withNavigationFixture(tabId, 'chrome://extensions/', async ({ state, cdpClient, agent }) => {
    await assert.rejects(cdpClient.startDialogHandling(tabId), /chrome:\/\//);
    assert.equal(cdpClient.dialogRuns.has(tabId), false, 'Nothing is armed on chrome://extensions');
    const arrived = await agent.executeTool(tabId, 'navigate', { url: 'https://mastoturk.org/publish' });
    assert.equal(arrived.success, true, arrived.error);
    assert.equal(cdpClient.dialogRuns.has(tabId), true, 'The first page the debugger can reach arms the run');
    state.leavePrompt = true;
    const left = await agent.executeTool(tabId, 'navigate', { url: 'https://x.com/home' });
    assert.equal(left.success, true, left.error);
    assert.deepEqual(state.answers(), [{ accept: true }], 'WebBrain answered Leave for its own navigation');
    assert.equal(state.url, 'https://x.com/home');
    // Once the run ends, a page's leave prompt is the person's again.
    cdpClient.stopDialogHandling(tabId);
    const after = await agent.executeTool(tabId, 'navigate', { url: 'https://mastoturk.org/home' });
    assert.equal(after.success, false);
    assert.equal(after.confirmationPossible, true);
    assert.deepEqual(state.answers(), [{ accept: true }], 'No answer after the run ended');
  });
});

for (const reason of ['target_closed', 'canceled_by_user']) {
  test(`a debugger connection that drops (${reason}) ${reason === 'canceled_by_user' ? 'stays off once the person cancelled it' : 'is armed again for the next navigation'}`, async () => {
    const tabId = reason === 'target_closed' ? 4302 : 4303;
    await withNavigationFixture(tabId, 'https://x.com/home', async ({ state, cdpClient, agent }) => {
      await cdpClient.startDialogHandling(tabId);
      assert.equal(cdpClient.dialogRuns.has(tabId), true);
      cdpClient._onDebuggerDetach({ tabId }, reason);
      assert.equal(cdpClient.dialogRuns.has(tabId), false);
      state.leavePrompt = true;
      const left = await agent.executeTool(tabId, 'navigate', { url: 'https://mastoturk.org/home' });
      if (reason === 'target_closed') {
        assert.equal(left.success, true, left.error);
        assert.deepEqual(state.answers(), [{ accept: true }]);
      } else {
        assert.equal(left.success, false);
        assert.deepEqual(state.answers(), [], 'The person who cancelled the debugger answers the prompt');
        assert.equal(cdpClient.dialogRuns.has(tabId), false);
      }
    });
  });
}

test('any later debugger attach arms the dialog handling its run could not arm at its start', async () => {
  const previousChrome = globalThis.chrome;
  const sent = [];
  let attaches = 0, eventListener = null;
  globalThis.chrome = {
    runtime: { getURL: value => value, lastError: undefined },
    debugger: {
      attach: (_target, _version, callback) => {
        const attempt = ++attaches;
        setTimeout(() => {
          // The run starts on chrome://extensions; a later page allows it.
          if (attempt === 1) globalThis.chrome.runtime.lastError = { message: 'Cannot access a chrome:// URL' };
          callback();
          globalThis.chrome.runtime.lastError = undefined;
        }, 0);
      },
      detach: (_target, callback) => callback?.(),
      sendCommand: (_target, method, params, callback) => { sent.push([method, params]); callback({}); },
      onEvent: { addListener: fn => { eventListener = fn; }, removeListener: () => {} },
      onDetach: { addListener: () => {}, removeListener: () => {} },
    },
  };
  try {
    const client = new CDPClient();
    await assert.rejects(client.startDialogHandling(51), /chrome:\/\//);
    assert.equal(client.dialogRuns.has(51), false);
    // A page with no run is never armed by an attach.
    await client.attach(52);
    await tick();
    assert.equal(client.dialogRuns.has(52), false);
    // A CDP tool attaches on a page the debugger can reach.
    await client.attach(51);
    await tick();
    assert.equal(client.dialogRuns.has(51), true);
    assert.ok(sent.some(([method]) => method === 'Page.enable'));
    // The page's own question no longer waits for the person; it is refused.
    eventListener({ tabId: 51 }, 'Page.javascriptDialogOpening', { type: 'confirm', url: 'https://mastoturk.org/home' });
    await tick();
    assert.deepEqual(sent.filter(([method]) => method === 'Page.handleJavaScriptDialog').map(([, params]) => params), [{ accept: false }]);
    // Stop ends it: a later attach arms nothing.
    client.stopDialogHandling(51);
    client.sessions.delete(51);
    await client.attach(51);
    await tick();
    assert.equal(client.dialogRuns.has(51), false);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('mid-run arming behind a hung Page.enable gives up quickly and keeps the run\'s wish', async () => {
  const { client, calls } = harness();
  client.sendCommand = async () => { throw new Error('Cannot access a chrome:// URL'); };
  await assert.rejects(client.startDialogHandling(7));
  // Page.enable never answers, as behind an already open prompt.
  client.sendCommand = (...args) => { calls.push(args); return args[1] === 'Page.enable' ? new Promise(() => {}) : Promise.resolve({}); };
  const started = Date.now();
  assert.equal(await client.ensureDialogHandling(7, { timeoutMs: 40 }), false);
  assert.ok(Date.now() - started < 1000);
  assert.equal(client.dialogRuns.has(7), false);
  assert.equal(client.dialogIntents.has(7), true);
  client.sendCommand = async (...args) => { calls.push(args); return {}; };
  assert.equal(await client.ensureDialogHandling(7), true, 'A later navigation arms it');
  client.stopDialogHandling(7);
});

test('after re-arming, a leave prompt WebBrain did not ask for still stays, and only its own navigation leaves', async () => {
  const { client, calls } = harness();
  await client.startDialogHandling(7);
  client._onDebuggerDetach({ tabId: 7 }, 'target_closed');
  assert.equal(await client.ensureDialogHandling(7), true);
  const emit = () => {
    client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogOpening', { type: 'beforeunload', url: 'https://x.com/home' });
    client._onDebuggerEvent({ tabId: 7 }, 'Page.javascriptDialogClosed', {});
  };
  emit();
  const release = client.authorizeNavigationDialog(7, 'https://x.com/home');
  emit();
  release();
  assert.deepEqual(calls.filter(call => call[1] === 'Page.handleJavaScriptDialog').map(call => call[2].accept), [false, true]);
  client.stopDialogHandling(7);
});

test('a connection that drops while a run starts does not stop the run', async () => {
  const { client } = harness();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  client.attach = () => { entered(); return new Promise(() => {}); };
  const startup = client.startDialogHandling(7);
  await ready;
  client._onDebuggerDetach({ tabId: 7 }, 'target_closed');
  await assert.rejects(startup, error => error.name !== 'AbortError' && error.code === 'dialog_connection_dropped');
  assert.equal(client.dialogIntents.has(7), true);
  client.attach = async id => client.sessions.set(id, { tabId: id });
  assert.equal(await client.ensureDialogHandling(7), true);
  // Stop during a start is still a stop.
  client.attach = () => { entered(); return new Promise(() => {}); };
  const stopped = client.startDialogHandling(8);
  client.stopDialogHandling(8);
  await assert.rejects(stopped, error => error.name === 'AbortError');
  client.stopDialogHandling(7);
});

test('an aborted run is not armed again by a later debugger attach', async () => {
  const previousChrome = globalThis.chrome;
  const sent = [];
  let attaches = 0;
  globalThis.chrome = {
    runtime: { getURL: value => value, lastError: undefined },
    debugger: {
      attach: (_target, _version, callback) => {
        const attempt = ++attaches;
        setTimeout(() => {
          if (attempt === 1) globalThis.chrome.runtime.lastError = { message: 'Cannot access a chrome:// URL' };
          callback();
          globalThis.chrome.runtime.lastError = undefined;
        }, 0);
      },
      detach: (_target, callback) => callback?.(),
      sendCommand: (_target, method, params, callback) => { sent.push(method); callback({}); },
      onEvent: { addListener: () => {}, removeListener: () => {} },
      onDetach: { addListener: () => {}, removeListener: () => {} },
    },
  };
  try {
    const client = new CDPClient(), controller = new AbortController();
    await assert.rejects(client.startDialogHandling(61, { signal: controller.signal }), /chrome:\/\//);
    controller.abort();
    assert.equal(client.dialogIntents.has(61), false);
    await client.attach(61);
    await tick();
    assert.equal(client.dialogRuns.has(61), false);
    assert.deepEqual(sent, []);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('history navigation after a dropped connection answers its own leave prompt', async () => {
  const tabId = 4304;
  await withNavigationFixture(tabId, 'https://x.com/compose/post', async ({ state, cdpClient, agent }) => {
    await cdpClient.startDialogHandling(tabId);
    cdpClient._onDebuggerDetach({ tabId }, 'target_closed');
    // history.go runs in the page; the prompt comes from the page being left.
    state.chrome.scripting.executeScript = async ({ func }) => {
      if (String(func).includes('history.go')) {
        const before = state.url;
        const answers = state.answers().length;
        state.client._onDebuggerEvent({ tabId }, 'Page.javascriptDialogOpening', { type: 'beforeunload', url: before });
        await new Promise(resolve => setTimeout(resolve, 0));
        state.client._onDebuggerEvent({ tabId }, 'Page.javascriptDialogClosed', {});
        if (state.answers()[answers]?.accept) {
          state.url = 'https://x.com/home';
          state.events.committed.emit({ tabId, frameId: 0, url: state.url, transitionQualifiers: ['forward_back'] });
        }
        return [{ result: { before } }];
      }
      return [{ result: { attachedFiles: 0, dirtyFields: 0 } }];
    };
    const result = await agent.executeTool(tabId, 'go_back', { force: true });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(state.answers(), [{ accept: true }]);
  });
});
