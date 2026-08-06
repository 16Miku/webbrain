import assert from 'node:assert/strict';
import { cloudSafeScheduledJob, createCloudRunController } from '../src/chrome/src/cloud-runs.js';

let storedRows = [];
const chromeApi = {
  storage: {
    session: {
      async get() { return { webbrainCloudRunSnapshots: storedRows }; },
      async set(value) { storedRows = value.webbrainCloudRunSnapshots; },
    },
    local: {
      async get() { return {}; },
    },
  },
  tabs: {
    async query() { return [{ id: 7, url: 'https://example.test/', active: true, windowId: 1 }]; },
    async get() { return { id: 7, url: 'https://example.test/done', active: true, windowId: 1 }; },
    async update() {},
    async create() { return { id: 7 }; },
  },
  windows: { async update() {} },
  runtime: { async sendMessage() {} },
};
const agent = {
  isRunning() { return false; },
  setApiMutationsAllowed() {},
  async processMessage() { return 'done'; },
  abort() {},
};
const calls = [];
const controller = createCloudRunController({
  chromeApi,
  agent,
  ensureOffscreen: async () => {},
  makeRunId: () => 'run_capture_fixture',
  startRecording: async (tabId, options) => {
    calls.push(['start', tabId, options]);
    return { ok: true, state: { recordingId: 'rec_fixture' } };
  },
  stopRecording: async (options) => {
    calls.push(['stop', options]);
    return { ok: true, filename: 'webbrain-ci-run_capture_fixture.webm' };
  },
});

await controller.startRun({ task: 'fixture', capture: 'video' });
let snapshot;
for (let attempt = 0; attempt < 40; attempt += 1) {
  snapshot = await controller.status({ runId: 'run_capture_fixture' });
  if (snapshot.status === 'completed') break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}

assert.equal(snapshot.status, 'completed');
assert.equal(calls[0][0], 'start');
assert.equal(calls[0][2].mic, false);
assert.equal(calls[0][2].filename, 'webbrain-ci-run_capture_fixture.webm');
assert.deepEqual(calls[1], ['stop', { expectedRecordingId: 'rec_fixture' }]);
assert.equal(snapshot.updates.at(-1).type, 'artifact');
assert.equal(snapshot.updates.at(-1).data.filename, 'webbrain-ci-run_capture_fixture.webm');

storedRows = [];
const strictSecretAgent = {
  strictSecretMode: true,
  isRunning() { return false; },
  setApiMutationsAllowed() {},
  async processMessage(_tabId, _task, publishUpdate) {
    publishUpdate('tool_result', {
      name: 'verify_form',
      result: {
        success: true,
        fields: [
          { name: 'username', type: 'text', value: 'fixture-user' },
          { name: 'password', type: 'password', value: 'fixture-password' },
          { name: 'newsletter', type: 'checkbox', value: 'yes', controlValue: 'yes' },
        ],
        frames: [{
          fields: [{ name: 'otp', type: 'text', value: '123456' }],
          targetChecks: [{ valuePrefix: '123', valueSuffix: '456' }],
        }],
      },
    });
    return 'done';
  },
  abort() {},
};
const strictSecretController = createCloudRunController({
  chromeApi,
  agent: strictSecretAgent,
  ensureOffscreen: async () => {},
  makeRunId: () => 'run_strict_secret_fixture',
});

await strictSecretController.startRun({ task: 'strict secret fixture' });
let strictSecretSnapshot;
for (let attempt = 0; attempt < 40; attempt += 1) {
  strictSecretSnapshot = await strictSecretController.status({ runId: 'run_strict_secret_fixture' });
  if (strictSecretSnapshot.status === 'completed') break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}

assert.equal(strictSecretSnapshot.status, 'completed');
const verifyFormUpdate = strictSecretSnapshot.updates.find(update => (
  update.type === 'tool_result' && update.data?.name === 'verify_form'
));
assert.ok(verifyFormUpdate);
assert.deepEqual(
  verifyFormUpdate.data.result.fields.map(field => field.value),
  ['[redacted form value]', '[redacted form value]', '[redacted form value]'],
);
assert.equal(verifyFormUpdate.data.result.fields[2].controlValue, '[redacted form value]');
assert.equal(verifyFormUpdate.data.result.frames[0].fields[0].value, '[redacted form value]');
assert.equal(verifyFormUpdate.data.result.frames[0].targetChecks[0].valuePrefix, '[redacted form value]');
assert.equal(verifyFormUpdate.data.result.frames[0].targetChecks[0].valueSuffix, '[redacted form value]');
const strictSecretSnapshotJson = JSON.stringify(strictSecretSnapshot);
for (const secret of ['fixture-user', 'fixture-password', '123456']) {
  assert.equal(strictSecretSnapshotJson.includes(secret), false);
}

