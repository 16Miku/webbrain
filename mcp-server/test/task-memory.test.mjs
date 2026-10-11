import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const allocator = createServer();
allocator.listen(0, '127.0.0.1');
await once(allocator, 'listening');
process.env.WEBBRAIN_BRIDGE_PORT = String(allocator.address().port);
allocator.close();
await once(allocator, 'close');
const { WebBrainBridge } = await import('../dist/bridge.js');
const { startRun, getStatus, describeSnapshot } = await import('../dist/runs.js');
const { bridgeUrl } = await import('../dist/config.js');
const { validateTaskMemory, redactTaskMemory, redactMemoryRunResponse, taskMemoryPrivateValues } = await import('../dist/task-memory.js');

const memory = {
  version: 1, botId: 'bot-owned', runId: 'app-run-1', policyVersion: 1,
  callbackUrl: 'http://127.0.0.1:4174/api/internal/bot-memory/app-run-1',
  callbackToken: 'private-scoped-callback-token-for-run',
  policy: { schemaVersion: 1, actions: [{ key: 'read', effect: 'read', repeat: { mode: 'unique' } }] },
  context: { document: null, recentActions: [], totalActions: 0 },
};

test('MCP validates private callbacks and bounded envelopes without exposing supplied data', () => {
  const ordinary = { result: { callbackToken: 'ordinary requested field', taskMemory: { title: 'ordinary page content' } } };
  assert.deepEqual(redactTaskMemory(ordinary), ordinary);
  const secrets = new Set([memory.callbackToken, memory.callbackUrl]);
  assert.deepEqual(redactMemoryRunResponse({ runId: 'ordinary', ...ordinary }, secrets, new Set(['protected'])), { runId: 'ordinary', ...ordinary });
  const listed = redactMemoryRunResponse({ runs: [{ runId: 'protected', ...ordinary }, { runId: 'ordinary', ...ordinary }], taskMemory: memory }, secrets, new Set(['protected']));
  assert.equal(listed.taskMemory, undefined);
  assert.deepEqual(listed.runs[0].result, {});
  assert.deepEqual(listed.runs[1].result, ordinary.result);
  assert.equal(redactTaskMemory(JSON.stringify({ ...memory, context: { notes: 'private-diagnostic-note' } }), secrets).includes('private-diagnostic-note'), false);
  assert.deepEqual(validateTaskMemory(memory), memory);
  for (const patch of [
    { botId: undefined }, { version: 2 }, { policyVersion: 0 },
    { callbackUrl: 'http://remote.example/api/internal/bot-memory/app-run-1' },
    { callbackUrl: 'https://user:password@webbrain.me/api/internal/bot-memory/app-run-1' },
    { callbackUrl: 'http://127.0.0.1:4174/api/internal/bot-memory/another' },
    { callbackUrl: memory.callbackUrl + '?secret=secret' },
    { context: { notes: 'x'.repeat(128 * 1024) } }, { extra: 'private' },
  ]) assert.throws(() => validateTaskMemory({ ...memory, ...patch }), /^Error: Invalid task_memory envelope\.$/);
});

