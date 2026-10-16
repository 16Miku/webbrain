import assert from 'node:assert/strict';
import { test } from 'node:test';

// Tool-call guards, in both builds:
// - a retired or unadvertised tool is refused before dispatch with specific
//   guidance and counted by name, so repeats are nudged and then stopped; a
//   refusal never counts as progress for, or hides, a real loop, and never
//   hits the per-target or read-only resource counters;
// - a missing required argument is named as missing, apart from invalid ones;
// - the plain-text recovery nudge sends a question to clarify, not to done.
const BUILDS = ['chrome', 'firefox'];

for (const build of BUILDS) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const tools = await import(`../src/${build}/src/agent/tools.js`);
  const { validateToolArguments } = await import(`../src/${build}/src/agent/tool-arguments.js`);

  function makeAgent(tabId) {
    const agent = new Agent({
      getActive: () => ({ contextWindow: 128000, supportsVision: false }),
      getVisionProvider: async () => null,
    });
    agent.conversationModes.set(tabId, 'act');
    agent._persist = () => {};
    const dispatched = [];
    agent.executeTool = async (_tabId, name) => {
      dispatched.push(name);
      return { success: true };
    };
    return { agent, dispatched };
  }

  async function callOnce(agent, tabId, name, args, step, allowed = new Set(['inspect_viewport', 'get_accessibility_tree', 'done'])) {
    const messages = [];
    const updates = [];
    const outcome = await agent._executeToolBatch(
      tabId,
      [{ id: `call_${step}`, function: { name, arguments: JSON.stringify(args) } }],
      messages,
      (type, data) => updates.push({ type, data }),
      { supportsVision: false },
      null,
      allowed,
      step,
    );
    const content = messages.find(message => message.role === 'tool')?.content || '';
    // A refusal's result is JSON; an executed tool's is wrapped page content.
    let result = null;
    try { result = JSON.parse(content.split('\n')[0] || '{}'); } catch {}
    return { outcome, updates, content, result };
  }

  test(`${build}: a retired screenshot tool is refused with guidance instead of a generic denial`, async () => {
    const tabId = 81;
    const { agent, dispatched } = makeAgent(tabId);
    for (const [index, name] of ['full_page_screenshot', 'screenshot'].entries()) {
      const { result, updates } = await callOnce(agent, tabId, name, {}, index + 1);
      assert.deepEqual(dispatched, [], `${name} reached executeTool`);
      assert.equal(result.errorCode, 'retired_tool');
      assert.equal(result.retiredTool, name);
      assert.equal(result.noDispatch, true);
      assert.equal(result.dispatched, false);
      assert.match(result.error, /user-only/);
      assert.match(result.error, /inspect_viewport/);
      assert.match(result.error, /\/screenshot --full-page/);
      assert.ok(updates.some(update => update.type === 'tool_result' && update.data?.result?.errorCode === 'retired_tool'),
        'the UI did not receive the refused result');
      assert.ok(updates.some(update => update.type === 'warning'), 'the refusal no longer warns');
    }
    if (build === 'firefox') {
      const { result } = await callOnce(agent, tabId, 'full_page_screenshot', {}, 3);
      assert.match(result.error, /trusted automation/, 'Firefox full-page capture needs its companion');
    }
  });

  test(`${build}: every retired name is refused as retired, other unadvertised names as unavailable`, async () => {
    const tabId = 82;
    for (const [index, name] of [...tools.RETIRED_AGENT_TOOL_NAMES].entries()) {
      const { agent, dispatched } = makeAgent(tabId);
      const { result } = await callOnce(agent, tabId, name, {}, index + 1);
      assert.equal(result.errorCode, 'retired_tool', `${name} was not refused as retired`);
      assert.match(result.error, new RegExp(`Do not call ${name} again`));
      assert.deepEqual(dispatched, []);
    }
    const { agent: recordAgent } = makeAgent(tabId);
    const record = (await callOnce(recordAgent, tabId, 'record_tab', {}, 1)).result;
    assert.match(record.error, build === 'chrome' ? /\/record/ : /not available in Firefox/);

    for (const [index, name] of ['search_the_web', 'click'].entries()) {
      const { agent, dispatched } = makeAgent(tabId);
      const { result } = await callOnce(agent, tabId, name, { text: 'Save' }, index + 1);
      assert.equal(result.errorCode, 'tool_unavailable', `${name} was not refused as unavailable`);
      assert.equal(result.noDispatch, true);
      assert.match(result.error, /not available in the current mode\/provider tool set/);
      assert.deepEqual(dispatched, []);
    }
  });

  test(`${build}: repeating an unavailable tool is nudged and then stopped`, async () => {
    for (const [tabId, name, reason] of [
      [83, 'full_page_screenshot', 'it is retired'],
      [84, 'search_the_web', 'this run does not offer it'],
      [86, 'click', 'this run does not offer it'],
    ]) {
      const { agent } = makeAgent(tabId);
      const contents = [];
      let stop = null;
      for (let step = 1; step <= 12 && !stop; step++) {
        // Varying arguments must not hide the repetition.
        const call = await callOnce(agent, tabId, name, { attempt: step, ref_id: `ref_${step}` }, step);
        contents.push(call.content);
        if (call.outcome?.action === 'recover') stop = { step, outcome: call.outcome };
      }
      assert.doesNotMatch(contents[1], /LOOP/, `${name}: the second call was nudged`);
      assert.match(contents[2], new RegExp(`\\[UNAVAILABLE TOOL LOOP: You have called ${name} 3 times, but ${reason}, so nothing was run\\. Do not call ${name} again\\.`),
        `${name}: the third call was not nudged`);
      assert.ok(stop, `${name}: repeated calls were never stopped`);
      assert.equal(stop.step, 10, `${name}: the stop budget changed`);
      assert.equal(stop.outcome.status, 'loop_stopped');
      assert.equal(stop.outcome.value, `Stopped: I called ${name} 10 times, but ${reason}, so nothing was run. Please give a different instruction.`);
      for (const text of contents) assert.doesNotMatch(text, /FAILED ACTION LOOP|same target|read-only resource/);
    }
  });

  test(`${build}: refused calls neither retire nor hide a real loop's warnings`, async () => {
    const allowed = new Set(['read_page', 'get_accessibility_tree', 'done']);
    // The stuck call, rejected before dispatch for its arguments each time
    // (the review's probe), or executed and failing each time (there a
    // delivery checkpoint takes over before the loop stop, as before).
    const loops = {
      rejected: { args: { maxChars: 1000 }, stops: true },
      executed: { args: { offset: 0 }, stops: false, executeTool: async () => ({ success: false, error: 'Element not found' }) },
    };
    // Loop state after each stuck attempt, until the run stops (on a stuck
    // attempt, or on the tenth refusal of one name) or 14 attempts.
    async function run(tabId, loop, pattern) {
      const { agent } = makeAgent(tabId);
      if (loop.executeTool) agent.executeTool = loop.executeTool;
      let step = 0;
      const trace = [];
      const refusalNudgeChanges = [];
      for (;;) {
        for (const name of pattern) {
          const before = agent.loopNudges.get(tabId) || 0;
          const call = await callOnce(agent, tabId, name, name === 'read_page' ? loop.args : {}, ++step, allowed);
          if (name !== 'read_page') {
            if (call.outcome?.action === 'recover') return { trace, outcome: call.outcome, stoppedBy: name, refusalNudgeChanges };
            if ((agent.loopNudges.get(tabId) || 0) !== before) refusalNudgeChanges.push(step);
            continue;
          }
          trace.push(`${agent.loopNudges.get(tabId) || 0}:${call.outcome?.status || call.outcome?.action || '-'}`);
          if (call.outcome?.action === 'recover') return { trace, outcome: call.outcome, stoppedBy: name, refusalNudgeChanges };
          if (trace.length >= 14) return { trace, outcome: null, refusalNudgeChanges };
        }
      }
    }
    for (const [kind, loop] of Object.entries(loops)) {
      const alone = await run(87, loop, ['read_page']);
      assert.equal(alone.outcome?.status === 'loop_stopped', loop.stops, `${kind}: ${alone.trace}`);
      for (const [tabId, pattern] of [
        [88, ['read_page', 'read_page', 'read_page', 'screenshot', 'list_tabs']], // two refusals after every third attempt
        [89, ['read_page', 'screenshot', 'list_tabs']], // refusals between every attempt
      ]) {
        const mixed = await run(tabId, loop, pattern);
        assert.deepEqual(mixed.refusalNudgeChanges, [], `${kind} ${pattern}: a refused call changed the loop's nudge count`);
        if (mixed.stoppedBy === 'screenshot') {
          // Its own budget: the tenth screenshot stops the run, which the
          // stuck loop had not done by then; up to there the loop ran as alone.
          assert.match(mixed.outcome.value, /^Stopped: I called screenshot 10 times/);
          assert.deepEqual(mixed.trace, alone.trace.slice(0, mixed.trace.length), `${kind} ${pattern}: refused calls changed the loop`);
          assert.ok(mixed.trace.length < alone.trace.length);
        } else {
          assert.deepEqual(mixed.trace, alone.trace, `${kind} ${pattern}: refused calls changed the loop`);
          if (loop.stops) assert.match(mixed.outcome.value, /looping on the same call to read_page/);
        }
      }
    }
  });

  test(`${build}: unavailable click, navigate and fetch_url are counted by name, not by target`, async () => {
    const askTools = new Set(tools.getToolsForMode('ask', { tier: 'full' }).map(tool => tool.function?.name));
    assert.ok(!askTools.has('click') && !askTools.has('navigate'), 'Ask mode now offers click or navigate');
    const restricted = new Set(['inspect_viewport', 'get_accessibility_tree', 'done']);
    for (const [tabId, name, allowed, argsFor] of [
      [90, 'click', askTools, i => ({ ref_id: `ref_${i}` })],
      [91, 'navigate', askTools, i => ({ url: `https://example.test/${i}` })],
      [92, 'fetch_url', restricted, i => ({ url: `https://example.test/data/${i}.json` })],
    ]) {
      const { agent, dispatched } = makeAgent(tabId);
      const calls = [];
      for (let i = 1; i <= 3; i++) calls.push(await callOnce(agent, tabId, name, argsFor(i), i, allowed));
      assert.deepEqual(dispatched, []);
      assert.ok(calls.every(call => call.outcome?.status !== 'loop_stopped'), `${name}: three calls with different targets stopped the run`);
      assert.doesNotMatch(calls[1].content, /LOOP/, `${name}: the second call was nudged`);
      assert.match(calls[2].content, new RegExp(`UNAVAILABLE TOOL LOOP: You have called ${name} 3 times, but this run does not offer it`));
      for (const call of calls) assert.doesNotMatch(call.content, /FAILED ACTION LOOP|same target|read-only resource/);
      assert.equal(agent.failedActionLoops.has(tabId), false, `${name}: a refusal reached the per-target failure counter`);
      assert.equal(agent.recentCalls.has(tabId), false, `${name}: a refusal entered the exact-call window`);
    }

    // Two clean calls in a row retire the count; a refusal between them does not.
    const tabId = 93;
    const { agent } = makeAgent(tabId);
    let step = 0;
    const click = () => callOnce(agent, tabId, 'click', { ref_id: `ref_${step}` }, ++step, askTools);
    const read = offset => callOnce(agent, tabId, 'read_page', { offset }, ++step, askTools);
    await click(); await click();
    await read(0); await read(100);
    assert.doesNotMatch((await click()).content, /UNAVAILABLE TOOL LOOP/, 'two clean calls did not retire the count');
    await click();
    await read(200);
    await callOnce(agent, tabId, 'screenshot', {}, ++step, askTools);
    await read(300);
    assert.match((await click()).content, /UNAVAILABLE TOOL LOOP: You have called click 3 times/,
      'a refusal between two clean calls retired the count');

    // Other rejections before dispatch keep their accounting: an invalid
    // argument still enters the exact-call window and counts as a clean call.
    const { agent: other } = makeAgent(94);
    const rejected = await callOnce(other, 94, 'read_page', { maxChars: 1000 }, 1, askTools);
    assert.equal(rejected.result.errorCode, 'invalid_tool_arguments');
    assert.equal(other.recentCalls.get(94)?.length, 1);
    assert.equal(other.healthyCallsSinceLoop.get(94), 1);
  });

  test(`${build}: a navigation between refusals does not reset the unavailable-tool count`, () => {
    const tabId = 95;
    const { agent } = makeAgent(tabId);
    const refusal = { success: false, denied: true, noDispatch: true, errorCode: 'retired_tool', error: 'retired' };
    const kinds = [];
    for (let step = 1; step <= 10; step++) {
      const url = `https://example.test/page-${step}`;
      agent._checkLoop(tabId, 'navigate', { url }, { success: true, pageUrlChanged: true, currentUrl: url });
      kinds.push(agent._checkLoop(tabId, 'screenshot', {}, refusal).kind);
    }
    assert.deepEqual(kinds, ['none', 'none', ...Array(7).fill('nudge'), 'stop']);
    // Only the run boundary clears it.
    agent._checkLoop(tabId, 'screenshot', {}, refusal);
    agent._checkLoop(tabId, 'screenshot', {}, refusal);
    agent._clearRunLoopState(tabId);
    assert.equal(agent._checkLoop(tabId, 'screenshot', {}, refusal).kind, 'none');
  });

  test(`${build}: missing required arguments are named apart from invalid ones`, () => {
    const schema = name => tools.AGENT_TOOLS.find(tool => tool.function?.name === name).function.parameters;

    const missing = validateToolArguments('click_ax', {}, schema('click_ax'));
    assert.equal(missing.ok, false);
    assert.equal(missing.result.noDispatch, true);
    assert.equal(missing.result.errorCode, 'invalid_tool_arguments');
    assert.deepEqual(missing.result.invalidArgumentNames, ['$.ref_id'], 'compatibility field changed');
    assert.equal(missing.result.detail, 'Missing required argument(s): $.ref_id.');

    const mixed = validateToolArguments('type_ax', { ref_id: 'ref_2', lang: 'tr' }, schema('type_ax'));
    assert.deepEqual(mixed.result.invalidArgumentNames, ['$.text', '$.lang']);
    assert.equal(mixed.result.detail, 'Missing required argument(s): $.text. Invalid or undeclared argument(s): $.lang.');

    const invalid = validateToolArguments('type_ax', { ref_id: 'ref_2', text: 'hi', lang: 'tr' }, schema('type_ax'));
    assert.equal(invalid.result.detail, 'Invalid or undeclared argument(s): $.lang.');
    assert.doesNotMatch(invalid.result.detail, /Missing/);
  });

  test(`${build}: the plain-text recovery nudge asks through clarify instead of ending the run`, () => {
    const tabId = 85;
    const agent = new Agent({});
    agent.conversations.set(tabId, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Log in to my bank and pay the electricity bill.' },
    ]);
    agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute', requiresStateChange: true });
    const decision = agent._planOnlyTerminalDecision(tabId, 'Which account should I pay from?');
    assert.equal(decision?.retry, true);
    const nudge = decision?.nudge || '';
    assert.match(nudge, /plain text cannot end it/i);
    assert.match(nudge, /missing user value or choice blocks progress, ask with clarify/);
    assert.match(nudge, /require_explicit_answer:true for personal, consent, or credential values/);
    assert.match(nudge, /never use done to ask a question/);
    assert.match(nudge, /if clarify is unavailable, call done with outcome failed or partial/);
    assert.doesNotMatch(nudge, /user input is required, call done/);

    // The argument the nudge names is part of clarify's advertised schema in
    // every Act tier where the nudge can appear.
    for (const tier of ['compact', 'mid', 'full']) {
      const clarify = tools.getToolsForMode('act', { tier }).find(tool => tool.function?.name === 'clarify');
      assert.ok(clarify, `${tier}: clarify is not advertised`);
      assert.ok(clarify.function.parameters.properties.require_explicit_answer, `${tier}: require_explicit_answer is missing`);
    }
  });
}
