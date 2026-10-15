// Ordinary clarification and its timeout guard, in both builds:
// - recipient purposes stay valid when research escalation is off;
// - Ask's research note does not send the model to a clarify it cannot use;
// - a timed-out clarification's block counter restarts with each user turn
//   while the guard itself stays armed and is announced in the system prompt,
//   in words that are also true when the scheduler armed it;
// - every scheduled task run, recurring or one-shot, drops the planner's
//   schedule_task requirement (a scheduled resume keeps it), and a one-shot
//   run that sets up a different schedule can still call schedule_task;
// - a real planner question reports that the run ended waiting for the user,
//   and that report pauses a recurring scheduled task.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
};
globalThis.chrome = api;
globalThis.browser = api;

const builds = await Promise.all(['chrome', 'firefox'].map(async build => ({
  build,
  Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
  tools: await import(`../src/${build}/src/agent/tools.js`),
  args: await import(`../src/${build}/src/agent/tool-arguments.js`),
  research: await import(`../src/${build}/src/agent/research-escalation.js`),
  Scheduler: await import(`../src/${build}/src/agent/scheduler.js`),
})));

const STILL_REQUIRED = /CLARIFICATION STILL REQUIRED/;

function plannerResult(kind, summary, overrides = {}) {
  return {
    request_kind: kind,
    requires_state_change: kind === 'execute',
    requires_submission: false,
    read_scope: 'none',
    summary,
    steps: kind === 'plan_only' ? [{ id: '1', action: summary }] : [],
    memory: {},
    scheduling: null,
    risks: [],
    localized: { locale: 'en', summary, steps: kind === 'plan_only' ? [{ id: '1', action: summary }] : [], risks: [] },
    ...overrides,
  };
}

