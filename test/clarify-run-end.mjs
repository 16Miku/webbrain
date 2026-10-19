import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

// A finished run accepts no more answers. A WebBrain card it still showed,
// such as the typing permission card on screen when the user pressed Stop
// (C2 trace), closes with the run instead of staying clickable.
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const panel = (await readFile(new URL(`../src/${build}/src/ui/sidepanel.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const extract = name => {
    const start = panel.indexOf(`function ${name}(`);
    const end = panel.indexOf('\n}\n', start);
    assert.ok(start >= 0 && end > start, `missing ${name}`);
    return panel.slice(start, end + 2);
  };

  test(`${build}: a finished run closes the cards it still showed`, () => {
    const runComplete = panel.slice(panel.indexOf("    case 'run_complete':"), panel.indexOf("    case 'clarify':"));
    assert.match(runComplete, /invalidateUnresolvedClarifyCards\(eventAssistantEl \|\| currentAssistantEl, '', \{ keepScheduled: true \}\);/);
  });

  test(`${build}: closing a run's cards removes its permission cards and keeps a scheduled task's`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<div class="message assistant"><div class="message-content">
        <div class="clarify-card" data-clarify-id="perm-typing" data-permission="1"><button>Allow once</button><button>Deny</button></div>
        <div class="clarify-card" data-clarify-id="question"><input class="clarify-input"><button>Send</button></div>
        <div class="clarify-card clarify-answered" data-clarify-id="answered"><button disabled>Done</button></div>
        <div class="clarify-card" data-clarify-id="scheduled-question" data-scheduled-job-id="job-1"><button>Reply</button></div>
      </div></div>`);
      const counts = await page.evaluate(source => {
        window.cleared = [];
        window.clearClarifyCountdown = card => cleared.push(card.dataset.clarifyId);
        window.eval(source);
        invalidateUnresolvedClarifyCards(document.querySelector('.message.assistant'), '', { keepScheduled: true });
        const card = id => document.querySelector(`[data-clarify-id="${id}"]`);
        return {
          permission: !!card('perm-typing'),
          question: { obsolete: card('question').classList.contains('clarify-obsolete'),
            disabled: [...card('question').querySelectorAll('button, input')].every(control => control.disabled) },
          answered: card('answered').classList.contains('clarify-obsolete'),
          scheduled: { obsolete: card('scheduled-question').classList.contains('clarify-obsolete'),
            enabled: !card('scheduled-question').querySelector('button').disabled },
          cleared,
        };
      }, extract('invalidateUnresolvedClarifyCards'));
      assert.equal(counts.permission, false, 'a permission card is transient and leaves with its run');
      assert.deepEqual(counts.question, { obsolete: true, disabled: true }, 'a question stays readable but locked');
      assert.equal(counts.answered, false, 'an answered card is untouched');
      assert.deepEqual(counts.scheduled, { obsolete: false, enabled: true }, 'a scheduled task waits for its own answer');
      assert.deepEqual(counts.cleared, ['perm-typing', 'question']);
    } finally { await browser.close(); }
  });
}
