import {
  normalizeSavedWorkflowName,
  normalizeTeacherCaptureAction,
  workflowUrlScope,
} from './workflows.js';

export const TEACHER_SESSION_PREFIX = 'teacherSession:';
export const TEACHER_ACTION_LIMIT = 100;

function sessionKey(tabId) {
  const id = Number(tabId);
  return Number.isFinite(id) ? `${TEACHER_SESSION_PREFIX}${id}` : '';
}

function normalizedScope(value) {
  const origin = String(value?.origin || '');
  const pathFamily = String(value?.pathFamily || '/');
  const scope = workflowUrlScope(`${origin}${pathFamily}`);
  return scope?.origin === origin ? scope : null;
}

function normalizedSession(value, tabId) {
  const key = sessionKey(tabId);
  const name = normalizeSavedWorkflowName(value?.name);
  const start = normalizedScope(value?.start);
  const currentScope = normalizedScope(value?.currentScope) || start;
  if (!key || value?.active !== true || !name || !start) return null;
  const actions = [];
  for (const raw of Array.isArray(value?.actions) ? value.actions : []) {
    const action = normalizeTeacherCaptureAction(raw);
    if (action) actions.push(action);
    if (actions.length >= TEACHER_ACTION_LIMIT) break;
  }
  return {
    version: 1,
    active: true,
    tabId: Number(tabId),
    name,
    start,
    currentScope,
    webbrainVersion: String(value.webbrainVersion || '').slice(0, 40),
    startedAt: Math.max(1, Number(value.startedAt) || Date.now()),
    updatedAt: Math.max(1, Number(value.updatedAt) || Date.now()),
    actions,
    lastActionAt: Math.max(0, Number(value.lastActionAt) || 0),
    lastActionKind: String(value.lastActionKind || ''),
    lastActionFingerprint: String(value.lastActionFingerprint || '').slice(0, 2000),
    skippedActionCount: Math.max(0, Math.floor(Number(value.skippedActionCount) || 0)),
    actionLimitReached: value.actionLimitReached === true,
  };
}

export function createTeacherSessionStore(storageArea, options = {}) {
  const now = options.now || Date.now;
  const read = async (tabId) => {
    const key = sessionKey(tabId);
    if (!key) return null;
    const stored = await storageArea.get(key);
    return normalizedSession(stored?.[key], tabId);
  };
  const write = async (session) => {
    const normalized = normalizedSession(session, session?.tabId);
    if (!normalized) throw new Error('Invalid teacher session.');
    normalized.updatedAt = now();
    await storageArea.set({ [sessionKey(normalized.tabId)]: normalized });
    return normalized;
  };

  const record = async (tabId, input) => {
    const session = await read(tabId);
    if (!session) return { changed: false, reason: 'no_active_session', session: null };
    const action = normalizeTeacherCaptureAction(input);
    if (!action) {
      const reason = ['click', 'field', 'checked'].includes(String(input?.kind || ''))
        ? 'unsafe_target'
        : 'invalid_action';
      session.skippedActionCount += 1;
      return { changed: false, reason, session: await write(session) };
    }
    if (session.actions.length >= TEACHER_ACTION_LIMIT) {
      if (!session.actionLimitReached) {
        session.actionLimitReached = true;
        await write(session);
      }
      return { changed: false, reason: 'action_limit', session };
    }
    const ts = now();
    const fingerprint = JSON.stringify(action);
    if (fingerprint === session.lastActionFingerprint && ts - session.lastActionAt < 200) {
      return { changed: false, reason: 'duplicate', session };
    }
    session.actions.push(action);
    session.currentScope = action.kind === 'navigate'
      ? workflowUrlScope(action.url) || session.currentScope
      : action.scope;
    session.lastActionAt = ts;
    session.lastActionKind = action.kind;
    session.lastActionFingerprint = fingerprint;
    return { changed: true, reason: '', session: await write(session) };
  };

  return {
    async get(tabId) { return read(tabId); },
    async start(tabId, input = {}) {
      const activeSession = await read(tabId);
      if (activeSession) return { changed: false, reason: 'already_active', session: activeSession };
      const name = normalizeSavedWorkflowName(input.name);
      if (!name) return { changed: false, reason: 'name_required', session: null };
      const start = workflowUrlScope(input.url);
      if (!start) return { changed: false, reason: 'http_start_url_required', session: null };
      const ts = now();
      const session = await write({
        version: 1,
        active: true,
        tabId: Number(tabId),
        name,
        start,
        currentScope: start,
        webbrainVersion: input.webbrainVersion,
        startedAt: ts,
        updatedAt: ts,
        actions: [],
      });
      return { changed: true, reason: '', session };
    },
    record,
    async navigation(tabId, url, options = {}) {
      const session = await read(tabId);
      if (!session) return { changed: false, reason: 'no_active_session', session: null };
      const destination = workflowUrlScope(url);
      if (!destination) return { changed: false, reason: 'invalid_action', session };
      const previous = session.currentScope || session.start;
      const sameScope = previous.origin === destination.origin
        && previous.pathFamily === destination.pathFamily;
      const recentClick = options.force !== true
        && session.lastActionKind === 'click'
        && now() - session.lastActionAt < 2000;
      session.currentScope = destination;
      if (sameScope || recentClick) return { changed: true, reason: '', session: await write(session) };
      return record(tabId, { kind: 'navigate', scope: previous, url });
    },
    async clear(tabId) {
      const key = sessionKey(tabId);
      const session = await read(tabId);
      if (!key || !session) return { changed: false, reason: 'no_active_session', session: null };
      await storageArea.remove(key);
      return { changed: true, reason: '', session };
    },
  };
}
