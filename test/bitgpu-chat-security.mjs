import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = process.env.WEBBRAIN_BITGPU_SECURITY_SOURCE
  ? path.resolve(process.env.WEBBRAIN_BITGPU_SECURITY_SOURCE)
  : path.join(ROOT, 'src/chrome/vendor/bitgpu/chat.js');
const source = readFileSync(sourcePath, 'utf8');
const start = source.indexOf('function preprocess(template, options = {}) {');
const end = source.indexOf('\nfunction tokenize(', start);
assert.ok(start >= 0 && end > start, 'actual bundled preprocessing boundary');
const preprocess = vm.runInNewContext(`${source.slice(start, end)};preprocess`);
const { parseToolCallXml, ChatTokenizer, ToolBodyMachineXml } = await import(pathToFileURL(sourcePath).href);
const toolsFor = schema => [{ type: 'function', function: { name: 'probe', parameters: schema } }];
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const stringSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const optionalStringSchema = { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false };
const xml = value => `<function=probe>${value}</function>`;
const parameter = (key, value) => `<parameter=${key}>${value}</parameter>`;
const reject = (raw, schema = emptySchema, tools = toolsFor(schema)) => {
  const result = parseToolCallXml(raw, tools);
  assert.equal(result.name, '');
  assert.deepEqual(result.arguments, {});
  assert.equal(result.raw, raw);
};

// Each hostile input runs in an isolated, bounded child. No GPU/model/browser
// is created. The same shipped export and byte-exact private function run there.
if (process.argv[2] === '--hostile-probe') {
  const kind = process.argv[3];
  const count = 32768;
  const input = kind === 'whitespace' ? ' '.repeat(count * 4)
    : kind === 'function' ? '<function='.repeat(count)
      : kind === 'parameter-header' ? '<function=probe>' + '<parameter='.repeat(count)
        : kind === 'parameter-value' ? '<function=probe>' + '<parameter=text>a'.repeat(count)
          : null;
  assert.notEqual(input, null);
  process.stdout.write('ready\n');
  const before = performance.now();
  if (kind === 'whitespace') assert.equal(preprocess(input), input);
  else assert.equal(parseToolCallXml(input, toolsFor(stringSchema)).name, '');
  process.stdout.write(JSON.stringify({ completed: true, characters: input.length, durationMs: performance.now() - before }) + '\n');
  process.exit(0);
}

for (const [label, input, expected, options] of [
  ['empty', '', ''],
  ['no marker', '  plain\t text  ', '  plain\t text  '],
  ['single final newline', 'x\n', 'x'],
  ['only one final newline removed', 'x\n\n', 'x\n'],
  ['open and close', 'before {% generation %}inside{% endgeneration %} after', 'before inside after'],
  ['both strips', 'x \n {%- generation -%} \n y', 'xy'],
  ['left strip', 'x \n {%- generation %} \n y', 'x \n y'],
  ['right strip', 'x \n {% generation -%} \n y', 'x \n y'],
  ['surrounding whitespace', ' {% generation %} \n', '  '],
  ['adjacent marker non-overlap', 'x{% generation %}  {%- endgeneration %}y', 'x  y'],
  ['multiple stripped markers', 'a {%-generation-%} b {%-endgeneration-%} c', 'abc'],
  ['Unicode whitespace', 'x\u00a0{%-\u2028generation\u2029-%}\uFEFFy', 'xy'],
  ['ordinary statement remains', ' {% if x %}y{% endif %} ', ' {% if x %}y{% endif %} '],
  ['incomplete marker remains', 'a {% generation ', 'a {% generation '],
  ['incomplete prefix then valid', 'a {% nope {% generation %}z', 'a {% nope z'],
  ['end separator remains invalid', '{% end generation %}', '{% end generation %}'],
  ['case stays significant', '{% Generation %}', '{% Generation %}'],
  ['existing block trim options', 'x\n  {% generation %}\ny\n  {% endgeneration %}\nz\n', 'x\ny\nz', { lstrip_blocks: true, trim_blocks: true }],
]) {
  test(`Jinja generation preprocessing: ${label}`, () => assert.equal(preprocess(input, options), expected));
}

test('actual XML export preserves raw strings and coerces declared non-string JSON values', () => {
  const schema = { type: 'object', properties: {
    text: { type: 'string' }, number: { type: 'number' }, integer: { type: 'integer' },
    enabled: { type: 'boolean' }, list: { type: 'array', items: { type: 'integer' } },
    object: { type: 'object' }, nothing: { type: 'null' },
  }, required: ['text', 'number', 'integer', 'enabled', 'list', 'object', 'nothing'], additionalProperties: false };
  const raw = '\n' + xml([
    parameter('text', '\n  literal <b> & "quoted" <parameter=nested> text  \n'),
    parameter('number', '\n1.25\n'), parameter('integer', '12'), parameter('enabled', 'true'),
    parameter('list', '[1,2]'), parameter('object', '{"k":"v"}'), parameter('nothing', 'null'),
  ].join('\n')) + '\t';
  const result = parseToolCallXml(raw, toolsFor(schema));
  assert.equal(result.name, 'probe');
  assert.equal(result.raw, raw);
  assert.deepEqual(result.arguments, {
    text: '  literal <b> & "quoted" <parameter=nested> text  ', number: 1.25, integer: 12,
    enabled: true, list: [1, 2], object: { k: 'v' }, nothing: null,
  });
  assert.equal(Object.getPrototypeOf(result.arguments), Object.prototype);
});

