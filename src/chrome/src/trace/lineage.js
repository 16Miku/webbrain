/**
 * Group persisted trace runs and build same-session parent/child trees.
 *
 * The Traces UI deliberately receives an explicit, bounded result. A missing
 * parent is therefore represented on the node instead of being inferred away.
 * This module has no browser or storage dependencies so its relationship
 * rules can be shared by Chrome, Firefox, and tests.
 */

function normalizedId(value) {
  if (value == null) return '';
  return String(value).trim();
}

function startedAt(run) {
  const value = Number(run?.startedAt);
  return Number.isFinite(value) ? value : 0;
}

function compareRuns(a, b) {
  const timeDelta = startedAt(a.run) - startedAt(b.run);
  if (timeDelta !== 0) return timeDelta;
  const idDelta = a.runId.localeCompare(b.runId);
  return idDelta !== 0 ? idDelta : a.key.localeCompare(b.key);
}

function compareGroups(a, b) {
  const aLatest = a.nodes.reduce((latest, node) => Math.max(latest, startedAt(node.run)), 0);
  const bLatest = b.nodes.reduce((latest, node) => Math.max(latest, startedAt(node.run)), 0);
  if (aLatest !== bLatest) return bLatest - aLatest;
  return a.key.localeCompare(b.key);
}

function sessionKey(run, index) {
  const sessionId = normalizedId(run?.conversationId);
  return sessionId ? `session:${sessionId}` : `singleton:${index}`;
}

function markCycleNodes(proposedParents, nodes) {
  const cycleKeys = new Set();
  for (const start of nodes) {
    const positions = new Map();
    const path = [];
    let current = start;
    while (current && proposedParents.has(current)) {
      if (positions.has(current.key)) {
        const cycleStart = positions.get(current.key);
        for (const node of path.slice(cycleStart)) cycleKeys.add(node.key);
        break;
      }
      positions.set(current.key, path.length);
      path.push(current);
      current = proposedParents.get(current);
    }
  }
  return cycleKeys;
}

export function buildTraceLineageGroups(runs, { bounded = false } = {}) {
  const records = Array.isArray(runs) ? runs : [];
  const nodes = records.map((rawRun, index) => {
    const run = rawRun && typeof rawRun === 'object' ? rawRun : {};
    const runId = normalizedId(run.runId);
    return {
      key: `lineage:${runId || `missing:${index}`}`,
      index,
      run,
      runId,
      parentRunId: normalizedId(run.parentRunId),
      parentSessionId: normalizedId(run.parentSessionId),
      sessionId: normalizedId(run.conversationId) || null,
      sessionKey: sessionKey(run, index),
      parentKey: null,
      children: [],
      lineageState: 'root',
    };
  });

  const groupsByKey = new Map();
  for (const node of nodes) {
    let group = groupsByKey.get(node.sessionKey);
    if (!group) {
      group = {
        key: node.sessionKey,
        sessionId: node.sessionId,
        runCount: 0,
        nodes: [],
        roots: [],
      };
      groupsByKey.set(node.sessionKey, group);
    }
    group.nodes.push(node);
    group.runCount += 1;
  }

  const byRunId = new Map();
  for (const node of nodes) {
    if (!node.runId) continue;
    const matches = byRunId.get(node.runId) || [];
    matches.push(node);
    byRunId.set(node.runId, matches);
  }
  const duplicateIds = new Set(
    [...byRunId.entries()]
      .filter(([, matches]) => matches.length > 1)
      .map(([runId]) => runId),
  );
  for (const node of nodes) {
    if (duplicateIds.has(node.runId)) {
      node.key = `lineage:${node.runId}:${node.index}`;
      node.lineageState = 'duplicate-id';
    }
  }

  const proposedParents = new Map();
  let missingParentCount = 0;
  let ambiguousParentCount = 0;
  let crossSessionParentCount = 0;
  for (const node of nodes) {
    if (!node.runId || node.lineageState === 'duplicate-id' || !node.parentRunId) continue;
    const candidates = byRunId.get(node.parentRunId) || [];
    if (candidates.length === 0) {
      node.lineageState = 'missing-parent';
      missingParentCount += 1;
      continue;
    }
    if (candidates.length !== 1) {
      node.lineageState = 'ambiguous-parent';
      ambiguousParentCount += 1;
      continue;
    }
    const parent = candidates[0];
    if (
      parent.sessionKey !== node.sessionKey
      || (node.parentSessionId && node.parentSessionId !== node.sessionId)
    ) {
      node.lineageState = 'cross-session-parent';
      crossSessionParentCount += 1;
      continue;
    }
    proposedParents.set(node, parent);
  }

  const cycleKeys = markCycleNodes(proposedParents, nodes);
  for (const node of nodes) {
    if (cycleKeys.has(node.key)) node.lineageState = 'cycle';
  }

  for (const node of nodes) {
    if (cycleKeys.has(node.key) || node.lineageState !== 'root') continue;
    const parent = proposedParents.get(node);
    if (!parent) continue;
    node.parentKey = parent.key;
    node.lineageState = 'attached';
    parent.children.push(node);
  }

  for (const group of groupsByKey.values()) {
    group.nodes.sort(compareRuns);
    group.roots = group.nodes.filter(node => !node.parentKey);
    group.roots.sort(compareRuns);
    for (const node of group.nodes) node.children.sort(compareRuns);
  }

  const groups = [...groupsByKey.values()].sort(compareGroups);
  const duplicateIdCount = [...duplicateIds].reduce(
    (count, runId) => count + (byRunId.get(runId)?.length || 0),
    0,
  );
  const cycleCount = cycleKeys.size;
  const incomplete = Boolean(
    bounded
    || missingParentCount
    || ambiguousParentCount
    || crossSessionParentCount
    || duplicateIdCount
    || cycleCount,
  );

  return {
    groups,
    incomplete,
    missingParentCount,
    ambiguousParentCount,
    crossSessionParentCount,
    duplicateIdCount,
    cycleCount,
  };
}
