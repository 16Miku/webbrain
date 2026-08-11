const COMPLETE_THREAD_ACTIONS = new Set(['summarize-thread', 'find-followups']);
const EMAIL_ADAPTERS = new Set(['gmail', 'yahoo-mail', 'proton-mail', 'fastmail', 'zoho-mail', 'yandex-mail', 'outlook']);
const EMAIL_HOST_RE = /(^|\.)(mail\.google\.com|gmail\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|icloud\.com|proton\.me|protonmail\.com|fastmail\.com|hey\.com|mail\.zoho\.com|mail\.yandex\.[a-z.]+)$/i;
const DM_HOST_RE = /(^|\.)(instagram\.com|x\.com|twitter\.com|facebook\.com|messenger\.com|threads\.net|reddit\.com|linkedin\.com|discord\.com|slack\.com|web\.whatsapp\.com|messages\.google\.com|web\.telegram\.org)$/i;

function messageText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
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

export function requiresCompleteThreadRead(userMessage, runOptions = {}, context = {}) {
  const recommendedId = String(runOptions?.recommendedAction?.id || '').trim();
  if (COMPLETE_THREAD_ACTIONS.has(recommendedId)) return true;
  if (context?.communicationThread !== true) return false;

  const text = messageText(userMessage).replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return /\b(?:whole|entire|complete|full)\s+(?:email\s+|message\s+)?(?:thread|conversation|chain)\b/i.test(text)
    || /\b(?:summari[sz](?:e|ing)|summary|recap|analy[sz](?:e|ing))\b[^.!?\n]{0,80}\b(?:thread|conversation|email\s+chain)\b/i.test(text)
    || /\b(?:follow[- ]?ups?|action\s+items?|open\s+questions?)\b[^.!?\n]{0,80}\b(?:thread|conversation|email\s+chain)\b/i.test(text)
    || /\b(?:thread|conversation|email\s+chain)\b[^.!?\n]{0,50}\b(?:in\s+its\s+entirety|completely|fully|from\s+(?:the\s+)?(?:start|beginning)\s+to\s+(?:the\s+)?end|oldest\s+to\s+newest)\b/i.test(text)
    || /\b(?:read|review(?:ed)?|inspect(?:ed)?|check(?:ed)?|look(?:ed)?\s+at)\b[^.!?\n]{0,80}\b(?:it|this|the\s+(?:thread|conversation|chain))\b[^.!?\n]{0,35}\ball\b/i.test(text);
}

export function createReadCompletenessState(runToken = '', required = false) {
  return {
    runToken: String(runToken || ''),
    required: required === true,
    sawEligibleRead: false,
    complete: required !== true,
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
  const complete = !paged || pagesComplete;
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

export function readCompletenessBlock(state) {
  if (!state?.required || state.complete) return null;
  const continuation = state.pendingTool && state.continuationArgs
    ? ` Call ${state.pendingTool}(${JSON.stringify(state.continuationArgs)}) exactly, then repeat with each returned continuationArgs while hasMore or truncated is true.`
    : state.sawEligibleRead
      ? ' Continue the full-depth accessibility-tree read from its first missing page and preserve the returned pagination arguments.'
      : ' First call get_accessibility_tree({"filter":"all","maxDepth":15}) from the document root.';
  return `[COMPLETE THREAD READ REQUIRED: The user explicitly asked for the whole conversation, but the available read coverage is incomplete. Do not answer, summarize, recommend a follow-up, or claim that you reviewed the thread yet.${continuation} Answer only after a terminal result confirms there is no unread remainder.]`;
}
