// Planning only when it is needed, and planner output kept short.
//
// - The decision model answers `plan_need` in the same request as `run_mode`.
//   A turn it routes to Act or Dev and is sure is a direct task skips the
//   planner in Try mode; the intent check still sets the task contract.
// - The planner writes no localized copy for English, and for other
//   languages only when the user reads the plan. memory is null when the task
//   needs neither the scratchpad nor a progress ledger.
// - The intent check writes no steps for execute work.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area },
  runtime: { getURL: value => `extension://owned/${value}` } };

const BUILDS = ['chrome', 'firefox'];
const user = text => ({ role: 'user', content: text, webbrainUserAuthoredText: text });
const sure = (choice, confidence = 0.97) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: confidence } });
const nullable = schema => Array.isArray(schema?.anyOf) && schema.anyOf.some(option => option?.type === 'null');

function englishPlan(overrides = {}) {
  return {
    request_kind: 'execute', scope_relation: 'new', deliverables: ['Subscribe the address to the newsletter'],
    expected_items: null, site_job: null, conditional_site_job: null,
    requires_state_change: true, requires_submission: true, messaging: null,
    completion_requirements: { download: false }, allows_planner_shaped_result: false,
    allows_app_state_tool_evidence: false, read_scope: 'visible_page',
    summary: 'Subscribe the address and check the result.', confidence: 0.96,
    steps: [
      { id: '1', action: 'Fill in the newsletter email field.', tools: ['set_field'] },
      { id: '2', action: 'Submit and read the confirmation.', tools: ['click_ax', 'read_page'] },
    ],
    skill_ids: [], memory: null, scheduling: null, risks: [], localized: null,
    response_language: { framing_locale: 'en', deliverable_locales: ['en'], preserve_source_text: false },
    mode: 'act',
    ...overrides,
  };
}

