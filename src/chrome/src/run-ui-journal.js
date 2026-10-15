export const RUN_UI_EVENT_LIMIT = 256;
export const RUN_UI_TEXT_DELTA_PERSIST_DELAY_MS = 200;
export const RUN_UI_STREAM_TEXT_LIMIT = 100000;
export const RUN_UI_PERSIST_BUDGET = 512 * 1024;
export const RUN_UI_PERSIST_RETRY_BUDGET = 128 * 1024;

export function runUiUpdatesForCurrentTask(updates = []) {
  if (!Array.isArray(updates)) return [];
  let boundary = -1;
  for (let index = updates.length - 1; index >= 0; index--) {
    if (updates[index]?.type === 'steering_applied') { boundary = index; break; }
  }
  if (boundary < 0) return updates;
  // Applied user steering replaces task outcomes, not run-wide resource or
  // persistence boundaries. Classifiers share this view; history stays intact.
  return updates.filter((update, index) => index > boundary || update?.type === 'quota'
    || (update?.type === 'run_status' && update?.data?.status === 'persistence_degraded'));
}

/**
 * Highest sequence number that was genuinely evicted from the bounded replay
 * journal. Older snapshots used `truncatedBeforeSeq` for both eviction and
 * ordinary acknowledgements, so only treat that legacy value as a replay gap
 * when it extends beyond the acknowledged boundary.
 */
export function runUiDiscardedBeforeSeq(snapshot = {}) {
  if (Object.prototype.hasOwnProperty.call(snapshot, 'discardedBeforeSeq')) {
    const explicit = Number(snapshot.discardedBeforeSeq);
    return Number.isFinite(explicit) ? Math.max(0, explicit) : 0;
  }
  const legacy = Number(snapshot.truncatedBeforeSeq || 0);
  const acknowledged = Number(snapshot.ackedSeq || 0);
  if (!Number.isFinite(legacy) || legacy <= acknowledged) return 0;
  return Math.max(0, legacy);
}

/**
 * Events at or below this boundary are no longer available to a sidepanel
 * replay. They may have been rendered and acknowledged by another panel copy,
 * or genuinely evicted by the bounded journal.
 */
export function runUiUnavailableBeforeSeq(snapshot = {}) {
  const acknowledged = Number(snapshot.ackedSeq || 0);
  const acknowledgedBoundary = Number.isFinite(acknowledged) ? Math.max(0, acknowledged) : 0;
  return Math.max(acknowledgedBoundary, runUiDiscardedBeforeSeq(snapshot));
}

