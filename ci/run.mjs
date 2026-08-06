#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { GnippetsE2EClient, WebBrainCloudClient } from './lib/webbrain-client.mjs';
import { gradeScenario, renderSummary } from './lib/grader.mjs';
import { sanitizeGnippetsState, sanitizeRun, sanitizeTrace } from './lib/sanitize.mjs';
import { buildSessionSettings, resolveCloudRunId, suiteShouldFail } from './lib/suite.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts');

function parseArgs(argv) {
  const options = { pack: 'all', concurrency: 2, video: true, dryRun: false, scenarioIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pack') options.pack = argv[++index];
    else if (arg === '--scenario') options.scenarioIds.push(argv[++index]);
    else if (arg === '--concurrency') options.concurrency = Math.max(1, Number(argv[++index]) || 1);
    else if (arg === '--no-video') options.video = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return `Usage: node ci/run.mjs [options]

  --pack <name>         all, cloud-smoke, public-readonly, gnippets-readonly, gnippets-spa, gnippets-captcha
  --scenario <id>       run one scenario (repeatable)
  --concurrency <n>     parallel isolated browsers (default: 2)
  --no-video            keep trace/rubric artifacts but disable .webm capture
  --dry-run             validate and list selected scenarios without API calls`;
}

async function readCatalog() {
  const raw = await fs.readFile(path.join(ROOT, 'catalog', 'scenarios.json'), 'utf8');
  const scenarios = JSON.parse(raw);
  const ids = new Set();
  for (const scenario of scenarios) {
    if (!scenario.id || ids.has(scenario.id)) throw new Error(`Duplicate or missing scenario id: ${scenario.id}`);
    if (!scenario.task || !scenario.output_schema || !scenario.verify) {
      throw new Error(`Scenario ${scenario.id} is missing task, output_schema, or verify.`);
    }
    ids.add(scenario.id);
  }
  return scenarios;
}

function selectScenarios(catalog, options) {
  let selected = options.pack === 'all'
    ? catalog
    : catalog.filter((scenario) => scenario.pack === options.pack);
  if (options.scenarioIds.length) {
    const ids = new Set(options.scenarioIds);
    selected = selected.filter((scenario) => ids.has(scenario.id));
    const missing = [...ids].filter((id) => !catalog.some((scenario) => scenario.id === id));
    if (missing.length) throw new Error(`Unknown scenario id(s): ${missing.join(', ')}`);
  }
  if (!selected.length) throw new Error('No scenarios matched the selection.');
  return selected;
}

async function writeJson(destination, value) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, consume));
  return results;
}

async function waitForRunWithClarifications({ cloud, sessionId, runId, scenario }) {
  const used = new Set();
  let run = await cloud.waitForRun(sessionId, runId, { timeoutMs: scenario.timeout_ms + 120_000 });
  for (let count = 0; run.status === 'needs_user_input' && count < 5; count += 1) {
    const pending = run.pending_input || run.pendingInput || {};
    const question = String(pending.question || '');
    const ruleIndex = (scenario.clarifications || []).findIndex((rule, index) => (
      !used.has(index) && new RegExp(rule.question_matches, 'i').test(question)
    ));
    if (ruleIndex < 0) return run;
    const clarifyId = pending.clarify_id || pending.clarifyId;
    if (!clarifyId) return run;
    used.add(ruleIndex);
    await cloud.respondToRun(sessionId, runId, clarifyId, scenario.clarifications[ruleIndex].answer);
    run = await cloud.waitForRun(sessionId, runId, { timeoutMs: scenario.timeout_ms + 120_000 });
  }
  return run;
}