test('protected memory reflections stay private while protocol and other run values remain exact', () => {
  const privateMemory = { ...memory, context: { notes: 'private-context-note', state: 'completed', id: 'protected', short: 'tiny' } };
  const values = taskMemoryPrivateValues(validateTaskMemory(privateMemory));
  const credentials = new Set([memory.callbackToken, memory.callbackUrl]);
  const protectedRunIds = new Set(['protected']);
  const scope = { runValues: new Map([['protected', values]]) };
  const protectedRun = { runId: 'protected', status: 'completed', code: 'completed',
    result: { text: 'private-context-note, tiny', nested: { taskMemory: privateMemory } },
    content: 'Finished private-context-note', updates: [{ note: 'private-context-note' }],
    private_result: { type: 'encrypted-private-result', ciphertext: 'opaque-ciphertext' } };
  const redacted = redactMemoryRunResponse(protectedRun, credentials, protectedRunIds, false, scope);
  assert.equal(redacted.runId, 'protected');
  assert.equal(redacted.status, 'completed');
  assert.equal(redacted.code, 'completed');
  assert.deepEqual(redacted.private_result, protectedRun.private_result);
  assert.equal(JSON.stringify(redacted).includes('private-context-note'), false);
  assert.equal(JSON.stringify(redacted).includes('tiny'), false);
  assert.equal(redacted.result.nested.taskMemory, undefined);
  const ordinary = { runId: 'ordinary', status: 'completed', content: 'private-context-note, tiny',
    result: { taskMemory: { notes: 'ordinary requested property' }, callbackToken: 'ordinary value' } };
  assert.deepEqual(redactMemoryRunResponse(ordinary, credentials, protectedRunIds, false, scope), ordinary);
  const mixed = redactMemoryRunResponse({ runs: [protectedRun, ordinary] }, credentials, protectedRunIds, false, scope);
  assert.deepEqual(mixed.runs[0], redacted);
  assert.deepEqual(mixed.runs[1], ordinary);
  assert.equal(redactMemoryRunResponse('Failed private-context-note', credentials, protectedRunIds, true,
    { ...scope, requestRunId: 'protected' }).includes('private-context-note'), false);
});

test('direct bridge rejects invalid, misplaced, or unsupported memory without sending it', async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();
  const seen = [];
  const extension = new WebSocket(bridgeUrl());
  extension.on('open', () => extension.send(JSON.stringify({ type: 'hello', client: 'webbrain-extension', protocolVersion: 2, capabilities: [] })));
  extension.on('message', raw => { seen.push(JSON.parse(raw.toString())); });
  try {
    assert.equal(await bridge.waitForExtension(3000), true);
    await assert.rejects(bridge.request('cloud_run', { task: 'Read', taskMemory: memory }), error => error.status === 409);
    await assert.rejects(bridge.request('cloud_run', { task: 'Read', taskMemory: { ...memory, version: 2 } }), error => error.status === 400 && !error.message.includes(memory.callbackToken));
    await assert.rejects(bridge.request('cloud_run', { task: 'Read', task_memory: memory }), error => error.status === 400);
    await assert.rejects(bridge.request('cloud_status', { runId: 'r', taskMemory: memory }), error => error.status === 400);
    assert.deepEqual(seen, []);
  } finally { extension.close(); await bridge.stop(); }
});

test('memory values survive failure and reconnect, with capability downgrade still refusing new memory runs', async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();
  const privateMemory = { ...memory, context: { notes: 'private-reconnect-note' } };
  const connect = capabilities => {
    const socket = new WebSocket(bridgeUrl());
    socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', client: 'webbrain-extension', protocolVersion: 2, capabilities })));
    return socket;
  };
  const first = connect(['bot_memory_v1']);
  first.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    first.send(JSON.stringify({ id: msg.id, ok: true, result: { runId: 'reconnect-protected', status: 'running' } }));
  });
  let second;
  try {
    assert.equal(await bridge.waitForExtension(3000), true);
    await startRun(bridge, { runId: 'reconnect-protected', task: 'Read', mode: 'act', taskMemory: privateMemory });
    first.close(); await once(first, 'close');
    second = connect([]);
    const received = [];
    second.on('message', raw => {
      const msg = JSON.parse(raw.toString()); received.push(msg);
      const ordinary = msg.payload.runId === 'reconnect-ordinary';
      second.send(JSON.stringify(msg.action === 'cloud_respond'
        ? { id: msg.id, ok: false, status: 500, error: 'failed private-reconnect-note ' + memory.callbackToken }
        : { id: msg.id, ok: true, result: { runId: msg.payload.runId, status: 'failed',
          content: 'private-reconnect-note', result: { taskMemory: ordinary ? { title: 'ordinary field' } : privateMemory } } }));
    });
    assert.equal(await bridge.waitForExtension(3000), true);
    const status = await getStatus(bridge, 'reconnect-protected');
    assert.equal(JSON.stringify(status).includes('private-reconnect-note'), false);
    assert.equal(status.result.taskMemory, undefined);
    const ordinary = await getStatus(bridge, 'reconnect-ordinary');
    assert.equal(ordinary.content, 'private-reconnect-note');
    assert.deepEqual(ordinary.result.taskMemory, { title: 'ordinary field' });
    await assert.rejects(bridge.request('cloud_respond', { runId: 'reconnect-protected', answer: 'Once' }), error => error.status === 500 && !error.message.includes('private-reconnect-note') && !error.message.includes(memory.callbackToken));
    const before = received.length;
    await assert.rejects(startRun(bridge, { task: 'Read', mode: 'act', taskMemory: privateMemory }), error => error.status === 409);
    assert.equal(received.length, before);
  } finally { first.close(); second?.close(); await bridge.stop(); }
});

