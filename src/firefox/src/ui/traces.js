/**
 * Traces page — inspects IndexedDB runs recorded by the trace recorder.
 * Supports single-run timeline view and two-run side-by-side compare.
 */

import {
  listRuns, getRun, getRunEvents, getScreenshot,
  getSessionStats, deleteRun, clearAllRuns, repairStaleRuns,
} from '../trace/recorder.js';
import { isKnownKind, isIgnorableKind } from '../trace/event-model.js';
import { buildTraceTrajectory } from '../trace/trajectory.js';
import { aggregateTraceRuns } from '../trace/stats.js';
import { buildTraceLineageGroups } from '../trace/lineage.js';
import { buildTraceExportPayload } from '../trace/export-contract.js';
import { sanitizeTraceExport } from '../agent/trace-export.js';
import { t } from './i18n.js';
import { escapeHtml, escapeAttr } from './utils.js';

const runtimeApi = globalThis.browser || globalThis.chrome;

const listEl = document.getElementById('run-list');
const mainPane = document.getElementById('main-pane');
const emptyState = document.getElementById('empty-state');
const countPill = document.getElementById('count-pill');
const filterText = document.getElementById('filter-text');
const filterModel = document.getElementById('filter-model');
const imgModal = document.getElementById('img-modal');
const imgModalImg = document.getElementById('img-modal-img');
const initialRunId = new URLSearchParams(location.search).get('runId');

let allRuns = [];
let selectedRunId = null;
let compareMode = false;
let compareIds = []; // length 0..2
let timelineObjectUrls = new Set();
let traceRenderRequestId = 0;
let traceRefreshRequestId = 0;
let lineageResult = { groups: [], incomplete: false };
const expandedSessionKeys = new Set();
const expandedLineageKeys = new Set();

// conversationId → [runs, oldest first]. Rebuilt from allRuns on every refresh.
let conversationMap = new Map();

function rebuildConversationMap() {
  conversationMap = new Map();
  for (const r of allRuns) {
    if (!r.conversationId) continue;
    const arr = conversationMap.get(r.conversationId) || [];
    arr.push(r);
    conversationMap.set(r.conversationId, arr);
  }
  for (const arr of conversationMap.values()) {
    arr.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  }
}

function siblingsOf(run) {
  if (!run || !run.conversationId) return [];
  return conversationMap.get(run.conversationId) || [];
}

/**
 * Render run cost in USD. Returns '' when the provider didn't report cost
 * (older runs from before recorder tracked it, providers that don't bill,
 * BYOK setups without cost data). Sub-cent values get an extra digit so a
 * $0.003 run isn't rendered as $0.00.
 */
