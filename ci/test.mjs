import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeScenario, inferStuckAt, renderSummary } from './lib/grader.mjs';
import { sanitizeRun, sanitizeTrace } from './lib/sanitize.mjs';
import {
  buildSessionSettings,
  resolveCloudRunId,
  successfulToolResults,
  suiteShouldFail,
} from './lib/suite.mjs';
import { GnippetsE2EClient, WebBrainCloudClient } from './lib/webbrain-client.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(await fs.readFile(path.join(root, 'catalog', 'scenarios.json'), 'utf8'));
const smokeWorkflow = await fs.readFile(
  path.join(root, '..', '.github', 'workflows', 'webbrain-cloud-smoke.yml'),
  'utf8',
);
const manualWorkflow = await fs.readFile(
  path.join(root, '..', '.github', 'workflows', 'cloud-e2e.yml'),
  'utf8',
);

assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length);
assert.ok(scenarios.every((scenario) => scenario.output_schema?.type === 'object'));
assert.ok(scenarios.every((scenario) => scenario.verify));
const signupScenario = scenarios.find((scenario) => scenario.id === 'gnippets-signup-otp-disposable');
assert.equal(signupScenario.api_mutations_allowed, true);
assert.match(signupScenario.task, /POST \/accounts/);
const nytimesScenario = scenarios.find((scenario) => scenario.id === 'nytimes-gated-article-read');
assert.equal(nytimesScenario.mode, 'ask');
assert.deepEqual(nytimesScenario.verify.successfulTools, ['fetch_nytimes_article']);
const youtubeDownloadScenario = scenarios.find((scenario) => scenario.id === 'youtube-short-video-download');
assert.equal(youtubeDownloadScenario.capture, false);
assert.equal(youtubeDownloadScenario.start_url, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
assert.match(youtubeDownloadScenario.task, /19-second/);
assert.deepEqual(
  youtubeDownloadScenario.verify.successfulTools,
  ['resolve_public_media', 'download_public_media', 'list_downloads'],
);
const googleFormsScenario = scenarios.find((scenario) => scenario.id === 'google-forms-scheduled-double-submit');
assert.equal(googleFormsScenario.verify.scheduledJobs.count, 2);
assert.equal(googleFormsScenario.verify.scheduledJobs.definitions.length, 2);
assert.equal(googleFormsScenario.verify.scheduledJobs.definitions[0].afterSeconds, 0);
assert.equal(googleFormsScenario.verify.scheduledJobs.definitions[1].afterSeconds, 60);
assert.equal(googleFormsScenario.session_settings.scheduledRequireConsequentialConfirmation, false);
assert.match(googleFormsScenario.task, /after_seconds=0/);
assert.match(googleFormsScenario.task, /after_seconds=60/);
assert.match(smokeWorkflow, /- "src\/chrome\/src\/offscreen\/cloud-bridge\.js"/);
assert.match(smokeWorkflow, /timeout-minutes:\s*120/);
assert.match(manualWorkflow, /timeout-minutes:\s*120/);

assert.equal(resolveCloudRunId({ run_id: 'snake-case' }), 'snake-case');
assert.equal(resolveCloudRunId({ runId: 'camel-case' }), 'camel-case');
assert.equal(resolveCloudRunId({ id: 'generic-id' }), 'generic-id');
assert.equal(resolveCloudRunId({}), '');
assert.equal(suiteShouldFail({ failed: 0, skipped: 0 }), false);
assert.equal(suiteShouldFail({ failed: 1, skipped: 0 }), true);
assert.equal(suiteShouldFail({ failed: 0, skipped: 1 }), true);
assert.equal(buildSessionSettings().askBeforeConsequentialActions, false);
assert.equal(buildSessionSettings().captchaSolverEnabled, false);
assert.equal(buildSessionSettings('', { strictSecretMode: true }).strictSecretMode, true);
assert.deepEqual(
  {
    enabled: buildSessionSettings('captcha-key').captchaSolverEnabled,
    key: buildSessionSettings('captcha-key').capsolverApiKey,
  },
  { enabled: true, key: 'captcha-key' },
);

let cloudRunRequest;
let scheduledPolls = 0;
const cloudClient = new WebBrainCloudClient({
  apiKey: 'test-cloud-key',
  baseUrl: 'https://webbrain.example',
  fetchImpl: async (url, options = {}) => {
    if (url.endsWith('/scheduled-jobs')) {
      scheduledPolls += 1;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            jobs: [{
              id: 'task_1',
              status: scheduledPolls > 1 ? 'completed' : 'running',
              lastOutcome: scheduledPolls > 1 ? 'success' : null,
            }],
          });
        },
      };
    }
    cloudRunRequest = JSON.parse(options.body);
    return {
      ok: true,
      status: 202,
      async text() { return '{"run_id":"run_test"}'; },
    };
  },
});
await cloudClient.startRun('browser_test', {
  task: 'Exercise the isolated provider API.',
  apiMutationsAllowed: true,
});
assert.equal(cloudRunRequest.api_mutations_allowed, true);
await cloudClient.startRun('browser_test', { task: 'Read-only run.' });
assert.equal(Object.hasOwn(cloudRunRequest, 'api_mutations_allowed'), false);
const completedScheduledJobs = await cloudClient.waitForScheduledJobs(
  'browser_test',
  ['task_1'],
  { timeoutMs: 1000, intervalMs: 0 },
);
assert.equal(completedScheduledJobs.jobs[0].lastOutcome, 'success');

