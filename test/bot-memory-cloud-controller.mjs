import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';

const envelope = (runId = 'app-run-1', botId = 'bot-owned') => ({
  version: 1, botId, runId, policyVersion: 1,
  callbackUrl: `https://app.example/api/internal/bot-memory/${runId}`,
  callbackToken: `private-scoped-callback-token-for-${runId}`,
  policy: { schemaVersion: 1, summary: 'Read each entity once', timezone: 'UTC', confidence: 1,
    actions: [{ key: 'read_entity', label: 'Read entity', target: 'Entity', effect: 'read', repeat: { mode: 'unique' }, evidenceFields: [] }] },
  context: { document: { revision: 1, policyVersion: 1, instructionHash: 'owned-instruction-hash',
    notes: 'Private notes concerning owned invoice 42', scratchpad: 'Private unfinished investigation 73',
    createdAt: 1, updatedAt: 1 },
  recentActions: [{ note: 'Private historical draft for owned entity 98', expectedAction: 'Private original expected action 17' }], totalActions: 1 },
});
const privateValues = memory => [memory.callbackToken, memory.callbackUrl, JSON.stringify(memory), JSON.stringify(memory.context),
  memory.context.document.notes, memory.context.document.scratchpad,
  ...memory.context.recentActions.flatMap(row => [row.note, row.expectedAction])];
