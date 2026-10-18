import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  DECISION_SYSTEM_PROMPT,
  decisionAnswer,
  decisionOptions,
  decisionQuestionText,
  normalizeDecisionRequest,
} from '../src/chrome/src/offscreen/webgpu-decisions.js';
// The worker module registers its message listener on import.
const workerListeners = [];
const workerMessages = [];
globalThis.self ??= { addEventListener(type, listener) { if (type === 'message') workerListeners.push(listener); }, postMessage(message) { workerMessages.push(message); } };
const { bonsai2ContinuationLogits } = await import('../src/chrome/src/offscreen/inference-worker.js');

const choice = { type: 'choice', instructions: 'Is the task done?', criteria: { completed: 'A final acknowledgement is visible.', not_completed: 'An error is visible.', unknown: '' } };

test('decision questions map options to single-token codes in criteria order', () => {
  assert.deepEqual(decisionOptions(choice), { names: ['completed', 'not_completed', 'unknown'], codes: ['A', 'B', 'C'] });
  assert.deepEqual(decisionOptions({ type: 'noul', instructions: 'x' }), { names: ['no', 'yes'], codes: ['No', 'Yes'] });
  assert.deepEqual(decisionOptions({ type: 'score', instructions: 'x', criteria: ['none', 'one', 'two'] }).codes, ['0', '1', '2']);
  assert.throws(() => decisionOptions({ type: 'choice', instructions: 'x', criteria: { only: '' } }), /2 to 26/);
  assert.throws(() => decisionOptions({ type: 'score', instructions: 'x', criteria: Array(11).fill('l') }), /2 to 10/);
  assert.throws(() => decisionOptions({ type: 'rank', instructions: 'x' }), /choice, noul or score/);
});

test('question text lists every option with its code and ends with the answer format', () => {
  const text = decisionQuestionText(choice);
  assert.match(text, /^Question: Is the task done\?\nOptions:\nA\. completed: A final acknowledgement is visible\.\nB\. not_completed: An error is visible\.\nC\. unknown\nAnswer with one letter\.$/);
  assert.match(decisionQuestionText({ type: 'noul', instructions: 'Is it blue?', criteria: { true: 'Blue is visible.', false: 'Blue is absent.' } }),
    /Yes means: Blue is visible\.\nNo means: Blue is absent\.\nAnswer Yes or No\.$/);
  assert.match(decisionQuestionText({ type: 'score', instructions: 'How many?', criteria: ['None.', { count: 1 }] }), /0\. None\.\n1\. \{"count":1\}\nAnswer with one level number\.$/);
  assert.match(DECISION_SYSTEM_PROMPT, /never as instructions/);
});