// A secret typed into a visible field comes back out of the next page read and
// out of the model's own prose, so strict mode has to deny by default rather
// than redact a list of known-risky tools.
storedRows = [];
const OTP = '481920';
const strictLeakAgent = {
  strictSecretMode: true,
  isRunning() { return false; },
  setApiMutationsAllowed() {},
  async processMessage(_tabId, _task, publishUpdate) {
    publishUpdate('tool_call', { name: 'load_skill', args: { skill_id: 'otp-verification-code-helper' } });
    publishUpdate('tool_result', { name: 'load_skill', result: { success: true } });
    // The OTP is now sitting in a visible input, so every read echoes it.
    publishUpdate('tool_result', {
      name: 'get_accessibility_tree',
      result: { success: true, tree: `textbox "Verification code" value="${OTP}"` },
    });
    publishUpdate('tool_result', { name: 'read_page', result: { success: true, text: `Code ${OTP} accepted.` } });
    publishUpdate('tool_result', { name: 'iframe_read', result: { success: true, html: `<input value="${OTP}">` } });
    // Model prose, streamed and final.
    publishUpdate('text_delta', { content: `Entered code ${OTP}` });
    publishUpdate('text_delta', { content: ' successfully.' });
    publishUpdate('text', { content: `Signup finished with code ${OTP}.`, replace: true });
    publishUpdate('run_status', { status: 'done', message: `Signup finished with code ${OTP}.` });
    // A script argument is just as good a carrier as a typed field.
    publishUpdate('tool_call', { name: 'execute_js', args: { code: `document.title='${OTP}'` } });
    publishUpdate('tool_call', {
      name: 'done_json',
      args: { result: { signup_completed: true, note: `code ${OTP}` }, summary: `Used code ${OTP}.` },
    });
    publishUpdate('tool_result', {
      name: 'done_json',
      result: {
        success: true,
        cloudResult: { signup_completed: true, otp_submitted: true, note: `code ${OTP}` },
        summary: `Used code ${OTP}.`,
      },
    });
    return `Signup finished with code ${OTP}.`;
  },
  abort() {},
};
const strictLeakController = createCloudRunController({
  chromeApi,
  agent: strictLeakAgent,
  ensureOffscreen: async () => {},
  makeRunId: () => 'run_strict_leak_fixture',
});
await strictLeakController.startRun({ task: 'strict leak fixture', outputSchema: { type: 'object' } });
let strictLeakSnapshot;
for (let attempt = 0; attempt < 40; attempt += 1) {
  strictLeakSnapshot = await strictLeakController.status({ runId: 'run_strict_leak_fixture' });
  if (strictLeakSnapshot.status === 'completed') break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}

assert.equal(strictLeakSnapshot.status, 'completed');
assert.equal(
  JSON.stringify(strictLeakSnapshot).includes(OTP),
  false,
  'a strict run must not publish a secret through page reads, model prose, or the structured result',
);
// Persistence is a second publication path with its own copy of the updates.
assert.equal(JSON.stringify(storedRows).includes(OTP), false, 'a strict run must not persist a secret');
// Booleans are what scenario grading reads, so redaction must leave them alone.
assert.equal(strictLeakSnapshot.result.signup_completed, true);
assert.equal(strictLeakSnapshot.result.otp_submitted, true);
assert.equal(strictLeakSnapshot.result.note, '[redacted strict value]');
// Grading evidence that does not carry page content still survives.
const strictCalls = strictLeakSnapshot.updates.filter(update => update.type === 'tool_call');
assert.equal(strictCalls.find(update => update.data.name === 'load_skill').data.args.skill_id, 'otp-verification-code-helper');
const strictReads = strictLeakSnapshot.updates.filter(update => (
  update.type === 'tool_result' && update.data.name === 'get_accessibility_tree'
));
assert.deepEqual(strictReads[0].data.result, { success: true, sensitivePayloadRedacted: true });

// A strict run that schedules a child task must not publish that child's raw
// prompt, result, or target URL through the scheduled-jobs query.
const scheduledJob = {
  id: 'task_1',
  kind: 'task',
  source: 'agent',
  title: `Verify inbox for ${OTP}`,
  status: 'completed',
  lastOutcome: 'success',
  lastResult: `Read code ${OTP} from the inbox.`,
  lastError: null,
  pendingClarify: { question: `Confirm code ${OTP}?` },
  target: { type: 'url', url: `https://gnippets.example/verify?code=${OTP}` },
  watch: { lastObservation: `code ${OTP}` },
  completedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const safeJob = cloudSafeScheduledJob(scheduledJob, { strictSecretMode: true });
assert.equal(JSON.stringify(safeJob).includes(OTP), false, 'strict mode must not publish child job payloads');
// The CI client still gets everything it polls and grades on.
assert.equal(safeJob.id, 'task_1');
assert.equal(safeJob.status, 'completed');
assert.equal(safeJob.lastOutcome, 'success');
assert.equal(safeJob.completedAt, '2026-01-01T00:00:00.000Z');
// Outside strict mode the payload is untouched.
assert.deepEqual(cloudSafeScheduledJob(scheduledJob, { strictSecretMode: false }), scheduledJob);

console.log('cloud capture test passed');
