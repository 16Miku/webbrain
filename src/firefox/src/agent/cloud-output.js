import { jsonDeepEqual } from './tool-arguments.js';

const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const SHORTHAND_TYPE_TOKENS = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'any']);
const SUPPORTED_JSON_SCHEMA_KEYWORDS = new Set([
  '$schema', '$ref', '$comment',
  'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'anyOf', 'oneOf', 'allOf',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum',
  'minItems', 'maxItems',
  'minProperties', 'maxProperties',
]);

function isSchemaObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// The shorthand form's values are always type tokens: `string`, `string[]`,
// `number?`. A keyword holding one of those is a field declaration, not a
// schema keyword.
function isShorthandToken(value) {
  if (typeof value !== 'string') return false;
  let token = value.trim();
  if (token.endsWith('?')) token = token.slice(0, -1).trim();
  if (token.endsWith('[]')) token = token.slice(0, -2).trim() || 'any';
  return SHORTHAND_TYPE_TOKENS.has(token);
}

function isNumericSchemaValue(value) {
  return typeof value === 'number';
}

function isSchemaBranch(value) {
  return typeof value === 'boolean' || isSchemaObject(value);
}

// A keyword only signals JSON Schema when its value has the shape JSON Schema
// requires. Presence alone is not enough: `const`, `items`, `enum`, and the
// rest are all legal shorthand field names.
const JSON_SCHEMA_KEYWORD_SHAPES = {
  properties: isSchemaObject,
  additionalProperties: (value) => typeof value === 'boolean',
  items: (value) => typeof value === 'boolean' || isSchemaObject(value) || Array.isArray(value),
  enum: Array.isArray,
  anyOf: (value) => Array.isArray(value) && value.length > 0 && value.every(isSchemaBranch),
  oneOf: (value) => Array.isArray(value) && value.length > 0 && value.every(isSchemaBranch),
  allOf: (value) => Array.isArray(value) && value.length > 0 && value.every(isSchemaBranch),
  // Both take free values, so the only tell is that a shorthand type token is
  // never what a caller means by `{ const: 'ok' }` or `{ $ref: '#/$defs/x' }`.
  const: (value) => !isShorthandToken(value),
  $ref: (value) => typeof value === 'string' && !isShorthandToken(value),
  $schema: (value) => typeof value === 'string' && value.length > 0,
  minLength: isNumericSchemaValue,
  maxLength: isNumericSchemaValue,
  pattern: (value) => typeof value === 'string' && !isShorthandToken(value),
  minimum: isNumericSchemaValue,
  maximum: isNumericSchemaValue,
  minItems: isNumericSchemaValue,
  maxItems: isNumericSchemaValue,
  minProperties: isNumericSchemaValue,
  maxProperties: isNumericSchemaValue,
};

/**
 * The bare `{ const: 'string' }` is genuinely ambiguous — a shorthand field
 * named `const`, or the JSON Schema literal `"string"` — and the heuristic above
 * has to pick one. A caller who means the second says so with `$schema`, which
 * turns off shorthand interpretation for the whole tree.
 */
export function hasJsonSchemaMarker(spec) {
  return isSchemaObject(spec) && typeof spec.$schema === 'string' && spec.$schema.length > 0;
}

/**
 * An output_schema node is either real JSON Schema or the shorthand form
 * (`{ title: 'string', tags: 'string[]' }`). Only structural keywords carrying
 * schema-shaped values disambiguate them: `description`, `required`, and
 * `additionalProperties` are ordinary field names too, and even `const` or
 * `enum` can name a shorthand field, so a shorthand object that happens to
 * declare one must not be mistaken for a schema node.
 */
export function isJsonSchemaSpec(spec) {
  if (!isSchemaObject(spec)) return false;
  const type = spec.type;
  if (typeof type === 'string' && JSON_SCHEMA_TYPES.has(type)) return true;
  if (Array.isArray(type) && type.length && type.every(item => JSON_SCHEMA_TYPES.has(item))) return true;
  return Object.entries(JSON_SCHEMA_KEYWORD_SHAPES)
    .some(([keyword, hasSchemaShape]) => Object.hasOwn(spec, keyword) && hasSchemaShape(spec[keyword]));
}

