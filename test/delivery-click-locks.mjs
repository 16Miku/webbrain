// Delivery regressions (C6, C7) for the Chrome click_ax trusted fallback lock.
// [mocked transport] The real Agent fallback pipeline runs with the page
// observation, target resolution and CDP mouse transport stubbed; the stubs
// model a synthetic click that produced no observable change on an eligible
// generic target, so the single trusted fallback is considered.
// C6: a lost mousePressed acknowledgement may follow delivery, so it reserves
//     the one-shot lock and is never reported retryable.
// C7: an unresolved trusted click stays locked across the run boundaries of
//     trusted Continue / recovery Retry (same task token) and is released by
//     a new task. processMessage clears the per-run lock set at every run
//     boundary; the test performs exactly that clear.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => value, getManifest: () => ({ version: 'test' }) },
  tabs: { get: async () => ({ id: 42, url: 'https://locks.test/' }), query: async () => [{ id: 42 }], sendMessage: async () => ({}) },
};
globalThis.chrome = api;
globalThis.browser = api;
const { Agent } = await import('../src/chrome/src/agent/agent.js');
const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');

const syntheticResponse = () => ({
  success: true, method: 'click_ax', ref_id: 'ref_row', tag: 'div',
  _fallbackStateBefore: '{"full":"same"}', _fallbackStateAfterImmediate: '{"full":"same"}',
  _fallbackStrongStateBefore: '{"aria-current":"<absent>"}', _fallbackStrongStateAfterImmediate: '{"aria-current":"<absent>"}',
  _fallbackWeakStateBefore: '{"className":""}', _fallbackWeakStateAfterImmediate: '{"className":""}',
});

function lockFixture({ press = () => ({}), proved = false } = {}) {
  const agent = new Agent({});
  const events = [];
  let callStart = 0;
  agent._clickAxFinalSettleMs = () => 0;
  let observations = 0;
  agent._observeClickAxSideEffect = async () => {
    observations++;
    const prove = proved && events.slice(callStart).includes('mouseReleased');
    return { changed: prove, proved: prove, weakEvidence: false, safetyVeto: false, observable: true,
      reasons: prove ? ['url'] : [], proofReasons: prove ? ['url'] : [], weakReasons: [], safetyReasons: [],
      snapshot: '{"text":"same","active":""}' };
  };
  agent._captureClickAxObservation = async (_tab, snapshot, sideEffectWatch, startedAt) => ({ startedAt, snapshot, tabIds: '42', sideEffectWatch });
  agent._resolveClickAxFallbackTarget = async () => ({ success: true, fallbackEligible: true, documentToken: 'doc-1',
    ref_id: 'ref_row', tag: 'div', x: 100, y: 200, rect: { x: 50, y: 180, w: 100, h: 40 },
    fallbackState: '{"aria-current":"<absent>"}', fallbackStrongState: '{"aria-current":"<absent>"}', fallbackWeakState: '{"className":""}' });
  const saved = { attach: cdpClient.attach, arm: cdpClient.armFileInputClickGuard, consume: cdpClient.consumeFileInputClickGuard,
    dispatch: cdpClient.dispatchMouseEvent, sendCommand: cdpClient.sendCommand };
  cdpClient.attach = async () => ({});
  cdpClient.armFileInputClickGuard = async () => {};
  cdpClient.consumeFileInputClickGuard = async () => ({ blocked: false });
  cdpClient.sendCommand = async () => ({});
  cdpClient.dispatchMouseEvent = async (_tab, type) => {
    events.push(type);
    if (type === 'mousePressed') return press(events);
    return {};
  };
  const fallback = () => {
    callStart = events.length;
    return agent._maybeFallbackClickAxWithCdp(42, { ref_id: 'ref_row' }, syntheticResponse(),
      { snapshot: '{"text":"same"}', sideEffectWatch: { created: [], requests: [] } });
  };
  const restore = () => Object.assign(cdpClient, { attach: saved.attach, armFileInputClickGuard: saved.arm,
    consumeFileInputClickGuard: saved.consume, dispatchMouseEvent: saved.dispatch, sendCommand: saved.sendCommand });
  // processMessage clears the per-run lock set at each run boundary.
  const runBoundary = () => agent._clickAxCdpFallbacks.delete(42);
  return { agent, events, fallback, restore, runBoundary, observations: () => observations };
}

