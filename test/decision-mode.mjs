// Decision models: Auto (default), On and Off.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

const area = { get: async () => ({}), set: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: x => x, sendMessage: async () => ({}) } };

const cache = await import('../src/chrome/src/providers/webgpu-model-cache.js');
const BONSAI_MARKER = cache.webgpuTextReadyMarkerUrl(cache.WEBGPU_LOCAL_ASSIST_MODEL_ID);
const COMPASS = { baseUrl: 'https://api.webbrain.one/v1', apiKey: 'managed' };
const NO_FEATURES = { done: false, watch: false, completion: false, classifications: false, browser: false, semantic: false };

// Cache Storage as the WebGPU worker leaves it after a finished download.
function withBonsaiCache(downloaded, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const lookups = [];
  globalThis.caches = {
    async match(url, options = {}) {
      lookups.push(url);
      return downloaded && options.cacheName === 'transformers-cache' && url === BONSAI_MARKER ? new Response('{}') : undefined;
    },
  };
  return Promise.resolve(fn(lookups)).finally(() => {
    if (saved) Object.defineProperty(globalThis, 'caches', saved); else delete globalThis.caches;
  });
}

for (const build of ['chrome', 'firefox']) {
  const config = await import(`../src/${build}/src/agent/decision-config.js`);
  const availability = await import(`../src/${build}/src/agent/decision-availability.js`);
  const transfer = await import(`../src/${build}/src/config-transfer.js`);
  const scheduler = await import(`../src/${build}/src/agent/scheduler.js`);

  test(`${build}: Auto is the default; a saved mode wins and an enabled pre-mode profile reads as On`, () => {
    assert.equal(config.resolveDecisionMode({}), 'auto');
    assert.equal(config.resolveDecisionMode({ systemOneEnabled: false }), 'auto');
    assert.equal(config.resolveDecisionMode({ systemOneEnabled: true }), 'on');
    assert.equal(config.resolveDecisionMode({ systemOneEnabled: true, decisionMode: 'off' }), 'off');
    assert.equal(config.resolveDecisionMode({ systemOneEnabled: false, decisionMode: 'on' }), 'on');
    assert.equal(config.resolveDecisionMode({ decisionMode: '' }), 'auto', 'an unset mode from an import');
    assert.equal(config.resolveDecisionMode({ decisionMode: 'maybe', systemOneEnabled: true }), 'on');
    assert.ok(config.DECISION_SETTINGS_KEYS.includes('decisionMode'));
    for (const key of Object.values(config.DECISION_FEATURE_KEYS)) assert.ok(config.DECISION_SETTINGS_KEYS.includes(key), key);
  });

  test(`${build}: Auto without the in-browser model or Compass answers nothing but keeps the configured fields`, () => {
    const selected = config.resolveDecisionConfig({ decisionProvider: 'typesafe', typesafeApiKey: 'ts-key' });
    assert.equal(selected.mode, 'auto'); assert.equal(selected.source, 'none');
    assert.equal(selected.enabled, false); assert.equal(selected.doneEnabled, false);
    assert.deepEqual(selected.features, NO_FEATURES);
    assert.equal(selected.provider, 'typesafe'); assert.equal(selected.apiKey, 'ts-key');
    for (const feature of config.DECISION_FEATURES) assert.equal(config.decisionFeatureEnabled(selected, feature), false, feature);
  });

  test(`${build}: Auto with Compass keeps its managed completion checks and semantic decisions only`, () => {
    const selected = config.resolveDecisionConfig({ systemOneFastBrowser: true, systemOneFastClassifications: true }, COMPASS, { localAssistReady: true });
    assert.equal(selected.provider, 'compass'); assert.equal(selected.source, 'compass'); assert.equal(selected.enabled, true);
    assert.deepEqual(selected.features, { ...NO_FEATURES, done: true, semantic: true });
    assert.equal(config.decisionFeatureEnabled(selected, 'browser'), false, 'stored fast switches need On');
  });

  test(`${build}: Off answers nothing, Compass included, whatever is downloaded`, () => {
    const off = config.resolveDecisionConfig({ decisionMode: 'off', systemOneEnabled: true, decisionProvider: 'local' }, COMPASS, { localAssistReady: true });
    assert.equal(off.enabled, false); assert.equal(off.source, 'off'); assert.notEqual(off.provider, 'compass');
    assert.deepEqual(off.features, NO_FEATURES);
  });

  test(`${build}: On answers every decision unless a switch is off; a pre-mode profile keeps its opt-in switches`, () => {
    const on = config.resolveDecisionConfig({ decisionMode: 'on', decisionProvider: 'local', systemOneFastBrowser: false });
    assert.equal(on.enabled, true); assert.equal(on.source, 'configured');
    assert.deepEqual(on.features, { done: true, watch: true, completion: true, classifications: true, browser: false, semantic: true });
    const legacy = config.resolveDecisionConfig({ systemOneEnabled: true, decisionProvider: 'local', systemOneWatchEnabled: true });
    assert.equal(legacy.mode, 'on');
    assert.deepEqual(legacy.features, { done: true, watch: true, completion: false, classifications: false, browser: false, semantic: true });
    const unconfigured = config.resolveDecisionConfig({ decisionMode: 'on', decisionProvider: 'openrouter' });
    assert.equal(unconfigured.enabled, false, 'a cloud provider still needs its key');
    const d1 = config.resolveDecisionConfig({ decisionMode: 'on', decisionProvider: 'webgpu_d1' });
    assert.equal(d1.enabled, false, 'D1 still needs its consent');
    assert.equal(config.resolveDecisionConfig({ decisionMode: 'on', decisionProvider: 'typesafe', typesafeApiKey: 'k' }, COMPASS).provider, 'compass',
      'On with Compass answers on Compass unless a local provider is chosen');
  });

  test(`${build}: imports carry the mode, reject unknown modes and keep old exports meaning what they meant`, () => {
    const roundTrip = transfer.parseConfigImport(JSON.stringify(transfer.createConfigExport({ decisionMode: 'off' }))).settings;
    assert.equal(roundTrip.decisionMode, 'off');
    assert.throws(() => transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { decisionMode: 'always' } })), /Invalid value/);
    assert.throws(() => transfer.parseConfigPatchImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { decisionMode: 1 } })), /Invalid value/);
    const old = transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { systemOneEnabled: true, typesafeApiKey: 'legacy' } })).settings;
    assert.equal(old.decisionMode, '');
    assert.equal(config.resolveDecisionMode(old), 'on');
    assert.equal(config.resolveDecisionMode(transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: {} })).settings), 'auto');
  });

  test(`${build}: scheduled checks follow the mode`, async () => {
    let calls = 0;
    const judge = { evaluate: async () => { calls++; return { model: 'judge', answers: { condition_met: { noul: .95 }, task_complete: { noul: .95 }, task_completeness: { score: 2 } } }; } };
    const h = makeSchedulerHarness(scheduler, { systemOneJudge: judge });
    const evidence = { observations: [{ data: 'Status: done' }] };
    const run = (settings, source = 'watch') => h.manager._evaluateSystemOne({ source, prompt: 'Watch status', tabId: 77 }, '', 'success', { settings, evidence });
    assert.equal((await run({ decisionMode: 'off', systemOneEnabled: true, typesafeApiKey: 'k', systemOneWatchEnabled: true })).reason, 'disabled');
    assert.equal((await run({ decisionMode: 'on', decisionProvider: 'typesafe', typesafeApiKey: 'k' })).decision, 'keep', 'On checks a watch with no switch saved');
    assert.equal((await run({ decisionMode: 'on', decisionProvider: 'typesafe', typesafeApiKey: 'k', systemOneCompletionEnabled: false }, 'scheduled')).reason, 'disabled');
    assert.equal((await run({ systemOneEnabled: true, typesafeApiKey: 'k' })).reason, 'disabled', 'a pre-mode profile keeps watches opt-in');
    assert.equal(calls, 1);
    await withBonsaiCache(true, async () => {
      const verdict = await run({});
      if (build === 'chrome') assert.equal(verdict.decision, 'keep', 'Auto checks with the downloaded in-browser model');
      else assert.equal(verdict.reason, 'disabled', 'Firefox has no in-browser model');
    });
  });

  test(`${build}: the current configuration looks for the in-browser model only when Auto could use it`, async () => {
    await withBonsaiCache(true, async lookups => {
      const auto = await availability.resolveCurrentDecisionConfig({});
      if (build === 'chrome') {
        assert.equal(auto.source, 'local_assist'); assert.equal(auto.provider, 'webgpu_chat');
        assert.equal(auto.model, config.WEBGPU_CHAT_DECISION_MODEL); assert.equal(auto.local, true);
        assert.equal(auto.supportsVision, true); assert.equal(auto.requiresIndependentSuccessConfirmation, true);
        assert.deepEqual(auto.features, { ...NO_FEATURES, done: true, watch: true, completion: true },
          'Auto keeps fast actions and semantic decisions on the main model');
        assert.equal(lookups.length, 1);
      } else {
        assert.equal(auto.enabled, false); assert.equal(lookups.length, 0);
      }
      lookups.length = 0;
      await availability.resolveCurrentDecisionConfig({}, COMPASS);
      await availability.resolveCurrentDecisionConfig({ decisionMode: 'off' });
      await availability.resolveCurrentDecisionConfig({ decisionMode: 'on', decisionProvider: 'local' });
      assert.equal(lookups.length, 0, 'Compass, Off and On never read the cache');
    });
    await withBonsaiCache(false, async () => {
      assert.equal((await availability.resolveCurrentDecisionConfig({})).enabled, false);
    });
  });

  test(`${build}: agent decision paths ask for their own decision`, async () => {
    const saved = globalThis.chrome;
    const store = { decisionMode: 'on', decisionProvider: 'local', systemOneFastBrowser: false };
    const local = { get: async () => ({ ...store }), set: async values => Object.assign(store, values) };
    globalThis.chrome = globalThis.browser = { ...saved, storage: { local, session: local } };
    try {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const agent = new Agent({ getActive: () => ({ config: {} }) });
      assert.ok(await agent._jevSettings(1, { config: {} }, 'semantic'));
      assert.ok(await agent._jevSettings(1, { config: {} }, 'classifications'));
      assert.equal(await agent._jevSettings(1, { config: {} }, 'browser'), null, 'a switched-off decision');
      store.decisionMode = 'auto';
      await withBonsaiCache(true, async () => {
        assert.equal(await agent._jevSettings(1, { config: {} }, 'semantic'), null, 'Auto leaves semantic decisions to the main model');
        assert.equal(await agent._jevSettings(1, { config: {} }, 'classifications'), null);
      });
      store.decisionMode = 'off';
      assert.equal(await agent._jevSettings(1, { config: { providerName: 'webbrain-cloud', baseUrl: COMPASS.baseUrl } }, 'semantic'), null, 'Off turns Compass off too');
    } finally {
      globalThis.chrome = globalThis.browser = saved;
    }
  });
}

test('Firefox imports a Chrome On selection of the Chrome-only chat model in Auto', async () => {
  const transfer = await import('../src/firefox/src/config-transfer.js');
  const chromeExport = { schema: transfer.CONFIG_SCHEMA, settings: { decisionMode: 'on', decisionProvider: 'webgpu_chat', systemOneEnabled: true } };
  const restored = transfer.parseConfigImport(JSON.stringify(chromeExport)).settings;
  assert.equal(restored.decisionMode, 'auto'); assert.equal(restored.systemOneEnabled, false); assert.equal(restored.decisionProvider, '');
  const patch = transfer.parseConfigPatchImport(JSON.stringify(chromeExport)).settings;
  assert.equal(patch.decisionMode, 'auto');
  const off = transfer.parseConfigImport(JSON.stringify({ ...chromeExport, settings: { ...chromeExport.settings, decisionMode: 'off' } })).settings;
  assert.equal(off.decisionMode, 'off', 'an explicit Off stays off');
});