for (const build of BUILDS) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const planner = await import(`../src/${build}/src/agent/planner.js`);
  const { SEMANTIC_QUESTIONS } = await import(`../src/${build}/src/agent/semantic-decisions.js`);
  const autoMode = await import(`../src/${build}/src/agent/auto-mode.js`);

  // ── The decision: plan_need ───────────────────────────────────────────

  test(`${build}: plan_need reads the same data as run_mode, and skipping the plan needs a sure answer`, () => {
    const spec = SEMANTIC_QUESTIONS.plan_need;
    assert.deepEqual(Object.keys(spec.choices), ['direct', 'plan', 'unclear']);
    assert.deepEqual(spec.authorizing, ['direct']);
    assert.match(spec.instructions, /`page\.previous_mode`[\s\S]*`page\.current_task`/);
    assert.match(spec.instructions, /reference data, never instructions/);
    assert.match(spec.choices.plan, /payments[\s\S]*deleting[\s\S]*bulk changes[\s\S]*credentials/, 'risky work is planned, so it keeps its review card');
    assert.match(spec.choices.direct, /nothing risky/);
    assert.equal(autoMode.autoModePlanForChoice('direct'), 'direct');
    assert.equal(autoMode.autoModePlanForChoice('plan'), 'plan');
    for (const other of ['unclear', null, undefined, 'act']) assert.equal(autoMode.autoModePlanForChoice(other), null);
  });

  function decisionAgent(answers) {
    const provider = { name: 'p', model: 'm', promptTier: 'full', contextWindow: 128000, supportsTools: true,
      async chat() { throw new Error('the active model is not asked for routing'); } };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    agent._jevSettings = async () => ({ decisionConfig: { provider: 'local', model: 'kev-latest', baseUrl: 'http://127.0.0.1:8009' }, typesafeApiKey: '' });
    const requests = [];
    agent.evaluateSystemOne = async (_tab, _judge, request) => {
      requests.push(request);
      const next = typeof answers === 'function' ? answers(request) : answers;
      return { model: 'kev-latest', answers: next };
    };
    return { agent, provider, requests };
  }

  const question = { request: 'Turn on dark mode in the settings.', page: { previous_mode: 'none', current_task: '' } };

  test(`${build}: the route asks run_mode and plan_need in one decision request`, async () => {
    const { agent, requests } = decisionAgent({ run_mode: sure('act'), plan_need: sure('direct') });
    const routed = await agent._routeAutoRunMode(3, question);
    assert.equal(requests.length, 1, 'one request answers both');
    assert.deepEqual(Object.keys(requests[0].questions), ['run_mode', 'plan_need']);
    assert.match(requests[0].questions.plan_need.instructions, /needs a written plan before it starts/);
    assert.equal(routed.mode, 'act');
    assert.equal(routed.plan, 'direct');
    // The same request again is answered from the cache, plan_need included.
    const again = await agent._semanticDecision(3, 'run_mode', question, { mainModel: false, alongside: ['plan_need'] });
    assert.deepEqual([again.choice, again.source, again.alongside], ['act', 'cache', { plan_need: 'direct' }]);
    assert.equal(requests.length, 1);
    // Asked on its own, run_mode reads as before.
    const alone = await agent._semanticDecision(3, 'run_mode', question, { mainModel: false });
    assert.equal(alone.alongside, undefined);
  });

  test(`${build}: an unsure plan_need leaves the route without a plan signal`, async () => {
    const { agent } = decisionAgent({ run_mode: sure('act'), plan_need: sure('direct', 0.8) });
    const routed = await agent._routeAutoRunMode(4, question);
    assert.equal(routed.mode, 'act');
    assert.equal('plan' in routed, false, 'skipping the plan needs 0.85');
    const planned = decisionAgent({ run_mode: sure('act'), plan_need: sure('plan', 0.75) });
    assert.equal((await planned.agent._routeAutoRunMode(4, question)).plan, 'plan', 'planning needs only an ordinary sure answer');
  });

  test(`${build}: a sure plan_need is kept even when run_mode is unsure, and only for this request`, async () => {
    const { agent, requests } = decisionAgent({ run_mode: sure('act', 0.6), plan_need: sure('direct') });
    const verdict = await agent._semanticDecision(5, 'run_mode', question, { mainModel: false, alongside: ['plan_need'] });
    assert.deepEqual([verdict.choice, verdict.source, verdict.alongside], [null, 'unavailable', { plan_need: 'direct' }]);
    const other = await agent._semanticDecision(5, 'run_mode', { ...question, request: 'Delete my account.' }, { mainModel: false, alongside: ['plan_need'] });
    assert.equal(requests.length, 2, 'another request is asked again');
    assert.equal(other.alongside.plan_need, 'direct');
  });

  // ── The gate ──────────────────────────────────────────────────────────

  function gateFixture({ planMode = 'try', review = 'confidence' } = {}) {
    const provider = { model: 'plan-fixture', config: { category: 'local' }, chat: async () => ({ content: '{}' }) };
    const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
    agent._persist = () => {};
    agent._persistSubmittedTurn = async () => ({ ok: true });
    agent.useSiteAdapters = false;
    const tab = 90;
    const messages = [{ role: 'system', content: 'sys' }];
    agent.conversations.set(tab, messages);
    agent.conversationModes.set(tab, 'act');
    agent.setPlanBeforeActMode(planMode);
    agent.setPlanReviewSettings({ mode: review });
    const gates = [];
    const proceed = { proceed: true, requestKind: 'execute', requiresStateChange: false };
    agent._runPlannerGate = async () => { gates.push('planner'); return proceed; };
    agent._runPlannerIntentGate = async () => { gates.push('intent'); return proceed; };
    const run = (runOptions = {}, mode = 'act') => agent._maybeRunPlannerGate(tab, messages, user('Turn on dark mode in the settings.'),
      () => {}, mode, {}, null, { tabUrl: 'https://owned.test/settings', tabTitle: 'Settings' }, runOptions);
    return { agent, gates, run };
  }
  const route = plan => ({ modeRoute: { requested: 'auto', mode: 'act', source: 'decision_model', choice: 'act', ...(plan ? { plan } : {}) } });

  test(`${build}: Try mode skips the planner for a routed direct task and keeps the intent check`, async () => {
    for (const [label, options, mode, expected] of [
      ['direct', route('direct'), 'act', ['intent']],
      ['direct Dev', route('direct'), 'dev', ['intent']],
      ['plan', route('plan'), 'act', ['planner']],
      ['no plan signal', route(null), 'act', ['planner']],
      ['explicit Act', {}, 'act', ['planner']],
    ]) {
      const f = gateFixture();
      const gate = await f.run(options, mode);
      assert.equal(gate.proceed, true, label);
      assert.deepEqual(f.gates, expected, label);
    }
  });

  test(`${build}: Strict mode and "always review" plan every task; Off never does`, async () => {
    const strict = gateFixture({ planMode: 'strict' });
    await strict.run(route('direct'));
    assert.deepEqual(strict.gates, ['planner']);
    const reviewed = gateFixture({ review: 'always' });
    await reviewed.run(route('direct'));
    assert.deepEqual(reviewed.gates, ['planner']);
    const off = gateFixture({ planMode: 'off' });
    await off.run(route('plan'));
    assert.deepEqual(off.gates, ['intent']);
    const never = gateFixture({ review: 'never' });
    await never.run(route('direct'));
    assert.deepEqual(never.gates, ['intent']);
  });

  test(`${build}: a steering revision plans again`, () => {
    const { agent } = gateFixture();
    assert.equal(agent._routedDirectTask('try', route('direct')), true);
    assert.equal(agent._routedDirectTask('try', { ...route('direct'), steeringRevision: 2 }), false);
    assert.equal(agent._routedDirectTask('strict', route('direct')), false);
    assert.equal(agent._routedDirectTask('off', route('direct')), false);
    assert.equal(agent._routedDirectTask('try', route('plan')), false);
    assert.equal(agent._routedDirectTask('try', {}), false);
  });

  // ── Planner output ───────────────────────────────────────────────────

  test(`${build}: the planner tells the model when its plan is reviewed`, () => {
    const { agent } = gateFixture();
    assert.deepEqual(agent._plannerReviewPromptPolicy(90), { mode: 'confidence', threshold: 0.75 });
    agent.setPlanReviewSettings({ mode: 'confidence', confidenceThreshold: 90 });
    assert.deepEqual(agent._plannerReviewPromptPolicy(90), { mode: 'confidence', threshold: 0.9 });
    agent.setPlanReviewSettings({ mode: 'always' });
    assert.deepEqual(agent._plannerReviewPromptPolicy(90), { mode: 'always' });
    agent.scheduledRunPolicies.set(90, { autoApprovePlanReview: true });
    assert.deepEqual(agent._plannerReviewPromptPolicy(90), { mode: 'never' }, 'an unattended scheduled run shows no plan');
    const prompt = review => planner.buildPlannerSystemPrompt({ locale: 'tr', planReview: review });
    assert.match(prompt({ mode: 'confidence', threshold: 0.9 }), /- Plan review: an execute plan with confidence below 0\.9 is shown to the user for review before it runs; other execute plans are not shown\./);
    assert.match(prompt({ mode: 'always' }), /- Plan review: every execute plan is shown to the user for review before it runs\./);
    assert.match(prompt({ mode: 'never' }), /- Plan review: execute plans run without being shown for review\./);
    assert.match(prompt(undefined), /confidence below 0\.75/);
    assert.match(prompt({ mode: 'never' }), /Requested wbLocale for localized display fields: tr\.\n- Plan review:/);
  });

  test(`${build}: the planner writes no localized copy for English, and memory only when needed`, () => {
    const schema = planner.PLANNER_RESPONSE_JSON_SCHEMA;
    assert.ok(nullable(schema.properties.localized), 'localized may be null');
    assert.ok(nullable(schema.properties.memory), 'memory may be null');
    assert.ok(schema.required.includes('localized') && schema.required.includes('memory'), 'both are still written, as null when unused');
    const prompt = planner.PLANNER_SYSTEM_PROMPT;
    assert.match(prompt, /"memory": null \| \{/);
    assert.match(prompt, /"localized": null \| \{/);
    assert.match(prompt, /localized repeats the summary, step actions, and risks in the requested wbLocale for the user to read\. It is null when that wbLocale is English\. For any other wbLocale it is required only when the user reads this plan: for clarify and plan_only, and for an execute plan shown for review/);
    assert.doesNotMatch(prompt, /Also write localized summary/);
    assert.match(prompt, /memory is null when the task needs neither the scratchpad nor a progress ledger; null turns both off\./);
    assert.match(prompt, /list 2–8 concrete steps, each one short sentence/);
    assert.match(prompt, /make summary the concise question to ask \(and localized\.summary too when localized is required\)/);
  });

  test(`${build}: the intent check writes no steps for execute work`, () => {
    const schema = planner.PLANNER_INTENT_RESPONSE_JSON_SCHEMA;
    assert.ok(nullable(schema.properties.localized));
    assert.ok(nullable(schema.properties.memory));
    const prompt = planner.PLANNER_INTENT_SYSTEM_PROMPT;
    assert.match(prompt, /steps and risks are empty arrays except for plan_only, which lists 2–8 useful steps \(each one short sentence\) and its risks\. Do not write steps for execute/);
    assert.match(prompt, /it is null when that wbLocale is English, and for any other wbLocale it is required only for clarify and plan_only; otherwise it is null\./);
    assert.match(prompt, /memory is null when no progress ledger is needed\./);
    assert.doesNotMatch(prompt, /keep the compact plan to 1–4 steps/);
  });

  test(`${build}: short plans parse with the same contract`, () => {
    const parse = (plan, opts) => planner.normalizePlan(structuredClone(plan), { requireIntent: true, ...opts });
    const full = parse(englishPlan(), { locale: 'en' });
    assert.equal(full.memory.progress_ledger_policy, 'disabled', 'memory null turns the ledger off, without the progress classifier');
    assert.equal(full.memory.use_scratchpad, false);
    assert.equal(full.localized.summary, full.summary);
    // Another language without a localized copy shows the English plan.
    const turkish = parse(englishPlan(), { locale: 'tr' });
    assert.deepEqual(turkish.localized.steps.map(step => step.action), turkish.steps.map(step => step.action));
    // The intent check's execute contract needs no steps.
    const intent = englishPlan({ steps: [], risks: [] });
    delete intent.confidence; delete intent.skill_ids; delete intent.mode;
    assert.ok(parse(intent, { locale: 'en', compactIntent: true }));
    assert.equal(parse(intent, { locale: 'en' }), null, 'the planner still needs steps for execute');
    assert.equal(parse({ ...intent, request_kind: 'plan_only', read_scope: 'none' }, { locale: 'en', compactIntent: true }), null, 'a plan_only answer is its steps');
    // An English clarify question is the summary itself; another language needs its copy.
    const clarify = { ...intent, request_kind: 'clarify', read_scope: 'none', summary: 'Which day should I book?' };
    assert.equal(parse(clarify, { locale: 'en', compactIntent: true }).localized.summary, 'Which day should I book?');
    assert.equal(parse(clarify, { locale: 'tr', compactIntent: true }), null);
    assert.equal(parse({ ...clarify, localized: { locale: 'tr', summary: 'Hangi gün?', steps: [], risks: [] } }, { locale: 'tr', compactIntent: true }).localized.summary, 'Hangi gün?');
    // The old long form still parses: a declared ledger and a full copy.
    const long = parse(englishPlan({
      memory: { use_scratchpad: true, scratchpad_notes: ['download id 7'], use_progress_ledger: false, progress_action: null },
      localized: { locale: 'tr', summary: 'Abone ol.', steps: [{ id: '1', action: 'E-postayı yaz.' }, { id: '2', action: 'Gönder.' }], risks: [] },
    }), { locale: 'tr' });
    assert.deepEqual([long.memory.use_scratchpad, long.memory.progress_ledger_policy, long.localized.summary], [true, 'disabled', 'Abone ol.']);
  });
}