const scheduleTraceFixture = {
  run: {
    updates: [
      {
        type: 'tool_call',
        data: {
          name: 'schedule_task',
          args: {
            title: 'Google Form submission A',
            mode: 'act',
            schedule: { type: 'once', after_seconds: 0 },
            target: { type: 'url', url: 'https://forms.gle/nDSbn2B6Cym4x9Bi8' },
            prompt: 'Use WebBrain CI A with a random shirt size and random harmless comment. Use set_field and verify_form, submit exactly once, and finish only after the response was recorded.',
          },
        },
      },
      { type: 'tool_result', data: { name: 'schedule_task', result: { success: true, jobId: 'task_1' } } },
      {
        type: 'tool_call',
        data: {
          name: 'schedule_task',
          args: {
            title: 'Google Form submission B',
            mode: 'act',
            schedule: { type: 'once', after_seconds: 60 },
            target: { type: 'url', url: 'https://forms.gle/nDSbn2B6Cym4x9Bi8' },
            prompt: 'Use WebBrain CI B with a random shirt size and random harmless comment. Use set_field and verify_form, submit exactly once, and finish only after the response was recorded.',
          },
        },
      },
      { type: 'tool_result', data: { name: 'schedule_task', result: { success: true, jobId: 'task_2' } } },
    ],
  },
};
assert.deepEqual(
  successfulToolResults(scheduleTraceFixture, 'schedule_task').map(result => result.jobId),
  ['task_1', 'task_2'],
);

const diagnosticSecret = 'diagnostic-secret-that-must-not-leak';
let diagnosticRequest;
const diagnosticClient = new GnippetsE2EClient({
  baseUrl: 'https://gnippets.example',
  controlToken: diagnosticSecret,
  fetchImpl: async (url, options) => {
    diagnosticRequest = { url, options };
    return {
      ok: false,
      status: 403,
      headers: {
        get(name) {
          return {
            server: 'cloudflare',
            'cf-ray': 'fixture-ray-IST',
            'cf-mitigated': 'challenge',
            'content-type': 'text/html',
          }[name.toLowerCase()] || null;
        },
      },
      async text() {
        return `<html><title>Attention Required</title><body>Bearer ${diagnosticSecret}</body></html>`;
      },
    };
  },
});
await assert.rejects(
  diagnosticClient.createRun('fixture'),
  (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.body.server, 'cloudflare');
    assert.equal(error.body.cf_mitigated, 'challenge');
    assert.match(error.message, /fixture-ray-IST/);
    assert.match(error.message, /Attention Required/);
    assert.doesNotMatch(error.message, new RegExp(diagnosticSecret));
    return true;
  },
);
assert.equal(diagnosticRequest.options.headers.accept, 'application/json');
assert.match(diagnosticRequest.options.headers['user-agent'], /WebBrainCloudE2E/);

