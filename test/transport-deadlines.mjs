import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { CDPClient } from '../src/chrome/src/cdp/cdp-client.js';
import { messageRecipientUploadSourceKey as chromeUploadSourceKey } from '../src/chrome/src/agent/message-recipient-guard.js';
import { messageRecipientUploadSourceKey as firefoxUploadSourceKey } from '../src/firefox/src/agent/message-recipient-guard.js';

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('CDP function results survive an unresponsive remote-object cleanup', async () => {
  const client = new CDPClient();
  const result = { result: { value: { success: false, dispatched: false, deadlineExpired: true } } };
  let releases = 0;
  client.sendCommand = async (_tab, method) => {
    if (method === 'Runtime.evaluate') return { result: { objectId: 'global' } };
    if (method === 'Runtime.callFunctionOn') return result;
    if (method === 'Runtime.releaseObject') { releases++; return new Promise(() => {}); }
    return {};
  };
  let settled;
  client.evaluateFunction(660, 'function () { return false; }').then(value => { settled = value; });
  await nextTurn();
  assert.equal(releases, 1);
  assert.equal(settled, result, 'Cleanup must not hide a known page result or convert it into an unknown action timeout');
});

for (const scenario of ['event listeners', 'field signature', 'local file', 'query error']) {
  test(`CDP ${scenario} result survives unresponsive remote-object cleanup`, async () => {
    const client = new CDPClient();
    const queryError = new Error('Selector failed before cleanup');
    let releases = 0;
    client.sendCommand = async (_tab, method) => {
      if (method === 'Runtime.releaseObject' || method === 'Runtime.releaseObjectGroup') {
        releases++;
        return new Promise(() => {});
      }
      if (method === 'Runtime.evaluate') {
        if (scenario === 'query error') throw queryError;
        return { result: { objectId: 'fixture' } };
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'fixture' } };
      if (method === 'DOMDebugger.getEventListeners') return { listeners: [] };
      if (method === 'Runtime.callFunctionOn') return { result: { value: scenario === 'field signature'
        ? 'stable-signature' : { exists: true, readable: true, size: 1 } } };
      return {};
    };
    let settled;
    const operation = scenario === 'event listeners' ? client.getEventListenersForNode(663, 5)
      : scenario === 'field signature' ? client.textEntrySignature(663, { nodeId: 5 })
      : scenario === 'local file' ? client.probeLocalFile(663, 'C:\\fixture.txt')
      : client.querySelectorPierce(663, '[');
    operation.then(value => { settled = { value }; }, error => { settled = { error }; });
    await nextTurn();
    assert.equal(releases, 1);
    assert.ok(settled, 'Cleanup must not block a known result');
    if (scenario === 'query error') assert.equal(settled.error, queryError);
    else if (scenario === 'event listeners') assert.deepEqual(settled.value, []);
    else if (scenario === 'field signature') assert.equal(settled.value, 'stable-signature');
    else assert.deepEqual(settled.value, { exists: true, readable: true, size: 1 });
  });
}

for (const browser of ['chrome', 'firefox']) {
  const source = fs.readFileSync(new URL(`../src/${browser}/src/content/content.js`, import.meta.url), 'utf8');
  const start = source.indexOf('function pressKeys(');
  const end = source.indexOf('\n  /**', start);
  assert.ok(start >= 0 && end > start);
  function press({ expireAtGuard = false, expireAtKeydown = false, repeat = 1 } = {}) {
    let expired = false;
    const events = [];
    const target = { tagName: 'TEXTAREA', dispatchEvent(event) {
      events.push(event.type);
      if (event.type === 'keydown' && expireAtKeydown) expired = true;
      return true;
    } };
    const context = vm.createContext({
      document: { body: {}, documentElement: {}, activeElement: target },
      KeyboardEvent: class { constructor(type, args) { Object.assign(this, args, { type }); } },
      _deepActiveElement: () => target,
      withLocalPageDispatch: callback => { if (expireAtGuard) expired = true; return callback(); },
    });
    const operation = vm.runInContext(`(${source.slice(start, end)})`, context);
    return { result: operation({ key: 'Enter', repeat }, () => expired), events };
  }

  test(`${browser}: a monitor consuming the key deadline prevents keydown`, () => {
    const { result, events } = press({ expireAtGuard: true });
    assert.equal(result.deadlineExpired, true);
    assert.equal(result.dispatched, false);
    assert.equal(result.noDispatch, true);
    assert.deepEqual(events, []);
  });
  test(`${browser}: a keydown crossing the deadline still releases keyup and stops repeats`, () => {
    const { result, events } = press({ expireAtKeydown: true, repeat: 3 });
    assert.equal(result.deadlineExpired, true);
    assert.equal(result.dispatched, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.retryable, false);
    assert.deepEqual(events, ['keydown', 'keyup']);
  });
  test(`${browser}: timely synthetic keys retain their requested repeat count`, () => {
    const { result, events } = press({ repeat: 2 });
    assert.equal(result.success, true);
    assert.deepEqual(events, ['keydown', 'keyup', 'keydown', 'keyup']);
  });
}

