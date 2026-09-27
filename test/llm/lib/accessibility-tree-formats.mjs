// Wire-format candidates for the accessibility-tree representation benchmark.
// The shipped runtime remains line-oriented; these serializers are deliberately
// isolated so the benchmark cannot change production parsing by accident.

export const FORMAT_IDS = Object.freeze([
  'line',
  'compact-ndjson',
  'full-json',
]);

const COMPACT_KEYS = Object.freeze({
  depth: 'd',
  role: 'r',
  name: 'n',
  ref_id: 'i',
  href: 'h',
  type: 't',
  value: 'v',
  placeholder: 'p',
  checked: 'c',
  selected: 's',
  disabled: 'x',
  dom_id: 'e',
  field_name: 'f',
  required: 'q',
  readonly: 'o',
  group: 'g',
  hidden: 'z',
  value_len: 'l',
  value_fp: 'y',
});

const COMPACT_TO_CANONICAL = Object.freeze(
  Object.fromEntries(Object.entries(COMPACT_KEYS).map(([key, value]) => [value, key])),
);

const ATTR_ORDER = [
  'href', 'type', 'dom_id', 'field_name', 'placeholder', 'value',
  'checked', 'selected', 'disabled', 'required', 'readonly', 'group',
  'hidden', 'value_len', 'value_fp',
];

const KNOWN_ATTRS = new Set(ATTR_ORDER);

function assertNode(node, index = 0) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError(`node ${index} must be an object`);
  }
  if (!Number.isInteger(node.depth) || node.depth < 0) {
    throw new TypeError(`node ${index} has an invalid depth`);
  }
  for (const key of ['role', 'ref_id']) {
    if (typeof node[key] !== 'string' || !node[key]) {
      throw new TypeError(`node ${index} is missing ${key}`);
    }
  }
  if (node.name != null && typeof node.name !== 'string') {
    throw new TypeError(`node ${index} has a non-string name`);
  }
  if (node.attrs != null && (typeof node.attrs !== 'object' || Array.isArray(node.attrs))) {
    throw new TypeError(`node ${index} has invalid attrs`);
  }
}

export function normalizeNodes(nodes) {
  if (!Array.isArray(nodes)) throw new TypeError('nodes must be an array');
  nodes.forEach(assertNode);
  return nodes.map((node) => ({
    depth: node.depth,
    role: node.role,
    ...(node.name ? { name: node.name } : {}),
    ref_id: node.ref_id,
    ...(Object.keys(node.attrs || {}).length ? {
      attrs: Object.fromEntries(Object.keys(node.attrs).sort().map((key) => {
        if (!KNOWN_ATTRS.has(key)) throw new TypeError(`unsupported AX attribute: ${key}`);
        return [key, node.attrs[key]];
      })),
    } : {}),
  }));
}

function escapeLineValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function unescapeLineValue(value) {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '\\') {
      out += value[i];
      continue;
    }
    const next = value[++i];
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === '\\' || next === '"') out += next;
    else return null;
  }
  return out;
}

function formatLineNode(node) {
  const attrs = node.attrs || {};
  let line = `${' '.repeat(node.depth)}${node.role}`;
  if (node.name) line += ` "${escapeLineValue(node.name)}"`;
  line += ` [${node.ref_id}]`;
  if (node.role === 'option' && attrs.selected === true) line += ' (selected)';
  for (const key of ATTR_ORDER) {
    if (node.role === 'option' && key === 'selected') continue;
    if (!(key in attrs)) continue;
    const value = attrs[key];
    if (typeof value === 'boolean') line += ` ${key}=${value}`;
    else if (typeof value === 'number') line += ` ${key}=${value}`;
    else if (key === 'value_fp') line += ` ${key}=${escapeLineValue(value)}`;
    else line += ` ${key}="${escapeLineValue(value)}"`;
  }
  return line;
}

function compactNode(node) {
  const out = { d: node.depth, r: node.role };
  if (node.name) out.n = node.name;
  out.i = node.ref_id;
  for (const [key, compactKey] of Object.entries(COMPACT_KEYS)) {
    if (key === 'depth' || key === 'role' || key === 'name' || key === 'ref_id') continue;
    if (Object.hasOwn(node.attrs || {}, key)) out[compactKey] = node.attrs[key];
  }
  return out;
}

function fullNode(node) {
  return {
    depth: node.depth,
    role: node.role,
    ...(node.name ? { name: node.name } : {}),
    ref_id: node.ref_id,
    ...(node.attrs && Object.keys(node.attrs).length ? { attrs: { ...node.attrs } } : {}),
  };
}

