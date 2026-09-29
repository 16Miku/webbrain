import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const captchaNames = ['get_captcha_capabilities', 'solve_captcha', 'apply_captcha_solution'];
const solverInstructions = /get_captcha_capabilities|solve_captcha|apply_captcha_solution|\[CAPTCHA SOLVER/;
test('CAPTCHA tool matrix matches Ask, Compact, Mid, Full and Dev availability', async () => {
  const rows = (await readFile(new URL('../docs/agent-tools.md', import.meta.url), 'utf8')).split('\n');
  for (const name of captchaNames) {
    const row = rows.find(line => line.startsWith(`| \`${name}\` |`));
    assert.ok(row, name);
    assert.deepEqual(row.split('|').slice(2, -1).map(cell => cell.trim()), ['No', 'No', 'Yes', 'Yes', 'Yes'], name);
  }
});
for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { getToolsForMode } = await import(`../src/${build}/src/agent/tools.js`);
  const { Capability, capabilitiesFor, requiredHosts } = await import(`../src/${build}/src/agent/permission-gate.js`);
  test(`${build}: CAPTCHA bindings require their mutation permissions for the selected frame host`, () => {
    const args = { frameId: 3, frameUrl: 'https://captcha.example.test/challenge', callback: { name: 'app.deleteAccount', path: 'token' } };
    assert.deepEqual(capabilitiesFor('apply_captcha_solution', args), [Capability.EXECUTE_JS]);
    assert.deepEqual(capabilitiesFor('apply_captcha_solution', { ...args, callback: undefined, fields: [{ selector: '#answer', path: 'token' }] }), [Capability.TYPE]);
    assert.deepEqual(capabilitiesFor('apply_captcha_solution', { ...args, callback: undefined, clicks: [{ selector: '#grid', path: 'points' }] }), [Capability.CLICK]);
    assert.deepEqual(capabilitiesFor('apply_captcha_solution', { ...args, callback: undefined, cookies: [{ name: 'clearance', path: 'cookie' }] }), [Capability.EXECUTE_JS]);
    assert.deepEqual(capabilitiesFor('apply_captcha_solution', { ...args, fields: [{}], clicks: [{}], cookies: [{}] }), [Capability.TYPE, Capability.CLICK, Capability.EXECUTE_JS]);
    assert.deepEqual(requiredHosts(Capability.EXECUTE_JS, args, 'https://main.example.test/', 'apply_captcha_solution'), ['captcha.example.test']);
    assert.deepEqual(requiredHosts(Capability.CLICK, args, 'https://main.example.test/', 'apply_captcha_solution'), ['captcha.example.test']);
    assert.deepEqual(capabilitiesFor('apply_captcha_solution', { ...args, callback: undefined }), []);
    assert.deepEqual(requiredHosts(Capability.EXECUTE_JS, { ...args, frameUrl: '' }, 'https://main.example.test/', 'apply_captcha_solution'), []);
  });
  test(`${build}: hCaptcha Enterprise rqdata is optional in the model-visible tool schema`, () => {
    const solve = getToolsForMode('act', { tier: 'full' }).find(tool => tool.function.name === 'solve_captcha');
    assert.match(solve.function.parameters.properties.rqdata.description, /optional.*when the widget exposes it/i);
    assert.doesNotMatch(solve.function.parameters.properties.rqdata.description, /required/i);
  });
  function agentFor(mode, tier, enabled = true) {
    const agent = new Agent({ getActive: () => ({ promptTier: tier }) });
    agent.conversationModes.set(1, mode);
    agent.captchaSolverEnabled = enabled;
    agent.captchaProviderIds = enabled ? ['nonecap'] : [];
    return agent;
  }
  for (const mode of ['ask', 'act', 'dev']) for (const tier of ['compact', 'mid', 'full']) {
    test(`${build}: CAPTCHA tools, prompts and runtime gates agree in ${mode}/${tier}`, () => {
      const available = mode !== 'ask' && tier !== 'compact';
      const names = new Set(getToolsForMode(mode, { tier }).map(t => t.function.name));
      for (const name of captchaNames) assert.equal(names.has(name), available, name);
      for (const enabled of [false, true]) {
        const agent = agentFor(mode, tier, enabled);
        const prompt = agent._buildSystemPrompt(mode, 1);
        assert.equal(prompt.includes('[CAPTCHA SOLVER —'), available && enabled);
        if (!available) assert.doesNotMatch(prompt, solverInstructions);
        if (mode === 'act' && tier === 'compact') assert.match(prompt, /CAPTCHA:.*manually.*outcome:"partial"/);
        for (const status of ['solve_required', 'manual_required', 'verification_pending']) {
          const gate = { status, publicGate: { status } };
          agent._captchaGateStates.set(1, gate);
          const message = agent._captchaRoutingMessage(1, gate.publicGate);
          const blocked = agent._captchaGateBlockResult(1, 'click', {});
          assert.equal(blocked.denied, true);
          if (!available) {
            assert.doesNotMatch(message, solverInstructions);
            assert.doesNotMatch(blocked.error, solverInstructions);
            assert.match(message, /manually/);
            assert.equal(blocked.manualCompletionRequired, true);
            assert.equal(agent._captchaGateBlockResult(1, 'done', { outcome: 'partial' }), null);
            assert.equal(agent._captchaGateBlockResult(1, 'done', { outcome: 'success' }).denied, true);
          }
          assert.equal(agent._canTryNativeCaptcha(1, gate), available && enabled);
        }
      }
    });
  }
  test(`${build}: run overrides and tier switches remove stale solver routing`, async () => {
    const agent = agentFor('act', 'full');
    agent._runModeOverrides.set(1, 'ask');
    assert.equal(agent._captchaToolsAvailable(1), false);
    agent._captchaGateStates.set(1, { status: 'solve_required', publicGate: { status: 'solve_required' } });
    agent._activeCloudflareManagedChallengeGate = () => {
      const publicGate = { status: 'manual_required', cloudflareManagedChallenge: true };
      agent._captchaGateStates.set(1, { status: 'manual_required', publicGate });
      return publicGate;
    };
    const observation = await agent._observeCaptchaChallenge(1, 'get_accessibility_tree', { pageContent: 'Verification required' });
    assert.equal(observation.gate.toolsUnavailable, true);
    assert.doesNotMatch(agent._captchaRoutingMessage(1, observation.gate), solverInstructions);
    assert.equal(agent._captchaGateBlockResult(1, 'done', { outcome: 'partial' }), null);
    agent._runModeOverrides.delete(1);
    agent._resolvePromptTier = () => 'compact';
    agent._captchaGateStates.set(1, { status: 'solve_required', publicGate: { status: 'solve_required' } });
    assert.equal(agent._captchaGateBlockResult(1, 'click', {}).manualCompletionRequired, true);
    agent._resolvePromptTier = () => 'mid';
    assert.equal(agent._captchaGateBlockResult(1, 'solve_captcha', {}), null);
    assert.equal(agent._captchaGateStates.get(1).status, 'solve_required');
  });
  test(`${build}: native application clears an unrecognized gate only after complete fresh confirmation`, async () => {
    const agent = agentFor('act', 'full');
    agent._activeCloudflareManagedChallengeGate = () => null;
    agent._checkVerificationChallengeLoop = () => ({ kind: 'none' });
    const pageUrl = 'https://example.test/form';
    for (const scenario of [
      { applied: false, complete: true, root: true, expected: 'verification_pending' },
      { applied: true, complete: false, root: true, expected: 'verification_pending' },
      { applied: true, complete: true, root: false, expected: 'verification_pending' },
      { applied: true, complete: true, root: true, expected: 'cleared' },
    ]) {
      agent._captchaGateStates.set(1, { status: 'verification_pending', challengeFrameId: 0, publicGate: { status: 'verification_pending', solveAttempted: true } });
      agent._nativeCaptchaSolutions = new Map([[1, { pageUrl, solution: { token: 'answer' }, applied: scenario.applied, applicationSucceeded: scenario.applied }]]);
      agent._detectChallengeDialogBeforeMutation = async () => ({ inspectionComplete: scenario.complete, challenge: null });
      const result = await agent._observeCaptchaChallenge(1, 'get_accessibility_tree', { pageUrl, pageContent: 'heading "Verification complete"', truncated: !scenario.root });
      assert.equal(result.gate.status, scenario.expected);
      if (scenario.expected === 'cleared') {
        assert.equal(result.gate.clearedByNativeApplication, true);
        assert.equal(agent._captchaGateBlockResult(1, 'click', {}), null);
      } else {
        assert.equal(agent._captchaGateBlockResult(1, 'click', {}).denied, true);
        if (!scenario.applied) assert.match(agent._captchaRoutingMessage(1, result.gate), /use apply_captcha_solution/);
      }
    }
  });
  test(`${build}: navigation retires an unapplied answer but retains its paid-dispatch history`, async () => {
    const agent = agentFor('act', 'full');
    const from = 'https://example.test/first';
    const to = 'https://example.test/second';
    const record = { pageUrl: from, solution: false, applied: false, dispatchedTimeOrigins: new Set([1000]) };
    agent._nativeCaptchaSolutions = new Map([[1, record]]);
    agent._captchaGateStates.set(1, { status: 'verification_pending', publicGate: { status: 'verification_pending' } });
    assert.equal(agent._hasUnappliedNativeCaptchaSolution(1), true);
    agent._clearCaptchaGateAfterNavigation(1, 'navigate', from, to, {});
    assert.equal(agent._hasUnappliedNativeCaptchaSolution(1), false);
    assert.equal(record.dispatchedTimeOrigins.has(1000), true);
    assert.equal(agent._captchaGateStates.has(1), false);
    agent._captchaGateStates.set(1, { status: 'solve_required', publicGate: { status: 'solve_required' } });
    assert.equal(agent._captchaGateBlockResult(1, 'apply_captcha_solution', {}).denied, true);
    assert.equal(agent._captchaGateBlockResult(1, 'solve_captcha', {}), null);

    record.solution = 0;
    agent._captchaGateStates.delete(1);
    agent._currentUrl = async () => to;
    agent._activeCloudflareManagedChallengeGate = () => null;
    agent._checkVerificationChallengeLoop = () => ({ kind: 'none' });
    await agent._observeCaptchaChallenge(1, 'get_accessibility_tree', { pageUrl: to, pageContent: 'heading "Next page"' });
    assert.equal(agent._hasUnappliedNativeCaptchaSolution(1), false);
    assert.equal(record.dispatchedTimeOrigins.has(1000), true);
  });
  test(`${build}: a same-URL reload retires the answer and releases the previous gate`, async () => {
    const agent = agentFor('act', 'full');
    const pageUrl = 'https://example.test/challenge';
    const record = { pageUrl, createdAt: Date.now(), applied: false, solution: { token: 'answer' },
      documents: [{ frameId: 0, url: pageUrl, timeOrigin: 1000 }], dispatchedTimeOrigins: new Set([1000]) };
    agent._nativeCaptchaSolutions = new Map([[1, record]]);
    agent._captchaGateStates.set(1, { status: 'verification_pending', publicGate: { status: 'verification_pending' } });
    const api = {
      tabs: {
        get: async () => ({ url: pageUrl }),
        executeScript: async (_tabId, options) => [options.code.includes('performance.timeOrigin') && !options.code.includes('applyCaptchaValuesInPage')
          ? { url: pageUrl, timeOrigin: 2000 } : { success: false, error: 'CAPTCHA frame navigated before application.' }],
      },
      scripting: build === 'chrome' ? { executeScript: async options => [{ frameId: 0, result: options.func.name === 'read'
        ? { url: pageUrl, timeOrigin: 2000 } : { success: false, error: 'CAPTCHA frame navigated before application.' } }] } : undefined,
      webNavigation: { getAllFrames: async () => [{ frameId: 0, url: pageUrl }] },
    };
    const key = build === 'chrome' ? 'chrome' : 'browser';
    const previous = globalThis[key];
    globalThis[key] = api;
    try {
      const result = await agent._executeToolImpl(1, 'apply_captcha_solution', { frameId: 0, frameUrl: pageUrl,
        fields: [{ selector: '#response', path: 'token' }] });
      assert.equal(result.applicationRetryable, false);
      assert.equal(record.solution, undefined);
      assert.equal(record.dispatchedTimeOrigins.has(1000), true);
      assert.equal(agent._captchaGateStates.has(1), false);
    } finally {
      if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
    }
  });
}