export function createRunRequestId(tabId, supplied = '') {
  const clean = String(supplied || '').trim();
  return clean || `req_${tabId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function runUiSnapshotForRequest(snapshot, requestedRequestId = '') {
  const requested = String(requestedRequestId || '');
  if (!requested) return snapshot || null;
  return String(snapshot?.requestId || '') === requested ? snapshot : null;
}

const RUN_UI_TOOL_RESULT_PREVIEW_CHARS = 500;

function compactRunUiToolResult(result, name) {
  const source = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const compacted = {};
  if (typeof source.success === 'boolean') compacted.success = source.success;
  if (typeof source.ok === 'boolean') compacted.ok = source.ok;
  if (source.error) compacted.error = String(source.error).slice(0, 1000);
  if (source.warning) compacted.warning = String(source.warning).slice(0, 1000);
  if (source.summary) compacted.summary = String(source.summary).slice(0, 2000);
  if (source.outcome) compacted.outcome = source.outcome;
  if (typeof source.pageContent === 'string') {
    compacted.pageContent = source.pageContent.slice(0, RUN_UI_TOOL_RESULT_PREVIEW_CHARS);
    if (source.pageContentTruncated === true || source.pageContent.length > RUN_UI_TOOL_RESULT_PREVIEW_CHARS) {
      compacted.pageContentTruncated = true;
    }
  } else if (typeof source.text === 'string' && source.text) {
    compacted.text = source.text.slice(0, RUN_UI_TOOL_RESULT_PREVIEW_CHARS);
    if (source.textTruncated === true || source.text.length > RUN_UI_TOOL_RESULT_PREVIEW_CHARS) {
      compacted.textTruncated = true;
    }
  }
  if (['auto_screenshot', 'staged_screenshot'].includes(name)) {
    // Preserve the vision output for live details and replay, without retaining
    // image bytes or allowing a single capture to exhaust the journal budget.
    if (typeof source.description === 'string') {
      compacted.description = source.description.slice(0, 12000);
      if (source.descriptionTruncated === true || source.description.length > 12000) {
        compacted.descriptionTruncated = true;
      }
    }
    for (const key of ['method', 'model', 'visionRoute']) {
      if (typeof source[key] === 'string') compacted[key] = source[key].slice(0, 300);
    }
  }
  if (source.truncated === true) compacted.truncated = true;
  if (source.hasMore === true) compacted.hasMore = true;
  if (source.notice) compacted.notice = String(source.notice).slice(0, 300);
  if (name === 'generate_image' && source.success === true) {
    // Inline bytes live in IndexedDB; retain the asset handle for live delivery
    // and replay. Hosted/local URLs are small enough to keep in the journal.
    for (const key of ['url', 'mediaId', 'mimeType', 'provider', 'model']) {
      if (typeof source[key] === 'string') compacted[key] = source[key];
    }
    if (source.inlineMedia === true) compacted.inlineMedia = true;
  }
  if (Object.keys(compacted).length === 0) {
    try {
      compacted.preview = String(JSON.stringify(source) || '{}').slice(0, 300);
    } catch {
      compacted.preview = '{}';
    }
  }
  return compacted;
}

export function compactRunUiData(type, data) {
  if (!data || typeof data !== 'object') return data;
  if (type === 'tool_result') {
    return {
      name: data.name,
      result: compactRunUiToolResult(data.result, data.name),
    };
  }
  if (type === 'text' || type === 'text_delta') {
    return { ...data, content: String(data.content || '').slice(0, 30000) };
  }
  return data;
}

function isCompleteTableJsonFinal(content) {
  if (content.length > 30000) return false;
  let parsed;
  try { parsed = JSON.parse(content); } catch { return false; }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
      || Object.keys(parsed).length !== 2
      || !Object.hasOwn(parsed, 'rowCount') || !Object.hasOwn(parsed, 'rows')
      || !Number.isSafeInteger(parsed.rowCount) || parsed.rowCount < 0
      || !Array.isArray(parsed.rows) || parsed.rowCount !== parsed.rows.length) return false;
  return parsed.rows.every(row => row && typeof row === 'object' && !Array.isArray(row)
    && Object.values(row).every(cell => cell === null
      || typeof cell === 'string' || typeof cell === 'boolean'
      || typeof cell === 'number' && Number.isFinite(cell)));
}

export function compactRunUiSnapshotForPersist(snapshot, options = {}) {
  const tight = options.tight === true;
  const budget = tight ? RUN_UI_PERSIST_RETRY_BUDGET : RUN_UI_PERSIST_BUDGET;
  const clone = typeof structuredClone === 'function'
    ? structuredClone(snapshot || {})
    : JSON.parse(JSON.stringify(snapshot || {}));
  const finalContent = String(clone.finalContent || '');
  // Preserve a complete bounded table answer as formatting only. Success and
  // execution authority still come from the existing terminal evidence.
  const finalContentLimit = tight && !isCompleteTableJsonFinal(finalContent) ? 8000 : 30000;
  clone.finalContent = finalContent.slice(0, finalContentLimit);
  clone.streamedText = String(clone.streamedText || '').slice(0, tight ? 30000 : RUN_UI_STREAM_TEXT_LIMIT);
  const eventCap = tight ? 64 : RUN_UI_EVENT_LIMIT;
  clone.events = (Array.isArray(clone.events) ? clone.events : []).slice(-eventCap).map(event => {
    const data = compactRunUiData(event?.type, event?.data);
    if (tight && data && typeof data === 'object' && typeof data.content === 'string') {
      data.content = data.content.slice(0, 4000);
    }
    return { ...event, data };
  });
  const removedBoundary = Number((Array.isArray(snapshot?.events) ? snapshot.events : []).at(-(clone.events.length + 1))?.seq || 0);
  if (removedBoundary > 0) {
    clone.discardedBeforeSeq = Math.max(runUiDiscardedBeforeSeq(clone), removedBoundary);
    clone.truncatedBeforeSeq = clone.discardedBeforeSeq;
  }
  while (clone.events.length && JSON.stringify(clone).length > budget) {
    const removed = clone.events.shift();
    clone.discardedBeforeSeq = Math.max(runUiDiscardedBeforeSeq(clone), Number(removed?.seq || 0));
    clone.truncatedBeforeSeq = clone.discardedBeforeSeq;
  }
  return clone;
}

export class RunUiPersistenceScheduler {
  constructor({
    persist,
    delayMs = RUN_UI_TEXT_DELTA_PERSIST_DELAY_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    if (typeof persist !== 'function') throw new TypeError('persist must be a function');
    this.persist = persist;
    this.delayMs = delayMs;
    // Browser timer functions are Web APIs with receiver checks. Calling a
    // saved setTimeout/clearTimeout as an instance property makes `this` the
    // scheduler and Chrome throws "Illegal invocation" on the first streamed
    // text delta. Bind injected and native timers to the actual global scope.
    this.setTimeoutFn = setTimeoutFn.bind(globalThis);
    this.clearTimeoutFn = clearTimeoutFn.bind(globalThis);
    this.pending = new Map();
  }

  _persist(tabId, snapshot) {
    try {
      return Promise.resolve(this.persist(tabId, snapshot));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  _take(tabId, cancelTimer = true) {
    const pending = this.pending.get(tabId);
    if (!pending) return null;
    this.pending.delete(tabId);
    if (cancelTimer && pending.timer != null) this.clearTimeoutFn(pending.timer);
    return pending.snapshot;
  }

  defer(tabId, snapshot) {
    const existing = this.pending.get(tabId);
    if (existing) {
      existing.snapshot = snapshot;
      return;
    }
    const pending = { snapshot, timer: null };
    this.pending.set(tabId, pending);
    pending.timer = this.setTimeoutFn(() => {
      const latest = this._take(tabId, false);
      if (latest) void this._persist(tabId, latest).catch(() => {});
    }, this.delayMs);
  }

  persistNow(tabId, snapshot) {
    this.cancel(tabId);
    return this._persist(tabId, snapshot);
  }

  flush(tabId) {
    const snapshot = this._take(tabId);
    return snapshot ? this._persist(tabId, snapshot) : null;
  }

  cancel(tabId) {
    this._take(tabId);
  }
}

export class RunUiJournal {
  constructor({ eventLimit = RUN_UI_EVENT_LIMIT, onChange = null } = {}) {
    this.eventLimit = eventLimit;
    this.onChange = onChange;
    this.snapshots = new Map();
  }

  _changed(tabId, snapshot, change = {}) {
    if (typeof this.onChange === 'function') this.onChange(tabId, snapshot, change);
    return snapshot;
  }

  begin(tabId, requestId = '', metadata = {}) {
    const attachmentCount = Number.isFinite(Number(metadata?.attachmentCount))
      ? Math.max(0, Number(metadata.attachmentCount))
      : 0;
    const snapshot = {
      tabId,
      requestId: createRunRequestId(tabId, requestId),
      mode: String(metadata?.mode || ''),
      kind: metadata?.kind === 'continue' ? 'continue' : 'chat',
      scheduledJobId: String(metadata?.scheduledJobId || ''),
      scheduledExecutionId: String(metadata?.scheduledExecutionId || ''),
      foreground: metadata?.foreground === true,
      attachmentCount,
      attachmentDeliveryState: attachmentCount ? 'sending' : '',
      runId: null,
      status: 'running',
      seq: 0,
      ackedSeq: 0,
      discardedBeforeSeq: 0,
      // Legacy alias retained for persisted snapshots and older callers.
      truncatedBeforeSeq: 0,
      events: [],
      pendingPlanId: null,
      lastPlanResolution: null,
      finalContent: '',
      successfulDone: false,
      runSucceeded: false,
      hadError: false,
      lastError: '',
      quota: null,
      pendingToolCall: null,
      streamedText: '',
      streamedTextStartSeq: 0,
      streamedTextSeq: 0,
      streamedTextTruncated: false,
      // Display-only state survives acknowledged events; incomplete prose
      // never contributes to completion evidence or success classification.
      responseRetry: null,
      responseIncomplete: false,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.snapshots.set(tabId, snapshot);
    return this._changed(tabId, snapshot);
  }

  resume(tabId, requestId = '', metadata = {}) {
    const snapshot = this.snapshots.get(tabId);
    if (!snapshot || String(snapshot.requestId) !== String(requestId)) return null;
    if (metadata?.mode) snapshot.mode = String(metadata.mode);
    if (typeof metadata?.foreground === 'boolean') snapshot.foreground = metadata.foreground;
    if (Number.isFinite(Number(metadata?.attachmentCount))) {
      snapshot.attachmentCount = Math.max(0, Number(metadata.attachmentCount));
      if (snapshot.attachmentCount && !snapshot.attachmentDeliveryState) {
        snapshot.attachmentDeliveryState = 'sending';
      }
    }
    if (!snapshot.kind && metadata?.kind) {
      snapshot.kind = metadata.kind === 'continue' ? 'continue' : 'chat';
    }
    snapshot.status = 'running';
    snapshot.pendingPlanId = null;
    snapshot.finalContent = '';
    snapshot.quota = null;
    snapshot.successfulDone = false;
    snapshot.runSucceeded = false;
    snapshot.endedAt = null;
    snapshot.responseRetry = null;
    snapshot.responseIncomplete = false;
    return this._changed(tabId, snapshot);
  }

  record(tabId, requestId, type, data, runId = null) {
    const snapshot = this.snapshots.get(tabId);
    if (!snapshot || snapshot.requestId !== requestId) return null;
    snapshot.runId = runId || snapshot.runId || null;
    const event = {
      seq: ++snapshot.seq,
      type,
      data: compactRunUiData(type, data),
      ts: Date.now(),
    };
    snapshot.events.push(event);
    if (data?.quota) snapshot.quota = structuredClone(data.quota);
    if (type === 'text_delta') {
      if (snapshot.responseRetry || snapshot.responseIncomplete) {
        snapshot.streamedText = '';
        snapshot.streamedTextStartSeq = 0;
        snapshot.streamedTextTruncated = false;
      }
      const chunk = String(event.data?.content || '');
      if (!snapshot.streamedText && !snapshot.streamedTextTruncated) {
        snapshot.streamedTextStartSeq = event.seq;
      }
      snapshot.streamedTextSeq = event.seq;
      if (!snapshot.streamedTextTruncated) {
        const nextText = snapshot.streamedText + chunk;
        if (nextText.length <= RUN_UI_STREAM_TEXT_LIMIT) {
          snapshot.streamedText = nextText;
        } else {
          snapshot.streamedText = '';
          snapshot.streamedTextStartSeq = 0;
          snapshot.streamedTextTruncated = true;
        }
      }
    } else if (type === 'text' || type === 'tool_call') {
      snapshot.streamedText = '';
      snapshot.streamedTextStartSeq = 0;
      snapshot.streamedTextSeq = 0;
      snapshot.streamedTextTruncated = false;
    }
    if (type === 'response_retry') {
      snapshot.responseRetry = {
        reason: 'stream_interrupted',
        retainPartial: data?.retainPartial === true,
        seq: event.seq,
      };
      snapshot.responseIncomplete = snapshot.responseRetry.retainPartial && !!snapshot.streamedText;
      if (!snapshot.responseRetry.retainPartial) {
        snapshot.streamedText = '';
        snapshot.streamedTextStartSeq = 0;
        snapshot.streamedTextSeq = 0;
        snapshot.streamedTextTruncated = false;
      }
    } else if (['text', 'text_delta', 'tool_call', 'error', 'failure_recovery', 'run_complete', 'steering_applied'].includes(type)) {
      snapshot.responseRetry = null;
    }
    if (['text', 'text_delta', 'tool_call', 'steering_applied'].includes(type)) snapshot.responseIncomplete = false;
    while (snapshot.events.length > this.eventLimit) {
      const removed = snapshot.events.shift();
      const removedSeq = Number(removed?.seq || 0);
      snapshot.discardedBeforeSeq = removedSeq || snapshot.discardedBeforeSeq;
      snapshot.truncatedBeforeSeq = snapshot.discardedBeforeSeq;
    }
    if (type === 'plan_review') {
      snapshot.status = 'awaiting_plan';
      snapshot.pendingPlanId = String(data?.planId || '') || null;
      snapshot.lastPlanResolution = null;
    }
    if (type === 'plan_resolved') {
      snapshot.status = 'running';
      if (!data?.planId || String(data.planId) === String(snapshot.pendingPlanId)) snapshot.pendingPlanId = null;
      snapshot.lastPlanResolution = {
        planId: String(data?.planId || ''),
        decision: String(data?.decision || ''),
      };
    }
    if (type === 'tool_call' && data?.outcomeUnknown === true) {
      snapshot.pendingToolCall = {
        name: String(data?.name || ''),
        seq: event.seq,
      };
    }
    if (type === 'steering_applied') {
      snapshot.successfulDone = false;
      snapshot.runSucceeded = false;
      snapshot.hadError = false;
      snapshot.lastError = '';
    }
    if (type === 'tool_result'
        && data?.name === 'done'
        && data?.result?.done === true
        && !data?.result?.blockedDone) {
      snapshot.successfulDone = data.result.outcome === 'success'
        && data.result.success !== false && !data.result.error;
    }
    if (type === 'error' || type === 'attachment_rejected' || type === 'max_steps_reached') {
      snapshot.hadError = true;
      snapshot.lastError = String(
        data?.message
        || data?.error
        || (type === 'max_steps_reached' ? 'The run reached its maximum step limit.' : ''),
      ).slice(0, 2000);
    }
    if (type === 'attachment_rejected' && Number(snapshot.attachmentCount || 0) > 0) {
      snapshot.attachmentDeliveryState = 'not-sent';
    }
    this._changed(tabId, snapshot, { eventType: type });
    return { ...event, requestId: snapshot.requestId, runId: snapshot.runId };
  }

  settleToolCall(tabId, requestId, name = '') {
    const snapshot = this.snapshots.get(tabId);
    if (!snapshot || snapshot.requestId !== requestId || !snapshot.pendingToolCall) return null;
    if (name && snapshot.pendingToolCall.name && snapshot.pendingToolCall.name !== String(name)) return null;
    snapshot.pendingToolCall = null;
    return this._changed(tabId, snapshot);
  }

  finish(tabId, requestId, status, finalContent = '', runId = null, options = {}) {
    const snapshot = this.snapshots.get(tabId);
    if (!snapshot || snapshot.requestId !== requestId) return null;
    snapshot.runId = runId || snapshot.runId || null;
    snapshot.status = status;
    // Classify before onChange clones the terminal snapshot for persistence.
    snapshot.runSucceeded = status === 'completed' && options.allowSuccess !== false
      && (snapshot.successfulDone === true || options.askSucceeded === true);
    snapshot.pendingPlanId = null;
    snapshot.pendingToolCall = null;
    snapshot.finalContent = String(finalContent || '').slice(0, 30000);
    snapshot.responseRetry = null;
    if (status === 'completed' && snapshot.finalContent) snapshot.responseIncomplete = false;
    snapshot.endedAt = Date.now();
    const event = {
      seq: ++snapshot.seq,
      type: 'run_complete',
      data: {
        status: snapshot.status,
        successfulDone: snapshot.successfulDone === true,
        runSucceeded: snapshot.runSucceeded === true,
        finalContent: snapshot.finalContent,
        quota: snapshot.quota || null,
        endedAt: snapshot.endedAt,
        attachmentDeliveryState: snapshot.attachmentDeliveryState || '',
      },
      ts: snapshot.endedAt,
    };
    snapshot.events.push(event);
    while (snapshot.events.length > this.eventLimit) {
      const removed = snapshot.events.shift();
      const removedSeq = Number(removed?.seq || 0);
      snapshot.discardedBeforeSeq = removedSeq || snapshot.discardedBeforeSeq;
      snapshot.truncatedBeforeSeq = snapshot.discardedBeforeSeq;
    }
    return this._changed(tabId, snapshot);
  }

  setAttachmentDeliveryState(tabId, requestId, state) {
    const snapshot = this.snapshots.get(tabId);
    const allowed = new Set(['sending', 'included', 'not-sent', 'unknown']);
    if (!snapshot || snapshot.requestId !== requestId || !allowed.has(state)) return null;
    if (Number(snapshot.attachmentCount || 0) <= 0) return snapshot;
    snapshot.attachmentDeliveryState = state;
    const terminalEvent = [...snapshot.events].reverse().find(event => event?.type === 'run_complete');
    if (terminalEvent?.data && typeof terminalEvent.data === 'object') {
      terminalEvent.data.attachmentDeliveryState = state;
    }
    return this._changed(tabId, snapshot, { attachmentDeliveryState: state });
  }

  restore(tabId, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    snapshot.discardedBeforeSeq = runUiDiscardedBeforeSeq(snapshot);
    // From this point on, keep the legacy field aligned with real eviction
    // only. Acknowledged events are intentionally released, not lost.
    snapshot.truncatedBeforeSeq = snapshot.discardedBeforeSeq;
    if (snapshot.successfulDone !== true) snapshot.successfulDone = false;
    const restoredSuccess = typeof snapshot.runSucceeded === 'boolean'
      ? snapshot.runSucceeded : snapshot.successfulDone === true;
    snapshot.runSucceeded = snapshot.status === 'completed' && restoredSuccess;
    if (snapshot.hadError !== true) snapshot.hadError = false;
    if (typeof snapshot.lastError !== 'string') snapshot.lastError = '';
    if (!snapshot.pendingToolCall || typeof snapshot.pendingToolCall !== 'object') {
      snapshot.pendingToolCall = null;
    }
    if (typeof snapshot.mode !== 'string') snapshot.mode = '';
    if (snapshot.kind !== 'continue' && snapshot.kind !== 'chat') snapshot.kind = 'chat';
    if (snapshot.foreground !== true) snapshot.foreground = false;
    const restoredAttachmentCount = Number(snapshot.attachmentCount || 0);
    snapshot.attachmentCount = Number.isFinite(restoredAttachmentCount)
      ? Math.max(0, restoredAttachmentCount)
      : 0;
    if (!['sending', 'included', 'not-sent', 'unknown'].includes(snapshot.attachmentDeliveryState)) {
      snapshot.attachmentDeliveryState = snapshot.attachmentCount ? 'sending' : '';
    }
    if (typeof snapshot.streamedText !== 'string') snapshot.streamedText = '';
    if (snapshot.streamedText.length > RUN_UI_STREAM_TEXT_LIMIT) {
      snapshot.streamedText = '';
      snapshot.streamedTextTruncated = true;
    } else if (snapshot.streamedTextTruncated !== true) {
      snapshot.streamedTextTruncated = false;
    }
    const restoredStreamStartSeq = Number(snapshot.streamedTextStartSeq || 0);
    const restoredStreamSeq = Number(snapshot.streamedTextSeq || 0);
    snapshot.streamedTextStartSeq = Number.isFinite(restoredStreamStartSeq) ? Math.max(0, restoredStreamStartSeq) : 0;
    snapshot.streamedTextSeq = Number.isFinite(restoredStreamSeq) ? Math.max(0, restoredStreamSeq) : 0;
    const restoredRetrySeq = Number(snapshot.responseRetry?.seq);
    snapshot.responseRetry = snapshot.status === 'running'
      && snapshot.responseRetry?.reason === 'stream_interrupted'
      && Number.isSafeInteger(restoredRetrySeq) && restoredRetrySeq > 0
      && restoredRetrySeq <= Number(snapshot.seq || 0)
      ? { reason: 'stream_interrupted', retainPartial: snapshot.responseRetry.retainPartial === true, seq: restoredRetrySeq }
      : null;
    snapshot.responseIncomplete = snapshot.responseIncomplete === true && !!snapshot.streamedText
      && !(snapshot.status === 'completed' && snapshot.finalContent);
    if (!snapshot.lastPlanResolution || typeof snapshot.lastPlanResolution !== 'object') {
      snapshot.lastPlanResolution = null;
    }
    this.snapshots.set(tabId, snapshot);
    return snapshot;
  }

  acknowledge(tabId, requestId, seq) {
    const snapshot = this.snapshots.get(tabId);
    const numericSeq = Number(seq);
    if (!snapshot || snapshot.requestId !== requestId || !Number.isFinite(numericSeq)) return null;
    snapshot.ackedSeq = Math.max(Number(snapshot.ackedSeq || 0), numericSeq);
    snapshot.events = snapshot.events.filter(event => Number(event?.seq || 0) > snapshot.ackedSeq);
    return this._changed(tabId, snapshot);
  }

  get(tabId) {
    return this.snapshots.get(tabId) || null;
  }

  clear(tabId) {
    this.snapshots.delete(tabId);
  }
}
