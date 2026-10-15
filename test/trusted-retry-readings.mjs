// Chrome's click_ax may send one trusted click to a generic element whose
// synthetic click changed nothing visible. Whether that second click could act
// twice or undo itself (a send, delete, like, follow or download) is read from
// the element's name by a model in any language (the control_repeat question),
// not matched against a word list in the page. Page structure still rules out
// native, form, stateful, download and covered targets before any reading.
// [mocked transport] The real Agent fallback pipeline runs with the page
// observation, target resolution and CDP mouse transport stubbed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureControlRepeatReading, stubPageTextReadings } from './semantic-decision-stub.mjs';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => value, getManifest: () => ({ version: 'test' }) },
  tabs: { get: async () => ({ id: 42, url: 'https://rows.test/' }), query: async () => [{ id: 42 }], sendMessage: async () => ({}) },
};
globalThis.chrome = api;
globalThis.browser = api;
const { Agent } = await import('../src/chrome/src/agent/agent.js');
const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');

const response = (name, extra = {}) => ({
  success: true, method: 'click_ax', ref_id: 'ref_row', tag: 'div', _fallbackName: name,
  _fallbackStateBefore: '{"full":"same"}', _fallbackStateAfterImmediate: '{"full":"same"}',
  _fallbackStrongStateBefore: '{"aria-current":"<absent>"}', _fallbackStrongStateAfterImmediate: '{"aria-current":"<absent>"}',
  _fallbackWeakStateBefore: '{"className":""}', _fallbackWeakStateAfterImmediate: '{"className":""}', ...extra,
});

function retryFixture({ read = (kind, item) => (kind === 'control_repeat' ? fixtureControlRepeatReading(item.text) : null),
  settledName = null, syntheticEffect = false } = {}) {
  const agent = new Agent({});
  const asked = stubPageTextReadings(agent, read);
  const events = [];
  agent._clickAxFinalSettleMs = () => 0;
  agent._observeClickAxSideEffect = async () => {
    const proved = syntheticEffect || events.includes('mouseReleased');
    return { changed: proved, proved, weakEvidence: false, safetyVeto: false, observable: true,
      reasons: proved ? ['url'] : [], proofReasons: proved ? ['url'] : [], weakReasons: [], safetyReasons: [],
      snapshot: '{"text":"same","active":""}' };
  };
  agent._captureClickAxObservation = async (_tab, snapshot, sideEffectWatch, startedAt) => ({ startedAt, snapshot, tabIds: '42', sideEffectWatch });
  let resolved = 0;
  agent._resolveClickAxFallbackTarget = async () => {
    resolved += 1;
    return { success: true, fallbackEligible: true, documentToken: 'doc-1', ref_id: 'ref_row', tag: 'div',
      name: settledName ?? agent.__clickedName, x: 100, y: 200, rect: { x: 50, y: 180, w: 100, h: 40 },
      fallbackState: '{"aria-current":"<absent>"}', fallbackStrongState: '{"aria-current":"<absent>"}', fallbackWeakState: '{"className":""}' };
  };
  const saved = { attach: cdpClient.attach, arm: cdpClient.armFileInputClickGuard, consume: cdpClient.consumeFileInputClickGuard,
    dispatch: cdpClient.dispatchMouseEvent, sendCommand: cdpClient.sendCommand };
  cdpClient.attach = async () => ({});
  cdpClient.armFileInputClickGuard = async () => {};
  cdpClient.consumeFileInputClickGuard = async () => ({ blocked: false });
  cdpClient.sendCommand = async () => ({});
  cdpClient.dispatchMouseEvent = async (_tab, type) => { events.push(type); return {}; };
  const click = (name, extra = {}) => {
    agent.__clickedName = name;
    return agent._maybeFallbackClickAxWithCdp(42, { ref_id: 'ref_row' }, response(name, extra),
      { snapshot: '{"text":"same"}', sideEffectWatch: { created: [], requests: [] } });
  };
  const restore = () => Object.assign(cdpClient, { attach: saved.attach, armFileInputClickGuard: saved.arm,
    consumeFileInputClickGuard: saved.consume, dispatchMouseEvent: saved.dispatch, sendCommand: saved.sendCommand });
  return { agent, asked, events, click, restore, resolved: () => resolved };
}