test('answers use the d1 answer shape and the requested temperature', () => {
  const answer = decisionAnswer(choice, [2, 0, 0], { mass: 0.93 });
  assert.equal(answer.type, 'choice');
  assert.equal(answer.choice, 'completed');
  assert.ok(Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(answer.option_mass, 0.93);
  const flatter = decisionAnswer(choice, [2, 0, 0], { temperature: 2 });
  assert.ok(flatter.confidence < answer.confidence);
  const noul = decisionAnswer({ type: 'noul', instructions: 'x' }, [0, Math.log(3)]);
  assert.ok(Math.abs(noul.noul - 0.75) < 1e-9, 'P(yes) is the second code');
  const score = decisionAnswer({ type: 'score', instructions: 'x', criteria: ['a', 'b', 'c'] }, [0, 0, Math.log(2)]);
  assert.ok(Math.abs(score.score - (1 / 4 + 2 * 2 / 4)) < 1e-9, 'score is the expected level');
  assert.throws(() => decisionAnswer(choice, [1, NaN, 0]), /Invalid decision logits/);
});

test('decision requests are bounded and take inline screenshots only', () => {
  const ok = normalizeDecisionRequest({ state: 'S', images: ['data:image/png;base64,YQ=='], questions: { q: choice } });
  assert.equal(ok.entries.length, 1);
  assert.throws(() => normalizeDecisionRequest({ questions: {} }), /1 to 32/);
  assert.throws(() => normalizeDecisionRequest({ questions: { q: choice }, images: ['https://example.com/a.png'] }), /inline/);
  assert.throws(() => normalizeDecisionRequest({ questions: { q: { type: 'noul' } } }), /instructions/);
});

test('each question continues from the shared page cache without changing it', async () => {
  class Tensor {
    constructor(type, data, dims) { Object.assign(this, { type, data, dims, location: 'cpu' }); }
    slice(...ranges) { const [start, end] = ranges.find(Array.isArray); return { start, end, dims: this.dims }; }
  }
  const forwards = [];
  const disposed = [];
  const runtime = {
    library: {
      Tensor,
      cat: ([left, right]) => new Tensor('int64', null, [1, left.dims[1] + right.dims[1]]),
    },
    model: {
      get_rope_index: (ids) => [new Tensor('int64', null, [3, 1, ids.dims[1]])],
      encode_text: async ({ input_ids }) => ({ dims: [1, input_ids.dims[1], 8] }),
      forward: async inputs => {
        forwards.push(inputs);
        const present = { location: 'gpu-buffer', dispose() { disposed.push('present'); } };
        const logits = { slice: () => ({ to: () => ({ data: new Float32Array([0.1, 0.2, 0.3]) }) }) };
        return { logits, 'present.0.key': present };
      },
    },
  };
  const cache = { 'past_key_values.0.key': { location: 'gpu-buffer' } };
  const prefix = { input_ids: new Tensor('int64', null, [1, 100]), image_grid_thw: null };
  const logits = await bonsai2ContinuationLogits(runtime, prefix, cache, new Tensor('int64', null, [1, 12]));
  assert.deepEqual(Array.from(logits).map(value => Math.round(value * 10)), [1, 2, 3]);
  assert.equal(forwards[0].past_key_values, cache, 'the prefix cache is passed as-is');
  assert.deepEqual(forwards[0].attention_mask.dims, [1, 112], 'the mask covers the prefix and the question');
  assert.deepEqual([forwards[0].position_ids.start, forwards[0].position_ids.end], [100, 112], 'positions continue after the prefix');
  assert.deepEqual(disposed, ['present'], 'the continuation cache is released');
  assert.deepEqual(Object.keys(cache), ['past_key_values.0.key'], 'the shared cache is not updated');
});

test('the worker routes decisions through the offscreen host and provider', async () => {
  const worker = await readFile(new URL('../src/chrome/src/offscreen/inference-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /type === 'multimodal-decide'[\s\S]*?runMultimodalDecision/);
  assert.match(worker, /WEBGPU_BONSAI2_VISION_MODEL_IDS\.has\(modelId\)\) \{\n\s*throw new Error\(`\$\{modelId\} does not support in-browser decisions/);
  const host = await readFile(new URL('../src/chrome/src/offscreen/vision-inference-host.js', import.meta.url), 'utf8');
  assert.match(host, /'webgpu-decide',/);
  assert.match(host, /message\.type === 'webgpu-decide'[\s\S]*?'multimodal-decide'/);
  const background = await readFile(new URL('../src/chrome/src/background.js', import.meta.url), 'utf8');
  const branch = background.slice(background.indexOf("case 'webgpu_decide_fixture':"), background.indexOf("case 'd1_control':"));
  assert.match(branch, /src\/ui\/settings\.html/, 'decision fixtures are Settings-only');
  assert.match(branch, /strictSecretMode/);
});

test('the trained probe scores each option from its margin and hidden state', async () => {
  const { BONSAI_DECISION_PROBE, bonsaiProbeScores } = await import('../src/chrome/src/offscreen/bonsai-decision-probe.js');
  const { WEBGPU_DECISION_MODEL_ID } = await import('../src/chrome/src/providers/webgpu.js');
  const { WEBGPU_CHAT_DECISION_MODEL } = await import('../src/chrome/src/agent/decision-config.js');
  assert.equal(BONSAI_DECISION_PROBE.model, WEBGPU_DECISION_MODEL_ID);
  assert.equal(WEBGPU_CHAT_DECISION_MODEL, WEBGPU_DECISION_MODEL_ID, 'decision-config keeps the probe model id in sync');
  const width = BONSAI_DECISION_PROBE.hiddenSize;
  const zero = new Float32Array(width);
  const [a, b] = bonsaiProbeScores([2, 0], [zero, zero]);
  assert.ok(Math.abs(a - b - 2 * BONSAI_DECISION_PROBE.margin) < 1e-9, 'with equal hidden states only the margins differ');
  const unit = new Float32Array(width).fill(1);
  const [c, d] = bonsaiProbeScores([0, 0], [unit, zero]);
  assert.ok(Number.isFinite(c - d) && c !== d, 'the hidden state moves the score');
  assert.throws(() => bonsaiProbeScores([0], [null]), /hidden state/);
  assert.throws(() => bonsaiProbeScores([0], [new Float32Array(3)]), /hidden state/);
});

test('decisions default to the probe and refuse a decoder without decision_hidden', async () => {
  const worker = await readFile(new URL('../src/chrome/src/offscreen/inference-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /payload\.promptVariant : 'probe';/, 'the probe is the default decision mode');
  assert.match(worker, /variant === 'probe' && !output\.hidden\) \{\n\s*throw new Error\('In-browser decisions need the updated Ternary Bonsai 2 2B Vision decoder/);
  assert.match(worker, /\['webbrain-one\/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision', '240c07e1191911a2306faf106ee537382a1b4d5e6ecdd32b618da160db9145c1'\]/,
    'the 2B decoder pin is the graph that exposes decision_hidden');
});

test('the in-browser chat model is an explicit, key-free, local decision provider that needs independent success proof', async () => {
  for (const build of ['chrome']) {
    const config = await import(`../src/${build}/src/agent/decision-config.js`);
    const transfer = await import(`../src/${build}/src/config-transfer.js`);
    const selected = config.resolveDecisionConfig({ decisionProvider: 'webgpu_chat', systemOneEnabled: true });
    assert.equal(selected.provider, 'webgpu_chat');
    assert.equal(selected.model, config.WEBGPU_CHAT_DECISION_MODEL);
    assert.equal(selected.local, true); assert.equal(selected.apiKey, ''); assert.equal(selected.enabled, true);
    assert.equal(selected.doneEnabled, false, 'completion outsourcing stays opt-in');
    assert.equal(selected.requiresIndependentSuccessConfirmation, true);
    assert.equal(selected.config.inputCostPerMillionUsd, 0);
    assert.equal(config.resolveDecisionConfig({ decisionProvider: 'webgpu_chat', systemOneEnabled: true }, { baseUrl: 'https://api.webbrain.one/v1' }).provider, 'webgpu_chat',
      'an explicit local choice overrides Compass, as D1 does');
    assert.equal(config.resolveDecisionConfig({ decisionProvider: 'webgpu_chat' }).enabled, false);
    assert.equal((await config.listDecisionModels(selected, () => { throw new Error('no network'); })).length, 1);
    const imported = transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { decisionProvider: 'webgpu_chat' } })).settings;
    assert.equal(imported.decisionProvider, 'webgpu_chat');
  }
});

test('Firefox never enables the Chrome-only chat-model provider and imports it with System One off', async () => {
  const config = await import('../src/firefox/src/agent/decision-config.js');
  const transfer = await import('../src/firefox/src/config-transfer.js');
  const stored = { decisionProvider: 'webgpu_chat', systemOneEnabled: true, decisionApiKey: 'sk-or-v1-test', typesafeApiKey: 'ts_test' };
  const selected = config.resolveDecisionConfig(stored);
  assert.equal(selected.provider, 'webgpu_chat', 'a local-only choice never falls back to a cloud provider');
  assert.equal(selected.enabled, false);
  assert.equal(selected.unavailable, 'chrome_only');
  const chromeExport = { schema: transfer.CONFIG_SCHEMA, settings: { ...stored, systemOneCompletionEnabled: true } };
  const restored = transfer.parseConfigImport(JSON.stringify(chromeExport)).settings;
  assert.equal(restored.decisionProvider, '');
  assert.equal(restored.systemOneEnabled, false);
  assert.equal(restored.systemOneCompletionEnabled, true, 'other settings import unchanged');
  assert.equal(restored.decisionInputRate, .042, 'the cost default follows the provider that is kept');
  assert.equal(config.resolveDecisionConfig(restored).enabled, false, 'no decisions until a provider is chosen here');
  const patch = transfer.parseConfigPatchImport(JSON.stringify(chromeExport)).settings;
  assert.equal(Object.hasOwn(patch, 'decisionProvider'), false, 'a provisioning patch keeps the stored provider');
  assert.equal(patch.systemOneEnabled, false);
  const chrome = await import('../src/chrome/src/config-transfer.js');
  assert.equal(chrome.parseConfigImport(JSON.stringify(chromeExport)).settings.decisionProvider, 'webgpu_chat', 'Chrome round-trips it');
});

test('the judge answers webgpu_chat decisions through the offscreen worker in Chrome and refuses them in Firefox', async () => {
  const saved = { chrome: globalThis.chrome };
  const sent = [];
  const decideMessages = [];
  const answers = { q: { type: 'noul', noul: 0.8 } };
  globalThis.chrome = {
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
    runtime: {
      lastError: null,
      getURL: path => `chrome-extension://test/${path}`,
      sendMessage(message, callback) {
        sent.push(message.type);
        if (message.type === 'webgpu-decide') decideMessages.push(message);
        const reply = message.type === 'webgpu-download-status' ? { ready: true }
          : message.type === 'webgpu-decide' ? { ok: true, model: message.model, answers, usage: { input_tokens: 900, output_tokens: 0 } }
            : { ok: true };
        callback(reply);
      },
    },
    storage: { local: { get: async () => ({}) } },
  };
  try {
    const { resolveDecisionConfig } = await import('../src/chrome/src/agent/decision-config.js');
    const { createSystemOneJudge } = await import('../src/chrome/src/agent/systemone-judge.js');
    const config = resolveDecisionConfig({ decisionProvider: 'webgpu_chat', systemOneEnabled: true });
    const screenshot = 'data:image/png;base64,YQ==';
    const result = await createSystemOneJudge({ fetchImpl: () => { throw new Error('no cloud request'); }, maxRetries: 0 })
      .evaluate({ state: [{ task: 'Save' }, { type: 'image_url', image_url: { url: screenshot } }], questions: { q: { type: 'noul', instructions: 'Is it done?' } }, config });
    assert.deepEqual(result.answers, answers);
    const decide = decideMessages.at(-1);
    assert.deepEqual(decide.images, [screenshot], 'screenshots in the state reach the model as images');
    assert.doesNotMatch(JSON.stringify(decide.state), /base64/, 'no screenshot is left in the prompt text');
    assert.equal(result.usage.output_tokens, 0);
    assert.equal(result.estimatedCostUsd, 0);
    assert.ok(sent.includes('webgpu-decide'));
    const firefox = await import('../src/firefox/src/agent/systemone-judge.js');
    const firefoxConfig = (await import('../src/firefox/src/agent/decision-config.js')).resolveDecisionConfig({ decisionProvider: 'webgpu_chat', systemOneEnabled: true });
    await assert.rejects(firefox.createSystemOneJudge({ fetchImpl: () => { throw new Error('no cloud request'); }, maxRetries: 0 })
      .evaluate({ state: 'Page', questions: { q: { type: 'noul', instructions: 'Is it done?' } }, config: firefoxConfig }), /Chrome only/);
  } finally {
    if (saved.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = saved.chrome;
  }
});

test('Settings offers the chat-model decision provider in Chrome only', async () => {
  const chromeHtml = await readFile(new URL('../src/chrome/src/ui/settings.html', import.meta.url), 'utf8');
  const firefoxHtml = await readFile(new URL('../src/firefox/src/ui/settings.html', import.meta.url), 'utf8');
  assert.match(chromeHtml, /<option value="webgpu_chat" data-i18n="st\.decision\.webgpu_chat"><\/option>/);
  assert.match(chromeHtml, /id="webgpu-decision-note" hidden data-i18n="st\.decision\.webgpu_chat_note"/);
  assert.doesNotMatch(firefoxHtml, /webgpu_chat/);
  const { decisionEnglish, decisionTranslations } = await import('../src/chrome/src/ui/locales/decision-copy.mjs');
  assert.ok(decisionEnglish['st.decision.webgpu_chat'] && decisionEnglish['st.decision.webgpu_chat_note']);
  assert.ok(decisionTranslations.tr['st.decision.webgpu_chat']);
});

test('a cancelled decision stops in the worker before using the model', async () => {
  assert.equal(workerListeners.length, 1);
  const post = data => workerListeners[0]({ data });
  const reply = id => workerMessages.find(message => message.id === id);
  const settle = async id => { for (let i = 0; i < 50 && !reply(id); i++) await new Promise(resolve => setTimeout(resolve, 1)); return reply(id); };
  const payload = { modelId: 'no-such/model', state: 'Page', questions: { q: { type: 'noul', instructions: 'Done?' } } };
  // Without a cancel the request reaches the model checks.
  const control = post({ id: 9001, type: 'multimodal-decide', payload });
  assert.doesNotMatch((await settle(9001)).error, /cancelled/);
  await control;
  // A cancel that arrives while the decision is queued stops it first.
  const decide = post({ id: 9002, type: 'multimodal-decide', payload });
  await post({ id: 9003, type: 'cancel', payload: { requestId: 9002 } });
  assert.equal(reply(9003).cancelled, true);
  await decide;
  assert.deepEqual(await settle(9002), { id: 9002, ok: false, error: 'The in-browser decision was cancelled.' });
  const worker = await readFile(new URL('../src/chrome/src/offscreen/inference-worker.js', import.meta.url), 'utf8');
  const run = worker.slice(worker.indexOf('async function runMultimodalDecision'), worker.indexOf('async function runText'));
  assert.match(run, /prefixLength, stopIfCancelled\)/, 'prefill slices check for a cancel');
  assert.equal((run.match(/stopIfCancelled\(\);\n\s*const (?:output|logits) = await bonsai2ContinuationLogits/g) || []).length, 2,
    'every continuation checks for a cancel');
});

test('an aborted judge request cancels the in-browser decision in the offscreen worker', async () => {
  const saved = { chrome: globalThis.chrome };
  const sent = [];
  let finishDecide;
  globalThis.chrome = {
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
    runtime: {
      lastError: null,
      getURL: path => `chrome-extension://test/${path}`,
      sendMessage(message, callback) {
        sent.push(message);
        if (message.type === 'webgpu-decide') { finishDecide = () => callback({ ok: false, error: 'The in-browser decision was cancelled.' }); return; }
        callback(message.type === 'webgpu-download-status' ? { ready: true } : { ok: true });
      },
    },
    storage: { local: { get: async () => ({}) } },
  };
  try {
    const { resolveDecisionConfig } = await import('../src/chrome/src/agent/decision-config.js');
    const { createSystemOneJudge } = await import('../src/chrome/src/agent/systemone-judge.js');
    const config = resolveDecisionConfig({ decisionProvider: 'webgpu_chat', systemOneEnabled: true });
    const controller = new AbortController();
    const pending = createSystemOneJudge({ fetchImpl: () => { throw new Error('no cloud request'); }, maxRetries: 0 })
      .evaluate({ state: 'Page', questions: { q: { type: 'noul', instructions: 'Is it done?' } }, config, signal: controller.signal });
    for (let i = 0; i < 50 && !finishDecide; i++) await new Promise(resolve => setTimeout(resolve, 1));
    const decide = sent.find(message => message.type === 'webgpu-decide');
    assert.ok(decide?.decisionId, 'each decision carries an id');
    controller.abort(new Error('Stopped'));
    await assert.rejects(pending);
    for (let i = 0; i < 50 && !sent.some(message => message.type === 'webgpu-decide-cancel'); i++) await new Promise(resolve => setTimeout(resolve, 1));
    const cancel = sent.find(message => message.type === 'webgpu-decide-cancel');
    assert.equal(cancel?.decisionId, decide.decisionId, 'the abort cancels that decision');
    finishDecide();
    const host = await readFile(new URL('../src/chrome/src/offscreen/vision-inference-host.js', import.meta.url), 'utf8');
    assert.match(host, /'webgpu-decide-cancel',/);
    assert.match(host, /cancelledWebgpuDecisions\.delete\(decisionId\)/, 'a cancel before dispatch skips the decision');
    assert.match(host, /type: 'cancel', payload: \{ requestId: decision\.requestId \}/, 'a dispatched decision is cancelled in its worker');
  } finally {
    if (saved.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = saved.chrome;
  }
});

test('in-browser decisions get their own timeout unless a caller sets a shorter one', async () => {
  const saved = { chrome: globalThis.chrome, setTimeout: globalThis.setTimeout };
  const delays = [];
  // Record request deadlines without arming them.
  globalThis.setTimeout = (fn, ms, ...rest) => { if (ms >= 1000) { delays.push(ms); return saved.setTimeout(() => {}, 0); } return saved.setTimeout(fn, ms, ...rest); };
  globalThis.chrome = {
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
    runtime: {
      lastError: null,
      getURL: path => `chrome-extension://test/${path}`,
      sendMessage(message, callback) {
        callback(message.type === 'webgpu-download-status' ? { ready: true }
          : message.type === 'webgpu-decide' ? { ok: true, model: message.model, answers: { q: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 900, output_tokens: 0 } } : { ok: true });
      },
    },
    storage: { local: { get: async () => ({}) } },
  };
  try {
    const { resolveDecisionConfig } = await import('../src/chrome/src/agent/decision-config.js');
    const { createSystemOneJudge, SYSTEM_ONE_WEBGPU_CHAT_TIMEOUT_MS } = await import('../src/chrome/src/agent/systemone-judge.js');
    const config = resolveDecisionConfig({ decisionProvider: 'webgpu_chat', systemOneEnabled: true });
    const ask = options => createSystemOneJudge({ fetchImpl: () => { throw new Error('no cloud request'); }, maxRetries: 0, ...options })
      .evaluate({ state: 'Page', questions: { q: { type: 'noul', instructions: 'Is it done?' } }, config });
    for (const [options, expected] of [[{}, SYSTEM_ONE_WEBGPU_CHAT_TIMEOUT_MS], [{ timeoutMs: 1000 }, 1000], [{ timeoutMs: 60_000 }, SYSTEM_ONE_WEBGPU_CHAT_TIMEOUT_MS]]) {
      delays.length = 0;
      await ask(options);
      assert.ok(delays.includes(expected), `${JSON.stringify(options)} -> ${expected}, got ${delays}`);
    }
    assert.equal(SYSTEM_ONE_WEBGPU_CHAT_TIMEOUT_MS, 15000);
  } finally {
    globalThis.setTimeout = saved.setTimeout;
    if (saved.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = saved.chrome;
  }
});

test('Settings locks the model and key fields for both fixed in-browser providers and restores them otherwise', async () => {
  const settings = await readFile(new URL('../src/chrome/src/ui/settings.js', import.meta.url), 'utf8');
  const start = settings.indexOf('function syncWebgpuDecisionProvider');
  const sync = settings.slice(start, settings.indexOf('\n}\n', start));
  assert.match(settings, /const FIXED_WEBGPU_DECISION_PROVIDERS = \['webgpu_d1', 'webgpu_chat'\];/);
  assert.match(sync, /const fixed = FIXED_WEBGPU_DECISION_PROVIDERS\.includes\(decisionProviderInput\?\.value\);/);
  assert.match(sync, /decisionModelInput\.readOnly = fixed;/);
  assert.match(sync, /systemOneApiKeyInput\.disabled = fixed;/);
  assert.doesNotMatch(sync, /= true;/, 'nothing is locked only one way');
  // d1-settings.js also sets these fields for D1 only; the sync must run after it.
  const awaited = [...settings.matchAll(/await refreshD1Settings\(\);\n(?:\s*decisionSuggestionDismissed = [^\n]*\n)?\s*(\S+)/g)].map(match => match[1]);
  assert.deepEqual(awaited, ['syncWebgpuDecisionProvider();', 'syncWebgpuDecisionProvider();'], 'load and Clear re-sync after D1');
  const change = settings.slice(settings.indexOf("decisionProviderInput?.addEventListener('change'"));
  assert.match(change.slice(0, change.indexOf('});')), /syncWebgpuDecisionProvider\(\);/);
  assert.ok(settings.indexOf('initD1Settings(sendToBackground)') < settings.indexOf("decisionProviderInput?.addEventListener('change'"),
    "D1's change listener is registered first, so this one runs last");
});

test('Settings suggests the chat model for decisions when Bonsai chats, with D1 as the safer upgrade', async () => {
  const html = await readFile(new URL('../src/chrome/src/ui/settings.html', import.meta.url), 'utf8');
  for (const id of ['decision-suggestion', 'decision-suggest-chat', 'decision-suggest-upgrade', 'btn-decision-use-chat', 'btn-decision-use-d1', 'btn-decision-suggest-dismiss']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /id="decision-suggestion" hidden/, 'hidden until Settings decides');
  const settings = await readFile(new URL('../src/chrome/src/ui/settings.js', import.meta.url), 'utf8');
  const sync = settings.slice(settings.indexOf('function activeChatModelIsDecisionCapable'), settings.indexOf('function chooseSuggestedDecisionProvider'));
  assert.match(sync, /providerDefinitionId\(activeProviderId\) !== 'webgpu'/, 'only when WebGPU is the active chat provider');
  assert.match(sync, /=== WEBGPU_CHAT_DECISION_MODEL/, 'only for the model with a trained decision probe');
  assert.match(sync, /provider === 'webgpu_chat' \? 'upgrade'/, 'with the chat model chosen, only the D1 upgrade shows');
  assert.match(sync, /provider !== 'webgpu_d1' && activeChatModelIsDecisionCapable\(\) \? 'suggest'/, 'nothing once D1 is chosen');
  assert.match(sync, /decisionSuggestionDismissed \? ''/, '"Not now" hides it');
  const choose = settings.slice(settings.indexOf('function chooseSuggestedDecisionProvider'), settings.indexOf("document.getElementById('btn-decision-suggest-dismiss')"));
  assert.match(choose, /dispatchEvent\(new Event\('change'\)\)/, 'uses the normal provider switch, so D1 consent and field locks apply');
  assert.doesNotMatch(choose, /chrome\.storage\.local\.set/, 'nothing is saved until the user clicks Save');
  assert.match(settings, /function renderProviders\(\) \{\n\s*providersContainer\.innerHTML = '';\n\s*syncDecisionSuggestion\(\);/, 'follows chat-provider changes');
  const { decisionEnglish, decisionTranslations } = await import('../src/chrome/src/ui/locales/decision-copy.mjs');
  for (const key of ['st.decision.suggest_chat', 'st.decision.suggest_upgrade', 'st.decision.use_chat', 'st.decision.use_d1', 'st.decision.suggest_dismiss', 'st.decision.suggest_selected']) {
    assert.ok(decisionEnglish[key] && decisionTranslations.tr[key], key);
  }
  const firefoxHtml = await readFile(new URL('../src/firefox/src/ui/settings.html', import.meta.url), 'utf8');
  assert.doesNotMatch(firefoxHtml, /decision-suggestion/, 'Chrome only');
});