const sensitiveTrace = sanitizeTrace({
  format: 'webbrain.run-trace',
  version: 1,
  run: {
    run_id: 'run_sensitive',
    status: 'completed',
    mode: 'act',
    final_url: 'https://gnippets.com/e2e/capability-secret/signup?token=fixture-secret',
    updates: [
      {
        type: 'tool_call',
        data: {
          name: 'fetch_url',
          args: {
            url: 'https://api.mail.tm/accounts?address=private%40example.test',
            method: 'POST',
            body: '{"address":"private@example.test","password":"mailbox-secret"}',
          },
        },
      },
      {
        type: 'tool_result',
        data: {
          name: 'fetch_url',
          result: {
            success: true,
            status: 201,
            content: '{"token":"provider-secret"}',
          },
        },
      },
      { type: 'tool_call', data: { name: 'set_field', args: { text: '654321' } } },
    ],
  },
});
assert.equal(sensitiveTrace.run.final_url, 'https://gnippets.com/');
assert.deepEqual(sensitiveTrace.run.updates[0].data.args, {
  url_origin: 'https://api.mail.tm',
  url_path_root: '/accounts',
  method: 'POST',
});
assert.deepEqual(sensitiveTrace.run.updates[1], {
  type: 'tool_result',
  data: { name: 'fetch_url', result: { success: true, status: 201 } },
});
assert.deepEqual(sensitiveTrace.run.updates[2].data, { name: 'set_field' });
assert.doesNotMatch(
  JSON.stringify(sensitiveTrace),
  /private@example|mailbox-secret|provider-secret|654321|capability-secret|fixture-secret/,
);
const sensitiveRun = sanitizeRun({
  run_id: 'run_sensitive',
  status: 'completed',
  mode: 'act',
  finalUrl: 'https://gnippets.com/e2e/capability-secret/signup?token=fixture-secret',
  result: { signup_completed: true },
});
assert.equal(sensitiveRun.final_url, 'https://gnippets.com/');
assert.doesNotMatch(JSON.stringify(sensitiveRun), /capability-secret|fixture-secret/);

const mountainScenario = scenarios.find((scenario) => scenario.id === 'wikipedia-table-extraction');
const invalidMountainHeights = gradeScenario({
  scenario: mountainScenario,
  run: {
    status: 'completed',
    final_url: 'https://en.wikipedia.org/wiki/List_of_highest_mountains_on_Earth',
    result: {
      mountains: [
        { name: 'Mount Everest', height_m: 0 },
        { name: 'K2', height_m: 0 },
        { name: 'Kangchenjunga', height_m: 0 },
      ],
    },
  },
});
assert.equal(invalidMountainHeights.passed, false);
assert.deepEqual(
  invalidMountainHeights.checks
    .filter((check) => check.id.endsWith('.height_m'))
    .map((check) => check.passed),
  [false, false, false],
);

