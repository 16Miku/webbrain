import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { chromium } from 'playwright';

// A side panel behind another tab or app is hidden but alive: it keeps
// rendering live run events and polling run state, yet it never saves its chat.
// When it becomes visible again it restores the saved chat and relies on the
// run journal to replay what came after. These tests drive that hand-off with
// the real panel functions, the real journal and the real background state and
// acknowledgement handlers: a video generated while the panel was hidden must
// still be in the chat when the user comes back.

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: x => x, sendMessage: async () => ({}) } };

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const builds = await Promise.all(['chrome', 'firefox'].map(async build => ({
  build,
  Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
  journalModule: await import(`../src/${build}/src/run-ui-journal.js`),
  panelSource: (await fs.readFile(new URL(`../src/${build}/src/ui/sidepanel.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
  backgroundSource: (await fs.readFile(new URL(`../src/${build}/src/background.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
})));

function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, name);
  return source.slice(start, end + 2);
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, startMarker);
  return source.slice(start, end);
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(done => setTimeout(done, 10));
  }
  assert.fail(message);
}

let server, origin, browser;
before(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/__panel.html') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta charset="utf-8"><div id="messages"></div>');
      return;
    }
    try {
      const file = resolve(root, `.${path}`);
      if (!file.startsWith(root + sep)) throw new Error('outside root');
      res.setHeader('Content-Type', extname(file) === '.js' ? 'text/javascript' : 'text/plain');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await new Promise(done => (server ? server.close(done) : done()));
});

function backgroundFixture(build) {
  const tab = 91, request = 'hidden-panel-request', runId = 'hidden-panel-run';
  const agent = new build.Agent({ getActive: () => ({ name: 'owned', model: 'owned', config: {} }) });
  agent._persist = () => {};
  agent._runningTabs.add(tab);
  agent.currentRunId.set(tab, runId);
  agent.getConversationState = async () => ({ conversationId: 'hidden-panel-conversation' });
  agent.hasDurableSubmittedTurn = async () => true;
  const journal = new build.journalModule.RunUiJournal();
  journal.begin(tab, request, { mode: 'act' });
  // storage.session copy of the tab chat. The handoff coordinator orders writes
  // between panel documents; with a single document it is just this copy.
  const session = { html: null };
  let deliver = async () => {};
  let delivery = Promise.resolve();
  const context = vm.createContext({
    agent, runUiJournal: journal,
    recordRunUiEvent: (tabId, requestId, type, data) => journal.record(tabId, requestId, type, data, agent.currentRunId.get(tabId)),
    notifyPlanReview() {}, clearPlanReviewAttention() {}, planReviewAttentionByTab: new Map(),
    chrome: { runtime: { sendMessage: msg => (delivery = delivery.then(() => deliver(structuredClone(msg)))) } },
    detachedRunStarts: new Map(), detachedRunFailures: new Map(), runUiPersistenceFailures: new Map(),
    getRunUiSnapshot: async tabId => journal.get(tabId), runUiSnapshotForRequest: build.journalModule.runUiSnapshotForRequest,
    console, Date, structuredClone,
  });
  context.browser = context.chrome;
  const handlers = between(build.backgroundSource, "    case 'agent_run_state': {", "    case 'get_scratchpad': {");
  vm.runInContext(`${extract(build.backgroundSource, 'sendAgentUpdate')}
async function handle(msg, sender = {}) { switch (msg.action) { ${handlers} } }`, context);
  return {
    tab, request, runId, journal, session,
    connect(fn) { deliver = fn; },
    async emit(type, data) {
      context.sendAgentUpdate(tab, request, type, data);
      await delivery;
    },
    async finish(finalContent) {
      agent._runningTabs.delete(tab);
      const snapshot = journal.finish(tab, request, 'completed', finalContent, runId);
      // The terminal broadcast of sendAgentRunComplete.
      context.chrome.runtime.sendMessage({
        target: 'sidepanel', action: 'agent_update', tabId: tab, requestId: request, runId, seq: snapshot.seq, type: 'run_complete',
        data: { status: snapshot.status, finalContent: snapshot.finalContent, quota: null, endedAt: snapshot.endedAt, submittedTurnDurable: true, attachmentDeliveryState: '' },
      });
      await delivery;
    },
    async rpc(action, data) {
      if (action === 'persist_tab_chat') { session.html = data.html; return { ok: true }; }
      if (action === 'load_tab_chat') return session.html == null ? { found: false } : { found: true, html: session.html };
      if (action === 'agent_run_state' || action === 'agent_run_ack') return context.handle({ ...data, action });
      throw new Error(`Unexpected panel request: ${action}`);
    },
  };
}