async function memoryUpload(options = {}) {
  const client = new CDPClient();
  let declaration;
  client.sendCommand = async (_tab, method, params) => {
    if (method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('function (base64')) declaration = params.functionDeclaration;
    return { result: { value: { success: true, dispatched: true, connected: true, fileInput: true, accept: '' } } };
  };
  await client.setFileInputData(661, 'input', { base64: 'YQ==', filename: 'fixture.txt', mimeType: 'text/plain' });
  let now = 0;
  const events = [];
  class Input {
    type = 'file';
    files = [];
    isConnected = true;
    getAttribute() { return ''; }
    dispatchEvent(event) {
      events.push(event.type);
      if (event.type === 'webbrain-agent-dom-dispatch' && options.expireAtGuard) now = 11;
      if (event.type === 'input' && options.expireAtInput) now = 11;
      return true;
    }
  }
  const input = new Input();
  const context = vm.createContext({
    HTMLInputElement: Input, Uint8Array, atob,
    Date: { now: () => now },
    File: class { constructor(_bytes, name, metadata) { this.name = name; this.size = 1; this.type = metadata.type; } },
    DataTransfer: class { files = []; items = { add: file => this.files.push(file) }; },
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type) { this.type = type; } },
    window: input,
  });
  const operation = vm.runInContext(`(${declaration})`, context);
  const result = operation.call(input, 'YQ==', 'fixture.txt', 'text/plain', 10, '', { operationId: 'guarded' });
  return { result, events: events.filter(event => event !== 'webbrain-agent-dom-dispatch'), input };
}

test('CDP memory upload rechecks its deadline after synchronous page validation', async () => {
  const { result, events, input } = await memoryUpload({ expireAtGuard: true });
  assert.equal(result.deadlineExpired, true);
  assert.equal(result.dispatched, false);
  assert.deepEqual(events, []);
  assert.equal(input.files.length, 0);
});

test('CDP memory upload stops change dispatch after an input listener crosses the deadline', async () => {
  const { result, events, input } = await memoryUpload({ expireAtInput: true });
  assert.equal(result.deadlineExpired, true);
  assert.equal(result.dispatched, true);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.retryable, false);
  assert.deepEqual(events, ['input']);
  assert.equal(input.files.length, 1);
});

test('CDP timely memory upload assigns one file and emits input and change', async () => {
  const { result, events, input } = await memoryUpload();
  assert.equal(result.success, true);
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(input.files.length, 1);
});

for (const [browser, sourceKey] of [['chrome', chromeUploadSourceKey], ['firefox', firefoxUploadSourceKey]]) {
  test(`${browser}: protected attachments accept explicit Windows drive and UNC paths`, () => {
    for (const filePath of ['C:\\Users\\fixture\\upload.txt', 'D:/Downloads/upload.txt', '\\\\server\\share\\upload.txt', '/tmp/upload.txt']) {
      assert.equal(sourceKey({ filePath }), `path:${filePath}`);
    }
    for (const filePath of ['C:upload.txt', '\\upload.txt', 'upload.txt', '\\\\server', 'C:\\upload\u0000.txt']) {
      assert.equal(sourceKey({ filePath }), '');
    }
    assert.equal(sourceKey({ filePath: 'C:\\upload.txt', downloadId: 1 }), '');
  });
}

function firefoxMemoryUpload(options = {}) {
  const source = fs.readFileSync(new URL('../src/firefox/src/agent/agent.js', import.meta.url), 'utf8');
  const start = source.indexOf('const buildInjectCode = (actionDeadlineAt, pageFeedbackGuard) =>');
  const end = source.indexOf('const runUploadPagePhase =', start);
  assert.ok(start >= 0 && end > start);
  let now = 0;
  const events = [];
  class Input {
    type = 'file'; files = []; labels = [];
    getAttribute() { return ''; }
    dispatchEvent(event) {
      events.push(event.type);
      if (event.type === 'input' && options.expireAtInput) now = 11;
      return true;
    }
  }
  const input = new Input();
  const context = vm.createContext({
    FILE_UPLOAD_POLICY_SOURCE: globalThis.__wbFileUploadPolicy.source,
    args: { selector: 'input' }, base64: 'YQ==', filename: 'fixture.txt', mimeType: 'text/plain',
    HTMLInputElement: Input, Uint8Array, atob, Date: { now: () => now },
    File: class { constructor(_bytes, name, metadata) { this.name = name; this.size = 1; this.type = metadata.type; } },
    DataTransfer: class { files = []; items = { add: file => this.files.push(file) }; },
    Event: class { constructor(type) { this.type = type; } },
    document: { querySelectorAll: selector => selector === 'input' ? [input] : [] },
    window: { __wbPageMonitor: {
      activatePreparedDispatch() {},
      withPreparedDispatch(_operation, callback) { if (options.expireAtGuard) now = 11; return callback(); },
    } },
  });
  const build = vm.runInContext(`${source.slice(start, end)}; buildInjectCode;`, context);
  return { result: vm.runInContext(build(10, { operationId: 'guarded' }), context), input, events };
}