test('empty, whitespace and multiple-newline strings retain the original one-newline rule', () => {
  for (const [value, expected] of [['', ''], [' ', ' '], ['\n', ''], ['\n\nvalue\n\n', '\nvalue\n'], ['\r\nvalue\r\n', '\r\nvalue\r']]) {
    assert.equal(parseToolCallXml(xml(parameter('text', value)), toolsFor(stringSchema)).arguments.text, expected);
  }
});

test('omitted schemas and additional properties retain raw string parameters', () => {
  const result = parseToolCallXml(xml(parameter('unknown', '12') + parameter('constructor', 'literal')), toolsFor(undefined));
  assert.equal(result.name, 'probe');
  assert.deepEqual(result.arguments, { unknown: '12', constructor: 'literal' });
  assert.equal(Object.getPrototypeOf(result.arguments), Object.prototype);
});

test('unknown tool, unsupported schema and malformed tool definitions fail closed', () => {
  reject('<function=unknown></function>');
  reject(xml(''), undefined, []);
  reject(xml(''), undefined, [{ type: 'function', function: { name: 'probe', parameters: { type: 'string' } } }]);
  reject(xml(''), { type: 'object', properties: { x: { type: 'unsupported' } } });
  reject(xml(''), undefined, [{ type: 'other', function: { name: 'probe' } }]);
  reject(xml(''), undefined, [{ type: 'function' }]);
  reject(xml(''), undefined, [...toolsFor(emptySchema), ...toolsFor(emptySchema)]);
});

for (const [label, raw] of [
  ['missing function', ''], ['incomplete function header', '<function=probe'],
  ['missing function close', '<function=probe>'],
  ['missing parameter header close', '<function=probe><parameter=text'],
  ['missing parameter close', '<function=probe><parameter=text>unfinished</function>'],
  ['stray parameter outside function', xml('') + parameter('text', 'orphan')],
  ['multiple function blocks', xml('') + xml('')],
  ['non-whitespace prefix', 'unexpected ' + xml('')],
  ['non-whitespace suffix', xml('') + ' unexpected'],
  ['unexpected text between parameters', xml(parameter('text', 'literal') + 'unexpected')],
  ['wrong close tag', '<function=probe><parameter=text>literal</param></function>'],
]) {
  test(`malformed XML is not surfaced: ${label}`, () => reject(raw, optionalStringSchema));
}

test('required and unknown properties are own properties, including inherited names', () => {
  for (const key of ['constructor', 'toString', '__proto__']) {
    reject(xml(''), { type: 'object', properties: JSON.parse(`{"${key}":{"type":"string"}}`), required: [key], additionalProperties: false });
    reject(xml(parameter(key, 'undeclared')), emptySchema);
  }
  reject(xml(''), stringSchema);
  reject(xml(parameter('text', 'ok') + parameter('extra', 'unknown')), stringSchema);
  reject(xml(parameter('count', 'not JSON')), { type: 'object', properties: { count: { type: 'integer' } } });
});

test('explicitly declared __proto__ is an own data property without satisfying another required key', () => {
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"object"},"must":{"type":"string"}},"required":["__proto__","must"],"additionalProperties":false}');
  reject(xml(parameter('__proto__', '{"must":"inherited"}')), schema);
  const result = parseToolCallXml(xml(parameter('__proto__', '{"must":"own nested value"}') + parameter('must', 'actual')), toolsFor(schema));
  assert.equal(result.name, 'probe');
  assert.equal(Object.getPrototypeOf(result.arguments), Object.prototype);
  assert.equal(Object.hasOwn(result.arguments, '__proto__'), true);
  assert.equal(Object.hasOwn(result.arguments, 'must'), true);
  assert.deepEqual(result.arguments.__proto__, { must: 'own nested value' });
  assert.equal(result.arguments.must, 'actual');
  assert.equal(Object.hasOwn(Object.prototype, 'must'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.arguments)), { ['__proto__']: { must: 'own nested value' }, must: 'actual' });
});

test('inherited property schemas cannot coerce unknown additional parameters', () => {
  const properties = Object.create({ custom: { type: 'number' } });
  const result = parseToolCallXml(xml(parameter('custom', 'literal')), toolsFor({ type: 'object', properties }));
  assert.equal(result.name, 'probe');
  assert.equal(result.arguments.custom, 'literal');
  reject(xml(parameter('custom', '12')), { type: 'object', properties, additionalProperties: false });
});

