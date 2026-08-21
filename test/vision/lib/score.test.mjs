import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCheck, parseSections, scoreVisionResponse } from './score.mjs';

const SAMPLE = `1) Page purpose: Checkout form
2) Visible text: "Pay now", "Review order", "€132.90"
3) Inputs: Card number, value •••• 1842, enabled
4) State signals: Error banner "Card ending 1842 was declined"
5) Blockers: Declined card prevents payment
6) Unknowns: None`;

test('parseSections accepts the production numbered format', () => {
  const sections = parseSections(SAMPLE);
  assert.equal(Object.keys(sections).length, 6);
  assert.match(sections[4], /declined/);
});

test('literal checks preserve exact visible text casing', () => {
  assert.equal(evaluateCheck({ kind: 'literal', section: 2, value: 'Pay now', caseSensitive: true }, SAMPLE).passed, true);
  assert.equal(evaluateCheck({ kind: 'literal', section: 2, value: 'Pay Now', caseSensitive: true }, SAMPLE).passed, false);
});

test('all and any checks use scoped section text', () => {
  assert.equal(evaluateCheck({ kind: 'all', section: 4, values: ['error', '1842', 'declined'] }, SAMPLE).passed, true);
  assert.equal(evaluateCheck({ kind: 'any', section: 5, values: ['overlay', 'card'] }, SAMPLE).passed, true);
  assert.equal(evaluateCheck({ kind: 'any', section: 3, values: ['declined'] }, SAMPLE).passed, false);
});

test('critical failures prevent a binary pass even above threshold', () => {
  const score = scoreVisionResponse({
    content: SAMPLE,
    expected: {
      threshold: 0.1,
      checks: [
        { id: 'ok', kind: 'any', values: ['checkout'], weight: 10 },
        { id: 'critical', kind: 'literal', section: 2, value: 'Submit payment', caseSensitive: true, weight: 1, critical: true },
      ],
    },
  });
  assert.equal(score.success, false);
  assert.deepEqual(score.criticalFailures, ['critical']);
});

test('empty input facts accept common blank-value wording', () => {
  const content = '3) Inputs: Email field is blank and focused';
  assert.equal(evaluateCheck({ kind: 'all', section: 3, values: ['Email', 'empty'] }, content).passed, true);
});