function formatCost(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

// ----- List -----------------------------------------------------------------

async function refresh() {
  const requestId = ++traceRefreshRequestId;
  const runs = await listRuns({ limit: 500 });
  if (requestId !== traceRefreshRequestId) return;
  allRuns = runs;
  rebuildConversationMap();
  countPill.textContent = t(allRuns.length === 1 ? 'tr.run' : 'tr.runs', { n: allRuns.length });
  // Populate model filter.
  const models = Array.from(new Set(allRuns.map(r => r.model).filter(Boolean))).sort();
  const prev = filterModel.value;
  filterModel.innerHTML = `<option value="">${escapeHtml(t('tr.filter.all_models'))}</option>` +
    models.map(m => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`).join('');
  filterModel.value = models.includes(prev) ? prev : '';
  renderList();
}

async function ensureRunLoaded(runId) {
  if (!runId || allRuns.some((run) => run.runId === runId)) return true;
  const run = await getRun(runId).catch(() => null);
  if (!run) return false;
  allRuns.push(run);
  allRuns.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  rebuildConversationMap();
  countPill.textContent = t(allRuns.length === 1 ? 'tr.run' : 'tr.runs', { n: allRuns.length });
  return true;
}

function lineageStateLabel(node) {
  const labels = {
    'missing-parent': 'tr.lineage.missing_parent',
    'ambiguous-parent': 'tr.lineage.ambiguous_parent',
    'cross-session-parent': 'tr.lineage.cross_session_parent',
    'duplicate-id': 'tr.lineage.duplicate_id',
    cycle: 'tr.lineage.cycle',
  };
  return t(labels[node?.lineageState] || 'tr.lineage.incomplete');
}

function renderRunItem(r, node = null) {
  const status = r.status || 'done';
  const statusClass = safeClassToken(status, 'done');
  const started = new Date(r.startedAt).toLocaleString();
  const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—';
  const steps = r.stepCount || 0;
  const tokens = (r.totalInputTokens || 0) + (r.totalOutputTokens || 0);
  const costStr = formatCost(r.totalCost);
  const cls = [
    'run-item',
    selectedRunId === r.runId ? 'selected' : '',
    compareIds.includes(r.runId) ? 'compare' : '',
  ].filter(Boolean).join(' ');
  const title = r.userMessage || t('tr.no_task');
  const losslessBadge = r.lossless === true
    ? `<span class="lossless-badge" title="${escapeAttr(t('tr.lossless.warning'))}">${escapeHtml(t('tr.lossless.badge'))}</span>`
    : '';
  const siblings = siblingsOf(r);
  const convChip = siblings.length > 1
    ? `<span class="conv-chip" title="${escapeAttr(t('tr.conversation.tooltip', { n: siblings.length, id: r.conversationId }))}">🧵 ${siblings.length}</span>`
    : '';
  const lineageState = node?.lineageState || 'root';
  const lineageBadge = lineageState !== 'root' && lineageState !== 'attached'
    ? `<span class="lineage-badge ${safeClassToken(lineageState)}" title="${escapeAttr(lineageStateLabel(node))}">${lineageState === 'cross-session-parent' ? '↗' : '⚠'}</span>`
    : '';
  const parentReference = node?.parentRunId
    ? `<span class="lineage-parent-ref" title="${escapeAttr(lineageStateLabel(node))}">↳ ${escapeHtml(node.parentRunId.slice(0, 16))}</span>`
    : '';
  // Highlight costly-but-empty runs (≥$0.50 spent with no final text) so
  // users can spot expensive failures at a glance.
  const isCostlyFailure = (r.totalCost || 0) >= 0.5 && (!r.finalContent || !r.finalContent.trim());
  const costClass = isCostlyFailure ? 'cost-warn' : '';
  return `
    <div class="${cls}" data-run-id="${escapeAttr(r.runId || '')}" data-lineage-key="${escapeAttr(node?.key || '')}">
      <div class="run-title"><span class="status-dot ${statusClass}"></span>${escapeHtml(title.slice(0, 120))}${losslessBadge}${convChip}${lineageBadge}${parentReference}</div>
      <div class="run-meta">
        <span class="run-model">${escapeHtml(r.model || '?')}</span>
        <span>${escapeHtml(r.providerId || '')}</span>
        <span>${escapeHtml(t(steps === 1 ? 'tr.step' : 'tr.steps_plural', { n: steps }))}</span>
        <span>${dur}</span>
        ${tokens ? `<span>${escapeHtml(t('tr.tokens_short', { n: tokens.toLocaleString() }))}</span>` : ''}
        ${costStr ? `<span class="${costClass}" title="${escapeAttr(t('tr.cost.tooltip'))}">${escapeHtml(costStr)}</span>` : ''}
      </div>
      <div class="run-meta" style="margin-top:3px;"><span>${started}</span></div>
    </div>
  `;
}

function renderLineageNode(node) {
  const expanded = expandedLineageKeys.has(node.key);
  const toggle = node.children.length
    ? `<button type="button" class="lineage-toggle" data-lineage-toggle="${escapeAttr(node.key)}" aria-expanded="${expanded}" aria-label="${escapeAttr(t('tr.lineage.toggle'))}">${expanded ? '▾' : '▸'}</button>`
    : '<span class="lineage-toggle-spacer" aria-hidden="true"></span>';
  const children = expanded
    ? node.children.map(child => renderLineageNode(child)).join('')
    : '';
  return `
    <div class="lineage-node ${node.lineageState !== 'root' && node.lineageState !== 'attached' ? 'lineage-node-issue' : ''}">
      <div class="lineage-row">
        ${toggle}
        ${renderRunItem(node.run, node)}
      </div>
      ${children}
    </div>
  `;
}

function renderLineageGroup(group) {
  const expanded = expandedSessionKeys.has(group.key);
  const stats = aggregateTraceRuns(group.nodes.map(node => node.run));
  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  const summary = [
    t(group.sessionId ? 'tr.conversation.label' : 'tr.lineage.standalone'),
    t(group.runCount === 1 ? 'tr.run' : 'tr.runs', { n: group.runCount }),
    totalTokens ? t('tr.tokens_short', { n: totalTokens.toLocaleString() }) : '',
    formatCost(stats.totalCost) ? formatCost(stats.totalCost) : '',
  ].filter(Boolean).join(' · ');
  return `
    <section class="lineage-group ${expanded ? 'expanded' : ''}">
      <button type="button" class="lineage-group-toggle" data-lineage-group-key="${escapeAttr(group.key)}" aria-expanded="${expanded}">
        <span class="lineage-group-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
        <span class="lineage-group-title">${escapeHtml(t(group.sessionId ? 'tr.conversation.label' : 'tr.lineage.standalone'))}</span>
        <span class="lineage-group-summary">${escapeHtml(summary)}</span>
      </button>
      ${expanded ? `<div class="lineage-group-runs">${group.roots.map(root => renderLineageNode(root)).join('')}</div>` : ''}
    </section>
  `;
}

function expandLineageForRun(runId) {
  if (!runId) return;
  const node = lineageResult.groups
    .flatMap(group => group.nodes)
    .find(candidate => candidate.runId === runId);
  if (!node) return;
  expandedSessionKeys.add(node.sessionKey);
  const nodesByKey = new Map(lineageResult.groups
    .flatMap(group => group.nodes)
    .map(candidate => [candidate.key, candidate]));
  let parentKey = node.parentKey;
  while (parentKey) {
    expandedLineageKeys.add(parentKey);
    parentKey = nodesByKey.get(parentKey)?.parentKey || null;
  }
}

function renderList() {
  const needle = filterText.value.trim().toLowerCase();
  const modelFilter = filterModel.value;
  const filtered = allRuns.filter(r => {
    if (modelFilter && r.model !== modelFilter) return false;
    if (!needle) return true;
    return [r.userMessage, r.model, r.tabUrl, r.tabTitle, r.providerId]
      .some(v => (v || '').toLowerCase().includes(needle));
  });
  if (filtered.length === 0) {
    lineageResult = { groups: [], incomplete: false };
    listEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px;">${escapeHtml(t('tr.no_match'))}</div>`;
    return;
  }
  const queryBounded = allRuns.length >= 500 || Boolean(needle || modelFilter);
  lineageResult = buildTraceLineageGroups(filtered, { bounded: queryBounded });
  const groupsByKey = new Map(lineageResult.groups.map(group => [group.key, group]));
  for (const key of expandedSessionKeys) {
    if (!groupsByKey.has(key)) expandedSessionKeys.delete(key);
  }
  const incompleteNotice = lineageResult.incomplete
    ? `<div class="lineage-incomplete" role="status">⚠ ${escapeHtml(t('tr.lineage.incomplete'))}</div>`
    : '';
  listEl.innerHTML = `${incompleteNotice}${lineageResult.groups.map(renderLineageGroup).join('')}`;
  listEl.querySelectorAll('[data-lineage-group-key]').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.lineageGroupKey;
      if (expandedSessionKeys.has(key)) expandedSessionKeys.delete(key);
      else expandedSessionKeys.add(key);
      renderList();
    });
  });
  listEl.querySelectorAll('[data-lineage-toggle]').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.lineageToggle;
      if (expandedLineageKeys.has(key)) expandedLineageKeys.delete(key);
      else expandedLineageKeys.add(key);
      renderList();
    });
  });
  listEl.querySelectorAll('.run-item').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.runId) handleRunClick(el.dataset.runId);
    });
  });
}

