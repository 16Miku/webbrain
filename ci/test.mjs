import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeScenario, inferStuckAt, renderSummary } from './lib/grader.mjs';
import { sanitizeTrace } from './lib/sanitize.mjs';
import { buildSessionSettings, resolveCloudRunId, suiteShouldFail } from './lib/suite.mjs';
import { GnippetsE2EClient, WebBrainCloudClient } from './lib/webbrain-client.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(await fs.readFile(path.join(root, 'catalog', 'scenarios.json'), 'utf8'));

assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length);
assert.ok(scenarios.every((scenario) => scenario.output_schema?.type === 'object'));
assert.ok(scenarios.every((scenario) => scenario.verify));
const signupScenario = scenarios.find((scenario) => scenario.id === 'gnippets-signup-otp-disposable');
assert.equal(signupScenario.api_mutations_allowed, true);
assert.match(signupScenario.task, /POST \/accounts/);

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
const cloudClient = new WebBrainCloudClient({
  apiKey: 'test-cloud-key',
  baseUrl: 'https://webbrain.example',
  fetchImpl: async (_url, options) => {
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
assert.doesNotMatch(JSON.stringify(sensitiveTrace), /private@example|mailbox-secret|provider-secret|654321/);

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
      forbiddenTools: ['navigate'],
    },
  },
  run: { status: 'completed', mode: 'ask' },
  trace: {
    run: {
      updates: [{ type: 'tool_call', data: { name: 'load_skill', args: { skill_id: 'forms' } } }],
    },
  },
});
assert.equal(skillGrade.passed, true);
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