function assertPrivate(value, memory) {
  const encoded = JSON.stringify(value);
  for (const literal of privateValues(memory)) assert.equal(encoded.includes(literal), false, `Private memory leaked: ${literal}`);
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

for (const build of ['chrome', 'firefox']) {
  const { createCloudRunController } = await import(`../src/${build}/src/cloud-runs.js`);
  function harness(process = async (_tab, _task, _update, _mode, _files, options) => {
    options.onRunFinished?.('done'); return 'Ordinary public result';
  }) {
    const stored = {}, touches = [], observed = [];
    let seq = 0;
    const agent = { isRunning: () => false, strictSecretMode: false, abort() {},
      clearConversation: async id => touches.push(['history', id]),
      assertRunStartAllowed: async () => {},
      async processMessage(...args) { observed.push(args); return process(...args); } };
    const api = { storage: { session: { get: async key => ({ [key]: stored[key] }),
      set: async data => Object.assign(stored, structuredClone(data)) } }, tabs: {
      get: async id => { touches.push(['get', id]); return { id, url: 'https://owned.example/' }; },
      query: async () => { touches.push(['query']); return [{ id: 7, url: 'https://owned.example/' }]; },
      update: async id => { touches.push(['update', id]); return { id }; },
      create: async () => { touches.push(['create']); return { id: 20, url: 'about:blank' }; },
      remove: async id => touches.push(['remove', id]),
    } };
    const make = () => createCloudRunController({ chromeApi: api, agent, ensureOffscreen: async () => {},
      makeRunId: () => `cloud-run-${++seq}`, workflowTrace: { getRun: async () => {
        touches.push(['trace-history']); return null;
      } } });
    return { make, c: make(), stored, touches, observed, agent, api };
  }
  async function finish(c, run) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = await c.status({ runId: run.runId });
      if (!['running', 'aborting'].includes(value.status)) return value;
      await tick();
    }
    throw new Error('Owned controller run did not finish.');
  }

  test(`${build}: malformed private memory fails before tabs, history, storage or agent execution`, async () => {
    for (const value of [null, { ...envelope(), version: 2 }, { ...envelope(), botId: '../foreign' },
      { ...envelope(), botId: 'x'.repeat(129) }, { ...envelope(), callbackToken: 'short' },
      { ...envelope(), policyVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...envelope(), policy: { ...envelope().policy, schemaVersion: 2 } },
      { ...envelope(), context: [] }, { ...envelope(), context: { note: 'x'.repeat(128 * 1024) } },
      { ...envelope(), callbackUrl: 'https://app.example/api/internal/bot-memory/other-run' },
      { ...envelope(), unexpected: 'private field' }]) {
      const h = harness();
      await assert.rejects(h.c.startRun({ task: 'Owned task', task_memory: value }), error => error.status === 400);
      assert.deepEqual(h.touches, []); assert.deepEqual(h.observed, []); assert.deepEqual(h.stored, {});
    }
    const h = harness();
    await assert.rejects(h.c.startRun({ task: 'Owned task', taskMemory: envelope(), task_memory: envelope('app-run-2') }),
      error => error.status === 400);
    assert.deepEqual(h.touches, []); assert.deepEqual(h.stored, {});
  });

  test(`${build}: exact private envelope reaches only volatile agent options; reflected context stays private`, async () => {
    for (const alias of ['taskMemory', 'task_memory']) {
      const memory = envelope();
      const h = harness(async (_tab, task, update, _mode, _files, options) => {
        assert.equal(task, 'Owned task'); assert.deepEqual(options.taskMemory, memory);
        update('text_delta', { content: JSON.stringify(memory) });
        update('text_delta', { content: memory.context.document.notes });
        update('tool_result', { name: 'bot_memory_lookup', result: { generic: memory.callbackToken, context: memory.context,
          taskMemory: memory, callbackUrl: memory.callbackUrl } });
        update('clarify', { clarifyId: 'owned-clarification', question: privateValues(memory).join('\n') });
        options.onRunFinished('done'); return privateValues(memory).join('\n') + '\nPublic receipt owned-42';
      });
      const done = await finish(h.c, await h.c.startRun({ task: 'Owned task', [alias]: memory }));
      assert.equal(done.status, 'completed'); assert.match(done.result, /Public receipt owned-42/);
      assertPrivate(done, memory); assertPrivate(h.stored, memory); assertPrivate([...h.c.runs.values()], memory);
      const row = h.stored.webbrainCloudRunSnapshots[0];
      assert.equal(row.memoryProtected, true);
      assert.deepEqual(Object.keys(row.memoryOwner).sort(), ['botIdHash', 'callbackTokenHash', 'runIdHash', 'version']);
      for (const key of ['botIdHash', 'callbackTokenHash', 'runIdHash']) assert.match(row.memoryOwner[key], /^[a-f0-9]{64}$/);
      assert.equal(done.memoryOwner, undefined, 'Private ownership metadata is not a public run field.');
    }
  });

  test(`${build}: protected continuation retains only hashed owner identity and requires fresh same-bot memory`, async () => {
    const h = harness(), firstMemory = envelope();
    const root = await finish(h.c, await h.c.startRun({ task: 'First protected run', taskMemory: firstMemory }));
    const c = h.make();
    for (const memory of [undefined, envelope('app-run-2', 'foreign-bot'), firstMemory,
      { ...envelope('app-run-2'), callbackToken: firstMemory.callbackToken },
      { ...envelope('app-run-1'), callbackToken: envelope('app-run-2').callbackToken }]) {
      h.touches.length = 0;
      await assert.rejects(c.startRun({ task: 'Continue', parentRunId: root.runId,
        ...(memory ? { taskMemory: memory } : {}) }), error => error.status === 409);
      assert.deepEqual(h.touches, [], 'A rejected continuation cannot inspect or activate a tab or history.');
      assert.equal(h.observed.length, 1);
    }
    const fresh = envelope('app-run-2');
    const child = await finish(c, await c.startRun({ task: 'Continue', parentRunId: root.runId, taskMemory: fresh }));
    assert.equal(child.status, 'completed'); assert.equal(child.tabId, root.tabId);
    assert.deepEqual(h.observed.at(-1)[5].taskMemory, fresh);
    assertPrivate(h.stored, firstMemory); assertPrivate(h.stored, fresh);
    const ordinary = harness();
    const prior = await finish(ordinary.c, await ordinary.c.startRun({ task: 'Ordinary prior run' }));
    ordinary.touches.length = 0;
    await assert.rejects(ordinary.c.startRun({ task: 'Attach foreign history', parentRunId: prior.runId, taskMemory: fresh }),
      error => error.status === 409);
    assert.deepEqual(ordinary.touches, []);
    await assert.rejects(c.startRun({ task: 'Missing protected parent', parentRunId: 'unknown', tabId: 7, taskMemory: fresh }),
      error => error.status === 409);
  });

  test(`${build}: keyed protected history rejects a changed bot before borrowing or clearing its tab`, async () => {
    const h = harness(), conversationKey = '00000000-0000-4000-8000-000000000001';
    await finish(h.c, await h.c.startRun({ task: 'Owned protected root', conversationKey, taskMemory: envelope() }));
    h.touches.length = 0;
    await assert.rejects(h.c.startRun({ task: 'Different bot', conversationKey, taskMemory: envelope('app-run-2', 'foreign-bot') }),
      error => error.status === 409);
    assert.deepEqual(h.touches, []);
    const next = await finish(h.c, await h.c.startRun({ task: 'Fresh same bot', conversationKey, taskMemory: envelope('app-run-2') }));
    assert.equal(next.status, 'completed'); assert.equal(next.tabId, 20);
  });

  test(`${build}: legacy protected rows without owner proof cannot authorize continuation`, async () => {
    const h = harness();
    h.stored.webbrainCloudRunSnapshots = [{ runId: 'legacy-protected', status: 'completed', tabId: 7,
      memoryProtected: true, updates: [], createdAt: new Date().toISOString() }];
    await assert.rejects(h.c.startRun({ task: 'Unsafe legacy continuation', parentRunId: 'legacy-protected', taskMemory: envelope() }),
      error => error.status === 409);
    assert.deepEqual(h.touches, []); assert.deepEqual(h.observed, []);
  });

  test(`${build}: protected workflows cannot start or export replay outside the runtime guard`, async () => {
    const h = harness();
    await assert.rejects(h.c.startRun({ task: 'Unsafe replay', taskMemory: envelope(), _workflow: {} }),
      error => error.status === 409);
    assert.deepEqual(h.touches, []); assert.deepEqual(h.observed, []);
    const run = await finish(h.c, await h.c.startRun({ task: 'Protected run', taskMemory: envelope() }));
    h.touches.length = 0;
    const compiled = await h.c.compileWorkflow({ runId: run.runId, name: 'Unsafe replay' });
    assert.equal(compiled.ok, false); assert.equal(compiled.status, 409);
    assert.equal(compiled.reason, 'memory_protected_workflow_unsupported'); assert.deepEqual(h.touches, []);
  });

  test(`${build}: async errors, structured results and encrypted output cannot reflect private memory`, async () => {
    const memory = envelope();
    const failing = harness(async () => { throw new Error(privateValues(memory).join('\n')); });
    const failed = await finish(failing.c, await failing.c.startRun({ task: 'Owned task', taskMemory: memory }));
    assert.equal(failed.status, 'failed'); assertPrivate(failed, memory); assertPrivate(failing.stored, memory);
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const h = harness(async (_tab, _task, update, _mode, _files, options) => {
      update('tool_result', { name: 'done_json', result: { cloudResult: {
        receipt: 'Public owned receipt', privateReflection: privateValues(memory).join('\n'), taskMemory: memory,
      }, summary: memory.context.document.notes, cloudDone: true } });
      options.onRunFinished('done'); return memory.callbackToken;
    });
    const done = await finish(h.c, await h.c.startRun({ task: 'Owned task', taskMemory: memory,
      private_result_public_key: pair.publicKey.export({ format: 'jwk' }), output_schema: { type: 'object' } }));
    assert.equal(done.status, 'completed'); assertPrivate(done, memory); assertPrivate(h.stored, memory);
    const e = done.result.private_result;
    const key = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(e.encryptedKey, 'base64'));
    const bytes = Buffer.from(e.ciphertext, 'base64'), aes = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
    aes.setAAD(Buffer.from('webbrain.private-result.v1:' + done.runId)); aes.setAuthTag(bytes.subarray(-16));
    const plain = JSON.parse(Buffer.concat([aes.update(bytes.subarray(0, -16)), aes.final()]).toString());
    assert.equal(plain.receipt, 'Public owned receipt'); assertPrivate(plain, memory);
    const startup = harness();
    startup.agent.assertRunStartAllowed = async () => {
      throw Object.assign(new Error(privateValues(memory).join('\n')), { code: 'owned_startup_veto', status: 409, rawPrivate: memory });
    };
    await assert.rejects(startup.c.startRun({ task: 'Owned task', taskMemory: memory }), error => {
      assert.equal(error.status, 409); assert.equal(error.code, 'owned_startup_veto');
      assertPrivate({ message: error.message, stack: error.stack, ...error }, memory); return true;
    });
    assert.equal(startup.observed.length, 0);
  });

  test(`${build}: late callbacks lose private publication authority when their run finishes`, async () => {
    const memory = envelope(); let late;
    const h = harness(async (_tab, _task, update, _mode, _files, options) => {
      late = update; options.onRunFinished('done'); return 'Owned public result';
    });
    const run = await finish(h.c, await h.c.startRun({ task: 'Owned task', taskMemory: memory }));
    const count = run.updates.length;
    late('text_delta', { content: privateValues(memory).join('\n') });
    late('tool_result', { name: 'bot_memory_lookup', result: { taskMemory: memory } });
    const after = await h.c.status({ runId: run.runId });
    assert.equal(after.updates.length, count); assertPrivate(after, memory); assertPrivate(h.stored, memory);
  });

  test(`${build}: ordinary runs keep memory-named requested fields and never receive another run's envelope`, async () => {
    const expected = { taskMemory: { title: 'Ordinary requested page field' }, callbackToken: 'Ordinary requested token field',
      callbackUrl: 'https://ordinary.example/' };
    const h = harness(async (_tab, _task, update, _mode, _files, options) => {
      if (options.taskMemory) { options.onRunFinished('done'); return 'Protected result'; }
      update('tool_result', { name: 'done_json', result: { cloudResult: expected, cloudDone: true } });
      options.onRunFinished('done'); return 'Ordinary result';
    });
    await finish(h.c, await h.c.startRun({ task: 'Protected task', taskMemory: envelope() }));
    const ordinary = await finish(h.c, await h.c.startRun({ task: 'Ordinary task', output_schema: { type: 'object' } }));
    assert.equal(h.observed.at(-1)[5].taskMemory, undefined); assert.deepEqual(ordinary.result, expected);
  });
}