test('actual Qwen XML body machine and exported parser agree on a completed valid tool call', () => {
  const properties = new Map([['probe', { keys: ['text', 'count'], required: ['text', 'count'], schemas: new Map([['text', { type: 'string' }], ['count', { type: 'integer' }]]) }]]);
  const machine = new ToolBodyMachineXml(['probe'], properties);
  const raw = '<function=probe>\n<parameter=text>\nliteral\n</parameter>\n<parameter=count>\n12\n</parameter>\n</function>';
  assert.equal(machine.feed(new TextEncoder().encode(raw)), true);
  assert.equal(machine.complete, true);
  const result = parseToolCallXml(raw, toolsFor({ type: 'object', properties: { text: { type: 'string' }, count: { type: 'integer' } }, required: ['text', 'count'], additionalProperties: false }));
  assert.equal(result.name, 'probe');
  assert.deepEqual(result.arguments, { text: 'literal', count: 12 });
});

const tokenizerJson = {
  model: { type: 'WordPiece', vocab: { '[UNK]': 0, '<|im_end|>': 1 }, unk_token: '[UNK]', continuing_subword_prefix: '##' },
  decoder: null, post_processor: null, pre_tokenizer: null, normalizer: null, added_tokens: [],
};
for (const [label, template, options, expected] of [
  ['generation wrapper', 'prefix {% generation %}{{ messages[0]["content"] }}{% endgeneration %} suffix\n', {}, 'prefix hello suffix'],
  ['stripped generation wrapper', 'x \n {%- generation -%}{{ messages[0]["content"] }}{%- endgeneration -%} \n y', {}, 'xhelloy'],
  ['ChatML turn and assistant prompt', '{% for message in messages %}{{ "<|im_start|>" + message["role"] + "\\n" + message["content"] + "<|im_end|>\\n" }}{% endfor %}{% if add_generation_prompt %}{{ "<|im_start|>assistant\\n" }}{% endif %}', { addGenerationPrompt: true }, '<|im_start|>user\nhello<|im_end|>\n<|im_start|>assistant\n'],
  ['thinking inside generation', '{% generation %}{% if enable_thinking %}{{ "<think>\\n" }}{% endif %}{{ messages[0]["content"] }}{% endgeneration %}', { enableThinking: true }, '<think>\nhello'],
]) {
  test(`actual ChatTokenizer/Jinja rendering: ${label}`, () => {
    const tokenizer = new ChatTokenizer(tokenizerJson, { eos_token: '<|im_end|>', chat_template: template });
    assert.equal(tokenizer.hasChatTemplate, true);
    assert.equal(tokenizer.eosTokenId, 1);
    assert.equal(tokenizer.applyChatTemplate([{ role: 'user', content: 'hello' }], options), expected);
  });
}

function boundedHostileProbe(kind) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--hostile-probe', kind], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WEBBRAIN_BITGPU_SECURITY_SOURCE: sourcePath },
    });
    let stdout = '', stderr = '', failure = null, ready = false, parseTimer = null;
    const abort = reason => { failure ??= reason; child.kill('SIGKILL'); };
    // Import/startup time is separate from the 500ms actual parser budget so
    // concurrent default suites do not mistake a cold module load for ReDoS.
    const loadTimer = setTimeout(() => abort('module_load_timeout'), 5000);
    child.stdout.on('data', data => {
      stdout += data.toString();
      if (stdout.length > 4096) return abort('child_output_limit');
      if (!ready && stdout.startsWith('ready\n')) {
        ready = true;
        clearTimeout(loadTimer);
        parseTimer = setTimeout(() => abort('parser_timeout'), 500);
      }
    });
    child.stderr.on('data', data => {
      stderr += data.toString();
      if (stderr.length > 4096) abort('child_output_limit');
    });
    child.on('error', error => { failure ??= error.code || 'child_start_error'; });
    child.on('close', status => {
      clearTimeout(loadTimer);
      clearTimeout(parseTimer);
      resolve({ status, stdout, stderr, ready, failure });
    });
  });
}

for (const kind of ['whitespace', 'function', 'parameter-header', 'parameter-value']) {
  test(`hostile ${kind} parser finishes within 500ms after module readiness`, async () => {
    const child = await boundedHostileProbe(kind);
    assert.equal(child.failure, null, `${kind}: ${child.failure}`);
    assert.equal(child.status, 0, `${kind}: ${child.stderr}`);
    assert.equal(child.ready, true, 'actual parser reached before completion');
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.equal(result.completed, true);
    assert.ok(result.characters >= 131072);
    assert.ok(result.durationMs <= 500, 'child measured actual parser wall time exceeds 500ms');
  });
}