// The real planner gate and run loop; only the model, storage, trace and tab
// transports are replaced, and no tool may run.
function plannerAgent(Agent, plan, plannerMode) {
  const provider = {
    name: 'owned', model: 'owned', promptTier: 'full', contextWindow: 128000,
    supportsTools: false, supportsVision: false,
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  const plannerCalls = [];
  Object.assign(agent, {
    _hydrate: async () => {},
    _persist: () => {},
    _persistNow: async () => ({ ok: true }),
    _persistSubmittedTurn: async () => {},
    _startTraceRun: async () => null,
    _endTraceRun: async () => {},
    _enrichUserMessageWithCurrentPage: async (_tab, _messages, content) => ({ role: 'user', content }),
    _beginReadCompleteness: async () => null,
    _manageContext: async () => {},
    _checkCostAllowance: async () => null,
    _recordCostUsage: async () => null,
    _currentUrl: async () => 'https://example.com/',
    _getTabUrlTitle: async () => ({ tabUrl: 'https://example.com/', tabTitle: 'Example' }),
    _plannerMode: () => plannerMode,
    _waitForPlanReview: async () => assert.fail('a planner question needs no plan review'),
    _chatWithCostAllowance: async (_provider, messages, _options, _cost, meta) => {
      plannerCalls.push(meta?.generationName || 'chat');
      if (!/^planner/.test(meta?.generationName || '')) assert.fail(`unexpected model call ${meta?.generationName}`);
      return { content: JSON.stringify(plan) };
    },
    executeTool: async name => assert.fail(`no tool may run after a planner question (${name})`),
  });
  agent.plannerCalls = plannerCalls;
  return agent;
}

function guardedAgent(Agent, tabId) {
  const agent = new Agent({ getVisionProvider: async () => null });
  agent.conversations.set(tabId, [{ role: 'system', content: 'system' }]);
  agent.conversationIds.set(tabId, `conv_${tabId}`);
  agent.conversationModes.set(tabId, 'act');
  agent._persist = () => {};
  agent._persistNow = async () => true;
  agent._ensureGateSetting = async () => {};
  agent.executeTool = async () => ({ done: true, summary: 'should not run', outcome: 'success' });
  return agent;
}

function doneSuccessBatch(agent, tabId) {
  return agent._executeToolBatch(
    tabId,
    [{ id: `done_${Math.random().toString(36).slice(2)}`, function: { name: 'done', arguments: JSON.stringify({ summary: 'Finished.', outcome: 'success' }) } }],
    [],
    () => {},
    { supportsVision: false },
    '',
    new Set(['done']),
    1,
  );
}

for (const { build, Agent, tools, args, research, Scheduler } of builds) {
  test(`${build}: ordinary clarify keeps the recipient purposes when research escalation is off`, () => {
    for (const [mode, tier] of [['act', 'compact'], ['act', 'mid'], ['act', 'full'], ['dev', 'mid'], ['dev', 'full']]) {
      const clarify = tools.getToolsForMode(mode, { tier, researchEscalationEnabled: false })
        .find(tool => tool.function.name === 'clarify');
      const parameters = clarify.function.parameters;
      assert.deepEqual(parameters.properties.purpose.enum, ['message_recipient', 'recipient_change'], `${mode}/${tier}`);
      assert.doesNotMatch(parameters.properties.purpose.description, /research/i, `${mode}/${tier}`);
      assert.equal('research_request' in parameters.properties, false, `${mode}/${tier}`);
      assert.equal('approve_option' in parameters.properties, false, `${mode}/${tier}`);
      for (const purpose of ['message_recipient', 'recipient_change']) {
        const result = args.validateToolArguments('clarify', { question: 'Who should receive the message?', purpose }, parameters);
        assert.equal(result.ok, true, `${mode}/${tier}: ${purpose} was rejected`);
      }
      const delegated = args.validateToolArguments('clarify', {
        question: 'Send this to ChatGPT?', options: ['Continue here', 'Use ChatGPT'],
        purpose: 'research_escalation', research_request: 'Compare fares.', approve_option: 'Use ChatGPT',
      }, parameters);
      assert.equal(delegated.ok, false, `${mode}/${tier}: research purpose must stay opt-in`);
      assert.ok(delegated.result.invalidArgumentNames.includes('$.purpose'));
    }
    const enabled = tools.getToolsForMode('act', { researchEscalationEnabled: true })
      .find(tool => tool.function.name === 'clarify');
    assert.deepEqual(enabled.function.parameters.properties.purpose.enum, ['research_escalation', 'message_recipient', 'recipient_change']);
  });

  test(`${build}: the clarify handler accepts a recipient purpose with research escalation off`, async () => {
    const agent = new Agent({});
    const tabId = 6101;
    agent.researchEscalationEnabled = false;
    agent._persist = () => {};
    agent._persistNow = async () => true;
    let card = null;
    const result = await agent.executeTool(tabId, 'clarify', {
      question: 'Who should receive the message?', options: ['Ayşe', 'Mehmet'], purpose: 'message_recipient',
    }, (type, data) => {
      if (type !== 'clarify') return;
      card = data;
      agent.submitClarifyResponse(tabId, data.clarifyId, 'Ayşe', 'user');
    });
    assert.equal(card?.question, 'Who should receive the message?');
    assert.equal(result.success, true);
    assert.equal(result.answer, 'Ayşe');
    assert.equal(result.authorized, true);
    assert.equal('researchEscalationApproved' in result, false);
    const refused = await agent.executeTool(tabId, 'clarify', {
      question: 'Send this to ChatGPT?', options: ['Continue here', 'Use ChatGPT'],
      purpose: 'research_escalation', research_request: 'Compare fares.', approve_option: 'Use ChatGPT',
    }, () => assert.fail('a disabled research escalation must not show a card'));
    assert.equal(refused.success, false);
    assert.match(refused.error, /Research escalation is disabled/);
  });

  test(`${build}: Ask's research note asks for missing constraints in the answer, not with clarify`, () => {
    const ask = research.researchEscalationSystemNote('ask');
    assert.match(ask, /ask the user for it in your final answer/);
    assert.match(ask, /in Ask mode, clarify is only this ChatGPT consent card/);
    assert.doesNotMatch(ask, /Clarify any material missing constraint/);
    assert.doesNotMatch(ask, /require_explicit_answer/);
    assert.match(ask, /call clarify with purpose="research_escalation"/);
    for (const mode of ['act', 'dev']) {
      assert.equal(research.researchEscalationSystemNote(mode), research.RESEARCH_ESCALATION_SYSTEM_NOTE, mode);
    }
    assert.match(research.RESEARCH_ESCALATION_SYSTEM_NOTE, /Clarify any material missing constraint with the user instead of guessing it\./);

    const agent = new Agent({});
    agent.researchEscalationEnabled = true;
    const askPrompt = agent._buildSystemPrompt('ask', null);
    assert.ok(askPrompt.includes(ask), 'Ask prompt should carry the Ask note');
    assert.doesNotMatch(askPrompt, /Clarify any material missing constraint/);
    for (const mode of ['act', 'dev']) {
      assert.ok(agent._buildSystemPrompt(mode, null).includes(research.RESEARCH_ESCALATION_SYSTEM_NOTE), mode);
    }
    agent.researchEscalationEnabled = false;
    assert.doesNotMatch(agent._buildSystemPrompt('ask', null), /RESEARCH ESCALATION/);
  });

  test(`${build}: a new user turn restarts the timeout block count but keeps the guard armed`, async () => {
    const tabId = 6201;
    const agent = guardedAgent(Agent, tabId);
    await agent._recordClarificationAuthorization(tabId, 'timeout');
    assert.equal(agent._clarificationAuthorizationBlock(tabId, 'done', { outcome: 'success' }, []).stop, false);
    assert.equal(agent._clarificationAuthorizationGuards.get(tabId).blockedAttempts, 1);

    // Not the user's new turn: Continue, scheduled and cloud runs, and the
    // workflow-replay entry that passes no run options.
    for (const runOptions of [
      undefined,
      null,
      { trustedContinuation: true },
      { scheduledRun: true, independentRun: true },
      { scheduledRun: true, independentRun: true, scheduledResume: true },
      { cloudRun: true, independentRun: true },
      { cloudRun: true, trustedContinuation: true, scheduledResume: true },
      { interactiveChat: true, steeringRevision: 2 },
    ]) {
      agent._prepareClarificationAuthorizationForRun(tabId, runOptions);
      assert.equal(agent._clarificationAuthorizationGuards.get(tabId).blockedAttempts, 1, JSON.stringify(runOptions));
    }

    for (const runOptions of [{ interactiveChat: true, detachedRequestId: 'req-2' }, {}]) {
      agent._clarificationAuthorizationGuards.get(tabId).blockedAttempts = 1;
      agent._prepareClarificationAuthorizationForRun(tabId, runOptions);
      const guard = agent._clarificationAuthorizationGuards.get(tabId);
      assert.equal(guard.blockedAttempts, 0, JSON.stringify(runOptions));
      assert.equal(guard.source, 'timeout');
      assert.equal(guard.authorized, false, 'the guard itself must stay armed');
      assert.equal(agent._conversationStorageEntry(tabId).clarificationAuthorizationGuard.blockedAttempts, 0);
    }

    const first = agent._clarificationAuthorizationBlock(tabId, 'solve_captcha', {}, []);
    assert.equal(first.stop, false, 'the first block of the new turn must let the model ask again');
    assert.match(first.result.error, /Call clarify again/);
    assert.equal(agent._clarificationAuthorizationBlock(tabId, 'solve_captcha', {}, []).stop, true,
      'a repeated block in the same turn still stops');
  });

  test(`${build}: after an earlier blocked turn, the next turn's first blocked success asks again instead of stopping`, async () => {
    const tabId = 6301;
    const agent = guardedAgent(Agent, tabId);
    await agent._recordClarificationAuthorization(tabId, 'timeout');
    assert.deepEqual(await doneSuccessBatch(agent, tabId), { action: 'continue' });

    agent._prepareClarificationAuthorizationForRun(tabId, { interactiveChat: true });
    assert.deepEqual(await doneSuccessBatch(agent, tabId), { action: 'continue' });
    const repeated = await doneSuccessBatch(agent, tabId);
    assert.equal(repeated.action, 'return');
    assert.equal(repeated.status, 'clarification_required');

    // Continue resumes the same turn, so its count carries over unchanged.
    agent._prepareClarificationAuthorizationForRun(tabId, { trustedContinuation: true });
    assert.equal((await doneSuccessBatch(agent, tabId)).status, 'clarification_required');
  });

  test(`${build}: both run entry points hand their run options to the guard`, async () => {
    const agent = new Agent({});
    const tabId = 6401;
    agent._hydrate = async () => {};
    const seen = [];
    const sentinel = new Error('stop after guard preparation');
    agent._prepareClarificationAuthorizationForRun = (_tabId, runOptions) => {
      seen.push(runOptions);
      throw sentinel;
    };
    await assert.rejects(agent._processMessageInner(tabId, 'Check it.', () => {}, 'act', [], { scheduledRun: true, marker: 'inner' }), sentinel);
    await assert.rejects(agent._processMessageStreamInner(tabId, 'Check it.', () => {}, 'act', { interactiveChat: true, marker: 'stream' }), sentinel);
    assert.deepEqual(seen.map(options => options?.marker), ['inner', 'stream']);
    assert.equal(seen[0].scheduledRun, true);
  });

  test(`${build}: the system prompt announces an armed timeout guard only in Act and Dev`, async () => {
    const tabId = 6501;
    const agent = guardedAgent(Agent, tabId);
    assert.doesNotMatch(agent._buildSystemPrompt('act', tabId), STILL_REQUIRED);

    await agent._recordClarificationAuthorization(tabId, 'timeout');
    assert.match(agent.conversations.get(tabId)[0].content, STILL_REQUIRED, 'arming the guard refreshes the live system prompt');
    const actPrompt = agent._buildSystemPrompt('act', tabId);
    assert.match(actPrompt, STILL_REQUIRED);
    assert.match(actPrompt, /stay blocked until the user answers a clarify question directly; an automatic or timed-out choice is not the user's decision/);
    assert.match(actPrompt, /Before any consequential action, call clarify and wait for the answer/);
    assert.match(actPrompt, /if the user's latest message already gives that answer, offer it as the first option/);
    assert.match(agent._buildSystemPrompt('dev', tabId), STILL_REQUIRED);
    assert.doesNotMatch(agent._buildSystemPrompt('ask', tabId), STILL_REQUIRED, 'Ask has no ordinary clarify');

    agent.conversationIds.set(tabId, 'another_conversation');
    assert.doesNotMatch(agent._buildSystemPrompt('act', tabId), STILL_REQUIRED, 'a guard from another conversation is stale');
    agent.conversationIds.set(tabId, `conv_${tabId}`);

    // Only a direct answer on a clarify card clears the guard.
    await agent._recordClarificationAuthorization(tabId, 'user');
    assert.equal(agent._clarificationAuthorizationGuards.has(tabId), false);
    assert.doesNotMatch(agent.conversations.get(tabId)[0].content, STILL_REQUIRED, 'answering refreshes the live system prompt');
    assert.doesNotMatch(agent._buildSystemPrompt('act', tabId), STILL_REQUIRED);
  });

  test(`${build}: the guard line stays true when the scheduler armed it and nothing timed out`, async () => {
    const tabId = 6511;
    const agent = guardedAgent(Agent, tabId);
    agent._hydrate = async () => {};
    // The scheduler arms the guard before a run whose earlier action must be
    // reconciled; no clarify question was ever asked.
    await agent.requireExplicitClarificationAuthorization(tabId);
    const prompt = agent._buildSystemPrompt('act', tabId);
    const line = prompt.slice(prompt.indexOf('[CLARIFICATION STILL REQUIRED'));
    assert.match(line, STILL_REQUIRED);
    assert.doesNotMatch(line.slice(0, line.indexOf(']') + 1), /timed out without|earlier clarify question|call clarify again|answers that question/,
      'the line must not claim that an earlier question timed out');
  });

  test(`${build}: every scheduled task run drops the schedule_task requirement; a scheduled resume keeps it`, () => {
    const agent = new Agent({});
    const tabId = 6601;
    agent._persist = () => {};
    agent.conversationIds.set(tabId, `conv_${tabId}`);
    const gate = { proceed: true, requestKind: 'execute', requiresStateChange: true, requiredSchedulingTool: 'schedule_task' };
    for (const [task, runOptions, expected] of [
      // The stored prompt keeps the user's timing; requiring a schedule made
      // the run schedule its own task again, recurring or one-shot.
      ['Every 5 minutes, check the page for a new release.', { scheduledRun: true, independentRun: true, scheduledResume: false }, null],
      ['In 30 minutes, remind me to take the pizza out.', { scheduledRun: true, independentRun: true, scheduledResume: false }, null],
      ['In 30 minutes, remind me to take the pizza out.', { scheduledRun: true, independentRun: true }, null],
      // A resume continues an interactive task that asked for a schedule.
      ['Wait for the deploy, then schedule the hourly check.', { scheduledRun: true, independentRun: true, scheduledResume: true }, 'schedule_task'],
      ['In 30 minutes, remind me to take the pizza out.', { interactiveChat: true }, 'schedule_task'],
    ]) {
      agent.conversations.set(tabId, [
        { role: 'system', content: 'system' },
        { role: 'user', content: `[Scheduled task task_1: Task]\nTask: ${task}` },
      ]);
      const label = `${task} ${JSON.stringify(runOptions)}`;
      const guard = agent._startPlanExecutionGuard(tabId, 'act', gate, runOptions);
      assert.equal(guard.requiredSchedulingTool, expected, label);
      const decision = agent._planOnlyTerminalDecision(tabId, 'Time to take the pizza out.', { viaDone: true, outcome: 'success' });
      if (expected) assert.match(decision.nudge, /requires a successful schedule_task call/, label);
      else assert.doesNotMatch(String(decision?.nudge || decision?.failure || ''), /schedule_task/, label);
    }
  });

  // Drives one scheduled run through the real scheduler and the agent's real
  // plan guard and tool dispatch; only the model's choices are scripted.
  async function scheduledOneShotRun({ prompt, toolCalls }) {
    const NOW = Date.UTC(2026, 9, 15, 9, 0, 0);
    const agent = new Agent({ getVisionProvider: async () => null });
    Object.assign(agent, { _persist: () => {}, _persistNow: async () => true, _skipPermissionGate: true, _ensureGateSetting: async () => true });
    const seen = {};
    const h = makeSchedulerHarness(Scheduler, {
      now: NOW,
      processMessage: async (tabId, message, onUpdate, mode, _attachments, runOptions) => {
        seen.message = message;
        agent.conversationIds.set(tabId, 'conv-1');
        agent.conversations.set(tabId, [{ role: 'system', content: 'system' }, { role: 'user', content: message }]);
        // What the planner sets when the prompt reads as a scheduling request.
        seen.guard = agent._startPlanExecutionGuard(tabId, mode, {
          proceed: true, requestKind: 'execute', requiresStateChange: true, requiredSchedulingTool: 'schedule_task',
        }, runOptions);
        seen.results = [];
        for (const [index, [name, args]] of toolCalls.entries()) {
          const messages = [];
          await agent._executeToolBatch(tabId, [{ id: `call_${index}`, function: { name, arguments: JSON.stringify(args) } }],
            messages, onUpdate, { supportsVision: false }, '', new Set([name, 'done']), index + 1, runOptions);
          seen.results.push(JSON.parse(messages.find(entry => entry.role === 'tool')?.content || 'null'));
        }
        seen.decision = agent._planOnlyTerminalDecision(tabId, 'Finished.', { viaDone: true, outcome: 'success' });
        onUpdate('tool_result', { name: 'done', result: { done: true, summary: 'Finished.', outcome: 'success' } });
        return 'Finished.';
      },
    });
    agent.scheduler = h.manager;
    const once = await h.manager.createTaskJob({
      tabId: 77, conversationId: 'conv-1',
      args: { title: 'One-shot', prompt, schedule: { type: 'once', after_seconds: 60 }, target: { type: 'current_tab' } },
    });
    h.setNow(NOW + 60 * 1000);
    await h.manager.handleAlarm(h.alarmName(once.jobId));
    return { h, once, seen };
  }

  const NEUTRAL = /This run is the scheduled execution of an existing task; do not schedule this task again\. Create a different schedule only if the task explicitly asks to set one up\./;

  test(`${build}: a one-shot reminder run is told not to schedule itself again and is not required to`, async () => {
    const { h, once, seen } = await scheduledOneShotRun({ prompt: 'In 30 minutes, remind me to take the pizza out.', toolCalls: [] });
    assert.match(seen.message, NEUTRAL);
    assert.equal(seen.guard.requiredSchedulingTool, null);
    assert.doesNotMatch(String(seen.decision?.nudge || ''), /schedule_task/, 'nothing pushes the run to schedule the reminder again');
    assert.deepEqual(h.jobs().map(job => job.id), [once.jobId], 'no new schedule');
    assert.equal(h.jobs()[0].status, 'completed');
  });

  test(`${build}: a one-shot run that sets up a different schedule can still call schedule_task`, async () => {
    const { h, once, seen } = await scheduledOneShotRun({
      prompt: 'On Monday at 9, start an hourly check of the releases page.',
      toolCalls: [['schedule_task', {
        title: 'Hourly releases check', prompt: 'Check the releases page for a new release.',
        schedule: { type: 'recurring', after_seconds: 60, interval_minutes: 60 },
        target: { type: 'url', url: 'https://example.com/releases' },
      }]],
    });
    assert.match(seen.message, NEUTRAL);
    assert.equal(seen.guard.requiredSchedulingTool, null);
    assert.equal(seen.results[0]?.success, true, JSON.stringify(seen.results[0]));
    assert.equal(seen.results[0]?.scheduled, true);
    const hourly = h.jobs().find(job => job.id !== once.jobId);
    assert.ok(hourly, 'the run created the hourly schedule');
    assert.equal(hourly.schedule.type, 'recurring');
    assert.equal(hourly.schedule.interval_minutes, 60);
    assert.equal(hourly.status, 'pending');
    assert.ok(h.alarms.has(h.alarmName(hourly.id)));
    assert.equal(seen.decision, null, 'done(success) is not blocked once the schedule exists');
    assert.equal(h.jobs().find(job => job.id === once.jobId).status, 'completed');
  });

  const scheduledRunOptions = finishes => ({
    scheduledRun: true, independentRun: true, scheduledResume: false, scheduledRecurring: true,
    onRunFinished: (...args) => finishes.push(args),
  });
  const scheduledMessage = '[Scheduled task task_1: Check account]\nTask: Every 5 minutes, check my account balance.';

  for (const plannerMode of ['off', 'try']) {
    test(`${build}: a real planner question (${plannerMode}) reports that the run ended waiting for the user`, async () => {
      const tabId = 6701;
      const agent = plannerAgent(Agent, plannerResult('clarify', 'Which account should I check?'), plannerMode);
      const finishes = [];
      const answer = await agent.processMessage(tabId, scheduledMessage, () => {}, 'act', [], scheduledRunOptions(finishes));
      assert.match(answer, /Which account should I check\?/);
      assert.deepEqual(agent.plannerCalls, [plannerMode === 'off' ? 'planner_intent' : 'planner'], 'the real planner gate ran');
      assert.deepEqual(finishes, [['clarify', { needsUserInput: true }]]);

      // The streaming entry point reports the same way.
      const streamAgent = plannerAgent(Agent, plannerResult('clarify', 'Which account should I check?'), plannerMode);
      const streamFinishes = [];
      await streamAgent.processMessageStream(tabId, scheduledMessage, () => {}, 'act', { onRunFinished: (...args) => streamFinishes.push(args) });
      assert.deepEqual(streamFinishes, [['clarify', { needsUserInput: true }]]);
    });
  }

  test(`${build}: an unverified recipient question also reports that the run is waiting for the user`, async () => {
    const tabId = 6702;
    // "Send it in the open conversation" when the open conversation has no
    // single verified recipient: the real planner gate ends the run with a
    // question to the user under another status. Only the page probe is
    // replaced.
    const agent = plannerAgent(Agent, plannerResult('execute', 'Send the balance to the open conversation.', {
      requires_submission: true,
      read_scope: 'visible_page',
      steps: [{ id: '1', action: 'Type the balance into the open conversation and send it', tools: ['type_text', 'click'] }],
      messaging: { target_kind: 'active_conversation', recipients: [] },
    }), 'off');
    const messagingUrl = 'https://www.linkedin.com/messaging/thread/example/';
    agent._getTabUrlTitle = async () => ({ tabUrl: messagingUrl, tabTitle: 'Messaging' });
    agent._currentUrl = async () => messagingUrl;
    agent._messageRecipientGuardProbe = async () => ({ success: true, conclusive: false, composerAvailable: true, recipients: [] });
    const finishes = [];
    const answer = await agent.processMessage(tabId, scheduledMessage, () => {}, 'act', [], scheduledRunOptions(finishes));
    assert.match(answer, /could not pin the currently open conversation to one verified recipient/);
    assert.deepEqual(finishes, [['active_recipient_unverified', { needsUserInput: true }]]);
  });

  test(`${build}: other planner endings do not claim the user is needed`, async () => {
    for (const [plannerMode, plan, status] of [
      ['off', plannerResult('plan_only', 'Outline the account check.'), 'plan_only_output'],
      // Strict planning's failure carries requestKind "clarify", but it is a
      // planner error, not a question for the user.
      ['strict', 'not a plan', 'planner_error'],
    ]) {
      const agent = plannerAgent(Agent, plan, plannerMode);
      const finishes = [];
      await agent.processMessage(6703, scheduledMessage, () => {}, 'act', [], scheduledRunOptions(finishes));
      assert.deepEqual(finishes, [[status, { needsUserInput: false }]], plannerMode);
    }
  });

  test(`${build}: a real planner question pauses a recurring scheduled task, not a one-shot one`, async () => {
    const NOW = Date.UTC(2026, 9, 15, 9, 0, 0);
    const agent = plannerAgent(Agent, plannerResult('clarify', 'Which account should I check?'), 'off');
    const h = makeSchedulerHarness(Scheduler, { now: NOW, processMessage: (...args) => agent.processMessage(...args) });
    const recurring = await h.manager.createTaskJob({
      tabId: 77, conversationId: 'conv-1',
      args: { title: 'Check account', prompt: 'Check my account balance.', schedule: { type: 'recurring', after_seconds: 60, interval_minutes: 5 }, target: { type: 'current_tab' } },
    });
    h.setNow(NOW + 60 * 1000);
    await h.manager.handleAlarm(h.alarmName(recurring.jobId));
    const job = h.jobs().find(candidate => candidate.id === recurring.jobId);
    assert.equal(job.status, 'paused');
    assert.equal(job.pausedBy, 'scheduler');
    assert.match(job.lastResult, /Which account should I check\?/);
    assert.match(job.lastError, /needs information only you can give/);
    assert.equal(h.alarms.has(h.alarmName(recurring.jobId)), false);

    const once = await h.manager.createTaskJob({
      tabId: 77, conversationId: 'conv-1',
      args: { title: 'Check once', prompt: 'Check my account balance once.', schedule: { type: 'once', after_seconds: 60 }, target: { type: 'current_tab' } },
    });
    h.setNow(NOW + 120 * 1000);
    await h.manager.handleAlarm(h.alarmName(once.jobId));
    assert.equal(h.jobs().find(candidate => candidate.id === once.jobId).status, 'completed');
  });
}
