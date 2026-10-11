import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CDPClient } from '../src/chrome/src/cdp/cdp-client.js';

const tab = 17;
const tick = () => new Promise(resolve => setImmediate(resolve));
function nativeDebugger({ owner = null, holdAttach = false, holdProbe = false, probeError = null,
  attachError = null, probeThrows = false, probeResult = { result: { type: 'undefined' } } } = {}) {
  const runtime = {}, events = new Set(), detachEvents = new Set(), calls = [], attachCallbacks = [], probeCallbacks = [];
  const respond = (callback, error, result) => {
    if (error) runtime.lastError = { message: error };
    try { callback(result); } finally { delete runtime.lastError; }
  };
  const api = { runtime, debugger: {
    onEvent: { addListener: fn => events.add(fn), removeListener: fn => events.delete(fn) },
    onDetach: { addListener: fn => detachEvents.add(fn), removeListener: fn => detachEvents.delete(fn) },
    attach(target, version, callback) {
      calls.push({ kind: 'attach', target, version });
      const error = attachError || (owner ? 'Another debugger is already attached to the tab with id: 17.' : null);
      if (!error) owner = 'webbrain';
      const complete = () => respond(callback, error);
      if (holdAttach) attachCallbacks.push(complete); else queueMicrotask(complete);
    },
    sendCommand(target, method, params, callback) {
      calls.push({ kind: 'command', target, method, params });
      if (probeThrows) throw Error('Native command transport failed.');
      const error = owner !== 'webbrain' ? 'Debugger is not attached to this extension.' : probeError;
      const complete = () => respond(callback, error,
      method === 'Runtime.evaluate' ? probeResult : {});
      if (holdProbe && method === 'Runtime.evaluate') probeCallbacks.push(complete); else queueMicrotask(complete);
    },
    detach(target, callback) { calls.push({ kind: 'detach', target }); owner = null; queueMicrotask(callback); },
  } };
  globalThis.chrome = api;
  return { calls, events, detachEvents, releaseAttach: () => attachCallbacks.shift()?.(),
    releaseProbe: () => probeCallbacks.shift()?.(), clearWorkerListeners() { events.clear(); detachEvents.clear(); },
    emitDetach() { owner = null; for (const handler of detachEvents) handler({ tabId: tab }, 'target_closed'); } };
}
const commands = native => native.calls.filter(call => call.kind === 'command');
const detaches = native => native.calls.filter(call => call.kind === 'detach');

test('normal attach caches one session and installs debugger event handlers once', async () => {
  const native = nativeDebugger(), client = new CDPClient();
  const attached = await client.attach(tab);
  assert.equal(await client.attach(tab), attached);
  assert.equal(native.calls.length, 1); assert.equal(native.events.size, 1); assert.equal(native.detachEvents.size, 1);
});

test('fresh worker recovers its existing native connection without detach or another attach', async () => {
  const native = nativeDebugger(), old = new CDPClient();
  await old.attach(tab); native.clearWorkerListeners();
  const current = new CDPClient();
  const session = await current.attach(tab);
  assert.deepEqual(session, { tabId: tab, attached: true });
  assert.equal(native.calls.filter(call => call.kind === 'attach').length, 2);
  assert.deepEqual(commands(native), [{ kind: 'command', target: { tabId: tab }, method: 'Runtime.evaluate',
    params: { expression: 'void 0', returnByValue: true, timeout: 1000 } }]);
  assert.equal(detaches(native).length, 0); assert.equal(native.events.size, 1); assert.equal(native.detachEvents.size, 1);
  assert.equal(current.attachPromises.size, 0);
  await current.sendCommand(tab, 'Page.enable');
  assert.equal(commands(native).at(-1).method, 'Page.enable');
  assert.equal(native.calls.filter(call => call.kind === 'attach').length, 2);
  for (const listener of native.detachEvents) listener({ tabId: tab }, 'target_closed');
  assert.equal(current.sessions.has(tab), false);
});

test('concurrent recovery shares one ownership probe and session', async () => {
  const native = nativeDebugger({ owner: 'webbrain', holdProbe: true }), client = new CDPClient();
  const first = client.attach(tab), second = client.attach(tab);
  await tick(); assert.equal(commands(native).length, 1);
  native.releaseProbe();
  const sessions = await Promise.all([first, second]);
  assert.equal(sessions[0], sessions[1]); assert.equal(client.attachPromises.size, 0);
});