test('C6: a lost trusted press acknowledgement reserves the one-shot fallback and is not retryable', async () => {
  const f = lockFixture({ press: () => { throw new Error('Detached while handling command.'); } });
  try {
    const first = await f.fallback();
    assert.equal(first.success, false);
    assert.equal(first.dispatched, true);
    assert.equal(first.outcomeUnknown, true, 'the press may have reached the page');
    assert.equal(first.retryable, false);
    assert.equal(f.events.filter(type => type === 'mousePressed').length, 1);
    // The held button is cleared without completing a click on the target.
    assert.ok(f.events.includes('mouseReleased') === false, 'no target release was sent');
    const repeated = await f.fallback();
    assert.match(repeated.fallbackSkipped, /already attempted/);
    assert.equal(f.events.filter(type => type === 'mousePressed').length, 1, 'no second trusted press');
  } finally { f.restore(); }
});

test('C6: a press vetoed by the dispatch fence before sending stays retryable and unreserved', async () => {
  const veto = () => { throw Object.assign(new Error('The browser changed during action preparation.'), { code: 'page_feedback_pending' }); };
  const f = lockFixture({ press: veto });
  try {
    const first = await f.fallback();
    assert.equal(first.retryable, true);
    assert.notEqual(first.outcomeUnknown, true);
    assert.equal(f.agent._clickAxCdpFallbacks.get(42)?.size || 0, 0);
  } finally { f.restore(); }
});

test('C7: an unresolved trusted click stays locked across Continue/Retry of the same task; a new task may act again', async () => {
  const f = lockFixture();
  try {
    f.agent._taskTokens.set(42, 'task_original');
    const first = await f.fallback();
    assert.equal(first.trusted, true);
    assert.equal(first.verified, false, 'acknowledged input with no observed effect stays unresolved');
    assert.equal(f.events.filter(type => type === 'mousePressed').length, 1);

    // Trusted Continue / failure-recovery Retry: new run, same task token.
    f.runBoundary();
    const continued = await f.fallback();
    assert.match(continued.fallbackSkipped || '', /already attempted/, JSON.stringify(continued));
    assert.equal(f.events.filter(type => type === 'mousePressed').length, 1, 'no repeated trusted press after Continue/Retry');

    // The synthetic click_ax path is blocked for the same exact document|ref.
    const realFallback = f.agent._maybeFallbackClickAxWithCdp;
    f.agent._maybeFallbackClickAxWithCdp = async (_tab, _args, response) => response;
    let contentClicks = 0;
    api.tabs.sendMessage = async (_tab, message) => { if (message.action === 'click_ax') contentClicks++; return { success: true }; };
    const synthetic = await f.agent._dispatchClickAx(42, { ref_id: 'ref_row' }, { documentToken: 'doc-1', pageUrl: 'https://locks.test/' },
      null, {}, null, { started: false }, null);
    assert.equal(synthetic.noDispatch, true);
    assert.equal(synthetic.repeatBlocked, true);
    assert.equal(contentClicks, 0);
    // A re-rendered target or another document is not this lock.
    const otherRef = await f.agent._dispatchClickAx(42, { ref_id: 'ref_other' }, { documentToken: 'doc-1', pageUrl: 'https://locks.test/' },
      null, {}, null, { started: false }, null);
    assert.notEqual(otherRef.repeatBlocked, true);
    assert.equal(contentClicks, 1);
    f.agent._maybeFallbackClickAxWithCdp = realFallback;

    // A new task does not inherit the old task's locks.
    f.runBoundary();
    f.agent._taskTokens.set(42, 'task_new');
    await f.fallback();
    assert.equal(f.events.filter(type => type === 'mousePressed').length, 2);
  } finally { f.restore(); api.tabs.sendMessage = async () => ({}); }
});

test('C7: a verified trusted effect releases the task lock for later runs', async () => {
  const f = lockFixture({ proved: true });
  try {
    f.agent._taskTokens.set(42, 'task_verified');
    const first = await f.fallback();
    assert.equal(first.verified, true);
    f.runBoundary();
    await f.fallback();
    assert.equal(f.events.filter(type => type === 'mousePressed').length, 2, 'a reconciled click does not block a later decision');
  } finally { f.restore(); }
});
