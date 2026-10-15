import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const { RunUiJournal, compactRunUiData, compactRunUiSnapshotForPersist } = await import(`../src/${build}/src/run-ui-journal.js`);
  for (const name of ['auto_screenshot', 'staged_screenshot']) {
    test(`${build}: ${name} description survives delivery and persistence`, async () => {
      const description = 'Visible page: a search box and navigation. '.repeat(70) + 'END OF DESCRIPTION';
      const journal = new RunUiJournal();
      journal.begin(7, 'capture');
      const event = journal.record(7, 'capture', 'tool_result', { name, result: {
        success: true, description, method: 'vision_describe', model: 'fixture-vision', visionRoute: 'dedicated', dataUrl: 'data:image/png;base64,PRIVATE',
      } });
      assert.equal(event.data.result.description, description);
      assert.equal(event.data.result.dataUrl, undefined);
      const restored = new RunUiJournal();
      restored.restore(7, JSON.parse(JSON.stringify(compactRunUiSnapshotForPersist(journal.get(7), { tight: true }))));
      assert.deepEqual(restored.get(7).events[0].data, event.data);
      const source = await readFile(`src/${build}/src/ui/sidepanel.js`, 'utf8');
      const compact = source.slice(source.indexOf('function markLastStepDone('), source.indexOf('\nfunction markLastStepFailed('));
      const verbose = source.slice(source.indexOf('function appendVerboseToolResult('), source.indexOf('\nfunction ', source.indexOf('function appendVerboseToolResult(') + 1));
      if (process.env.WEBBRAIN_SCREENSHOT_UI !== '1') return;
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        for (const mode of ['compact', 'verbose']) {
          const text = await page.evaluate(({ compact, verbose, name, result, mode }) => {
            document.body.innerHTML = '<div class="message-content"><div class="step-item active"><span class="step-icon"></span></div><div class="step-details"></div><div class="tool-call" data-awaiting-result="true"><div class="tool-call-name"></div></div></div>';
            const currentAssistantEl = document.body;
            document.querySelector('.tool-call').dataset.toolName = name;
            const findLastActiveCompactStep = () => document.querySelector('.step-item.active');
            const isTerminalDoneTool = () => false;
            const restoreStepFriendlyLabel = () => {};
            const t = key => key;
            const escapeHtml = text => { const el = document.createElement('span'); el.textContent = text; return el.innerHTML; };
            const truncate = (text, length) => text.slice(0, length);
            eval(`${compact}\n${verbose}\n${mode === 'compact' ? 'markLastStepDone' : 'appendVerboseToolResult'}(name, result);`);
            return document.querySelector(mode === 'compact' ? '.detail-result' : '.tool-result').textContent;
          }, { compact, verbose, name, result: event.data.result, mode });
          assert.ok(text.includes('END OF DESCRIPTION'), `${mode} must show the description beyond the generic cutoff`);
          assert.ok(text.includes('fixture-vision'));
        }
      } finally { await browser.close(); }
    });
  }
  test(`${build}: screenshot descriptions stay bounded through repeated compaction`, () => {
    const data = { name: 'auto_screenshot', result: { success: true, description: 'x'.repeat(13000) } };
    const once = compactRunUiData('tool_result', data);
    assert.equal(once.result.description.length, 12000);
    assert.equal(once.result.descriptionTruncated, true);
    assert.deepEqual(compactRunUiData('tool_result', once), once);
  });
}
