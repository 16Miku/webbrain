import assert from 'node:assert/strict';
import { test } from 'node:test';

const call = (id, page = 0, large = '') => ({
  id, type: 'function',
  function: { name: 'read_page', arguments: JSON.stringify({ page, large }) },
});

function assertPairedResults(messages) {
  let pending = new Set();
  for (const message of messages) {
    if (message.role === 'tool') {
      assert.ok(pending.delete(message.tool_call_id),
        `Tool result ${message.tool_call_id} must belong to the preceding assistant group`);
    } else {
      assert.equal(pending.size, 0, 'A completed tool group must retain all its results');
      pending = new Set((message.tool_calls || []).map(item => item.id));
    }
  }
  assert.equal(pending.size, 0);
}

for (const browser of ['chrome', 'firefox']) {
  const { serializeConversationForSession: serialize } = await import(
    `../src/${browser}/src/agent/conversation-persistence.js`
  );

  test(`${browser}: recovery preserves a complete in-budget batch with more than fifty tool calls`, () => {
    const calls = Array.from({ length: 60 }, (_, index) => call(`page-${index}`, index));
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Read every page in this finite collection.' },
      { role: 'assistant', content: null, tool_calls: calls },
      ...calls.map(item => ({ role: 'tool', tool_call_id: item.id, content: `Read ${item.id}` })),
    ];
    const snapshot = serialize(messages);
    assert.deepEqual(snapshot.messages, messages);
    assert.equal(snapshot.compacted, false);
    assertPairedResults(snapshot.messages);
  });

  test(`${browser}: compacted recovery binds reused tool IDs to their own assistant turn`, () => {
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Inspect the conversation history.' },
      ...Array.from({ length: 30 }, (_, index) => [
        { role: 'assistant', content: null, tool_calls: [call('reused', index, 'x'.repeat(5000))] },
        { role: 'tool', tool_call_id: 'reused', content: `Page ${index}: ${'result '.repeat(2000)}` },
      ]).flat(),
    ];
    const snapshot = serialize(messages, { maxBytes: 100_000, preserveMessageIndices: [1] });
    assert.equal(snapshot.compacted, true);
    assert.ok(snapshot.bytes <= 100_000);
    assert.equal(snapshot.messages[1].content, messages[1].content);
    assertPairedResults(snapshot.messages);
    assert.ok(snapshot.messages.some(message => message.role === 'tool' && message.content.startsWith('Page 29:')),
      'The latest completed result must survive historical compaction');
  });

  test(`${browser}: recovery keeps a pending final tool group without inventing an execution result`, () => {
    const pendingCall = call('pending');
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Inspect the page.' },
      ...Array.from({ length: 25 }, (_, index) => [
        { role: 'assistant', content: null, tool_calls: [call(`older-${index}`, index)] },
        { role: 'tool', tool_call_id: `older-${index}`, content: 'history '.repeat(2000) },
      ]).flat(),
      { role: 'assistant', content: null, tool_calls: [pendingCall] },
    ];
    const snapshot = serialize(messages, { maxBytes: 100_000, preserveMessageIndices: [1] });
    assert.equal(snapshot.compacted, true);
    assert.deepEqual(snapshot.messages.at(-1).tool_calls, [pendingCall]);
    assert.equal(snapshot.messages.some(message => message.tool_call_id === 'pending'), false);
    assertPairedResults(snapshot.messages.slice(0, -1));
  });
}
