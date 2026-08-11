const COMPLETE_THREAD_ACTIONS = new Set(['summarize-thread', 'find-followups']);
const READ_SCOPES = new Set(['complete_thread', 'current_message', 'visible_page', 'none']);
export const STANDARD_TREE_PAGE_CHARS = 6000;
export const EXPANDED_TREE_PAGE_CHARS = 12000;
export const STANDARD_TOOL_RESULT_CHARS = 8000;
export const EXPANDED_TOOL_RESULT_CHARS = 16000;
export const EXPANDED_READ_CONTEXT_TOKENS = 65536;
const EMAIL_ADAPTERS = new Set(['gmail', 'yahoo-mail', 'proton-mail', 'fastmail', 'zoho-mail', 'yandex-mail', 'outlook']);
const EMAIL_HOST_RE = /(^|\.)(mail\.google\.com|gmail\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|icloud\.com|proton\.me|protonmail\.com|fastmail\.com|hey\.com|mail\.zoho\.com|mail\.yandex\.[a-z.]+)$/i;
const DM_HOST_RE = /(^|\.)(instagram\.com|x\.com|twitter\.com|facebook\.com|messenger\.com|threads\.net|reddit\.com|linkedin\.com|discord\.com|slack\.com|web\.whatsapp\.com|messages\.google\.com|web\.telegram\.org)$/i;

export function normalizeReadScope(value) {
  const scope = String(value || '').trim();
  return READ_SCOPES.has(scope) ? scope : null;
}

export function readWindowLimits(promptTier = 'full', contextWindow = 0) {
  const tokens = Number(contextWindow);
  const expanded = promptTier !== 'compact'
    && Number.isFinite(tokens)
    && tokens >= EXPANDED_READ_CONTEXT_TOKENS;
  return {
    expanded,
    treePageChars: expanded ? EXPANDED_TREE_PAGE_CHARS : STANDARD_TREE_PAGE_CHARS,
    toolResultChars: expanded ? EXPANDED_TOOL_RESULT_CHARS : STANDARD_TOOL_RESULT_CHARS,
  };
}

