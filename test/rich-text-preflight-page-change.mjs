import assert from 'node:assert/strict';
import { test } from 'node:test';

// Chrome resolves a type_text selector through the trusted CDP resolver
// before the call is validated, and that resolver's scroll is fenced. On a
// page that keeps updating by itself (X's timeline behind the composer) the
// fence refuses it before anything is typed. That refusal used to be reported
// as "the trusted selector resolver could not attach ... DevTools is open",
// which sent the model looking for a cause that did not exist. It must say
// that the page changed and point to typing by reference.
const PAGE_URL = 'https://x.com/compose/post';
const SELECTOR = 'div[role="textbox"][aria-label="Post text"]';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const contentProbe = { resolved: true, refId: '', documentToken: 'content-1', refScopeUrl: PAGE_URL,
  rect: { x: 300, y: 160, w: 516, h: 96, pageX: 300, pageY: 160 },
  fieldMeta: { tag: 'div', role: 'textbox', contentEditable: true }, toolbarContext: false, toolbarRegionRef: '' };
const contentMessages = [];
let contentResolved = true;
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: PAGE_URL, title: 'Compose post' }),
    sendMessage: async (_id, message) => {
      contentMessages.push(message.action);
      if (message.action !== 'probe_rich_text_toolbar_retry_target') return { ready: true };
      return contentResolved ? structuredClone(contentProbe) : { resolved: false };
    },
  },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;

const { Agent } = await import('../src/chrome/src/agent/agent.js');
const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
let nextTab = 8100;

async function preflight({ attach, churn = true }) {
  const tab = nextTab++, commands = [];
  const agent = new Agent({ getActive: () => null, getProvider: () => null, getVisionProvider: async () => null });
  const original = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand };
  contentMessages.length = 0;
  cdpClient.attach = attach;
  // The real resolver runs; only the protocol transport is replaced.
  cdpClient.sendCommand = async (_tab, method) => {
    commands.push(method);
    if (method === 'Runtime.evaluate') return { result: { value: { found: true, x: 558, y: 208, width: 516, height: 96, inViewport: true, hitOk: true, tag: 'DIV', type: '' } } };
    return {};
  };
  agent._runningTabs.add(tab);
  await agent._beginPageFeedbackRun(tab, 'act');
  const from = { tab: { id: tab }, frameId: 0, documentId: 'document-1', url: PAGE_URL };
  const state = agent.pageMonitorState(from, 'content-1');
  assert.equal(state.active, true);
  // A feed item arrives: automatic page activity, no user involved.
  if (churn) assert.equal(agent.observePageFeedback(from, { ...state, seq: 1, revision: 1, kind: 'dom', source: 'page', target: 'div#timeline' }).accepted, true);
  try {
    const result = await agent._preflightRichTextToolbarTarget(tab, 'type_text', { selector: SELECTOR, text: 'Owned QA support is coming soon' }, { supportsVision: false });
    return { result, commands };
  } finally {
    cdpClient.attach = original.attach;
    cdpClient.sendCommand = original.sendCommand;
    agent._finishPageFeedbackRun(tab);
    agent._runningTabs.delete(tab);
  }
}

for (const resolved of [true, false]) test(`Chrome: selector typing refused because the page changed says so, not that DevTools is open${resolved ? '' : ' (content probe unresolved)'}`, async () => {
  contentResolved = resolved;
  const { result, commands } = await preflight({ attach: async () => {} }).finally(() => { contentResolved = true; });
  const block = result.block;
  assert.ok(block, JSON.stringify(result));
  assert.equal(block.success, false);
  assert.equal(block.dispatched, false);
  assert.equal(block.noDispatch, true);
  assert.doesNotMatch(block.error, /DevTools|could not attach|Re-read the page and retry/);
  assert.match(block.error, /page changed while WebBrain was locating/);
  assert.match(block.error, /nothing was typed/);
  assert.match(block.error, /type_ax/);
  assert.match(block.error, /ref_id/);
  // Repeating the same selector call meets the same fence.
  assert.equal(block.retryable, undefined);
  // The fence refused before the resolver touched the page.
  assert.deepEqual(commands, ['Runtime.enable']);
  assert.equal(commands.some(method => method.startsWith('Input.')), false);
  assert.ok(contentMessages.includes('probe_rich_text_toolbar_retry_target'));
});

test('Chrome: a resolver that cannot attach still reports the attach failure', async () => {
  const { result, commands } = await preflight({ attach: async () => { throw new Error('Another debugger is already attached to the tab with id: 1.'); } });
  const block = result.block;
  assert.ok(block, JSON.stringify(result));
  assert.equal(block.noDispatch, true);
  assert.match(block.error, /could not attach to this tab/);
  assert.doesNotMatch(block.error, /page changed while/);
  assert.equal(block.retryable, undefined);
  assert.deepEqual(commands, []);
});

test('Chrome: on a settled page the trusted resolver still binds the selector target', async () => {
  const { result, commands } = await preflight({ attach: async () => {}, churn: false });
  // Field inspection is a protocol call this transport answers with nothing,
  // so the probe is unresolved; what matters is that no fence refused it.
  assert.ok(commands.includes('Runtime.evaluate'), JSON.stringify(commands));
  assert.doesNotMatch(String(result.block?.error || ''), /page changed while|DevTools/);
});