const PANEL_FUNCTIONS = [
  'handleAgentUpdateMessage', 'ensureCurrentRunAssistant', 'applyActiveRunState', 'restoreActiveRunState',
  'restorePendingCurrentClarification', 'invalidateUnresolvedClarifyCards', 'isTerminalRunUiStatus', 'isFinishedRunUiStatus',
  'addRunProgressReplayGapNote', 'getOrCreateStepsContainer', 'isTerminalDoneTool', 'sameTabId',
  'schedulePersist', 'persistTabChat', 'enqueueTabChatOperation', 'loadTabChat', 'waitForHistoryRecovery',
  'refreshVisibleSidePanelState', 'requestVisibleSidePanelStateRefresh',
];

async function panelFixture(build, bg) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('panelRpc', (action, data) => bg.rpc(action, data));
  await page.goto(`${origin}/__panel.html`);
  const functions = PANEL_FUNCTIONS.map(name => extract(build.panelSource, name)).join('\n');
  // Anonymous, so it is found by its hidden-branch opening.
  const listener = `${between(build.panelSource,
    "document.addEventListener('visibilitychange', () => {\n  if (document.visibilityState === 'hidden') {\n    visibleStateRefreshPending = false;",
    '\n});')}\n});`;
  const asset = await page.evaluate(async ({ build, functions, listener, tab, request }) => {
    const { appendGeneratedMedia, restoreGeneratedMedia } = await import(`/src/${build}/src/ui/generated-media-view.js`);
    const { storeGeneratedMedia } = await import(`/src/${build}/src/generated-media-store.js`);
    const { runUiUnavailableBeforeSeq } = await import(`/src/${build}/src/run-ui-journal.js`);
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    const messagesEl = document.querySelector('#messages');
    messagesEl.innerHTML = `<div class="message user" data-run-request-id="${request}"><div class="message-content"><div class="message-text">use your generative features to do it</div></div></div>`
      + `<div class="message assistant" data-run-request-id="${request}" data-last-rendered-seq="0"><div class="message-content"><div class="message-text"></div></div></div>`;
    const noop = () => {};
    const asyncNoop = async () => {};
    const t = key => key;
    Object.assign(window, {
      t, messagesEl, currentTabId: tab, renderedTabId: tab, currentAssistantEl: messagesEl.querySelector('.message.assistant'),
      verboseMode: false, activityDisplayMode: null,
      localRunRequestIds: new Map([[tab, request]]), clearedConversationRunRequestIds: new Set(), cancelledRunRecoveryRequestIds: new Set(),
      failedConversationClearRecoveryTabs: new Set(), historyRecoveryTabs: new Set(), streamedAssistantTextByEl: new WeakMap(),
      tabChats: new Map(), tabChatOperations: new Map(), tabChatHandoffGenerations: new Map(), tabChatHandoffOwnerId: 'hidden-panel-owner',
      TAB_CHAT_LOAD_FAILED: Symbol('tab-chat-load-failed'), tabSwitchTransitionId: null,
      persistTimer: null, persistTimerTabId: null, lastVisibleTabChatSnapshot: null,
      visibleStateRefreshPending: false, visibleStateRefreshInProgress: false, visibleStateRefreshGeneration: 0,
      visibleStateRefreshPromise: Promise.resolve(),
      appendGeneratedMedia, runUiUnavailableBeforeSeq,
      // A restored chat rehydrates its stored media (rebindRestoredMessageControls).
      rebindRestoredMessageControls: () => { void restoreGeneratedMedia(messagesEl, t); },
      sendToBackground: (action, data) => window.panelRpc(action, data),
      refreshConversationScopeState: tabId => window.panelRpc('agent_run_state', { tabId }),
      normalizePlanReviewTabId: Number, isConversationClearInProgress: () => false, isTabAbortRequested: () => false,
      adoptRestoredRunState: asyncNoop, reclaimUnappliedSteering: asyncNoop, recoverActiveRunAfterFailedConversationClear: asyncNoop,
      hydrateRestoredChatHistory: asyncNoop, waitForTabChatHandoffRetry: asyncNoop, consumePendingContextMenuPrompt: asyncNoop,
      reconcilePersistedStagedScreenshots: asyncNoop, newtabHandoff: { consume: asyncNoop },
      scheduleHistoryPersist: noop, refreshRenderedStepLabels: noop, syncProgressDisplayMode: noop,
      migrateLegacyEmptyStateFromRestoredChat: noop, drainQueuedContextMenuPrompts: noop, syncSendButtonState: noop,
      showActivity: noop, hideActivity: noop, startThinkingActivity: noop, clearThinkingActivityTimers: noop,
      beginThinkingActivity: noop, showInspectionBanner: noop, clearTransientAssistantTextForToolCall: noop,
      friendlyToolLabel: name => name, markLastStepDone: noop, finalizeSteps: noop, setMessageCreatedAt: noop,
      reconcileRunMessageAttachmentState: noop, invalidatePlanReviewCards: noop, setPlanReviewAwaiting: noop,
      clearPlanReviewActiveRun: noop, reconcileFailureRecoveryCards: noop, setTabProcessing: noop,
      setTabAbortRequested: noop, hideRecommendedActions: noop, holdQueuedComposerMessages: noop,
      resetChatNavigation: noop, clearClarifyCountdown: noop, scrollToBottom: noop, addMessageCopyButton: noop,
      clearAssistantTextStreamState: noop, isPlanReviewTimeoutTerminal: () => false, parseCostAllowanceError: () => null,
      renderCostAllowanceError: () => false, renderSubscribeError: () => false,
      getStreamedAssistantText: () => '', hasStreamedAssistantText: () => false,
      activeRetryPayloadForRequest: () => null, retryPayloadForRunAssistant: () => null,
      formatMarkdown: text => { const node = document.createElement('p'); node.textContent = String(text); return node.outerHTML; },
      appendCompactStep: name => {
        const step = document.createElement('div');
        step.className = 'step-item';
        step.dataset.tool = name;
        window.getOrCreateStepsContainer().appendChild(step);
      },
      addMessage: () => { throw new Error('The run already has its assistant message.'); },
    });
    (0, eval)(`${functions}\n${listener}`);
    // persistObserver: every rendered change schedules a chat save.
    new MutationObserver(() => window.schedulePersist())
      .observe(messagesEl, { childList: true, subtree: true, characterData: true });
    window.setPanelHidden = value => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
    return storeGeneratedMedia(`data:video/mp4;base64,${btoa('synthetic mp4 bytes')}`);
  }, { build: build.build, functions, listener, tab: bg.tab, request: bg.request });
  bg.connect(msg => page.evaluate(msg => window.handleAgentUpdateMessage(msg), msg));
  return {
    page, asset, errors,
    // One tick of runDetachedWithReconnect's state poll for the local run.
    async poll() {
      const state = await bg.rpc('agent_run_state', { tabId: bg.tab, requestId: bg.request });
      return page.evaluate(state => window.applyActiveRunState(window.currentTabId, state), state);
    },
    setHidden: value => page.evaluate(async value => {
      window.setPanelHidden(value);
      await window.visibleStateRefreshPromise;
    }, value),
    close: () => context.close(),
  };
}