const scenario = {
  id: 'fixture',
  title: 'Fixture',
  verify: {
    result: [
      { path: 'ok', equals: true, weight: 40 },
      { path: 'title', contains: 'needle', weight: 20 },
    ],
    events: [{ type: 'saved', weight: 20 }],
    finalUrlHost: 'example.com',
  },
};
const run = {
  status: 'completed',
  result: { ok: true, title: 'The Needle' },
  final_url: 'https://example.com/done',
};
const grade = gradeScenario({
  scenario,
  run,
  trace: { run: { updates: [] } },
  remoteState: { events: [{ type: 'saved', detail: 'fixture' }] },
});
assert.equal(grade.passed, true);
assert.equal(grade.score, 100);
assert.equal(grade.stuck_at, null);
assert.match(renderSummary([{ scenario, grade }]), /PASS/);
assert.equal(inferStuckAt({ run: { status: 'failed', updates: [] }, checks: [] }), 'planning');
const camelCaseUrlGrade = gradeScenario({
  scenario: { id: 'camel-url', verify: { finalUrlHost: 'example.com' } },
  run: { status: 'completed', finalUrl: 'https://example.com/camel' },
});
assert.equal(camelCaseUrlGrade.passed, true);
const traceCamelCaseUrlGrade = gradeScenario({
  scenario: { id: 'trace-camel-url', verify: { finalUrlHost: 'example.com' } },
  run: { status: 'completed' },
  trace: { run: { finalUrl: 'https://example.com/from-trace' } },
});
assert.equal(traceCamelCaseUrlGrade.passed, true);
assert.equal(inferStuckAt({
  run: {
    status: 'failed',
    finalUrl: 'https://example.com/execution',
    updates: [{ type: 'tool_call', data: { name: 'click' } }],
  },
  checks: [],
}), 'execution');
const missingVideo = gradeScenario({
  scenario,
  run,
  trace: { run: { updates: [] } },
  remoteState: { events: [{ type: 'saved', detail: 'fixture' }] },
  artifactError: new Error('capture missing'),
  captureRequired: true,
});
assert.equal(missingVideo.passed, false);
assert.equal(missingVideo.stuck_at, 'artifact_capture');