function handleRunClick(runId) {
  if (compareMode) {
    const idx = compareIds.indexOf(runId);
    if (idx >= 0) compareIds.splice(idx, 1);
    else compareIds.push(runId);
    if (compareIds.length > 2) compareIds.shift();
    renderList();
    if (compareIds.length === 2) renderCompare(compareIds[0], compareIds[1]);
    else {
      mainPane.classList.remove('compare-mode');
      replaceTimelineObjectUrls(new Set());
      mainPane.innerHTML = `<div id="empty-state"><div><p style="font-size:14px;">${escapeHtml(t('tr.compare_mode.title'))}</p><p style="color:var(--text3);">${escapeHtml(t('tr.compare_mode.picked', { n: compareIds.length }))}</p></div></div>`;
    }
  } else {
    selectedRunId = runId;
    expandLineageForRun(runId);
    renderList();
    renderRun(runId);
  }
}

// ----- Single run view ------------------------------------------------------

function isCurrentRunRender(requestId, runId) {
  return requestId === traceRenderRequestId && !compareMode && selectedRunId === runId;
}

function isCurrentCompareRender(requestId, aId, bId) {
  return requestId === traceRenderRequestId &&
    compareMode &&
    compareIds.length === 2 &&
    compareIds[0] === aId &&
    compareIds[1] === bId;
}

async function renderRun(runId) {
  const requestId = ++traceRenderRequestId;
  const run = await getRun(runId);
  if (!isCurrentRunRender(requestId, runId)) return;
  if (!run) {
    replaceTimelineObjectUrls(new Set());
    return;
  }
  const events = await getRunEvents(runId).catch(() => []);
  if (!isCurrentRunRender(requestId, runId)) return;
  const objectUrls = new Set();
  const html = await buildRunView(run, events, false, objectUrls);
  if (!isCurrentRunRender(requestId, runId)) {
    revokeObjectUrls(objectUrls);
    return;
  }
  mainPane.classList.remove('compare-mode');
  replaceTimelineObjectUrls(objectUrls);
  mainPane.innerHTML = html;
  wireTimelineImages(mainPane);
}

async function renderCompare(aId, bId) {
  const requestId = ++traceRenderRequestId;
  const [a, b, aEv, bEv] = await Promise.all([
    getRun(aId), getRun(bId),
    getRunEvents(aId).catch(() => []),
    getRunEvents(bId).catch(() => []),
  ]);
  if (!isCurrentCompareRender(requestId, aId, bId)) return;
  if (!a || !b) {
    replaceTimelineObjectUrls(new Set());
    return;
  }
  const objectUrls = new Set();
  const aHtml = await buildRunView(a, aEv, true, objectUrls);
  const bHtml = await buildRunView(b, bEv, true, objectUrls);
  if (!isCurrentCompareRender(requestId, aId, bId)) {
    revokeObjectUrls(objectUrls);
    return;
  }
  mainPane.classList.add('compare-mode');
  replaceTimelineObjectUrls(objectUrls);
  mainPane.innerHTML = `<div class="pane">${aHtml}</div><div class="pane">${bHtml}</div>`;
  wireTimelineImages(mainPane);
}

/**
 * Render a "Conversation" panel listing sibling runs (turns of the same
 * chat) so users can jump between them. Hidden in compare mode (panes are
 * already two-up) and when there's only one run in the conversation.
 */
function renderConversationPanel(run, compact, sessionStats = null) {
  if (compact) return '';
  const siblings = siblingsOf(run);
  if (siblings.length < 2) return '';
  const stats = sessionStats || aggregateTraceRuns(siblings);
  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  const summary = [
    t(stats.runCount === 1 ? 'tr.run' : 'tr.runs', { n: stats.runCount }),
    t(stats.stepCount === 1 ? 'tr.step' : 'tr.steps_plural', { n: stats.stepCount }),
    totalTokens ? t('tr.tokens_short', { n: totalTokens.toLocaleString() }) : '',
    formatCost(stats.totalCost) ? `${t('tr.cost.label')}: ${formatCost(stats.totalCost)}` : '',
    stats.errorCount ? `${t('tr.event.error_kind')} ×${stats.errorCount}` : '',
  ].filter(Boolean).join(' · ');
  const turnNumber = siblings.findIndex(r => r.runId === run.runId) + 1;
  const items = siblings.map((r, i) => {
    const isCurrent = r.runId === run.runId;
    const label = (r.userMessage || t('tr.no_task')).slice(0, 60);
    const cls = `conv-turn${isCurrent ? ' current' : ''}`;
    return `<button class="${cls}" data-jump-run-id="${escapeAttr(r.runId)}" title="${escapeAttr(r.userMessage || '')}">
      <span class="conv-turn-n">#${i + 1}</span>
      <span class="conv-turn-msg">${escapeHtml(label)}</span>
    </button>`;
  }).join('');
  return `
    <div class="conv-panel">
      <div class="conv-panel-label">${escapeHtml(t('tr.conversation.label'))} · ${escapeHtml(t('tr.conversation.turn_of', { n: turnNumber, total: siblings.length }))}</div>
      <div class="conv-summary">${escapeHtml(summary)}</div>
      <div class="conv-turns">${items}</div>
    </div>
  `;
}

function formatTrajectoryDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return '—';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatTrajectoryMetric(value) {
  return value > 0 ? value.toLocaleString() : '—';
}

function renderTrajectoryActivity(row) {
  const parts = [];
  if (row.requestCount) parts.push(`${escapeHtml(t('tr.event.llm_request'))} ×${row.requestCount}`);
  if (row.responseCount) parts.push(`${escapeHtml(t('tr.event.llm_response'))} ×${row.responseCount}`);
  if (row.toolCount) {
    const names = row.toolNames.length ? ` · ${row.toolNames.map(name => escapeHtml(name)).join(', ')}` : '';
    parts.push(`🔧 ×${row.toolCount}${names}`);
  }
  if (row.subCallCount) parts.push(`${escapeHtml(t('tr.event.vision_sub_call'))} ×${row.subCallCount}`);
  if (row.errorCount) parts.push(`${escapeHtml(t('tr.event.error_kind'))} ×${row.errorCount}`);
  return parts.join(' · ') || '—';
}

function renderTrajectoryErrors(row) {
  if (!row.errors.length && !row.errorCodes.length) return '';
  const codes = row.errorCodes.length ? ` · ${row.errorCodes.map(code => escapeHtml(code)).join(', ')}` : '';
  const details = row.errors.map((error) => {
    const parts = [error.code, error.phase, error.message].filter(Boolean).map(escapeHtml);
    return parts.join(' · ');
  });
  if (!details.length) details.push(row.errorCodes.map(code => escapeHtml(code)).join('\n'));
  return `<details class="trajectory-errors"><summary>${escapeHtml(t('tr.event.error_kind'))}${codes}</summary><div class="trajectory-error-details">${details.join('\n')}</div></details>`;
}

function renderStepTrajectory(events, compact) {
  const rows = buildTraceTrajectory(events);
  if (!rows.length) return '';
  const tableRows = rows.map((row) => {
    const status = safeClassToken(row.status);
    const stepLabel = row.step == null ? '—' : row.step;
    const cost = formatCost(row.cost) || '—';
    return `
      <tr class="trajectory-row ${status}" data-step="${escapeAttr(row.step == null ? 'run' : row.step)}">
        <th scope="row">
          <span class="trajectory-step">${escapeHtml(stepLabel)}</span>
          <div class="trajectory-activity">${renderTrajectoryActivity(row)}</div>
          ${renderTrajectoryErrors(row)}
        </th>
        <td><span class="trajectory-status">${escapeHtml(row.status)}</span>${row.repaired ? ' ↻' : ''}</td>
        <td class="trajectory-metric">${escapeHtml(formatTrajectoryDuration(row.durationMs))}</td>
        <td class="trajectory-metric">${escapeHtml(formatTrajectoryMetric(row.inputTokens))}</td>
        <td class="trajectory-metric">${escapeHtml(formatTrajectoryMetric(row.outputTokens))}</td>
        <td class="trajectory-metric">${escapeHtml(cost)}</td>
      </tr>`;
  }).join('');
  return `
    <section class="trajectory${compact ? ' compact' : ''}" aria-label="${escapeAttr(t('tr.steps.label'))}">
      <div class="trajectory-heading">${escapeHtml(t('tr.steps.label'))}</div>
      <div class="trajectory-scroll">
        <table class="trajectory-table">
          <thead><tr>
            <th scope="col">#</th>
            <th scope="col">${escapeHtml(t('tr.status.label'))}</th>
            <th scope="col">${escapeHtml(t('tr.duration.label'))}</th>
            <th scope="col">${escapeHtml(t('tr.intokens.label'))}</th>
            <th scope="col">${escapeHtml(t('tr.outtokens.label'))}</th>
            <th scope="col">${escapeHtml(t('tr.cost.label'))}</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </section>`;
}

