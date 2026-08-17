import { searchApocalypseArchives } from './apocalypse-mode.js';

const BUILT_IN_SOURCE = 'skills/wikipedia.md';
const SEARCH_TOOL = 'search_wikipedia';
const SUMMARY_TOOL = 'get_wikipedia_summary';
const LOCAL_RAG_RESULT_LIMIT = 2;
const LOCAL_RAG_SEARCH_LIMIT = 6;
const LOCAL_RAG_EXCERPT_CHARS = 1800;
const LOCAL_RAG_QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'about', 'biography', 'born', 'date', 'did', 'does', 'facts', 'for',
  'founded', 'give', 'had', 'has', 'have', 'history', 'information', 'is', 'it', 'life', 'made',
  'me', 'more', 'of', 'overview', 'tell', 'the', 'was', 'were', 'what', 'when', 'where', 'which',
  'who', 'why', 'how', 'work', 'works',
]);

export function shouldRetrieveLocalWikipedia(value) {
  const text = String(value || '').trim();
  if (text.length < 3 || text.length > 500 || /^\//.test(text) || /```|<\/?(?:html|script|style)\b/i.test(text)) return false;
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  if (/^(?:hi|hello|hey|thanks?|thank you|good (?:morning|afternoon|evening))[!. ]*$/.test(normalized)) return false;
  if (/^(?:and|and then|so|okay|ok|really|go on|continue)[?!. ]*$/.test(normalized)) return false;
  if (/\b(?:today|currently|current|latest|right now|this week|breaking|live score|weather|forecast|stock price|exchange rate)\b/.test(normalized)) return false;
  if (/\b(?:write|rewrite|draft|compose|translate|proofread|summarize this|fix this|make this)\b/.test(normalized)) return false;
  if (/^(?:(?:are|am|do|did|can|could|would|will|have|has)\s+(?:you|i|we)|what\s+are\s+you)\b/.test(normalized)) return false;
  if (/^(?:how|what should|can|could|should)\b.*\b(?:i|me|my|we|us|our)\b/.test(normalized)) return false;
  if (/[?？]\s*$/.test(text)) return true;
  if (/^(?:who|what|when|where|why|how|which|define|explain|describe|tell me (?:more )?about|history of|meaning of|overview of)\b/.test(normalized)) return true;
  const words = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length >= 1 && words.length <= 8
    && !words.some(word => [
      'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'we', 'our', 'ours',
      'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'theirs',
      'it', 'its', 'this', 'that',
    ].includes(word));
}

export function localWikipediaSearchQuery(value, options = {}) {
  const source = String(value || '').trim();
  const fallbackTopic = String(options.fallbackTopic || '').trim();
  const contextualFollowUp = /\b(?:he|him|his|she|her|hers|they|them|their|theirs|it|its|this|that)\b/i.test(source);
  if (contextualFollowUp && fallbackTopic) return fallbackTopic;
  return source
    .replace(/[?？!！.]+$/g, '')
    .replace(/[,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:who|what|when|where|why|how|which)['’]s\s+/i, '')
    .replace(/^(?:tell me (?:more )?about|give me (?:an )?overview of|what is the history of|history of|meaning of|overview of)\s+/i, '')
    .replace(/\s+(?:and\s+)?when\s+(?:was|is)\s+(?:he|she|they|it)\s+born$/i, '')
    .replace(/^(?:who|what|when|where|why|how|which)\s+(?:is|was|are|were|does|did|do|can|could|would|will|has|have|had)\s+/i, '')
    .replace(/^who\s+(?:founded|created|invented|discovered|built|wrote)\s+/i, '')
    .replace(/^(?:define|explain|describe)\s+/i, '')
    .replace(/^(?:a|an|the)\s+/i, '')
    .replace(/\s+(?:made|composed|consists?)\s+of$/i, '')
    .replace(/\s+(?:(?:birth|date|biography|life|facts|information)\s*)+$/i, '')
    .replace(/\s+born$/i, '')
    .replace(/\s+(?:work|mean)$/i, '')
    .trim();
}

function localRagTerms(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(term => term.length >= 2 && !LOCAL_RAG_QUERY_STOP_WORDS.has(term));
}

function differsByAtMostOne(left, right) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let short = left;
  let long = right;
  if (short.length > long.length) [short, long] = [long, short];
  let edits = 0;
  for (let i = 0, j = 0; i < short.length || j < long.length;) {
    if (short[i] === long[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (short.length === long.length) { i += 1; j += 1; }
    else j += 1;
  }
  return true;
}

function localRagTermMatches(left, right) {
  return left === right || (left.length >= 5 && right.length >= 5 && differsByAtMostOne(left, right));
}

export function rankLocalWikipediaRagRecords(records, query, limit = LOCAL_RAG_RESULT_LIMIT) {
  const queryTerms = localRagTerms(query);
  if (!queryTerms.length) return [];
  const ranked = (records || []).map((record, index) => {
    const titleTerms = localRagTerms(record?.title);
    const matchedQueryTerms = queryTerms.filter(queryTerm => titleTerms.some(titleTerm => localRagTermMatches(queryTerm, titleTerm)));
    const matchedTitleTerms = titleTerms.filter(titleTerm => queryTerms.some(queryTerm => localRagTermMatches(queryTerm, titleTerm)));
    const matches = new Set(matchedQueryTerms).size;
    const queryCoverage = matches / queryTerms.length;
    const titleCoverage = titleTerms.length ? new Set(matchedTitleTerms).size / titleTerms.length : 0;
    const relevant = queryTerms.length === 1
      ? matches === 1
      : matches >= 1 && queryCoverage >= 0.5 && titleCoverage >= 0.5;
    const exactTopic = titleTerms.length === queryTerms.length
      && queryTerms.every((queryTerm, termIndex) => localRagTermMatches(queryTerm, titleTerms[termIndex]));
    return {
      record,
      index,
      relevant,
      exactTopic,
      score: matches * 100 + queryCoverage * 50 + titleCoverage * 25 - Math.abs(titleTerms.length - queryTerms.length),
    };
  }).filter(item => item.relevant)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked.some(item => item.exactTopic)
    ? ranked.filter(item => item.exactTopic)
    : ranked;
  return selected
    .slice(0, Math.max(1, Math.min(LOCAL_RAG_RESULT_LIMIT, Number(limit) || LOCAL_RAG_RESULT_LIMIT)))
    .map(item => item.record);
}

export async function retrieveLocalWikipediaResultForStandalone(query, options = {}) {
  if (!shouldRetrieveLocalWikipedia(query)) {
    return { status: 'skipped', records: [], searchQuery: '' };
  }
  const search = options.apocalypseSearch || searchApocalypseArchives;
  const searchQuery = String(options.searchQuery || localWikipediaSearchQuery(query) || query).trim();
  let reportedStatus = '';
  try {
    const records = await search(searchQuery, {
      limit: LOCAL_RAG_SEARCH_LIMIT,
      onSearchStatus(value) {
        const status = typeof value === 'string' ? value : value?.status;
        if (status) reportedStatus = String(status);
      },
    });
    const ranked = rankLocalWikipediaRagRecords(records, searchQuery, LOCAL_RAG_RESULT_LIMIT);
    return {
      status: ranked.length ? 'matched' : (reportedStatus && reportedStatus !== 'matched' ? reportedStatus : 'no_match'),
      records: ranked,
      searchQuery,
    };
  } catch {
    return { status: 'read_error', records: [], searchQuery };
  }
}

export async function retrieveLocalWikipediaForStandalone(query, options = {}) {
  return (await retrieveLocalWikipediaResultForStandalone(query, options)).records;
}

export function formatLocalWikipediaRag(records) {
  return (records || []).slice(0, LOCAL_RAG_RESULT_LIMIT).map(record => ({
    title: String(record?.title || '').slice(0, 300),
    passage: String(record?.excerpt || '').slice(0, LOCAL_RAG_EXCERPT_CHARS),
    url: String(record?.url || '').slice(0, 1000),
    language: String(record?.language || '').slice(0, 30),
    archiveDate: String(record?.archiveDate || '').slice(0, 40),
    archiveTitle: String(record?.archiveTitle || '').slice(0, 300),
    source: String(record?.source || 'Wikipedia').slice(0, 300),
  })).filter(record => record.title && record.passage);
}

function isBuiltInWikipediaProvenance(value, idField = 'id') {
  return value?.[idField] === 'wikipedia'
    && value?.sourceType === 'built-in'
    && value?.sourceUrl === BUILT_IN_SOURCE;
}

function isBuiltInWikipediaTool(tool) {
  return isBuiltInWikipediaProvenance(tool, 'skillId')
    && (tool?.name === SEARCH_TOOL || tool?.name === SUMMARY_TOOL);
}

export function hasBuiltInWikipediaSkill(skills) {
  return (skills || []).some(skill => isBuiltInWikipediaProvenance(skill));
}

function offlineResult(tool, records, originalError) {
  if (!records.length) return {
    success: false,
    provider: 'local Kiwix/ZIM archive',
    skillTool: tool.name,
    skillName: tool.skillName || 'Wikipedia',
    offline: true,
    error: `${originalError || 'Wikipedia is unavailable.'} No matching installed Apocalypse Mode archive entry was found.`,
  };
  const license = 'Offline archive content remains subject to its embedded license; canonical article URLs provide attribution.';
  if (tool.name === SEARCH_TOOL) {
    return {
      success: true,
      status: 200,
      provider: 'local Kiwix/ZIM archive',
      skillTool: tool.name,
      skillName: tool.skillName || 'Wikipedia',
      offline: true,
      resultPolicy: 'untrusted',
      license,
      data: { pages: records },
    };
  }
  const record = records[0];
  return {
    success: true,
    status: 200,
    provider: 'local Kiwix/ZIM archive',
    skillTool: tool.name,
    skillName: tool.skillName || 'Wikipedia',
    offline: true,
    resultPolicy: 'untrusted',
    license,
    data: {
      query: {
        pages: {
          [record.title]: {
            pageid: null,
            title: record.title,
            extract: record.excerpt,
            fullurl: record.url,
            canonicalurl: record.url,
            language: record.language,
            archiveDate: record.archiveDate,
            source: record.source,
            license: record.license,
          },
        },
      },
    },
  };
}

export async function executeWikipediaSkillTool(tool, args = {}, options = {}) {
  const executeOnline = options.executeOnline;
  if (typeof executeOnline !== 'function') return { success: false, error: 'Wikipedia online executor is unavailable.' };
  if (!isBuiltInWikipediaTool(tool)) return await executeOnline(tool, args, options);
  let online;
  if (options.online !== false && globalThis.navigator?.onLine !== false) {
    online = await executeOnline(tool, args, options);
    if (online?.success) return online;
  }
  const query = tool.name === SEARCH_TOOL ? args.q : args.titles;
  const limit = tool.name === SEARCH_TOOL ? args.limit : 1;
  const search = options.apocalypseSearch || searchApocalypseArchives;
  let records;
  try {
    records = await search(query, { limit });
  } catch (error) {
    return {
      success: false,
      provider: 'local Kiwix/ZIM archive',
      skillTool: tool.name,
      skillName: tool.skillName || 'Wikipedia',
      offline: true,
      error: `${online?.error ? `${online.error} ` : ''}${error?.message || String(error)}`.trim(),
    };
  }
  return offlineResult(tool, records, online?.error);
}
