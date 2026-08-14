import { searchApocalypseArchives } from './apocalypse-mode.js';

const BUILT_IN_SOURCE = 'skills/wikipedia.md';
const SEARCH_TOOL = 'search_wikipedia';
const SUMMARY_TOOL = 'get_wikipedia_summary';

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
