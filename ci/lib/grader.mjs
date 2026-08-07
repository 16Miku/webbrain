function getPath(value, dottedPath) {
  return String(dottedPath).split('.').reduce((current, key) => current?.[key], value);
}

function checkValue(actual, check) {
  if (Object.hasOwn(check, 'equals')) return actual === check.equals;
  if (Object.hasOwn(check, 'contains')) {
    if (Array.isArray(actual)) return actual.includes(check.contains);
    return String(actual ?? '').toLowerCase().includes(String(check.contains).toLowerCase());
  }
  if (Object.hasOwn(check, 'matches')) return new RegExp(check.matches, 'i').test(String(actual ?? ''));
  if (check.truthy) return Boolean(actual);
  return actual !== undefined;
}

function getFinalUrl(run, trace) {
  return run?.final_url || run?.finalUrl || trace?.run?.final_url || trace?.run?.finalUrl || '';
}

function toolCalls(run, trace) {
  const calls = [];
  const pending = [];
  for (const update of trace?.run?.updates || run?.updates || []) {
    const name = update.data?.name || update.data?.tool || '';
    if (update.type === 'tool_call') {
      const call = {
        name,
        args: update.data?.args || update.data?.arguments || {},
        result: null,
      };
      calls.push(call);
      pending.push(call);
    } else if (update.type === 'tool_result') {
      const pendingIndex = pending.findIndex((call) => call.name === name);
      if (pendingIndex >= 0) {
        pending[pendingIndex].result = update.data?.result || {};
        pending.splice(pendingIndex, 1);
      }
    }
  }
  return calls;
}

function successfulToolRequest(call) {
  if (call?.result?.success !== true) return false;
  if (call.name !== 'fetch_url') return true;
  const status = Number(call.result.status);
  return Number.isInteger(status) && status >= 200 && status < 300;
}

export function inferStuckAt({
  run,
  trace,
  setupError,
  scheduledError,
  postStartError,
  artifactError,
  cleanupErrors = [],
  checks,
}) {
  if (setupError) return 'setup';
  if (scheduledError) return 'scheduled_execution';
  if (postStartError) return run?.status === 'completed' ? 'verification' : 'execution';
  if (!run) return 'run_start';
  if (run.status === 'needs_user_input') return 'user_handoff';
  const updates = trace?.run?.updates || run.updates || [];
  const toolNames = updates
    .filter((update) => update.type === 'tool_result' || update.type === 'tool_call')
    .map((update) => update.data?.name || update.data?.tool || '');
  if (run.status !== 'completed') {
    if (!toolNames.length) return 'planning';
    if (!getFinalUrl(run, trace)) return 'navigation';
    return 'execution';
  }
  if (cleanupErrors.length) return 'cleanup';
  if (checks.some((check) => !check.passed && !['artifact:video', 'cleanup'].includes(check.id))) return 'verification';
  if (artifactError) return 'artifact_capture';
  return null;
}