for (const build of builds) {
  test(`${build.build}: a video generated while the side panel was hidden is still in the chat on return`, async () => {
    const bg = backgroundFixture(build);
    const panel = await panelFixture(build, bg);
    try {
      await bg.emit('tool_call', { name: 'generate_image', args: { prompt: 'An instructional video about the nested set model' } });
      await panel.poll();
      const visibleAck = bg.journal.get(bg.tab).ackedSeq;
      assert.equal(visibleAck, bg.journal.get(bg.tab).seq, 'a visible panel releases the events it rendered');

      // The user switches away while the video renders.
      await panel.setHidden(true);
      await waitFor(() => bg.session.html?.includes(`data-last-rendered-seq="${visibleAck}"`), 'the panel saves its last visible chat when hidden');
      const savedChat = bg.session.html;

      await bg.emit('tool_result', {
        name: 'generate_image',
        result: { success: true, provider: 'openrouter', model: 'test/video-model', ...panel.asset },
      });
      await panel.poll();
      await bg.emit('tool_call', { name: 'done', args: { summary: 'The video is ready.' } });
      await bg.emit('tool_result', { name: 'done', result: { done: true, summary: 'The video is ready.', outcome: 'success' } });
      await bg.finish('The video is ready.');
      await panel.poll();
      assert.equal(await panel.page.locator('.generated-media').count(), 1, 'the hidden panel rendered the video live');
      assert.equal(bg.session.html, savedChat, 'a hidden panel never saves its chat');
      const ackedWhileHidden = bg.journal.get(bg.tab).ackedSeq;

      // The user comes back: the panel restores the saved chat and replays the rest.
      await panel.setHidden(false);
      const video = panel.page.locator(
        `.message.assistant[data-run-request-id="${bg.request}"] .generated-media[data-media-id="${panel.asset.mediaId}"] video`);
      await video.waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
      assert.equal(await video.count(), 1, 'the generated video is still in the chat');
      assert.equal(await panel.page.locator('.run-progress-replay-gap-note').count(), 0, 'no progress was lost while the panel was hidden');
      assert.match(await panel.page.locator('.message.assistant .message-text').innerText(), /The video is ready\./);
      assert.equal(ackedWhileHidden, visibleAck, 'a hidden panel keeps the events it could not save for the visible replay');
      assert.equal(bg.journal.get(bg.tab).ackedSeq, bg.journal.get(bg.tab).seq, 'the visible panel releases the replayed events');
      assert.equal(bg.journal.get(bg.tab).events.length, 0);
      assert.deepEqual(panel.errors, []);
    } finally { await panel.close(); }
  });
}