export function serializeLine(nodes) {
  return normalizeNodes(nodes).map(formatLineNode).join('\n');
}

export function serializeCompactNdjson(nodes) {
  return normalizeNodes(nodes).map((node) => JSON.stringify(compactNode(node))).join('\n');
}

export function serializeFullJson(nodes) {
  return JSON.stringify({ nodes: normalizeNodes(nodes).map(fullNode) });
}

export function serialize(format, nodes) {
  if (format === 'line') return serializeLine(nodes);
  if (format === 'compact-ndjson') return serializeCompactNdjson(nodes);
  if (format === 'full-json') return serializeFullJson(nodes);
  throw new Error(`unknown accessibility-tree format: ${format}`);
}

function parseLine(text) {
  const nodes = [];
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    const match = /^( *)([A-Za-z][\w-]*)(?: "((?:\\.|[^"\\])*)")? \[([^\]]+)\](.*)$/u.exec(line);
    if (!match) throw new Error(`line format record ${index + 1} is invalid`);
    const attrs = {};
    let rest = match[5];
    if (/^ \(selected\)/u.test(rest)) {
      attrs.selected = true;
      rest = rest.slice(' (selected)'.length);
    }
    const attrRe = /\s+([A-Za-z_][\w-]*)=(?:"((?:\\.|[^"\\])*)"|(true|false)|(-?\d+)|([A-Za-z0-9._:-]+))/gu;
    let cursor = 0;
    let attr;
    while ((attr = attrRe.exec(rest))) {
      if (rest.slice(cursor, attr.index).trim()) {
        throw new Error(`line format record ${index + 1} has invalid attributes`);
      }
      let value;
      if (attr[2] != null) value = unescapeLineValue(attr[2]);
      else if (attr[3] != null) value = attr[3] === 'true';
      else if (attr[4] != null) value = Number.parseInt(attr[4], 10);
      else value = unescapeLineValue(attr[5]);
      if (value === null) throw new Error(`line format record ${index + 1} has an invalid escape`);
      attrs[attr[1]] = value;
      cursor = attrRe.lastIndex;
    }
    if (rest.slice(cursor).trim()) throw new Error(`line format record ${index + 1} has invalid attributes`);
    const name = match[3] == null ? undefined : unescapeLineValue(match[3]);
    if (name === null) throw new Error(`line format record ${index + 1} has an invalid name escape`);
    nodes.push({
      depth: match[1].length,
      role: match[2],
      ...(name ? { name } : {}),
      ref_id: match[4],
      ...(Object.keys(attrs).length ? { attrs } : {}),
    });
  }
  return nodes;
}

function parseCompactNdjson(text) {
  const nodes = [];
  for (const [index, line] of String(text || '').split(/\r?\n/).filter((value) => value.trim()).entries()) {
    let raw;
    try { raw = JSON.parse(line); } catch { throw new Error(`compact NDJSON record ${index + 1} is invalid JSON`); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`compact NDJSON record ${index + 1} is not an object`);
    }
    const attrs = {};
    for (const [key, value] of Object.entries(raw)) {
      const canonical = COMPACT_TO_CANONICAL[key];
      if (!canonical) throw new Error(`compact NDJSON record ${index + 1} has unknown key ${key}`);
      if (!['depth', 'role', 'name', 'ref_id'].includes(canonical)) attrs[canonical] = value;
    }
    if (!Number.isInteger(raw.d) || raw.d < 0 || typeof raw.r !== 'string' || !raw.r || typeof raw.i !== 'string' || !raw.i) {
      throw new Error(`compact NDJSON record ${index + 1} is missing d/r/i`);
    }
    if (raw.n != null && typeof raw.n !== 'string') throw new Error(`compact NDJSON record ${index + 1} has an invalid n`);
    nodes.push({
      depth: raw.d,
      role: raw.r,
      ...(raw.n ? { name: raw.n } : {}),
      ref_id: raw.i,
      ...(Object.keys(attrs).length ? { attrs } : {}),
    });
  }
  return nodes;
}

function parseFullJson(text) {
  let raw;
  try { raw = JSON.parse(String(text || '')); } catch { throw new Error('full JSON is invalid JSON'); }
  if (!raw || !Array.isArray(raw.nodes)) throw new Error('full JSON must contain nodes[]');
  return raw.nodes.map((node, index) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error(`full JSON node ${index + 1} is not an object`);
    }
    const { depth, role, name, ref_id, attrs } = node;
    return { depth, role, ...(name ? { name } : {}), ref_id, ...(attrs ? { attrs: { ...attrs } } : {}) };
  });
}

