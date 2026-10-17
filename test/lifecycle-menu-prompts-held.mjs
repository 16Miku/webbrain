// Browser-menu and selection-shortcut prompts after a user Stop. A prompt
// queued before or during the stopped run is held durably: it never starts on
// its own (this panel, another panel, a reopened panel, a restarted worker),
// stays listed as "Paused after Stop", and runs only on an explicit Send through
// the normal claim/lease path. Real storage, handler, background-route and
// side-panel code from both builds; only browser messaging is simulated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { afterEach, test } from 'node:test';
import { chromium, firefox } from 'playwright';

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
  return source.slice(start, end + to.length);
}
const unexport = source => source.replace(/^import [^;]+;\n/gm, '').replace(/^export /gm, '');
const settle = async (rounds = 12) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => (value === undefined ? value : structuredClone(value));

async function modules(build) {
  return {
    storage: await import(`../src/${build}/src/context-menu-storage.js`),
    createHandler: (await import(`../src/${build}/src/ui/context-menu-prompts.js`)).createContextMenuPromptHandler,
  };
}

function memoryArea() {
  const data = new Map();
  const state = { failWrites: false };
  return {
    data,
    state,
    area: {
      async get(key) { return data.has(key) ? { [key]: clone(data.get(key)) } : {}; },
      async set(values) {
        if (state.failWrites) throw new Error('QUOTA_BYTES quota exceeded');
        for (const [key, value] of Object.entries(values)) data.set(key, clone(value));
      },
      async remove(keys) { for (const key of [].concat(keys)) data.delete(key); },
    },
  };
}

let promptSeq = 0;
// The payload shapes the background stores for a selection shortcut.
function summarizePrompt(storage, tabId = 7) {
  const createdAt = 1_000 + (++promptSeq);
  return {
    id: `selection-${tabId}-${createdAt}`,
    tabId,
    text: storage.buildSelectionPrompt('Quarterly revenue grew 12% while costs fell.', 'summarize', '', 'en'),
    sourceGrounding: storage.SELECTION_ONLY_SOURCE_GROUNDING,
    selectionAction: 'summarize',
    createdAt,
  };
}
function fullContextQuestion(storage, tabId = 7) {
  const createdAt = 1_000 + (++promptSeq);
  return {
    id: `selection-${tabId}-${createdAt}`,
    tabId,
    text: storage.buildFullContextSelectionPrompt('Quarterly revenue grew 12%.', 'How does this compare with last year?'),
    restoreSelectionScope: true,
    createdAt,
  };
}

// Backgrounds still open when a test ends are closed, so a failing test cannot
// leave a panel retrying its claim and keep the test process alive.
const openBackgrounds = new Set();
afterEach(() => {
  for (const background of openBackgrounds) background.close();
  openBackgrounds.clear();
});

// The background routes the panel uses, over the real context-menu storage.
// restartWorker() drops every in-memory copy, like an MV3 worker restart.
function fakeBackground(storageModule) {
  const memory = memoryArea();
  let storage = storageModule.createContextMenuStorage(() => memory.area);
  const panels = new Set();
  const runs = [];
  const state = { runActive: false, beforeReserve: null, closed: false };
  const broadcast = (prompt) => {
    for (const panel of panels) panel.handler.acceptContextMenuPrompt(clone(prompt));
  };
  const background = {
    memory, runs, state, panels,
    storage: () => storage,
    close() { state.closed = true; panels.clear(); },
    restartWorker() { storage = storageModule.createContextMenuStorage(() => memory.area); },
    stored: tabId => memory.data.get(storage.key(tabId)) || null,
    async createPrompt(prompt) {
      await storage.save(prompt.tabId, prompt);
      broadcast(prompt);
    },
    // The user's Stop: the 'abort' route holds whatever the tab has pending.
    async stop(tabId) { await storage.hold(tabId); },
    async route(action, rawParams) {
      const params = clone(rawParams);
      if (state.closed) return { ok: true, claimed: false, released: false, reason: 'missing', prompt: null };
      let result;
      switch (action) {
        case 'consume_context_menu_prompt': result = await storage.consume(params.tabId); break;
        case 'claim_context_menu_prompt':
          result = await storage.claim(params.tabId, params.promptId, params.claimantId, () => state.runActive);
          // Storage keeps its real lease; only the panel's retry timer is shortened.
          if (result?.retryAfterMs) result.retryAfterMs = 20;
          if (result?.leaseExpiresAt && !result.claimed) result.leaseExpiresAt = Date.now() + 20;
          break;
        case 'release_context_menu_prompt_claim':
          result = await storage.release(params.tabId, params.promptId, params.claimantId);
          if (result?.released && result.prompt?.text) broadcast(result.prompt);
          break;
        case 'clear_context_menu_prompt': result = await storage.clear(params.tabId, params.promptId); break;
        case 'hold_context_menu_prompt': result = await storage.hold(params.tabId, params.promptId); break;
        case 'resume_context_menu_prompt': result = await storage.resume(params.tabId, params.promptId); break;
        default: throw new Error(`Unexpected background action ${action}`);
      }
      return clone(result);
    },
    // sendMessage for a claimed prompt: renew the claim, reserve the detached
    // run (chat_start), then the starting run clears the prompt (contextMenuClear).
    async startClaimedRun(extra, text) {
      const { contextMenuClear: target, contextMenuClaim: claim } = extra;
      const renewed = await background.route('claim_context_menu_prompt', { tabId: target.tabId, ...claim });
      if (!renewed.claimed) {
        extra.__onContextMenuClaimRejected?.(renewed);
        return false;
      }
      await state.beforeReserve?.();
      const reservation = await storage.reserve(target.tabId, claim.promptId, claim.claimantId, () => ({ ok: true, accepted: true }));
      if (!reservation.reserved) {
        await background.route('release_context_menu_prompt_claim', { tabId: target.tabId, ...claim });
        extra.__onContextMenuClaimRejected?.({ reason: reservation.reason });
        return false;
      }
      await storage.clear(target.tabId, target.promptId);
      runs.push({ text, extra });
      return true;
    },
  };
  openBackgrounds.add(background);
  return background;
}