function schemaSupportErrors(schema) {
  const errors = [];
  const push = (path, message) => errors.push(`${path}: ${message}`);
  const visit = (spec, path, forceJsonSchema = false) => {
    if (!isSchemaObject(spec)) return;
    const jsonSchemaNode = forceJsonSchema || isJsonSchemaSpec(spec);
    if (!jsonSchemaNode) {
      for (const [key, child] of Object.entries(spec)) visit(child, `${path}.${key}`);
      return;
    }
    for (const key of Object.keys(spec)) {
      if (!SUPPORTED_JSON_SCHEMA_KEYWORDS.has(key)) {
        push(path, `unsupported JSON Schema keyword ${JSON.stringify(key)}`);
      }
    }
    if (Object.hasOwn(spec, 'type')) {
      const types = Array.isArray(spec.type) ? spec.type : [spec.type];
      if (!types.length || !types.every(type => typeof type === 'string' && JSON_SCHEMA_TYPES.has(type))) {
        push(path, 'type must contain only supported JSON Schema types');
      }
    }
    if (Object.hasOwn(spec, 'properties')) {
      if (!isSchemaObject(spec.properties)) push(path, 'properties must be an object');
      else for (const [key, child] of Object.entries(spec.properties)) visit(child, `${path}.properties.${key}`, true);
    }
    if (Object.hasOwn(spec, 'required') && (
      !Array.isArray(spec.required)
      || !spec.required.every(key => typeof key === 'string')
      || new Set(spec.required).size !== spec.required.length
    )) {
      push(path, 'required must be an array of unique strings');
    }
    if (Object.hasOwn(spec, 'additionalProperties')) {
      if (typeof spec.additionalProperties === 'boolean') {
        // Fully supported.
      } else if (isSchemaObject(spec.additionalProperties)) {
        visit(spec.additionalProperties, `${path}.additionalProperties`, true);
      } else {
        push(path, 'additionalProperties must be a boolean or schema object');
      }
    }
    if (Object.hasOwn(spec, 'items')) {
      if (typeof spec.items === 'boolean') {
        // Fully supported.
      } else if (isSchemaObject(spec.items)) {
        visit(spec.items, `${path}.items`, true);
      } else {
        push(path, 'tuple-form items is not supported; use one schema object');
      }
    }
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
      if (!Object.hasOwn(spec, keyword)) continue;
      if (!Array.isArray(spec[keyword]) || !spec[keyword].length
          || !spec[keyword].every(branch => typeof branch === 'boolean' || isSchemaObject(branch))) {
        push(path, `${keyword} must be a non-empty array of schema objects`);
        continue;
      }
      spec[keyword].forEach((branch, index) => visit(branch, `${path}.${keyword}[${index}]`, true));
    }
    if (Object.hasOwn(spec, 'enum') && (!Array.isArray(spec.enum) || !spec.enum.length)) {
      push(path, 'enum must be a non-empty array');
    }
    for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
      if (Object.hasOwn(spec, keyword) && (!Number.isInteger(spec[keyword]) || spec[keyword] < 0)) {
        push(path, `${keyword} must be a non-negative integer`);
      }
    }
    for (const keyword of ['minimum', 'maximum']) {
      if (Object.hasOwn(spec, keyword) && (typeof spec[keyword] !== 'number' || !Number.isFinite(spec[keyword]))) {
        push(path, `${keyword} must be a finite number`);
      }
    }
    if (Object.hasOwn(spec, 'pattern')) {
      if (typeof spec.pattern !== 'string') push(path, 'pattern must be a string');
      else {
        try { new RegExp(spec.pattern); } catch { push(path, 'pattern must be a valid regular expression'); }
      }
    }
  };
  visit(schema, '$', hasJsonSchemaMarker(schema));
  return errors;
}