async function buildRunView(run, events, compact, objectUrls = new Set()) {
  const sessionStats = !compact && run.conversationId
    ? await getSessionStats(run.conversationId).catch(() => null)
    : null;
  const header = `
    <div class="run-header">
      <h2>${escapeHtml(run.model || t('tr.unknown_model'))}</h2>
      <span class="meta">${escapeHtml(run.providerId || '')} · ${new Date(run.startedAt).toLocaleString()}</span>
    </div>
    <div class="stats-row">
      <span class="stat">${escapeHtml(t('tr.status.label'))} <b>${escapeHtml(run.status || '')}</b></span>
      <span class="stat">${escapeHtml(t('tr.steps.label'))} <b>${run.stepCount || 0}</b></span>
      <span class="stat">${escapeHtml(t('tr.duration.label'))} <b>${run.durationMs ? (run.durationMs / 1000).toFixed(1) + 's' : '—'}</b></span>
      <span class="stat">${escapeHtml(t('tr.intokens.label'))} <b>${(run.totalInputTokens || 0).toLocaleString()}</b></span>
      <span class="stat">${escapeHtml(t('tr.outtokens.label'))} <b>${(run.totalOutputTokens || 0).toLocaleString()}</b></span>
      ${formatCost(run.totalCost) ? `<span class="stat">${escapeHtml(t('tr.cost.label'))} <b>${escapeHtml(formatCost(run.totalCost))}</b></span>` : ''}
    </div>
    ${run.lossless === true ? `<div class="lossless-warning" role="alert">${escapeHtml(t('tr.lossless.warning'))}</div>` : ''}
    ${renderConversationPanel(run, compact, sessionStats)}
    <div class="run-task">${escapeHtml(run.userMessage || '')}</div>
    ${run.finalContent ? `<div class="run-task" style="border-left-color:var(--success);"><b style="color:var(--success);">${escapeHtml(t('tr.final_label'))}</b> ${escapeHtml(run.finalContent)}</div>` : ''}
  `;
  // Build timeline — collect screenshot blobs for img src.
  const shotCache = new Map();
  for (const ev of events) {
    if (ev.kind === 'screenshot') {
      const shot = await getScreenshot(run.runId, ev.seq);
      if (shot) shotCache.set(ev.seq, shot);
    }
  }
  const items = events.map(ev => renderEvent(ev, shotCache, compact, objectUrls)).join('');
  return `${header}${renderStepTrajectory(events, compact)}<div class="timeline">${items}</div>`;
}

