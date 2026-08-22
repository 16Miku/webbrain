import { sanitizeText as sanitizeSharedText } from './text-sanitize.js';

const sanitizeText = (value, max = 240) => sanitizeSharedText(value, max, { collapseWhitespace: true });

const VALID_STATUSES = new Set(['pending', 'acted', 'processed', 'skipped', 'failed']);
const TERMINAL_STATUSES = new Set(['processed', 'skipped', 'failed']);
const CLICK_ACTION_TOOLS = new Set(['click', 'click_ax', 'iframe_click']);
const APP_OWNED_BOOLEAN_FIELD_KEYS = new Set(['completionRequirement', 'classifierTarget']);
const APP_OWNED_INTEGER_FIELD_KEYS = new Set(['expectedOrdinal']);
const ACTION_RE = /^\s*(follow|unfollow|star|unstar|watch|unwatch|connect|subscribe|unsubscribe|save|unsave|like|unlike|block|unblock|report|send|submit|add|remove)\b(?:\s+(.+?))?\s*$/i;
const IDENTITY_ACTION_PREFIX_RE = /^\s*(?:follow|unfollow|star|unstar|watch|unwatch|connect|subscribe|unsubscribe|save|unsave|like|unlike|block|unblock|report|send|submit|add|remove|collect_email|collect_profile|process_item|visit|open)\s*[:\-]?\s+/i;
const GENERIC_TARGET_RE = /^(button|link|item|result|profile|user|member|person|this|that|it|here|there|more|submit|save|send|add|remove|follow|unfollow|changes?|message|comment|reply|post|form|details|settings|preferences)$/i;