export function isCommunicationThreadContext(url = '', adapterName = '') {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return false;
  }

  const host = parsed.hostname.replace(/^www\./i, '');
  const route = `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`;
  const adapter = String(adapterName || '').trim().toLowerCase();
  if (EMAIL_HOST_RE.test(host) || EMAIL_ADAPTERS.has(adapter)) {
    if (/(?:^|\.)google\.com$/i.test(host) || host === 'gmail.com') {
      const hashSegments = parsed.hash.replace(/^#/, '').split('/').filter(Boolean);
      return hashSegments.length >= 2;
    }
    return /(?:^|[/?#])(?:messages?|message|thread|conversation|id|p)(?:[/?#])[^/?#\s]+/i.test(route)
      || /(?:^|[/?#])(?:inbox|sent|all|archive|folders?|labels?)(?:[/?#])[^/?#\s]+/i.test(route);
  }

  if (!DM_HOST_RE.test(host)) return false;
  return /(?:^|[/?#])(?:client|channels)(?:[/?#][^/?#\s]+){2,}/i.test(route)
    || /(?:^|[/?#])(?:direct|messaging)(?:[/?#][^/?#\s]+){2,}/i.test(route)
    || /(?:^|[/?#])(?:messages?|chat|chats|dm|conversation|conversations|t)(?:[/?#])[^/?#\s]+/i.test(route);
}

export function requiresCompleteThreadRead(_userMessage, runOptions = {}) {
  const recommendedId = String(runOptions?.recommendedAction?.id || '').trim();
  return COMPLETE_THREAD_ACTIONS.has(recommendedId);
}

export function plannerRequiresCompleteThreadRead(plan = null) {
  return plan?.request_kind === 'execute'
    && normalizeReadScope(plan.read_scope) === 'complete_thread';
}

export function createReadCompletenessState(runToken = '', required = false, communicationThread = false, adapterName = '') {
  const adapter = String(adapterName || '').trim().toLowerCase();
  return {
    runToken: String(runToken || ''),
    communicationThread: communicationThread === true,
    adapterName: adapter,
    required: required === true,
    sawEligibleRead: false,
    complete: required !== true,
    treeCoverageComplete: required !== true,
    requiresExpansionEvidence: adapter === 'gmail',
    expansionConfirmed: false,
    treeKey: '',
    treePages: [],
    treeTerminalPage: null,
    pendingTool: '',
    continuationArgs: null,
  };
}

export function requirePlannerReadCompleteness(state, plan = null) {
  const current = state || createReadCompletenessState();
  if (!current.communicationThread || current.required || !plannerRequiresCompleteThreadRead(plan)) return current;
  return {
    ...current,
    required: true,
    complete: false,
    sawEligibleRead: false,
    treeCoverageComplete: false,
    expansionConfirmed: false,
    treeKey: '',
    treePages: [],
    treeTerminalPage: null,
    pendingTool: '',
    continuationArgs: null,
  };
}

function accessibilityTreeState(state, args, result) {
  const filter = String(args?.filter || 'all');
  const maxDepth = args?.maxDepth == null ? 15 : Number(args.maxDepth);
  if (filter !== 'all' || args?.ref_id || !Number.isFinite(maxDepth) || maxDepth < 15 || result?.error || typeof result?.pageContent !== 'string') return state;

  const rawPage = Number(result.page ?? args?.page ?? 1);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;
  const totalChars = result.totalChars == null ? Number.NaN : Number(result.totalChars);
  const treeKey = Number.isFinite(totalChars)
    ? `${totalChars}|${maxDepth}|${Number(args?.maxChars) || 6000}`
    : '';
  const resetPages = treeKey && state.treeKey && treeKey !== state.treeKey;
  const pages = new Set(resetPages ? [] : state.treePages);
  pages.add(page);

  const paged = result.hasMore === true
    || result.truncated === true
    || result.page != null
    || args?.page != null;
  let terminalPage = resetPages ? null : state.treeTerminalPage;
  if (paged && result.hasMore !== true && result.truncated !== true) terminalPage = page;
  const pagesComplete = Number.isInteger(terminalPage)
    && terminalPage >= 1
    && Array.from({ length: terminalPage }, (_, index) => index + 1).every(item => pages.has(item));
  const treeCoverageComplete = !paged || pagesComplete;
  let expansionConfirmed = resetPages ? false : state.expansionConfirmed === true;
  if (result.conversationExpansionState === 'expanded') expansionConfirmed = true;
  if (result.conversationExpansionState === 'collapsed') expansionConfirmed = false;
  const complete = treeCoverageComplete
    && (state.requiresExpansionEvidence !== true || expansionConfirmed);
  const nextPage = result.nextPage == null ? Number.NaN : Number(result.nextPage);
  const fallbackContinuation = result.hasMore === true && Number.isFinite(nextPage)
    ? {
        filter: 'all',
        maxDepth,
        ...(Number.isFinite(Number(args?.maxChars)) ? { maxChars: Number(args.maxChars) } : {}),
        page: Math.trunc(nextPage),
      }
    : null;

  return {
    ...state,
    sawEligibleRead: true,
    complete: state.complete || complete,
    treeCoverageComplete,
    expansionConfirmed,
    treeKey: treeKey || state.treeKey,
    treePages: [...pages].sort((a, b) => a - b),
    treeTerminalPage: terminalPage,
    pendingTool: complete ? '' : 'get_accessibility_tree',
    continuationArgs: complete ? null : (result.continuationArgs || fallbackContinuation),
  };
}

export function recordReadCompleteness(state, toolName, args = {}, result = null) {
  const current = state || createReadCompletenessState();
  if (!current.required || current.complete) return current;
  if (toolName === 'get_accessibility_tree') return accessibilityTreeState(current, args, result);
  return current;
}

export function readCompletenessLimitation(state, mode = 'ask') {
  if (
    mode !== 'ask'
    || !state?.required
    || state.complete
    || state.requiresExpansionEvidence !== true
    || state.treeCoverageComplete !== true
    || state.expansionConfirmed === true
  ) return null;
  return 'I could not verify the complete Gmail conversation because one or more messages may still be collapsed, and Ask mode cannot expand them. Expand all messages in Gmail and retry, or switch to Act mode so WebBrain can expand the conversation before reading it.';
}

export function readCompletenessBlock(state, treePageChars = STANDARD_TREE_PAGE_CHARS, options = {}) {
  if (!state?.required || state.complete) return null;
  const requestedTreePageChars = Number(treePageChars) === EXPANDED_TREE_PAGE_CHARS
    ? EXPANDED_TREE_PAGE_CHARS
    : STANDARD_TREE_PAGE_CHARS;
  const expansionRequired = state.requiresExpansionEvidence === true
    && state.treeCoverageComplete === true
    && state.expansionConfirmed !== true;
  const continuation = expansionRequired
    ? options.mode === 'ask'
      ? ' The root tree is fully paged, but Gmail conversation expansion is not verified. Ask mode cannot expand messages. Report that limitation without claiming complete coverage.'
      : ' The root tree is fully paged, but Gmail conversation expansion is not verified. Activate Gmail\'s top-level Expand all control, then perform a fresh full-depth root accessibility-tree read and verify that the tree exposes Collapse all before answering.'
    : state.pendingTool && state.continuationArgs
    ? ` Call ${state.pendingTool}(${JSON.stringify(state.continuationArgs)}) exactly, then repeat with each returned continuationArgs while hasMore or truncated is true.`
    : state.sawEligibleRead
      ? ' Continue the full-depth accessibility-tree read from its first missing page and preserve the returned pagination arguments.'
      : ` First call get_accessibility_tree({"filter":"all","maxDepth":15,"maxChars":${requestedTreePageChars}}) from the document root.`;
  return `[COMPLETE THREAD READ REQUIRED: The user explicitly asked for the whole conversation, but the available read coverage is incomplete. Do not answer, summarize, recommend a follow-up, or claim that you reviewed the thread yet.${continuation} Answer only after a terminal result confirms there is no unread remainder.]`;
}
