import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CMS_FIXTURES, CMS_ADAPTER_ROUTE_CASES } from './fixtures/cms-api-first.mjs';
import { buildScenarioPayload } from './llm/lib/scenario-payload.mjs';
import { scoreVerdict } from './llm/lib/score.mjs';

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const ids = CMS_FIXTURES.map(f => `cms-${f.cms}`);
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
let tabUrl = 'https://cms.example.test/admin';
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: p => `chrome-extension://fixture/${p}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: tabUrl, title: 'Content editor' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
const variants = await Promise.all(['chrome', 'firefox'].map(async browser => ({
  browser,
  skills: await import(`../src/${browser}/src/agent/skills.js`),
  tools: await import(`../src/${browser}/src/agent/tools.js`),
  adapters: await import(`../src/${browser}/src/agent/adapters.js`),
  Agent: (await import(`../src/${browser}/src/agent/agent.js`)).Agent,
  fetchUrl: (await import(`../src/${browser}/src/network/network-tools.js`)).fetchUrl,
})));

function records(v) {
  return v.skills.DEFAULT_SKILL_SOURCES.map(s => ({
    id: s.id, name: s.name, sourceUrl: s.path, sourceType: 'built-in',
    content: read(`src/${v.browser}/${s.path}`), createdAt: 0,
  }));
}

// Run the actual background hydration functions, isolating extension startup
// side effects. This catches storage migration bugs that catalog tests cannot.
function hydration(v, initial) {
  const stored = structuredClone(initial);
  const writes = [];
  let installed;
  const local = {
    get: async () => structuredClone(stored),
    set: async update => { writes.push(update); Object.assign(stored, structuredClone(update)); },
  };
  const extension = { ...api, storage: { local } };
  const source = read(`src/${v.browser}/src/background.js`);
  const start = source.indexOf('async function loadPackagedSkillRecords(');
  const end = source.indexOf('const customSkillsReady = loadCustomSkills();', start);
  assert.ok(start >= 0 && end > start);
  const dependencies = { ...v.skills, chrome: extension, browser: extension,
    agent: { setCustomSkills: skills => { installed = skills; } },
    fetch: async url => ({ ok: true, text: async () => read(`src/${v.browser}/${url.split('://fixture/')[1]}`) }),
  };
  const load = Function(...Object.keys(dependencies), `${source.slice(start, end)}; return loadCustomSkills;`)(...Object.values(dependencies));
  const settings = read(`src/${v.browser}/src/ui/settings.js`);
  const saveStart = settings.indexOf('async function saveCustomSkills(');
  const saveEnd = settings.indexOf('\nfunction renderPackagedSkills()', saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  const settingsDependencies = { ...v.skills, chrome: extension, browser: extension,
    DEFAULT_SKILL_IDS: new Set(v.skills.DEFAULT_SKILL_SOURCES.map(s => s.id)),
    renderSkills() {},
  };
  const save = Function(...Object.keys(settingsDependencies), `let customSkills; ${settings.slice(saveStart, saveEnd)}; return saveCustomSkills;`)(...Object.values(settingsDependencies));
  return { load, save, stored, writes, installed: () => installed };
}

async function dispatch(v, { allowed = false, persistent = false, ask = false } = {}, args = {}) {
  const agent = new v.Agent({ getVisionProvider: async () => null });
  agent._ensureGateSetting = async () => {};
  agent._skipPermissionGate = true; // isolate the API/mode gate, not CMS auth
  agent.setAlwaysAllowApiMutations(persistent);
  if (allowed) agent.setApiMutationsAllowed(11, true);
  let calls = 0;
  agent.executeTool = async (_tab, _name, passed) => {
    calls++;
    return v.fetchUrl(passed.url, passed, { tabId: 11 });
  };
  const messages = [];
  await agent._executeToolBatch(11, [{
    id: 'cms_call', function: { name: 'fetch_url', arguments: JSON.stringify(args) },
  }], messages, () => {}, { supportsVision: false }, '', new Set(['fetch_url']), 1,
  { apiMutationsDenied: ask });
  return { calls, messages, agent };
}

test('nine instruction-only CMS files are byte-identical in both packages', () => {
  for (const id of ids) {
    assert.equal(read(`src/chrome/skills/${id}.md`), read(`src/firefox/skills/${id}.md`));
  }
  assert.equal(read('src/chrome/src/agent/cms-adapters.js'), read('src/firefox/src/agent/cms-adapters.js'));
});

// Validate replay inputs and scoring only. No LLM is called by this test.
for (let n = 201; n <= 208; n++) {
  test(`CMS replay ${n}: real package loading, valid next-tool schema and safe rubric`, () => {
    const scenario = JSON.parse(read(`test/llm/scenarios/cms/${n}.json`));
    const originalSeed = structuredClone(scenario.seed);
    for (const browser of ['chrome', 'firefox']) {
      for (const tier of ['mid', 'full', 'compact']) {
        const payload = buildScenarioPayload({ ...scenario, browser }, { tier, strictSecretMode: n === 204 });
        assert.equal(payload.tools.some(t => t.function.name === 'load_skill'), tier !== 'compact');
        assert.equal(payload.messages[0].content.includes('<skill '), tier !== 'compact');
        const ideal = scenario.expected.idealNextToolCall;
        const tool = payload.tools.find(t => t.function.name === ideal.name);
        assert.ok(tool, `${browser}/${tier}: unknown ideal tool ${ideal.name}`);
        for (const arg of Object.keys(ideal.args)) {
          assert.ok(arg in tool.function.parameters.properties, `${ideal.name}: unknown argument ${arg}`);
        }
        const score = scoreVerdict({ firstToolCall: ideal, expected: scenario.expected });
        assert.equal(score.verdict, 'ideal');
        assert.ok(scenario.expected.antiPatterns.length && scenario.expected.successRubric.length > 80);
      }
    }
    assert.deepEqual(scenario.seed, originalSeed);
  });
}

for (const v of variants) {
  const { browser, skills } = v;
  test(`${browser}: Sanity publish example keeps HTTP identity and document revision guards`, () => {
    // Contract: https://www.sanity.io/docs/http-reference/actions#documentpublishaction
    // Sanity's PublishAction retains ifDraftRevisionId; ifVersionRevisionId
    // belongs to PublishVariantAction, a different operation.
    const recipe = read(`src/${browser}/skills/cms-sanity.md`);
    const examples = [...recipe.matchAll(/```json\s+([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));
    const publishes = examples.flatMap(example => example.actions || [])
      .filter(action => action.actionType === 'sanity.action.document.publish');
    assert.equal(publishes.length, 1, 'validate the actual packaged publish example');
    const publish = publishes[0];
    assert.equal(publish.versionId, `drafts.${publish.publishedId}`, 'publish the same draft/published pair');
    assert.equal(publish.ifDraftRevisionId, '<DRAFT_REV>', 'keep the draft optimistic lock');
    assert.equal(publish.ifPublishedRevisionId, '<PUBLISHED_REV>', 'keep the existing-publication optimistic lock');
    assert.equal('draftId' in publish, false, 'use the current HTTP identity field');
    assert.equal('ifVersionRevisionId' in publish, false, 'do not mix variant and document action guards');
  });

  test(`${browser}: default catalog exposes all nine; only selected recipe loads in Mid/Full`, () => {
    const all = records(v);
    assert.ok(all.length <= skills.MAX_CUSTOM_SKILLS);
    for (const tier of ['mid', 'full']) {
      for (const mode of ['ask', 'act', 'dev']) {
        const catalog = skills.getEligibleSkillCatalog(all, { tier, mode });
        for (const id of ids) assert.ok(catalog.some(s => s.id === id), `${tier}/${mode}/${id}`);
        assert.equal(skills.buildCustomSkillsPrompt(all, { tier, mode }), '');
        for (const id of ids) {
          const loaded = skills.buildCustomSkillsPrompt(all, { tier, mode, activeSkillIds: [id] });
          assert.equal((loaded.match(/<skill /g) || []).length, 1);
          assert.ok(loaded.length <= 12000, `${id}: loaded recipe exceeds CMS prompt budget`);
          assert.ok(loaded.includes(`skills/${id}.md`));
          assert.equal(loaded.includes('<SERIALIZED_VALID_LEXICAL_JSON>'), id === 'cms-ghost');
        }
      }
    }
    const normalized = skills.normalizeCustomSkills(all).filter(s => ids.includes(s.id));
    assert.ok(normalized.every(s => s.content.length < skills.MAX_CUSTOM_SKILL_CHARS));
    assert.ok(normalized.every(s => s.tools.length === 0 && s.summary.length <= 200));
    const loader = skills.buildSkillLoaderDefinition(all, { mode: 'act', tier: 'full' });
    for (const id of ids) assert.ok(loader.function.parameters.properties.skill_id.enum.includes(id));
    const cmsCatalog = skills.buildSkillLoaderDefinition(all.filter(s => ids.includes(s.id)), { mode: 'act', tier: 'full' });
    assert.ok(cmsCatalog.function.description.length <= 2000, 'CMS catalog exceeds summary budget');
  });

  test(`${browser}: runtime load_skill activation keeps unrelated recipes out`, async () => {
    for (const tier of ['mid', 'full']) {
      const agent = new v.Agent({ getVisionProvider: async () => null, getActive: () => ({ promptTier: tier }) });
      agent.setCustomSkills(records(v));
      assert.equal(agent._resolvePromptTier(), tier);
      const result = await agent.executeTool(18, 'load_skill', { skill_id: 'cms-contentful' });
      assert.equal(result.success, true);
      assert.ok(agent.activeSkillIds.get(18).has('cms-contentful'));
      for (const id of ids.filter(x => x !== 'cms-contentful')) assert.equal(agent.activeSkillIds.get(18).has(id), false);
      agent._resetActiveSkillsForRun(18, { refreshPrompt: false });
      assert.equal(agent.activeSkillIds.has(18), false, 'the next run must not retain the CMS recipe');
      assert.equal(skills.buildCustomSkillsPrompt(records(v), { tier, activeSkillIds: agent.activeSkillIds.get(18) }), '');
    }
  });

  test(`${browser}: Compact keeps no skill surface; observed CMS routes receive bounded guidance`, () => {
    const all = records(v);
    assert.equal(skills.buildSkillLoaderDefinition(all, { mode: 'act', tier: 'compact' }), null);
    assert.deepEqual(skills.getEligibleSkillCatalog(all, { tier: 'compact' }), []);
    assert.equal(skills.buildCustomSkillsPrompt(all, { tier: 'compact', activeSkillIds: ids }), '');
    assert.equal(v.tools.getToolsForMode('act', { tier: 'compact' }).some(t => t.function.name === 'load_skill'), false);
    for (const f of CMS_FIXTURES) {
      const adapter = v.adapters.getActiveAdapter(f.tab);
      // A custom Studio URL alone cannot identify Sanity. Its enabled skill
      // remains loadable after the model observes the CMS and task context.
      if (f.cms === 'sanity') {
        assert.equal(adapter, null);
        continue;
      }
      assert.equal(adapter?.name, `cms-${f.cms}`, `${f.cms}: missing adapter`);
      assert.ok(adapter.notes.includes('fetch_url'));
      assert.doesNotMatch(adapter.notes, /load_skill/);
      assert.ok(adapter.notes.length <= 1300);
    }
    for (const url of ['https://news.example.test/article/ghost', 'https://shopify.com.evil.test/', 'https://wix.com.evil.test/', 'file:///ghost/']) {
      assert.ok(!v.adapters.getActiveAdapter(url)?.name.startsWith('cms-'), url);
    }
  });

  test(`${browser}: CMS routing excludes generic admin and Webflow marketing pages`, () => {
    for (const { url, adapter } of CMS_ADAPTER_ROUTE_CASES) {
      assert.equal(v.adapters.getActiveAdapter(url)?.name ?? null, adapter, url);
    }
  });

  test(`${browser}: startup introduces new defaults but Settings removal survives restart and refresh`, async () => {
    const original = records(v).filter(s => !ids.includes(s.id));
    const h = hydration(v, { customSkills: original, defaultSkillsSeeded: true });
    await h.load();
    assert.deepEqual(h.installed().filter(s => ids.includes(s.id)).map(s => s.id), ids);
    const removed = h.installed().find(s => s.id === 'cms-ghost');
    await h.save(h.installed().filter(s => s.id !== removed.id), { removedSkill: removed });
    assert.ok(h.stored.defaultSkillsRemoved.includes('cms-ghost'));
    await h.load();
    await h.load();
    assert.equal(h.installed().some(s => s.id === 'cms-ghost'), false);
    assert.equal(h.installed().filter(s => ids.includes(s.id)).length, 8);
    // Explicit enable is the sole way the removed default comes back.
    await h.save([...h.installed(), removed], { installedSkill: removed });
    await h.load();
    assert.equal(h.installed().some(s => s.id === 'cms-ghost'), true);
  });

  test(`${browser}: empty removed catalog is not resurrected; full user storage is not evicted`, async () => {
    const removed = skills.DEFAULT_SKILL_SOURCES.map(s => s.id);
    const h = hydration(v, { customSkills: [], defaultSkillsSeeded: true, defaultSkillsRemoved: removed });
    await h.load();
    assert.deepEqual(h.installed(), []);
    const userSkills = Array.from({ length: skills.MAX_CUSTOM_SKILLS }, (_, n) => ({ id: `user-${n}`, content: `# User ${n}\nKeep me` }));
    const full = hydration(v, { customSkills: userSkills, defaultSkillsSeeded: true });
    await full.load();
    assert.deepEqual(full.installed().map(s => s.id), userSkills.map(s => s.id));
  });

  for (const [label, options, expected] of [
    ['permission off', {}, false],
    ['prior conversation grant', { allowed: true }, true],
    ['persistent grant', { persistent: true }, true],
    ['Ask overrides conversation grant', { allowed: true, ask: true }, false],
    ['Ask overrides persistent grant', { persistent: true, ask: true }, false],
  ]) {
    test(`${browser}: ${label} applies to every CMS write and GraphQL query POST`, async () => {
      const prior = globalThis.fetch;
      let networkCalls = 0;
      globalThis.fetch = async () => { networkCalls++; return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); };
      try {
        for (const f of CMS_FIXTURES) {
          tabUrl = f.tab;
          const args = { url: f.url, method: f.method, headers: f.headers, body: JSON.stringify(f.request) };
          const result = await dispatch(v, options, args);
          assert.equal(result.calls, expected ? 1 : 0, f.cms);
          if (!expected) {
            const denied = JSON.parse(result.messages[0].content);
            assert.equal(denied.denied, true);
            assert.equal(denied.requiresApiAllow, !options.ask);
          }
        }
        const shop = CMS_FIXTURES.find(f => f.cms === 'shopify');
        const query = await dispatch(v, options, { url: shop.url, method: 'POST', body: JSON.stringify(shop.readRequest) });
        assert.equal(query.calls, expected ? 1 : 0);
        assert.equal(networkCalls, expected ? 10 : 0);
      } finally { globalThis.fetch = prior; }
    });
  }

  for (const f of CMS_FIXTURES) {
    test(`${browser}/${f.cms}: scripted existing-draft read/update/read preserves identity and non-title data through fetch_url`, async () => {
      const prior = globalThis.fetch;
      tabUrl = f.tab;
      let record = structuredClone(f.record);
      const requests = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url, init });
        const body = init.body ? JSON.parse(init.body) : null;
        const writing = init.method === f.method && !(f.readRequest && body?.query === f.readRequest.query);
        if (writing) {
          assert.equal(url, f.url);
          assert.deepEqual(body, f.request);
          record = f.update(record, body);
        }
        const response = writing && f.writeResponse ? f.writeResponse(record) : f.response(record);
        return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
      };
      try {
        const readArgs = { headers: f.headers, ...(f.readRequest ? { method: 'POST', body: JSON.stringify(f.readRequest) } : {}) };
        const initial = await v.fetchUrl(f.readUrl || f.url, readArgs, { tabId: 11 });
        assert.equal(initial.success, true);
        const result = await dispatch(v, { allowed: true }, { url: f.url, method: f.method, headers: f.headers, body: JSON.stringify(f.request) });
        assert.equal(result.calls, 1);
        const after = await v.fetchUrl(f.readUrl || f.url, readArgs, { tabId: 11 });
        assert.equal(after.success, true);
        assert.equal(f.title(record), 'Revised title');
        const unchanged = JSON.stringify(f.record).replace('Original title', 'Revised title');
        assert.deepEqual(record, JSON.parse(unchanged));
        assert.equal(requests.length, 3, 'no create/publish or duplicate update');
        for (const req of requests) {
          assert.equal(req.init.redirect, 'manual');
          assert.deepEqual(req.init.headers, f.headers);
        }
        assert.equal(requests[1].init.credentials, ['ghost', 'drupal', 'joomla', 'strapi', 'webflow', 'contentful'].includes(f.cms) ? 'include' : 'omit');
      } finally { globalThis.fetch = prior; }
    });
  }

  test(`${browser}: auth, rights, conflicts and rate-limit errors reach the caller without transport retry`, async () => {
    const prior = globalThis.fetch;
    try {
      for (const status of [401, 403, 409, 429, 503]) {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ errors: [{ code: `CMS_${status}` }] }), { status, headers: { 'Content-Type': 'application/json', 'Retry-After': '17', ETag: 'r1' } }); };
        const result = await v.fetchUrl('https://cms.example.test/api/stories/s1', { method: 'PUT', body: '{}' }, { tabId: 11 });
        assert.equal(result.success, false);
        assert.equal(result.status, status);
        assert.equal(calls, 1);
        assert.ok(result.json.includes(`CMS_${status}`));
        assert.equal(result.retryAfter, undefined, 'do not claim unavailable response headers');
        assert.equal(result.etag, undefined);
      }
    } finally { globalThis.fetch = prior; }
  });

  test(`${browser}: timeout after fixture create commits once; reconciliation GET recovers the same draft`, async () => {
    const prior = globalThis.fetch;
    let draft = null; const methods = [];
    globalThis.fetch = async (_url, init) => {
      methods.push(init.method);
      if (init.method === 'POST') { draft = { id: 'existing-after-timeout', status: 'draft', title: 'Fixture' }; throw new Error('Timed out after dispatch'); }
      return new Response(JSON.stringify({ posts: [draft] }), { headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const created = await v.fetchUrl('https://cms.example.test/ghost/api/admin/posts/', { method: 'POST', body: '{"posts":[{"title":"Fixture","status":"draft"}]}' }, { tabId: 11 });
      assert.equal(created.success, false);
      const reconciled = await v.fetchUrl('https://cms.example.test/ghost/api/admin/posts/?filter=slug:fixture', {}, { tabId: 11 });
      assert.equal(JSON.parse(reconciled.json).posts[0].id, 'existing-after-timeout');
      assert.deepEqual(methods, ['POST', 'GET']);
    } finally { globalThis.fetch = prior; }
  });

  test(`${browser}: redirects do not forward a CMS secret to a second origin`, async () => {
    const prior = globalThis.fetch; const requests = [];
    globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response(null, { status: 307, headers: { Location: 'https://untrusted.example.test/collect' } }); };
    try {
      const result = await v.fetchUrl('https://cms.example.test/api/stories', { headers: { Authorization: 'Bearer <FIXTURE_SECRET>' } }, { tabId: 11 });
      assert.equal(result.success, false);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].init.redirect, 'manual');
    } finally { globalThis.fetch = prior; }
  });

  test(`${browser}: Strict Secret Handling still supplies its existing runtime instructions`, () => {
    const tools = v.tools.getToolsForMode('act', { tier: 'full', strictSecretMode: true });
    const done = tools.find(t => t.function.name === 'done');
    assert.match(done.function.description, /NEVER|never/);
    assert.match(done.function.description, /credential|secret/i);
    // This checks policy delivery only. Generic CMS auth headers have no secret
    // injection API; the fixture tests above explicitly show they are arguments.
    for (const id of ids) {
      const prompt = skills.buildCustomSkillsPrompt(records(v), { tier: 'full', activeSkillIds: [id] });
      assert.match(prompt, /With\nStrict Secret Handling/);
    }
  });
}
