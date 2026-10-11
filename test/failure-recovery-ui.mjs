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
      isStandaloneWindow: false, isProcessing: false, currentTabId: 7, renderedTabId: 7, agentMode: 'act',
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