async function executeScenario({ scenario, suiteDir, cloud, gnippets, video }) {
  const scenarioDir = path.join(suiteDir, scenario.id);
  await fs.mkdir(scenarioDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const missingRequirement = (scenario.requires || []).find((name) => !process.env[name]);
  if (missingRequirement) {
    const grade = {
      scenario_id: scenario.id,
      passed: false,
      skipped: true,
      score: 0,
      stuck_at: 'prerequisite',
      checks: [],
      error: `Missing ${missingRequirement}.`,
      artifact_warning: '',
    };
    await writeJson(path.join(scenarioDir, 'grade.json'), grade);
    return { scenario, grade, skipped: true };
  }

  let browser = null;
  let gnippetsRun = null;
  let run = null;
  let trace = null;
  let remoteState = null;
  let setupError = null;
  let artifactError = null;
  const cleanupErrors = [];
  const artifacts = {};
  const sensitive = scenario.artifact_policy === 'sensitive';
  const captureRequested = video && scenario.capture !== false && !sensitive;

  try {
    let startUrl = scenario.start_url;
    if (scenario.setup === 'gnippets_e2e') {
      const setup = await gnippets.createRun(scenario.id);
      gnippetsRun = setup.run;
      startUrl = setup.app_url;
      await writeJson(path.join(scenarioDir, 'gnippets-setup.json'), sensitive
        ? { created: true, expires_at: gnippetsRun.expires_at }
        : { run_id: gnippetsRun.run_id, app_url: startUrl, expires_at: gnippetsRun.expires_at });
    }
    const task = scenario.task.replaceAll('{{START_URL}}', startUrl);
    browser = await cloud.createIncognitoBrowser({
      name: `CI ${scenario.id}`.slice(0, 120),
      settings: buildSessionSettings(process.env.CAPSOLVER_API_KEY || '', scenario.session_settings || {}),
    });
    await cloud.waitForBrowser(browser.id);
    let tabId;
    if (scenario.preload_url) {
      const preload = await cloud.startRun(browser.id, {
        task: `Open ${scenario.preload_url} and stop after the page is fully loaded.`,
        mode: 'act',
        timeoutMs: scenario.timeout_ms,
        capture: 'none',
      });
      const preloadId = resolveCloudRunId(preload);
      if (!preloadId) throw new Error('WebBrain Cloud did not return a preload run id.');
      const preloaded = await cloud.waitForRun(browser.id, preloadId, { timeoutMs: scenario.timeout_ms + 120_000 });
      if (preloaded.status !== 'completed') throw new Error(`Page preload ended with ${preloaded.status}.`);
      tabId = preloaded.tab_id ?? preloaded.tabId;
    }
    const started = await cloud.startRun(browser.id, {
      task,
      mode: scenario.mode || 'act',
      tabId,
      outputSchema: scenario.output_schema,
      timeoutMs: scenario.timeout_ms,
      capture: captureRequested ? 'video' : 'none',
    });
    const runId = resolveCloudRunId(started);
    if (!runId) throw new Error('WebBrain Cloud did not return a run id.');
    run = await waitForRunWithClarifications({ cloud, sessionId: browser.id, runId, scenario });
    await writeJson(path.join(scenarioDir, 'run.json'), sensitive ? sanitizeRun(run) : run);
    if (['completed', 'failed'].includes(run.status)) {
      trace = await cloud.exportTrace(browser.id, runId);
      const storedTrace = sensitive ? sanitizeTrace(trace) : trace;
      await writeJson(path.join(scenarioDir, 'trace.json'), storedTrace);
      artifacts.trace = 'trace.json';
      if (sensitive) trace = storedTrace;
    }
    if (gnippetsRun) {
      remoteState = (await gnippets.getRun(gnippetsRun.run_id)).run;
      const storedState = sensitive ? sanitizeGnippetsState(remoteState) : remoteState;
      await writeJson(path.join(scenarioDir, 'gnippets-state.json'), storedState);
      artifacts.gnippets_state = 'gnippets-state.json';
      if (sensitive) remoteState = storedState;
    }
    if (captureRequested) {
      try {
        const capture = await cloud.downloadCapture(
          browser.id,
          runId,
          path.join(scenarioDir, 'video.webm'),
        );
        artifacts.video = { path: 'video.webm', ...capture };
      } catch (error) {
        artifactError = error;
      }
    }
  } catch (error) {
    setupError = error;
    run ||= error.latest || null;
    await writeJson(path.join(scenarioDir, 'error.json'), {
      name: error.name,
      message: sensitive ? 'Sensitive scenario failed; raw diagnostics were omitted.' : error.message,
      status: error.status || null,
      body: sensitive ? null : (error.body || null),
    });
  } finally {
    if (gnippetsRun) {
      await gnippets.deleteRun(gnippetsRun.run_id).catch((error) => cleanupErrors.push(error));
    }
    if (browser?.id) {
      await cloud.destroyBrowser(browser.id).catch((error) => cleanupErrors.push(error));
    }
  }

  const grade = gradeScenario({
    scenario,
    run: sensitive ? sanitizeRun(run) : run,
    trace,
    remoteState,
    setupError: sensitive && setupError
      ? new Error('Sensitive scenario failed; raw diagnostics were omitted.')
      : setupError,
    artifactError,
    cleanupErrors: sensitive
      ? cleanupErrors.map(() => new Error('Sensitive scenario cleanup failed; raw diagnostics were omitted.'))
      : cleanupErrors,
    captureRequired: captureRequested,
  });
  const manifest = {
    format: 'webbrain.ci-scenario',
    version: 1,
    scenario_id: scenario.id,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    browser_session_id: browser?.id || null,
    run_id: run?.run_id || trace?.run?.run_id || null,
    artifacts,
  };
  await Promise.all([
    writeJson(path.join(scenarioDir, 'grade.json'), grade),
    writeJson(path.join(scenarioDir, 'manifest.json'), manifest),
  ]);
  return { scenario, grade, manifest };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const selected = selectScenarios(await readCatalog(), options);
  if (options.dryRun) {
    console.log(JSON.stringify(selected.map(({ id, title, pack, requires = [] }) => ({ id, title, pack, requires })), null, 2));
    return;
  }

  const apiKey = process.env.WEBBRAIN_API_KEY;
  if (!apiKey) throw new Error('WEBBRAIN_API_KEY is required. Use --dry-run to validate the catalog offline.');
  const cloud = new WebBrainCloudClient({
    apiKey,
    baseUrl: process.env.WEBBRAIN_BASE_URL || 'https://webbrain.cloud',
  });
  const gnippets = new GnippetsE2EClient({
    baseUrl: process.env.GNIPPETS_BASE_URL || 'https://gnippets.com',
    controlToken: process.env.GNIPPETS_E2E_CONTROL_TOKEN || '',
  });

  const suiteId = new Date().toISOString().replace(/[:.]/g, '-');
  const suiteDir = path.join(ARTIFACT_ROOT, suiteId);
  const startedAt = new Date().toISOString();
  console.log(`Running ${selected.length} scenario(s) with concurrency ${options.concurrency}.`);
  const results = await mapLimit(selected, options.concurrency, async (scenario) => {
    console.log(`→ ${scenario.id}`);
    const result = await executeScenario({ scenario, suiteDir, cloud, gnippets, video: options.video });
    console.log(`${result.grade.passed ? '✓' : result.skipped ? '○' : '✗'} ${scenario.id} (${result.grade.score})`);
    return result;
  });
  const finishedAt = new Date().toISOString();
  const summary = {
    format: 'webbrain.ci-suite',
    version: 1,
    suite_id: suiteId,
    started_at: startedAt,
    finished_at: finishedAt,
    pack: options.pack,
    totals: {
      scenarios: results.length,
      passed: results.filter((result) => result.grade.passed).length,
      failed: results.filter((result) => !result.grade.passed && !result.grade.skipped).length,
      skipped: results.filter((result) => result.grade.skipped).length,
    },
    results: results.map(({ scenario, grade, manifest }) => ({
      scenario_id: scenario.id,
      title: scenario.title,
      grade,
      manifest,
    })),
  };
  await Promise.all([
    writeJson(path.join(suiteDir, 'summary.json'), summary),
    fs.writeFile(
      path.join(suiteDir, 'summary.md'),
      `${renderSummary(results, { startedAt, finishedAt, pack: options.pack })}\n`,
      'utf8',
    ),
  ]);
  console.log(`Report: ${path.join(suiteDir, 'summary.md')}`);
  if (suiteShouldFail(summary.totals)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
