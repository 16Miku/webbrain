import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';

// Exact transport shape returned by MiniMax during the owned native-chat live
// fixture. These identifiers belong to that synthetic Telegram-shaped page.
const nativeOnly = ']<]minimax[>[<tool_call>\n]<]minimax[>[<invoke name="chat_observe">]<]minimax[>[<rebind_thread_key>dom:telegram:k:123456:0]<]minimax[>[</rebind_thread_key>]<]minimax[>[<reconcile_pending_outbound>false]<]minimax[>[</reconcile_pending_outbound>]<]minimax[>[<pending_outbound_key>telegram:k:123456:0:13:r12d2bc8d]<]minimax[>[</pending_outbound_key>]<]minimax[>[</invoke>\n]<]minimax[>[</tool_call>';
const blocked = 'Stuck in a loop. Stopped.';
const deferred = () => {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
};
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = { storage: { local: area, session: area },
  runtime: { getURL: value => `extension://fixture/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.test/', title: 'Owned recovery lab' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] } };
globalThis.chrome = api;
globalThis.browser = api;

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { chatRecoveryDisplayText } = await import(`../src/${build}/src/agent/chat-recovery-text.js`);

  test(`${build}: large backtick runs and many literal code spans cannot block the worker`, () => {
    const literal = 'Literal ' + '`'.repeat(65536);
    const start = performance.now();
    assert.equal(chatRecoveryDisplayText(literal), literal);
    assert.equal(chatRecoveryDisplayText(`${literal}\n${nativeOnly}`), literal);
    const many = Array(2048).fill('Literal `code` ' + nativeOnly).join('\n');
    const clean = chatRecoveryDisplayText(many);
    assert.equal((clean.match(/Literal `code`/g) || []).length, 2048);
    assert.doesNotMatch(clean, /minimax|tool_call|chat_observe/);
    assert.ok(performance.now() - start < 1000, 'Bounded recovery display processing must leave Stop and steering responsive.');
  });

  test(`${build}: steering during deferred terminal recovery suppresses obsolete UI and persistence`, async () => {
    const entered = deferred(), release = deferred();
    const agent = new Agent({});
    const messages = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Original task' }];
    const updates = [], persisted = [];
    agent.conversations.set(73, messages);
    agent._persist = () => persisted.push(structuredClone(messages));
    agent._chatWithCostAllowance = async () => { entered.resolve(); return release.promise; };
    await agent._claimRunEntry(73, 'interactive', { detachedRequestId: 'recovery-run' }, () => {});
    try {
      const pending = agent._recoverLoopStoppedTurn(73, messages, (type, data) => updates.push({ type, data }), {}, {}, null, 4, blocked);
      await entered.promise;
      assert.equal(agent.steerMessage(73, 'Use the corrected task instead', { requestId: 'recovery-run', messageId: 'correction' }).accepted, true);
      release.resolve({ content: JSON.stringify({ final_text: 'Obsolete recovered answer' }), toolCalls: [] });
      assert.deepEqual(await pending, { content: '', status: 'steering_superseded' });
      assert.equal(messages.length, 2, 'No stale assistant turn can enter the conversation.');
      assert.deepEqual(persisted, []);
      assert.equal(updates.some(update => ['text', 'error'].includes(update.type)), false);
      assert.equal(agent._hasPendingSteering(73), true, 'Leave the correction for the normal authorized boundary.');
    } finally { release.resolve({ content: '' }); agent._finishSteeringRun(73); agent._releaseRunEntry(73); }
  });

  test(`${build}: Stop during deferred recovery takes priority over an already accepted correction`, async () => {
    const entered = deferred(), release = deferred(), updates = [];
    const agent = new Agent({});
    const messages = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Original task' }];
    agent._persist = () => {};
    agent._chatWithCostAllowance = async () => { entered.resolve(); return release.promise; };
    await agent._claimRunEntry(73, 'interactive', { detachedRequestId: 'recovery-run' }, () => {});
    try {
      const pending = agent._recoverLoopStoppedTurn(73, messages, (type, data) => updates.push({ type, data }), {}, {}, null, 4, blocked);
      await entered.promise;
      assert.equal(agent.steerMessage(73, 'Use the corrected task instead', { requestId: 'recovery-run', messageId: 'correction' }).accepted, true);
      agent.abort(73);
      release.resolve({ content: JSON.stringify({ final_text: 'Obsolete recovered answer' }), toolCalls: [] });
      assert.deepEqual(await pending, { content: '[Stopped by user]', status: 'cancelled' });
      assert.equal(updates.some(update => update.type === 'text' && update.data.content === '[Stopped by user]'), true);
      assert.equal(updates.some(update => update.type === 'text' && /Obsolete recovered answer/.test(update.data.content)), false);
      assert.equal(messages.some(message => /Obsolete recovered answer/.test(message.content)), false);
    } finally { release.resolve({ content: '' }); agent._finishSteeringRun(73); agent._releaseRunEntry(73); }
  });

  for (const streaming of [false, true]) test(`${build}: ${streaming ? 'stream' : 'chat'} recovery resumes the corrected task before another generation`, async () => {
    const entered = deferred(), release = deferred(), plans = [], requests = [], updates = [], persisted = [];
    let generations = 0, agent;
    const next = async messages => {
      requests.push(structuredClone(messages));
      if (++generations === 1) return { toolCalls: [{ id: 'old-scroll', function: { name: 'scroll', arguments: '{"direction":"down"}' } }] };
      if (generations === 2) { entered.resolve(); await release.promise; return { content: JSON.stringify({ final_text: 'Obsolete recovered answer' }) }; }
      assert.equal(generations, 3, 'Exactly one generation answers the revalidated correction.');
      assert.match(JSON.stringify(messages), /Use the corrected task instead/);
      assert.doesNotMatch(JSON.stringify(messages), /Obsolete recovered answer/);
      return { content: 'Corrected task answer' };
    };
    const provider = { name: 'fixture', model: 'fixture', contextWindow: 128000, supportsTools: false, supportsVision: false,
      chat: next, async *chatStream(messages) { const result = await next(messages);
        if (result.toolCalls) yield { type: 'tool_call', content: result.toolCalls };
        if (result.content) yield { type: 'text', content: result.content };
        yield { type: 'done' }; } };
    agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    agent._hydrate = async () => {};
    agent._persist = () => persisted.push(structuredClone(agent.conversations.get(73) || []));
    agent._persistNow = async () => ({ ok: true });
    agent._startTraceRun = async () => null; agent._endTraceRun = async () => {};
    agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
    agent._beginReadCompleteness = async () => null; agent._manageContext = async () => {};
    agent._checkCostAllowance = async () => null; agent._recordCostUsage = async () => null;
    agent._plannerMode = () => 'off'; agent._persistSubmittedTurn = async () => {};
    agent._getTabUrlTitle = async () => ({ tabUrl: 'https://example.test/', tabTitle: 'Owned recovery lab' });
    agent._currentUrl = async () => 'https://example.test/';
    agent._ensureProgressSessionForCurrentTask = async () => {};
    agent._maybeEmitAskModeHandoff = async () => {};
    agent._runPlannerIntentGate = async (_tab, enriched) => {
      plans.push(enriched.content);
      return plans.length === 1
        ? { proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false }
        : { proceed: true, requestKind: 'respond', responseOnly: true, requiresStateChange: false, requiresSubmission: false };
    };
    // Only the loop-stop trigger is isolated. The production recovery helper,
    // both outer callers, real steering acceptance/revalidation and corrected
    // response generation remain intact.
    agent._executeToolBatch = async (_tab, calls, messages) => {
      assert.equal(calls.length, 1); assert.equal(calls[0].function.name, 'scroll');
      messages.push({ role: 'tool', tool_call_id: calls[0].id, content: '{"success":false,"noProgress":true}' });
      return { action: 'recover', value: blocked };
    };
    const update = (type, data) => updates.push({ type, data });
    const options = { detachedRequestId: 'recovery-run', askStreamingEnabled: false };
    const pending = streaming ? agent.processMessageStream(73, 'Original task', update, 'act', options)
      : agent.processMessage(73, 'Original task', update, 'act', [], options);
    await Promise.race([entered.promise, pending.then(value => assert.fail(`Recovery ended early: ${value}`))]);
    assert.equal(agent.steerMessage(73, 'Use the corrected task instead', { requestId: 'recovery-run', messageId: 'correction' }).accepted, true);
    release.resolve();
    assert.equal(await pending, 'Corrected task answer');
    assert.equal(plans.length, 2); assert.match(plans[1], /Use the corrected task instead/);
    assert.equal(generations, 3);
    assert.equal(updates.some(update => update.type === 'text' && /Obsolete recovered answer/.test(update.data.content)), false);
    assert.equal(persisted.some(messages => messages.some(message => message.role === 'assistant' && /Obsolete recovered answer/.test(message.content || ''))), false);
    assert.equal(agent.isRunning(73), false);
  });

  async function recover(content, toolCalls = [], { raw = false } = {}) {
    const agent = new Agent({});
    const messages = [
      { role: 'system', content: 'ordinary Act prompt' },
      { role: 'user', content: 'Reply to the latest message in the owned demo chat.' },
    ];
    const updates = [];
    let request = null;
    const dispatched = [];
    agent.executeTool = async (...args) => { dispatched.push(args); throw new Error('Recovery must remain tool-free'); };
    agent._persist = () => {};
    agent._chatWithCostAllowance = async (_provider, sentMessages, options) => {
      request = { sentMessages, options };
      return { content: raw ? content : JSON.stringify({ final_text: content }), toolCalls };
    };
    const result = await agent._recoverLoopStoppedTurn(
      73, messages, (type, data) => updates.push({ type, data }), { model: 'fixture' }, {}, null, 8, blocked,
    );
    assert.equal(request.options.tools, undefined, 'Recovery must expose no tools');
    assert.match(request.sentMessages[0].content, /tool-free chat response/);
    assert.deepEqual(dispatched, [], 'Never turn recovered transport fragments into browser actions');
    assert.equal(result.status, 'loop_stopped');
    assert.equal(messages.at(-1).content, result.content);
    assert.equal(updates.findLast(update => update.type === 'text').data.content, result.content);
    return { result, updates };
  }

  test(`${build}: native MiniMax tool-only recovery shows the existing blocker without transport XML`, async () => {
    const { result, updates } = await recover(nativeOnly);
    assert.equal(result.content, blocked);
    assert.equal(updates.findLast(update => update.type === 'error').data.message, blocked);
  });

  test(`${build}: native recovery preserves useful prose while removing complete transport calls`, async () => {
    const prose = 'The draft is ready in the editor. Sending remains unverified.';
    const { result } = await recover(`${prose}\n\n${nativeOnly}`);
    assert.match(result.content, /chat-only; do not assume it was saved, submitted, or sent/);
    assert.ok(result.content.endsWith(prose));
    assert.doesNotMatch(result.content, /minimax|tool_call|chat_observe|rebind_thread_key/);
    const adjacent = await recover(`${nativeOnly}${nativeOnly}\n${prose}`);
    assert.ok(adjacent.result.content.endsWith(prose), 'Adjacent calls must not consume trailing useful prose');
    assert.doesNotMatch(adjacent.result.content, /minimax|tool_call|chat_observe|rebind_thread_key/);
  });

  test(`${build}: incomplete native transport cannot masquerade as a recovered deliverable`, async () => {
    for (const content of [
      nativeOnly.slice(0, nativeOnly.indexOf('<pending_outbound_key>')),
      ']<]minimax[>[<invoke name="chat_send"><text>Never send this</text>',
      '<tool_call><invoke name="chat_observe"></invoke></tool_call>',
    ]) assert.equal((await recover(content)).result.content, blocked);
  });

  test(`${build}: structured tool calls returned despite tool-free recovery are never executed`, async () => {
    const { result } = await recover('Submitting now.', [{
      id: 'forbidden', function: { name: 'chat_send', arguments: '{"text":"Do not send"}' },
    }]);
    assert.equal(result.content, blocked);
  });

  test(`${build}: ordinary drafts and fenced literal XML remain available during recovery`, async () => {
    for (const prose of [
      'Subject: Thank you\n\nHello,\nThank you for your help.',
      'Requested XML:\n```xml\n<tool_call><invoke name="example"></invoke></tool_call>\n```',
      `Literal native XML: \`${nativeOnly}\``,
      'Literal XML with a backtick: ``<invoke name="example">`</invoke>``',
      'Use <article> as the root of the XML document.',
    ]) assert.ok((await recover(prose)).result.content.endsWith(prose));
  });


  test(`${build}: exact observed unmarked terminal recovery is rejected without displaying deliberation`, async () => {
    // Actual tool-free response seq211 had an unmarked prose preamble.
    // The display boundary must not guess which prose is deliberation.
    const observed = "We need respond to latest genuine user request? It’s implied continue task. Need mention cannot verify save maybe. But likely need act; however tools stopped.\n\nI’ve attached the GitHub logo file to the YouTube Studio profile picture editor, and the next required step is still to confirm the crop dialog and then save/publish the change. The current evidence shows the file was accepted locally, but I do not yet have verified proof that the new profile picture was durably saved to the channel.\n\nIf you want, I can continue from this state when tool access resumes.";
    const { result } = await recover(observed, [], { raw: true });
    assert.equal(result.content, blocked);
    assert.doesNotMatch(result.content, /We need respond|Need mention|tools stopped/);
  });

  test(`${build}: one strict final_text envelope preserves a draft and literal protocol`, async () => {
    for (const final_text of [
      "Subject: Thank you\n\nHello,\nThank you for your help.",
      "Requested XML:\n```xml\n<tool_call><invoke name=\"example\"></invoke></tool_call>\n```",
      "Literal native XML: `" + nativeOnly + "`",
    ]) {
      const { result } = await recover(JSON.stringify({ final_text }), [], { raw: true });
      assert.ok(result.content.endsWith(final_text));
    }
    const max = 'x'.repeat(65536);
    assert.ok((await recover(JSON.stringify({ final_text: max }), [], { raw: true })).result.content.endsWith(max));
  });

  test(`${build}: malformed, prefixed, extra-field, empty and oversized envelopes fail closed`, async () => {
    const good = JSON.stringify({ final_text: 'Useful draft' });
    for (const content of [
      'Internal preamble\n' + good, good + '\nInternal suffix',
      '```json\n' + good + '\n```', '{"final_text":"incomplete',
      JSON.stringify({ final_text: 'Useful draft', analysis: 'private deliberation' }),
      JSON.stringify({ analysis: 'private deliberation' }), JSON.stringify({ final_text: '' }),
      JSON.stringify({ final_text: '  \n ' }), JSON.stringify({ final_text: 4 }),
      JSON.stringify({ final_text: ['Useful draft'] }), 'null', '[]',
      JSON.stringify({ final_text: 'x'.repeat(65537) }), ' '.repeat(65536 * 6 + 129),
    ]) assert.equal((await recover(content, [], { raw: true })).result.content, blocked);
    assert.equal((await recover(good, [{ id: 'forbidden', function: { name: 'chat_send', arguments: '{}' } }], { raw: true })).result.content, blocked);
  });
  test(`${build}: normal tool-free Ask preserves requested literal native protocol examples`, async () => {
    const agent = new Agent({});
    const expected = `Example protocol:\n\n\`\`\`xml\n${nativeOnly}\n\`\`\``;
    const messages = [
      { role: 'system', content: 'ordinary Ask prompt' },
      { role: 'user', content: 'Print this XML transport example literally as code.' },
    ];
    agent._persist = () => {};
    agent._chatWithCostAllowance = async () => ({ content: expected, toolCalls: [] });
    const result = await agent._completeResponseOnlyTurn(73, messages, () => {}, {}, {}, null);
    assert.equal(result.status, 'done');
    assert.equal(result.content, expected);
  });
}

test('chat recovery protocol helpers remain identical in both browser builds', async () => {
  assert.equal(await fs.readFile('src/chrome/src/agent/chat-recovery-text.js', 'utf8'),
    await fs.readFile('src/firefox/src/agent/chat-recovery-text.js', 'utf8'));
});
