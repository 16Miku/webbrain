import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: Escape dismisses History without cancelling the active task`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const source = await readFile(`src/${build}/src/ui/sidepanel.js`, 'utf8');
      await page.setContent('<button id="history">History</button><div id="popover" popover="auto"><button>Recover</button></div><textarea></textarea>');
      await page.addScriptTag({ content: `
        const historyBtn = document.querySelector('#history');
        const historyPopover = document.querySelector('#popover');
        const inputEl = document.querySelector('textarea');
        const uiScaleShortcutAction = () => null;
        const closeUiScalePopover = () => false;
        const slashCommandMenuEl = null, selectionAskActionEl = null, providerPickerMenu = null, languagePickerMenu = null;
        const isProcessing = true;
        window.aborts = 0;
        function abortRun() { window.aborts++; }
        ${extract(source, 'handleGlobalKeydown')}
        document.addEventListener('keydown', handleGlobalKeydown, true);
        historyPopover.showPopover();
        historyBtn.focus();
      ` });
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.querySelector('#popover').matches(':popover-open')), false);
      assert.equal(await page.evaluate(() => window.aborts), 0);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => window.aborts), 1, 'Escape still aborts after dismissal');
    } finally { await browser.close(); }
  });

  test(`${build}: hidden recovery commits the new transcript before handoff`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const source = await readFile(`src/${build}/src/ui/sidepanel.js`, 'utf8');
      const listenerStart = source.lastIndexOf(`${build === 'firefox' ? 'browser' : 'chrome'}.runtime.onMessage.addListener(`, source.indexOf("|| msg.action !== 'tab_chat_handoff_request'"));
      const listener = source.slice(listenerStart, source.indexOf('\n});', listenerStart) + 4);
      await page.setContent('<div id="messages">old dialog</div>');
      await page.addScriptTag({ content: `
        let hidden = false;
        Object.defineProperty(document, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' });
        const messagesEl = document.querySelector('#messages');
        const currentTabId = 42, renderedTabId = 42, tabSwitchTransitionId = null;
        const historyRecoveryTabs = new Set(), tabChats = new Map(), tabChatHandoffGenerations = new Map([[42, 1]]);
        const tabChatHandoffOwnerId = 'owner';
        const chatHistoryRecordIdsByTab = new Map(), chatHistoryConversationIdsByTab = new Map(), chatHistoryCreatedAtByTab = new Map();
        const chatHistoryTabInfoByTab = new Map([[42, { url: 'https://example.com/' }]]), chatHistorySaveSeqByTab = new Map();
        const providerSelect = null, agentMode = 'ask';
        let historyPersistTimerTabId = null, saveSeq = 0;
        const hydrateChatHistoryIdentity = async () => {};
        const fallbackHistoryRecordId = () => 'previous';
        const extractChatHistoryMessages = () => [{ role: 'user', text: messagesEl.textContent }];
        const saveChatHistoryRecord = async record => { window.archive = record; window.archivedHidden = hidden; };
        let persistTimer = null, persistTimerTabId = null, historyPersistTimer = null, currentAssistantEl = null;
        let lastVisibleTabChatSnapshot = { tabId: 42, html: 'old dialog' };
        const historyPopover = { hidePopover() {} };
        const sameTabId = (a,b) => a === b;
        const isTabProcessing = () => false, isConversationClearInProgress = () => false;
        const getTabInfoForHistory = async () => ({ url: 'https://example.com/' });
        const setConversationClearInProgress = () => {};
        const nextChatHistorySaveSeqForTab = id => { chatHistorySaveSeqByTab.set(id, ++saveSeq); return saveSeq; };
        const releaseRetryAttachmentsInTree = () => {}, clearRetryAttachmentsForTab = () => {};
        const setApiMutationsAllowedForTab = () => {}, clearPendingAttachmentsForTab = () => {};
        const clearQueuedComposerMessagesForTab = () => {}, resetComposerHistoryNavigation = () => {};
        const resetChatNavigation = () => {}, applyConversationScopeState = () => {}, setMode = () => {};
        const flushPendingStreamedAssistantMarkdownRenders = () => {}, historyRecoveryMetadata = () => ({});
        const t = value => value;
        const showComposerToast = message => { window.failure = message; };
        const enqueueTabChatOperation = (tabId, fn) => fn(tabId);
        const addMessage = (role,text) => { const el = document.createElement('div'); el.textContent = text; messagesEl.append(el); return el; };
        ${extract(source, 'persistChatHistorySnapshot')}
        ${extract(source, 'flushChatHistorySnapshot')}
        let completeRecovery;
        const sendToBackground = async (action, payload) => {
          if (action === 'recover_chat_history') return new Promise(resolve => completeRecovery = resolve);
          if (action === 'persist_tab_chat') { window.persisted = payload.html; return { ok: true }; }
          throw new Error(action);
        };
        const chrome = { runtime: { onMessage: { addListener(fn) { window.handoff = fn; } } } };
        const browser = chrome;
        ${extract(source, 'waitForHistoryRecovery')}
        ${extract(source, 'persistTabChat')}
        ${extract(source, 'flushRenderedTabChat')}
        ${extract(source, 'recoverHistoryRecord')}
        ${listener}
        window.finish = () => completeRecovery({ ok: true, conversationId: 'new-id', record: { messages: [{role: 'user', text:'recovered dialog'}] } });
        window.hide = () => { hidden = true; };
        window.recovery = recoverHistoryRecord('archive', 42, 'https://example.com/');
      ` });
      await page.waitForFunction(() => typeof window.finish === 'function');
      await page.evaluate(() => {
        window.hide();
        window.handoffPending = window.handoff({target:'sidepanel', action:'tab_chat_handoff_request', ownerId:'owner', tabId:42, generation:1}, {}, value => {window.ack = value;});
      });
      assert.equal(await page.evaluate(() => window.handoffPending), true);
      assert.equal(await page.evaluate(() => window.ack), undefined);
      await page.evaluate(async () => { window.finish(); await window.recovery; });
      await page.waitForFunction(() => window.ack);
      assert.match(await page.evaluate(() => window.persisted), /recovered dialog/);
      assert.equal(await page.evaluate(() => window.ack.html), await page.evaluate(() => window.persisted));
      assert.equal(await page.evaluate(() => window.archivedHidden), true);
      assert.equal(await page.evaluate(() => window.archive.id), 'new-id');
      assert.equal(await page.evaluate(() => window.archive.messages[0].text), 'recovered dialog');
      assert.equal(await page.evaluate(() => window.failure), undefined);
    } finally { await browser.close(); }
  });
}
