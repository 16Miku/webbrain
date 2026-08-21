#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, DIFFICULTIES } from './fixtures/cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUESTIONS = join(HERE, 'questions');
const EXPECTED = join(HERE, 'expected');
await Promise.all([mkdir(QUESTIONS, { recursive: true }), mkdir(EXPECTED, { recursive: true })]);

for (const entry of CASES) {
  const question = {
    schemaVersion: 1,
    id: entry.id,
    difficulty: entry.difficulty,
    category: entry.category,
    title: entry.title,
    image: `images/${entry.id}.png`,
    question: entry.question,
    defaultPromptMode: 'production',
  };
  const expected = {
    schemaVersion: 1,
    id: entry.id,
    image: question.image,
    threshold: entry.expected.threshold,
    checks: entry.expected.checks,
    successRubric: entry.expected.successRubric,
  };
  await Promise.all([
    writeFile(join(QUESTIONS, `${entry.id}.json`), `${JSON.stringify(question, null, 2)}\n`),
    writeFile(join(EXPECTED, `${entry.id}.json`), `${JSON.stringify(expected, null, 2)}\n`),
  ]);
}

const manifest = {
  schemaVersion: 1,
  caseCount: CASES.length,
  ordering: 'difficulty ascending, then category family',
  difficultyBands: DIFFICULTIES.map(d => ({ ...d, count: CASES.filter(c => c.difficulty.level === d.level).length })),
  categories: [...new Set(CASES.map(c => c.category))],
};
await writeFile(join(HERE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${CASES.length} question files, ${CASES.length} expected files, and manifest.json`);