test('a name a model reads as acting again is not clicked a second time, in any language', async () => {
  for (const name of ['Fiók törlése', 'Radera konto', 'Διαγραφή λογαριασμού', 'Hesabı sil', 'Send message', 'メッセージを送信']) {
    const f = retryFixture();
    try {
      const result = await f.click(name);
      assert.equal(result.success, true, `${name}: the synthetic click itself was sent`);
      assert.equal(result.trusted, false, name);
      assert.equal(result.verified, false, name);
      assert.match(result.fallbackSkipped || '', /potentially mutating/, name);
      assert.deepEqual(f.events, [], `${name}: no trusted input`);
      assert.deepEqual(f.asked.map(item => [item.kind, item.text]), [['control_repeat', name]], name);
    } finally { f.restore(); }
  }
});

test('a name read as harmless or unclear, or left unread, keeps the one trusted retry', async () => {
  const readers = [
    ['harmless', () => 'harmless'], ['unclear', () => 'unclear'], ['unread', () => null],
    ['failing', () => { throw Object.assign(new Error('budget'), { code: 'WB_COST_ALLOWANCE' }); }],
  ];
  for (const [label, read] of readers) {
    for (const name of ['Defne Sokullu Yesterday Photo', 'Order history', 'Ayarlar']) {
      const f = retryFixture({ read: (kind) => (kind === 'control_repeat' ? read() : null) });
      try {
        const result = await f.click(name);
        assert.deepEqual(f.events, ['mouseMoved', 'mousePressed', 'mouseReleased'], `${label}: ${name}`);
        assert.equal(result.trusted, true, `${label}: ${name}`);
        assert.equal(result.fallbackAttempted, true, `${label}: ${name}`);
      } finally { f.restore(); }
    }
  }
});

test('the name is read once, only after the first click showed no effect, and an unnamed element is not read', async () => {
  const f = retryFixture();
  try {
    await f.click('Fiók törlése');
    assert.equal(f.resolved(), 2, 'the target is resolved before and after the page settles');
    assert.equal(f.asked.length, 1, 'one reading serves both');
  } finally { f.restore(); }

  const worked = retryFixture({ syntheticEffect: true });
  try {
    const result = await worked.click('Gönder');
    assert.equal(result.verified, true);
    assert.deepEqual(worked.asked, [], 'a click that worked needs no reading');
    assert.deepEqual(worked.events, []);
  } finally { worked.restore(); }

  const unnamed = retryFixture();
  try {
    await unnamed.click('');
    assert.deepEqual(unnamed.asked, []);
    assert.deepEqual(unnamed.events, ['mouseMoved', 'mousePressed', 'mouseReleased']);
  } finally { unnamed.restore(); }

  // The element the trusted click would reach is the one whose name decides.
  const renamed = retryFixture({ settledName: 'Hesabı sil' });
  try {
    const result = await renamed.click('Ayarlar');
    assert.match(result.fallbackSkipped || '', /potentially mutating/);
    assert.deepEqual(renamed.asked.map(item => item.text).sort(), ['Ayarlar', 'Hesabı sil']);
    assert.deepEqual(renamed.events, []);
  } finally { renamed.restore(); }
});

test('page structure still rules a target out before any reading', async () => {
  const f = retryFixture();
  try {
    const result = await f.click('Ayarlar', { _fallbackStaticBlockedReason: 'form controls must not be auto-retried' });
    assert.equal(result.trusted, false);
    assert.match(result.fallbackSkipped || '', /form controls/);
    assert.deepEqual(f.asked, []);
    assert.deepEqual(f.events, []);
  } finally { f.restore(); }
});