function fakePanel(createHandler, background, tabId = 7) {
  let processing = false;
  const input = { value: '', dispatchEvent() {} };
  const sends = [];
  const panel = {
    sends,
    setProcessing(value) { processing = value; },
    handler: createHandler({
      getCurrentTabId: () => tabId,
      getIsProcessing: () => processing,
      getAgentMode: () => 'ask',
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async (extra) => {
        sends.push({ text: input.value, extra });
        return background.startClaimedRun(extra, input.value);
      },
      sendToBackground: (action, params) => background.route(action, params),
      onHeldPromptsChange() {},
    }),
  };
  background.panels.add(panel);
  return panel;
}

// A prompt arrives while a run is active, then the user stops that run: the
// background holds it at Stop and the panel holds what it queued.
async function heldAfterStop(build, makePrompt = summarizePrompt) {
  const { storage, createHandler } = await modules(build);
  const background = fakeBackground(storage);
  const panel = fakePanel(createHandler, background);
  panel.setProcessing(true);
  background.state.runActive = true;
  const prompt = makePrompt(storage);
  await background.createPrompt(prompt);
  await settle();
  assert.equal(panel.sends.length, 0, 'fixture: a prompt waits while the run is active');
  await background.stop(prompt.tabId);
  panel.handler.holdQueuedForTab(prompt.tabId);
  background.state.runActive = false;
  panel.setProcessing(false);
  panel.handler.drainQueuedContextMenuPrompts();
  await settle();
  return { storage, createHandler, background, panel, prompt };
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: storage holds a pending prompt durably until it is resumed or cleared`, async () => {
    const { storage } = await modules(build);
    const memory = memoryArea();
    const contextMenuStorage = storage.createContextMenuStorage(() => memory.area);
    const prompt = summarizePrompt(storage);
    await contextMenuStorage.save(prompt.tabId, prompt);

    assert.deepEqual(await contextMenuStorage.hold(prompt.tabId, 'some-other-prompt'), { ok: true, held: false, reason: 'missing' },
      'A hold that names another prompt never holds the pending one');
    const held = await contextMenuStorage.hold(prompt.tabId);
    assert.equal(held.held, true);
    assert.equal(memory.data.get(contextMenuStorage.key(prompt.tabId)).held, true, 'The hold is written to storage');
    assert.equal((await contextMenuStorage.consume(prompt.tabId)).prompt.held, true, 'Consumers learn that it is held');
    assert.deepEqual(await contextMenuStorage.claim(prompt.tabId, prompt.id, 'panel-a', () => false),
      { ok: true, claimed: false, reason: 'held' });
    let reserved = 0;
    assert.equal((await contextMenuStorage.reserve(prompt.tabId, prompt.id, 'panel-a', () => { reserved++; return {}; })).reason, 'held');
    assert.equal(reserved, 0, 'A held prompt cannot reserve a run');

    // A restarted worker reads the hold back from storage.
    const restarted = storage.createContextMenuStorage(() => memory.area);
    assert.equal((await restarted.consume(prompt.tabId)).prompt.held, true);
    assert.equal((await restarted.claim(prompt.tabId, prompt.id, 'panel-b', () => false)).reason, 'held');

    const resumed = await restarted.resume(prompt.tabId, prompt.id);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.prompt.held, undefined);
    assert.equal(memory.data.get(restarted.key(prompt.tabId)).held, undefined, 'Resume releases the durable hold');
    assert.equal(resumed.prompt.sourceGrounding, storage.SELECTION_ONLY_SOURCE_GROUNDING, 'Resume keeps grounding');
    assert.equal(resumed.prompt.selectionAction, 'summarize', 'Resume keeps the selection action');
    assert.equal((await restarted.claim(prompt.tabId, prompt.id, 'panel-b', () => false)).claimed, true);

    await restarted.hold(prompt.tabId, prompt.id);
    await restarted.clear(prompt.tabId, prompt.id);
    assert.equal(memory.data.has(restarted.key(prompt.tabId)), false, 'Delete clears a held prompt durably');
    assert.equal((await restarted.resume(prompt.tabId, prompt.id)).reason, 'missing');

    // A newer prompt replaces a held one and is not held itself.
    const older = summarizePrompt(storage);
    const newer = summarizePrompt(storage);
    await restarted.save(older.tabId, older);
    await restarted.hold(older.tabId);
    await restarted.save(newer.tabId, newer);
    assert.equal((await restarted.hold(older.tabId, older.id)).reason, 'missing');
    assert.equal((await restarted.claim(newer.tabId, newer.id, 'panel-c', () => false)).claimed, true);
  });

  test(`${build}: a hold whose storage write fails still holds the prompt in memory`, async () => {
    const { storage } = await modules(build);
    const memory = memoryArea();
    const contextMenuStorage = storage.createContextMenuStorage(() => memory.area);
    const prompt = summarizePrompt(storage);
    await contextMenuStorage.save(prompt.tabId, prompt);
    memory.state.failWrites = true;
    assert.equal((await contextMenuStorage.hold(prompt.tabId)).held, true, 'A storage failure does not fail Stop');
    assert.equal((await contextMenuStorage.consume(prompt.tabId)).prompt.held, true);
    assert.equal((await contextMenuStorage.claim(prompt.tabId, prompt.id, 'panel-a', () => false)).reason, 'held',
      'Reading the prompt does not drop the memory copy of its hold');
  });

  test(`${build}: a prompt queued during a stopped run is listed as held, not drained`, async () => {
    const { background, panel, prompt } = await heldAfterStop(build);
    assert.equal(panel.sends.length, 0, 'Nothing starts on its own after Stop');
    assert.equal(panel.handler.hasQueuedForTab(prompt.tabId), false, 'Held prompts are not automatic queue work');
    assert.deepEqual(panel.handler.getHeldForTab(prompt.tabId), [{ id: prompt.id, tabId: prompt.tabId, text: prompt.text }]);
    assert.equal(background.stored(prompt.tabId)?.held, true);
    await wait(60);
    assert.equal(panel.sends.length, 0, 'No retry starts it later either');
  });

  test(`${build}: Send runs a held prompt exactly once with its grounding and action`, async () => {
    const { background, panel, prompt } = await heldAfterStop(build);
    assert.equal(await panel.handler.runHeldPrompt(prompt.id), true);
    await settle();
    assert.equal(panel.sends.length, 1);
    assert.equal(panel.sends[0].text, prompt.text, 'The model receives the full selection prompt');
    const { contextMenuClaim, __onContextMenuClaimRejected, ...extra } = panel.sends[0].extra;
    assert.deepEqual(extra, {
      contextMenuClear: { tabId: prompt.tabId, promptId: prompt.id },
      sourceGrounding: prompt.sourceGrounding,
      selectionAction: 'summarize',
    }, 'The resumed run is an ordinary context-menu run');
    assert.equal(contextMenuClaim.promptId, prompt.id);
    assert.equal(typeof __onContextMenuClaimRejected, 'function');
    assert.equal(background.runs.length, 1);
    assert.equal(background.stored(prompt.tabId), null, 'Starting the run consumed the prompt');
    assert.deepEqual(panel.handler.getHeldForTab(prompt.tabId), []);
    assert.equal(await panel.handler.runHeldPrompt(prompt.id), false, 'A second Send cannot run it again');
    await settle();
    assert.equal(background.runs.length, 1);

    const question = await heldAfterStop(build, fullContextQuestion);
    await question.panel.handler.runHeldPrompt(question.prompt.id);
    await settle();
    assert.equal(question.panel.sends[0].extra.restoreSelectionScope, true, 'Full-context questions still restore the conversation scope');
    assert.equal(question.panel.sends[0].extra.sourceGrounding, undefined);
  });

  test(`${build}: Delete clears a held prompt durably; a reopened panel does not see it`, async () => {
    const { createHandler, background, panel, prompt } = await heldAfterStop(build);
    assert.equal(await panel.handler.deleteHeldPrompt(prompt.id), true);
    assert.equal(background.stored(prompt.tabId), null);
    assert.deepEqual(panel.handler.getHeldForTab(prompt.tabId), []);
    background.restartWorker();
    const reopened = fakePanel(createHandler, background);
    await reopened.handler.consumePendingContextMenuPrompt();
    reopened.handler.drainQueuedContextMenuPrompts();
    await settle();
    assert.deepEqual(reopened.handler.getHeldForTab(prompt.tabId), []);
    assert.equal(panel.sends.length + reopened.sends.length, 0);
  });

  test(`${build}: a held prompt survives a panel reopen and a worker restart without starting`, async () => {
    const { createHandler, background, prompt } = await heldAfterStop(build);
    background.restartWorker();
    const reopened = fakePanel(createHandler, background);
    await reopened.handler.consumePendingContextMenuPrompt();
    reopened.handler.drainQueuedContextMenuPrompts();
    await settle();
    assert.equal(reopened.sends.length, 0, 'Reopening the panel does not run it');
    assert.deepEqual(reopened.handler.getHeldForTab(prompt.tabId).map(item => item.id), [prompt.id], 'The reopened panel lists it as held');
    assert.equal(await reopened.handler.runHeldPrompt(prompt.id), true);
    await settle();
    assert.equal(background.runs.length, 1, 'An explicit Send still runs it');
  });

  test(`${build}: prompts created after Stop run as before and replace the held one`, async () => {
    const { storage, background, panel, prompt } = await heldAfterStop(build);
    const later = summarizePrompt(storage);
    await background.createPrompt(later);
    await settle();
    assert.deepEqual(background.runs.map(run => run.extra.contextMenuClaim.promptId), [later.id], 'A new prompt on an idle tab runs at once');
    assert.deepEqual(panel.handler.getHeldForTab(prompt.tabId), [], 'The newer prompt replaced the held one (one pending prompt per tab)');

    panel.setProcessing(true);
    background.state.runActive = true;
    const duringNextRun = summarizePrompt(storage);
    await background.createPrompt(duringNextRun);
    await settle();
    assert.equal(background.runs.length, 1, 'A prompt created during a later run waits for it');
    background.state.runActive = false;
    panel.setProcessing(false);
    panel.handler.drainQueuedContextMenuPrompts();
    await settle();
    assert.deepEqual(background.runs.map(run => run.extra.contextMenuClaim.promptId), [later.id, duringNextRun.id],
      'A run that ends without Stop drains it as before');
  });

  test(`${build}: a run that ends without Stop drains queued prompts`, async () => {
    const { storage, createHandler } = await modules(build);
    const background = fakeBackground(storage);
    const panel = fakePanel(createHandler, background);
    panel.setProcessing(true);
    background.state.runActive = true;
    const prompt = summarizePrompt(storage);
    await background.createPrompt(prompt);
    await settle();
    assert.equal(background.runs.length, 0);
    background.state.runActive = false;
    panel.setProcessing(false);
    panel.handler.drainQueuedContextMenuPrompts();
    await settle();
    assert.equal(background.runs.length, 1);
    assert.equal(background.runs[0].extra.sourceGrounding, prompt.sourceGrounding);
  });

  test(`${build}: another panel instance cannot start a held prompt, and Send still runs it once`, async () => {
    const { storage, createHandler } = await modules(build);
    const background = fakeBackground(storage);
    const stopped = fakePanel(createHandler, background);
    const other = fakePanel(createHandler, background);
    stopped.setProcessing(true);
    background.state.runActive = true;
    const prompt = summarizePrompt(storage);
    await background.createPrompt(prompt);
    await settle();
    // The other instance is idle: its claim is refused while the run is active.
    assert.equal(other.sends.length, 0);
    await background.stop(prompt.tabId);
    stopped.handler.holdQueuedForTab(prompt.tabId);
    background.state.runActive = false;
    stopped.setProcessing(false);
    stopped.handler.drainQueuedContextMenuPrompts();
    await wait(80); // the other instance retries its claim
    await settle();
    assert.equal(stopped.sends.length + other.sends.length, 0, 'Neither instance starts it on its own');
    assert.deepEqual(other.handler.getHeldForTab(prompt.tabId).map(item => item.id), [prompt.id],
      'The other instance lists it as held after its claim is refused');

    // Both instances press Send at once: the lease admits one run.
    const [first, second] = await Promise.all([
      stopped.handler.runHeldPrompt(prompt.id),
      other.handler.runHeldPrompt(prompt.id),
    ]);
    assert.equal(first || second, true);
    await wait(80);
    await settle();
    assert.equal(background.runs.length, 1, 'Exactly one run starts across panel instances');
    assert.equal(stopped.handler.getHeldForTab(prompt.tabId).length + other.handler.getHeldForTab(prompt.tabId).length, 0);
  });

  test(`${build}: a Stop between claim and run start leaves the prompt held`, async () => {
    const { storage, createHandler } = await modules(build);
    const background = fakeBackground(storage);
    const panel = fakePanel(createHandler, background);
    const prompt = summarizePrompt(storage);
    background.state.beforeReserve = async () => {
      background.state.beforeReserve = null;
      await background.stop(prompt.tabId);
    };
    await background.createPrompt(prompt);
    await settle();
    assert.equal(background.runs.length, 0, 'The reservation refuses a prompt held after its claim');
    assert.deepEqual(panel.handler.getHeldForTab(prompt.tabId).map(item => item.id), [prompt.id]);
    await wait(60);
    assert.equal(background.runs.length, 0, 'It is not retried automatically');
  });

  test(`${build}: a prompt that arrives while stopping is held durably by the panel`, async () => {
    const { storage, createHandler } = await modules(build);
    const background = fakeBackground(storage);
    const panel = fakePanel(createHandler, background);
    panel.setProcessing(true);
    background.state.runActive = true;
    await background.stop(7); // Stop with nothing pending yet
    const prompt = summarizePrompt(storage);
    await background.createPrompt(prompt); // arrives while the run is still stopping
    await settle();
    panel.handler.holdQueuedForTab(prompt.tabId); // the stopped run settles in the panel
    await settle();
    assert.equal(background.stored(prompt.tabId)?.held, true, 'The panel writes its hold to storage');
    background.state.runActive = false;
    background.restartWorker();
    const reopened = fakePanel(createHandler, background);
    await reopened.handler.consumePendingContextMenuPrompt();
    reopened.handler.drainQueuedContextMenuPrompts();
    await settle();
    assert.equal(reopened.sends.length + panel.sends.length, 0);
    assert.deepEqual(reopened.handler.getHeldForTab(prompt.tabId).map(item => item.id), [prompt.id]);
  });

  test(`${build}: navigation and conversation clear drop held prompts as before`, async () => {
    const navigated = await heldAfterStop(build);
    navigated.panel.handler.clearQueuedForTab(navigated.prompt.tabId);
    assert.deepEqual(navigated.panel.handler.getHeldForTab(navigated.prompt.tabId), []);

    const cleared = await heldAfterStop(build);
    cleared.panel.handler.clearQueuedForTab(cleared.prompt.tabId, { promptId: cleared.prompt.id });
    assert.deepEqual(cleared.panel.handler.getHeldForTab(cleared.prompt.tabId), []);
    cleared.panel.handler.acceptContextMenuPrompt({ ...cleared.prompt, held: true });
    assert.deepEqual(cleared.panel.handler.getHeldForTab(cleared.prompt.tabId), [], 'A late delivery of the cleared prompt stays dropped');
  });

  test(`${build}: user Stop routes hold the tab's prompt before the run can unwind`, async () => {
    const { storage } = await modules(build);
    const source = read(build, 'src/background.js');
    const api = build === 'chrome' ? 'chrome' : 'browser';
    const helper = extract(source, 'holdContextMenuPromptsAfterStop');
    const panelOnly = between(source, '  // Pausing or resuming a browser-menu prompt is a chat-panel decision.\n', '\n  }\n');
    const abortCase = between(source, "    case 'abort': {", '\n    }\n');
    const promptCases = between(source, "    case 'hold_context_menu_prompt':", '\n    }\n');
    const stopListenerStart = source.lastIndexOf(`${api}.runtime.onMessage.addListener(`, source.indexOf("if (msg?.type !== 'WB_STOP_AGENT')"));
    const stopListener = source.slice(stopListenerStart, source.indexOf('\n});', stopListenerStart) + 4);

    const memory = memoryArea();
    const contextMenuStorage = storage.createContextMenuStorage(() => memory.area);
    const events = [], listeners = [];
    const raceClaims = [];
    const context = vm.createContext({
      contextMenuStorage,
      events,
      agent: {
        researchEscalationSourceTab: () => null,
        // A panel whose claim reaches storage while the run unwinds.
        abort(tabId) {
          events.push(['abort', tabId]);
          raceClaims.push(contextMenuStorage.claim(tabId, `selection-${tabId}`, 'racing-panel', () => false));
        },
      },
      cancelDetachedRunStart: tabId => events.push(['cancel-start', tabId]),
      sendIndicatorMessage() {},
      [api]: {
        runtime: {
          getURL: path => `extension://webbrain/${path}`,
          onMessage: { addListener: listener => listeners.push(listener) },
        },
      },
    });
    vm.runInContext(`${helper}
      async function route(msg, sender) {
        ${panelOnly}
        switch (msg.action) {
      ${abortCase}
      ${promptCases}
        }
      }
      ${stopListener}`, context);
    // Values created inside the vm context belong to another realm.
    const plain = value => JSON.parse(JSON.stringify(value));
    const route = async (msg, sender = { url: 'extension://webbrain/src/ui/sidepanel.html' }) => plain(await context.route(msg, sender));
    const save = tabId => contextMenuStorage.save(tabId, { id: `selection-${tabId}`, tabId, text: 'Summarize this', createdAt: 1 });

    await save(7);
    assert.deepEqual(await route({ action: 'abort', tabId: 7 }), { ok: true });
    assert.deepEqual(plain(events), [['cancel-start', 7], ['abort', 7]], 'Stop still cancels and aborts the run');
    assert.equal(memory.data.get(contextMenuStorage.key(7)).held, true, 'The panel Stop holds the pending prompt');
    assert.equal((await raceClaims[0]).reason, 'held', 'A claim racing the unwinding run is refused');

    await save(8);
    await route({ action: 'abort', tabId: 8, conversationClear: true });
    assert.equal(memory.data.get(contextMenuStorage.key(8)).held, undefined, 'A conversation clear keeps its own prompt rules');

    await save(9);
    listeners[0]({ type: 'WB_STOP_AGENT' }, { tab: { id: 9 } }, () => {});
    await settle();
    assert.equal(memory.data.get(contextMenuStorage.key(9)).held, true, 'The page Stop button holds it too');

    const fromPage = await route({ action: 'resume_context_menu_prompt', tabId: 7, promptId: 'selection-7' }, { url: 'https://example.com/', tab: { id: 7 } });
    assert.equal(fromPage.ok, false, 'Pages cannot resume a held prompt');
    assert.equal(memory.data.get(contextMenuStorage.key(7)).held, true);
    const fromPanel = await route({ action: 'resume_context_menu_prompt', tabId: 7, promptId: 'selection-7' },
      { url: 'extension://webbrain/src/ui/sidepanel.html?standalone=1' });
    assert.equal(fromPanel.resumed, true, 'The chat panel can resume it');
    assert.equal((await route({ action: 'hold_context_menu_prompt', tabId: 7 })).ok, false, 'A panel hold must name its prompt');
  });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: the side panel lists a held menu prompt as paused with keyboard Send and Delete`, async () => {
    const panelSource = read(build, 'src/ui/sidepanel.js');
    const html = read(build, 'src/ui/sidepanel.html');
    const en = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    // Helpers that older panels lack are optional, so the Stop behavior itself
    // is what fails on them.
    const optional = name => (panelSource.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')) >= 0 ? extract(panelSource, name) : '');
    const functions = [
      ...['heldContextMenuPromptRow', 'handleHeldContextMenuPromptAction'].map(optional),
      ...['sameTabId', 'getQueuedComposerMessages', 'setQueuedComposerMessages', 'holdQueuedComposerMessages',
        'queuedComposerButton', 'renderQueuedComposerMessages', 'syncComposerDeliveryState',
        'removeQueuedComposerMessage', 'deleteQueuedComposerMessage'].map(name => extract(panelSource, name)),
    ].join('\n');
    const handlerWiring = between(panelSource, 'const {\n  acceptContextMenuPrompt,', '\n});');
    const clickListener = between(panelSource, "queuedMessagesEl?.addEventListener('click', (e) => {", '\n});');
    const queueMarkup = html.match(/<div id="queued-messages"[^>]*><\/div>/)[0];
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
      await page.setContent(`<style>${read(build, 'styles/sidepanel.css')}</style>${queueMarkup}<textarea id="user-input"></textarea><button id="btn-send"></button>`);
      await page.addScriptTag({ content: `(() => {
        ${unexport(read(build, 'src/context-menu-storage.js'))}
        ${unexport(read(build, 'src/ui/context-menu-prompts.js'))}
        const STRINGS = ${JSON.stringify(en)};
        const t = key => STRINGS[key] || key;
        const queuedMessagesEl = document.getElementById('queued-messages');
        const inputEl = document.getElementById('user-input');
        const sendBtn = document.getElementById('btn-send');
        let currentTabId = 7, renderedTabId = 7, isProcessing = true, agentMode = 'ask', composerDeliveryMode = 'queue';
        let autoModeSelection = false; // Settings → Mode selection: Manual
        let tabSwitchTransitionId = null, visibleStateRefreshPending = false, visibleStateRefreshInProgress = false, clearing = false;
        const processingTabs = new Set([7]), abortRequestedTabs = new Set();
        const queuedComposerMessagesByTab = new Map(), steeringRequestsByTab = new Map();
        const runs = [], calls = [], toasts = [];
        function isTabProcessing(tabId) { return processingTabs.has(Number(tabId)); }
        function isTabAbortRequested(tabId) { return abortRequestedTabs.has(Number(tabId)); }
        function isConversationClearInProgress() { return clearing; }
        function isAwaitingPlanReviewForTab() { return false; }
        function resetComposerHistoryNavigation() {}
        function setMode(mode) { agentMode = mode; }
        function autoResizeInput() {}
        function showComposerToast(text) { toasts.push(text); }
        function editQueuedComposerMessage() {}
        function steerComposerMessage() {}
        // The background, over the real context-menu storage.
        const area = new Map();
        const storage = createContextMenuStorage(() => ({
          get: async key => (area.has(key) ? { [key]: structuredClone(area.get(key)) } : {}),
          set: async values => { for (const [key, value] of Object.entries(values)) area.set(key, structuredClone(value)); },
          remove: async keys => { for (const key of [].concat(keys)) area.delete(key); },
        }));
        async function sendToBackground(action, params = {}) {
          calls.push(action);
          switch (action) {
            case 'consume_context_menu_prompt': return storage.consume(params.tabId);
            case 'claim_context_menu_prompt': return storage.claim(params.tabId, params.promptId, params.claimantId, () => isTabProcessing(params.tabId));
            case 'release_context_menu_prompt_claim': return storage.release(params.tabId, params.promptId, params.claimantId);
            case 'clear_context_menu_prompt': return storage.clear(params.tabId, params.promptId);
            case 'hold_context_menu_prompt': return storage.hold(params.tabId, params.promptId);
            case 'resume_context_menu_prompt': return storage.resume(params.tabId, params.promptId);
          }
          throw new Error('Unexpected background action ' + action);
        }
        // Like the real send: chat_start reserves the claimed prompt's run, which consumes the prompt.
        async function sendMessage(extra) {
          const { contextMenuClear: target, contextMenuClaim: claim } = extra;
          const reservation = await storage.reserve(target.tabId, claim.promptId, claim.claimantId, () => ({ accepted: true }));
          if (!reservation.reserved) { extra.__onContextMenuClaimRejected?.({ reason: reservation.reason }); return false; }
          await storage.clear(target.tabId, target.promptId);
          runs.push({ text: inputEl.value, sourceGrounding: extra.sourceGrounding, selectionAction: extra.selectionAction });
          inputEl.value = '';
          return true;
        }
        ${functions}
        ${handlerWiring}
        ${clickListener}
        const prompts = {};
        window.panel = {
          runs, calls, toasts, STRINGS,
          stored: () => area.get('contextMenuPrompt:7') || null,
          async arrive(prompt) { await storage.save(prompt.tabId, prompt); acceptContextMenuPrompt(prompt); },
          stop: () => holdQueuedComposerMessages(7),
          startRun: () => { processingTabs.add(7); isProcessing = true; syncComposerDeliveryState(); },
          endRun: () => { processingTabs.delete(7); isProcessing = false; syncComposerDeliveryState(); drainQueuedContextMenuPrompts(); },
          setClearing: value => { clearing = value; },
          // The payload a selection shortcut stores (one nonce per prompt).
          prompt: id => (prompts[id] ||= {
            id, tabId: 7, createdAt: Date.now(),
            text: buildSelectionPrompt('Quarterly revenue grew 12% while costs fell.', 'summarize', '', 'en'),
            sourceGrounding: SELECTION_ONLY_SOURCE_GROUNDING, selectionAction: 'summarize',
          }),
          display: text => formatSelectionPromptForDisplay(text),
          rows: () => [...queuedMessagesEl.querySelectorAll('.queued-message')].map(row => ({
            role: row.getAttribute('role'), held: row.dataset.held === 'true',
            label: row.querySelector('.queued-message-label').textContent,
            text: row.querySelector('.queued-message-text').textContent,
            buttons: [...row.querySelectorAll('button')].map(button => ({
              tag: button.tagName, type: button.type, title: button.title,
              label: button.getAttribute('aria-label'), disabled: button.disabled,
            })),
          })),
          hidden: () => queuedMessagesEl.classList.contains('hidden'),
        };
      })();` });
      const panel = (fn, ...args) => page.evaluate(fn, ...args);
      const settleInPage = () => page.waitForTimeout(40);

      // A selection prompt arrives during the run; the user presses Stop; the run settles.
      await panel(() => window.panel.arrive(window.panel.prompt('selection-7-a')));
      await panel(() => window.panel.stop());
      await panel(() => window.panel.endRun());
      await settleInPage();
      assert.deepEqual(await panel(() => window.panel.runs), [], 'Nothing starts on its own after Stop');
      const expectedText = await panel(() => window.panel.display(window.panel.prompt('selection-7-a').text));
      assert.match(expectedText, /^Summarize this selected text clearly and concisely\.\n\nSelected text:\n/);
      assert.deepEqual(await panel(() => window.panel.rows()), [{
        role: 'listitem', held: true, label: en['sp.queue.held'], text: expectedText,
        buttons: [
          { tag: 'BUTTON', type: 'button', title: en['sp.btn.send'], label: en['sp.btn.send'], disabled: false },
          { tag: 'BUTTON', type: 'button', title: en['sp.queue.delete'], label: en['sp.queue.delete'], disabled: false },
        ],
      }], 'The held prompt is listed as paused, as the chat bubble would show it, with Send and Delete');
      assert.equal(await panel(() => window.panel.hidden()), false);
      assert.equal(await panel(() => window.panel.stored()?.held), true, 'The panel holds it durably');
      assert.equal(await page.locator('.queued-message-text').first().evaluate(node => /untrusted|ctx-/.test(node.textContent + node.title)), false,
        'Model-only wrappers are never shown');

      // A later run neither enables Send nor releases the hold when it ends.
      await panel(() => window.panel.startRun());
      assert.equal((await panel(() => window.panel.rows()))[0].buttons[0].disabled, true, 'Send waits while the tab is busy');
      await panel(() => window.panel.endRun());
      await settleInPage();
      assert.deepEqual(await panel(() => window.panel.runs), []);
      assert.equal((await panel(() => window.panel.rows()))[0].buttons[0].disabled, false, 'Send is available once the tab is idle');

      // Keyboard: Tab reaches Send; Enter sends it through the normal claim path.
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'queued-message-action queued-message-run');
      await page.keyboard.press('Enter');
      await settleInPage();
      const prompt = await panel(() => window.panel.prompt('selection-7-a'));
      assert.deepEqual(await panel(() => window.panel.runs), [{ text: prompt.text, sourceGrounding: prompt.sourceGrounding, selectionAction: 'summarize' }]);
      assert.deepEqual(await panel(() => window.panel.rows()), []);
      assert.equal(await panel(() => window.panel.hidden()), true);
      assert.equal(await panel(() => window.panel.stored()), null);

      // Delete clears another held prompt without running it.
      await panel(() => { window.panel.startRun(); return window.panel.arrive(window.panel.prompt('selection-7-b')); });
      await panel(() => window.panel.stop());
      await panel(() => window.panel.endRun());
      await settleInPage();
      await page.locator('.queued-message-delete').focus();
      await page.keyboard.press('Enter');
      await settleInPage();
      assert.deepEqual(await panel(() => window.panel.rows()), []);
      assert.equal(await panel(() => window.panel.stored()), null, 'Delete clears it durably');
      assert.equal((await panel(() => window.panel.runs)).length, 1);
      assert.equal((await panel(() => window.panel.calls)).includes('clear_context_menu_prompt'), true);

      // A conversation clear stops the run without holding; the prompt keeps its usual path.
      await panel(() => { window.panel.startRun(); window.panel.setClearing(true); return window.panel.arrive(window.panel.prompt('selection-7-c')); });
      await panel(() => window.panel.stop());
      await settleInPage();
      assert.deepEqual(await panel(() => window.panel.rows()), []);
      assert.equal(await panel(() => window.panel.stored()?.held), undefined);
      await panel(() => { window.panel.setClearing(false); window.panel.endRun(); });
      await settleInPage();
      assert.equal((await panel(() => window.panel.runs)).length, 2, 'Without a user Stop it drains as before');
    } finally { await browser.close(); }
  });
}
