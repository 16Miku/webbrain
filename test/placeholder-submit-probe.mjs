// The submit probe lists every field that holds its own placeholder text,
// for the placeholder guard, and says whether it differs from its default.
// Unlike the summary's changed fields, which stop at eight, the list covers
// the whole form, and it never carries a password.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { fixtureControlEffectReading, probeWithReadings } from './semantic-decision-stub.mjs';

const pageUrl = 'https://signup.example/register';

for (const build of ['chrome', 'firefox']) {
  for (const engine of ['chromium', 'firefox']) {
    test(`${build} build on ${engine}: the submit probe lists placeholder values across the whole form`, async t => {
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
        await t.test('a placeholder past the summary\'s first eight fields is listed', async () => {
          await page.setContent('<form method="post" action="/register">'
            + Array.from({ length: 10 }, (_, i) => `<input name="f${i}" aria-label="Field ${i}" placeholder="Example ${i}">`).join('')
            + '<input id="email" name="email" aria-label="Email" placeholder="you@example.com">'
            + '<input id="pass" name="pass" type="password" aria-label="Password" placeholder="Password">'
            + '<input id="city" name="city" aria-label="City" placeholder="Istanbul" value="Istanbul">'
            + '<button id="go">Save</button></form>');
          await page.evaluate(() => {
            for (let i = 0; i < 10; i++) document.querySelector(`[name=f${i}]`).value = `Answer ${i}`;
            document.querySelector('#email').value = 'you@example.com';
            document.querySelector('#pass').value = 'Password';
          });
          const result = await probe('click', { selector: '#go' });
          assert.equal(result?.isSubmit, true);
          assert.equal(result.changedFields.length, 8, 'the summary stops at eight');
          assert.ok(!result.changedFields.some(field => field.label === 'Email'), 'the email field is past the summary');
          assert.deepEqual(result.placeholderFields, [
            { label: 'Email', value: 'you@example.com', placeholder: 'you@example.com', changed: true },
            { label: 'City', value: 'Istanbul', placeholder: 'Istanbul', changed: false },
          ], 'the edited email field, and the page default marked unchanged; never the password');
        });

        await t.test('a value set_field is about to type and submit is checked too', async () => {
          await page.setContent('<form method="post" action="/subscribe">'
            + '<input id="email" name="email" aria-label="Email" placeholder="you@example.com"><button>Subscribe</button></form>');
          // set_field names its field by ref, as the accessibility tree hands it out.
          await page.evaluate(() => { window.__wb_ax_lookup = ref => (ref === 'ref_email' ? document.querySelector('#email') : null); });
          const result = await probe('set_field', { ref_id: 'ref_email', text: 'you@example.com', submit: true });
          assert.equal(result?.isSubmit, true);
          assert.equal(result.placeholderFields?.[0]?.value, 'you@example.com');
          const own = await probe('set_field', { ref_id: 'ref_email', text: 'reader@example.org', submit: true });
          assert.deepEqual(own.placeholderFields, []);
        });
      } finally {
        await browser.close();
      }
    });
  }
}
