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
globalThis.self ??= { addEventListener() {}, postMessage() {} };
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
