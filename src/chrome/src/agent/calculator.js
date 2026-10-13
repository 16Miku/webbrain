// Pure, bounded arithmetic. Expressions never enter JavaScript evaluation.
const MAX_CHARS = 4096;
const MAX_TOKENS = 512;
const MAX_DEPTH = 32;
const MAX_OPERATIONS = 256;
const MAX_DIGITS = 1024;
const CALCULATION_TOKEN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|^[a-z]+|^[()+\-*/,]/;
const CALCULATION_FUNCTIONS = new Set(['sum', 'avg', 'min', 'max', 'count']);
const fail = message => { throw new Error(message); };
const abs = value => value < 0n ? -value : value;
function gcd(a, b) { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a || 1n; }
function rational(n, d = 1n) {
  if (!d) fail('Division by zero is undefined.');
  if (d < 0n) { n = -n; d = -d; }
  const divisor = gcd(n, d);
  n /= divisor; d /= divisor;
  if (abs(n).toString().length > MAX_DIGITS || d.toString().length > MAX_DIGITS)
    fail('Calculation exceeds the intermediate number budget.');
  return { n, d };
}
function number(token) {
  const [mantissa, exponent = '0'] = token.toLowerCase().split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const digits = whole + fraction;
  if (digits.length > 128 || !Number.isInteger(Number(exponent)) || Math.abs(Number(exponent)) > 100)
    fail('Numbers are limited to 128 digits and exponents from -100 to 100.');
  const scale = fraction.length - Number(exponent);
  return scale >= 0 ? rational(BigInt(digits), 10n ** BigInt(scale))
    : rational(BigInt(digits) * 10n ** BigInt(-scale));
}
export function tokenizeCalculationExpression(expression) {
  if (typeof expression !== 'string' || !expression.trim()) fail('Provide a non-empty arithmetic expression.');
  if (expression.length > MAX_CHARS) fail('Expression exceeds the 4096-character budget.');
  const tokens = [];
  for (let cursor = 0; cursor < expression.length;) {
    if (/\s/.test(expression[cursor])) { cursor++; continue; }
    const match = expression.slice(cursor).match(CALCULATION_TOKEN);
    if (!match) fail(`Unsupported arithmetic syntax at position ${cursor + 1}.`);
    tokens.push(match[0]); cursor += match[0].length;
    if (tokens.length > MAX_TOKENS) fail('Expression exceeds the 512-token budget.');
  }
  return tokens;
}
// Candidate literals only: callers must validate the complete genuine task.
// Scanning never produces a calculator result or execution/completion receipt.
export function calculationExpressionSpans(text) {
  if (typeof text !== 'string' || text.length > 6000) return [];
  const spans = []; let start = -1, end = -1;
  const flush = () => {
    if (start >= 0) {
      const value = text.slice(start, end);
      if (/\d/.test(value) || /\b(?:sum|avg|min|max|count)\b/.test(value)) spans.push(value);
    }
    start = end = -1;
  };
  for (let cursor = 0; cursor < text.length;) {
    if (/\s/.test(text[cursor])) { cursor++; continue; }
    const value = text.slice(cursor).match(CALCULATION_TOKEN)?.[0];
    if (value && (/^[\d.]/.test(value) || /^[()+\-*/,]$/.test(value) || CALCULATION_FUNCTIONS.has(value))) {
      if (start < 0) start = cursor;
      end = cursor + value.length;
    } else flush();
    cursor += value?.length || 1;
  }
  flush();
  return spans;
}
function evaluate(tokens) {
  let cursor = 0, depth = 0, operations = 0;
  const consume = () => { if (++operations > MAX_OPERATIONS) fail('Calculation exceeds the 256-operation budget.'); };
  const binary = (a, b, operator) => {
    consume();
    if (operator === '+') return rational(a.n * b.d + b.n * a.d, a.d * b.d);
    if (operator === '-') return rational(a.n * b.d - b.n * a.d, a.d * b.d);
    if (operator === '*') return rational(a.n * b.n, a.d * b.d);
    return rational(a.n * b.d, a.d * b.n);
  };
  const expect = token => { if (tokens[cursor++] !== token) fail(`Expected ${token}.`); };
  const add = () => {
    let value = term();
    while (['+', '-'].includes(tokens[cursor])) {
      const operator = tokens[cursor++]; value = binary(value, term(), operator);
    }
    return value;
  };
  const term = () => {
    let value = atom();
    while (['*', '/'].includes(tokens[cursor])) {
      const operator = tokens[cursor++]; value = binary(value, atom(), operator);
    }
    return value;
  };
  const atom = () => {
    if (++depth > MAX_DEPTH) fail('Expression exceeds the 32-level nesting budget.');
    try {
      const token = tokens[cursor++];
      if (token === '+' || token === '-') {
        const value = atom(); consume(); return token === '-' ? rational(-value.n, value.d) : value;
      }
      if (token === '(') { const value = add(); expect(')'); return value; }
      if (/^(?:\d|\.)/.test(token || '')) return number(token);
      if (!CALCULATION_FUNCTIONS.has(token)) fail('Expected a number, parentheses, or sum/avg/min/max/count.');
      expect('(');
      const values = [];
      if (tokens[cursor] !== ')') {
        values.push(add());
        while (tokens[cursor] === ',') { cursor++; values.push(add()); }
      }
      expect(')'); consume();
      if (token === 'count') return rational(BigInt(values.length));
      if (!values.length && token !== 'sum') fail(`${token} requires at least one value.`);
      if (token === 'sum' || token === 'avg') {
        const total = values.reduce((a, b) => binary(a, b, '+'), rational(0n));
        return token === 'sum' ? total : binary(total, rational(BigInt(values.length)), '/');
      }
      return values.reduce((a, b) => {
        consume();
        const smaller = a.n * b.d < b.n * a.d;
        return token === 'min' ? (smaller ? a : b) : (smaller ? b : a);
      });
    } finally { depth--; }
  };
  const value = add();
  if (cursor !== tokens.length) fail('Unexpected trailing arithmetic tokens.');
  return { ...value, operations };
}
function display(value) {
  let remainder = value.d, twos = 0, fives = 0;
  while (remainder % 2n === 0n) { remainder /= 2n; twos++; }
  while (remainder % 5n === 0n) { remainder /= 5n; fives++; }
  const exact = remainder === 1n;
  const places = exact ? Math.max(twos, fives) : 12;
  const scale = 10n ** BigInt(places);
  const numerator = abs(value.n) * scale;
  let scaled = numerator / value.d;
  if (!exact && (numerator % value.d) * 2n >= value.d) scaled++;
  let result = scaled.toString().padStart(places + 1, '0');
  if (places) result = `${result.slice(0, -places)}.${result.slice(-places)}`.replace(/\.?0+$/, '');
  if (value.n < 0n && scaled) result = `-${result}`;
  return { result, exact, ...(!exact ? { fraction: `${value.n}/${value.d}`, decimalPlaces: places } : {}) };
}
export function calculateExpression(expression) {
  try {
    const tokens = tokenizeCalculationExpression(expression);
    const value = evaluate(tokens);
    return { success: true, ...display(value), operations: value.operations };
  } catch (error) {
    return { success: false, noDispatch: true, dispatched: false,
      errorCode: 'invalid_calculation', error: error.message || 'Invalid arithmetic expression.' };
  }
}