function renderEvent(ev, shotCache, compact, objectUrls = new Set()) {
  // Kind-level collapse for events recorded as ignorable. The catalog is
  // empty today; the check keeps the behavior defined for future kinds.
  if (isIgnorableKind(ev.kind)) return '';
  const ts = new Date(ev.ts).toLocaleTimeString();
  const stepBadge = ev.data?.step != null ? `<span class="step">${escapeHtml(t('tr.event.step', { step: ev.data.step }))}</span>` : '';
  switch (ev.kind) {
    case 'llm_request': {
      const media = [
        Number.isFinite(ev.data?.imageBlockCount) ? `${ev.data.imageBlockCount} img` : '',
        Number.isFinite(ev.data?.documentBlockCount) ? `${ev.data.documentBlockCount} doc` : '',
      ].filter(Boolean).join(' · ');
      const rag = ev.data?.localWikipediaRag;
      const ragDates = (Array.isArray(rag?.archiveDates) ? rag.archiveDates : []).slice(0, 3).join(', ');
      const ragLabel = rag?.multiSource === true ? 'Offline RAG' : 'Wikipedia RAG';
      const ragDetails = rag
        ? ` · ${ragLabel}: ${rag.status || (rag.attempted ? 'attempted' : 'skipped')}${rag.attempted ? ` · ${Number(rag.matchCount) || 0} match${Number(rag.matchCount) === 1 ? '' : 'es'}` : ''}${ragDates ? ` · ${ragDates}` : ''}`
        : '';
      return `
        <div class="event llm_request">
          <div class="event-head"><span class="kind">${escapeHtml(t('tr.event.llm_request'))}</span>${stepBadge}<span class="latency">${ts}</span></div>
          <span class="tool-args">${escapeHtml(t('tr.event.messages_tools', {
            m: ev.data?.messageCount || 0,
            t: ev.data?.toolsCount || 0,
            model: ev.data?.model || '',
          }))}${media ? ` · ${escapeHtml(media)}` : ''}${escapeHtml(ragDetails)}</span>
        </div>`;
    }
    case 'llm_response': {
      const u = ev.data?.usage;
      const usage = u ? `<span class="latency">${(u.prompt_tokens || 0).toLocaleString()} in / ${(u.completion_tokens || 0).toLocaleString()} out</span>` : '';
      const lat = ev.data?.latencyMs != null ? `<span class="latency">${ev.data.latencyMs} ms</span>` : '';
      const content = ev.data?.content;
      const hasVisibleContent = typeof content === 'string' ? content.trim().length > 0 : !!content;
      const toolCalls = ev.data?.toolCalls || [];
      let body = '';
      if (hasVisibleContent) {
        body += `<div class="content-text">${escapeHtml(content)}</div>`;
      }
      if (toolCalls.length > 0) {
        const tcList = toolCalls.map(tc => {
          let args = tc.args || '';
          try { args = JSON.stringify(JSON.parse(args), null, 2); } catch {}
          return `<details><summary><span class="tool-name">${escapeHtml(tc.name)}</span>()</summary><pre>${escapeHtml(args)}</pre></details>`;
        }).join('');
        body += `<div style="margin-top:6px;">${tcList}</div>`;
      }
      if (!hasVisibleContent && toolCalls.length === 0) {
        const emptyDetails = [
          `reason=${ev.data?.emptyReason || 'unknown'}`,
          ev.data?.finishReason ? `finish=${ev.data.finishReason}` : '',
          Number.isInteger(ev.data?.outputTokens) ? `output_tokens=${ev.data.outputTokens}` : '',
          Number.isInteger(ev.data?.reasoningTokens)
            ? `reasoning_tokens=${ev.data.reasoningTokens}`
            : (ev.data?.reasoningPresent === true ? 'reasoning_present=true' : ''),
          Number.isInteger(ev.data?.requestedMaxTokens) ? `requested_max_tokens=${ev.data.requestedMaxTokens}` : '',
          Number.isInteger(ev.data?.recoveryAttempt) ? `attempt=${ev.data.recoveryAttempt}` : '',
          `content_chars=${Number.isInteger(ev.data?.contentChars) ? ev.data.contentChars : 0}`,
          `tool_calls=${Number.isInteger(ev.data?.toolCallCount) ? ev.data.toolCallCount : 0}`,
        ].filter(Boolean).join(' · ');
        body = `<div class="tool-args">EMPTY_RESPONSE · ${escapeHtml(emptyDetails)}</div>`;
      }
      return `
        <div class="event llm_response">
          <div class="event-head"><span class="kind">${escapeHtml(t('tr.event.llm_response'))}</span>${stepBadge}${usage}${lat}<span class="latency">${ts}</span></div>
          ${body}
        </div>`;
    }
    case 'tool': {
      const name = ev.data?.name || '?';
      const lat = ev.data?.latencyMs != null ? `<span class="latency">${ev.data.latencyMs} ms</span>` : '';
      const args = ev.data?.args ? JSON.stringify(ev.data.args, null, 2) : '';
      let result = ev.data?.result;
      try { result = typeof result === 'string' ? result : JSON.stringify(result, null, 2); } catch { result = String(result); }
      if (typeof result === 'string' && result.length > 4000 && compact) result = result.slice(0, 4000) + '\n' + t('tr.event.description_truncated');
      const ok = ev.data?.result && !ev.data.result.error && ev.data.result.success !== false;
      return `
        <div class="event tool">
          <div class="event-head">
            <span class="kind">${ok ? '✓' : '✗'} <span class="tool-name">${escapeHtml(name)}</span></span>
            ${lat}<span class="latency">${ts}</span>
          </div>
          ${args ? `<details><summary>${escapeHtml(t('tr.event.args'))}</summary><pre>${escapeHtml(args)}</pre></details>` : ''}
          <details ${ok ? '' : 'open'}><summary>${escapeHtml(t('tr.event.result'))}</summary><pre>${escapeHtml(result || '')}</pre></details>
        </div>`;
    }
    case 'screenshot': {
      const shot = shotCache.get(ev.seq);
      let src = '';
      if (shot?.blob) src = createTrackedObjectUrl(shot.blob, objectUrls);
      else if (shot?.dataUrl) src = shot.dataUrl;
      const caption = ev.data?.caption || t('tr.event.screenshot_caption');
      return `
        <div class="event screenshot">
          <div class="event-head"><span class="kind">📷 ${escapeHtml(caption)}</span>${stepBadge}<span class="latency">${ts}</span></div>
          ${src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(caption)}" loading="lazy">` : `<span class="latency">${escapeHtml(t('tr.event.screenshot_missing'))}</span>`}
        </div>`;
    }
    case 'streaming': {
      const d = ev.data || {};
      const details = [
        d.protocol,
        d.reason,
        d.errorCode ? `#${d.errorCode}` : '',
        Number.isFinite(d.textDeltaCount) ? `Δ × ${d.textDeltaCount}` : '',
        Number.isFinite(d.textChars) ? t('st.skills.item.chars', { count: d.textChars }) : '',
        Number.isFinite(d.firstDeltaMs) ? `TTFT ${d.firstDeltaMs} ms` : '',
        Number.isFinite(d.durationMs) ? `${t('tr.duration.label')}: ${d.durationMs} ms` : '',
        Number.isFinite(d.toolCallCount) ? `🔧 × ${d.toolCallCount}` : '',
      ].filter(Boolean).join(' · ');
      const message = d.message ? `<div class="content-text">${escapeHtml(d.message)}</div>` : '';
      return `
        <div class="event streaming">
          <div class="event-head"><span class="kind">🌊 ${escapeHtml(t('st.display.openai_ask_streaming.label'))}: ${escapeHtml(d.status || '?')}</span>${stepBadge}<span class="latency">${ts}</span></div>
          ${details ? `<div class="tool-args">${escapeHtml(details)}</div>` : ''}
          ${message}
        </div>`;
    }
    case 'error': {
      return `
        <div class="event error">
          <div class="event-head"><span class="kind">${escapeHtml(t('tr.event.error_kind'))}</span>${stepBadge}<span class="latency">${ts}</span></div>
          <div class="content-text">${escapeHtml(ev.data?.phase || '')}: ${escapeHtml(ev.data?.message || '')}</div>
        </div>`;
    }
    case 'vision_sub_call': {
      const lat = ev.data?.latencyMs != null ? `<span class="latency">${ev.data.latencyMs} ms</span>` : '';
      const model = ev.data?.model ? `<span class="latency">${escapeHtml(ev.data.model)}</span>` : '';
      const ctx = ev.data?.context ? `<span class="tool-args">${escapeHtml(ev.data.context)}</span>` : '';
      const body = ev.data?.error
        ? `<div class="content-text" style="color:#f88;">${escapeHtml(t('tr.event.vision_failed', { error: ev.data.error }))}</div>`
        : (ev.data?.description
            ? `<details open><summary>${escapeHtml(t('tr.event.description'))}</summary><pre>${escapeHtml(ev.data.description)}</pre></details>`
            : '');
      return `
        <div class="event vision_sub_call">
          <div class="event-head"><span class="kind">${escapeHtml(t('tr.event.vision_sub_call'))}</span>${ctx}${model}${lat}<span class="latency">${ts}</span></div>
          ${body}
        </div>`;
    }
    case 'note':
    default: {
      if (ev.data?.note === 'standalone_wikipedia_search_requested') {
        const queries = Math.max(1, Number(ev.data?.extra?.queryCount) || 1);
        return `
          <div class="event note">
            <div class="event-head"><span class="kind">Local Wikipedia retrieval</span>${stepBadge}<span class="latency">${ts}</span></div>
            <span class="tool-args">On-device model request · ${queries} ${queries === 1 ? 'query' : 'queries'} · no network access</span>
          </div>`;
      }
      if (!isKnownKind(ev.kind)) {
        // Unknown kind from a newer build: keep the event visible instead of
        // letting it vanish silently, but label it as unknown so the lack of
        // rich rendering is obvious.
        return `
          <div class="event unknown">
            <div class="event-head"><span class="kind">Unknown event · ${escapeHtml(ev.kind)}</span>${stepBadge}<span class="latency">${ts}</span></div>
            <pre>${escapeHtml(JSON.stringify(ev.data, null, 2))}</pre>
          </div>`;
      }
      return `
        <div class="event note">
          <div class="event-head"><span class="kind">${escapeHtml(ev.kind)}</span>${stepBadge}<span class="latency">${ts}</span></div>
          <pre>${escapeHtml(JSON.stringify(ev.data, null, 2))}</pre>
        </div>`;
    }
  }
}

