import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function: ${name}`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2);
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: native composer queues by default, explicitly steers, and preserves drafts across races`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 380, height: 700 } });
      const html = read(build, 'src/ui/sidepanel.html');
      const source = read(build, 'src/ui/sidepanel.js');
      const start = html.indexOf('<div id="queued-messages"');
      const end = html.indexOf('      </div>\n    </div>', start);
      assert.ok(start >= 0 && end > start);
      await page.setContent(`<style>${read(build, 'styles/sidepanel.css')}</style><div id="messages"></div>${html.slice(start, end + 12)}`);
      const functions = [
        'sameTabId', 'getQueuedComposerMessages', 'setQueuedComposerMessages',
        'queueUnconsumedSteeringMessages', 'steerComposerMessage', 'syncSteerButtonState',
        'queuedComposerButton', 'renderQueuedComposerMessages', 'removeQueuedComposerMessage',
        'enqueueQueuedComposerMessage', 'syncSendButtonState', 'sendMessage',
      ].map(name => extract(source, name)).join('\n');
      const listenersStart = source.indexOf("sendBtn.addEventListener('click', sendMessage);");
      const listenersEnd = source.indexOf("inputEl.addEventListener('input', handleInput);", listenersStart);
      await page.addScriptTag({ content: `
        var inputEl = document.getElementById('user-input');
        var sendBtn = document.getElementById('btn-send');
        var steerBtn = document.getElementById('btn-steer');
        var queuedMessagesEl = document.getElementById('queued-messages');
        var messagesEl = document.getElementById('messages');
        var currentTabId = 1, renderedTabId = 1, isProcessing = true;
        var isStandaloneWindow = false, tabSwitchTransitionId = null;
        var visibleStateRefreshPending = false, visibleStateRefreshInProgress = false;
        var clearing = false, reviewing = false, aborting = false;
        var queuedComposerMessagesByTab = new Map(), steeringRequestsByTab = new Map();
        var queuedSteeringMessageIds = new Set(), tabInputDrafts = new Map();
        var clearedConversationRunRequestIds = new Set(), queuedComposerMessageSeq = 0;
        var sent = [], notices = [], requestSeq = 0, heldResponse = null;
        var responseMode = 'accept';
        function t(key) { return ({ 'sp.steer.button': 'Yönlendir', 'sp.queue.label': 'Kuyrukta' })[key] || key; }
        function isTabProcessing(tabId) { return tabId === 1; }
        function isTabAbortRequested() { return aborting; }
        function isConversationClearInProgress() { return clearing; }
        function isAwaitingPlanReviewForTab() { return reviewing; }
        function isAttachmentReadPendingForTab() { return false; }
        function createRunRequestId() { return 'id-' + (++requestSeq); }
        function localRunRequestIdForTab() { return 'run-1'; }
        function saveInputDraftForTab(tabId, text) { tabInputDrafts.set(Number(tabId), text); }
        function resetComposerHistoryNavigation() {}
        function hideSlashCommandAutocomplete() {}
        function autoResizeInput() {}
        function drainQueuedPromptsAfterRunSettles() {}
        function showComposerToast(text) { notices.push(text); }
        function normalizeScreenshotCommandText(value) { return value; }
        function normalizeSelectionSourceGrounding() { return null; }
        function normalizeSelectionAction() { return ''; }
        function waitForVisibleSidePanelStateRefresh() { return Promise.resolve(); }
        function dismissSelectionAskAction() {}
        function stopListening() {}
        function permissionSkipCommandContextForDraft() { return null; }
        function isOutOfBandSlashDraft() { return false; }
        function showBusySlashCommandNotice() { notices.push('busy slash'); }
        function handleGlobalKeydown() {}
        function handleSlashCommandKeydown() { return false; }
        function editLastQueuedComposerMessageForCurrentTab() { return false; }
        function navigateComposerHistory() { return false; }
        function editQueuedComposerMessage() {}
        function deleteQueuedComposerMessage(tabId, id) { removeQueuedComposerMessage(tabId, id); }
        function sendToBackground(action, data) {
          sent.push({ action, ...data });
          if (responseMode === 'hold') return new Promise(resolve => { heldResponse = resolve; });
          if (responseMode === 'fail') return Promise.reject(new Error('transport failed'));
          return Promise.resolve({ accepted: responseMode !== 'inactive' });
        }
        ${functions}
        ${source.slice(listenersStart, listenersEnd)}
        steerBtn.textContent = t('sp.steer.button');
        inputEl.addEventListener('input', syncSendButtonState);
        syncSendButtonState();
      ` });

      const input = page.locator('#user-input');
      await input.fill('After this, check the tests');
      await input.press('Enter');
      await page.waitForFunction(() => getQueuedComposerMessages(1).length === 1);
      assert.equal(await page.evaluate(() => sent.length), 0, 'Enter queues locally');
      assert.equal(await input.inputValue(), '');
      assert.equal(await page.locator('.queued-message-steer').count(), 1);
      assert.equal(await page.locator('.queued-message-action').evaluateAll(buttons =>
        new Set(buttons.map(button => button.getBoundingClientRect().top)).size), 1,
        'Steer, edit, and delete remain on one row in a narrow panel');

      await input.fill('Use blue instead');
      await page.locator('#btn-steer').click();
      await page.waitForFunction(() => sent.length === 1 && !steeringRequestsByTab.size);
      assert.equal(await input.inputValue(), '');
      assert.deepEqual(await page.evaluate(() => [sent[0].action, sent[0].text, sent[0].requestId, sent[0].tabId]),
        ['chat_steer', 'Use blue instead', 'run-1', 1]);
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(1).length), 1, 'Steering preserves queued follow-ups');

      await page.locator('.queued-message-steer').click();
      await page.waitForFunction(() => sent.length === 2 && !steeringRequestsByTab.size);
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(1).length), 0);

      await input.fill('Keep the logo');
      await input.press('Alt+Enter');
      await page.waitForFunction(() => sent.length === 3 && !steeringRequestsByTab.size);
      assert.equal(await page.evaluate(() => sent.at(-1).text), 'Keep the logo');

      await page.evaluate(() => inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, isComposing: true })));
      assert.equal(await page.evaluate(() => sent.length), 3, 'IME confirmation does not send');

      await input.fill('/act');
      assert.equal(await page.locator('#btn-steer').isDisabled(), true);
      await input.press('Alt+Enter');
      assert.equal(await page.evaluate(() => sent.length), 3, 'Busy slash commands never become steering');

      await page.evaluate(() => { responseMode = 'hold'; });
      await input.fill('First correction');
      await page.locator('#btn-steer').click();
      await page.waitForFunction(() => heldResponse !== null);
      await input.fill('New draft while waiting');
      await input.press('Enter');
      assert.equal(await page.evaluate(() => sent.length), 4, 'Acknowledgement wait prevents duplicate sends');
      await page.evaluate(() => { heldResponse({ accepted: true }); heldResponse = null; });
      await page.waitForFunction(() => !steeringRequestsByTab.size);
      assert.equal(await input.inputValue(), 'New draft while waiting');

      await page.evaluate(() => { responseMode = 'inactive'; });
      await input.fill('Missed the current turn');
      await page.locator('#btn-steer').click();
      await page.waitForFunction(() => !steeringRequestsByTab.size);
      assert.equal(await input.inputValue(), '');
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(1)[0].text), 'Missed the current turn');

      await page.evaluate(() => { responseMode = 'hold'; });
      await page.locator('.queued-message-steer').click();
      await page.waitForFunction(() => heldResponse !== null);
      await page.evaluate(() => {
        queueUnconsumedSteeringMessages(1, [{ id: sent.at(-1).messageId, text: sent.at(-1).text }]);
        heldResponse({ accepted: true }); heldResponse = null;
      });
      await page.waitForFunction(() => !steeringRequestsByTab.size);
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(1).length), 1,
        'An unconsumed correction arriving before its acknowledgement survives promotion');

      await page.evaluate(() => { responseMode = 'fail'; });
      await input.fill('Retain on failure');
      await page.locator('#btn-steer').click();
      await page.waitForFunction(() => !steeringRequestsByTab.size);
      assert.equal(await input.inputValue(), 'Retain on failure');

      await page.evaluate(() => { responseMode = 'hold'; });
      await input.fill('Correction for tab one');
      await page.locator('#btn-steer').click();
      await page.waitForFunction(() => heldResponse !== null);
      await page.evaluate(() => {
        tabInputDrafts.set(1, inputEl.value);
        currentTabId = renderedTabId = 2;
        inputEl.value = 'Tab two draft';
        heldResponse({ accepted: true }); heldResponse = null;
      });
      await page.waitForFunction(() => !steeringRequestsByTab.size);
      assert.equal(await input.inputValue(), 'Tab two draft');
      assert.equal(await page.evaluate(() => tabInputDrafts.get(1)), '', 'Only the submitted tab draft is cleared');
      await page.evaluate(() => { currentTabId = renderedTabId = 1; syncSendButtonState(); });

      await page.evaluate(() => { responseMode = 'hold'; });
      await input.fill('Clear while awaiting acknowledgement');
      await page.locator('#btn-steer').click();
      await page.waitForFunction(() => heldResponse !== null);
      await page.evaluate(() => {
        queuedComposerMessagesByTab.clear();
        clearedConversationRunRequestIds.add('run-1');
        heldResponse({ accepted: false }); heldResponse = null;
      });
      await page.waitForFunction(() => !steeringRequestsByTab.size);
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(1).length), 0, 'Cleared chats are not resurrected');

      await page.evaluate(() => {
        currentTabId = renderedTabId = 2;
        queueUnconsumedSteeringMessages(1, [{ id: 'fallback-1', text: 'Late correction' }]);
        queueUnconsumedSteeringMessages(1, [{ id: 'fallback-1', text: 'Late correction' }]);
      });
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(1).length), 1, 'Journal replay is deduplicated');
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(2).length), 0);
      await page.evaluate(() => { isProcessing = false; syncSendButtonState(); });
      assert.equal(await page.locator('#btn-steer').isVisible(), false);
      assert.equal(await page.locator('#btn-send').getAttribute('title'), 'sp.btn.send');
    } finally {
      await browser.close();
    }
  });
}
