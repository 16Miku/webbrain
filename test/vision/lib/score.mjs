const EMPTY_SYNONYMS = ['empty', 'blank', 'no value', 'not filled', 'not entered', 'missing'];

export function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function parseSections(content) {
  const text = String(content ?? '');
  const marker = /^\s*(?:#{1,6}\s*)?(?:\*\*)?([1-6])\s*[).:-]\s*(?:\*\*)?/gm;
  const hits = [...text.matchAll(marker)];
  const sections = {};
  for (let i = 0; i < hits.length; i++) {
    const number = Number(hits[i][1]);
    const start = hits[i].index;
    const end = hits[i + 1]?.index ?? text.length;
    sections[number] = text.slice(start, end).trim();
  }
  return sections;
}

function contains(haystack, needle, caseSensitive = false) {
  if (needle === 'empty') {
    const normalized = normalize(haystack);
    return EMPTY_SYNONYMS.some(value => normalized.includes(value));
  }
  if (caseSensitive) return String(haystack).includes(String(needle));
  return normalize(haystack).includes(normalize(needle));
}

export function evaluateCheck(check, content, sections = parseSections(content)) {
  const scoped = check.section == null ? String(content ?? '') : String(sections[check.section] ?? '');
  let passed = false;
  let matched = [];
  if (check.kind === 'literal') {
    passed = contains(scoped, check.value, !!check.caseSensitive);
    if (passed) matched = [check.value];
  } else if (check.kind === 'any') {
    matched = (check.values || []).filter(value => value && contains(scoped, value));
    passed = matched.length > 0;
  } else if (check.kind === 'all') {
    matched = (check.values || []).filter(value => value && contains(scoped, value));
    passed = matched.length === (check.values || []).filter(Boolean).length;
  } else {
    throw new Error(`Unknown vision score check kind: ${check.kind}`);
  }
  return { ...check, passed, matched, scopeFound: check.section == null || !!sections[check.section] };
}

export function scoreVisionResponse({ content, expected }) {
  const sections = parseSections(content);
  const checks = expected.checks.map(check => evaluateCheck(check, content, sections));
  const factWeight = checks.reduce((sum, check) => sum + (check.weight || 1), 0);
  const factEarned = checks.reduce((sum, check) => sum + (check.passed ? (check.weight || 1) : 0), 0);
  const sectionCount = Object.keys(sections).length;
  const structureWeight = 2;
  const structureEarned = structureWeight * (sectionCount / 6);
  const earned = factEarned + structureEarned;
  const possible = factWeight + structureWeight;
  const ratio = possible ? earned / possible : 0;
  const criticalFailures = checks.filter(check => check.critical && !check.passed).map(check => check.id);
  const threshold = Number(expected.threshold ?? 0.72);
  const success = ratio >= threshold && criticalFailures.length === 0;
  const dimensions = {};
  for (const check of checks) {
    const key = check.dimension || 'other';
    const entry = dimensions[key] ||= { earned: 0, possible: 0, ratio: 0 };
    entry.possible += check.weight || 1;
    if (check.passed) entry.earned += check.weight || 1;
  }
  for (const entry of Object.values(dimensions)) entry.ratio = entry.possible ? entry.earned / entry.possible : 0;
  return {
    success,
    ratio,
    earned,
    possible,
    threshold,
    sectionCount,
    criticalFailures,
    dimensions,
    checks,
  };
}