test('Firefox memory upload rechecks its deadline inside the prepared dispatch', () => {
  const { result, input, events } = firefoxMemoryUpload({ expireAtGuard: true });
  assert.equal(result.deadlineExpired, true);
  assert.equal(result.dispatched, false);
  assert.equal(result.noDispatch, true);
  assert.equal(input.files.length, 0);
  assert.deepEqual(events, []);
});

test('Firefox memory upload stops change after an input listener crosses the deadline', () => {
  const { result, input, events } = firefoxMemoryUpload({ expireAtInput: true });
  assert.equal(result.deadlineExpired, true);
  assert.equal(result.dispatched, true);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.retryable, false);
  assert.equal(input.files.length, 1);
  assert.deepEqual(events, ['input']);
});

test('Firefox timely memory upload assigns one file and emits input and change', () => {
  const { result, input, events } = firefoxMemoryUpload();
  assert.equal(result.success, true);
  assert.equal(input.files.length, 1);
  assert.deepEqual(events, ['input', 'change']);
});

async function fallbackClick({ closed = false, expireAtGuard = '', expireAtFocus = false } = {}) {
  let now = 0;
  const events = [];
  const element = {
    isConnected: true, tagName: 'BUTTON',
    getAttribute: () => 'button', closest: () => null,
    getBoundingClientRect: () => ({ x: 1, y: 1, width: 20, height: 10 }),
    focus() { events.push('focus'); if (expireAtFocus) now = 11; },
    click() { events.push('click'); },
  };
  const context = vm.createContext({
    Date: { now: () => now },
    document: { querySelector: () => element },
    window: { dispatchEvent(event) {
      if (JSON.parse(event.detail).dispatchPhase === expireAtGuard) now = 11;
      return true;
    } },
    CustomEvent: class { constructor(type, options) { Object.assign(this, options, { type }); } },
  });
  const run = declaration => {
    const operation = vm.runInContext('(' + declaration + ')', context);
    const guard = { operationId: 'guarded' };
    return { result: { value: closed
      ? operation.call(element, 10, guard)
      : operation('button', 10, guard) } };
  };
  const client = new CDPClient();
  client.resolveSelector = async () => ({ inViewport: false, hitOk: false, x: 1, y: 1, ...(closed ? { nodeId: 5 } : {}) });
  client.armFileInputClickGuard = async () => {};
  client.consumeFileInputClickGuard = async () => null;
  client.evaluateFunction = async (_tab, declaration) => run(declaration);
  client.sendCommand = async (_tab, method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'button' } };
    if (method === 'Runtime.callFunctionOn') return run(params.functionDeclaration);
    return {};
  };
  return { result: await client.clickElement(662, 'button'), events };
}

for (const closed of [false, true]) {
  const target = closed ? 'closed-shadow' : 'open-shadow';
  test(`CDP ${target} click rechecks its deadline after focus validation`, async () => {
    const { result, events } = await fallbackClick({ closed, expireAtGuard: 'focus' });
    assert.equal(result.deadlineExpired, true);
    assert.equal(result.dispatched, false);
    assert.equal(result.noDispatch, true);
    assert.deepEqual(events, []);
  });
  test(`CDP ${target} click stops after click validation crosses the deadline`, async () => {
    const { result, events } = await fallbackClick({ closed, expireAtGuard: 'click' });
    assert.equal(result.deadlineExpired, true);
    assert.equal(result.dispatched, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.retryable, false);
    assert.deepEqual(events, ['focus']);
  });
  test(`CDP ${target} click retains focus uncertainty when a focus handler exhausts the deadline`, async () => {
    const { result, events } = await fallbackClick({ closed, expireAtFocus: true });
    assert.equal(result.deadlineExpired, true);
    assert.equal(result.dispatched, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.retryable, false);
    assert.deepEqual(events, ['focus']);
  });
  test(`CDP timely ${target} click keeps focus and click semantics`, async () => {
    const { result, events } = await fallbackClick({ closed });
    assert.equal(result.success, true);
    assert.deepEqual(events, ['focus', 'click']);
  });
}