// Display validation only: this creates no tool event, receipt or task evidence.
// Accept equivalent standalone scalars/fractions, never an arithmetic formula
// that happens to evaluate to the expected answer.
export function calculationResultInText(text, result, fraction = null, { onlyScalar = false, atEnd = false } = {}) {
  if (typeof text !== 'string' || typeof result !== 'string' || !result || text.length > 6000) return false;
  const displayText = text.replace(/\*\*([^*\n]{1,4096})\*\*/g, '$1')
    .replace(/__([^_\n]{1,4096})__/g, '$1').replace(/`([^`\n]{1,4096})`/g, '$1');
  let expectedValue = null, expectedFraction = null;
  try { expectedValue = evaluate(tokenizeCalculationExpression(result)); } catch {}
  try { if (typeof fraction === 'string') expectedFraction = evaluate(tokenizeCalculationExpression(fraction)); } catch {}
  const same = (a, b) => b && a.n === b.n && a.d === b.d;
  for (const span of calculationExpressionSpans(displayText)) {
    let index = displayText.indexOf(span);
    while (index >= 0) {
      const before = displayText.slice(0, index), after = displayText.slice(index + span.length);
      const nextIndex = displayText.indexOf(span, index + 1);
      if ((onlyScalar && before.trim()) || ((onlyScalar || atEnd) && after.trim())) {
        index = nextIndex; continue;
      }
      if (/[\p{L}\p{N}_.,]$/u.test(before) || /^[\p{L}\p{N}_]/u.test(after)
          || /[+\-−/*^%×÷±⁄]$/.test(before.trimEnd()) || /^[+\-−/*^%×÷±⁄]/.test(after.trimStart())
          || /^\s*[eE]\s*[+\-−]?\s*\d/.test(after)) {
        index = nextIndex; continue;
      }
      try {
        const tokens = tokenizeCalculationExpression(span.trim().replace(/,+$/, ''));
        let cursor = 0;
        const scalar = depth => {
          if (depth > MAX_DEPTH) return false;
          if (['+', '-'].includes(tokens[cursor])) cursor++;
          if (tokens[cursor] === '(') {
            cursor++;
            if (!ratio(depth + 1) || tokens[cursor++] !== ')') return false;
            return true;
          }
          return /^[\d.]/.test(tokens[cursor] || '') && !!tokens[cursor++];
        };
        const ratio = depth => {
          if (!scalar(depth)) return false;
          return tokens[cursor] !== '/' || (cursor++, scalar(depth));
        };
        if (ratio(0) && cursor === tokens.length) {
          const compact = tokens.join('');
          // An actual returned long scalar may exceed the input-number limit.
          if (compact === result || (typeof fraction === 'string' && compact === fraction)) return true;
          const value = evaluate(tokens);
          if (same(value, expectedValue) || same(value, expectedFraction)) return true;
        }
      } catch { /* Malformed, oversized and non-scalar display text is not a result. */ }
      index = nextIndex;
    }
  }
  return false;
}
