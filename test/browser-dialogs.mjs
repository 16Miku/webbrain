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

test('failed startup and already-aborted runs do not retain dialog handling', async () => {
  const { client } = harness();
  await client.startDialogHandling(7, { signal: AbortSignal.abort() });
  assert.equal(client.dialogRuns.size, 0);
  client.sendCommand = async () => { throw new Error('detached'); };
  await assert.rejects(client.startDialogHandling(7));
  assert.equal(client.dialogRuns.size, 0);
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
  let firstAttachCallback = null;
  let secondAttachCallback = null;
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
      detach: (_target, callback) => { callback?.(); },
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} },
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

    // Late callback from the first attach must not corrupt the session
    firstAttachCallback?.();
    assert.equal(cdpClient.sessions.has(81), true);

    await cdpClient.detach(81);
  } finally {
    cdpClient.stopDialogHandling(81);
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
