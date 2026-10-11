import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ChromeScheduler from '../src/chrome/src/agent/scheduler.js';
import * as FirefoxScheduler from '../src/firefox/src/agent/scheduler.js';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

const args = { after_seconds: 60, reason: 'The authorized owned dialogue is waiting for its next fresh numbered question.',
  resume_instruction: 'Observe the same explicitly authorized conversation and durably wait again when no new question is available.' };
const input = { tabId: 77, conversationId: 'conv-1', resumeTaskId: 'owned-ongoing-goal', mode: 'act', args };

for (const [build, module] of [['chrome', ChromeScheduler], ['firefox', FirefoxScheduler]]) {
  test(`${build}: a running resume creates one future successor without deduping itself`, async () => {
    let harness, runs = 0;
    const results = [];
    harness = makeSchedulerHarness(module, { requireConfirmation: false,
      processMessage: async (_tabId, _message, onUpdate) => {
        runs++;
        if (runs <= 3) {
          const successor = await harness.manager.createResumeJob(input);
          const repeated = await harness.manager.createResumeJob(input);
          results.push({ successor, repeated });
          onUpdate('run_status', { status: 'scheduled_resume' });
          return successor.summary;
        }
        onUpdate('tool_result', { name: 'done', result: { done: true, success: true, outcome: 'success' } });
        return 'The owned conversation ended after verified replies.';
      },
    });
    let current = await harness.manager.createResumeJob(input);
    for (let turn = 0; turn < 4; turn++) {
      harness.setNow(Date.parse(current.scheduledAt) + 1);
      await harness.manager.handleAlarm(harness.alarmName(current.jobId));
      assert.equal(harness.jobs().find(job => job.id === current.jobId).status, 'completed');
      const waiting = harness.jobs().filter(job => ['pending', 'queued'].includes(job.status));
      if (turn < 3) {
        const { successor, repeated } = results[turn];
        assert.notEqual(successor.jobId, current.jobId,
          'A currently running alarm cannot substitute for a future scheduled wait.');
        assert.notEqual(successor.deduped, true);
        assert.equal(waiting.length, 1, 'Only one successor alarm is pending.');
        assert.equal(waiting[0].predecessorJobId, current.jobId);
        assert.equal(repeated.deduped, true, 'Repeated requests for the same pending successor still dedupe.');
        assert.equal(repeated.jobId, successor.jobId);
        assert.ok(harness.alarms.has(harness.alarmName(successor.jobId)));
        assert.ok(Date.parse(successor.scheduledAt) > Date.parse(current.scheduledAt));
        current = successor;
      } else assert.equal(waiting.length, 0);
    }
    assert.equal(runs, 4);
  });

  test(`${build}: restored predecessor and successor keep separate alarms and duplicate successors coalesce`, async () => {
    let harness, release, created;
    const ready = new Promise(resolve => { created = resolve; });
    harness = makeSchedulerHarness(module, { requireConfirmation: false,
      processMessage: async (_tabId, _message, onUpdate) => {
        const successor = await harness.manager.createResumeJob(input);
        created(successor);
        await new Promise(resolve => { release = resolve; });
        onUpdate('run_status', { status: 'scheduled_resume' });
        return successor.summary;
      },
    });
    const first = await harness.manager.createResumeJob(input);
    harness.setNow(Date.parse(first.scheduledAt) + 1);
    const running = harness.manager.handleAlarm(harness.alarmName(first.jobId));
    const next = await ready;
    const saved = structuredClone(harness.jobs());
    release(); await running;
    assert.notEqual(next.jobId, first.jobId);
    const duplicate = { ...saved.find(job => job.id === next.jobId), id: 'duplicate-future-wait',
      createdAt: new Date(Date.parse(next.scheduledAt) + 1).toISOString() };
    const restored = makeSchedulerHarness(module, { jobs: [...saved, duplicate], requireConfirmation: false,
      now: Date.parse(next.scheduledAt) - 1000 });
    await restored.manager.restoreAlarms();
    const byId = Object.fromEntries(restored.jobs().map(job => [job.id, job]));
    assert.equal(byId[first.jobId].status, 'queued', 'An interrupted read-only predecessor retains its retry.');
    assert.equal(byId[next.jobId].status, 'pending', 'The genuine successor must survive restore coalescing.');
    assert.equal(byId[duplicate.id].status, 'cancelled', 'Only duplicate future waits are coalesced.');
    assert.ok(restored.alarms.has(restored.alarmName(first.jobId)));
    assert.ok(restored.alarms.has(restored.alarmName(next.jobId)));
    assert.equal(restored.alarms.has(restored.alarmName(duplicate.id)), false);
  });
}
