const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const JSON_SCHEMA_COMBINATORS = ['properties', 'items', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', '$ref'];

/**
 * An output_schema node is either real JSON Schema or the shorthand form
 * (`{ title: 'string', tags: 'string[]' }`). Only structural keywords
 * disambiguate them: `description`, `required`, and `additionalProperties` are
 * ordinary field names too, so a shorthand object that happens to declare a
 * field called `description` must not be mistaken for a schema node.
 */
export function isJsonSchemaSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return false;
  const type = spec.type;
  if (typeof type === 'string' && JSON_SCHEMA_TYPES.has(type)) return true;
  if (Array.isArray(type) && type.length && type.every(item => JSON_SCHEMA_TYPES.has(item))) return true;
  return JSON_SCHEMA_COMBINATORS.some(keyword => Object.hasOwn(spec, keyword));
}

export function validateCloudOutput(value, schema) {
  const errors = [];
  const push = (path, message) => errors.push(`${path}: ${message}`);
  const isObject = item => !!item && typeof item === 'object' && !Array.isArray(item);

  const validate = (item, spec, path = '$') => {
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
    if (!isJsonSchemaSpec(spec)) {
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

    if (Array.isArray(spec.enum) && !spec.enum.includes(item)) {
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
    if (spec.properties || spec.required) {
      if (!isObject(item)) {
        push(path, 'expected object with properties');
        return;
      }
      for (const key of Array.isArray(spec.required) ? spec.required : []) {
        if (!(key in item)) push(`${path}.${key}`, 'missing required property');
      }
      for (const [key, childSpec] of Object.entries(spec.properties || {})) {
        if (key in item) validate(item[key], childSpec, `${path}.${key}`);
      }
      if (spec.additionalProperties === false) {
        const allowed = new Set(Object.keys(spec.properties || {}));
        for (const key of Object.keys(item)) {
          if (!allowed.has(key)) push(`${path}.${key}`, 'additional property is not allowed');
        }
      }
    }
    if (spec.items && Array.isArray(item)) {
      item.forEach((child, index) => validate(child, spec.items, `${path}[${index}]`));
    }
  };

  validate(value, schema);
  return { ok: errors.length === 0, errors };
}
export function handleDoneJson(context, args = {}) {
  if (!context?.outputSchema) {
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
