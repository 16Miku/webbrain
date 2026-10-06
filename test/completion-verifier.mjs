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
  function response(outcome = 'succeeded') {
    return { model: config.DEFAULT_DECISION_MODEL + '-20261001', provider: 'Perplexity', usage: { input_tokens: 40, output_tokens: 1, cost: .00002 },
      answers: { task_outcome: { type: 'choice', choice: outcome, confidence: .99, probabilities: Object.fromEntries(verifier.COMPLETION_OUTCOMES.map(x => [x, x === outcome ? .97 : .01])) } } };
  }
  test(`${build}: OpenRouter wire, resolved versions and actual costs`, async () => {
    let request, usage;
    const client = judge.createSystemOneJudge({ fetchImpl: async (url, options) => { request = { url, ...options }; return { ok: true, json: async () => response() }; } });
    const result = await client.evaluate({ config: config.resolveDecisionConfig({ decisionApiKey: 'synthetic' }), state: {}, questions: verifier.completionQuestions(), onUsage: m => { usage = m; } });
    assert.equal(request.url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(JSON.parse(request.body).model, config.DEFAULT_DECISION_MODEL);
    assert.equal(usage.estimatedCostUsd, .00002); assert.equal(result.usage.cost, .00002);
    assert.equal(verifier.decisionCompletionVerdict(result).outcome, 'succeeded');
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
  test(`${build}: auth/transport skip engine; unsupported image retries AX`, async () => {
    for (const status of [401, 422]) {
      const calls = [];
      const decision = { name: 'decision', supportsVision: true, evaluate: async (_e, modality) => { calls.push(modality); if (modality === 'vision') throw Object.assign(new Error('HTTP'), { status }); return { outcome: 'failed' }; } };
      const result = await verifier.verifyCompletion({ decision, capture: async () => ({ identity: 'fresh' }), isCurrent: () => true });
      assert.deepEqual(calls, status === 401 ? ['vision'] : ['vision', 'ax']);
      assert.equal(result.outcome, status === 401 ? 'uncertain' : 'failed');
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
      completionInvariants: new Map([[1, { runToken: 'run', lastAction: { sequence: 2, name: 'click' } }]]),
      _completionSubmitStates: new Map([[1, { dispatched: true, observedAfterSubmit: true, currentUrl: 'https://old.reddit.com/comments/new' }]]),
      conversationIds: new Map([[1, 'session']]), conversations: new Map([[1, [
        { role: 'assistant', tool_calls: [{ id: 'rules', function: { name: 'read_page', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'rules', content: '{"text":"Community rules: relevant tools are allowed"}' },
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
        assert.equal(options.tools, undefined); assert.equal(options.maxTokens, 256);
        assert.match(messages[0].content, /Do not call tools/);
        return { content: JSON.stringify({ outcome: llmCalls === 1 ? 'uncertain' : 'succeeded', reason: 'Published resource is visible.' }) };
      };
      verdict = await runtime.verifyBrowserCompletion(agent, 1);
      assert.equal(verdict.engine, 'llm'); assert.equal(verdict.modality, 'ax'); assert.equal(llmCalls, 2, 'active LLM must use its own vision and AX tiers');
      stored.systemOneDoneEnabled = true;
      agent.evaluateSystemOne = async () => { stamp = 'changed-during-verification'; const result = response(); result.model = 'kev-latest'; return result; };
      verdict = await runtime.verifyBrowserCompletion(agent, 1);
      assert.equal(verdict.outcome, 'pending'); assert.equal(verdict.engine, 'freshness');
    } finally {
      globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator;
    }
  });
  test(`${build}: runtime revalidates pixels changed during a decision or LLM request`, async () => {
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    try {
      for (const engine of ['decision', 'llm']) for (const change of ['canvas', 'image', 'capture_unavailable']) {
        const stored = { decisionProvider: 'local', systemOneEnabled: engine === 'decision', decisionVisionMode: 'on' };
        globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => stored } } };
        let pixels = 'data:image/png;base64,original', captures = 0, requests = 0;
        const active = { model: 'local-model', supportsVision: true, config: { category: 'local' }, chat() {} };
        const guard = { semanticSubmissionVerified: true, verifiedSubmissionEvidence: true };
        const agent = {
          _activeProvider: () => active, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
          _latestTaskText: () => 'Verify the published image', _originalTaskText: () => '', _progressTaskKeyHash: () => 'task',
          _planExecutionGuards: new Map([[1, guard]]), completionInvariants: new Map([[1, { runToken: 'run', lastAction: { sequence: 1 } }]]),
          _completionSubmitStates: new Map(), conversationIds: new Map(), conversations: new Map(),
          _completionDocumentStamp: async () => 'unchanged-text-and-inputs',
          _captureCompletionJudgeImage: async () => { captures++; return pixels; },
          _budgetForCapture: () => ({ maxTargetPx: 1408, maxTargetTokens: 1400 }), _shrinkImageForBudget: async dataUrl => ({ dataUrl }),
          executeTool: async () => { throw new Error('Stale pixels must not be reversed by an AX judge'); },
          _newCostRunState: () => ({}), recordSystemOneVerdict() {},
        };
        const changePixels = () => { requests++; pixels = change === 'capture_unavailable' ? null : `data:image/png;base64,changed-${change}`; };
        agent.evaluateSystemOne = async () => { changePixels(); const result = response(); result.model = 'kev-latest'; return result; };
        agent._chatWithCostAllowance = async () => { changePixels(); return { content: '{"outcome":"succeeded","reason":"Image matches"}' }; };
        const verdict = await runtime.verifyBrowserCompletion(agent, 1);
        assert.equal(verdict.outcome, 'pending', `${engine}/${change}: stale pixels must not establish success`);
        assert.equal(verdict.engine, 'freshness');
        assert.equal(captures, 2, 'pixels must be captured again after the response');
        assert.equal(requests, 1, 'a stale response must not fall through to another judge');
        assert.equal(guard.semanticSubmissionVerified, false);
        assert.equal(guard.verifiedSubmissionEvidence, false);
      }
    } finally {
      globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator;
    }
  });
}
