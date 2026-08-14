const DEFAULT_ERROR_MESSAGE = 'An unexpected error occurred.';
const PREFERRED_KEYS = ['message', 'error', 'detail', 'reason', 'description', 'cause', 'code', 'errorCode'];

function bounded(text, maxLength) {
  const value = String(text || '').trim();
  if (value === '[object Object]') return DEFAULT_ERROR_MESSAGE;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 14))}… [truncated]`;
}

function stableJson(value, maxDepth = 4) {
  const seen = new WeakSet();
  const visit = (item, depth) => {
    if (item == null || typeof item !== 'object') return item;
    if (seen.has(item)) return '[circular]';
    if (depth >= maxDepth) return Array.isArray(item) ? '[array omitted]' : '[object omitted]';
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 20).map(entry => visit(entry, depth + 1));
    const out = {};
    for (const key of Object.keys(item).sort().slice(0, 30)) out[key] = visit(item[key], depth + 1);
    return out;
  };
  try {
    return JSON.stringify(visit(value, 0));
  } catch {
    return '';
  }
}

export function formatErrorMessage(value, options = {}) {
  const maxLength = Number.isFinite(options.maxLength) ? Math.max(80, options.maxLength) : 2000;
  const fallback = bounded(options.fallback || DEFAULT_ERROR_MESSAGE, maxLength) || DEFAULT_ERROR_MESSAGE;
  const seen = new WeakSet();
  const find = (item, depth = 0) => {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      const text = bounded(item, maxLength);
      return text && text !== '[object Object]' ? text : '';
    }
    if (!item || typeof item !== 'object' || depth > 5 || seen.has(item)) return '';
    seen.add(item);
    for (const key of PREFERRED_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      const found = find(item[key], depth + 1);
      if (found) return found;
    }
    return '';
  };
  const preferred = find(value);
  if (preferred) return preferred;
  if (value && typeof value === 'object') {
    const json = bounded(stableJson(value), maxLength);
    if (json && json !== '{}' && json !== '[]') return json;
  }
  return fallback;
}
