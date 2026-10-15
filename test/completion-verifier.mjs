import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const config = await import(`../src/${build}/src/agent/decision-config.js`);
  const judge = await import(`../src/${build}/src/agent/systemone-judge.js`);
  const verifier = await import(`../src/${build}/src/agent/completion-verifier.js`);
  const runtime = await import(`../src/${build}/src/agent/completion-runtime.js`);
  const transfer = await import(`../src/${build}/src/config-transfer.js`);
  test(`${build}: decision configuration round trips and legacy migration preserves credentials, flags and thresholds`, () => {
    const stored = { decisionProvider: 'openrouter', decisionModel: 'other/decision', decisionApiKey: 'synthetic-or', decisionLocalApiKey: 'synthetic-local', typesafeApiKey: 'synthetic-legacy',
      decisionBaseUrl: 'http://localhost:8009', decisionVisionMode: 'on', decisionVisionSupported: true, decisionInputRate: .2, decisionOutputRate: .1,
      systemOneEnabled: true, systemOneDoneEnabled: false, systemOneDoneThreshold: .93, systemOneWatchEnabled: true, systemOneCompletionEnabled: true, systemOneCompletionThreshold: .8 };
    const imported = transfer.parseConfigImport(JSON.stringify(transfer.createConfigExport(stored))).settings;
    for (const [key, value] of Object.entries(stored)) assert.equal(imported[key], value, key);
    const legacy = transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { typesafeApiKey: 'legacy', systemOneEnabled: true, systemOneWatchEnabled: true, systemOneWatchThreshold: .85, systemOneCompletionThreshold: .75 } })).settings;
    const selected = config.resolveDecisionConfig(legacy);
    assert.equal(selected.provider, 'typesafe'); assert.equal(selected.model, 'jev-1.13.0'); assert.equal(selected.apiKey, 'legacy');
    assert.equal(selected.config.inputCostPerMillionUsd, .042); assert.equal(legacy.systemOneWatchEnabled, true);
    assert.equal(legacy.systemOneWatchThreshold, .85); assert.equal(legacy.systemOneCompletionThreshold, .75); assert.equal(selected.threshold, .9);
  });
  test(`${build}: full and sparse imports reject invalid decision enums and endpoints before persistence`, () => {
    for (const parser of [transfer.parseConfigImport, transfer.parseConfigPatchImport]) {
      for (const settings of [{ decisionProvider: 'unknown' }, { decisionVisionMode: 'maybe' }, { decisionProvider: 'local', decisionBaseUrl: 'not a URL' },
        { decisionBaseUrl: 'javascript:alert(1)' }, { decisionBaseUrl: 'http://remote.example.com' }, { decisionBaseUrl: 'https://user:secret@example.com' }]) {
        assert.throws(() => parser(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings })), /Invalid value for configuration setting/);
      }
      for (const decisionBaseUrl of ['', 'http://127.0.0.1:8009', 'http://localhost:8009', 'http://[::1]:8009', 'https://example.com/v1']) {
        const imported = parser(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { decisionProvider: 'local', decisionBaseUrl } })).settings;
        assert.doesNotThrow(() => config.resolveDecisionConfig(imported));
      }
    }
  });
  test(`${build}: new defaults and legacy/local configuration`, () => {
    assert.equal(config.resolveDecisionConfig().model, config.DEFAULT_DECISION_MODEL);
    const legacy = config.resolveDecisionConfig({ typesafeApiKey: 'legacy', systemOneEnabled: true, systemOneWatchEnabled: true });
    assert.equal(legacy.provider, 'typesafe'); assert.equal(legacy.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(legacy.apiKey, 'legacy'); assert.equal(legacy.doneEnabled, true);
    const local = config.resolveDecisionConfig({ decisionProvider: 'local', systemOneEnabled: true });
    assert.equal(local.enabled, true); assert.equal(local.local, true); assert.equal(local.apiKey, '');
    assert.equal(local.url, 'http://127.0.0.1:8009/v1/systemone');
    assert.equal(config.resolveDecisionConfig({ decisionProvider: 'local', decisionBaseUrl: 'http://localhost:8009/v1' }).url, 'http://localhost:8009/v1/systemone');
    assert.throws(() => config.resolveDecisionConfig({ decisionProvider: 'local', decisionBaseUrl: 'http://user:pass@example.com' }));
    const compass = config.resolveDecisionConfig({ decisionProvider: 'local', systemOneDoneEnabled: false }, { baseUrl: 'https://api.webbrain.one/v1' });
    assert.equal(compass.provider, 'compass'); assert.equal(compass.enabled, true); assert.equal(compass.doneEnabled, true);
  });
  test(`${build}: Compass credentials never fall back to saved decision-provider keys`, async () => {
    const saved = { systemOneEnabled: false, decisionApiKey: 'saved-openrouter-key',
      typesafeApiKey: 'saved-typesafe-key', decisionLocalApiKey: 'saved-local-key' };
    for (const decisionProvider of ['openrouter', 'typesafe', 'local']) {
      for (const apiKey of [undefined, '', '  ', 'managed-compass-key']) {
        const selected = config.resolveDecisionConfig({ ...saved, decisionProvider }, { baseUrl: 'https://api.webbrain.one/v1', apiKey });
        assert.equal(selected.apiKey, (apiKey || '').trim());
        let request;
        const client = judge.createSystemOneJudge({ fetchImpl: async (url, options) => {
          request = { url, ...options };
          return { ok: true, json: async () => response() };
        } });
        await client.evaluate({ config: selected, apiKey: saved.typesafeApiKey, state: {}, questions: verifier.completionQuestions() });
        assert.equal(request.url, 'https://api.webbrain.one/v1/decisions');
        assert.equal(request.headers.Authorization, selected.apiKey ? `Bearer ${selected.apiKey}` : undefined);
      }
      const byo = config.resolveDecisionConfig({ ...saved, decisionProvider, systemOneEnabled: true });
      assert.equal(byo.apiKey, decisionProvider === 'typesafe' ? saved.typesafeApiKey : decisionProvider === 'local' ? saved.decisionLocalApiKey : saved.decisionApiKey);
    }
  });
  // The judge answers every question it is asked: the outcome, and the two
  // side questions about later outcomes and the candidate summary.
  const side = (choices, choice) => ({ type: 'choice', choice, confidence: .95,
    probabilities: Object.fromEntries(choices.map(x => [x, x === choice ? 1 - .05 * (choices.length - 1) : .05])) });
  function response(outcome = 'succeeded', { later = 'not_asked', summary = 'result' } = {}) {
    return { model: config.DEFAULT_DECISION_MODEL + '-20261001', provider: 'Perplexity', usage: { input_tokens: 40, output_tokens: 1, cost: .00002 },
      answers: { task_outcome: { type: 'choice', choice: outcome, confidence: .99, probabilities: Object.fromEntries(verifier.COMPLETION_OUTCOMES.map(x => [x, x === outcome ? .97 : .01])) },
        later_outcome: side(['asked', 'not_asked'], later), summary_kind: side(['result', 'meta_only', 'plan_only'], summary) } };
  }
  test(`${build}: OpenRouter wire, resolved versions and actual costs`, async () => {
    let request, usage;
    const client = judge.createSystemOneJudge({ fetchImpl: async (url, options) => { request = { url, ...options }; return { ok: true, json: async () => response() }; } });
    const result = await client.evaluate({ config: config.resolveDecisionConfig({ decisionApiKey: 'synthetic' }), state: {}, questions: verifier.completionQuestions(), onUsage: m => { usage = m; } });
    assert.equal(request.url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(JSON.parse(request.body).model, config.DEFAULT_DECISION_MODEL);
    assert.equal(usage.estimatedCostUsd, .00002); assert.equal(result.usage.cost, .00002);
    assert.equal(verifier.decisionCompletionVerdict(result).outcome, 'succeeded');
    assert.deepEqual(Object.keys(JSON.parse(request.body).questions), ['task_outcome', 'later_outcome', 'summary_kind'],
      'the side questions travel in the same request as the verdict');
    assert.match(JSON.parse(request.body).questions.summary_kind.instructions, /any language/);
  });
  test(`${build}: the decision judge's sure side answers add a note or flag a summary; unsure ones do nothing`, () => {
    const verdict = verifier.decisionCompletionVerdict(response('succeeded', { later: 'asked', summary: 'meta_only' }));
    assert.equal(verdict.laterOutcome, 'asked'); assert.equal(verdict.summaryKind, 'meta_only');
    assert.equal(verifier.decisionCompletionVerdict(response('succeeded', { summary: 'plan_only' })).summaryKind, 'plan_only');
    const plain = verifier.decisionCompletionVerdict(response());
    assert.equal(plain.laterOutcome, undefined); assert.equal(plain.summaryKind, undefined);
    const unsure = response('succeeded', { later: 'asked', summary: 'meta_only' });
    unsure.answers.later_outcome.confidence = .5; unsure.answers.summary_kind.probabilities = { result: .35, meta_only: .4, plan_only: .25 };
    const verdict2 = verifier.decisionCompletionVerdict(unsure);
    assert.equal(verdict2.laterOutcome, undefined); assert.equal(verdict2.summaryKind, undefined);
    // A side answer never changes the outcome itself.
    assert.equal(verifier.decisionCompletionVerdict(response('pending', { summary: 'result' })).outcome, 'pending');
  });
  test(`${build}: local key is optional and malformed distributions cannot succeed`, async () => {
    let headers;
    const local = config.resolveDecisionConfig({ decisionProvider: 'local' });
    const good = response(); good.model = 'kev-latest';
    const client = judge.createSystemOneJudge({ fetchImpl: async (_url, options) => { headers = options.headers; return { ok: true, json: async () => good }; } });
    await client.evaluate({ config: local, state: {}, questions: verifier.completionQuestions() });
    assert.equal(headers.Authorization, undefined);
    good.answers.task_outcome.probabilities.succeeded = .5;
    await assert.rejects(client.evaluate({ config: local, state: {}, questions: verifier.completionQuestions() }), e => e.code === 'JEV_INVALID_DISTRIBUTION');
  });
  test(`${build}: vision then AX, negative verdict stops, uncertainty reaches LLM and legacy`, async () => {
    const calls = [];
    const engine = (name, outcomes) => ({ name, supportsVision: true, evaluate: async (_e, modality) => { calls.push(name + ':' + modality); return { outcome: outcomes.shift() || 'uncertain' }; } });
    const base = { capture: async modality => ({ identity: 'fresh', state: modality }), isCurrent: () => true };
    let result = await verifier.verifyCompletion({ ...base, decision: engine('decision', ['uncertain', 'pending']), llm: engine('llm', ['succeeded']) });
    assert.equal(result.outcome, 'pending'); assert.deepEqual(calls, ['decision:vision', 'decision:ax']);
    calls.length = 0;
    result = await verifier.verifyCompletion({ ...base, decision: engine('decision', ['uncertain']), llm: engine('llm', ['uncertain', 'succeeded']) });
    assert.equal(result.engine, 'llm'); assert.equal(result.modality, 'ax');
    result = await verifier.verifyCompletion({ ...base, llm: engine('llm', ['uncertain']) });
    assert.equal(result.engine, 'legacy');
    result = await verifier.verifyCompletion({ ...base, decision: engine('decision', ['succeeded']), capture: async modality => {
      if (modality === 'vision') throw new Error('Screenshot capture failed');
      return { identity: 'fresh' };
    } });
    assert.equal(result.modality, 'ax', 'capture failures should retry with AX');
  });
  // The decision model decides when it is sure. When it answered but was not
  // sure, the active model's second look has a bounded time in all; when the
  // decision model was unavailable, or its success needs confirmation, the
  // active model keeps its full checks.
  test(`${build}: an unsure decision model bounds the active model's second look`, async () => {
    let clock = 0;
    const now = () => clock;
    const capture = async modality => { clock += 300; return { identity: 'fresh', state: modality }; };
    const calls = [], attempts = [];
    const llm = (spend, outcomes) => ({ name: 'llm', supportsVision: true, evaluate: async (_e, modality, options = {}) => {
      calls.push([modality, options.timeoutMs ?? null]); clock += spend; return { outcome: outcomes.shift() || 'uncertain' }; } });
    const unsure = { name: 'typesafe', supportsVision: false, evaluate: async () => { clock += 400; return { outcome: 'uncertain' }; } };
    let result = await verifier.verifyCompletion({ capture, isCurrent: () => true, now, onAttempt: item => attempts.push(item),
      decision: unsure, llm: llm(7000, ['uncertain', 'succeeded']) });
    assert.equal(result.engine, 'legacy');
    assert.deepEqual(calls, [['vision', verifier.COMPLETION_SECOND_LOOK_MS - 300]],
      'One look fits; the second could not finish in what is left and is not started');
    assert.deepEqual(attempts.map(item => [item.engine, item.modality, item.outcome, item.reason ?? null]),
      [['typesafe', 'ax', 'uncertain', null], ['llm', 'vision', 'uncertain', null], ['llm', 'ax', 'uncertain', 'time_budget']]);
    assert.deepEqual([attempts[0].captureMs, attempts[0].evaluateMs, attempts[1].captureMs, attempts[1].evaluateMs], [300, 400, 300, 7000]);
    // A fast second look still uses both of its checks.
    calls.length = 0; clock = 0;
    result = await verifier.verifyCompletion({ capture, isCurrent: () => true, now, decision: unsure, llm: llm(1000, ['uncertain', 'failed']) });
    assert.equal(result.outcome, 'failed'); assert.equal(result.modality, 'ax');
    assert.deepEqual(calls.map(([modality]) => modality), ['vision', 'ax']);
    assert.ok(calls.every(([, timeoutMs]) => timeoutMs > 0 && timeoutMs <= verifier.COMPLETION_SECOND_LOOK_MS));
    // An unavailable decision model, or a sure success that needs
    // independent confirmation, leaves the active model unbounded.
    for (const decision of [
      { name: 'typesafe', evaluate: async () => { clock += 400; throw Object.assign(new Error('HTTP'), { status: 503 }); } },
      { name: 'webgpu_d1', requiresIndependentSuccessConfirmation: true, evaluate: async () => { clock += 400; return { outcome: 'succeeded' }; } },
    ]) {
      calls.length = 0; clock = 0;
      result = await verifier.verifyCompletion({ capture, isCurrent: () => true, now, decision, llm: llm(7000, ['uncertain', 'succeeded']) });
      assert.equal(result.outcome, 'succeeded', decision.name); assert.equal(result.modality, 'ax');
      assert.deepEqual(calls, [['vision', null], ['ax', null]], decision.name);
    }
    // A sure decision ends at once, with no second look.
    calls.length = 0; clock = 0;
    result = await verifier.verifyCompletion({ capture, isCurrent: () => true, now,
      decision: { name: 'typesafe', evaluate: async () => ({ outcome: 'succeeded' }) }, llm: llm(7000, ['failed']) });
    assert.equal(result.outcome, 'succeeded'); assert.equal(result.engine, 'typesafe'); assert.deepEqual(calls, []);
  });
  test(`${build}: auth/transport skip engine; unsupported image retries AX`, async () => {
    for (const field of ['status', 'httpStatus']) for (const status of [401, 500, 400, 413, 415, 422]) for (const name of ['decision', 'llm']) {
      const calls = [];
      const engine = { name, supportsVision: true, evaluate: async (_e, modality) => { calls.push(modality); if (modality === 'vision') throw Object.assign(new Error('HTTP'), { [field]: status }); return { outcome: 'failed' }; } };
      const result = await verifier.verifyCompletion({ [name]: engine, capture: async () => ({ identity: 'fresh' }), isCurrent: () => true });
      const unsupportedImage = [400, 413, 415, 422].includes(status);
      assert.deepEqual(calls, unsupportedImage ? ['vision', 'ax'] : ['vision'], `${name}/${field}/${status}`);
      assert.equal(result.outcome, unsupportedImage ? 'failed' : 'uncertain');
    }
  });
  test(`${build}: quota, cancellation, budget and stale evidence never fall through`, async () => {
    for (const error of [Object.assign(new Error('quota'), { status: 402 }), Object.assign(new Error('budget'), { code: 'WB_COST_ALLOWANCE' })]) {
      let llmCalls = 0;
      await assert.rejects(verifier.verifyCompletion({ decision: { name: 'decision', evaluate: async () => { throw error; } }, llm: { name: 'llm', evaluate: async () => { llmCalls++; return { outcome: 'succeeded' }; } }, capture: async () => ({}), isCurrent: () => true }));
      assert.equal(llmCalls, 0);
    }
    await assert.rejects(verifier.verifyCompletion({ decision: { name: 'decision', evaluate: async () => ({ outcome: 'succeeded' }) }, capture: async () => ({}), isCurrent: () => false }), e => e.code === 'STALE_COMPLETION');
    const controller = new AbortController(); controller.abort(new Error('Stopped'));
    await assert.rejects(verifier.verifyCompletion({ signal: controller.signal, decision: { name: 'decision' }, capture: async () => ({}), isCurrent: () => true }), /Stopped/);
    await assert.rejects(verifier.withCompletionTimeout(() => new Promise(() => {}), null, 5), /timed out/);
  });
  test(`${build}: LLM enum/shape validation and observable requirements`, () => {
    assert.throws(() => verifier.llmCompletionVerdict('{"outcome":"success","reason":"yes"}'));
    assert.throws(() => verifier.llmCompletionVerdict('{"outcome":"succeeded"}'));
    assert.equal(verifier.llmCompletionVerdict('{"outcome":"uncertain","reason":"rules were not observed"}').outcome, 'uncertain');
    assert.match(verifier.COMPLETION_INSTRUCTIONS, /unrelated comment/); assert.match(verifier.COMPLETION_INSTRUCTIONS, /Future popularity/);
    // The judge also says whether the task expects a later outcome; only an
    // exact "asked" counts, and no other value invalidates the verdict.
    assert.equal(verifier.llmCompletionVerdict('{"outcome":"succeeded","reason":"posted","later":"asked"}').laterOutcome, 'asked');
    for (const later of ['not_asked', 'ASKED', 'yes', '', null, true]) {
      const verdict = verifier.llmCompletionVerdict(JSON.stringify({ outcome: 'succeeded', reason: 'posted', later }));
      assert.equal(verdict.outcome, 'succeeded'); assert.equal(verdict.laterOutcome, undefined, JSON.stringify(later));
    }
    assert.match(verifier.SUMMARY_KIND_FIELD, /any language/);
    for (const [summary, kind] of [['meta_only', 'meta_only'], ['plan_only', 'plan_only'], ['result', undefined], ['META_ONLY', undefined], [7, undefined]]) {
      const verdict = verifier.llmCompletionVerdict(JSON.stringify({ outcome: 'succeeded', reason: 'posted', summary }));
      assert.equal(verdict.outcome, 'succeeded'); assert.equal(verdict.summaryKind, kind, JSON.stringify(summary));
    }
  });
  test(`${build}: discovery includes every decision publisher and per-model vision/rates`, async () => {
    const data = [ { id: 'other/decision', architecture: { output_modalities: ['decisions'], input_modalities: ['text', 'image'] }, pricing: { prompt: '.0000002' } }, { id: 'chat-only', architecture: { output_modalities: ['text'] } } ];
    const models = await config.listDecisionModels(config.resolveDecisionConfig(), async () => ({ ok: true, json: async () => ({ data }) }));
    assert.equal(models.length, 1); assert.equal(models[0].id, 'other/decision'); assert.equal(models[0].supportsVision, true); assert.ok(Math.abs(models[0].inputRate - .2) < 1e-12);
  });
  test(`${build}: runtime routes Compass, binds evidence, caches only unchanged results and works locally offline`, async () => {
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const stored = { decisionProvider: 'local', systemOneEnabled: false };
    const storage = { get: async () => ({ ...stored }) };
    globalThis.chrome = globalThis.browser = { storage: { local: storage } };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    let stamp = 'published-document', pixels = 'data:image/png;base64,synthetic', requests = 0, lastRequest;
    const active = { model: 'compass', supportsVision: true, config: { providerName: 'webbrain-cloud', baseUrl: 'https://api.webbrain.one/v1', deviceGuid: 'device', helpImproveWebBrain: false } };
    const guard = { enabled: true, requiresSubmission: true };
    const agent = {
      strictSecretMode: false, _activeProvider: () => active, _runAbortSignal: () => null,
      systemOneContext: () => ({ isCurrent: () => true }), _latestTaskText: () => 'Read the community rules and publish a WebBrain post', _originalTaskText: () => '',
      _progressTaskKeyHash: () => 'task-key', _planExecutionGuards: new Map([[1, guard]]),
      completionInvariants: new Map([[1, { runToken: 'run', historyToolCallIdsBeforeRun: new Set(), lastAction: { sequence: 2, name: 'click' } }]]),
      _currentCompletionSubmitState(tab) { return this._completionSubmitStates.get(tab) || null; }, _completionSubmitStates: new Map([[1, { dispatched: true, observedAfterSubmit: true, currentUrl: 'https://old.reddit.com/comments/new', workflowBinding: {
        adapterName: 'reddit', revision: '1', job: 'publish', verificationKind: 'published_resource', recipientBound: true,
        messageBody: 'unlabelled-entered-value', composerBody: 'nested-entered-value', messageSubject: 'another-entered-value',
        recipientTargets: [{ address: 'opaque-entered-value' }], metadataRequirements: [{ field: 'title', value: 'metadata-entered-value' }],
      } }]]),
      conversationIds: new Map([[1, 'session']]), conversations: new Map([[1, [
        { role: 'assistant', tool_calls: [{ id: 'rules', function: { name: 'read_page', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'rules', content: '{"text":"Community rules: relevant tools are allowed"}' },
        { role: 'assistant', tool_calls: ['type_ax', 'type_text', 'set_field', 'fill_form', 'navigate'].map((name, index) => ({ id: `action-${index}`, function: { name, arguments: JSON.stringify({ ref_id: 'observed-ref', text: 'unlabelled-entered-value', value: 'nested-entered-value', fields: [{ text: 'another-entered-value' }], url: 'https://example.test/?data=opaque-entered-value' }) } })) },
      ]]]),
      _completionDocumentStamp: async () => stamp, _captureCompletionJudgeImage: async () => pixels,
      _budgetForCapture: () => ({ maxTargetPx: 1568, maxTargetTokens: 1568 }), _shrinkImageForBudget: async dataUrl => ({ dataUrl }),
      executeTool: async () => ({ success: true, pageContent: 'Published WebBrain post\npassword=PRIVATE_SECRET' }),
      evaluateSystemOne: async (_tab, _client, args) => { requests++; lastRequest = args; return response(); },
      recordSystemOneVerdict: () => {},
    };
    try {
      let verdict = await runtime.verifyBrowserCompletion(agent, 1, { pageUrl: 'https://old.reddit.com/comments/new' });
      assert.equal(verdict.engine, 'compass'); assert.equal(verdict.modality, 'vision'); assert.equal(lastRequest.config.model, config.DEFAULT_DECISION_MODEL);
      assert.equal(lastRequest.headers['X-WebBrain-Help-Improve'], '0'); assert.equal(lastRequest.metadata.session_id, 'session');
      assert.match(JSON.stringify(lastRequest.state), /Community rules/);
      assert.doesNotMatch(JSON.stringify(lastRequest.state), /entered-value/);
      assert.deepEqual(lastRequest.state[0].recorded_actions, ['type_ax', 'type_text', 'set_field', 'fill_form', 'navigate'].map(tool => ({ tool })));
      assert.match(lastRequest.state[0].action, /published_resource/);
      const initialState = JSON.stringify(lastRequest.state);
      await runtime.verifyBrowserCompletion(agent, 1, { pageUrl: 'https://old.reddit.com/comments/new' });
      assert.equal(JSON.stringify(lastRequest.state), initialState);
      assert.equal(requests, 1, 'unchanged evidence should reuse its verdict');
      pixels = 'data:image/png;base64,changed-pixels';
      await runtime.verifyBrowserCompletion(agent, 1, { pageUrl: 'https://old.reddit.com/comments/new' });
      assert.equal(requests, 2, 'changed pixels must invalidate success even if AX text did not change');
      stamp = 'changed-document';
      await runtime.verifyBrowserCompletion(agent, 1, { pageUrl: 'https://old.reddit.com/comments/new' });
      assert.equal(requests, 3, 'changed evidence must invalidate the verdict');
      active.config = { category: 'local' }; active.supportsVision = false;
      stored.systemOneEnabled = true; Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
      agent.evaluateSystemOne = async (_tab, _client, args) => { lastRequest = args; const result = response(); result.model = 'kev-latest'; return result; };
      verdict = await runtime.verifyBrowserCompletion(agent, 1, { pageUrl: 'https://old.reddit.com/comments/new' });
      assert.equal(verdict.engine, 'local'); assert.equal(verdict.modality, 'ax'); assert.equal(lastRequest.config.local, true);
      assert.doesNotMatch(JSON.stringify(lastRequest.state), /PRIVATE_SECRET/);
      stamp = 'unicode-document';
      agent._latestTaskText = () => '规则と作業を確認してください'.repeat(1000);
      agent.executeTool = async () => ({ success: true, pageContent: '网页已发布。'.repeat(3000) + '\u0000'.repeat(3000) });
      await runtime.verifyBrowserCompletion(agent, 1, { pageUrl: 'https://old.reddit.com/comments/new', summary: '完了しました'.repeat(1000) });
      assert.ok(Buffer.byteLength(JSON.stringify(lastRequest.state)) < 16000, 'multilingual evidence must fit the upstream UTF-8 budget');
      stored.systemOneDoneEnabled = false;
      verdict = await runtime.verifyBrowserCompletion(agent, 1);
      assert.equal(verdict.engine, 'legacy', 'changed settings must invalidate cached success');
      active.chat = () => {}; active.supportsVision = true;
      agent._newCostRunState = () => ({ spentUsd: 0 });
      let llmCalls = 0;
      agent._chatWithCostAllowance = async (_provider, messages, options) => {
        llmCalls++;
        assert.equal(options.tools, undefined); assert.equal(options.maxTokens, 4096);
        assert.match(messages[0].content, /Do not call tools/);
        assert.ok(messages[0].content.includes(verifier.LATER_OUTCOME_FIELD), 'the judge is asked about later outcomes in the same request');
        assert.ok(messages[0].content.includes(verifier.SUMMARY_KIND_FIELD), 'the judge reads the candidate summary in the same request');
        return { content: JSON.stringify({ outcome: llmCalls === 1 ? 'uncertain' : 'succeeded', reason: 'Published resource is visible.', later: 'asked' }) };
      };
      verdict = await runtime.verifyBrowserCompletion(agent, 1);
      assert.equal(verdict.engine, 'llm'); assert.equal(verdict.modality, 'ax'); assert.equal(llmCalls, 2, 'active LLM must use its own vision and AX tiers');
      assert.equal(verdict.laterOutcome, 'asked');
      stored.systemOneDoneEnabled = true;
      agent.evaluateSystemOne = async () => { stamp = 'changed-during-verification'; const result = response(); result.model = 'kev-latest'; return result; };
      verdict = await runtime.verifyBrowserCompletion(agent, 1);
      assert.equal(verdict.outcome, 'pending'); assert.equal(verdict.engine, 'freshness');
    } finally {
      globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator;
    }
  });
  test(`${build}: completion history excludes previous runs and keeps current reads through compaction`, async () => {
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ decisionProvider: 'local', systemOneEnabled: true }) } } };
    const provider = { model: 'local', supportsVision: false, config: { category: 'local' } };
    const messages = [
      { role: 'assistant', tool_calls: [{ id: 'prior-rules', function: { name: 'read_page' } }, { id: 'prior-type', function: { name: 'type_ax' } }] },
      { role: 'tool', tool_call_id: 'prior-rules', content: 'STALE community rules from another task and document' },
      { role: 'tool', name: 'read_page', content: 'STALE unbound rules result' },
      { role: 'assistant', tool_calls: [{ id: 'current-rules', function: { name: 'read_page' } }, { id: 'current-click', function: { name: 'click_ax' } }] },
      { role: 'tool', tool_call_id: 'current-rules', content: 'CURRENT community rules inspected in this run' },
    ];
    let state;
    const run = { runToken: 'current', historyToolCallIdsBeforeRun: new Set(['prior-rules', 'prior-type']) };
    const agent = {
      _activeProvider: () => provider, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
      _latestTaskText: () => 'Read the rules and publish a post', _originalTaskText: () => '', _progressTaskKeyHash: () => 'task',
      _planExecutionGuards: new Map(), completionInvariants: new Map([[1, run]]), _currentCompletionSubmitState(tab) { return this._completionSubmitStates.get(tab) || null; }, _completionSubmitStates: new Map(),
      conversationIds: new Map(), conversations: new Map([[1, messages]]), _completionDocumentStamp: async () => 'document',
      executeTool: async () => ({ success: true, pageContent: 'Requested post published' }), recordSystemOneVerdict() {},
      evaluateSystemOne: async (_tab, _client, args) => { state = args.state; const result = response(JSON.stringify(state).includes('CURRENT') ? 'succeeded' : 'uncertain'); result.model = 'kev-latest'; return result; },
    };
    try {
      for (const compacted of [false, true]) {
        if (compacted) agent.conversations.set(1, structuredClone(messages.slice(1)));
        agent._completionVerdicts?.clear();
        assert.equal((await runtime.verifyBrowserCompletion(agent, 1)).outcome, 'succeeded');
        assert.match(JSON.stringify(state), /CURRENT/); assert.doesNotMatch(JSON.stringify(state), /STALE/);
        assert.deepEqual(state[0].recorded_actions, [{ tool: 'click_ax' }]);
      }
      delete run.historyToolCallIdsBeforeRun; agent._completionVerdicts.clear();
      assert.equal((await runtime.verifyBrowserCompletion(agent, 1)).outcome, 'uncertain', 'unknown read provenance cannot establish task completion');
      assert.deepEqual(state[0].recorded_reads, []); assert.deepEqual(state[0].recorded_actions, []);
    } finally { globalThis.chrome = previousChrome; globalThis.browser = previousBrowser; }
  });
  test(`${build}: completion evidence keeps an earlier page of the run beside repeated reads of the result page, in any language`, async () => {
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ decisionProvider: 'local', systemOneEnabled: true }) } } };
    const provider = { model: 'local', supportsVision: false, config: { category: 'local' } };
    const read = (id, url, text) => [
      { role: 'assistant', tool_calls: [{ id, function: { name: 'read_page' } }] },
      { role: 'tool', tool_call_id: id, content: JSON.stringify({ success: true, url, pageContent: text }) },
    ];
    // The task's rules page, in Turkish, is read first; the published post is
    // then read four times. No word on either page is read to choose them.
    const messages = [
      ...read('rules', 'https://forum.example/r/turkce/kurallar', 'TOPLULUK KURALLARI: bağlantı paylaşmayın'),
      ...read('post-1', 'https://forum.example/r/turkce/post/1', 'POST READ ONE'),
      ...read('post-2', 'https://forum.example/r/turkce/post/1#yorumlar', 'POST READ TWO'),
      ...read('post-3', 'https://forum.example/r/turkce/post/1', 'POST READ THREE'),
      ...read('post-4', 'https://forum.example/r/turkce/post/1', 'POST READ FOUR'),
    ];
    let state;
    const run = { runToken: 'current', historyToolCallIdsBeforeRun: new Set() };
    const agent = {
      _activeProvider: () => provider, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
      _latestTaskText: () => 'Kurallara uyan bir gönderi yayımla', _originalTaskText: () => '', _progressTaskKeyHash: () => 'task',
      _planExecutionGuards: new Map(), completionInvariants: new Map([[1, run]]), _currentCompletionSubmitState(tab) { return this._completionSubmitStates.get(tab) || null; }, _completionSubmitStates: new Map(),
      conversationIds: new Map(), conversations: new Map([[1, messages]]), _completionDocumentStamp: async () => 'document',
      executeTool: async () => ({ success: true, pageContent: 'Requested post published' }), recordSystemOneVerdict() {},
      evaluateSystemOne: async (_tab, _client, args) => { state = args.state; const result = response('succeeded'); result.model = 'kev-latest'; return result; },
    };
    try {
      assert.equal((await runtime.verifyBrowserCompletion(agent, 1)).outcome, 'succeeded');
      const evidence = JSON.stringify(state);
      assert.match(evidence, /TOPLULUK KURALLARI/, 'the rules page read earlier in the run was dropped');
      assert.match(evidence, /POST READ FOUR/, 'the latest read of the result page is missing');
      assert.doesNotMatch(evidence, /POST READ (?:ONE|TWO|THREE)/, 'older reads of the same page crowded the evidence');
    } finally { globalThis.chrome = previousChrome; globalThis.browser = previousBrowser; }
  });
  test(`${build}: stale image verdicts cannot succeed without fresh evidence`, async () => {
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    try {
      for (const engine of ['decision', 'llm']) for (const change of ['canvas', 'image', 'capture_unavailable']) {
        const stored = { decisionProvider: 'local', systemOneEnabled: engine === 'decision', decisionVisionMode: 'on' };
        globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => stored } } };
        let pixels = 'data:image/png;base64,original', captures = 0, requests = 0;
        const active = { model: 'local-model', supportsVision: true, config: { category: 'local' }, ...(engine === 'llm' ? { chat() {} } : {}) };
        const guard = { semanticSubmissionVerified: true, verifiedSubmissionEvidence: true };
        const agent = {
          _activeProvider: () => active, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
          _latestTaskText: () => 'Verify the published image', _originalTaskText: () => '', _progressTaskKeyHash: () => 'task',
          _planExecutionGuards: new Map([[1, guard]]), completionInvariants: new Map([[1, { runToken: 'run', lastAction: { sequence: 1 } }]]),
          _currentCompletionSubmitState(tab) { return this._completionSubmitStates.get(tab) || null; }, _completionSubmitStates: new Map(), conversationIds: new Map(), conversations: new Map(),
          _completionDocumentStamp: async () => 'unchanged-text-and-inputs',
          _captureCompletionJudgeImage: async () => { captures++; return pixels; },
          _budgetForCapture: () => ({ maxTargetPx: 1408, maxTargetTokens: 1400 }), _shrinkImageForBudget: async dataUrl => ({ dataUrl }),
          executeTool: async () => ({ success: true, pageContent: 'AX has no evidence establishing the image contents.' }),
          _newCostRunState: () => ({}), recordSystemOneVerdict() {},
        };
        const changePixels = () => { requests++; pixels = change === 'capture_unavailable' ? null : `data:image/png;base64,changed-${change}`; };
        agent.evaluateSystemOne = async (_tab, _client, args) => {
          const vision = args.state[1].type === 'image_url';
          if (vision) changePixels(); else requests++;
          const result = response(vision ? 'succeeded' : 'uncertain'); result.model = 'kev-latest'; return result;
        };
        agent._chatWithCostAllowance = async (_provider, messages) => {
          const vision = Array.isArray(messages[1].content);
          if (vision) changePixels(); else requests++;
          return { content: JSON.stringify({ outcome: vision ? 'succeeded' : 'uncertain', reason: 'Image details are not verifiable from AX.' }) };
        };
        const verdict = await runtime.verifyBrowserCompletion(agent, 1);
        assert.equal(verdict.outcome, 'uncertain', `${engine}/${change}: stale pixels must not establish success`);
        assert.equal(verdict.engine, 'legacy');
        assert.equal(captures, 2, 'pixels must be captured again after the response');
        assert.equal(requests, 2, 'changed pixels require a new AX judgment, not acceptance of the stale image');
        assert.equal(guard.semanticSubmissionVerified, false);
        assert.equal(guard.verifiedSubmissionEvidence, false);
      }
    } finally {
      globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator;
    }
  });
  test(`${build}: moving pixels fall back to fresh AX and disabled outsourcing retains the approved LLM route`, async () => {
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    try {
      for (const stored of [{ decisionProvider: 'local', systemOneEnabled: true }, {}, { systemOneEnabled: false }, { decisionProvider: 'local', systemOneEnabled: true, systemOneDoneEnabled: false }]) {
        globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ ...stored, decisionVisionMode: 'on' }) } } };
        let captures = 0, reads = 0;
        const calls = [];
        const provider = { model: 'local', supportsVision: true, config: { category: 'local' }, chat() {} };
        const agent = {
          _activeProvider: () => provider, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
          _latestTaskText: () => 'Verify the published post', _originalTaskText: () => '', _progressTaskKeyHash: () => 'task',
          _planExecutionGuards: new Map(), completionInvariants: new Map([[1, { runToken: 'run' }]]),
          _currentCompletionSubmitState(tab) { return this._completionSubmitStates.get(tab) || null; }, _completionSubmitStates: new Map(), conversationIds: new Map(), conversations: new Map(),
          _completionDocumentStamp: async () => 'same-published-document',
          _captureCompletionJudgeImage: async () => `data:image/png;base64,animation-frame-${++captures}`,
          _budgetForCapture: () => ({ maxTargetPx: 1408, maxTargetTokens: 1400 }), _shrinkImageForBudget: async dataUrl => ({ dataUrl }),
          executeTool: async () => { reads++; return { success: true, pageContent: 'Published requested post; no draft or validation error' }; },
          _newCostRunState: () => ({}), recordSystemOneVerdict() {},
          evaluateSystemOne: async (_tab, _client, args) => {
            calls.push('decision:' + (args.state[1].type === 'image_url' ? 'vision' : 'ax'));
            const result = response(); result.model = 'kev-latest'; return result;
          },
          _chatWithCostAllowance: async (_provider, messages) => {
            calls.push('llm:' + (Array.isArray(messages[1].content) ? 'vision' : 'ax'));
            return { content: '{"outcome":"succeeded","reason":"Fresh AX establishes publication"}' };
          },
        };
        const verdict = await runtime.verifyBrowserCompletion(agent, 1);
        const engine = stored.systemOneEnabled === true && stored.systemOneDoneEnabled !== false ? 'decision' : 'llm';
        assert.equal(verdict.outcome, 'succeeded'); assert.equal(verdict.modality, 'ax');
        assert.deepEqual(calls, [`${engine}:vision`, `${engine}:ax`]);
        assert.equal(reads, 2, 'AX evidence must be re-read after its judgment'); assert.equal(captures, 2);
      }
    } finally {
      globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator;
    }
  });
  test(`${build}: finite screenshot budgets preserve freshness capacity or select AX`, async () => {
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    try {
      for (const engine of ['decision', 'llm']) for (const [cap, used, modality] of [[0, 10, 'vision'], [1, 0, 'ax'], [2, 0, 'vision'], [3, 0, 'vision'], [3, 2, 'ax'], [3, 1, 'vision'], [2, 2, 'ax']]) {
        globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ decisionProvider: 'local', systemOneEnabled: engine === 'decision', decisionVisionMode: 'on' }) } } };
        let captures = 0, spent = used, requests = 0;
        const active = { model: 'local-model', supportsVision: true, config: { category: 'local' }, chat() {} };
        const agent = {
          _activeProvider: () => active, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
          _latestTaskText: () => 'Verify publication', _originalTaskText: () => '', _progressTaskKeyHash: () => 'task',
          _planExecutionGuards: new Map(), completionInvariants: new Map([[1, { runToken: 'run' }]]),
          _currentCompletionSubmitState(tab) { return this._completionSubmitStates.get(tab) || null; }, _completionSubmitStates: new Map(), conversationIds: new Map(), conversations: new Map(),
          _completionDocumentStamp: async () => 'stable',
          _canTakeAutoScreenshot: (_tabId, slots = 1) => cap === 0 || spent + slots <= cap,
          _captureCompletionJudgeImage: async () => { if (cap && spent >= cap) return null; spent++; captures++; return 'data:image/png;base64,stable'; },
          _budgetForCapture: () => ({ maxTargetPx: 1408, maxTargetTokens: 1400 }), _shrinkImageForBudget: async dataUrl => ({ dataUrl }),
          executeTool: async () => ({ success: true, pageContent: 'Published requested content' }),
          _newCostRunState: () => ({}), recordSystemOneVerdict() {},
          evaluateSystemOne: async () => { requests++; const result = response(); result.model = 'kev-latest'; return result; },
          _chatWithCostAllowance: async () => { requests++; return { content: '{"outcome":"succeeded","reason":"Published"}' }; },
        };
        const verdict = await runtime.verifyBrowserCompletion(agent, 1);
        assert.equal(verdict.outcome, 'succeeded', `${engine}: cap=${cap}, used=${used}`);
        assert.equal(verdict.modality, modality);
        assert.equal(captures, modality === 'vision' ? 2 : 0);
        assert.equal(requests, 1);
        if (cap === 3 && used === 0) {
          const repeated = await runtime.verifyBrowserCompletion(agent, 1);
          assert.equal(repeated.outcome, 'succeeded'); assert.equal(repeated.modality, 'vision');
          assert.equal(requests, 1, 'a revalidated cached verdict needs no additional judge request');
          assert.equal(captures, 3, 'the matching freshness capture must be reused after the last slot is spent');
        }
        if (cap) assert.ok(spent <= cap, 'freshness must honor the user screenshot cap');
      }
    } finally {
      globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator;
    }
  });
  test(`${build}: a replaced run during the final document read cannot establish completion`, async () => {
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ decisionProvider: 'local', systemOneEnabled: true }) } } };
    let judged = false, current = true;
    const provider = { model: 'local', config: { category: 'local' } };
    const agent = {
      _activeProvider: () => provider, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => current }),
      _latestTaskText: () => 'Verify publication', _originalTaskText: () => '', _progressTaskKeyHash: () => 'task',
      _planExecutionGuards: new Map(), completionInvariants: new Map([[1, { runToken: 'run' }]]),
      _currentCompletionSubmitState(tab) { return this._completionSubmitStates.get(tab) || null; }, _completionSubmitStates: new Map(), conversationIds: new Map(), conversations: new Map(),
      _completionDocumentStamp: async () => { if (judged) current = false; return 'stable'; },
      executeTool: async () => ({ success: true, pageContent: 'Published' }), recordSystemOneVerdict() {},
      evaluateSystemOne: async () => { judged = true; const result = response(); result.model = 'kev-latest'; return result; },
    };
    try {
      const verdict = await runtime.verifyBrowserCompletion(agent, 1);
      assert.equal(verdict.outcome, 'pending');
      assert.equal(verdict.engine, 'freshness');
    } finally { globalThis.chrome = previousChrome; globalThis.browser = previousBrowser; }
  });
}
