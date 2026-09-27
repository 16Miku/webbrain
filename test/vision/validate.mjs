#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from './fixtures/cases.mjs';
import { PRODUCTION_USER_TEXT, VISION_SYSTEM_PROMPT } from './prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const numbered = (names) => names.filter(name => /^\d{3}\.(json|png)$/.test(name)).sort();
const expectedIds = Array.from({ length: 100 }, (_, i) => String(i + 1).padStart(3, '0'));

assert.equal(CASES.length, 100, 'case definitions must total 100');
assert.deepEqual(CASES.map(c => c.id), expectedIds, 'case ids must be sequential');
assert.deepEqual(CASES.map(c => c.difficulty.level), expectedIds.map((_, i) => Math.floor(i / 20) + 1), 'difficulty must increase every 20 cases');
assert.equal(new Set(CASES.map(c => c.question)).size, 100, 'focus questions must be unique');
assert.equal(new Set(CASES.map(c => c.category)).size, 20, 'expected 20 category families');

const questionFiles = numbered(await readdir(join(HERE, 'questions'))).filter(name => name.endsWith('.json'));
const expectedFiles = numbered(await readdir(join(HERE, 'expected'))).filter(name => name.endsWith('.json'));
const imageFiles = numbered(await readdir(join(HERE, 'images'))).filter(name => name.endsWith('.png'));
assert.deepEqual(questionFiles, expectedIds.map(id => `${id}.json`));
assert.deepEqual(expectedFiles, expectedIds.map(id => `${id}.json`));
assert.deepEqual(imageFiles, expectedIds.map(id => `${id}.png`));

const hashes = new Set();
for (const id of expectedIds) {
  const question = JSON.parse(await readFile(join(HERE, 'questions', `${id}.json`), 'utf8'));
  const expected = JSON.parse(await readFile(join(HERE, 'expected', `${id}.json`), 'utf8'));
  assert.equal(question.id, id);
  assert.equal(expected.id, id);
  assert.equal(question.image, `images/${id}.png`);
  assert.equal(expected.image, question.image);
  assert.ok(expected.checks.length >= 3, `${id} needs at least three checks`);
  assert.equal(new Set(expected.checks.map(check => check.id)).size, expected.checks.length, `${id} has duplicate check ids`);
  assert.ok(expected.checks.some(check => check.critical), `${id} needs a critical check`);
  const bytes = await readFile(join(HERE, question.image));
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', `${id} must be PNG`);
  assert.equal(bytes.readUInt32BE(16), 1280, `${id} width must be 1280`);
  assert.equal(bytes.readUInt32BE(20), 720, `${id} height must be 720`);
  hashes.add(createHash('sha256').update(bytes).digest('hex'));
}
assert.equal(hashes.size, 100, 'every rendered viewport must be unique');

function extractPrompt(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `could not extract ${label}`);
  return match[1];
}

for (const browser of ['chrome', 'firefox']) {
  const source = await readFile(join(ROOT, 'src', browser, 'src', 'agent', 'agent.js'), 'utf8');
  const prompt = extractPrompt(source, /static VISION_SYSTEM_PROMPT = `([\s\S]*?)`;/, `${browser} VISION_SYSTEM_PROMPT`);
  assert.equal(prompt, VISION_SYSTEM_PROMPT, `${browser} vision system prompt drifted`);
  assert.ok(source.includes(`text: '${PRODUCTION_USER_TEXT}'`), `${browser} vision user text drifted`);
}
const probeSource = await readFile(join(ROOT, 'test', 'vision-probe.mjs'), 'utf8');
assert.equal(extractPrompt(probeSource, /const VISION_SYSTEM_PROMPT = `([\s\S]*?)`;/, 'one-shot probe prompt'), VISION_SYSTEM_PROMPT);
assert.ok(probeSource.includes(`const USER_TEXT = '${PRODUCTION_USER_TEXT}';`), 'one-shot probe user text drifted');

const assetFiles = ['street-talad-noi.jpg', 'street-snow.jpg', 'street-night.jpg', 'street-tangiers.jpg'];
for (const name of assetFiles) assert.ok((await stat(join(HERE, 'assets', name))).size > 0, `missing asset ${name}`);
console.log('vision corpus valid: 100 questions, 100 rubrics, 100 unique 1280×720 PNGs, prompts synchronized');