function createTrackedObjectUrl(blob, objectUrls) {
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  return url;
}

function revokeObjectUrls(urls) {
  for (const url of urls) URL.revokeObjectURL(url);
}

function replaceTimelineObjectUrls(nextUrls) {
  const oldUrls = timelineObjectUrls;
  if (oldUrls.size > 0) {
    const modalSrc = imgModalImg?.src || '';
    const modalUsesOldUrl = oldUrls.has(modalSrc);
    revokeObjectUrls(oldUrls);
    if (modalUsesOldUrl) {
      imgModal.classList.remove('show');
      imgModalImg.removeAttribute('src');
    }
  }
  timelineObjectUrls = nextUrls;
}

function wireTimelineImages(root) {
  root.querySelectorAll('.event.screenshot img').forEach(img => {
    img.addEventListener('click', () => {
      imgModalImg.src = img.src;
      imgModal.classList.add('show');
    });
  });
  // Conversation panel: jumping between sibling runs.
  root.querySelectorAll('button[data-jump-run-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.jumpRunId;
      if (!id || id === selectedRunId) return;
      selectedRunId = id;
      expandLineageForRun(id);
      renderList();
      renderRun(id);
    });
  });
}

imgModal.addEventListener('click', () => imgModal.classList.remove('show'));

// ----- Toolbar handlers ------------------------------------------------------

document.getElementById('btn-refresh').addEventListener('click', async () => {
  await refresh();
  // Manual refresh might surface a newly-started run; kick polling back on
  // if so. Idempotent — does nothing if a timer is already pending.
  if (hasRunningJob()) scheduleAutoRefresh();
});

document.getElementById('btn-compare').addEventListener('click', () => {
  compareMode = !compareMode;
  const btn = document.getElementById('btn-compare');
  if (compareMode) {
    btn.classList.add('primary');
    btn.textContent = t('tr.btn.compare.picking');
    compareIds = [];
    selectedRunId = null;
    mainPane.classList.remove('compare-mode');
    replaceTimelineObjectUrls(new Set());
    mainPane.innerHTML = `<div id="empty-state"><div><p style="font-size:14px;">${escapeHtml(t('tr.compare_mode.title'))}</p><p style="color:var(--text3);">${escapeHtml(t('tr.compare_mode.hint'))}</p></div></div>`;
  } else {
    btn.classList.remove('primary');
    btn.textContent = t('tr.btn.compare');
    compareIds = [];
    mainPane.classList.remove('compare-mode');
    replaceTimelineObjectUrls(new Set());
    mainPane.innerHTML = `<div id="empty-state"><div><p style="font-size:14px;">${escapeHtml(t('tr.empty.title'))}</p></div></div>`;
  }
  renderList();
});

async function loadTraceExportEntry(run) {
  const events = await getRunEvents(run.runId).catch(() => []);
  // Resolve screenshot blobs to base64 for portability.
  for (const ev of events) {
    if (ev.kind === 'screenshot') {
      const shot = await getScreenshot(run.runId, ev.seq);
      if (shot?.blob) {
        ev.data = ev.data || {};
        ev.data.screenshot_base64 = await blobToBase64(shot.blob);
      } else if (shot?.dataUrl) {
        ev.data = ev.data || {};
        ev.data.screenshot_dataUrl = shot.dataUrl;
      }
    }
  }
  return { run, events };
}

