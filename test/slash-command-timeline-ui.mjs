import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function: ${name}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `Missing end of function: ${name}`);
  return source.slice(start, end + 2);
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: slash outputs preserve the live conversation timeline`, async t => {
    const source = read(build, 'src/ui/sidepanel.js');
    const metadataStart = source.indexOf('const SLASH_COMMANDS = [');
    const metadataEnd = source.indexOf('function showSlashInvocationError(', metadataStart);
    const visibilityStart = source.indexOf('const ASSISTANT_RENDERABLE_ELEMENT_SELECTOR =');
    const observerStart = source.indexOf('const persistObserver =', visibilityStart);
    const observerEnd = source.indexOf('\n});', observerStart) + '\n});'.length;
    const observeCall = source.match(/persistObserver\.observe\(messagesEl, \{[^\n]+\}\);/)?.[0];
    assert.ok(metadataStart >= 0 && metadataEnd > metadataStart && observeCall);
    const functions = [
      'parseSlashCommands', 'addMessage', 'addPersistentSlashMessage',
      'showProgress', 'showScratchpad', 'showUserMemory', 'showTeacherModeStatus',
      'showSavedWorkflows', 'systemHtml', 'isSystemHtml', 'tSystemHtml',
      'getOrCreateStepsContainer', 'appendVerboseToolCall', 'appendVerboseToolResult',
      'placeAnsweredClarifyCardInTimeline', 'syncProgressDisplayMode', 'setCompactProgressVisible',
      'getStreamedAssistantText', 'hasStreamedAssistantText', 'clearStreamedAssistantText',
      'renderAssistantTextUpdate', 'isStoppedByUserStatus', 'clearTransientAssistantTextForToolCall',
      'addMessageCopyButton', 'addScratchpadCopyButton', 'getMessageCopyText', 'bindMessageCopyButton',
      'extractChatHistoryMessages', 'roleFromMessageElement', 'normalizeHistoryText',
      'scrollToBottom', 'pinChatToBottom', 'appendCompactStep', 'markLastStepDone',
      'findLastActiveCompactStep', 'restoreStepFriendlyLabel', 'isTerminalDoneTool', 'bindCompactStepDetailsToggle',
    ].map(name => extract(source, name)).join('\n');
    const browser = await engine.launch({ headless: true });
    try {
      async function fixture(run, mode = 'compact') {
        const page = await browser.newPage({ viewport: { width: 420, height: 500 } });
        await page.bringToFront();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
          await page.setContent(`<style>${read(build, 'styles/sidepanel.css')}
            body { display: block; margin: 0; }
            #transcript { height: 480px; overflow: auto; }
            .message { animation: none; }
            .step-item { min-height: 30px; }
          </style><div id="transcript"><main id="messages"></main></div>`);
          await page.addScriptTag({ content: `
            var messagesEl = document.getElementById('messages');
            var transcript = document.getElementById('transcript');
            var chatContainerEl = transcript, chatAutoFollow = true, chatUserChoseReadingPosition = false;
            var scrollToBottomFrame = null;
            var currentAssistantEl = null, currentTabId = 7, isProcessing = true;
            var verboseMode = ${mode === 'verbose'}, compactProgressVisible = ${mode !== 'status-only'};
            var activityProgressToggle = null, agentActivity = null;
            var streamedAssistantTextByEl = new WeakMap(), streamedAssistantRenderFrameByEl = new WeakMap();
            var scrollRequests = [], backgroundRequests = [], responseOverrides = {};
            function schedulePersist() {}
            function chatTurnIsConnected() { return !!currentAssistantEl?.isConnected; }
            function chatTurnIsRunning() { return isProcessing; }
            function chatTurnNeedsReadingNavigation() { return true; }
            function scheduleChatNavigationUpdate() {}
            function safeLabelArgs(args) { return JSON.stringify(args); }
            function friendlyToolLabel(name) { return name; }
            function setMessageCreatedAt() {}
            function messageCreatedAt() { return null; }
            function messageAttachmentMetadata() { return []; }
            function historyRecoveryMetadata() { return {}; }
            function historyTextFromElement(element) { return element.textContent; }
            function bindMessageInfoToggle() {}
            function renderCostAllowanceError() { return false; }
            function renderSubscribeError() { return false; }
            function parseCostAllowanceError() { return null; }
            function formatSelectionPromptForDisplay(text) { return text; }
            function formatMarkdown(text) { return escapeHtml(text); }
            function escapeHtml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
            function truncate(text, limit) { return text.slice(0, limit); }
            function t(key) { return key; }
            function isSelectionGroundedForTab() { return false; }
            function showComposerToast() {}
            function visibleScheduledJobs(jobs) { return jobs; }
            async function refreshScheduledJobs() { return []; }
            async function sendToBackground(action, params = {}) {
              backgroundRequests.push({ action, params });
              if (action in responseOverrides) return await responseOverrides[action];
              if (action === 'get_progress') return { ok: true, sessionId: 'live-session', counts: { total: 1, acted: 1 }, rows: [{ id: 'row-1', status: 'acted' }] };
              if (action === 'get_scratchpad') return { exists: true, body: 'Saved scratchpad notes' };
              if (action === 'get_user_memory') return { ok: true, records: [{ id: 'memory-1', text: 'Saved preference' }] };
              if (action === 'get_teacher_mode') return { ok: true, session: { active: true, name: 'Example', actionCount: 2 } };
              if (action === 'list_saved_workflows') return { ok: true, workflows: [] };
              throw new Error('Unexpected background request: ' + action);
            }
            ${source.slice(metadataStart, metadataEnd)}
            ${source.slice(visibilityStart, observerEnd)}
            ${functions}
            const productionScrollToBottom = scrollToBottom;
            scrollToBottom = (options = {}) => { scrollRequests.push(options); productionScrollToBottom(options); };
            ${observeCall}
            function beginRun() {
              addMessage('user', 'Process all items');
              currentAssistantEl = addMessage('assistant', '');
              currentAssistantEl.dataset.runRequestId = 'run-original';
              currentAssistantEl.dataset.runId = 'execution-original';
              window.originalAssistant = currentAssistantEl;
              const steps = getOrCreateStepsContainer();
              steps.dataset.testPosition = 'before-command';
              for (let i = 0; i < 25; i++) {
                const step = document.createElement('div');
                step.className = 'step-item done';
                step.textContent = 'Earlier action ' + i;
                steps.appendChild(step);
              }
              syncProgressDisplayMode();
            }
            function addLaterStep(label) {
              const step = document.createElement('div');
              step.className = 'step-item done';
              step.textContent = label;
              getOrCreateStepsContainer().appendChild(step);
              return step;
            }
            beginRun();
          ` });
          await run(page);
          assert.deepEqual(errors, [], 'Production handlers must not throw browser errors');
        } finally { await page.close(); }
      }

      for (const mode of ['compact', 'status-only', 'verbose']) {
        await t.test(`/progress is visible after prior activity and later output follows it in ${mode} mode`, () => fixture(async page => {
          await page.evaluate(() => parseSlashCommands('/progress'));
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const first = await page.evaluate(() => {
            const card = messagesEl.querySelector('.slash-command-output');
            const before = messagesEl.querySelector('[data-test-position="before-command"]');
            const rect = card?.getBoundingClientRect();
            const viewport = transcript.getBoundingClientRect();
            return {
              present: !!card,
              inLiveRun: card?.closest('.message.assistant') === originalAssistant,
              afterPrior: !!card && !!(before.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING),
              visible: !!rect && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom,
              forced: scrollRequests.some(request => request.force === true),
              systemCount: messagesEl.querySelectorAll(':scope > .message.system').length,
            };
          });
          assert.deepEqual(first, { present: true, inLiveRun: true, afterPrior: true, visible: true, forced: true, systemCount: 0 });
          const continuation = await page.evaluate(() => {
            const card = currentAssistantEl.querySelector('.slash-command-output');
            const initialContent = card.textContent;
            const later = addLaterStep('Later action');
            appendVerboseToolCall('read_page', { fresh: true });
            appendVerboseToolResult('read_page', { text: 'Fresh result' });
            renderAssistantTextUpdate(currentAssistantEl, 'Finished processing items.', { replace: true });
            const text = currentAssistantEl.querySelector('.message-text');
            return {
              sameAssistant: currentAssistantEl === originalAssistant,
              requestId: currentAssistantEl.dataset.runRequestId,
              runId: currentAssistantEl.dataset.runId,
              cardIntact: card.textContent === initialContent,
              stepAfter: !!(card.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING),
              toolAfter: !!(card.compareDocumentPosition(currentAssistantEl.querySelector('.tool-call')) & Node.DOCUMENT_POSITION_FOLLOWING),
              textAfter: !!(card.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING),
              text: text.textContent,
            };
          });
          assert.deepEqual(continuation, {
            sameAssistant: true, requestId: 'run-original', runId: 'execution-original', cardIntact: true,
            stepAfter: true, toolAfter: true, textAfter: true, text: 'Finished processing items.',
          });
        }, mode));
      }

      await t.test('persistent command handlers and every advertised help option use the current timeline', () => fixture(async page => {
        const result = await page.evaluate(async () => {
          const commands = ['/help', '/progress', '/scratchpad', '/memory', '/schedule --list', '/teach', '/workflow'];
          commands.push(...SLASH_COMMANDS.filter(slashCommandIsDiscoverable).map(command => command.value + ' --help'));
          const counts = [];
          for (const command of commands) {
            const count = currentAssistantEl.querySelectorAll('.slash-command-output').length;
            await parseSlashCommands(command);
            const cards = currentAssistantEl.querySelectorAll('.slash-command-output');
            counts.push({ command, added: cards.length - count });
          }
          return { counts, rootSystems: messagesEl.querySelectorAll(':scope > .message.system').length };
        });
        for (const entry of result.counts) assert.equal(entry.added, 1, entry.command);
        assert.equal(result.rootSystems, 0);
      }));

      await t.test('repeated commands and answered clarifications keep separate step segments after restoration', () => fixture(async page => {
        const result = await page.evaluate(async () => {
          await parseSlashCommands('/progress');
          addLaterStep('Between commands');
          await parseSlashCommands('/scratchpad');
          const card = document.createElement('div');
          card.className = 'clarify-card clarify-answered';
          card.textContent = 'Answered clarification';
          currentAssistantEl.querySelector('.message-content').appendChild(card);
          placeAnsweredClarifyCardInTimeline(card);
          addLaterStep('After clarification');
          // Session snapshots restore markup; no in-memory marker should be needed.
          messagesEl.innerHTML = messagesEl.innerHTML;
          currentAssistantEl = messagesEl.querySelector('.message.assistant');
          await parseSlashCommands('/memory');
          addLaterStep('After restoration');
          return [...currentAssistantEl.querySelector('.message-content').children]
            .filter(node => node.matches('.steps-container, .slash-command-output, .clarify-card'))
            .map(node => node.classList.contains('steps-container') ? node.lastElementChild.textContent : node.className);
        });
        assert.deepEqual(result, [
          'Earlier action 24', 'slash-command-output', 'Between commands', 'slash-command-output',
          'clarify-card clarify-answered', 'After clarification', 'slash-command-output', 'After restoration',
        ]);
      }));

      await t.test('scratchpad and memory copy buttons stay scoped to their own cards', () => fixture(async page => {
        const result = await page.evaluate(async () => {
          await parseSlashCommands('/scratchpad');
          await parseSlashCommands('/memory');
          renderAssistantTextUpdate(currentAssistantEl, 'Assistant answer', { replace: true });
          return {
            cardCopies: [...currentAssistantEl.querySelectorAll('.slash-command-output .scratchpad-copy-btn')].map(getMessageCopyText),
            assistantCopies: [...currentAssistantEl.querySelectorAll('.msg-copy-btn:not(.scratchpad-copy-btn)')].map(getMessageCopyText),
          };
        });
        assert.deepEqual(result, { cardCopies: ['Saved scratchpad notes', 'memory-1 [preference] Saved preference'], assistantCopies: ['Assistant answer'] });
      }));

      await t.test('streamed text keeps its original cursor and state across a slash response', () => fixture(async page => {
        const result = await page.evaluate(async () => {
          const cursor = currentAssistantEl.querySelector('.message-text');
          cursor.textContent = 'Response already streaming';
          cursor.dataset.streamedAssistantActive = 'true';
          streamedAssistantTextByEl.set(cursor, 'Response already streaming');
          await parseSlashCommands('/progress');
          const intact = currentAssistantEl.querySelector('.message-text') === cursor
            && getStreamedAssistantText(cursor) === 'Response already streaming'
            && hasStreamedAssistantText(cursor);
          renderAssistantTextUpdate(currentAssistantEl, 'Response completed', { replace: true });
          return {
            intact,
            final: cursor.textContent,
            card: currentAssistantEl.querySelector('.slash-command-text').textContent.includes('live-session'),
            assistantCopies: currentAssistantEl.querySelectorAll('.msg-copy-btn:not(.scratchpad-copy-btn)').length,
          };
        });
        assert.deepEqual(result, { intact: true, final: 'Response completed', card: true, assistantCopies: 1 });
      }));

      await t.test('durable history retains slash results as system records without duplicating the assistant reply', () => fixture(async page => {
        const result = await page.evaluate(async () => {
          await parseSlashCommands('/scratchpad');
          await parseSlashCommands('/memory');
          renderAssistantTextUpdate(currentAssistantEl, 'Final assistant reply', { replace: true });
          const complete = extractChatHistoryMessages().map(({ role, text }) => ({ role, text }));
          currentAssistantEl.querySelector('.message-text').dataset.responseIncomplete = 'true';
          const incomplete = extractChatHistoryMessages().map(({ role, text }) => ({ role, text }));
          return { complete, incomplete };
        });
        const prefix = [
          { role: 'user', text: 'Process all items' },
          { role: 'system', text: 'sp.scratchpad.title_htmlSaved scratchpad notes' },
          { role: 'system', text: 'sp.memory.title_htmlmemory-1 [preference] Saved preference' },
        ];
        assert.deepEqual(result, { complete: [...prefix, { role: 'assistant', text: 'Final assistant reply' }], incomplete: prefix });
      }));

      await t.test('a slash response is revealed above a long in-flight answer without replacing the stream cursor', () => fixture(async page => {
        const initial = await page.evaluate(async () => {
          const cursor = currentAssistantEl.querySelector('.message-text');
          cursor.innerHTML = Array.from({ length: 100 }, (_, i) => '<p>Streaming answer line ' + i + '</p>').join('');
          streamedAssistantTextByEl.set(cursor, 'Original streaming state');
          window.streamCursor = cursor;
          await parseSlashCommands('/progress');
          const card = currentAssistantEl.querySelector('.slash-command-output');
          const rect = card.getBoundingClientRect(), viewport = transcript.getBoundingClientRect();
          return { visible: rect.bottom > viewport.top && rect.top < viewport.bottom, sameCursor: currentAssistantEl.querySelector('.message-text') === cursor };
        });
        assert.deepEqual(initial, { visible: true, sameCursor: true });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const afterFrame = await page.evaluate(() => {
          scrollToBottom(); // Subsequent stream events must respect the revealed card.
          const rect = currentAssistantEl.querySelector('.slash-command-output').getBoundingClientRect();
          const viewport = transcript.getBoundingClientRect();
          return {
            visible: rect.bottom > viewport.top && rect.top < viewport.bottom,
            stream: getStreamedAssistantText(streamCursor),
            paragraphs: streamCursor.querySelectorAll('p').length,
            reading: chatUserChoseReadingPosition && !chatAutoFollow,
          };
        });
        assert.deepEqual(afterFrame, { visible: true, stream: 'Original streaming state', paragraphs: 100, reading: true });
      }));

      await t.test('Markdown export keeps inline system output and the final assistant reply distinct', () => fixture(async page => {
        const exported = await page.evaluate(async () => {
          window.chrome = { runtime: { getManifest: () => ({ version: 'test' }) } };
          window.browser = window.chrome;
          const blobs = [];
          URL.createObjectURL = blob => { blobs.push(blob); return 'blob:test'; };
          HTMLAnchorElement.prototype.click = () => {};
          await parseSlashCommands('/scratchpad');
          await parseSlashCommands('/memory');
          renderAssistantTextUpdate(currentAssistantEl, 'Final exported answer', { replace: true });
          await parseSlashCommands('/export');
          return await blobs[0].text();
        });
        assert.match(exported, /\*\*WebBrain:\*\* Final exported answer/);
        assert.equal(exported.match(/Saved scratchpad notes/g)?.length, 1);
        assert.equal(exported.match(/Saved preference/g)?.length, 1);
      }));

      await t.test('completion retries reuse their own segment and never rewrite output before a timeline boundary', () => fixture(async page => {
        const results = await page.evaluate(async () => {
          const outcomes = [];
          for (const kind of ['compact', 'verbose']) {
            for (const boundary of ['none', 'slash', 'clarify']) {
              messagesEl.replaceChildren();
              beginRun();
              const append = kind === 'compact' ? appendCompactStep : appendVerboseToolCall;
              const finish = kind === 'compact' ? markLastStepDone : appendVerboseToolResult;
              const selector = kind === 'compact' ? '.step-item[data-tool="done"]' : '.tool-call[data-tool-name="done"]';
              append('done', { summary: 'Before boundary' });
              finish('done', { blockedDone: true });
              let marker = null;
              if (boundary === 'slash') {
                await parseSlashCommands('/progress');
                marker = currentAssistantEl.querySelector('.slash-command-output');
              } else if (boundary === 'clarify') {
                marker = document.createElement('div');
                marker.className = 'clarify-card clarify-answered';
                currentAssistantEl.querySelector('.message-content').appendChild(marker);
                placeAnsweredClarifyCardInTimeline(marker);
              }
              append('done', { summary: 'After boundary' });
              const calls = [...currentAssistantEl.querySelectorAll(selector)];
              outcomes.push({
                kind, boundary, count: calls.length,
                latestAfterBoundary: !marker || !!(marker.compareDocumentPosition(calls.at(-1)) & Node.DOCUMENT_POSITION_FOLLOWING),
                previousStillRejected: !marker || calls[0].dataset.rejectedCompletion === 'true',
              });
            }
          }
          return outcomes;
        });
        for (const result of results) {
          assert.equal(result.count, result.boundary === 'none' ? 1 : 2, `${result.kind}/${result.boundary}: completion count`);
          assert.equal(result.latestAfterBoundary, true, `${result.kind}/${result.boundary}: continuation order`);
          assert.equal(result.previousStillRejected, true, `${result.kind}/${result.boundary}: history preserved`);
        }
      }));

      await t.test('idle commands append after completed replies, even with a retained assistant reference', () => fixture(async page => {
        const result = await page.evaluate(async () => {
          isProcessing = false;
          renderAssistantTextUpdate(currentAssistantEl, 'Completed response', { replace: true });
          await parseSlashCommands('/progress');
          return {
            lastRole: messagesEl.lastElementChild.className,
            nested: currentAssistantEl.querySelectorAll('.slash-command-output').length,
            finalText: currentAssistantEl.querySelector('.message-text').textContent,
          };
        });
        assert.deepEqual(result, { lastRole: 'message system', nested: 0, finalText: 'Completed response' });
      }));

      await t.test('asynchronous progress respects the visible tab and handles empty/error replies at the live edge', () => fixture(async page => {
        const result = await page.evaluate(async () => {
          let resolveProgress;
          responseOverrides.get_progress = new Promise(resolve => { resolveProgress = resolve; });
          const pending = showProgress(7);
          currentTabId = 8;
          resolveProgress({ ok: true, rows: [{ id: 'wrong-tab' }] });
          await pending;
          const staleCount = messagesEl.querySelectorAll('.slash-command-output, .message.system').length;
          currentTabId = 7;
          responseOverrides.get_progress = { ok: true, rows: [] };
          await showProgress(7);
          responseOverrides.get_progress = { ok: false, error: 'unavailable' };
          await showProgress(7);
          return { staleCount, contents: [...currentAssistantEl.querySelectorAll('.slash-command-text')].map(node => node.textContent) };
        });
        assert.deepEqual(result, { staleCount: 0, contents: ['sp.progress.empty', 'sp.progress.error'] });
      }));
    } finally { await browser.close(); }
  });
}
