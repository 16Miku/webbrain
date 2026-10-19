// A submission the user declined is remembered for the rest of the turn by
// the page elements it goes through, as the submit probe identifies them:
// the form and its button. Per-row forms that post the same visible fields to
// one endpoint, told apart only by hidden IDs, and two buttons of one form are
// different submissions. The same form and button, clicked again or reached
// by an Enter in the form's field, is the same submission.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { fixtureControlEffectReading, probeWithReadings } from './semantic-decision-stub.mjs';

const pageUrl = 'https://rows.example/list';

for (const build of ['chrome', 'firefox']) {
  for (const engine of ['chromium', 'firefox']) {
    test(`${build} build on ${engine}: the submit probe tells forms and buttons apart`, async t => {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const browser = await (engine === 'chromium' ? chromium : firefox).launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>fixture</title>' }));
      const page = await context.newPage();
      await page.goto(pageUrl);
      const source = Agent._submitActionProbe.toString();
      const runProbe = (tool, args) => page.evaluate(({ source, tool, args }) => (0, eval)(`(${source})`)(tool, args), { source, tool, args });
      const probe = (tool, args) => probeWithReadings(runProbe, tool, args, fixtureControlEffectReading);
      try {
        await t.test('per-row forms with the same fields and action are different submissions', async () => {
          await page.setContent(['1', '2'].map(row => '<form method="post" action="/rows/save">'
            + `<input type="hidden" name="row" value="${row}"><input name="note" aria-label="Note" value="Done">`
            + `<button id="save-${row}">Save</button></form>`).join(''));
          const first = await probe('click', { selector: '#save-1' });
          const again = await probe('click', { selector: '#save-1' });
          const other = await probe('click', { selector: '#save-2' });
          assert.equal(first?.isSubmit, true);
          assert.ok(first.submissionIdentity, 'the probe identifies the form and button');
          assert.equal(again.submissionIdentity, first.submissionIdentity, 'the same form and button');
          assert.notEqual(other.submissionIdentity, first.submissionIdentity, 'another row');
          // Without the elements, the two rows read the same.
          assert.equal(other.actionUrl, first.actionUrl);
          assert.deepEqual(other.changedFields, first.changedFields);
        });

        await t.test('two buttons of one form differ, and an Enter goes through the default button', async () => {
          await page.setContent('<form method="post" action="/review">'
            + '<input id="comment" name="comment" aria-label="Comment" value="Looks good">'
            + '<button id="save">Save</button><button id="send" name="decision" value="send">Send</button></form>');
          const save = await probe('click', { selector: '#save' });
          const send = await probe('click', { selector: '#send' });
          assert.equal(save?.isSubmit, true);
          assert.equal(send?.isSubmit, true);
          assert.notEqual(send.submissionIdentity, save.submissionIdentity, 'another button of the form');
          await page.focus('#comment');
          const enter = await probe('press_keys', { keys: 'Enter' });
          assert.equal(enter?.isSubmit, true);
          assert.equal(enter.submissionIdentity, save.submissionIdentity, 'an Enter in the field submits through the first button');
        });
      } finally {
        await browser.close();
      }
    });
  }
}