document.getElementById('btn-export').addEventListener('click', async () => {
  if (!selectedRunId) return alert(t('tr.select_first'));
  const runId = selectedRunId;
  const run = await getRun(runId);
  if (!run) return alert(t('tr.select_first'));
  const sessionId = typeof run.conversationId === 'string' ? run.conversationId.trim() : '';
  const sessionRuns = sessionId
    ? await listRuns({ conversationId: run.conversationId }).catch(() => [])
    : [];
  const exportRuns = [];
  const seenRunIds = new Set();
  for (const candidate of [...sessionRuns, run]) {
    if (!candidate?.runId || seenRunIds.has(candidate.runId)) continue;
    seenRunIds.add(candidate.runId);
    exportRuns.push(candidate);
  }
  const entries = [];
  for (const exportRun of exportRuns) entries.push(await loadTraceExportEntry(exportRun));
  const isSession = Boolean(sessionId);
  const payload = buildTraceExportPayload(entries, {
    sessionId,
    exportedAt: Date.now(),
    exportedByWebBrainVersion: browser.runtime.getManifest().version || '',
  });
  const blob = new Blob([JSON.stringify(sanitizeTraceExport(payload), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = isSession
    ? `webbrain-session-${safeFilenamePart(sessionId, 'session')}.json`
    : `webbrain-trace-${run.model || 'unknown'}-${run.runId}.json`;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 7000);
  }
});

document.getElementById('btn-delete').addEventListener('click', async () => {
  if (!selectedRunId) return alert(t('tr.select_first'));
  const runId = selectedRunId;
  if (!confirm(t('tr.confirm_delete'))) return;
  await deleteRun(runId);
  if (selectedRunId === runId) {
    selectedRunId = null;
    replaceTimelineObjectUrls(new Set());
    mainPane.innerHTML = `<div id="empty-state"><div><p>${escapeHtml(t('tr.deleted'))}</p></div></div>`;
  }
  await refresh();
});

document.getElementById('btn-clear-all').addEventListener('click', async () => {
  if (!confirm(t('tr.confirm_delete_all'))) return;
  await clearAllRuns();
  selectedRunId = null;
  compareIds = [];
  replaceTimelineObjectUrls(new Set());
  mainPane.innerHTML = `<div id="empty-state"><div><p>${escapeHtml(t('tr.all_deleted'))}</p></div></div>`;
  refresh();
});

// Re-render on locale change so already-rendered content updates in place.
document.addEventListener('wb-locale-changed', async () => {
  await refresh();
  const compareBtn = document.getElementById('btn-compare');
  compareBtn.textContent = compareMode ? t('tr.btn.compare.picking') : t('tr.btn.compare');
  if (compareMode) {
    if (compareIds.length === 2) {
      renderCompare(compareIds[0], compareIds[1]);
    } else {
      mainPane.classList.remove('compare-mode');
      replaceTimelineObjectUrls(new Set());
      const textKey = compareIds.length === 0 ? 'tr.compare_mode.hint' : 'tr.compare_mode.picked';
      const textParams = compareIds.length === 0 ? undefined : { n: compareIds.length };
      mainPane.innerHTML = `<div id="empty-state"><div><p style="font-size:14px;">${escapeHtml(t('tr.compare_mode.title'))}</p><p style="color:var(--text3);">${escapeHtml(t(textKey, textParams))}</p></div></div>`;
    }
  } else if (selectedRunId) {
    renderRun(selectedRunId);
  } else {
    replaceTimelineObjectUrls(new Set());
    mainPane.innerHTML = `<div id="empty-state"><div><p style="font-size:14px;">${escapeHtml(t('tr.empty.title'))}</p></div></div>`;
  }
});

filterText.addEventListener('input', renderList);
filterModel.addEventListener('change', renderList);

// ----- Utils -----------------------------------------------------------------

function safeClassToken(value, fallback = 'unknown') {
  const token = String(value == null ? '' : value).trim();
  return /^[A-Za-z0-9_-]+$/.test(token) ? token : fallback;
}
function safeFilenamePart(value, fallback = 'unknown') {
  const token = String(value == null ? '' : value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 80)
    .replace(/^[.-]+|[.-]+$/g, '');
  return token || fallback;
}
function blobToBase64(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}

// Auto-refresh while visible AND while at least one run is still running —
// so a live job shows new steps but a finished page doesn't keep re-rendering
// under the user's cursor while they're trying to examine a single run.
// Self-rescheduling setTimeout (not setInterval) so the gating check can
// short-circuit the next tick.
const AUTO_REFRESH_MS = 30000;
let _autoTimer = null;
function hasRunningJob() {
  return allRuns.some((r) => r.status === 'running');
}
async function autoRefreshTick() {
  _autoTimer = null;
  if (document.hidden) return;
  await refresh();
  if (selectedRunId && !compareMode) renderRun(selectedRunId);
  if (hasRunningJob()) scheduleAutoRefresh();
}
function scheduleAutoRefresh() {
  if (_autoTimer || document.hidden) return;
  _autoTimer = setTimeout(autoRefreshTick, AUTO_REFRESH_MS);
}
function stopAutoRefresh() {
  if (_autoTimer) { clearTimeout(_autoTimer); _autoTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAutoRefresh();
  else if (hasRunningJob()) scheduleAutoRefresh();
});

// Prefer letting the background own the stale-run scan: only its recorder
// instance knows which runs are live in memory. If it cannot be reached,
// nothing can be running anywhere, so a local pass is safe.
async function repairStaleRunsForPage({ timeoutMs = 5_000 } = {}) {
  let timer;
  try {
    if (runtimeApi?.runtime?.sendMessage) {
      const response = await Promise.race([
        runtimeApi.runtime.sendMessage({ type: 'WB_TRACE_REPAIR_STALE_RUNS' }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('trace repair roundtrip timed out')), timeoutMs);
        }),
      ]);
      if (response?.ok) return Array.isArray(response.repaired) ? response.repaired : [];
    }
  } catch {} finally {
    clearTimeout(timer);
  }
  return repairStaleRuns().catch(() => []);
}

// Initial load: always do one refresh so the list populates, then only keep
// polling if the freshly-loaded data shows a live run.
(async () => {
  await repairStaleRunsForPage();
  await refresh();
  if (initialRunId && await ensureRunLoaded(initialRunId)) {
    selectedRunId = initialRunId;
    renderList();
    expandLineageForRun(initialRunId);
    renderList();
    await renderRun(initialRunId);
  }
  if (hasRunningJob()) scheduleAutoRefresh();
})();