for (const options of [
  { owner: 'another-extension' }, { owner: null, attachError: 'Host access is restricted by policy.' },
  { owner: 'webbrain', probeError: 'Target disappeared.' }, { owner: 'webbrain', probeThrows: true },
  { owner: 'webbrain', probeResult: {} }, { owner: 'webbrain', probeResult: { exceptionDetails: {} } },
]) test(`unverified connection stays blocked: ${JSON.stringify(options)}`, async () => {
  const native = nativeDebugger(options), client = new CDPClient();
  await assert.rejects(client.attach(tab), options.attachError ? /restricted by policy/ : /Another debugger/);
  assert.equal(client.sessions.has(tab), false); assert.equal(client.attachPromises.size, 0);
  assert.equal(detaches(native).length, 0, 'Recovery cannot disconnect another debugger.');
});

for (const interruption of ['cancel-before-probe', 'generation-before-probe', 'cancel-during-probe', 'generation-during-probe']) {
  test(`recovery cannot cache a superseded attachment: ${interruption}`, async () => {
    const beforeProbe = interruption.endsWith('before-probe');
    const native = nativeDebugger({ owner: 'webbrain', holdAttach: beforeProbe, holdProbe: !beforeProbe });
    const client = new CDPClient(), attempt = client.attach(tab);
    const rejected = assert.rejects(attempt, /cancelled/);
    await tick();
    if (interruption.startsWith('cancel')) client.attachPromises.get(tab).cancelled = true;
    else client.attachGenerations.set(tab, client.attachGenerations.get(tab) + 1);
    if (beforeProbe) native.releaseAttach(); else native.releaseProbe();
    await rejected; assert.equal(client.sessions.has(tab), false); assert.equal(detaches(native).length, 0);
    assert.equal(commands(native).length, beforeProbe ? 0 : 1);
  });
}

test('real dialog startup Stop cancels an in-flight ownership probe without adopting or detaching it', async () => {
  const native = nativeDebugger({ owner: 'webbrain', holdProbe: true }), client = new CDPClient();
  const controller = new AbortController();
  const startup = client.startDialogHandling(tab, { signal: controller.signal });
  const rejected = assert.rejects(startup, /Stopped/);
  await tick(); assert.equal(commands(native).length, 1);
  controller.abort(); await rejected; native.releaseProbe(); await tick();
  assert.equal(client.sessions.has(tab), false); assert.equal(client.attachPromises.size, 0);
  assert.equal(client.dialogRuns.has(tab), false); assert.equal(detaches(native).length, 0);
  assert.equal(commands(native).length, 1, 'Stop must prevent Page.enable after late probe completion.');
});

test('an unanswered ownership command is bounded and never adopts the old session', async () => {
  const native = nativeDebugger({ owner: 'webbrain', holdProbe: true }), client = new CDPClient();
  await assert.rejects(client.attach(tab), /Another debugger/);
  assert.equal(client.sessions.has(tab), false); assert.equal(client.attachPromises.size, 0);
  native.releaseProbe(); await tick();
  assert.equal(client.sessions.has(tab), false); assert.equal(detaches(native).length, 0);
});

for (const attachError of ['Host access is restricted by policy.', 'Cannot attach to this target.',
  'Permission denied.', 'Another debugger is already attached to the tab with id: 17.\nHost access is restricted by policy.']) {
  test(`an existing own connection cannot bypass a different native attach failure: ${JSON.stringify(attachError)}`, async () => {
    const native = nativeDebugger({ owner: 'webbrain', attachError }), client = new CDPClient();
    await assert.rejects(client.attach(tab), error => error.message === attachError);
    assert.equal(commands(native).length, 0); assert.equal(client.sessions.has(tab), false); assert.equal(detaches(native).length, 0);
  });
}

test('observed native detach invalidates an already-answered but delayed ownership probe', async () => {
  const native = nativeDebugger({ owner: 'webbrain', holdProbe: true }), client = new CDPClient();
  const attempt = client.attach(tab), rejected = assert.rejects(attempt, /cancelled/);
  await tick(); native.emitDetach(); native.releaseProbe(); await rejected;
  assert.equal(client.sessions.has(tab), false); assert.equal(detaches(native).length, 0);
});

test('late normal attach after known detach cannot disconnect a newer native connection', async () => {
  const native = nativeDebugger({ holdAttach: true }), client = new CDPClient();
  const old = client.attach(tab), rejected = assert.rejects(old, /cancelled/);
  native.emitDetach(); const current = client.attach(tab);
  native.releaseAttach(); await rejected;
  assert.equal(detaches(native).length, 0); assert.equal(client.sessions.has(tab), false);
  native.releaseAttach(); await current;
  assert.equal(client.sessions.has(tab), true); assert.equal(detaches(native).length, 0);
});