test('MCP rejects protected runs on old bridges before dispatch; ordinary calls are unchanged', async () => {
  const calls = [];
  const bridge = { capabilities: () => [], async request(action, payload) { calls.push({ action, payload }); return { runId: 'ordinary', status: 'running' }; } };
  await assert.rejects(startRun(bridge, { task: 'Read', mode: 'act', taskMemory: memory }), error => error.status === 409);
  assert.equal(calls.length, 0);
  await startRun(bridge, { task: 'Read', mode: 'ask' });
  assert.deepEqual(calls[0], { action: 'cloud_run', payload: { task: 'Read', mode: 'ask' } });
});

test('MCP transports memory outside prompts and redacts credentials from status and errors after failure', async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();
  const seen = [];
  let rejectNext = false;
  const extension = new WebSocket(bridgeUrl());
  extension.on('open', () => extension.send(JSON.stringify({ type: 'hello', client: 'webbrain-extension', protocolVersion: 2, capabilities: ['bot_memory_v1'] })));
  extension.on('message', raw => {
    const message = JSON.parse(raw.toString());
    seen.push(message);
    const ordinary = message.action === 'cloud_run' && !message.payload.taskMemory;
    extension.send(JSON.stringify(rejectNext
      ? { id: message.id, ok: false, status: 500, error: `failed ${memory.callbackToken}` }
      : { id: message.id, ok: true, result: {
        runId: ordinary ? 'ordinary-run' : 'browser-run', status: message.action === 'cloud_status' ? 'failed' : 'running',
        taskMemory: memory, result: ordinary ? { taskMemory: { title: 'ordinary field' }, callbackToken: 'ordinary token', callbackUrl: 'https://ordinary.example' } : { text: 'read', task_memory: memory },
        error: `uncertain ${memory.callbackToken}`, updates: [{ note: memory.callbackToken, callbackToken: memory.callbackToken }],
      } }));
  });
  try {
    assert.equal(await bridge.waitForExtension(3000), true);
    const started = await startRun(bridge, { runId: 'browser-run', task: 'Read a story', mode: 'act', taskMemory: memory });
    assert.deepEqual(seen[0].payload.taskMemory, memory);
    assert.equal(seen[0].payload.task, 'Read a story');
    assert.equal(seen[0].payload.task.includes(memory.callbackToken), false);
    assert.equal(JSON.stringify(started).includes(memory.callbackToken), false);
    const failed = await getStatus(bridge, 'browser-run');
    assert.equal(failed.status, 'failed');
    assert.equal(JSON.stringify(failed).includes(memory.callbackToken), false);
    assert.equal(JSON.stringify(failed).includes('taskMemory'), false);
    assert.equal(describeSnapshot(failed).includes(memory.callbackToken), false);
    const ordinary = await startRun(bridge, { runId: 'ordinary-run', task: 'Ordinary', mode: 'ask' });
    assert.deepEqual(ordinary.result, { taskMemory: { title: 'ordinary field' }, callbackToken: 'ordinary token', callbackUrl: 'https://ordinary.example' });
    rejectNext = true;
    await assert.rejects(getStatus(bridge, 'browser-run'), error => error.status === 500 && !error.message.includes(memory.callbackToken));
  } finally { extension.close(); await bridge.stop(); }
});

