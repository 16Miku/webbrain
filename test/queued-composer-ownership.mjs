import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const queueSnapshot = (h, tabId = 1) => Array.from(h.context.getQueuedComposerMessages(tabId), item => ({ id: item.id, text: item.text }));

function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `Missing production function ${name}`);
  return source.slice(start, end + 2);
}

function fixture(build, { preferences = Promise.resolve(), refresh = Promise.resolve(), parsing = Promise.resolve() } = {}) {
  const source = fs.readFileSync(new URL(`../src/${build}/src/ui/sidepanel.js`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const send = extract(source, 'sendMessage');
  const boundary = send.indexOf('  await prepareChatHistoryForTurn(tabId, modeForSend);');
  assert.ok(boundary > 0, 'The harness runs the actual production preflight through its first run reservation.');
  const queue = [{ id: 'first', text: 'Original follow-up' }, { id: 'second', text: 'Later follow-up' }];
  const submitted = [], errors = [], drafts = new Map();
  const context = vm.createContext({
    currentTabId: 1, renderedTabId: 1, isProcessing: false, isStandaloneWindow: false,
    document: { visibilityState: 'visible' }, inputEl: { value: '' },
    queuedComposerMessagesByTab: new Map([[1, structuredClone(queue)]]),
    steeringRequestsByTab: new Map(), queuedComposerMessageSeq: 0,
    composerDeliveryModeReady: preferences, composerDeliveryMode: 'queue',
    waitForVisibleSidePanelStateRefresh: () => refresh,
    // The tab's kept mode is already read in these fixtures.
    restoreComposerModeBeforeSend: async () => {},
    parseSlashCommands: async text => { await parsing; return text; },
    submitted, errors, tabInputDrafts: drafts,
    saveInputDraftForTab: (tabId, text) => drafts.set(Number(tabId), text),
    setTabProcessing: (_tabId, processing) => { context.isProcessing = processing; },
    getPendingAttachmentsForTab: () => [], isAttachmentReadPendingForTab: () => false,
    normalizeSelectionSourceGrounding: () => null, normalizeSelectionAction: () => '',
    isConversationClearInProgress: () => false, isAwaitingPlanReviewForTab: () => false,
    isOutOfBandSlashDraft: () => false, isTabAbortRequested: () => false,
    permissionSkipCommandContextForDraft: () => null,
    parseTrailingRunCaptureDirective: () => null,
    modeForMessageText: () => 'act', rejectSelectionScopedMode: () => false,
    isApiMutationsAllowedForTab: () => false, isSelectionGroundedForTab: () => false,
    createRunRequestId: () => 'queue-test', t: (_key, args) => args?.msg || _key,
    addMessage: (_role, text) => errors.push(text),
    Promise, setTimeout, clearTimeout,
  });
  for (const name of [
    'dismissSelectionAskAction', 'stopListening', 'resetComposerHistoryNavigation',
    'hideSlashCommandAutocomplete', 'autoResizeInput', 'updateSlashCommandAutocomplete',
    'syncSendButtonState', 'renderQueuedComposerMessages', 'setTabAbortRequested',
    'showComposerToast', 'showBusySlashCommandNotice', 'scrollToBottom',
  ]) context[name] = () => {};
  const functions = [
    'sameTabId', 'getQueuedComposerMessages', 'setQueuedComposerMessages',
    'shiftQueuedComposerMessage', 'removeQueuedComposerMessage', 'enqueueQueuedComposerMessage',
    'composerSubmissionIsCurrent', 'queuedComposerSubmissionIsCurrent',
    'nextAutomaticQueuedComposerMessage', 'drainQueuedComposerMessageForCurrentTab',
  ].map(name => extract(source, name)).join('\n');
  // Only the history/render/network suffix is stubbed. The production queue,
  // async preflight, draft clearing and first run reservation execute verbatim.
  vm.runInContext(`${functions}\n${send.slice(0, boundary)}
    submitted.push({ tabId, text, params: chatExtraParams });
    return true;
  }`, context);
  return { context, queue, submitted, errors, drafts };
}

for (const build of ['chrome', 'firefox']) {
  for (const wait of ['preferences', 'refresh']) {
    test(`${build}: an ordinary Send cannot submit the other tab's draft after delayed ${wait}`, async () => {
      const gate = deferred(), h = fixture(build, { [wait]: gate.promise });
      h.context.inputEl.value = 'Explicit command for tab one';
      const sending = h.context.sendMessage(); await settle();
      h.drafts.set(1, h.context.inputEl.value);
      h.context.currentTabId = h.context.renderedTabId = 2;
      h.context.inputEl.value = 'Private unsent command for tab two';
      gate.resolve(); await sending;
      assert.deepEqual(h.submitted, [], 'Pressing Send before a tab switch authorizes only its original tab and draft.');
      assert.equal(h.context.inputEl.value, 'Private unsent command for tab two');
      assert.equal(h.drafts.get(1), 'Explicit command for tab one');
    });
  }

  test(`${build}: an ordinary Send cannot silently substitute a newer draft while preferences wait`, async () => {
    const gate = deferred(), h = fixture(build, { preferences: gate.promise });
    h.context.inputEl.value = 'Explicit original command';
    const sending = h.context.sendMessage(); await settle();
    h.context.inputEl.value = 'New command still being composed';
    gate.resolve(); await sending;
    assert.deepEqual(h.submitted, []);
    assert.equal(h.context.inputEl.value, 'New command still being composed');
  });

  test(`${build}: a new draft typed while ordinary slash preflight waits is preserved`, async () => {
    const gate = deferred(), h = fixture(build, { parsing: gate.promise });
    h.context.inputEl.value = 'Explicit original command';
    const sending = h.context.sendMessage(); await settle();
    h.context.inputEl.value = 'Next command still being composed';
    gate.resolve(); await sending;
    assert.deepEqual(h.submitted, []);
    assert.equal(h.context.inputEl.value, 'Next command still being composed');
  });

  test(`${build}: competing ordinary Sends reserve their original draft only once`, async () => {
    const gate = deferred(), h = fixture(build, { parsing: gate.promise });
    h.context.inputEl.value = 'Explicit original command';
    const first = h.context.sendMessage(), second = h.context.sendMessage();
    await settle(); gate.resolve(); await Promise.all([first, second]);
    assert.equal(h.submitted.length, 1, 'Two preflights cannot reserve separate runs for the same clicked draft.');
    assert.equal(h.submitted[0].text, 'Explicit original command');
  });

  test(`${build}: a newer original-tab draft survives a tab switch during slash preflight`, async () => {
    const gate = deferred(), h = fixture(build, { parsing: gate.promise });
    h.context.inputEl.value = 'Explicit original command';
    const sending = h.context.sendMessage(); await settle();
    h.drafts.set(1, 'Newer saved original-tab draft');
    h.context.currentTabId = h.context.renderedTabId = 2;
    h.context.inputEl.value = 'Other-tab draft';
    gate.resolve(); await sending;
    assert.deepEqual(h.submitted, []);
    assert.equal(h.drafts.get(1), 'Newer saved original-tab draft');
    assert.equal(h.context.inputEl.value, 'Other-tab draft');
  });

  test(`${build}: a valid mid-run Send still queues its exact clicked command`, async () => {
    const h = fixture(build); h.context.isProcessing = true;
    h.context.inputEl.value = 'Next command for this tab';
    assert.equal(await h.context.sendMessage(), true);
    assert.deepEqual(h.submitted, []);
    assert.deepEqual(queueSnapshot(h).map(item => item.text), [...h.queue.map(item => item.text), 'Next command for this tab']);
    assert.equal(h.context.inputEl.value, '');
  });

  test(`${build}: a valid immediate mid-run Send still steers its original tab`, async () => {
    const h = fixture(build), steered = []; h.context.isProcessing = true;
    h.context.composerDeliveryMode = 'steer';
    h.context.inputEl.value = 'Correction for this tab';
    h.context.steerComposerMessage = async (tabId, text) => { steered.push({ tabId, text }); return true; };
    assert.equal(await h.context.sendMessage(), true);
    assert.deepEqual(steered, [{ tabId: 1, text: 'Correction for this tab' }]);
    assert.deepEqual(h.submitted, []);
  });

  test(`${build}: an unrelated new run during idle Send preflight does not turn the clicked draft into steering`, async () => {
    const gate = deferred(), h = fixture(build, { preferences: gate.promise });
    h.context.inputEl.value = 'Original idle command';
    const sending = h.context.sendMessage(); await settle();
    h.context.isProcessing = true; gate.resolve(); await sending;
    assert.deepEqual(h.submitted, []);
    assert.deepEqual(queueSnapshot(h), h.queue);
    assert.equal(h.context.inputEl.value, 'Original idle command');
  });

  for (const wait of ['preferences', 'refresh']) {
    test(`${build}: a queued follow-up keeps its tab when ${wait} resolves after a tab switch`, async () => {
      const gate = deferred();
      const h = fixture(build, { [wait]: gate.promise });
      assert.equal(h.context.drainQueuedComposerMessageForCurrentTab(), true);
      await settle();
      h.drafts.set(1, h.context.inputEl.value);
      h.context.currentTabId = h.context.renderedTabId = 2;
      h.context.inputEl.value = 'Unsubmitted other-tab draft';
      gate.resolve(); await settle(); await settle();
      assert.deepEqual(h.submitted, [], 'The other tab draft must never become an automatic submission.');
      assert.deepEqual(queueSnapshot(h), h.queue);
      assert.equal(h.context.inputEl.value, 'Unsubmitted other-tab draft');
      assert.equal(h.drafts.get(1), h.queue[0].text);
      assert.deepEqual(h.errors, []);
    });
  }

  for (const wait of ['preferences', 'parsing']) {
    test(`${build}: a fresh draft typed during queued-send ${wait} stays unsubmitted`, async () => {
      const gate = deferred();
      const h = fixture(build, { [wait]: gate.promise });
      h.context.drainQueuedComposerMessageForCurrentTab(); await settle();
      h.context.inputEl.value = 'New draft while preparation waits';
      gate.resolve(); await settle(); await settle();
      assert.deepEqual(h.submitted, []);
      assert.equal(h.context.inputEl.value, 'New draft while preparation waits');
      assert.deepEqual(queueSnapshot(h), h.queue);
      assert.deepEqual(h.errors, []);
    });
  }

  test(`${build}: clearing the queue while automatic submission waits revokes its ownership`, async () => {
    const gate = deferred(), h = fixture(build, { preferences: gate.promise });
    h.context.drainQueuedComposerMessageForCurrentTab(); await settle();
    h.context.setQueuedComposerMessages(1, []);
    gate.resolve(); await settle(); await settle();
    assert.deepEqual(h.submitted, [], 'A removed queued item must not start after the user clears it.');
    assert.deepEqual(queueSnapshot(h), []);
    assert.deepEqual(h.errors, []);
  });

  test(`${build}: a replacement run during queued preflight retains the follow-up without steering it`, async () => {
    const gate = deferred(), h = fixture(build, { preferences: gate.promise });
    h.context.drainQueuedComposerMessageForCurrentTab(); await settle();
    h.context.isProcessing = true;
    gate.resolve(); await settle(); await settle();
    assert.deepEqual(h.submitted, []);
      assert.deepEqual(queueSnapshot(h), h.queue);
    assert.deepEqual(h.errors, []);
  });

  test(`${build}: competing automatic drains claim one queued item only once`, async () => {
    const gate = deferred(), h = fixture(build, { parsing: gate.promise });
    h.context.drainQueuedComposerMessageForCurrentTab(); await settle();
    h.context.inputEl.value = '';
    h.context.drainQueuedComposerMessageForCurrentTab(); await settle();
    gate.resolve(); await settle(); await settle();
    assert.equal(h.submitted.length, 1);
    assert.equal(h.submitted[0].text, h.queue[0].text);
    assert.deepEqual(queueSnapshot(h), h.queue.slice(1));
    assert.deepEqual(h.errors, []);
  });

  test(`${build}: successful queued preflight preserves FIFO and excludes its ownership token from chat arguments`, async () => {
    const h = fixture(build);
    h.context.drainQueuedComposerMessageForCurrentTab(); await settle(); await settle();
    assert.equal(h.submitted.length, 1);
    assert.equal(h.submitted[0].tabId, 1);
    assert.equal(h.submitted[0].text, h.queue[0].text);
    assert.equal(Object.hasOwn(h.submitted[0].params, '__queuedComposerMessage'), false);
    assert.equal(h.context.inputEl.value, '');
    assert.deepEqual(queueSnapshot(h), h.queue.slice(1));
    assert.deepEqual(h.errors, []);
  });

  test(`${build}: an explicit Send on the waiting automatic draft claims that queued item once`, async () => {
    const gate = deferred(), h = fixture(build, { preferences: gate.promise });
    h.context.drainQueuedComposerMessageForCurrentTab();
    const manualSend = h.context.sendMessage();
    await settle(); gate.resolve();
    await manualSend; await settle(); await settle();
    assert.equal(h.submitted.length, 1);
    assert.equal(h.submitted[0].text, h.queue[0].text);
    assert.deepEqual(queueSnapshot(h), h.queue.slice(1), 'The explicitly sent item must not remain queued for another run.');
    assert.deepEqual(h.errors, []);
  });
}
