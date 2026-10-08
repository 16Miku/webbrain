import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

for (const build of ['chrome', 'firefox']) {
  const config = await import(`../src/${build}/src/agent/decision-config.js`);
  const pin = await import(`../src/${build}/src/providers/d1-config.js`);
  const runtime = await import(`../src/${build}/src/providers/d1-runtime.js`);
  const preprocess = await import(`../src/${build}/src/providers/d1-preprocess.js`);
  const cache = await import(`../src/${build}/src/providers/d1-cache.js`);
  const completion = await import(`../src/${build}/src/agent/completion-verifier.js`);
  const transfer = await import(`../src/${build}/src/config-transfer.js`);
  test(`${build}: D1 is opt-in, endpoint/key-free, zero-cost and overrides Compass only with explicit local consent`, async () => {
    const stored = { decisionProvider: 'webgpu_d1', systemOneEnabled: true };
    assert.equal(config.resolveDecisionConfig(stored).enabled, false);
    const selected = config.resolveDecisionConfig({ ...stored, [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION });
    assert.equal(selected.enabled, true); assert.equal(selected.local, true); assert.equal(selected.apiKey, ''); assert.equal(selected.url, ''); assert.equal(selected.doneEnabled, false);
    assert.equal(selected.config.inputCostPerMillionUsd, 0); assert.equal(selected.requiresIndependentSuccessConfirmation, true);
    assert.equal(config.resolveDecisionConfig(stored, { baseUrl: 'https://api.webbrain.one/v1' }).provider, 'compass');
    assert.equal(config.resolveDecisionConfig({ ...stored, [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION }, { baseUrl: 'https://api.webbrain.one/v1' }).provider, 'webgpu_d1');
    let fetched = false;
    assert.equal((await config.listDecisionModels(selected, () => { fetched = true; })).length, 1); assert.equal(fetched, false);
    const imported = transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: stored })).settings;
    assert.equal(imported.decisionProvider, 'webgpu_d1'); assert.equal(config.resolveDecisionConfig(imported).enabled, false);
  });
  test(`${build}: hardware guards reject software and inadequate buffers, not other capable GPUs`, () => {
    const adapter = { info: { description: 'Some capable GPU', isFallbackAdapter: false }, limits: { maxBufferSize: 268435456, maxStorageBufferBindingSize: 268435456 } };
    assert.doesNotThrow(() => pin.assertD1Adapter(adapter));
    assert.throws(() => pin.assertD1Adapter({ ...adapter, info: { description: 'SwiftShader' } }), /software/);
    assert.throws(() => pin.assertD1Adapter({ ...adapter, limits: { maxBufferSize: 64 } }), /buffer/);
    assert.throws(() => pin.assertD1Adapter({ ...adapter, limits: { ...adapter.limits, maxStorageBufferBindingSize: 134217728 } }), /storage-binding/);
  });
  test(`${build}: media remains inline data and separate from state, remote network media is rejected`, () => {
    const url = 'data:image/png;base64,YQ==';
    assert.deepEqual(runtime.splitD1State([{ task: 'Observe' }, { type: 'image_url', image_url: { url } }]), { state: [{ task: 'Observe' }], images: [url] });
    assert.throws(() => runtime.splitD1State('', ['https://example.com/private.png']), /remote/);
    assert.throws(() => runtime.splitD1State('', Array(5).fill(url)), /four/);
    assert.equal(runtime.splitD1State(null).state, '');
    assert.equal(preprocess.pyJSON({ small: 1e-7, decimal: 1e-5, regular: .0001, negative: -.0000012, count: 2 }), '{"small": 1e-07, "decimal": 1e-05, "regular": 0.0001, "negative": -1.2e-06, "count": 2}');
    assert.throws(() => preprocess.pyJSON({ invalid: Infinity }), /finite/);
  });
  test(`${build}: public noul yes/no, choice names and score expectation preserve source ordering`, () => {
    const questions = { n: { type: 'noul' }, c: { type: 'choice', criteria: { second: 'B', first: 'A' } }, s: { type: 'score', criteria: ['Zero', 'One'] } };
    const answers = runtime.d1Answers(questions, new Float32Array([.25, .75, .8, .2, .6, .4]), 2);
    assert.equal(answers.n.noul, .75); assert.equal(answers.c.choice, 'second'); assert.ok(Math.abs(answers.s.score - .4) < 1e-6); assert.equal(answers.s.legend['0'], 'Zero');
    assert.throws(() => runtime.d1Answers({ n: { type: 'noul' } }, [NaN, 1], 2), /probability/);
    assert.equal(runtime.d1Answers({ s: { type: 'score', criteria: [{ n: 0 }, ['high']] } }, [.25, .75], 2).s.legend['0'], '{"n": 0}');
    assert.deepEqual(preprocess.renderOptions({ type: 'noul', criteria: { false: null, no: 'Do not use', true: null, yes: 'Do not use' } }), ['false: no, the statement does not hold', 'true: yes, the statement holds']);
    const numericNames = runtime.d1Answers([['1', { type: 'noul' }], ['0', { type: 'noul' }]], [.2, .8, .6, .4], 2);
    assert.equal(numericNames['1'].noul, .8); assert.equal(numericNames['0'].noul, .4);
  });
  test(`${build}: positive D1 alone cannot authorize completion, negative and independent policies remain`, async () => {
    const base = { capture: async () => ({ identity: 'fresh', key: 'pixel' }), isCurrent: () => true };
    const decision = { name: 'webgpu_d1', supportsVision: true, requiresIndependentSuccessConfirmation: true, evaluate: async () => ({ outcome: 'succeeded', probability: .999 }) };
    let verdict = await completion.verifyCompletion({ ...base, decision });
    assert.equal(verdict.outcome, 'uncertain'); assert.equal(verdict.engine, 'legacy');
    verdict = await completion.verifyCompletion({ ...base, decision, llm: { name: 'llm', evaluate: async () => ({ outcome: 'failed' }) } });
    assert.equal(verdict.outcome, 'failed'); assert.equal(verdict.engine, 'llm');
    verdict = await completion.verifyCompletion({ ...base, decision: { ...decision, evaluate: async () => ({ outcome: 'pending' }) } });
    assert.equal(verdict.outcome, 'pending');
  });
  test(`${build}: bounded checksum chunks cover each large file without gaps`, () => {
    const files = pin.D1_REQUIRED_FILES.map(path => ({ path, bytes: 2, sha256: 'a'.repeat(64) }));
    assert.doesNotThrow(() => cache.validateD1Manifest({ dtype: 'float32', audio_included: false, files }));
    files.at(-1).bytes = 10 * 1024 * 1024;
    assert.throws(() => cache.validateD1Manifest({ dtype: 'float32', audio_included: false, files }), /chunks/);
    assert.throws(() => cache.validateD1Manifest({ dtype: 'float16', audio_included: false, files }), /FP32/);
    files.at(-1).bytes = 2; files.at(-1).chunks = [];
    assert.throws(() => cache.validateD1Manifest({ dtype: 'float32', audio_included: false, files }), /coverage/);
  });
  test(`${build}: source longest-first 65536-token sub-batches preserve original question indices`, () => {
    const rows = [80, 16384, 16384, 16384, 16384, 16384, 16384].map(length => ({ input_ids: Array(length) }));
    assert.deepEqual(runtime.d1RowBatches(rows, 0), [[1, 2, 3, 4], [5, 6, 0]]);
    assert.deepEqual(runtime.d1RowBatches([{ input_ids: Array(896) }, { input_ids: Array(896) }], 16384), [[0, 1]]);
  });
  test(`${build}: encoder/head feeds are FP32, bidirectional and generate no tokens`, async () => {
    const seen = [];
    class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } dispose() {} }
    const tokenizer = { bos_token_id: 1, pad_token_id: 0, convert_tokens_to_ids: token => ({ '<|mask|>': 99 }[token] || 5), encode: text => text.split('').map(c => c.charCodeAt(0)) };
    const sessions = { vision: {}, projector: {}, decision: { async run(feeds) { seen.push(feeds); return { probabilities: { getData: async () => new Float32Array([.25, .75, .8, .2]), dispose() {} } }; } } };
    const model = runtime.createD1Runtime({ ort: { Tensor }, tokenizer, config: { dtype: 'float16', max_length: 16384, image_text_length: 896, temperatures: { 'noul:2': 1.666, 'choice:2': 1.746 } }, ratios: [], sessions, model: pin.D1_MODEL_ID });
    const result = await model.evaluate({ state: { color: 'blue' }, questions: { n: { type: 'noul', instructions: 'Is it blue?' }, c: { type: 'choice', instructions: 'Pick a color', criteria: { blue: 'Blue', red: 'Red' } } } });
    assert.equal(result.usage.output_tokens, 0); assert.equal(result.answers.n.noul, .75);
    assert.deepEqual(seen[0].media_prefix.dims, [2, 0, 1024]); assert.equal(seen[0].media_prefix.type, 'float32'); assert.equal(seen[0].temperature.type, 'float32'); assert.equal(seen[0].qtype.type, 'int64');
    assert.equal(Object.hasOwn(seen[0], 'past_key_values'), false); assert.equal(Object.hasOwn(seen[0], 'causal_mask'), false);
  });
}

test('new decision runtime modules are byte-identical across Chrome and Firefox', async () => {
  for (const name of ['d1-config.js', 'd1-runtime.js', 'd1-preprocess.js', 'd1-cache.js', 'd1-worker.js', 'd1-host.js', 'd1.js']) assert.deepEqual(await readFile(new URL(`../src/chrome/src/providers/${name}`, import.meta.url)), await readFile(new URL(`../src/firefox/src/providers/${name}`, import.meta.url)), name);
});
