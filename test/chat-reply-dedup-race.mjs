import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const w = await import(`../src/${build}/src/agent/chat-workflow.js`);
  const nativeKey = 'dom:telegram:k:123456:0';
  const snapshot = (threadKey, messages) => ({ threadKey, composer: { available: true, empty: true }, messages });
  const incoming = (id, text = 'Can you confirm?') => ({ id, direction: 'incoming', text });
  const outgoing = (id, text = 'ok') => ({ id, direction: 'outgoing', text });
  function race(native = true) {
    const threadKey = native ? nativeKey : 'dom:whatsapp:owned-qa';
    const ids = native ? ['telegram:k:123456:0:1:raaaaaaaa', 'telegram:k:123456:0:2:rbbbbbbbb',
      'telegram:k:123456:0:3', 'telegram:k:123456:0:4'] : ['owned-question-1', 'owned-question-2', 'owned-reply-1', 'owned-reply-2'];
    const first = snapshot(threadKey, [incoming(ids[0])]);
    const observed = w.advanceChatSession(w.createChatSession(), first);
    const decision = w.decideChatSend(observed.session, first, 'ok');
    assert.equal(decision.ok, true);
    const pending = w.markChatSendPending(observed.session, decision);
    const nextQuestion = snapshot(threadKey, [...first.messages, incoming(ids[1])]);
    assert.equal(w.decideChatSend(w.advanceChatSession(pending, nextQuestion).session, nextQuestion, 'ok').reason, 'send_pending');
    const delivered = snapshot(threadKey, [...nextQuestion.messages, outgoing(ids[2])]);
    const result = w.advanceChatSession(pending, delivered);
    assert.equal(result.session.pendingOutbound, null);
    assert.ok(result.newMessages.some(message => message.id === ids[1]));
    return { threadKey, ids, first, decision, delivered, result };
  }

  for (const native of [true, false]) test(`${build}: ${native ? 'native Telegram' : 'generic WhatsApp'} delayed reply keeps its original question anchor across restart`, () => {
    const r = race(native);
    assert.equal(w.decideChatSend(r.result.session, r.delivered, 'ok').ok, true,
      'A reply to question one that arrives after question two cannot consume question two.');
    const saved = w.serializeChatSession(r.result.session);
    const restored = w.normalizeChatSession(JSON.parse(JSON.stringify(saved)));
    assert.equal(w.decideChatSend(restored, r.delivered, 'ok').ok, true);
    assert.equal(w.decideChatSend(restored, r.delivered, 'A different useful reply.').ok, true);
    const firstOnly = snapshot(r.threadKey, [incoming(r.ids[0]), outgoing(r.ids[2])]);
    assert.equal(w.decideChatSend(restored, firstOnly, 'ok').reason, 'already_sent', 'The original verified question still cannot be answered twice.');
    const second = w.decideChatSend(restored, r.delivered, 'ok');
    assert.notEqual(second.messageKey, r.decision.messageKey);
    const pending = w.markChatSendPending(restored, second);
    assert.equal(w.decideChatSend(pending, r.delivered, 'ok').reason, 'send_pending');
    const both = snapshot(r.threadKey, [...r.delivered.messages, outgoing(r.ids[3])]);
    const complete = w.advanceChatSession(pending, both);
    assert.equal(complete.session.pendingOutbound, null);
    assert.equal(w.decideChatSend(complete.session, both, 'ok').reason, 'already_sent');
    assert.equal(complete.session.deliveredReplyBindings.length, 2);
    assert.equal(w.advanceChatSession(complete.session, both).session.deliveredReplyBindings.length, 2,
      'Repeated observations must not create duplicate delivery provenance.');
  });

  test(`${build}: remounted old native outgoing bubbles cannot consume a fresh question after 200 retained bindings`, () => {
    const r = race(); let session = r.result.session, rows = [...r.delivered.messages], id = 3;
    for (let turn = 2; turn <= 220; turn++) {
      if (turn > 2) rows.push(incoming(`telegram:k:123456:0:${++id}:raaaaaaaa`));
      const current = snapshot(nativeKey, rows);
      session = w.advanceChatSession(session, current).session;
      const send = w.decideChatSend(session, current, 'ok'); assert.equal(send.ok, true, `turn ${turn}`);
      session = w.markChatSendPending(session, send);
      rows.push(outgoing(`telegram:k:123456:0:${++id}`));
      session = w.advanceChatSession(session, snapshot(nativeKey, rows)).session;
      session = w.normalizeChatSession(JSON.parse(JSON.stringify(w.serializeChatSession(session))));
      assert.equal(w.decideChatSend(session, snapshot(nativeKey, rows), 'ok').reason, 'already_sent');
    }
    assert.equal(session.deliveredReplyBindings.length, 200);
    assert.equal(session.seenMessageIds.length, 200); assert.ok(session.sentMessageKeys.length <= 200);
    assert.equal(session.deliveredReplyBindings.some(binding => binding.messageId === r.ids[2]), false);
    rows.push(incoming(`telegram:k:123456:0:${++id}:rbbbbbbbb`));
    // A virtual list may mount an old native row after the current question.
    // Its monotonic ID, rather than DOM order, still places it in the past.
    rows.push(outgoing(r.ids[2]));
    const current = snapshot(nativeKey, rows);
    const fresh = w.advanceChatSession(session, current);
    assert.equal(fresh.newMessages.filter(message => message.direction === 'incoming').length, 1);
    assert.equal(fresh.newMessages.filter(message => message.direction === 'outgoing').length, 0);
    assert.equal(w.decideChatSend(fresh.session, current, 'ok').ok, true);
  });

  test(`${build}: old native IDs and ambiguous outgoing receipts cannot mint original-question provenance`, () => {
    const first = snapshot(nativeKey, [incoming('telegram:k:123456:0:10:raaaaaaaa')]);
    const observed = w.advanceChatSession(w.createChatSession(), first);
    const pending = w.markChatSendPending(observed.session, w.decideChatSend(observed.session, first, 'ok'));
    const old = snapshot(nativeKey, [...first.messages, outgoing('telegram:k:123456:0:2')]);
    const stale = w.advanceChatSession(pending, old);
    assert.ok(stale.session.pendingOutbound); assert.equal(stale.session.deliveredReplyBindings?.length || 0, 0);
    const multiple = snapshot(nativeKey, [...first.messages, incoming('telegram:k:123456:0:11:rbbbbbbbb'),
      outgoing('telegram:k:123456:0:12'), outgoing('telegram:k:123456:0:13')]);
    const ambiguous = w.advanceChatSession(pending, multiple);
    assert.equal(ambiguous.session.deliveredReplyBindings?.length || 0, 0,
      'Two possible receipts cannot be assigned to the one original pending action.');
    assert.equal(w.decideChatSend(ambiguous.session, multiple, 'ok').reason, 'already_sent');
  });

  test(`${build}: delivery provenance does not ignore edited bodies, another peer or malformed persisted bindings`, () => {
    const r = race(), saved = w.serializeChatSession(r.result.session);
    const edited = snapshot(nativeKey, r.delivered.messages.map(message => message.id === r.ids[2]
      ? { ...message, text: 'Different visible reply.' } : message));
    assert.equal(w.decideChatSend(saved, edited, 'Different visible reply.').reason, 'already_sent',
      'An ID binding must also match the original message body before it can exclude a duplicate.');
    const other = w.normalizeChatSession({ ...saved, threadKey: 'dom:telegram:k:654321:0' });
    assert.equal(other.deliveredReplyBindings?.length || 0, 0);
    const malformed = w.normalizeChatSession({ ...saved, deliveredReplyBindings: [
      ...saved.deliveredReplyBindings, { messageId: '', replyAnchor: 'other', messageKey: 'bad', threadKey: nativeKey },
      { messageId: 'unbounded', replyAnchor: 'other', messageKey: 'chatout_12345678', threadKey: 'another-peer' },
      { ...saved.deliveredReplyBindings[0], replyAnchor: 'telegram:k:654321:0:1:raaaaaaaa' },
      { ...saved.deliveredReplyBindings[0], nativeMessageFloor: '3' },
    ] });
    assert.equal(malformed.deliveredReplyBindings.length, 1);
    assert.equal(JSON.stringify(malformed.deliveredReplyBindings).includes('Different visible reply.'), false,
      'Persisted provenance stores bounded IDs and a key, never message text.');
  });
}