export function validateCloudOutput(value, schema) {
  const unsupported = schemaSupportErrors(schema);
  if (unsupported.length) return { ok: false, errors: unsupported };
  const errors = [];
  const push = (path, message) => errors.push(`${path}: ${message}`);
  const isObject = item => !!item && typeof item === 'object' && !Array.isArray(item);
  // Set once for the whole tree: a marked document has no shorthand nodes in
  // it, so no node has to be guessed at.
  const jsonSchemaOnly = hasJsonSchemaMarker(schema);

  const validate = (item, spec, path = '$', forceJsonSchema = false) => {
    if (typeof spec === 'boolean') {
      if (!spec) push(path, 'rejected by false schema');
      return;
    }
    if (typeof spec === 'string') {
      let shorthand = spec.trim();
      const optional = shorthand.endsWith('?');
      if (optional) shorthand = shorthand.slice(0, -1).trim();
      if ((item === undefined || item === null) && optional) return;
      if (shorthand.endsWith('[]')) {
        if (!Array.isArray(item)) {
          push(path, `expected array of ${shorthand.slice(0, -2)}`);
          return;
        }
        item.forEach((child, index) => validate(child, shorthand.slice(0, -2) || 'any', `${path}[${index}]`));
        return;
      }
      const valid = shorthand === 'any'
        || (shorthand === 'string' && typeof item === 'string')
        || (shorthand === 'number' && typeof item === 'number' && !Number.isNaN(item))
        || (shorthand === 'integer' && Number.isInteger(item))
        || (shorthand === 'boolean' && typeof item === 'boolean')
        || (shorthand === 'object' && isObject(item))
        || (shorthand === 'array' && Array.isArray(item));
      if (!valid) push(path, shorthand === 'any' ? 'unsupported value' : `expected ${shorthand}`);
      return;
    }

    if (Array.isArray(spec)) {
      if (!Array.isArray(item)) {
        push(path, 'expected array');
        return;
      }
      item.forEach((child, index) => validate(child, spec[0] || 'any', `${path}[${index}]`));
      return;
    }

    if (!isObject(spec)) return;
    const jsonSchemaNode = forceJsonSchema || jsonSchemaOnly || isJsonSchemaSpec(spec);
    if (!jsonSchemaNode) {
      if (!isObject(item)) {
        push(path, 'expected object');
        return;
      }
      for (const [key, childSpec] of Object.entries(spec)) {
        const optional = typeof childSpec === 'string' && childSpec.trim().endsWith('?');
        if (!(key in item)) {
          if (!optional) push(`${path}.${key}`, 'missing required property');
          continue;
        }
        validate(item[key], childSpec, `${path}.${key}`);
      }
      return;
    }

    // Keywords this validator classifies as JSON Schema must actually be
    // enforced. Anything advertised but unevaluated would let done_json publish
    // a result that violates the caller's contract.
    if (Object.hasOwn(spec, '$ref')) {
      push(path, '$ref is not supported in a cloud output schema; inline the definition');
      return;
    }
    // A model's done_json argument is separately parsed, so an object or array
    // `const` never passes reference identity even when it is structurally the
    // value the caller asked for.
    if (Object.hasOwn(spec, 'const') && !jsonDeepEqual(spec.const, item)) {
      push(path, `expected ${JSON.stringify(spec.const)}`);
    }
    if (Array.isArray(spec.anyOf) && !spec.anyOf.some(branch => matches(item, branch))) {
      push(path, 'does not match any anyOf branch');
    }
    if (Array.isArray(spec.oneOf)) {
      const matched = spec.oneOf.filter(branch => matches(item, branch)).length;
      if (matched !== 1) push(path, `expected exactly one oneOf branch to match, matched ${matched}`);
    }
    if (Array.isArray(spec.allOf) && !spec.allOf.every(branch => matches(item, branch))) {
      push(path, 'does not match every allOf branch');
    }
    // Same reference-identity trap as `const` above.
    if (Array.isArray(spec.enum) && !spec.enum.some(candidate => jsonDeepEqual(candidate, item))) {
      push(path, `expected one of ${JSON.stringify(spec.enum)}`);
    }
    const types = Array.isArray(spec.type) ? spec.type : (spec.type ? [spec.type] : []);
    if (types.length) {
      const typeOk = types.some(type => {
        if (type === 'array') return Array.isArray(item);
        if (type === 'object') return isObject(item);
        if (type === 'integer') return Number.isInteger(item);
        if (type === 'number') return typeof item === 'number' && !Number.isNaN(item);
        if (type === 'null') return item === null;
        return typeof item === type;
      });
      if (!typeOk) push(path, `expected ${types.join(' or ')}`);
    }
    if (typeof item === 'string') {
      const length = [...item].length;
      if (Number.isInteger(spec.minLength) && length < spec.minLength) push(path, `expected at least ${spec.minLength} characters`);
      if (Number.isInteger(spec.maxLength) && length > spec.maxLength) push(path, `expected at most ${spec.maxLength} characters`);
      if (typeof spec.pattern === 'string' && !new RegExp(spec.pattern).test(item)) push(path, `expected to match ${JSON.stringify(spec.pattern)}`);
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      if (typeof spec.minimum === 'number' && item < spec.minimum) push(path, `expected at least ${spec.minimum}`);
      if (typeof spec.maximum === 'number' && item > spec.maximum) push(path, `expected at most ${spec.maximum}`);
    }
    if (Array.isArray(item)) {
      if (Number.isInteger(spec.minItems) && item.length < spec.minItems) push(path, `expected at least ${spec.minItems} items`);
      if (Number.isInteger(spec.maxItems) && item.length > spec.maxItems) push(path, `expected at most ${spec.maxItems} items`);
    }
    if (isObject(item)) {
      const size = Object.keys(item).length;
      if (Number.isInteger(spec.minProperties) && size < spec.minProperties) push(path, `expected at least ${spec.minProperties} properties`);
      if (Number.isInteger(spec.maxProperties) && size > spec.maxProperties) push(path, `expected at most ${spec.maxProperties} properties`);
    }
    if (isObject(item) && (spec.properties || spec.required || Object.hasOwn(spec, 'additionalProperties'))) {
      for (const key of Array.isArray(spec.required) ? spec.required : []) {
        if (!(key in item)) push(`${path}.${key}`, 'missing required property');
      }
      const allowed = new Set(Object.keys(spec.properties || {}));
      for (const [key, childSpec] of Object.entries(spec.properties || {})) {
        if (key in item) validate(item[key], childSpec, `${path}.${key}`, true);
      }
      for (const [key, child] of Object.entries(item)) {
        if (allowed.has(key)) continue;
        if (spec.additionalProperties === false) push(`${path}.${key}`, 'additional property is not allowed');
        else if (typeof spec.additionalProperties === 'boolean') {
          if (!spec.additionalProperties) push(`${path}.${key}`, 'additional property is not allowed');
        } else if (isObject(spec.additionalProperties)) {
          validate(child, spec.additionalProperties, `${path}.${key}`, true);
        }
      }
    }
    if (Object.hasOwn(spec, 'items') && Array.isArray(item)) {
      item.forEach((child, index) => validate(child, spec.items, `${path}[${index}]`, true));
    }
  };

  // A branch check needs a yes/no answer without polluting the caller's error
  // list. Reuse this document's validator so a root `$schema` marker keeps the
  // whole tree in JSON-Schema-only mode, then discard the branch diagnostics.
  function matches(item, branchSpec) {
    const errorCount = errors.length;
    validate(item, branchSpec, '$', true);
    const matched = errors.length === errorCount;
    errors.length = errorCount;
    return matched;
  }

  validate(value, schema);
  return { ok: errors.length === 0, errors };
}
export function handleDoneJson(context, args = {}) {
  if (!context || context.outputSchema == null) {
    return {
      success: false,
      error: 'done_json is only available during a cloud run with an output schema.',
    };
  }
  const result = Object.prototype.hasOwnProperty.call(args, 'result') ? args.result : undefined;
  const summary = String(args.summary || '').trim() || 'Task completed.';
  const validation = validateCloudOutput(result, context.outputSchema);
  if (validation.ok) {
    return { done: true, doneJson: true, summary, result, cloudResult: result };
  }
  const message = `done_json result did not match outputSchema: ${validation.errors.slice(0, 8).join('; ')}`;
  if (!context.schemaRepairUsed) {
    context.schemaRepairUsed = true;
    return {
      success: false,
      schemaValidationError: true,
      error: `${message}. Call done_json exactly one more time with a corrected result.`,
      expectedSchema: context.outputSchema,
    };
  }
  return {
    done: true,
    doneJson: true,
    cloudFailed: true,
    schemaValidationError: true,
    summary: 'Structured cloud run failed schema validation.',
    error: message,
    expectedSchema: context.outputSchema,
    invalidResult: result,
  };
}
