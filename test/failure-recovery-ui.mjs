import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { chromium, firefox } from 'playwright';

const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function: ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: recovery choices preserve stage details, require a click, and lock duplicate retries`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<style>${read(build, 'styles/sidepanel.css')}</style><main id="messages"><div class="message assistant" data-run-mode="act" data-run-request-id="failed-request"><div class="message-content"><div class="message-text"></div></div></div></main>`);
      const source = read(build, 'src/ui/sidepanel.js');
      const functions = ['syncFailureRecoveryButtons', 'bindFailureRecoveryCard', 'renderFailureRecoveryCard', 'reconcileFailureRecoveryCards', 'rebindFailureRecoveryCards'].map(name => extract(source, name)).join('\n');
      await page.addScriptTag({ content: `
        ${read(build, 'src/ui/failure-recovery.js').replaceAll('export function ', 'function ')}
        var messagesEl = document.querySelector('#messages');
        var currentAssistantEl = document.querySelector('.assistant');
        var currentTabId = 7, renderedTabId = 7, agentMode = 'act', isProcessing = false;
        var processingTabs = new Set(), calls = [], settleRetry;
        function sameTabId(a, b) { return Number(a) === Number(b); }
        function isConversationClearInProgress() { return false; }
        function t() { return 'Retry'; }
        function scrollToBottom() {}
        function schedulePersist() {}
        function formatErrorMessage(error) { return error.message || String(error); }
        function continueAgent(options) {
          const { onFailureRecoveryAccepted, ...payload } = options;
          calls.push({ type: 'retry', options: payload });
          return new Promise(resolve => {
            settleRetry = value => { if (value) onFailureRecoveryAccepted?.(); resolve(value); };
          });
        }
        async function sendToBackground(action, payload) { calls.push({ action, payload }); return { ok: true }; }
        ${functions}
        renderFailureRecoveryCard(currentAssistantEl, {
          recoveryId: 'opaque-draft-offer', stage: 'publication_audit',
          retryMode: 'publication_without_audit',
          message: 'webbrain-cloud error 400: {"error":{"message":"upstream error"}}',
          diagnostics: '<img src=x onerror="window.unsafe=true">'
        }, { tabId: 7, requestId: 'failed-request' });
      ` });
      assert.equal(await page.locator('.failure-recovery-message').textContent(), 'Failed while checking permission to publish. Your draft is still ready.');
      assert.match(await page.locator('.failure-recovery-note').textContent(), /skips the publication audit once/);
      assert.deepEqual(await page.locator('.failure-recovery-action').allTextContents(), ['Give up', 'Retry']);
      assert.equal(await page.locator('.failure-recovery-card img').count(), 0);
      assert.equal(await page.evaluate(() => calls.length), 0);
      await page.locator('[data-recovery-choice="retry"]').click();
      assert.equal(await page.locator('.failure-recovery-action:disabled').count(), 2);
      await page.evaluate(() => document.querySelector('[data-recovery-choice="retry"]').click());
      assert.deepEqual(await page.evaluate(() => calls), [{ type: 'retry', options: { failureRecoveryId: 'opaque-draft-offer', mode: 'act', foreground: false } }]);
      await page.evaluate(() => settleRetry(true));
      await page.waitForFunction(() => document.querySelector('.failure-recovery-card').dataset.recoveryChosen === 'true');
      assert.equal(await page.locator('.failure-recovery-status').textContent(), 'Retry requested.');
      assert.equal(await page.locator('.failure-recovery-action:disabled').count(), 2);

      await page.evaluate(() => {
        renderFailureRecoveryCard(currentAssistantEl, { recoveryId: 'verification-offer', stage: 'verification', retryMode: 'resume' }, { tabId: 7 });
      });
      await page.locator('[data-recovery-id="verification-offer"] [data-recovery-choice="give_up"]').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => calls.length === 2);
      assert.deepEqual(await page.evaluate(() => calls[1]), { action: 'failure_recovery_response', payload: { tabId: 7, recoveryId: 'verification-offer', choice: 'give_up' } });
      assert.equal(await page.locator('[data-recovery-id="verification-offer"] .failure-recovery-note').count(), 0);

      await page.evaluate(() => {
        renderFailureRecoveryCard(currentAssistantEl, {
          recoveryId: 'monitoring-offer', stage: 'browser_interaction', retryMode: 'action_monitoring_relaxed',
        }, { tabId: 7 });
      });
      const monitoringCard = page.locator('[data-recovery-id="monitoring-offer"]');
      assert.equal(await monitoringCard.getAttribute('data-retry-mode'), 'action_monitoring_relaxed');
      assert.equal(await monitoringCard.locator('.failure-recovery-note').textContent(), 'Retry relaxes page-change monitoring once for this task.');
      assert.equal(await page.evaluate(() => calls.length), 2, 'Displaying the retry note must not change monitoring automatically');
      await monitoringCard.locator('[data-recovery-choice="retry"]').click();
      assert.deepEqual(await page.evaluate(() => calls[2]), { type: 'retry', options: { failureRecoveryId: 'monitoring-offer', mode: 'act', foreground: false } });
      await page.evaluate(() => settleRetry(true));
      await page.waitForFunction(() => document.querySelector('[data-recovery-id="monitoring-offer"]').dataset.recoveryChosen === 'true');

      // A run WebBrain routed to Ask says so, and its retry is routed again.
      await page.evaluate(() => {
        const routed = document.createElement('div');
        routed.className = 'message assistant';
        Object.assign(routed.dataset, { runMode: 'ask', autoRouted: 'true', runRequestId: 'routed-request' });
        routed.innerHTML = '<div class="message-content"><div class="message-text"></div></div>';
        messagesEl.appendChild(routed);
        renderFailureRecoveryCard(routed, { recoveryId: 'routed-offer', stage: 'browser_interaction', retryMode: 'resume' }, { tabId: 7 });
      });
      await page.locator('[data-recovery-id="routed-offer"] [data-recovery-choice="retry"]').click();
      assert.deepEqual(await page.evaluate(() => calls[3]), { type: 'retry', options: { failureRecoveryId: 'routed-offer', mode: 'ask', autoRouted: true, foreground: false } });
      await page.evaluate(() => settleRetry(true));
    } finally { await browser.close(); }
  });

  test(`${build}: recovery explanations stay singular through live updates, terminal responses, and restoration`, async t => {
    const source = read(build, 'src/ui/sidepanel.js');
    const helperStart = source.indexOf('const ASSISTANT_RENDERABLE_ELEMENT_SELECTOR =');
    const observerStart = source.indexOf('const persistObserver =', helperStart);
    const observerEnd = source.indexOf('\n});', observerStart) + '\n});'.length;
    const observeCall = source.match(/persistObserver\.observe\(messagesEl, \{[^\n]+\}\);/)?.[0];
    assert.ok(helperStart >= 0 && observerStart > helperStart && observerEnd > observerStart && observeCall);
    const functions = [
      'syncFailureRecoveryButtons', 'bindFailureRecoveryCard', 'renderFailureRecoveryCard',
      'reconcileFailureRecoveryCards', 'rebindFailureRecoveryCards', 'applyActiveRunState',
      'getStreamedAssistantText', 'hasStreamedAssistantText', 'clearStreamedAssistantText',
      'renderStreamedAssistantMarkdownNow', 'scheduleStreamedAssistantMarkdownRender',
      'clearAssistantTextStreamState', 'renderAssistantTextUpdate', 'isStoppedByUserStatus',
      'handleAgentUpdateMessage', 'addMessageCopyButton', 'getMessageCopyText',
      'roleFromMessageElement', 'normalizeHistoryText', 'extractChatHistoryMessages', 'formatMarkdown',
    ].map(name => extract(source, name)).join('\n');
    const send = extract(source, 'sendMessage');
    const responseStart = send.indexOf('    if (renderToCurrentTab && currentTabId === tabId && isTabAbortRequested(tabId))');
    const responseEnd = send.indexOf('\n  } catch (e) {', responseStart);
    const continuation = extract(source, 'continueAgent');
    const continuationStart = continuation.indexOf('    if (currentTabId === tabId && res?.content && assistantEl)');
    const continuationEnd = continuation.indexOf('\n  } catch (e) {', continuationStart);
    assert.ok(responseStart >= 0 && responseEnd > responseStart && continuationStart >= 0 && continuationEnd > continuationStart);
    const friendly = 'Failed while contacting the model. You can retry from the current state.';
    const browser = await engine.launch({ headless: true });
    try {
      async function withPage(run) {
        const page = await browser.newPage();
        try {
          await page.setContent(`<style>${read(build, 'styles/sidepanel.css')}</style><main id="messages"><div class="message assistant" data-run-mode="act" data-run-request-id="failed-request"><div class="message-content"><div class="message-text"></div></div></div></main>`);
          const unexport = source => source.replace(/^export /gm, '');
          await page.addScriptTag({ content: `
            ${unexport(read(build, 'src/ui/failure-recovery.js'))}
            ${unexport(read(build, 'src/ui/utils.js'))}
            ${unexport(read(build, 'src/ui/markdown-render.js'))}
            ${unexport(read(build, 'src/ui/markdown-link.js'))}
            ${unexport(read(build, 'src/ui/history-text.js'))}
            var messagesEl = document.querySelector('#messages'), currentAssistantEl = document.querySelector('.assistant');
            var currentTabId = 7, renderedTabId = 7, agentMode = 'act', isProcessing = false;
            var verboseMode = false, compactProgressVisible = true;
            var processingTabs = new Set(), localRunRequestIds = new Map();
            var clearedConversationRunRequestIds = new Set(), cancelledRunRecoveryRequestIds = new Set();
            var streamedAssistantTextByEl = new WeakMap(), streamedAssistantRenderFrameByEl = new WeakMap();
            var offer = { recoveryId: 'one-offer', stage: 'inference', message: ${JSON.stringify(friendly)} };
            function sameTabId(a, b) { return Number(a) === Number(b); }
            function isConversationClearInProgress() { return false; }
            function t(key) { return key === 'sp.retry' ? 'Retry' : key; }
            function scrollToBottom() {}
            function schedulePersist() {}
            function scheduleMathRender() {}
            function bindMessageCopyButton() {}
            function showActivity() {}
            function hideActivity() {}
            function hideRecommendedActions() {}
            function startThinkingActivity() {}
            function markLastStepFailed() {}
            function finishResponseRetry() {}
            function parseCostAllowanceError() { return null; }
            function renderCostAllowanceError() { return false; }
            function renderSubscribeError() { return false; }
            function isTabAbortRequested() { return false; }
            function ensureCurrentRunAssistant() { return currentAssistantEl; }
            function setMessageCreatedAt() {}
            function messageCreatedAt() { return 1; }
            function messageAttachmentMetadata() { return []; }
            function finalizeSteps() {}
            function reconcileRunMessageAttachmentState() {}
            async function reconcilePersistedStagedScreenshots() {}
            async function restorePendingCurrentClarification() { return false; }
            function invalidatePlanReviewCards() {}
            function setPlanReviewAwaiting() {}
            function clearPlanReviewActiveRun() {}
            function isPlanReviewTimeoutTerminal() { return false; }
            function setTabProcessing(tabId, value) {
              isProcessing = value;
              if (value) processingTabs.add(tabId); else processingTabs.delete(tabId);
              syncFailureRecoveryButtons();
            }
            function setTabAbortRequested() {}
            function syncSendButtonState() {}
            function runUiUnavailableBeforeSeq() { return 0; }
            function isTerminalRunUiStatus(status) { return ['completed', 'stopped', 'cancelled', 'failed'].includes(status); }
            async function sendToBackground() { return { ok: true }; }
            function activeRetryPayloadForRequest() { return null; }
            function retryPayloadForRunAssistant() { return null; }
            function looksLikeRawToolCallText() { return false; }
            ${source.slice(helperStart, observerEnd)}
            ${functions}
            ${observeCall}
            function update(type, data = {}) {
              handleAgentUpdateMessage({ tabId: 7, requestId: 'failed-request', type, data });
            }
            function applyReturnedResponse(res) {
              const renderToCurrentTab = true, tabId = 7, assistantEl = currentAssistantEl, modeForSend = 'act', retryPayload = null;
              ${send.slice(responseStart, responseEnd)}
            }
            function applyReturnedContinuation(res) {
              const tabId = 7, assistantEl = currentAssistantEl, modeForSend = 'act';
              ${continuation.slice(continuationStart, continuationEnd)}
            }
          ` });
          await run(page);
        } finally { await page.close(); }
      }

      async function assertSingleExplanation(page) {
        await page.waitForFunction(() => document.querySelector('.failure-recovery-message')?.hidden === true);
        assert.equal(await page.locator('.failure-recovery-card').count(), 1);
        assert.equal(await page.locator('.assistant .message-text:visible, .failure-recovery-message:visible').count(), 1);
        assert.equal(await page.locator('.failure-recovery-action:visible').count(), 2);
        assert.equal(await page.evaluate(() => getMessageCopyText(document.querySelector('.msg-copy-btn')).trim()), friendly);
        assert.deepEqual(await page.evaluate(() => extractChatHistoryMessages().map(message => message.text)), [friendly]);
      }

      await t.test('text before the offer keeps one explanation and repeated offers stay idempotent', () => withPage(async page => {
        await page.evaluate(() => {
          update('text', { content: offer.message });
          update('failure_recovery', offer);
          update('failure_recovery', offer);
        });
        await assertSingleExplanation(page);
      }));

      await t.test('the offer retains its fallback for empty or distinct assistant output', () => withPage(async page => {
        await page.evaluate(() => update('failure_recovery', offer));
        assert.equal(await page.locator('.failure-recovery-message').isVisible(), true);
        await page.evaluate(() => update('text', { content: offer.message + '\n', replace: true }));
        await assertSingleExplanation(page);
        await page.evaluate(() => update('text', { content: 'The draft is ready for review.', replace: true }));
        await page.waitForFunction(() => document.querySelector('.failure-recovery-message').hidden === false);
        assert.equal(await page.locator('.assistant .message-text').textContent(), 'The draft is ready for review.');
        assert.equal(await page.locator('.failure-recovery-message').isVisible(), true);
        await page.evaluate(() => update('text', { content: '', replace: true }));
        assert.equal(await page.locator('.assistant .message-text').textContent(), '');
        assert.equal(await page.locator('.failure-recovery-message').isVisible(), true);
      }));

      for (const terminalPath of ['run_complete', 'chat_response', 'continuation_response', 'stream']) {
        await t.test(`${terminalPath} merges terminal failure copy with the existing offer`, () => withPage(async page => {
          await page.evaluate(terminalPath => {
            update('failure_recovery', offer);
            if (terminalPath === 'run_complete') update('run_complete', { status: 'failed', finalContent: offer.message });
            if (terminalPath === 'chat_response') applyReturnedResponse({ content: offer.message });
            if (terminalPath === 'continuation_response') applyReturnedContinuation({ content: offer.message });
            if (terminalPath === 'stream') update('text_delta', { content: offer.message });
          }, terminalPath);
          if (terminalPath === 'stream') {
            await page.waitForFunction(() => document.querySelector('.failure-recovery-message').hidden === true);
            await page.evaluate(() => update('run_complete', { status: 'failed', finalContent: offer.message }));
          }
          await assertSingleExplanation(page);
        }));
      }

      await t.test('legacy saved duplicates normalize on rebind and remain singular after reconnect', () => withPage(async page => {
        const normalized = await page.evaluate(() => {
          update('text', { content: offer.message });
          update('failure_recovery', offer);
          document.querySelector('.failure-recovery-message').hidden = false;
          messagesEl.innerHTML = messagesEl.innerHTML;
          currentAssistantEl = document.querySelector('.assistant');
          messagesEl.querySelectorAll('[data-bound]').forEach(node => delete node.dataset.bound);
          rebindFailureRecoveryCards();
          return document.querySelector('.failure-recovery-message').hidden;
        });
        assert.equal(normalized, true, 'Rebinding normalizes restored copy before the observer runs');
        assert.equal(await page.locator('.failure-recovery-action:disabled').count(), 2);
        await page.evaluate(async () => {
          const state = { running: false, runUi: { requestId: 'failed-request', status: 'failed', seq: 4, ackedSeq: 4, events: [], finalContent: offer.message }, pendingFailureRecovery: offer };
          await applyActiveRunState(7, state);
          await applyActiveRunState(7, state);
        });
        assert.equal(await page.locator('.failure-recovery-action:disabled').count(), 0);
        await assertSingleExplanation(page);
      }));

      await t.test('reconnect restores missing final text and recovery from a terminal snapshot', () => withPage(async page => {
        await page.evaluate(async () => {
          await applyActiveRunState(7, {
            running: false,
            runUi: { requestId: 'failed-request', status: 'failed', seq: 4, ackedSeq: 4, events: [], finalContent: offer.message },
            pendingFailureRecovery: offer,
          });
        });
        await assertSingleExplanation(page);
      }));
    } finally { await browser.close(); }
  });

  test(`${build}: restored recovery buttons require the current background offer and wait for the run to stop`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<main id="messages"><div class="message assistant"><div class="message-content"></div></div></main>');
      const source = read(build, 'src/ui/sidepanel.js');
      const functions = ['syncFailureRecoveryButtons', 'bindFailureRecoveryCard', 'renderFailureRecoveryCard', 'reconcileFailureRecoveryCards', 'rebindFailureRecoveryCards'].map(name => extract(source, name)).join('\n');
      await page.addScriptTag({ content: `
        ${read(build, 'src/ui/failure-recovery.js').replaceAll('export function ', 'function ')}
        var messagesEl = document.querySelector('#messages'), currentAssistantEl = document.querySelector('.assistant');
        var currentTabId = 7, renderedTabId = 7, agentMode = 'act', isProcessing = true, calls = [];
        var processingTabs = new Set([7]);
        function sameTabId(a, b) { return Number(a) === Number(b); }
        function isConversationClearInProgress() { return false; }
        function t() { return 'Retry'; }
        function scrollToBottom() {}
        function schedulePersist() {}
        function formatErrorMessage(error) { return error.message; }
        async function sendToBackground(action, payload) { calls.push({ action, payload }); return { ok: true }; }
        async function continueAgent() { calls.push('retry'); return true; }
        ${functions}
        renderFailureRecoveryCard(currentAssistantEl, { recoveryId: 'current-offer', stage: 'plan_alignment' }, { tabId: 7 });
      ` });
      assert.equal(await page.locator('.failure-recovery-action:disabled').count(), 2);
      await page.evaluate(() => {
        processingTabs.clear(); isProcessing = false;
        messagesEl.innerHTML = messagesEl.innerHTML;
        currentAssistantEl = document.querySelector('.assistant');
        messagesEl.querySelectorAll('[data-bound]').forEach(node => delete node.dataset.bound);
        rebindFailureRecoveryCards();
      });
      assert.equal(await page.locator('.failure-recovery-action:disabled').count(), 2);
      await page.evaluate(() => reconcileFailureRecoveryCards(7, { recoveryId: 'current-offer', stage: 'plan_alignment' }, currentAssistantEl));
      assert.equal(await page.locator('.failure-recovery-action:disabled').count(), 0);
      await page.evaluate(() => reconcileFailureRecoveryCards(7, null, currentAssistantEl));
      assert.equal(await page.locator('.failure-recovery-action:disabled').count(), 2);
      assert.equal(await page.locator('.failure-recovery-status').textContent(), 'This recovery option is no longer available.');
      assert.equal(await page.evaluate(() => calls.length), 0);
    } finally { await browser.close(); }
  });

  test(`${build}: recovery transport only accepts the panel and resolves opaque offers before continuing`, async () => {
    const source = extract(read(build, 'src/background.js'), 'handleFailureRecoveryResponse');
    const api = { runtime: { getURL: path => `extension://test/${path}` } };
    const calls = [], detached = new Map();
    let active = false, available = true, snapshot = null;
    const agent = { requestFailureRecovery(tabId, recoveryId, choice) {
      calls.push({ tabId, recoveryId, choice });
      return available ? { ok: true, continue: choice === 'retry' } : { ok: false, error: 'Stale recovery option.' };
    } };
    const handler = new Function('chrome', 'browser', 'agent', 'detachedRunStarts', 'getRunUiSnapshot', 'assertNoActiveTabRun', 'launchDetachedRun', `${source}; return handleFailureRecoveryResponse;`)(
      api, api, agent, detached, async () => snapshot,
      () => { if (active) throw new Error('A run is already active for this tab.'); },
      (action, msg) => { calls.push({ action, requestId: msg.requestId }); detached.set(msg.tabId, { requestId: msg.requestId }); return { ok: true, accepted: true, requestId: msg.requestId }; },
    );
    const msg = { tabId: 7, recoveryId: 'bound-id', choice: 'retry', requestId: 'new-recovery-run' };
    const panel = { url: api.runtime.getURL('src/ui/sidepanel.html') + '?standalone=true' };
    assert.equal((await handler(msg, { url: 'https://site.example/' })).ok, false);
    assert.equal((await handler({ ...msg, choice: 'anything' }, panel)).ok, false);
    assert.equal(calls.length, 0);
    active = true;
    await assert.rejects(handler(msg, panel), /already active/);
    assert.equal(calls.length, 0);
    active = false; available = false;
    assert.equal((await handler(msg, panel)).ok, false);
    assert.deepEqual(calls.pop(), { tabId: 7, recoveryId: 'bound-id', choice: 'retry' });
    available = true;
    assert.equal((await handler(msg, panel)).accepted, true);
    assert.deepEqual(calls, [{ tabId: 7, recoveryId: 'bound-id', choice: 'retry' }, { action: 'continue', requestId: 'new-recovery-run' }]);
    assert.equal((await handler(msg, panel)).accepted, true);
    assert.equal(calls.length, 2, 'Lost acknowledgements must follow the same run');
    detached.clear(); snapshot = { requestId: msg.requestId, kind: 'continue' };
    assert.equal((await handler(msg, panel)).accepted, true);
    assert.equal(calls.length, 2);
    snapshot = null;
    const stopped = await handler({ ...msg, choice: 'give_up' }, panel);
    assert.equal(stopped.continue, false);
    assert.deepEqual(calls.at(-1), { tabId: 7, recoveryId: 'bound-id', choice: 'give_up' });
    assert.equal(calls.filter(call => call.action === 'continue').length, 1);
  });

  test(`${build}: retry preflight failure clears its busy state without granting or starting recovery`, async () => {
    const context = vm.createContext({
      isStandaloneWindow: false, autoModeSelection: false, isProcessing: false, currentTabId: 7, renderedTabId: 7, agentMode: 'act',
      localRunRequestIds: new Map(), cancelledRunRecoveryRequestIds: new Set(),
      conversationClearFollowerCancellationRequestIds: new Set(), currentAssistantEl: null,
      rejectSelectionScopedMode: () => false, createRunRequestId: () => 'retry-preflight',
      clearActiveChatPayloadForTab: () => {},
      setTabProcessing: (_tab, value) => { context.isProcessing = value; },
      setTabAbortRequested: () => {}, syncSendButtonState: () => {},
      prepareChatHistoryForTurn: async () => { throw new Error('History is unavailable.'); },
      clearAssistantTextStreamState: () => {}, hideActivity: () => {}, scrollToBottom: () => {},
      flushRenderedTabChat: async () => {}, flushChatHistorySnapshot: async () => {},
      drainQueuedPromptsAfterRunSettles: async () => {},
      sendRunWithReconnect: () => assert.fail('Failed preflight must never grant or start recovery.'),
    });
    vm.runInContext(extract(read(build, 'src/ui/sidepanel.js'), 'continueAgent'), context);
    await assert.rejects(context.continueAgent({ failureRecoveryId: 'opaque-offer' }), /History is unavailable/);
    assert.equal(context.isProcessing, false);
    assert.equal(context.localRunRequestIds.size, 0);
    context.isProcessing = true;
    assert.equal(await context.continueAgent({ failureRecoveryId: 'opaque-offer' }), false);
    assert.equal(context.localRunRequestIds.size, 0);
  });
}
