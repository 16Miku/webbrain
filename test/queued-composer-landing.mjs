import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// A message queued during a run starts when that run ends, but only if the
// panel shows the run's tab at that moment (drainQueuedPromptsAfterRunSettles
// needs the tab on screen). When it ended while the panel followed another
// tab, or was hidden, the message has to start when the panel lands on the
// tab again: on every activation for it, when the panel becomes visible, and
// when a finishing run hands corrections back late. The production queue,
// drain, tab-switch and visibility functions run verbatim; only browser and
// background boundaries are stubbed.

const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const RETRY_MS = 20;
const QUEUED = 'publish 45.0.0 to mozilla amo';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `Missing production function ${name}`);
  return source.slice(start, end + 2);
}

function between(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Missing anchor: ${from}`);
  return source.slice(start, end);
}

function panel(build, { currentTabId = 1, renderedTabId = currentTabId, queue = [{ id: 'q1', text: QUEUED }] } = {}) {
  const source = fs.readFileSync(new URL(`../src/${build}/src/ui/sidepanel.js`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const sent = [];
  const background = { running: false, runStateProbes: 0 };
  const restoreGates = [];
  const context = vm.createContext({
    console, Promise, Map, Set, Number, String, Symbol, setTimeout, clearTimeout,
    sent, background, restoreGates,
    currentTabId, renderedTabId, isProcessing: false, abortRequested: false,
    processingTabs: new Set(), abortRequestedTabs: new Set(),
    tabSwitchGeneration: 0, tabSwitchTransitionId: null, queuedTabSwitchMessages: [],
    historyRecoveryTabs: new Set(), historyPopover: null, newConversationConfirmationState: null,
    currentAssistantEl: null, TAB_CHAT_LOAD_FAILED: Symbol('tab-chat-load-failed'),
    visibleStateRefreshPending: false, visibleStateRefreshInProgress: false,
    visibleStateRefreshGeneration: 0, visibleStateRefreshPromise: Promise.resolve(),
    document: { visibilityState: 'visible' },
    messagesEl: { innerHTML: '', querySelectorAll: () => [] },
    inputEl: { value: '' },
    tabInputDrafts: new Map(), permissionSkipCommandContextsByTab: new Map(),
    steeringRequestsByTab: new Map(), queuedSteeringMessageIds: new Set(),
    queuedComposerMessagesByTab: new Map(queue.length ? [[1, structuredClone(queue)]] : []),
    QUEUED_PROMPT_DRAIN_RETRY_MS: RETRY_MS, queuedPromptDrainRetryTimers: new Map(),
    newtabHandoff: { consume: async () => {} },
    sendToBackground: async (action) => {
      if (action === 'agent_run_state') {
        background.runStateProbes += 1;
        return { ok: true, running: background.running, starting: false };
      }
      return { ok: true };
    },
    // The real restore reads the tab's run journal from the background; a
    // test can hold it open to let another activation arrive meanwhile.
    restoreActiveRunState: async () => { const gate = restoreGates.shift(); if (gate) await gate.promise; },
    loadTabChat: async tabId => `chat ${tabId}`,
    hydrateRestoredChatHistory: async () => {},
    refreshVisibleSidePanelState: async () => true,
    waitForTabChatHandoffRetry: async () => {},
    consumePendingContextMenuPrompt: async () => {},
    hasQueuedContextMenuPromptForTab: () => false,
    isConversationClearInProgress: () => false,
    isPermissionSkipCommandDraft: () => false,
    isTabProcessing: tabId => context.processingTabs.has(Number(tabId)),
    isTabAbortRequested: tabId => context.abortRequestedTabs.has(Number(tabId)),
    // Like the real send, an accepted queued submission leaves the queue and the composer.
    sendMessage: async (params) => {
      const item = params.__queuedComposerMessage;
      sent.push(item ? { tabId: item.tabId, text: item.text } : { text: context.inputEl.value });
      if (item) context.removeQueuedComposerMessage(item.tabId, item.id);
      context.inputEl.value = '';
      delete context.inputEl.queuedComposerSubmission;
      return true;
    },
    t: key => key, addMessage: () => {},
  });
  for (const name of [
    'syncSendButtonState', 'dismissSelectionAskAction', 'settleNewConversationConfirmation',
    'closePermissionSkipDialog', 'hideActivity', 'flushRenderedTabChat', 'flushChatHistorySnapshot',
    'resetChatNavigation', 'syncApiMutationsAllowedForCurrentTab', 'restoreComposerModeForCurrentTab',
    'syncSelectionScopeUi', 'migrateLegacyEmptyStateFromRestoredChat', 'rebindRestoredMessageControls',
    'refreshRenderedStepLabels', 'syncProgressDisplayMode', 'renderAttachmentPreviews',
    'renderQueuedComposerMessages', 'restoreLatestChatTurnPosition', 'refreshScheduledJobs',
    'refreshRecommendedActions', 'drainQueuedAgentUpdatesForTab', 'drainQueuedContextMenuPrompts',
    'renderComposerModePicker', 'autoResizeInput', 'updateSlashCommandAutocomplete',
    'resetComposerHistoryNavigation', 'hideSlashCommandAutocomplete',
  ]) context[name] = () => {};
  const functions = [
    'sameTabId', 'getQueuedComposerMessages', 'setQueuedComposerMessages', 'removeQueuedComposerMessage',
    'nextAutomaticQueuedComposerMessage', 'queueUnconsumedSteeringMessages',
    'drainQueuedComposerMessageForCurrentTab', 'cancelQueuedPromptDrainRetry', 'scheduleQueuedPromptDrainRetry',
    'hasQueuedPromptForTab', 'drainQueuedPromptsAfterRunSettles', 'switchToTab', 'waitForHistoryRecovery',
    'researchEscalationSourceTabIdFromState', 'requestVisibleSidePanelStateRefresh',
    'syncCurrentTabRunFlags', 'restoreInputDraftForTab', 'captureInputDraftForTab', 'saveInputDraftForTab',
  ].map(name => extract(source, name)).join('\n');
  // The top of handleAgentUpdateMessage, which queues handed-back corrections
  // for their own tab before updates for other tabs are dropped.
  const steeringUpdate = between(source, '  // Fallback queues belong to their source tab even while another tab is visible.',
    "  // Drop updates that belong to a different tab's run.");
  vm.runInContext(`${functions}\nfunction onAgentUpdate(msg) {\n${steeringUpdate}\n}`, context);
  return {
    context, sent, background, restoreGates,
    // Copied out of the vm realm so strict deep equality compares plain values.
    queue: (tabId = 1) => Array.from(context.getQueuedComposerMessages(tabId), item => ({ text: item.text, held: item.held === true })),
  };
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: a run ending while the panel shows another tab leaves its message queued`, async () => {
    const h = panel(build, { currentTabId: 2 });
    await h.context.drainQueuedPromptsAfterRunSettles(1);
    await settle(RETRY_MS * 3);
    assert.deepEqual(h.sent, [], 'The panel cannot start a run in a tab it does not show');
    assert.deepEqual(h.queue(), [{ text: QUEUED, held: false }]);
  });

  test(`${build}: switching back to the tab starts its queued message`, async () => {
    const h = panel(build, { currentTabId: 2 });
    await h.context.switchToTab(1);
    await settle();
    assert.deepEqual(h.sent, [{ tabId: 1, text: QUEUED }]);
    assert.deepEqual(h.queue(), []);
  });

  test(`${build}: a second activation while switching back still starts it, once`, async () => {
    const h = panel(build, { currentTabId: 2 });
    const restore = deferred();
    h.restoreGates.push(restore);
    // tabs.onActivated, then windows.onFocusChanged for the same tab while the
    // first switch is still restoring the tab's run state.
    const first = h.context.switchToTab(1);
    await settle();
    assert.equal(h.context.renderedTabId, 1, 'fixture: the first switch already rendered the tab');
    const second = h.context.switchToTab(1);
    await settle();
    restore.resolve();
    await Promise.all([first, second]);
    await settle(RETRY_MS * 3);
    assert.deepEqual(h.sent, [{ tabId: 1, text: QUEUED }]);
    assert.deepEqual(h.queue(), []);
  });

  test(`${build}: an activation for the tab already shown starts its queued message`, async () => {
    // The panel stayed on the tab (its window lost focus) while the run ended
    // hidden; the window regaining focus syncs the same tab again.
    const h = panel(build, { currentTabId: 1 });
    await h.context.switchToTab(1);
    await settle();
    assert.deepEqual(h.sent, [{ tabId: 1, text: QUEUED }]);
  });

  test(`${build}: a hidden panel keeps the message out of its composer and starts it once visible`, async () => {
    const h = panel(build, { currentTabId: 1 });
    h.context.document.visibilityState = 'hidden';
    await h.context.drainQueuedPromptsAfterRunSettles(1);
    await settle();
    assert.deepEqual(h.sent, []);
    assert.equal(h.context.inputEl.value, '', 'A hidden panel must not strand the message in its composer');
    assert.deepEqual(h.queue(), [{ text: QUEUED, held: false }]);
    h.context.document.visibilityState = 'visible';
    await h.context.requestVisibleSidePanelStateRefresh();
    await settle();
    assert.deepEqual(h.sent, [{ tabId: 1, text: QUEUED }]);
    assert.deepEqual(h.queue(), []);
  });

  test(`${build}: a correction handed back after the run's own drain starts on its own`, async () => {
    const h = panel(build, { currentTabId: 1, queue: [] });
    await h.context.drainQueuedPromptsAfterRunSettles(1); // the run's drain found nothing yet
    h.context.onAgentUpdate({ tabId: 1, requestId: 'run-1', type: 'steering_queued',
      data: { messages: [{ id: 'corr-1', text: 'Use the short version' }] } });
    await settle();
    assert.deepEqual(h.sent, [{ tabId: 1, text: 'Use the short version' }]);
  });

  test(`${build}: a correction handed back while its run is finishing waits for it to end`, async () => {
    const h = panel(build, { currentTabId: 1, queue: [] });
    h.background.running = true;
    h.context.onAgentUpdate({ tabId: 1, requestId: 'run-1', type: 'steering_queued',
      data: { messages: [{ id: 'corr-1', text: 'Use the short version' }] } });
    await settle(RETRY_MS * 3);
    assert.deepEqual(h.sent, [], 'Nothing starts while the background still runs the tab');
    h.background.running = false;
    await settle(RETRY_MS * 4);
    assert.deepEqual(h.sent, [{ tabId: 1, text: 'Use the short version' }]);
  });

  test(`${build}: corrections handed back by a stopped run stay held`, async () => {
    const h = panel(build, { currentTabId: 1, queue: [] });
    h.context.onAgentUpdate({ tabId: 1, requestId: 'run-1', type: 'steering_queued',
      data: { messages: [{ id: 'corr-1', text: 'Also post it on Mastodon' }], stopped: true } });
    await h.context.switchToTab(1);
    await h.context.requestVisibleSidePanelStateRefresh();
    await settle(RETRY_MS * 3);
    assert.deepEqual(h.sent, [], 'After Stop nothing starts on its own');
    assert.deepEqual(h.queue(), [{ text: 'Also post it on Mastodon', held: true }]);
  });

  test(`${build}: a landing while the panel follows the tab's own run leaves the start to that run`, async () => {
    const h = panel(build, { currentTabId: 1 });
    h.context.processingTabs.add(1);
    h.context.isProcessing = true;
    h.background.running = true;
    await h.context.switchToTab(1); // the window regains focus mid-run
    await h.context.requestVisibleSidePanelStateRefresh();
    h.context.onAgentUpdate({ tabId: 1, requestId: 'run-1', type: 'steering_queued',
      data: { messages: [{ id: 'corr-1', text: 'Use the short version' }] } });
    await settle(RETRY_MS * 3);
    assert.equal(h.background.runStateProbes, 0, 'No background polling while the panel follows the run');
    assert.deepEqual(h.sent, []);
    // The run ends on screen; its own drain starts the queue in order.
    h.background.running = false;
    h.context.processingTabs.delete(1);
    h.context.isProcessing = false;
    await h.context.drainQueuedPromptsAfterRunSettles(1);
    await settle();
    assert.deepEqual(h.sent, [{ tabId: 1, text: 'Use the short version' }]);
    assert.deepEqual(h.queue(), [{ text: QUEUED, held: false }]);
  });

  test(`${build}: landing on the tab never replaces the user's draft`, async () => {
    const h = panel(build, { currentTabId: 2 });
    h.context.tabInputDrafts.set(1, 'my unsent draft');
    await h.context.switchToTab(1);
    await h.context.switchToTab(1);
    await h.context.requestVisibleSidePanelStateRefresh();
    await settle(RETRY_MS * 3);
    assert.deepEqual(h.sent, []);
    assert.equal(h.context.inputEl.value, 'my unsent draft');
    assert.deepEqual(h.queue(), [{ text: QUEUED, held: false }]);
  });
}