export function normalizeLedgerStatus(value, fallback = 'pending') {
  const status = sanitizeText(value, 40).toLowerCase();
  if (VALID_STATUSES.has(status)) return status;
  const unwrapped = status
    .replace(/^[\s"'`<([{\\\u300c\u300e\u201c\u2018]+/g, '')
    .replace(/[\s"'`>)\]}\\\u300d\u300f\u201d\u2019]+$/g, '');
  return VALID_STATUSES.has(unwrapped) ? unwrapped : fallback;
}

function normalizeStatus(value, fallback = 'pending') {
  return normalizeLedgerStatus(value, fallback);
}

function sanitizeFieldValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const text = sanitizeText(value, 500);
    if (/^(null|none|n\/a|not found|no email|unknown)$/i.test(text)) return null;
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function cleanTarget(value) {
  let text = sanitizeText(value, 180)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^\s*@/, '')
    .replace(/\s+\((?:button|link|profile|user)\)$/i, '')
    .trim();
  if (!text || GENERIC_TARGET_RE.test(text)) return '';
  return text;
}

function targetFromHref(href) {
  const raw = sanitizeText(href, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://example.invalid');
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    const last = decodeURIComponent(parts[parts.length - 1] || '');
    return cleanTarget(last);
  } catch {
    const parts = raw.split(/[?#]/)[0].split('/').filter(Boolean);
    return cleanTarget(parts[parts.length - 1] || '');
  }
}

function stableIdFor(action, target, url) {
  const base = cleanTarget(target) || targetFromHref(url);
  if (!base) return '';
  const compact = base
    .replace(/^@/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitizeText(compact, 160);
}

function normalizeIdentityText(value) {
  let text = cleanTarget(value);
  if (!text) return '';
  try { text = text.normalize('NFKC'); } catch {}
  text = text
    .replace(IDENTITY_ACTION_PREFIX_RE, '')
    .replace(/^\s*@/, '')
    .replace(/\/+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return text && !GENERIC_TARGET_RE.test(text) ? text : '';
}

function identityEntries(item) {
  const entries = new Map();
  const add = (key, strength) => {
    if (!key) return;
    entries.set(key, Math.max(strength, entries.get(key) || 0));
  };
  const addUrl = (value) => {
    const raw = sanitizeText(value, 500);
    if (!raw) return;
    try {
      const url = new URL(raw);
      if (!/^https?:$/i.test(url.protocol)) return;
      const host = url.hostname.toLowerCase();
      const pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
      add(`url:${host}${pathname.toLowerCase()}`, 4);
      const parts = pathname.split('/').filter(Boolean);
      if (!parts.length) return;
      let tail = '';
      try { tail = decodeURIComponent(parts[parts.length - 1] || ''); } catch { tail = parts[parts.length - 1] || ''; }
      tail = normalizeIdentityText(tail);
      if (!tail) return;
      add(`profile:${host}/${tail}`, 3);
      if (/^[^@\s]+@[^@\s]+$/.test(tail)) {
        add(`acct:${tail}`, 3);
      } else if ((parts[parts.length - 1] || '').startsWith('@')) {
        add(`acct:${tail}@${host}`, 3);
      }
      add(`text:${tail}`, 1);
    } catch {}
  };
  const addText = (value, strength = 1) => {
    const raw = sanitizeText(value, 500);
    if (!raw) return;
    if (/^https?:\/\//i.test(raw)) {
      addUrl(raw);
      return;
    }
    const text = normalizeIdentityText(raw);
    if (!text) return;
    add(`text:${text}`, strength);
    if (/^[^@\s]+@[^@\s]+$/.test(text)) add(`acct:${text}`, Math.max(3, strength));
  };

  const id = sanitizeText(item?.id, 180);
  if (id && !/^(?:expected|requirement):/i.test(id)) addText(id, 2);
  addText(item?.target, 2);
  addText(item?.label, 1);
  addUrl(item?.url || item?.href);
  return entries;
}

export function progressIdentityKeys(item) {
  return [...identityEntries(item).keys()];
}

export function progressIdentitiesAreUnique(items = []) {
  const strongestKeys = (Array.isArray(items) ? items : []).map(item => {
    const entries = identityEntries(item);
    const strongest = Math.max(0, ...entries.values());
    return new Set([...entries]
      .filter(([, strength]) => strength === strongest)
      .map(([key]) => key));
  });
  return strongestKeys.every(keys => keys.size > 0)
    && strongestKeys.every((keys, index) => strongestKeys.every((other, otherIndex) => (
      index === otherIndex || ![...keys].some(key => other.has(key))
    )));
}

function identityMatchScore(left, right) {
  const leftEntries = identityEntries(left);
  const rightEntries = identityEntries(right);
  let score = 0;
  for (const [key, leftStrength] of leftEntries) {
    const rightStrength = rightEntries.get(key);
    if (rightStrength) score = Math.max(score, Math.min(leftStrength, rightStrength));
  }
  return score;
}

function isCanonicalProgressRow(row) {
  const ordinal = Number(row?.fields?.expectedOrdinal);
  return row?.fields?.completionRequirement === true
    || row?.fields?.classifierTarget === true
    || (Number.isInteger(ordinal) && ordinal > 0);
}

function actionsCompatible(left, right) {
  const leftAction = sanitizeText(left?.action, 80).toLowerCase();
  const rightAction = sanitizeText(right?.action, 80).toLowerCase();
  return !leftAction || !rightAction || leftAction === rightAction;
}

function sanitizeFields(fields, opts = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(fields).slice(0, 20)) {
    const k = sanitizeText(key, 80);
    if (!k) continue;
    if (APP_OWNED_BOOLEAN_FIELD_KEYS.has(k)) {
      if (opts.allowAppOwnedFields === true && value === true) out[k] = true;
      continue;
    }
    if (APP_OWNED_INTEGER_FIELD_KEYS.has(k)) {
      const ordinal = Number(value);
      if (opts.allowAppOwnedFields === true && Number.isInteger(ordinal) && ordinal > 0 && ordinal <= 1000) {
        out[k] = ordinal;
      }
      continue;
    }
    const cleaned = sanitizeFieldValue(value);
    if (cleaned !== undefined) out[k] = cleaned;
  }
  return Object.keys(out).length ? out : undefined;
}

export function ledgerRowKey(row) {
  const id = sanitizeText(row?.id, 180).toLowerCase();
  if (!id) return '';
  const sessionId = sanitizeText(row?.sessionId || row?.session_id || '', 120).toLowerCase();
  return sessionId ? `${sessionId}::${id}` : id;
}

export function isTerminalLedgerStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').toLowerCase());
}

// Single source of truth for the reopen gate: a terminal row may only move
// back to a non-terminal status via an explicit allowReopen (never for auto).
export function isBlockedLedgerDowngrade(existingStatus, incomingStatus, opts = {}) {
  if (!isTerminalLedgerStatus(existingStatus) || isTerminalLedgerStatus(incomingStatus)) return false;
  return opts.source === 'auto' || opts.allowReopen !== true;
}

export function isValidLedgerStatus(status) {
  return VALID_STATUSES.has(normalizeLedgerStatus(status, ''));
}

export function normalizeLedgerItem(item, opts = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const source = sanitizeText(opts.source || item.source || 'model', 40) || 'model';
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const action = sanitizeText(item.action, 80).toLowerCase();
  const target = cleanTarget(item.target || '');
  const url = sanitizeText(item.url || item.href || '', 500);
  const id = sanitizeText(item.id || stableIdFor(action, target || item.label, url), 160);
  if (!id) return null;
  const fallbackStatus = source === 'auto' ? 'acted' : 'pending';
  const status = normalizeStatus(item.status, fallbackStatus);
  const label = sanitizeText(item.label || target || id, 220);
  const reason = sanitizeText(item.reason || item.note || '', 300);
  const sessionId = sanitizeText(item.sessionId || item.session_id || opts.sessionId || '', 120);
  const pageScope = sanitizeText(item.pageScope || item.page_scope || opts.pageScope || '', 240);
  const taskKey = sanitizeText(item.taskKey || opts.taskKey || '', 240);
  const fields = sanitizeFields(item.fields, { allowAppOwnedFields: source === 'classifier' });
  const attempts = Number.isFinite(Number(item.attempts))
    ? Math.max(0, Math.floor(Number(item.attempts)))
    : (source === 'auto' ? 1 : 0);

  return {
    id,
    label,
    ...(target ? { target } : {}),
    ...(url ? { url } : {}),
    status,
    ...(action ? { action } : {}),
    ...(fields ? { fields } : {}),
    ...(reason ? { reason } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(pageScope ? { pageScope } : {}),
    ...(taskKey ? { taskKey } : {}),
    source,
    attempts,
    firstSeenAt: Number.isFinite(Number(item.firstSeenAt)) ? Number(item.firstSeenAt) : now,
    updatedAt: now,
  };
}

export function reconcileLedgerItems(rows = [], items = [], opts = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const source = sanitizeText(opts.source || 'model', 40) || 'model';
  const sessionId = sanitizeText(opts.sessionId || '', 120);
  const reconciled = [];
  const rawItems = Array.isArray(items) ? items : [];
  const normalizedItems = rawItems.map(rawItem => normalizeLedgerItem(rawItem, {
    source,
    sessionId,
    pageScope: opts.pageScope,
    taskKey: opts.taskKey,
    now: opts.now,
  }));
  const semanticBindingFor = incoming => {
    if (!incoming) return null;
    const exactRow = safeRows.find(row => ledgerRowKey(row) === ledgerRowKey(incoming));
    if (exactRow && actionsCompatible(exactRow, incoming)) return null;
    let bestScore = 0;
    let matches = [];
    for (const row of safeRows) {
      const autoMayReuseRow = source === 'auto' && !isTerminalLedgerStatus(row?.status);
      if ((!isCanonicalProgressRow(row) && !autoMayReuseRow) || !actionsCompatible(row, incoming)) continue;
      const rowSessionId = sanitizeText(row?.sessionId || row?.session_id || '', 120);
      if (rowSessionId !== incoming.sessionId) continue;
      const score = identityMatchScore(row, incoming);
      if (score > bestScore) {
        bestScore = score;
        matches = [row];
      } else if (score > 0 && score === bestScore) {
        matches.push(row);
      }
    }
    return bestScore && matches.length === 1 && matches[0]?.id ? matches[0] : null;
  };
  const semanticBindings = new Map();
  normalizedItems.forEach((item, index) => {
    const canonical = semanticBindingFor(item);
    if (canonical) semanticBindings.set(index, canonical);
  });
  const batchBindings = new Map();
  if (source !== 'classifier' && sessionId) {
    const exactIncomingKeys = new Set(normalizedItems.filter(Boolean).map(ledgerRowKey));
    const availableExpected = safeRows
      .filter(row => {
        const ordinal = Number(row?.fields?.expectedOrdinal);
        const rowSessionId = sanitizeText(row?.sessionId || row?.session_id || '', 120);
        return Number.isInteger(ordinal) && ordinal > 0
          && row?.fields?.classifierTarget !== true
          && !row?.target
          && !row?.url
          && rowSessionId === sessionId
          && !exactIncomingKeys.has(ledgerRowKey(row));
      })
      .sort((a, b) => Number(a.fields.expectedOrdinal) - Number(b.fields.expectedOrdinal));
    const newIncoming = normalizedItems
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => item
        && !semanticBindings.has(index)
        && !safeRows.some(row => ledgerRowKey(row) === ledgerRowKey(item) && actionsCompatible(row, item)));
    const canBindPartialBatch = source === 'model' || source === 'observe';
    const batchFitsAvailable = newIncoming.length === availableExpected.length
      || (canBindPartialBatch && newIncoming.length > 0 && newIncoming.length < availableExpected.length);
    if (availableExpected.length && batchFitsAvailable) {
      const identitiesAreUnique = progressIdentitiesAreUnique(newIncoming.map(({ item }) => item));
      const compatible = newIncoming.every(({ item }, index) => actionsCompatible(availableExpected[index], item));
      const identityVerified = source !== 'auto' || newIncoming.every(({ item }, index) => (
        identityMatchScore(availableExpected[index], item) > 0
      ));
      if (identitiesAreUnique && compatible && identityVerified) {
        newIncoming.forEach(({ index }, expectedIndex) => batchBindings.set(index, availableExpected[expectedIndex]));
      }
    }
  }

  const nextItems = rawItems.map((rawItem, itemIndex) => {
    const incoming = normalizedItems[itemIndex];
    const semanticCanonical = semanticBindings.get(itemIndex);
    if (incoming && semanticCanonical?.id) {
      reconciled.push({ incomingId: incoming.id, canonicalId: semanticCanonical.id });
      return {
        ...rawItem,
        id: semanticCanonical.id,
        sessionId: semanticCanonical.sessionId || incoming.sessionId || sessionId,
      };
    }
    const batchCanonical = batchBindings.get(itemIndex);
    if (incoming && batchCanonical?.id) {
      reconciled.push({ incomingId: incoming.id, canonicalId: batchCanonical.id });
      return {
        ...rawItem,
        id: batchCanonical.id,
        target: rawItem?.target
          || incoming.target
          || sanitizeText(String(incoming.label || '').replace(IDENTITY_ACTION_PREFIX_RE, ''), 180)
          || incoming.label,
        sessionId: batchCanonical.sessionId || incoming.sessionId || sessionId,
      };
    }
    if (!incoming) return rawItem;
    const exactRow = safeRows.find(row => ledgerRowKey(row) === ledgerRowKey(incoming));
    if (exactRow && actionsCompatible(exactRow, incoming)) return rawItem;
    return rawItem;
  });
  return { items: nextItems, reconciled };
}

function mergedProgressStatus(canonicalStatus, duplicateStatus) {
  const canonical = normalizeStatus(canonicalStatus, 'pending');
  const duplicate = normalizeStatus(duplicateStatus, 'pending');
  if (isTerminalLedgerStatus(canonical) && isTerminalLedgerStatus(duplicate)) {
    return canonical === duplicate ? canonical : '';
  }
  if (isTerminalLedgerStatus(canonical)) return canonical;
  if (isTerminalLedgerStatus(duplicate)) return duplicate;
  if (canonical === 'acted' || duplicate === 'acted') return 'acted';
  return 'pending';
}

function mergeCanonicalProgressRows(canonical, duplicate) {
  const status = mergedProgressStatus(canonical?.status, duplicate?.status);
  if (!status) return null;
  const ordinal = Number(canonical?.fields?.expectedOrdinal);
  const firstSeenAt = [canonical?.firstSeenAt, duplicate?.firstSeenAt]
    .map(Number).filter(Number.isFinite);
  const updatedAt = [canonical?.updatedAt, duplicate?.updatedAt]
    .map(Number).filter(Number.isFinite);
  return {
    ...canonical,
    label: duplicate?.label || canonical?.label,
    ...(duplicate?.target ? { target: duplicate.target } : {}),
    ...(duplicate?.url ? { url: duplicate.url } : {}),
    status,
    ...(duplicate?.action ? { action: duplicate.action } : {}),
    source: duplicate?.source || canonical?.source || 'model',
    fields: {
      ...(canonical?.fields || {}),
      ...(duplicate?.fields || {}),
      ...(canonical?.fields?.completionRequirement === true || duplicate?.fields?.completionRequirement === true
        ? { completionRequirement: true } : {}),
      ...(canonical?.fields?.classifierTarget === true || duplicate?.fields?.classifierTarget === true
        ? { classifierTarget: true } : {}),
      ...(Number.isInteger(ordinal) && ordinal > 0 ? { expectedOrdinal: ordinal } : {}),
    },
    attempts: Math.max(Number(canonical?.attempts || 0), Number(duplicate?.attempts || 0)),
    ...(firstSeenAt.length ? { firstSeenAt: Math.min(...firstSeenAt) } : {}),
    ...(updatedAt.length ? { updatedAt: Math.max(...updatedAt) } : {}),
  };
}

export function reconcilePersistedLedgerRows(rows = []) {
  let next = Array.isArray(rows)
    ? rows.map(row => ({ ...row, fields: row?.fields ? { ...row.fields } : undefined }))
    : [];
  const reconciled = [];
  const sessionIds = new Set(next
    .map(row => sanitizeText(row?.sessionId || row?.session_id || '', 120))
    .filter(Boolean));

  for (const sessionId of sessionIds) {
    const inSession = row => sanitizeText(row?.sessionId || row?.session_id || '', 120) === sessionId;
    const expected = next.filter(row => inSession(row) && Number.isInteger(Number(row?.fields?.expectedOrdinal)))
      .sort((a, b) => Number(a.fields.expectedOrdinal) - Number(b.fields.expectedOrdinal));
    const requirements = next.filter(row => inSession(row)
      && row?.fields?.classifierTarget === true
      && /^requirement:/i.test(String(row?.id || '')))
      .sort((a, b) => Number(String(a.id).match(/^requirement:(\d+)/i)?.[1] || 0)
        - Number(String(b.id).match(/^requirement:(\d+)/i)?.[1] || 0));
    if (expected.length && expected.length === requirements.length) {
      const targetsAreUnique = progressIdentitiesAreUnique(requirements);
      const ordinalsAreComplete = expected.every((row, index) => Number(row.fields.expectedOrdinal) === index + 1);
      const compatible = expected.every((row, index) => actionsCompatible(row, requirements[index]));
      const merged = expected.map((row, index) => mergeCanonicalProgressRows(row, requirements[index]));
      if (targetsAreUnique && ordinalsAreComplete && compatible && merged.every(Boolean)) {
        const replacementByKey = new Map(expected.map((row, index) => [ledgerRowKey(row), merged[index]]));
        const removedKeys = new Set(requirements.map(ledgerRowKey));
        next = next
          .filter(row => !removedKeys.has(ledgerRowKey(row)))
          .map(row => replacementByKey.get(ledgerRowKey(row)) || row);
        requirements.forEach((row, index) => reconciled.push({ incomingId: row.id, canonicalId: expected[index].id }));
      }
    }

    const unboundExpected = next.filter(row => inSession(row)
      && Number.isInteger(Number(row?.fields?.expectedOrdinal))
      && row?.fields?.classifierTarget !== true)
      .sort((a, b) => Number(a.fields.expectedOrdinal) - Number(b.fields.expectedOrdinal));
    const concreteRows = next.filter(row => inSession(row) && !isCanonicalProgressRow(row));
    if (unboundExpected.length && unboundExpected.length === concreteRows.length) {
      const identitiesAreUnique = progressIdentitiesAreUnique(concreteRows);
      const ordinalsAreComplete = unboundExpected.every((row, index) => Number(row.fields.expectedOrdinal) === index + 1);
      const compatible = unboundExpected.every((row, index) => actionsCompatible(row, concreteRows[index]));
      const merged = unboundExpected.map((row, index) => mergeCanonicalProgressRows(row, concreteRows[index]));
      if (identitiesAreUnique && ordinalsAreComplete && compatible && merged.every(Boolean)) {
        const replacementByKey = new Map(unboundExpected.map((row, index) => [ledgerRowKey(row), merged[index]]));
        const removedKeys = new Set(concreteRows.map(ledgerRowKey));
        next = next
          .filter(row => !removedKeys.has(ledgerRowKey(row)))
          .map(row => replacementByKey.get(ledgerRowKey(row)) || row);
        concreteRows.forEach((row, index) => reconciled.push({ incomingId: row.id, canonicalId: unboundExpected[index].id }));
      }
    }

    const canonicalRows = next.filter(row => inSession(row)
      && Number.isInteger(Number(row?.fields?.expectedOrdinal))
      && row?.fields?.classifierTarget === true);
    for (const duplicate of [...next]) {
      if (!inSession(duplicate) || isCanonicalProgressRow(duplicate)) continue;
      let bestScore = 0;
      let matches = [];
      for (const canonical of canonicalRows) {
        if (!actionsCompatible(canonical, duplicate)) continue;
        const score = identityMatchScore(canonical, duplicate);
        if (score > bestScore) {
          bestScore = score;
          matches = [canonical];
        } else if (score > 0 && score === bestScore) {
          matches.push(canonical);
        }
      }
      if (!bestScore || matches.length !== 1) continue;
      const canonical = matches[0];
      const merged = mergeCanonicalProgressRows(canonical, duplicate);
      if (!merged) continue;
      const canonicalKey = ledgerRowKey(canonical);
      const duplicateKey = ledgerRowKey(duplicate);
      next = next.filter(row => ledgerRowKey(row) !== duplicateKey)
        .map(row => ledgerRowKey(row) === canonicalKey ? merged : row);
      const canonicalIndex = canonicalRows.indexOf(canonical);
      if (canonicalIndex >= 0) canonicalRows[canonicalIndex] = merged;
      reconciled.push({ incomingId: duplicate.id, canonicalId: canonical.id });
    }
  }
  return { rows: next, changed: reconciled.length > 0, reconciled };
}

export function progressCounts(rows = []) {
  const counts = { total: 0, pending: 0, acted: 0, processed: 0, skipped: 0, failed: 0, unresolved: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    const status = normalizeStatus(row?.status, 'pending');
    counts.total += 1;
    counts[status] += 1;
    if (!isTerminalLedgerStatus(status)) counts.unresolved += 1;
  }
  return counts;
}

export function unresolvedLedgerRows(rows = [], opts = {}) {
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(0, Math.floor(Number(opts.limit))) : Infinity;
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || isTerminalLedgerStatus(row.status)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export function selectLedgerRows(rows = [], opts = {}) {
  const status = opts.status ? normalizeStatus(opts.status, '') : '';
  const sessionId = sanitizeText(opts.sessionId || opts.session_id || '', 120);
  const offset = Number.isFinite(Number(opts.offset)) ? Math.max(0, Math.floor(Number(opts.offset))) : 0;
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(0, Math.floor(Number(opts.limit))) : 50;
  const filtered = (Array.isArray(rows) ? rows : [])
    .filter(row => (!status || normalizeStatus(row?.status, 'pending') === status)
      && (!sessionId || sanitizeText(row?.sessionId || row?.session_id || '', 120) === sessionId));
  return filtered.slice(offset, offset + limit);
}

export function upsertLedgerItems(rows = [], items = [], opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const source = sanitizeText(opts.source || 'model', 40) || 'model';
  const next = Array.isArray(rows) ? rows.map(row => ({ ...row, fields: row?.fields ? { ...row.fields } : undefined })) : [];
  const reconciliation = reconcileLedgerItems(next, items, { ...opts, source, now });
  const indexByKey = new Map();
  next.forEach((row, idx) => {
    const key = ledgerRowKey(row);
    if (key) indexByKey.set(key, idx);
  });

  const updated = [];
  const blockedDowngrades = [];
  for (const rawItem of reconciliation.items) {
    const incoming = normalizeLedgerItem(rawItem, { source, now, sessionId: opts.sessionId, pageScope: opts.pageScope, taskKey: opts.taskKey });
    if (!incoming) continue;
    const key = ledgerRowKey(incoming);
    const existingIdx = indexByKey.get(key);
    if (existingIdx == null) {
      next.push(incoming);
      indexByKey.set(key, next.length - 1);
      updated.push(incoming);
      continue;
    }

    const existing = next[existingIdx] || {};
    const autoActed = source === 'auto' && incoming.status === 'acted';
    const keepTerminal = isBlockedLedgerDowngrade(existing.status, incoming.status, { source, allowReopen: opts.allowReopen });
    if (keepTerminal && !autoActed) {
      blockedDowngrades.push({ id: incoming.id, keptStatus: existing.status, requestedStatus: incoming.status });
    }
    const merged = {
      ...existing,
      label: incoming.label || existing.label,
      ...(incoming.target ? { target: incoming.target } : {}),
      ...(incoming.url ? { url: incoming.url } : {}),
      status: keepTerminal ? existing.status : incoming.status,
      ...(incoming.action ? { action: incoming.action } : {}),
      fields: { ...(existing.fields || {}), ...(incoming.fields || {}) },
      ...(incoming.reason ? { reason: incoming.reason } : {}),
      sessionId: incoming.sessionId || existing.sessionId,
      pageScope: incoming.pageScope || existing.pageScope,
      taskKey: incoming.taskKey || existing.taskKey,
      source: incoming.source || existing.source,
      attempts: source === 'auto'
        ? Math.max(1, Number(existing.attempts || 0) + 1)
        : Math.max(Number(existing.attempts || 0), Number(incoming.attempts || 0)),
      firstSeenAt: Number.isFinite(Number(existing.firstSeenAt)) ? Number(existing.firstSeenAt) : incoming.firstSeenAt,
      updatedAt: now,
    };
    if (!Object.keys(merged.fields || {}).length) delete merged.fields;
    if (!merged.sessionId) delete merged.sessionId;
    if (!merged.pageScope) delete merged.pageScope;
    if (!merged.taskKey) delete merged.taskKey;
    next[existingIdx] = merged;
    updated.push(merged);
  }

  return {
    rows: next,
    updated,
    counts: progressCounts(next),
    changed: updated.length > 0,
    blockedDowngrades,
    reconciled: reconciliation.reconciled,
  };
}

export function formatLedgerRow(row) {
  if (!row) return '';
  const status = normalizeStatus(row.status, 'pending');
  const action = sanitizeText(row.action, 60);
  const label = sanitizeText(row.label || row.id, 220);
  const id = sanitizeText(row.id, 160);
  const fields = row.fields && typeof row.fields === 'object'
    ? Object.entries(row.fields)
      .slice(0, 8)
      .map(([k, v]) => `${sanitizeText(k, 60)}=${v == null ? 'null' : sanitizeText(v, 160)}`)
      .filter(Boolean)
      .join(', ')
    : '';
  const reason = sanitizeText(row.reason || '', 240);
  return `- ${status}${action ? ` ${action}` : ''}: ${label}${id && id !== label ? ` [id: ${id}]` : ''}${fields ? ` (${fields})` : ''}${reason ? ` - ${reason}` : ''}`;
}

export function formatLedgerSummary(rows = [], opts = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) return 'Progress ledger: no rows.';
  const maxRows = Number.isFinite(Number(opts.maxRows)) ? Math.max(1, Math.floor(Number(opts.maxRows))) : 18;
  const counts = progressCounts(safeRows);
  const unresolved = unresolvedLedgerRows(safeRows);
  const unresolvedKeys = new Set(unresolved.map(ledgerRowKey));
  const ordered = [
    ...unresolved,
    ...safeRows.filter(row => !unresolvedKeys.has(ledgerRowKey(row))),
  ].slice(0, maxRows);
  const countText = `total ${counts.total}; pending ${counts.pending}; acted ${counts.acted}; processed ${counts.processed}; skipped ${counts.skipped}; failed ${counts.failed}`;
  const lines = ordered.map(formatLedgerRow).filter(Boolean);
  const more = safeRows.length > ordered.length ? `\n... ${safeRows.length - ordered.length} more row(s) omitted from prompt view; call progress_read for full ledger.` : '';
  return `Progress ledger (${countText}). Unresolved rows before done: ${counts.unresolved}.\n${lines.join('\n')}${more}`;
}

export function ledgerDoneBlock(rows = [], opts = {}) {
  const unresolved = unresolvedLedgerRows(rows, { limit: opts.limit || 12 });
  if (!unresolved.length) return null;
  const counts = progressCounts(rows);
  const examples = unresolved.map(formatLedgerRow).join('\n');
  return {
    blocked: true,
    counts,
    unresolved,
    error: `The app-owned progress ledger still has ${counts.unresolved} unresolved row(s). Before calling done, use progress_update to mark each as processed, skipped, or failed, including any collected fields such as email/null. Unresolved rows:\n${examples}`,
  };
}

export function detectProgressAction(toolName, args = {}, result = {}, opts = {}) {
  if (!CLICK_ACTION_TOOLS.has(toolName)) return null;
  if (!result || result.success === false || result.error || result.noProgress) return null;
  const allowedActions = new Set((Array.isArray(opts.allowedActions) ? opts.allowedActions : [])
    .map(value => sanitizeText(value, 80).toLowerCase())
    .filter(Boolean));

  const labels = [
    args.text,
    args.name,
    args.label,
    result.requestedText,
    result.beforeText,
    result.beforeName,
    result.name,
    result.text,
  ].map(v => sanitizeText(v, 220)).filter(Boolean);
  const href = sanitizeText(result.href || result.url || '', 500);

  for (const label of labels) {
    const match = label.match(ACTION_RE);
    if (!match) continue;
    const action = match[1].toLowerCase();
    if (allowedActions.size && !allowedActions.has(action)) continue;
    const target = cleanTarget(match[2] || '') || targetFromHref(href);
    const id = stableIdFor(action, target, href);
    if (!id) continue;
    return {
      id,
      label: target ? `${action} ${target}` : label,
      action,
      status: 'acted',
      ...(href ? { url: href } : {}),
    };
  }

  return null;
}
