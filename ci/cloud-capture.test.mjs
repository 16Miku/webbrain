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
const SHORT_PIN = '731';
const strictLeakAgent = {
  strictSecretMode: true,
  isRunning() { return false; },
  setApiMutationsAllowed() {},
  async processMessage(_tabId, _task, publishUpdate) {
    publishUpdate('tool_call', { name: 'load_skill', args: { skill_id: 'otp-verification-code-helper' } });
    publishUpdate('tool_result', { name: 'load_skill', result: { success: true } });
    // Typing a secret registers it, so any later quote of the literal is struck
    // by value rather than left to a key-name guess.
    publishUpdate('tool_call', { name: 'set_field', args: { ref_id: 'ref_otp', text: OTP } });
    publishUpdate('tool_call', { name: 'set_field', args: { ref_id: 'ref_pin', text: SHORT_PIN } });
    publishUpdate('tool_result', { name: 'set_field', result: { success: true } });
    // A clarification cannot be blanked — the caller has to read it to answer —
    // so it must come through usable but with the literal removed.
    publishUpdate('clarify', {
      clarifyId: 'clarify_1',
      question: `The disposable inbox returned code ${OTP}. Continue with this temporary signup?`,
      options: ['yes', 'no'],
      reason: `Confirm before submitting ${OTP}.`,
    });
    publishUpdate('warning', { message: `Retrying submission with code ${OTP}.` });
    publishUpdate('warning', { message: `Temporary PIN ${SHORT_PIN}; unrelated x${SHORT_PIN}x stays ordinary.` });
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
assert.equal(JSON.stringify(strictLeakSnapshot).includes(`PIN ${SHORT_PIN}`), false);
assert.equal(
  strictLeakSnapshot.updates.some(update => String(update.data?.message || '').includes(`x${SHORT_PIN}x`)),
  true,
  'short secret replacement must use token boundaries instead of mangling unrelated text',
);
// Persistence is a second publication path with its own copy of the updates.
assert.equal(JSON.stringify(storedRows).includes(OTP), false, 'a strict run must not persist a secret');
// Booleans are what scenario grading reads, so redaction must leave them alone.
assert.equal(strictLeakSnapshot.result.signup_completed, true);
assert.equal(strictLeakSnapshot.result.otp_submitted, true);
// The caller's own field survives with only the credential struck out of it —
// the public result is the contract they asked for, not a wall of placeholders.
assert.equal(strictLeakSnapshot.result.note, 'code [redacted strict value]');
// Grading evidence that does not carry page content still survives.
const strictCalls = strictLeakSnapshot.updates.filter(update => update.type === 'tool_call');
assert.equal(strictCalls.find(update => update.data.name === 'load_skill').data.args.skill_id, 'otp-verification-code-helper');
const strictReads = strictLeakSnapshot.updates.filter(update => (
  update.type === 'tool_result' && update.data.name === 'get_accessibility_tree'
));
assert.deepEqual(strictReads[0].data.result, { success: true, sensitivePayloadRedacted: true });
// The clarification survives in answerable form — the CI driver regex-matches
// this question — while the literal is gone.
const strictClarify = strictLeakSnapshot.updates.find(update => update.type === 'clarify');
assert.equal(strictClarify.data.clarifyId, 'clarify_1');
assert.deepEqual(strictClarify.data.options, ['yes', 'no']);
assert.match(strictClarify.data.question, /disposable inbox|temporary signup/);
assert.match(strictClarify.data.question, /\[redacted strict value\]/);
// pendingInput stores this same payload, and the whole-snapshot check above
// covers it; the run has already cleared it by the time this fixture settles.
// Free text on other update types is covered by the same value redaction.
const strictWarning = strictLeakSnapshot.updates.find(update => update.type === 'warning');
assert.match(strictWarning.data.message, /Retrying submission/);
assert.equal(strictWarning.data.message.includes(OTP), false);

// The registry is bounded. If a hostile result fills it, strict mode must stop
// publishing scalar values rather than evict an older secret and leak it.
storedRows = [];
const overflowSecrets = Array.from({ length: 257 }, (_value, index) => `overflow-secret-${index}`);
const strictOverflowController = createCloudRunController({
  chromeApi,
  agent: {
    strictSecretMode: true,
    isRunning() { return false; },
    setApiMutationsAllowed() {},
    abort() {},
    async processMessage(_tabId, _task, publishUpdate) {
      publishUpdate('tool_result', {
        name: 'read_page',
        result: Object.fromEntries(overflowSecrets.map((secret, index) => [`item_${index}_token`, secret])),
      });
      publishUpdate('clarify', {
        clarifyId: 'clarify_overflow',
        question: `Should ${overflowSecrets.at(-1)} be submitted?`,
        options: ['yes', 'no'],
      });
      return `Finished with ${overflowSecrets[0]}.`;
    },
  },
  ensureOffscreen: async () => {},
  makeRunId: () => 'run_strict_overflow_fixture',
});
await strictOverflowController.startRun({ task: 'strict overflow fixture' });
let strictOverflowSnapshot;
for (let attempt = 0; attempt < 40; attempt += 1) {
  strictOverflowSnapshot = await strictOverflowController.status({ runId: 'run_strict_overflow_fixture' });
  if (strictOverflowSnapshot.status === 'completed') break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(strictOverflowSnapshot.status, 'completed');
for (const secret of [overflowSecrets[0], overflowSecrets.at(-1)]) {
  assert.equal(JSON.stringify(strictOverflowSnapshot).includes(secret), false);
  assert.equal(JSON.stringify(storedRows).includes(secret), false);
}

// A secret surfaced under a key the scrubber already knows is registered too,
// so a later quote of the literal is struck rather than masked only in place.
storedRows = [];
const strictReadController = createCloudRunController({
  chromeApi,
  agent: {
    strictSecretMode: true,
    isRunning() { return false; },
    setApiMutationsAllowed() {},
    abort() {},
    async processMessage(_tabId, _task, publishUpdate) {
      publishUpdate('tool_result', { name: 'fetch_url', result: { success: true, otp: OTP } });
      publishUpdate('clarify', { clarifyId: 'clarify_2', question: `Submit code ${OTP}?`, options: ['yes'] });
      return 'done';
    },
  },
  ensureOffscreen: async () => {},
  makeRunId: () => 'run_strict_read_fixture',
});
await strictReadController.startRun({ task: 'strict read fixture' });
let strictReadSnapshot;
for (let attempt = 0; attempt < 40; attempt += 1) {
  strictReadSnapshot = await strictReadController.status({ runId: 'run_strict_read_fixture' });
  if (strictReadSnapshot.status === 'completed') break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(strictReadSnapshot.status, 'completed');
assert.equal(JSON.stringify(strictReadSnapshot).includes(OTP), false);
assert.equal(JSON.stringify(storedRows).includes(OTP), false);
assert.match(
  strictReadSnapshot.updates.find(update => update.type === 'clarify').data.question,
  /Submit code \[redacted strict value\]\?/,
);

// Terminal fields publish over the same two routes as update rows. An
// unstructured strict run has no structured result, so its final answer is the
// result — it must come back readable with the literal struck, not raw.
storedRows = [];
const strictProseController = createCloudRunController({
  chromeApi,
  agent: {
    strictSecretMode: true,
    isRunning() { return false; },
    setApiMutationsAllowed() {},
    abort() {},
    async processMessage(_tabId, _task, publishUpdate) {
      publishUpdate('tool_call', { name: 'set_field', args: { ref_id: 'ref_otp', text: OTP } });
      return `Signup finished. The code was ${OTP}.`;
    },
  },
  ensureOffscreen: async () => {},
  makeRunId: () => 'run_strict_prose_fixture',
});
await strictProseController.startRun({ task: 'strict prose fixture' }); // no outputSchema
let strictProseSnapshot;
for (let attempt = 0; attempt < 40; attempt += 1) {
  strictProseSnapshot = await strictProseController.status({ runId: 'run_strict_prose_fixture' });
  if (strictProseSnapshot.status === 'completed') break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(strictProseSnapshot.status, 'completed');
assert.equal(JSON.stringify(strictProseSnapshot).includes(OTP), false);
assert.equal(JSON.stringify(storedRows).includes(OTP), false);
assert.match(strictProseSnapshot.content, /^Signup finished\. The code was \[redacted strict value\]\.$/);
assert.equal(strictProseSnapshot.result, strictProseSnapshot.content);

// A secret is not always a string: request bodies and tool results can carry an
// OTP or PIN as a JSON number. The trace row takes the blunt leaf-type
// redaction, while the public result keeps every schema-valid value and strikes
// only the registered credential — a strict run has to stay useful to its
// caller.
storedRows = [];
const NUMERIC_OTP = 735914;
const NUMERIC_RESULT_PIN = 864209;
const BODY_PASSWORD = 'Tr0ub4dor-correct-horse';
const strictLeafController = createCloudRunController({
  chromeApi,
  agent: {
    strictSecretMode: true,
    isRunning() { return false; },
    setApiMutationsAllowed() {},
    abort() {},
    async processMessage(_tabId, _task, publishUpdate) {
      // Minted in a request body and never typed, so only the body parser can
      // register its numeric form.
      publishUpdate('tool_call', {
        name: 'fetch_url',
        args: {
          url: 'https://api.mail.tm/accounts',
          method: 'POST',
          body: JSON.stringify({
            address: 'ci@mail.tm',
            password: BODY_PASSWORD,
            otp: NUMERIC_OTP,
          }),
        },
      });
      publishUpdate('tool_call', { name: 'set_field', args: { ref_id: 'ref_otp', text: OTP } });
      publishUpdate('tool_result', {
        name: 'read_page',
        result: { success: true, pin: NUMERIC_RESULT_PIN },
      });
      const payload = {
        verification_code: NUMERIC_OTP,
        nested: {
          pin_digits: [NUMERIC_OTP, 7],
          result_pin: NUMERIC_RESULT_PIN,
          note: `code ${OTP}`,
          account: BODY_PASSWORD,
        },
        item_name: 'widget',
        item_count: 3,
        signup_completed: true,
        opted_out: false,
        absent: null,
      };
      // The call is published before argument validation can reject it, so the
      // args are a publication path in their own right.
      publishUpdate('tool_call', { name: 'done_json', args: { result: payload, summary: `code ${OTP}` } });
      publishUpdate('tool_result', {
        name: 'done_json',
        result: { success: true, cloudResult: payload, summary: `code ${OTP}` },
      });
      return 'done';
    },
  },
  ensureOffscreen: async () => {},
  makeRunId: () => 'run_strict_leaf_fixture',
});
await strictLeafController.startRun({ task: 'strict leaf fixture', outputSchema: { type: 'object' } });
let strictLeafSnapshot;
for (let attempt = 0; attempt < 40; attempt += 1) {
  strictLeafSnapshot = await strictLeafController.status({ runId: 'run_strict_leaf_fixture' });
  if (strictLeafSnapshot.status === 'completed') break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(strictLeafSnapshot.status, 'completed');
for (const source of [JSON.stringify(strictLeafSnapshot), JSON.stringify(storedRows)]) {
  assert.equal(source.includes(String(NUMERIC_OTP)), false, 'a numeric secret escaped strict mode');
  assert.equal(source.includes(OTP), false, 'a string secret escaped strict mode');
  assert.equal(source.includes(BODY_PASSWORD), false, 'a request-body credential escaped strict mode');
}
// Public result: registered credentials struck, the caller's contract intact.
assert.equal(strictLeafSnapshot.result.verification_code, '[redacted strict value]');
assert.deepEqual(strictLeafSnapshot.result.nested.pin_digits, ['[redacted strict value]', 7]);
assert.equal(strictLeafSnapshot.result.nested.result_pin, '[redacted strict value]');
assert.equal(strictLeafSnapshot.result.nested.note, 'code [redacted strict value]');
assert.equal(strictLeafSnapshot.result.nested.account, '[redacted strict value]');
assert.equal(strictLeafSnapshot.result.item_name, 'widget', 'a schema-valid string must survive');
assert.equal(strictLeafSnapshot.result.item_count, 3, 'a schema-valid number must survive');
assert.equal(strictLeafSnapshot.result.signup_completed, true, 'grading reads booleans; they must survive');
assert.equal(strictLeafSnapshot.result.opted_out, false);
assert.equal(strictLeafSnapshot.result.absent, null);
// Trace row: no contract to honour, so the blunt leaf-type redaction stands.
const strictLeafTrace = strictLeafSnapshot.updates
  .find(update => update.type === 'tool_result' && update.data.name === 'done_json').data.result;
assert.equal(strictLeafTrace.cloudResult.item_name, '[redacted strict value]');
assert.equal(strictLeafTrace.cloudResult.item_count, '[redacted strict number]');
assert.equal(strictLeafTrace.cloudResult.signup_completed, true);

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
