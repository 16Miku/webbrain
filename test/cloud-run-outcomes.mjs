import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
for (const browser of ['chrome', 'firefox']) {
  const { createCloudRunController } = await import(`../src/${browser}/src/cloud-runs.js`);
  function harness(processMessage, extra = {}) {
    const stored = {};
    let seq = 0;
    const agent = { isRunning: () => false, processMessage, abort() {}, strictSecretMode: true };
    const api = { storage: { session: { get: async key => ({ [key]: stored[key] }), set: async data => Object.assign(stored, data) } },
      tabs: { get: async () => ({ id: 7, url: 'https://example.com' }), query: async () => [{ id: 7, url: 'https://example.com' }], update: async () => {} } };
    const c = createCloudRunController({ chromeApi: api, agent, makeRunId: () => `run_${++seq}`, ensureOffscreen: async () => {}, ...extra });
    return { c, stored, agent, api };
  }
  async function finished(c, run) {
    for (let i = 0; i < 100 && ['running', 'aborting'].includes(c.runs.get(run.runId).status); i++) await tick();
    return c.status({ runId: run.runId });
  }
  test(`${browser}: tracked continuation keeps its run and tab lock, evidence and secrets`, async () => {
    let clock = Date.parse('2026-10-05T10:00:00Z'), releaseWait;
    const waiting = new Promise(resolve => { releaseWait = resolve; });
    const observed = [];
    const { c } = harness(async (tab, prompt, update, mode, _attachments, options) => {
      observed.push({ tab, prompt, mode, options });
      options.onTraceStarted(`trace_${observed.length}`);
      if (observed.length === 1) {
        update('tool_call', { name: 'set_field', args: { text: 'private-login-secret' } });
        const resume = options.deferResume({ after_seconds: 30, reason: 'Wait for page', resume_instruction: 'Continue the same task' });
        assert.equal(resume.success, true);
        options.onRunFinished('scheduled_resume');
        return resume.summary;
      }
      update('tool_result', { name: 'read_page', result: { url: 'https://news.ycombinator.com/item?id=12345678' } });
      options.onRunFinished('done');
      return 'Article https://news.ycombinator.com/item?id=12345678; private-login-secret';
    }, { now: () => new Date(clock), waitForResume: async () => { await waiting; clock += 30000; }, workflowTrace: { getRun: async () => ({ conversationId: 'same-conversation' }) } });
    const run = await c.startRun({ task: 'Read a public article' });
    await tick();
    assert.equal((await c.status({ runId: run.runId })).status, 'running');
    assert.equal(c.runs.get(run.runId).completedAt, null);
    await assert.rejects(c.startRun({ task: 'Other task' }), e => e.status === 409);
    releaseWait();
    const done = await finished(c, run);
    assert.equal(done.status, 'completed');
    assert.equal(observed.length, 2);
    assert.equal(observed[1].options.trustedContinuation, true);
    assert.equal(observed[1].options.scheduledResume, true);
    assert.equal(observed[1].options.independentRun, false);
    assert.equal(observed[1].options.parentRunId, 'trace_1');
    assert.equal(observed[1].options.parentSessionId, 'same-conversation');
    assert.match(observed[1].prompt, /^\[Scheduled resume run_\d+\]/);
    assert.match(observed[1].prompt, /Continue the same task/);
    assert.match(observed[1].prompt, /durable continuation/);
    assert.match(done.result, /item\?id=12345678/);
    assert.equal(JSON.stringify(done).includes('private-login-secret'), false);
    assert.equal(JSON.stringify(done.updates).includes('item?id=12345678'), false);
  });
  test(`${browser}: cancellation during a deferred resume never dispatches continuation`, async () => {
    let release, calls = 0;
    const waiting = new Promise(resolve => { release = resolve; });
    const { c } = harness(async (_tab, _task, _update, _mode, _attachments, options) => {
      calls++;
      const r = options.deferResume({ after_seconds: 30, reason: 'Waiting', resume_instruction: 'Continue' });
      options.onRunFinished('scheduled_resume');
      return r.summary;
    }, { waitForResume: () => waiting });
    const run = await c.startRun({ task: 'Read' }); await tick();
    assert.equal((await c.abort({ runId: run.runId })).status, 'aborting');
    release();
    assert.equal((await finished(c, run)).status, 'aborted');
    assert.equal(calls, 1);
  });
  test(`${browser}: failed, partial and recovery-limit outcomes preserve output without reporting success`, async () => {
    for (const outcome of ['partial', 'failed', 'empty_output', 'max_steps', 'required_tool_missing']) {
      const { c } = harness(async (_tab, _task, update, _mode, _attachments, options) => {
        update('tool_result', { name: 'done', result: { outcome: outcome === 'failed' ? 'failed' : undefined } });
        options.onRunFinished(outcome === 'failed' ? 'done' : outcome);
        return 'Only a draft, not posted';
      });
      const run = await c.startRun({ task: 'Comment on an article' });
      const done = await finished(c, run);
      assert.equal(done.status, 'failed');
      assert.match(done.error, /did not finish successfully/);
      assert.equal(done.result, 'Only a draft, not posted');
    }
  });
  test(`${browser}: continuation budget and restart stop safely instead of replaying page actions`, async () => {
    let clock = Date.now(), calls = 0;
    const { c, stored, agent, api } = harness(async (_tab, _task, _update, _mode, _attachments, options) => {
      calls++;
      const resume = options.deferResume({ after_seconds: 30, reason: 'Wait', resume_instruction: 'Continue' });
      options.onRunFinished(resume.success ? 'scheduled_resume' : 'partial');
      return resume.summary || resume.error;
    }, { now: () => new Date(clock), waitForResume: async ms => { clock += ms; } });
    const run = await c.startRun({ task: 'Read' });
    assert.equal((await finished(c, run)).status, 'failed');
    assert.equal(calls, 4);
    const row = structuredClone(stored.webbrainCloudRunSnapshots[0]);
    row.status = 'running'; row.completedAt = null;
    stored.webbrainCloudRunSnapshots = [row];
    const restarted = createCloudRunController({ chromeApi: api, agent, ensureOffscreen: async () => {} });
    assert.equal((await restarted.status({ runId: row.runId })).status, 'failed');
    assert.equal(calls, 4, 'restart never replays a possible consequential action');
  });
  test(`${browser}: oversized resume delays are rejected without holding the run`, async () => {
    const { c } = harness(async (_tab, _task, _update, _mode, _attachments, options) => {
      const resume = options.deferResume({ after_seconds: 7 * 24 * 60 * 60, reason: 'Wait a week', resume_instruction: 'Continue later' });
      assert.equal(resume.success, false);
      assert.match(resume.error, /5 minutes|partial/);
      options.onRunFinished('partial');
      return 'Partial answer';
    });
    const run = await c.startRun({ task: 'Read' });
    const done = await finished(c, run);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /did not finish successfully \(partial\)/);
  });
  test(`${browser}: explicit successful done wins over recovery trace status`, async () => {
    const { c } = harness(async (_tab, _task, update, _mode, _attachments, options) => {
      update('tool_result', { name: 'done', result: { outcome: 'success', summary: 'Recovered answer' } });
      options.onRunFinished('chrome_protected_page_visual_fallback');
      return 'Recovered answer';
    });
    const run = await c.startRun({ task: 'Read protected page' });
    const done = await finished(c, run);
    assert.equal(done.status, 'completed');
  });
  test(`${browser}: real auto-resume helper routes Cloud work to the controller, native scheduling stays unchanged`, async () => {
    const source = fs.readFileSync(new URL(`../src/${browser}/src/agent/agent.js`, import.meta.url), 'utf8');
    const method = source.slice(source.indexOf('  async _scheduleAutoProgressResume('), source.indexOf('  _plainFinalProgressBlock('));
    const helper = vm.runInNewContext(`({${method}})._scheduleAutoProgressResume`);
    let native = 0, cloud = 0;
    const fake = { scheduler: { createResumeJob: async () => { native++; return { success: true }; } },
      cloudRunContexts: new Map([[7, { deferResume: async args => { cloud++; assert.equal(args.after_seconds, 90); return { success: true }; } }]]),
      _effectiveRunMode: () => 'act', _isActionMode: () => true, _shouldBlockDoneForProgress: () => true,
      _getTabUrlTitle: async () => ({}), _buildAutoProgressResumeInstruction: () => 'Continue',
      conversationIds: new Map(), _resumeTaskId: () => 'task' };
    await helper.call(fake, 7);
    assert.equal(cloud, 1); assert.equal(native, 0);
    fake.cloudRunContexts.clear(); await helper.call(fake, 7);
    assert.equal(native, 1);
    const start = source.indexOf("    if (name === 'schedule_resume') {");
    const route = source.slice(start, source.indexOf('      if (!this.scheduler)', start));
    const toolRoute = vm.runInNewContext(`(async function(name,tabId,args){${route}\n}})`);
    fake.cloudRunContexts.set(7, { deferResume: async () => ({ success: true, cloud: true }) });
    fake._resumeArgsWithProgressGuard = (_tab, args) => args;
    assert.equal((await toolRoute.call(fake, 'schedule_resume', 7, {})).cloud, true);
  });
}