const skillGrade = gradeScenario({
  scenario: {
    id: 'skill-fixture',
    verify: {
      mode: 'ask',
      skills: ['forms'],
      tools: ['read_page'],
      forbiddenTools: ['navigate'],
    },
  },
  run: { status: 'completed', mode: 'ask' },
  trace: {
    run: {
      updates: [
        { type: 'tool_call', data: { name: 'load_skill', args: { skill_id: 'forms' } } },
        { type: 'tool_result', data: { name: 'load_skill', result: { success: true } } },
        { type: 'tool_call', data: { name: 'read_page', args: {} } },
        { type: 'tool_result', data: { name: 'read_page', result: { success: true } } },
      ],
    },
  },
});
assert.equal(skillGrade.passed, true);
const failedRequiredCallsGrade = gradeScenario({
  scenario: {
    id: 'failed-required-calls-fixture',
    verify: { skills: ['forms'], tools: ['set_field'] },
  },
  run: { status: 'completed' },
  trace: {
    run: {
      updates: [
        { type: 'tool_call', data: { name: 'load_skill', args: { skill_id: 'forms' } } },
        { type: 'tool_result', data: { name: 'load_skill', result: { success: false } } },
        { type: 'tool_call', data: { name: 'set_field', args: { ref_id: 'ref_1', text: 'value' } } },
        { type: 'tool_result', data: { name: 'set_field', result: { success: false } } },
      ],
    },
  },
});
assert.equal(failedRequiredCallsGrade.passed, false);
assert.equal(failedRequiredCallsGrade.checks.find((check) => check.id === 'skill:forms').passed, false);
assert.equal(failedRequiredCallsGrade.checks.find((check) => check.id === 'tool:set_field').passed, false);
const successfulToolsGrade = gradeScenario({
  scenario: {
    id: 'successful-tools-fixture',
    verify: {
      successfulTools: ['resolve_public_media', 'download_public_media'],
      toolResults: [
        { tool: 'download_public_media', path: 'downloadId', equals: 42 },
      ],
    },
  },
  run: { status: 'completed' },
  trace: {
    run: {
      updates: [
        { type: 'tool_call', data: { name: 'resolve_public_media', args: {} } },
        { type: 'tool_result', data: { name: 'resolve_public_media', result: { success: true } } },
        { type: 'tool_call', data: { name: 'download_public_media', args: {} } },
        {
          type: 'tool_result',
          data: { name: 'download_public_media', result: { success: true, downloadId: 42 } },
        },
      ],
    },
  },
});
assert.equal(successfulToolsGrade.passed, true);
const completedGoogleFormsRun = {
  status: 'completed',
  mode: 'act',
  final_url: 'https://docs.google.com/forms/d/e/example/formResponse',
  result: {
    scheduled_count: 2,
    first_job_id: 'task_1',
    second_job_id: 'task_2',
  },
};
const completedScheduledState = {
  jobs: [
    { id: 'task_1', status: 'completed', lastOutcome: 'success' },
    { id: 'task_2', status: 'completed', lastOutcome: 'success' },
  ],
};
const gradeGoogleForms = (trace = scheduleTraceFixture, run = completedGoogleFormsRun) => gradeScenario({
  scenario: googleFormsScenario,
  run,
  trace,
  scheduledState: completedScheduledState,
});
const scheduledJobsGrade = gradeGoogleForms();
assert.equal(scheduledJobsGrade.passed, true);
const invalidScheduledDefinitions = [
  {
    checkId: 'scheduled_jobs:definition:0',
    mutate(trace) { trace.run.updates[0].data.args.target.url = 'https://example.com/unrelated'; },
  },
  {
    checkId: 'scheduled_jobs:definition:1',
    mutate(trace) { trace.run.updates[2].data.args.schedule.after_seconds = 30; },
  },
  {
    checkId: 'scheduled_jobs:definition:1',
    mutate(trace) {
      trace.run.updates[2].data.args.prompt = trace.run.updates[2].data.args.prompt
        .replace('random harmless comment', 'a comment');
    },
  },
  {
    checkId: 'scheduled_jobs:distinct_prompts',
    mutate(trace) { trace.run.updates[2].data.args.prompt = trace.run.updates[0].data.args.prompt; },
  },
];
for (const { checkId, mutate } of invalidScheduledDefinitions) {
  const trace = structuredClone(scheduleTraceFixture);
  mutate(trace);
  const grade = gradeGoogleForms(trace);
  assert.equal(grade.passed, false);
  assert.equal(grade.checks.find((check) => check.id === checkId).passed, false);
}
const mismatchedScheduledIdGrade = gradeGoogleForms(scheduleTraceFixture, {
  ...completedGoogleFormsRun,
  result: { ...completedGoogleFormsRun.result, first_job_id: 'wrong_task' },
});
assert.equal(mismatchedScheduledIdGrade.passed, false);
assert.equal(
  mismatchedScheduledIdGrade.checks.find((check) => check.id === 'scheduled_jobs:id:first_job_id').passed,
  false,
);
const failedScheduledJobsGrade = gradeScenario({
  scenario: {
    id: 'failed-scheduled-jobs-fixture',
    verify: { scheduledJobs: { count: 2, status: 'completed', lastOutcome: 'success' } },
  },
  run: { status: 'completed' },
  scheduledState: {
    jobs: [
      { id: 'task_1', status: 'completed', lastOutcome: 'success' },
      { id: 'task_2', status: 'failed', lastOutcome: 'failed' },
    ],
  },
});
assert.equal(failedScheduledJobsGrade.passed, false);
const scheduledTimeout = new Error('Scheduled jobs did not finish within 420000ms.');
assert.equal(inferStuckAt({
  run: { status: 'completed' },
  scheduledError: scheduledTimeout,
  checks: [],
}), 'scheduled_execution');
const scheduledTimeoutGrade = gradeScenario({
  scenario: { id: 'scheduled-timeout-fixture', verify: {} },
  run: { status: 'completed' },
  scheduledError: scheduledTimeout,
});
assert.equal(scheduledTimeoutGrade.passed, false);
assert.equal(scheduledTimeoutGrade.stuck_at, 'scheduled_execution');
assert.match(scheduledTimeoutGrade.error, /did not finish/);
const invalidToolResultGrade = gradeScenario({
  scenario: {
    id: 'invalid-tool-result-fixture',
    verify: {
      toolResults: [
        { tool: 'list_downloads', path: 'downloads.0.state', equals: 'complete' },
      ],
    },
  },
  run: { status: 'completed' },
  trace: {
    run: {
      updates: [
        { type: 'tool_call', data: { name: 'list_downloads', args: {} } },
        {
          type: 'tool_result',
          data: {
            name: 'list_downloads',
            result: { success: true, downloads: [{ filename: 'video.mp4', state: 'in_progress' }] },
          },
        },
      ],
    },
  },
});
assert.equal(invalidToolResultGrade.passed, false);
const failedSuccessfulToolGrade = gradeScenario({
  scenario: {
    id: 'failed-successful-tool-fixture',
    verify: { successfulTools: ['download_public_media'] },
  },
  run: { status: 'completed' },
  trace: {
    run: {
      updates: [
        { type: 'tool_call', data: { name: 'download_public_media', args: {} } },
        { type: 'tool_result', data: { name: 'download_public_media', result: { success: false } } },
      ],
    },
  },
});
assert.equal(failedSuccessfulToolGrade.passed, false);
const mailTmGrade = gradeScenario({
  scenario: {
    id: 'mailtm-fixture',
    verify: {
      toolRequests: [{
        tool: 'fetch_url',
        method: 'POST',
        origin: 'https://api.mail.tm',
        pathRoot: '/accounts',
      }],
    },
  },
  run: { status: 'completed' },
  trace: sensitiveTrace,
});
assert.equal(mailTmGrade.passed, true);
const failedMailTmGrade = gradeScenario({
  scenario: {
    id: 'mailtm-failed',
    verify: {
      toolRequests: [{
        tool: 'fetch_url',
        method: 'POST',
        origin: 'https://api.mail.tm',
        pathRoot: '/accounts',
      }],
    },
  },
  run: { status: 'completed' },
  trace: {
    run: {
      updates: [
        {
          type: 'tool_call',
          data: {
            name: 'fetch_url',
            args: {
              url_origin: 'https://api.mail.tm',
              url_path_root: '/accounts',
              method: 'POST',
            },
          },
        },
        {
          type: 'tool_result',
          data: { name: 'fetch_url', result: { success: false, status: 403 } },
        },
      ],
    },
  },
});
assert.equal(failedMailTmGrade.passed, false, 'a rejected Mail.tm request must not count as evidence');
assert.match(
  failedMailTmGrade.checks.find((check) => check.id.startsWith('tool_request:')).evidence,
  /HTTP 403/,
);
const missingMailTmGrade = gradeScenario({
  scenario: {
    id: 'mailtm-missing',
    verify: {
      skills: ['disposable-email-mailtm'],
      toolRequests: [{ tool: 'fetch_url', origin: 'https://api.mail.tm', pathRoot: '/messages' }],
    },
  },
  run: { status: 'completed' },
  trace: { run: { updates: [{ type: 'tool_call', data: { name: 'load_skill', args: { skill_id: 'disposable-email-mailtm' } } }] } },
});
assert.equal(missingMailTmGrade.passed, false, 'loading the skill alone must not prove Mail.tm use');
const unconfirmedMailTmGrade = gradeScenario({
  scenario: {
    id: 'mailtm-unconfirmed',
    verify: {
      toolRequests: [{
        tool: 'fetch_url',
        method: 'POST',
        origin: 'https://api.mail.tm',
        pathRoot: '/accounts',
      }],
    },
  },
  run: { status: 'completed' },
  trace: {
    run: {
      updates: [{
        type: 'tool_call',
        data: {
          name: 'fetch_url',
          args: {
            url_origin: 'https://api.mail.tm',
            url_path_root: '/accounts',
            method: 'POST',
          },
        },
      }],
    },
  },
});
assert.equal(unconfirmedMailTmGrade.passed, false, 'a request without a result must not count as evidence');
const cleanupGrade = gradeScenario({
  scenario,
  run,
  cleanupErrors: [new Error('fixture cleanup failed')],
});
assert.equal(cleanupGrade.passed, false);
assert.equal(cleanupGrade.stuck_at, 'cleanup');

console.log(`ci tests passed (${scenarios.length} scenarios validated)`);