export function gradeScenario({
  scenario,
  run,
  trace,
  remoteState,
  scheduledState,
  setupError,
  scheduledError,
  postStartError,
  artifactError,
  cleanupErrors = [],
  captureRequired = false,
}) {
  const checks = [];
  const add = (id, label, weight, passed, evidence = '') => {
    checks.push({ id, label, weight, passed: Boolean(passed), evidence: String(evidence || '') });
  };

  add(
    'run_completed',
    'Cloud run completed',
    20,
    run?.status === 'completed',
    run?.status || scheduledError?.message || postStartError?.message || setupError?.message || 'run unavailable',
  );

  if (scenario.verify?.mode) {
    const actualMode = run?.mode || trace?.run?.mode || 'act';
    add('mode', `Run used ${scenario.verify.mode} mode`, 10, actualMode === scenario.verify.mode, actualMode);
  }

  const calls = toolCalls(run, trace);
  for (const skillId of scenario.verify?.skills || []) {
    const candidates = calls.filter((call) => call.name === 'load_skill' && call.args?.skill_id === skillId);
    const loaded = candidates.some((call) => call.result?.success === true);
    add(
      `skill:${skillId}`,
      `Loaded ${skillId}`,
      10,
      loaded,
      loaded ? skillId : candidates.length ? 'failed or missing result' : 'not observed',
    );
  }
  for (const toolName of scenario.verify?.tools || []) {
    const candidates = calls.filter((call) => call.name === toolName);
    const used = candidates.some((call) => call.result?.success === true);
    add(
      `tool:${toolName}`,
      `Completed ${toolName}`,
      10,
      used,
      used ? 'success' : candidates.length ? 'failed or missing result' : 'not observed',
    );
  }
  for (const toolName of scenario.verify?.successfulTools || []) {
    const completed = calls.find((call) => call.name === toolName && call.result?.success === true);
    const attempted = calls.findLast((call) => call.name === toolName);
    add(
      `tool_success:${toolName}`,
      `Completed ${toolName}`,
      10,
      Boolean(completed),
      completed ? 'success' : attempted ? 'failed or missing result' : 'not observed',
    );
  }
  for (const expected of scenario.verify?.toolCounts || []) {
    const candidates = calls.filter((call) => (
      call.name === expected.tool
      && (expected.successful === false || call.result?.success === true)
    ));
    const count = candidates.length;
    const passed = Object.hasOwn(expected, 'equals')
      ? count === expected.equals
      : count >= (expected.min || 1);
    add(
      `tool_count:${expected.tool}`,
      expected.label || `Completed ${expected.tool} ${expected.equals ?? expected.min ?? 1} time(s)`,
      expected.weight || 10,
      passed,
      `${count} observed`,
    );
  }
  for (const expected of scenario.verify?.toolResults || []) {
    const call = calls.findLast((candidate) => (
      candidate.name === expected.tool && candidate.result?.success === true
    ));
    const actual = call ? getPath(call.result, expected.path) : undefined;
    add(
      `tool_result:${expected.tool}:${expected.path}`,
      expected.label || `${expected.tool} result field ${expected.path}`,
      expected.weight || 10,
      Boolean(call) && checkValue(actual, expected),
      actual === undefined ? 'not observed' : JSON.stringify(actual),
    );
  }
  for (const expected of scenario.verify?.toolRequests || []) {
    const candidates = calls.filter((call) => (
      call.name === expected.tool
      && (!expected.origin || call.args?.url_origin === expected.origin)
      && (!expected.method || String(call.args?.method || 'GET').toUpperCase() === expected.method.toUpperCase())
    ));
    const matched = candidates.find(successfulToolRequest);
    const attempted = candidates.at(-1);
    const target = [expected.method, expected.origin].filter(Boolean).join(' ');
    const attemptedStatus = Number(attempted?.result?.status);
    const evidence = matched
      ? `${target} -> HTTP ${matched.result.status}`
      : attempted
        ? `request did not succeed${Number.isInteger(attemptedStatus) ? ` (HTTP ${attemptedStatus})` : ''}`
        : 'not observed';
    add(
      `tool_request:${expected.tool}:${target}`,
      expected.label || `Observed ${expected.tool} request to ${target}`,
      expected.weight || 10,
      Boolean(matched),
      evidence,
    );
  }
  for (const toolName of scenario.verify?.forbiddenTools || []) {
    const used = calls.some((call) => call.name === toolName);
    add(`tool_forbidden:${toolName}`, `Did not use ${toolName}`, 5, !used, used ? 'observed' : 'absent');
  }

  for (const expected of scenario.verify?.result || []) {
    const actual = getPath(run?.result, expected.path);
    add(
      `result:${expected.path}`,
      expected.label || `Result field ${expected.path}`,
      expected.weight || 10,
      checkValue(actual, expected),
      JSON.stringify(actual),
    );
  }

  const events = remoteState?.events || [];
  for (const expected of scenario.verify?.events || []) {
    const matches = events.filter((event) => event.type === expected.type);
    add(
      `event:${expected.type}`,
      expected.label || `Gnippets event ${expected.type}`,
      expected.weight || 15,
      matches.length >= (expected.min || 1),
      matches.map((event) => event.detail).join(' | ') || 'event absent',
    );
  }

  const scheduledExpectation = scenario.verify?.scheduledJobs;
  if (scheduledExpectation) {
    const jobs = scheduledState?.jobs || [];
    const scheduledCalls = calls.filter((call) => (
      call.name === 'schedule_task' && call.result?.success === true
    ));
    const expectedCount = scheduledExpectation.count || 1;
    add(
      'scheduled_jobs:count',
      `Observed ${expectedCount} scheduled job outcome(s)`,
      scheduledExpectation.countWeight || 15,
      jobs.length === expectedCount,
      `${jobs.length} observed`,
    );
    if (scheduledExpectation.status) {
      const matching = jobs.filter(job => job.status === scheduledExpectation.status).length;
      add(
        'scheduled_jobs:status',
        `All scheduled jobs reached ${scheduledExpectation.status}`,
        scheduledExpectation.statusWeight || 20,
        jobs.length === expectedCount && matching === expectedCount,
        `${matching}/${expectedCount}`,
      );
    }
    if (scheduledExpectation.lastOutcome) {
      const matching = jobs.filter(job => job.lastOutcome === scheduledExpectation.lastOutcome).length;
      add(
        'scheduled_jobs:outcome',
        `All scheduled jobs reported ${scheduledExpectation.lastOutcome}`,
        scheduledExpectation.outcomeWeight || 25,
        jobs.length === expectedCount && matching === expectedCount,
        `${matching}/${expectedCount}`,
      );
    }
    const definitions = scheduledExpectation.definitions || [];
    for (const [index, expected] of definitions.entries()) {
      const call = scheduledCalls[index];
      const args = call?.args || {};
      const jobId = call?.result?.jobId || call?.result?.existingJobId || '';
      const prompt = String(args.prompt || '');
      const definitionPassed = Boolean(call)
        && (!expected.title || args.title === expected.title)
        && (!expected.mode || args.mode === expected.mode)
        && (!expected.scheduleType || args.schedule?.type === expected.scheduleType)
        && (!Object.hasOwn(expected, 'afterSeconds')
          || Number(args.schedule?.after_seconds) === expected.afterSeconds)
        && (!expected.targetType || args.target?.type === expected.targetType)
        && (!expected.targetUrl || args.target?.url === expected.targetUrl)
        && (expected.promptContains || []).every((value) => prompt.includes(value))
        && (expected.promptExcludes || []).every((value) => !prompt.includes(value));
      add(
        `scheduled_jobs:definition:${index}`,
        expected.label || `Scheduled job ${index + 1} matched its requested definition`,
        expected.weight || 15,
        definitionPassed,
        definitionPassed ? `${args.title} -> ${args.target?.url}` : 'definition mismatch',
      );
      if (expected.resultPath) {
        const resultJobId = getPath(run?.result, expected.resultPath);
        const stateJobId = jobs[index]?.id;
        const idsMatch = Boolean(jobId)
          && resultJobId === jobId
          && stateJobId === jobId;
        add(
          `scheduled_jobs:id:${expected.resultPath}`,
          `Scheduled job ID matches result field ${expected.resultPath}`,
          expected.idWeight || 10,
          idsMatch,
          idsMatch ? jobId : 'ID mismatch',
        );
      }
    }
    if (scheduledExpectation.distinctPrompts) {
      const prompts = scheduledCalls.map((call) => String(call.args?.prompt || ''));
      add(
        'scheduled_jobs:distinct_prompts',
        'Scheduled jobs use distinct non-empty prompts',
        scheduledExpectation.distinctPromptsWeight || 10,
        prompts.length === expectedCount
          && prompts.every(Boolean)
          && new Set(prompts).size === expectedCount,
        `${new Set(prompts.filter(Boolean)).size}/${expectedCount} distinct`,
      );
    }
  }

  if (scenario.verify?.finalUrlHost) {
    let host = '';
    try { host = new URL(getFinalUrl(run, trace)).hostname; } catch {}
    add('final_url', 'Finished on the expected host', 10, host === scenario.verify.finalUrlHost, host);
  }

  if (captureRequired) {
    add(
      'artifact:video',
      'Run video synchronized',
      10,
      !artifactError,
      artifactError?.message || 'video.webm',
    );
  }

  add(
    'cleanup',
    'Ephemeral resources cleaned up',
    10,
    cleanupErrors.length === 0,
    cleanupErrors.map((error) => error.message).join(' | ') || 'browser and fixture removed',
  );

  const available = checks.reduce((sum, check) => sum + check.weight, 0);
  const earned = checks.filter((check) => check.passed).reduce((sum, check) => sum + check.weight, 0);
  const score = available ? Math.round((earned / available) * 100) : 0;
  const requiredPassed = checks.every((check) => check.passed);
  return {
    scenario_id: scenario.id,
    passed: requiredPassed && !setupError && !scheduledError && !postStartError,
    score,
    earned,
    available,
    stuck_at: inferStuckAt({
      run,
      trace,
      setupError,
      scheduledError,
      postStartError,
      artifactError,
      cleanupErrors,
      checks,
    }),
    checks,
    error: scheduledError?.message || postStartError?.message || setupError?.message || run?.error || '',
    artifact_warning: artifactError?.message || '',
  };
}

