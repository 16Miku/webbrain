// Real side-panel functions extracted verbatim from both builds and run in
// Playwright Chromium and Firefox. The activity test replays update streams of
// the real Agent (mocked browser APIs). After a user Stop nothing may start on
// its own: queued messages and unconsumed corrections stay visible for manual
// send, while ordinary (non-Stop) queue draining keeps working.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/', title: 'Example' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: 'https://example.com/' }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;

const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function: ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function between(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Missing anchor: ${from}`);
  return source.slice(start, end);
}

async function agentUpdates(build) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const tab = build === 'chrome' ? 9101 : 9102, updates = [];
  let requests = 0, agent;
  const next = async () => {
    requests++;
    if (requests === 1) return { toolCalls: [{ id: 'r1', function: { name: 'get_accessibility_tree', arguments: '{}' } }] };
    if (requests === 2) return { toolCalls: [{ id: 'd1', function: { name: 'done', arguments: '{"summary":"The update is posted.","outcome":"success"}' } }] };
    if (requests === 3) return { toolCalls: [{ id: 'r2', function: { name: 'get_accessibility_tree', arguments: '{}' } }] };
    return { toolCalls: [{ id: 'd2', function: { name: 'done', arguments: '{"summary":"The corrected update is posted.","outcome":"success"}' } }] };
  };
  const provider = { name: 'ui test', model: 'test', promptTier: 'full', contextWindow: 128000, supportsTools: true, supportsVision: false, chat: next };
  agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  Object.assign(agent, {
    _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
    _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
    _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
    _currentUrl: async () => 'https://example.com/', _getTabUrlTitle: async () => ({ tabUrl: 'https://example.com/', tabTitle: 'Example' }),
    _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {}, _ensureProgressSessionForCurrentTask: async () => {},
    _plannerMode: () => 'off', _skipPermissionGate: true, _ensureGateSetting: async () => true, _shouldAutoScreenshot: () => false,
    _pageFeedbackIdleMs: 0, _completionDoneBlock: () => null,
    _runPlannerIntentGate: async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false }),
  });
  agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
  agent._executeToolWithLifecycle = async (_tab, name, args) => {
    if (name === 'get_accessibility_tree') return { success: true, pageContent: 'article "The update is posted." [ref_1]' };
    if (requests === 2) agent.steerMessage(tab, 'Also add the #webbrain tag', { requestId: 'ui-' + build, messageId: 'c1' });
    return { done: true, success: true, summary: args.summary, outcome: args.outcome };
  };
  const result = await agent.processMessage(tab, 'Post the update', (type, data) => updates.push({ type, data }), 'act', [], { detachedRequestId: 'ui-' + build });
  assert.equal(result, 'The corrected update is posted.', 'fixture: the correction reopened the finished answer');
  return updates;
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const source = read(build, 'src/ui/sidepanel.js');
  const en = (await import(`../src/${build}/src/ui/locales/en.js`)).default;

  test(`${build}: "Finishing up" does not stick after a correction reopens a finished answer`, async () => {
    const updates = await agentUpdates(build);
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="activity" class="hidden"><span id="text"></span><span id="live"></span></div>');
      await page.addScriptTag({ content: `
        const STRINGS = ${JSON.stringify(en)};
        const t = key => STRINGS[key] || key;
        const agentActivity = document.querySelector('#activity');
        const activityText = document.querySelector('#text');
        const activityLiveStatus = document.querySelector('#live');
        let compactProgressVisible = true, currentAssistantEl = null, eventAssistantEl = null;
        const verboseMode = false, messagesEl = document.createElement('div');
        function setCompactProgressVisible() {} function hideInspectionBanner() {} function showInspectionBanner() {}
        function finishResponseRetry() {} function addMessage() { return document.createElement('div'); } function schedulePersist() {}
        function scrollToBottom() {} function truncate(value, n) { value = String(value || ''); return value.length > n ? value.slice(0, n) + '…' : value; }
        ${between(source, 'const TOOL_KEYS = {', '\n};')}\n};
        ${extract(source, 'isTerminalDoneTool')}
        ${between(source, 'function friendlyToolLabel(name, args) {', '\nconst LABEL_ARG_KEYS')}
        ${between(source, 'const THINKING_ACTIVITY_KEYS = [', '// A new turn is reading-first')}
        function update(type, data) {
          switch (type) {
            ${between(source, "    case 'steering_applied': {", "    case 'text':")}
            ${between(source, "    case 'tool_call':", "    case 'tool_progress':")}
            ${between(source, "    case 'tool_result':", "    case 'run_capture_warning':")}
          }
        }
        window.replay = events => events.map(([type, data]) => { update(type, data);
          return agentActivity.classList.contains('hidden') ? '' : activityText.textContent; });
      ` });
      const events = updates.filter(update => ['steering_applied', 'thinking', 'tool_call', 'tool_result'].includes(update.type))
        .map(update => [update.type, update.data]);
      const shown = await page.evaluate(events => window.replay(events), events);
      const label = await page.evaluate(() => friendlyToolLabel('done', {}));
      const firstDone = events.findIndex(([type, data]) => type === 'tool_call' && data?.name === 'done');
      const applied = events.findIndex(([type]) => type === 'steering_applied');
      const reread = events.findIndex(([type, data], index) => index > applied && type === 'tool_call' && data?.name === 'get_accessibility_tree');
      assert.ok(firstDone >= 0 && applied > firstDone && reread > applied, 'fixture: done, correction, then a new step');
      assert.equal(shown[firstDone], label, 'The finishing status is shown while the completion runs');
      for (let index = applied; index < reread; index++) {
        assert.notEqual(shown[index], label, `"${label}" stuck after ${events[index][0]}`);
      }
      // A concrete status from an ordinary tool still persists across thinking.
      const generic = await page.evaluate(() => window.replay([
        ['tool_call', { name: 'get_accessibility_tree', args: {} }],
        ['tool_result', { name: 'get_accessibility_tree', result: { success: true } }],
        ['thinking', { step: 4 }],
      ]));
      assert.equal(generic[2], generic[0]);
      // Any later main step after a completion means the run did not end there.
      const reopened = await page.evaluate(() => window.replay([
        ['tool_call', { name: 'done', args: { summary: 'x' } }],
        ['tool_result', { name: 'done', result: { done: true, success: true, summary: 'x' } }],
        ['thinking', { step: 5 }],
      ]));
      assert.equal(reopened[1], label);
      assert.notEqual(reopened[2], label);
    } finally { await browser.close(); }
  });

  test(`${build}: Stop holds queued messages and the stopped run's correction for manual send`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="queued-messages" class="hidden"></div><textarea id="user-input"></textarea>');
      // Helpers that older panels lack are optional so the same behavior can be checked on them.
      const optional = name => (source.search(new RegExp(`^function ${name}\\(`, 'm')) >= 0 ? extract(source, name) : '');
      const helpers = ['holdQueuedComposerMessages', 'nextAutomaticQueuedComposerMessage'].map(optional).join('\n');
      const functions = helpers + '\n' + ['sameTabId', 'getQueuedComposerMessages', 'setQueuedComposerMessages', 'queueUnconsumedSteeringMessages',
        'queuedComposerButton', 'renderQueuedComposerMessages',
        'removeQueuedComposerMessage', 'editQueuedComposerMessage', 'enqueueQueuedComposerMessage', 'drainQueuedComposerMessageForCurrentTab',
        'cancelQueuedPromptDrainRetry', 'scheduleQueuedPromptDrainRetry', 'hasQueuedPromptForTab', 'drainQueuedPromptsAfterRunSettles',
        'abortRun'].map(name => extract(source, name)).join('\n');
      const preFilter = between(source, '  // Fallback queues belong to their source tab even while another tab is visible.',
        "  // Drop updates that belong to a different tab's run.");
      await page.addScriptTag({ content: `(() => {
        // Shorten the panel's settle timers; every other value is real.
        const setTimeout = (fn, ms) => window.setTimeout(fn, Math.min(ms, 20));
        const clearTimeout = id => window.clearTimeout(id);
        const queuedMessagesEl = document.getElementById('queued-messages');
        const inputEl = document.getElementById('user-input');
        let currentTabId = 7, renderedTabId = 7, isProcessing = true, currentAssistantEl = null, queuedComposerMessageSeq = 0;
        const QUEUED_PROMPT_DRAIN_RETRY_MS = 1000;
        const queuedComposerMessagesByTab = new Map(), queuedSteeringMessageIds = new Set(), steeringRequestsByTab = new Map();
        const queuedPromptDrainRetryTimers = new Map(), processingTabs = new Set([7]), abortRequestedTabs = new Set();
        const localRunRequestIds = new Map([[7, 'run-7']]), localRunFollowers = new Map(), cancelledRunRecoveryRequestIds = new Set();
        const sent = [], drafts = new Map();
        let running = true;
        const t = key => key;
        function isTabProcessing(tabId) { return processingTabs.has(Number(tabId)); }
        function setTabProcessing(tabId, value) { value ? processingTabs.add(Number(tabId)) : processingTabs.delete(Number(tabId)); isProcessing = processingTabs.has(Number(currentTabId)); }
        function isTabAbortRequested(tabId) { return abortRequestedTabs.has(Number(tabId)); }
        function setTabAbortRequested(tabId, value) { value ? abortRequestedTabs.add(Number(tabId)) : abortRequestedTabs.delete(Number(tabId)); }
        function isConversationClearInProgress() { return false; }
        function isAwaitingPlanReviewForTab() { return false; }
        function hasQueuedContextMenuPromptForTab() { return false; }
        function drainQueuedContextMenuPrompts() {}
        function resetComposerHistoryNavigation() {} function syncComposerDeliveryState() {} function syncSendButtonState() {}
        function autoResizeInput() {} function updateSlashCommandAutocomplete() {} function hideSlashCommandAutocomplete() {}
        function saveInputDraftForTab(tabId, text) { drafts.set(Number(tabId), text); }
        function showActivity() {} function hideActivity() {} function finalizeSteps() {} async function flushRenderedTabChat() {}
        function addMessage() {}
        async function sendToBackground(action) {
          if (action === 'agent_run_state') return { ok: true, running, starting: false };
          return { ok: true };
        }
        // Like the real send, an accepted queued submission leaves the queue and composer.
        async function sendMessage(params) {
          const item = params.__queuedComposerMessage;
          sent.push(item?.text);
          if (item) removeQueuedComposerMessage(item.tabId, item.id);
          inputEl.value = ''; delete inputEl.queuedComposerSubmission;
          return true;
        }
        ${functions}
        function onAgentUpdate(msg) {\n${preFilter}\n}
        window.panel = {
          queue: () => getQueuedComposerMessages(7).map(item => ({ text: item.text, held: item.held === true })),
          rows: () => [...queuedMessagesEl.querySelectorAll('.queued-message')].map(row => ({ text: row.querySelector('.queued-message-text').textContent, held: row.dataset.held === 'true' })),
          enqueue: text => enqueueQueuedComposerMessage(7, text),
          stop: async () => { const pending = abortRun(7); running = false; setTabProcessing(7, false); await pending; },
          update: msg => onAgentUpdate(msg),
          settle: () => drainQueuedPromptsAfterRunSettles(7),
          edit: index => editQueuedComposerMessage(7, getQueuedComposerMessages(7)[index].id),
          startRun: () => { running = true; setTabProcessing(7, true); },
          endRun: () => { running = false; setTabProcessing(7, false); },
          sent, input: () => inputEl.value, clearInput: () => { inputEl.value = ''; },
        };
      })();` });
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      await page.evaluate(() => window.panel.enqueue('Then summarize the replies'));
      await page.evaluate(() => window.panel.stop());
      // The stopped run's journal returns its unconsumed correction afterwards.
      await page.evaluate(() => window.panel.update({ tabId: 7, requestId: 'run-7', type: 'steering_queued',
        data: { messages: [{ id: 'corr-1', text: 'Also post it on Mastodon' }], stopped: true } }));
      await page.evaluate(() => window.panel.settle());
      await wait(120);
      assert.deepEqual(await page.evaluate(() => window.panel.sent), [], 'Nothing starts on its own after Stop');
      assert.deepEqual(await page.evaluate(() => window.panel.rows()), [
        { text: 'Also post it on Mastodon', held: true }, { text: 'Then summarize the replies', held: true },
      ], 'Held items stay visible in the queue');
      // Manual send: the user moves a held item into the composer.
      await page.evaluate(() => window.panel.edit(0));
      assert.equal(await page.evaluate(() => window.panel.input()), 'Also post it on Mastodon');
      assert.deepEqual(await page.evaluate(() => window.panel.queue()), [{ text: 'Then summarize the replies', held: true }]);
      await page.evaluate(() => window.panel.clearInput()); // the user sent it manually
      // A later, normally finishing run still drains what was queued during it.
      await page.evaluate(() => { window.panel.startRun(); window.panel.enqueue('Check the notifications'); window.panel.endRun(); });
      await page.evaluate(() => window.panel.settle());
      await wait(120);
      assert.deepEqual(await page.evaluate(() => window.panel.sent), ['Check the notifications']);
      assert.deepEqual(await page.evaluate(() => window.panel.queue()), [{ text: 'Then summarize the replies', held: true }]);
      // A correction left over by an ordinary (non-Stop) end keeps auto-queue semantics.
      await page.evaluate(() => window.panel.update({ tabId: 7, requestId: 'run-8', type: 'steering_queued',
        data: { messages: [{ id: 'corr-2', text: 'Use the short version' }] } }));
      await page.evaluate(() => window.panel.settle());
      await wait(120);
      assert.deepEqual(await page.evaluate(() => window.panel.sent), ['Check the notifications', 'Use the short version']);
      // A run stopped outside the panel (page Stop button) also holds queued messages.
      await page.evaluate(() => { window.panel.startRun(); window.panel.enqueue('Reply to Ayşe'); window.panel.endRun(); });
      await page.evaluate(() => window.panel.update({ tabId: 7, requestId: 'run-9', type: 'run_complete', data: { status: 'stopped' } }));
      await page.evaluate(() => window.panel.settle());
      await wait(120);
      assert.equal((await page.evaluate(() => window.panel.sent)).includes('Reply to Ayşe'), false);
      assert.deepEqual((await page.evaluate(() => window.panel.queue())).at(-1), { text: 'Reply to Ayşe', held: true });
    } finally { await browser.close(); }
  });
}