export function parse(format, text) {
  if (format === 'line') return parseLine(text);
  if (format === 'compact-ndjson') return parseCompactNdjson(text);
  if (format === 'full-json') return parseFullJson(text);
  throw new Error(`unknown accessibility-tree format: ${format}`);
}

function comparable(nodes) {
  return normalizeNodes(nodes).map((node) => JSON.stringify(node));
}

export function assertRoundTrip(format, nodes) {
  const parsed = parse(format, serialize(format, nodes));
  const expected = comparable(nodes);
  const actual = comparable(parsed);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${format} round-trip changed node data`);
  }
  return parsed;
}

export function validateTreeNodes(nodes, { requireUniqueRefs = true } = {}) {
  const normalized = normalizeNodes(nodes);
  const refs = new Set();
  for (const [index, node] of normalized.entries()) {
    if (!/^ref_[A-Za-z0-9_-]+$/u.test(node.ref_id)) {
      throw new Error(`node ${index + 1} has an invalid ref_id`);
    }
    if (requireUniqueRefs && refs.has(node.ref_id)) throw new Error(`duplicate ref_id: ${node.ref_id}`);
    refs.add(node.ref_id);
    if (node.depth > 0 && index > 0 && node.depth > normalized[index - 1].depth + 1) {
      throw new Error(`node ${index + 1} skips a hierarchy level`);
    }
  }
  return { nodeCount: normalized.length, refCount: refs.size };
}

export function validateSelection(format, nodes, task) {
  const parsed = parse(format, serialize(format, nodes));
  const matches = parsed.filter((node) => (
    node.ref_id === task.targetRef
    && node.role === task.targetRole
    && node.name === task.targetName
  ));
  return {
    taskId: task.id,
    targetRef: task.targetRef,
    pass: matches.length === 1,
    matchCount: matches.length,
  };
}

export function compareRefReuse(format, beforeNodes, afterNodes, expectedRefs) {
  const before = new Set(parse(format, serialize(format, beforeNodes)).map((node) => node.ref_id));
  const after = new Set(parse(format, serialize(format, afterNodes)).map((node) => node.ref_id));
  const expected = new Set(expectedRefs);
  const preserved = [...expected].filter((ref) => before.has(ref) && after.has(ref));
  return {
    expected: expected.size,
    preserved: preserved.length,
    pass: preserved.length === expected.size,
    missingBefore: [...expected].filter((ref) => !before.has(ref)),
    missingAfter: [...expected].filter((ref) => !after.has(ref)),
  };
}

export function pagePrefixes(nodes, format, maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be a positive integer');
  const normalized = normalizeNodes(nodes);
  const pages = [];
  let offset = 0;
  while (offset < normalized.length) {
    let end = offset + 1;
    let best = '';
    while (end <= normalized.length) {
      const candidate = serialize(format, normalized.slice(offset, end));
      if (candidate.length > maxChars) break;
      best = candidate;
      end += 1;
    }
    if (!best) throw new Error(`${format} record exceeds page maxChars (${maxChars})`);
    const count = end - offset - 1;
    pages.push({
      pageContent: best,
      start: offset,
      end: offset + count,
      hasMore: offset + count < normalized.length,
    });
    offset += count;
  }
  return pages;
}

export function assertPagination(format, nodes, maxChars, continuationBase = {}) {
  const pages = pagePrefixes(nodes, format, maxChars);
  const reassembled = [];
  pages.forEach((page, index) => {
    const parsed = parse(format, page.pageContent);
    reassembled.push(...parsed);
    const expectedContinuation = page.hasMore
      ? { ...continuationBase, page: index + 2 }
      : null;
    page.continuationArgs = expectedContinuation;
    page.page = index + 1;
    page.nextPage = page.hasMore ? index + 2 : null;
  });
  if (JSON.stringify(comparable(reassembled)) !== JSON.stringify(comparable(nodes))) {
    throw new Error(`${format} pagination lost or reordered nodes`);
  }
  if (pages.at(-1)?.hasMore) throw new Error(`${format} pagination did not terminate`);
  return pages;
}

export function formatSchema() {
  return {
    compactNdjson: {
      description: 'One compact JSON object per line; depth is explicit so continuation pages retain hierarchy.',
      keys: COMPACT_KEYS,
    },
    fullJson: {
      description: 'Conventional JSON object with nodes[] and descriptive repeated keys; baseline only.',
    },
  };
}