export function renderSummary(results, metadata = {}) {
  const passed = results.filter((result) => result.grade.passed).length;
  const lines = [
    '# WebBrain Cloud E2E report',
    '',
    `- Started: ${metadata.startedAt || 'unknown'}`,
    `- Finished: ${metadata.finishedAt || 'unknown'}`,
    `- Pack: ${metadata.pack || 'all'}`,
    `- Passed: ${passed}/${results.length}`,
    '',
    '| Scenario | Result | Score | Stuck at |',
    '|---|---:|---:|---|',
    ...results.map(({ scenario, grade }) => (
      `| ${scenario.title} | ${grade.passed ? 'PASS' : 'FAIL'} | ${grade.score} | ${grade.stuck_at || '—'} |`
    )),
    '',
  ];
  for (const { scenario, grade } of results) {
    lines.push(`## ${scenario.title}`, '');
    for (const check of grade.checks) {
      lines.push(`- ${check.passed ? '✓' : '✗'} ${check.label} (${check.weight})${check.evidence ? ` — ${check.evidence}` : ''}`);
    }
    if (grade.error) lines.push(`- Error: ${grade.error}`);
    if (grade.artifact_warning) lines.push(`- Artifact warning: ${grade.artifact_warning}`);
    lines.push('');
  }
  return lines.join('\n');
}
