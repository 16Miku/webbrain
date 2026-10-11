import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';

for (const build of ['chrome', 'firefox']) {
  const { calculateExpression } = await import(`../src/${build}/src/agent/calculator.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { getToolsForMode, SYSTEM_PROMPT_ASK, SYSTEM_PROMPT_ACT, SYSTEM_PROMPT_ACT_MID,
    SYSTEM_PROMPT_ACT_COMPACT } = await import(`../src/${build}/src/agent/tools.js`);
  const { validateToolArguments } = await import(`../src/${build}/src/agent/tool-arguments.js`);

  test(`${build}: arithmetic handles observed price totals, precedence, signs and nested aggregation`, () => {
    for (const [expression, expected] of [
      ['3*10+7*20+2*30', '230'], ['sum(3,7,2)', '12'], ['count(0,3,7,2)', '4'],
      ['sum(1,avg(2,4),min(9,5))', '9'], ['max(-2,-5,1)', '1'], ['min(-2,-5,1)', '-5'],
      ['3+4*2/(1-5)', '1'], ['6/3/2', '1'], ['6/(3/2)', '4'], ['-(2+3)*4', '-20'],
      ['1+-2', '-1'], ['--2', '2'], ['sum()', '0'], ['count()', '0'],
    ]) {
      const result = calculateExpression(expression);
      assert.equal(result.success, true, expression);
      assert.equal(result.result, expected, expression);
      assert.equal(result.exact, true, expression);
    }
    // Independent, varied integer inventories exercise expression construction
    // and aggregation without teaching one fixture's answer to the prompt.
    for (let seed = 1; seed <= 40; seed++) {
      const rows = Array.from({ length: 7 }, (_, index) => ({
        quantity: (seed * 17 + index * 3) % 19, price: (seed * 11 + index * 5) % 97,
      }));
      const expression = `sum(${rows.map(row => `${row.quantity}*${row.price}`).join(',')})`;
      const total = rows.reduce((sum, row) => sum + row.quantity * row.price, 0);
      assert.equal(calculateExpression(expression).result, String(total));
    }
  });

  test(`${build}: decimal arithmetic preserves exact cents and integers beyond floating-point precision`, () => {
    for (const [expression, expected] of [
      ['0.1+0.2', '0.3'], ['19.99*3', '59.97'], ['avg(0.1,0.2)', '0.15'],
      ['1/3+2/3', '1'], ['4/-8', '-0.5'], ['4.5e-2+.005', '0.05'],
      ['9007199254740993+1', '9007199254740994'], ['0/7', '0'],
    ]) {
      const result = calculateExpression(expression);
      assert.equal(result.result, expected, expression);
      assert.equal(result.exact, true, expression);
    }
    const tiny = calculateExpression(`1${'/2'.repeat(200)}`);
    assert.equal(tiny.success, true);
    assert.equal(tiny.exact, true, 'Finite decimals must not be silently rounded to zero');
    assert.notEqual(tiny.result, '0');
    const fraction = calculateExpression('-1/6');
    assert.equal(fraction.result, '-0.166666666667');
    assert.equal(fraction.exact, false);
    assert.equal(fraction.fraction, '-1/6', 'Rounded decimal output retains its exact mathematical value');
  });

  test(`${build}: invalid syntax, code, division by zero and expensive expressions fail within explicit budgets`, () => {
    for (const expression of [null, {}, '', '1/0', 'avg()', 'min()', '1 2', 'sum(1,)',
      'window.location=1', 'fetch("https://example.test")', 'process.exit()', 'Math.random()',
      '1;2', '1**100', '${secret}', 'Infinity', 'NaN', '1e101', '1e-101',
      '9'.repeat(129), '1'.repeat(4097), '1+'.repeat(256) + '1',
      '('.repeat(33) + '1' + ')'.repeat(33),
      `sum(${Array(100).fill('++1').join(',')})`,
      Array(9).fill('9'.repeat(128)).join('*')]) {
      const result = calculateExpression(expression);
      assert.equal(result.success, false, String(expression).slice(0, 100));
      assert.equal(result.noDispatch, true);
      assert.equal(result.errorCode, 'invalid_calculation');
    }
    assert.equal(calculateExpression('('.repeat(20) + '2+3' + ')'.repeat(20)).result, '5');
  });

  test(`${build}: Ask and Act advertise bounded arithmetic and retain strict argument validation`, () => {
    for (const mode of ['ask', 'act']) for (const tier of ['compact', 'mid', 'full']) {
      const definition = getToolsForMode(mode, { tier }).find(tool => tool.function.name === 'calculate');
      assert.ok(definition, `${mode}/${tier}`);
      const schema = definition.function.parameters;
      assert.equal(validateToolArguments('calculate', { expression: 'sum(2,5)' }, schema).ok, true);
      for (const args of [{ expression: 5 }, {}, { expression: '2', code: 'publish()' }, { expression: '1'.repeat(4097) }]) {
        assert.equal(validateToolArguments('calculate', args, schema).ok, false);
      }
    }
    for (const prompt of [SYSTEM_PROMPT_ASK, SYSTEM_PROMPT_ACT, SYSTEM_PROMPT_ACT_MID, SYSTEM_PROMPT_ACT_COMPACT])
      assert.match(prompt, /call calculate with the exact observed operands before answering/);
  });

  test(`${build}: the real Agent handler computes locally without executing a browser or network operation`, async () => {
    const agent = new Agent({ getActive: () => null });
    const result = await agent.executeTool(1, 'calculate', { expression: 'sum(2*12.5,4*7.25)' });
    assert.equal(result.success, true);
    assert.equal(result.result, '54');
    assert.equal(result.exact, true);
  });
}

test('Chrome and Firefox arithmetic implementations stay identical', async () => {
  assert.equal(await fs.readFile(new URL('../src/chrome/src/agent/calculator.js', import.meta.url), 'utf8'),
    await fs.readFile(new URL('../src/firefox/src/agent/calculator.js', import.meta.url), 'utf8'));
});
