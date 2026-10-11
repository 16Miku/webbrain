import test from 'node:test';
import assert from 'node:assert/strict';

for (const build of ['chrome', 'firefox']) {
  const { RunUiJournal, compactRunUiSnapshotForPersist } = await import(`../src/${build}/src/run-ui-journal.js`);
  const interrupted = () => {
    const journal = new RunUiJournal({ eventLimit: 2 });
    journal.begin(7, 'ask', { mode: 'ask' });
    journal.record(7, 'ask', 'text_delta', { content: 'An unfinished explanation' });
    journal.record(7, 'ask', 'response_retry', { reason: 'stream_interrupted', retainPartial: true });
    return journal;
  };

  test(`${build}: an acknowledged interrupted answer survives cold replay with its retry status`, () => {
    const journal = interrupted();
    journal.record(7, 'ask', 'warning', { code: 'ask_stream_fallback' });
    journal.acknowledge(7, 'ask', journal.get(7).seq);
    const persisted = JSON.parse(JSON.stringify(compactRunUiSnapshotForPersist(journal.get(7), { tight: true })));
    const restored = new RunUiJournal();
    restored.restore(7, persisted);
    assert.deepEqual(restored.get(7).events, []);
    assert.equal(restored.get(7).streamedText, 'An unfinished explanation');
    assert.equal(restored.get(7).responseIncomplete, true);
    assert.deepEqual(restored.get(7).responseRetry, { reason: 'stream_interrupted', retainPartial: true, seq: 2 });
    assert.equal(restored.get(7).successfulDone, false);
    assert.equal(restored.get(7).runSucceeded, false);
    assert.equal(restored.get(7).finalContent, '');
  });

  test(`${build}: a regenerated stream replaces the incomplete snapshot rather than appending to it`, () => {
    const journal = interrupted();
    journal.record(7, 'ask', 'text_delta', { content: 'A replacement' });
    journal.record(7, 'ask', 'text_delta', { content: ' explanation.' });
    assert.equal(journal.get(7).streamedText, 'A replacement explanation.');
    assert.equal(journal.get(7).streamedTextStartSeq, 3);
    assert.equal(journal.get(7).streamedTextSeq, 4);
    assert.equal(journal.get(7).responseRetry, null);
    assert.equal(journal.get(7).responseIncomplete, false);
  });

  test(`${build}: a full replacement or an explicit safety clear ends the provisional display`, () => {
    for (const content of ['The complete explanation.', '']) {
      const journal = interrupted();
      journal.record(7, 'ask', 'text', { content, replace: true });
      assert.equal(journal.get(7).streamedText, '');
      assert.equal(journal.get(7).responseRetry, null);
      assert.equal(journal.get(7).responseIncomplete, false);
      assert.equal(journal.get(7).events.at(-1).data.content, content);
    }
  });

  test(`${build}: retry status survives reconnect even before the first token`, () => {
    const journal = new RunUiJournal();
    journal.begin(7, 'ask', { mode: 'ask' });
    journal.record(7, 'ask', 'response_retry', { reason: 'stream_interrupted', retainPartial: false });
    journal.acknowledge(7, 'ask', 1);
    const restored = new RunUiJournal();
    restored.restore(7, compactRunUiSnapshotForPersist(journal.get(7)));
    assert.equal(restored.get(7).responseRetry.retainPartial, false);
    assert.equal(restored.get(7).streamedText, '');
  });

  test(`${build}: terminal outcomes and new execution boundaries clear the retry status`, () => {
    for (const type of ['tool_call', 'error', 'failure_recovery', 'steering_applied', 'run_complete']) {
      const journal = interrupted();
      journal.record(7, 'ask', type, {});
      assert.equal(journal.get(7).responseRetry, null, type);
    }
    const resumed = interrupted();
    resumed.resume(7, 'ask');
    assert.equal(resumed.get(7).responseRetry, null);
    for (const status of ['completed', 'stopped', 'failed']) {
      const journal = interrupted();
      journal.finish(7, 'ask', status);
      assert.equal(journal.get(7).responseRetry, null, status);
      assert.equal(journal.get(7).runSucceeded, false, 'partial text alone never proves completion');
    }
  });

  test(`${build}: restoration rejects stale, malformed, and terminal retry markers`, () => {
    for (const responseRetry of [undefined, {}, { reason: 'stream_interrupted', seq: 100 },
      { reason: 'stream_interrupted', seq: -1 }, { reason: 'other', seq: 2 }]) {
      const snapshot = structuredClone(interrupted().get(7));
      snapshot.responseRetry = responseRetry;
      const restored = new RunUiJournal();
      assert.equal(restored.restore(7, snapshot).responseRetry, null);
    }
    const terminal = structuredClone(interrupted().get(7));
    terminal.status = 'failed';
    assert.equal(new RunUiJournal().restore(7, terminal).responseRetry, null);
  });

  test(`${build}: failed or stopped retries remain incomplete after terminal events are acknowledged`, () => {
    for (const status of ['failed', 'stopped', 'cancelled']) {
      const journal = interrupted();
      journal.record(7, 'ask', 'error', { message: 'The replacement could not finish.' });
      journal.finish(7, 'ask', status, status === 'stopped' ? '[Stopped by user]' : 'The replacement could not finish.');
      journal.acknowledge(7, 'ask', journal.get(7).seq);
      const snapshot = JSON.parse(JSON.stringify(compactRunUiSnapshotForPersist(journal.get(7))));
      const restored = new RunUiJournal().restore(7, snapshot);
      assert.equal(restored.responseRetry, null);
      assert.equal(restored.responseIncomplete, true);
      assert.equal(restored.runSucceeded, false);
      assert.equal(restored.streamedText, 'An unfinished explanation');
    }
    const completed = interrupted();
    completed.finish(7, 'ask', 'completed', 'The full replacement.', null, { askSucceeded: true });
    assert.equal(completed.get(7).responseIncomplete, false);
  });
}
