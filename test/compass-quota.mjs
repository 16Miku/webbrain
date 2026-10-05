import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const area = { async get() { return {}; }, async set() {}, async remove() {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/', title: 'Example' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};

for (const browser of ['chrome', 'firefox']) {
  const base = new URL(`../src/${browser}/src/`, import.meta.url);
  const { OpenAICompatibleProvider } = await import(new URL('providers/openai.js', base));
  const { RunUiJournal } = await import(new URL('run-ui-journal.js', base));
  const { runDetachedWithReconnect } = await import(new URL('run-reconnect.js', base));
  const { Agent } = await import(new URL('agent/agent.js', base));
  const { formatQuotaUsd, socialComposer } = await import(new URL('ui/compass-quota.js', base));
  const { quotaTranslations } = await import(new URL('ui/locales/compass-quota-copy.mjs', base));
  const payload = {
    error: { code: 'webbrain_cloud_free_tier_exceeded', message: 'Weekly quota exhausted.' },
    usage: { base_weekly_allowance_usd: 0.375, promotional_balance_usd: 0.25,
      next_reset_at: '2026-10-12T00:00:00+00:00', social_claim: { eligible: false, status: 'approved' } },
    subscribe_url: 'https://buy.stripe.com/test?client_reference_id=device-1',
  };
  const provider = new OpenAICompatibleProvider({ providerName: 'webbrain-cloud', deviceGuid: 'device-1' });
  test(`${browser}: structured metadata and legacy checkout survive a provider error`, () => {
    const error = provider._httpError(402, JSON.stringify(payload), 'Compass');
    assert.equal(error.quota.code, payload.error.code);
    assert.deepEqual(error.quota.usage, payload.usage);
    assert.match(error.message, /Subscribe for more usage: https:\/\/buy.stripe.com\/test/);
    assert.equal(error.httpStatus, 402);
    assert.equal(new Agent({})._isCostAllowanceError(error), true);
    const other = new OpenAICompatibleProvider({ providerName: 'openai' })._httpError(402, JSON.stringify(payload), 'OpenAI');
    assert.equal(other.quota, undefined);
  });
  test(`${browser}: quota metadata survives evicted events, persistence, and terminal replay`, () => {
    const journal = new RunUiJournal({ eventLimit: 2 });
    journal.begin(41, 'quota-run');
    journal.record(41, 'quota-run', 'quota', { quota: provider._httpError(402, JSON.stringify(payload), '').quota });
    for (let i = 0; i < 5; i++) journal.record(41, 'quota-run', 'warning', { message: 'stopped' });
    const terminal = journal.finish(41, 'quota-run', 'failed', 'Localized quota text without a trailing URL');
    assert.deepEqual(terminal.quota.usage, payload.usage);
    assert.deepEqual(terminal.events.at(-1).data.quota.usage, payload.usage);
    const restored = JSON.parse(JSON.stringify(terminal));
    assert.equal(restored.quota.usage.social_claim.eligible, false);
    assert.equal(restored.events.some(e => e.type === 'quota'), false);
  });
  test(`${browser}: reconnect restores quota without auto-resume or a duplicate error card`, async () => {
    let starts = 0;
    const quota = provider._httpError(402, JSON.stringify(payload), '').quota;
    const response = await runDetachedWithReconnect({ initialAction: 'chat_start', payload: { requestId: 'stopped-quota' },
      start: async () => { starts++; return { accepted: true, requestId: 'stopped-quota' }; },
      probe: async () => ({ submittedTurnDurable: true, runUi: { requestId: 'stopped-quota', status: 'failed',
        finalContent: 'Localized quota text', quota, events: [] } }), wait: async () => {}, pollIntervalMs: 0 });
    assert.equal(starts, 1);
    assert.deepEqual(response.quota, quota);
    assert.equal(response.updates.some(update => update.type === 'error'), false);
    assert.equal(response.submittedTurnDurable, true);
  });
  for (const mode of ['chat', 'stream']) test(`${browser}: ${mode} stops once with structured quota and retains the task`, async () => {
    const error = provider._httpError(402, JSON.stringify(payload), 'Compass');
    let calls = 0;
    const stub = { name: 'Compass test', model: 'test', contextWindow: 128000, supportsTools: false,
      supportsVision: false, promptTier: 'full',
      chat: async () => { calls++; throw error; },
      async *chatStream() { calls++; throw error; } };
    const agent = new Agent({ getActive: () => stub, getProvider: () => stub, getVisionProvider: async () => null });
    agent._hydrate = async () => {}; agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true }); agent._startTraceRun = async () => null; agent._endTraceRun = async () => {};
    agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
    agent._manageContext = async () => {}; agent._checkCostAllowance = async () => null;
    agent._recordCostUsage = async () => null; agent._currentUrl = async () => 'https://example.com/';
    agent.executeTool = async () => assert.fail('Quota recovery dispatched a browser action');
    const events = [];
    const update = (type, data) => events.push({ type, data });
    const result = mode === 'chat'
      ? await agent.processMessage(41, 'Retain this stopped task', update, 'ask', [], { standaloneChat: true, askStreamingEnabled: false })
      : await agent.processMessageStream(41, 'Retain this stopped task', update, 'ask', { standaloneChat: true });
    assert.match(String(result), /Weekly quota exhausted/);
    assert.equal(calls, 1, 'quota must not trigger automatic provider retries');
    assert.equal(events.find(e => e.type === 'quota')?.data.quota.usage.base_weekly_allowance_usd, 0.375);
  });
  test(`${browser}: structured card routing works without a Subscribe string`, () => {
    const panel = fs.readFileSync(new URL('ui/sidepanel.js', base), 'utf8');
    const start = panel.indexOf('function renderSubscribeError(');
    const body = panel.slice(start, panel.indexOf('function renderCostAllowanceError(', start));
    let mounted;
    const render = vm.runInNewContext(`${body}; renderSubscribeError`, {
      parseSubscribeError: () => null, quotaController: { mount: (...args) => { mounted = args; return true; } }, agentMode: 'ask',
    });
    const host = { dataset: {}, closest: () => ({ dataset: {} }) };
    assert.equal(render(host, 'Localized error', 'ask', { code: payload.error.code, usage: payload.usage }, { submittedTurnDurable: false }), true);
    assert.equal(mounted[2].retry, true);
    assert.equal(mounted[2].mode, 'ask');
    host.dataset.quota = JSON.stringify(mounted[1]);
    host.dataset.quotaContext = JSON.stringify(mounted[2]);
    render(host, 'Restored localized text');
    assert.equal(mounted[2].retry, true, 'restored durable-turn decision must survive rerendering');
  });
  test(`${browser}: response-only quota emits one recovery signal and preserves the stopped turn`, async () => {
    const agent = new Agent({});
    agent._consumeContextOnlyAbort = () => null;
    agent._persist = () => {};
    const events = [];
    const messages = [{ role: 'user', content: 'Keep this question' }];
    const error = provider._httpError(402, JSON.stringify(payload), 'Compass');
    agent._generateContextOnlyResponse = async () => { throw error; };
    const result = await agent._completeResponseOnlyTurn(41, messages, (type, data) => events.push({ type, data }));
    assert.equal(result.status, 'cost_limit');
    assert.equal(events.filter(e => e.type === 'quota').length, 1);
    assert.equal(events.filter(e => e.type === 'error').length, 0);
    assert.equal(messages[0].content, 'Keep this question');
    assert.equal(messages.at(-1).content, result.content);
    const background = fs.readFileSync(new URL('background.js', base), 'utf8');
    const classifiers = background.slice(background.indexOf('function isClarificationRequiredRunUpdate('), background.indexOf('async function getRunUiSnapshot('));
    const { terminalRunUiStatus, runUpdatesSucceeded, askCompletionSucceededForBadge } = vm.runInNewContext(`${classifiers}; ({ terminalRunUiStatus, runUpdatesSucceeded, askCompletionSucceededForBadge })`);
    assert.equal(terminalRunUiStatus('Localized quota stop', events), 'failed');
    assert.equal(runUpdatesSucceeded(events), false, 'user memory must see the stopped turn as unsuccessful');
    assert.equal(askCompletionSucceededForBadge('Localized quota stop', events), false);
    const journal = new RunUiJournal(); journal.begin(41, 'response-only-quota');
    for (const event of events) journal.record(41, 'response-only-quota', event.type, event.data);
    const snapshot = journal.finish(41, 'response-only-quota', terminalRunUiStatus(result.content, events), result.content);
    const reconnected = await runDetachedWithReconnect({ initialAction: 'chat_start', payload: { requestId: 'response-only-quota' },
      start: async () => ({ accepted: true, requestId: 'response-only-quota' }),
      probe: async () => ({ submittedTurnDurable: true, runUi: snapshot }), wait: async () => {}, pollIntervalMs: 0 });
    assert.equal(reconnected.success, false);
    assert.equal(reconnected.quota.code, payload.error.code);
    assert.equal(reconnected.updates.filter(e => e.type === 'error').length, 0, 'failed classification must preserve a single quota card');
    const panel = fs.readFileSync(new URL('ui/sidepanel.js', base), 'utf8');
    const askEnd = panel.indexOf('\n}\n', panel.indexOf('function isSuccessfulAskCompletion(')) + 3;
    const askClassifiers = panel.slice(panel.indexOf('function updatesContainStoreReviewFailure('), askEnd);
    const isSuccessfulAskCompletion = vm.runInNewContext(`${askClassifiers}; isSuccessfulAskCompletion`, { parseSubscribeError: () => null, parseCostAllowanceError: () => null });
    assert.equal(isSuccessfulAskCompletion('ask', { content: 'Localized quota stop', updates: events }), false);
    assert.equal(isSuccessfulAskCompletion('ask', { content: 'Localized quota stop', quota: error.quota, updates: [] }), false);
    agent._generateContextOnlyResponse = async () => { throw new Error('Other failure'); };
    events.length = 0;
    await agent._completeResponseOnlyTurn(41, messages, (type, data) => events.push({ type, data }));
    assert.equal(events.filter(e => e.type === 'error').length, 1, 'ordinary errors must still be rendered');
  });
  test(`${browser}: quota provider switch checks real connection results, exceptions and stale tests`, async () => {
    const panel = fs.readFileSync(new URL('ui/sidepanel.js', base), 'utf8');
    const start = panel.indexOf('async function testConnection(');
    const connection = panel.slice(start, panel.indexOf('function getSlashAutocompleteContext(', start));
    const switchStart = panel.indexOf('  async switchProvider(id) {');
    const switchMethod = panel.slice(switchStart, panel.indexOf('  openSettings:', switchStart));
    let response = { ok: false, error: 'Invalid credentials' };
    let failure;
    const sandbox = { providerSelect: { value: 'own-key' }, providerTestRequestId: 0, isProcessing: false,
      statusDot: {}, t: key => key, setActiveChatProvider: async () => {}, syncProviderPickerButton: () => {},
      sendToBackground: async () => { if (failure) throw failure; return response; } };
    const context = vm.createContext(sandbox);
    const switchProvider = vm.runInContext(`${connection}; ({${switchMethod}}).switchProvider`, context);
    await assert.rejects(switchProvider('own-key'), /Invalid credentials/);
    assert.equal(sandbox.statusDot.className, 'status-dot offline');
    failure = new Error('Network unavailable');
    await assert.rejects(switchProvider('own-key'), /Network unavailable/);
    failure = null; response = { ok: true, model: 'local model' };
    await switchProvider('local');
    assert.equal(sandbox.statusDot.className, 'status-dot online');
    sandbox.sendToBackground = async () => { sandbox.providerTestRequestId++; return response; };
    await assert.rejects(switchProvider('local'), /sp.status.failed/);
  });
  test(`${browser}: all supported locales and exact decimal displays`, () => {
    const codes = ['en', 'es', 'fr', 'tr', 'zh', 'ru', 'uk', 'ar', 'ja', 'ko', 'id', 'th', 'ms', 'tl', 'pl', 'he', 'hi', 'pt', 'vi', 'bn', 'fa', 'nl', 'de'];
    for (const code of codes) {
      assert.deepEqual(Object.keys(quotaTranslations[code]), Object.keys(quotaTranslations.en));
      assert.equal(Object.values(quotaTranslations[code]).every(value => typeof value === 'string' && value.length > 0), true);
    }
    assert.equal(formatQuotaUsd(0.375, 'en-US'), '$0.375');
    assert.equal(formatQuotaUsd(0.50, 'en-US'), '$0.50');
    for (const platform of ['x', 'bluesky']) assert.equal(new URL(socialComposer(platform, 'Edited copy https://webbrain.one/?share=opaque')).searchParams.get('text'), 'Edited copy https://webbrain.one/?share=opaque');
  });
}
test('quota controller and localized copy remain byte-identical in both extensions', () => {
  for (const file of ['ui/compass-quota.js', 'ui/locales/compass-quota-copy.mjs']) {
    assert.equal(fs.readFileSync(new URL(`../src/chrome/src/${file}`, import.meta.url), 'utf8'), fs.readFileSync(new URL(`../src/firefox/src/${file}`, import.meta.url), 'utf8'));
  }
});