test('real MCP stdio run forwards the optional envelope privately and preserves ordinary tool output', async () => {
  const portAllocator = createServer();
  portAllocator.listen(0, '127.0.0.1'); await once(portAllocator, 'listening');
  const port = portAllocator.address().port;
  portAllocator.close(); await once(portAllocator, 'close');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'],
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, WEBBRAIN_BRIDGE_PORT: String(port) }, stderr: 'pipe' });
  const client = new Client({ name: 'private-memory-integration-test', version: '1.0.0' });
  const privateMemory = { ...memory, context: { notes: 'private-stdio-memory-context', status: 'completed' } };
  let extension;
  const seen = [];
  try {
    await client.connect(transport);
    const unsupported = await client.callTool({ name: 'webbrain_run', arguments: { task: 'Read page', wait: false, task_memory: privateMemory } });
    assert.equal(unsupported.isError, true);
    assert.match(JSON.stringify(unsupported), /Update the browser extension/);
    assert.equal(JSON.stringify(unsupported).includes(memory.callbackToken), false);
    extension = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    extension.on('open', () => extension.send(JSON.stringify({ type: 'hello', client: 'webbrain-extension', protocolVersion: 2, capabilities: ['bot_memory_v1'] })));
    extension.on('message', raw => {
      const msg = JSON.parse(raw.toString()); seen.push(msg);
      const protectedRun = !!msg.payload.taskMemory;
      extension.send(JSON.stringify({ id: msg.id, ok: true, result: {
        runId: msg.payload.runId, status: 'completed',
        taskMemory: protectedRun ? privateMemory : undefined,
        result: protectedRun ? { text: 'private-stdio-memory-context', task_memory: privateMemory }
          : { taskMemory: { title: 'ordinary requested field' }, callbackToken: 'ordinary requested token', callbackUrl: 'https://ordinary.example' },
      } }));
    });
    await once(extension, 'open');
    // A status request establishes that this socket's hello reached the server.
    for (let attempt = 0; attempt < 30; attempt++) {
      const connection = await client.callTool({ name: 'webbrain_connection', arguments: {} });
      if (JSON.stringify(connection).includes('bot_memory_v1')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.notEqual(attempt, 29, 'MCP extension handshake was not observed');
    }
    const protectedResult = await client.callTool({ name: 'webbrain_run', arguments: { task: 'Read page', mode: 'act', wait: false, task_memory: privateMemory } });
    assert.notEqual(protectedResult.isError, true);
    assert.deepEqual(seen[0].payload.taskMemory, privateMemory);
    assert.equal(seen[0].payload.task, 'Read page');
    const text = JSON.stringify(protectedResult);
    assert.match(text, /completed/);
    for (const secret of [memory.callbackToken, memory.callbackUrl, 'private-stdio-memory-context']) assert.equal(text.includes(secret), false);
    const ordinaryResult = await client.callTool({ name: 'webbrain_run', arguments: { task: 'Ordinary read', wait: false } });
    assert.notEqual(ordinaryResult.isError, true);
    assert.equal(seen[1].payload.taskMemory, undefined);
    assert.match(JSON.stringify(ordinaryResult), /ordinary requested field/);
    assert.match(JSON.stringify(ordinaryResult), /ordinary requested token/);
    assert.match(JSON.stringify(ordinaryResult), /https:\/\/ordinary\.example/);
  } finally { extension?.close(); await client.close().catch(() => {}); }
});
