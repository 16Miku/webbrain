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
          const shown = result.placeholderFields.map(({ label, value, placeholder, changed, name, id }) => ({ label, value, placeholder, changed, name, id }));
          assert.deepEqual(shown, [
            { label: 'Email', value: 'you@example.com', placeholder: 'you@example.com', changed: true, name: 'email', id: 'email' },
            { label: 'City', value: 'Istanbul', placeholder: 'Istanbul', changed: false, name: 'city', id: 'city' },
          ], 'the edited email field first, then the page default marked unchanged; never the password');
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
          // clear:false appends to what the field already holds.
          await page.evaluate(() => { document.querySelector('#email').value = 'you@'; });
          const appended = await probe('set_field', { ref_id: 'ref_email', text: 'example.com', clear: false, submit: true });
          assert.equal(appended.placeholderFields?.[0]?.fullValue, 'you@example.com', 'the field ends up holding its placeholder');
          const replaced = await probe('set_field', { ref_id: 'ref_email', text: 'example.com', submit: true });
          assert.deepEqual(replaced.placeholderFields, [], 'set_field replaces the value by default');
        });

        await t.test('untouched matches cannot push an edited field out of the list', async () => {
          await page.setContent('<form method="post" action="/many">'
            + Array.from({ length: 600 }, (_, i) => `<input name="d${i}" placeholder="Example" value="Example">`).join('')
            + '<input id="email" name="email" aria-label="Email" placeholder="you@example.com"><button id="go">Save</button></form>');
          await page.evaluate(() => { document.querySelector('#email').value = 'you@example.com'; });
          const result = await probe('click', { selector: '#go' });
          assert.equal(result?.isSubmit, true);
          assert.equal(result.placeholderFields[0]?.name, 'email', 'the edited field comes first');
          assert.equal(result.placeholderFields[0]?.changed, true);
        });

        await t.test('any number of controls the scan skips cannot hide an edited field', async () => {
          await page.setContent('<form method="post" action="/many">'
            + Array.from({ length: 6000 }, (_, i) => `<input type="hidden" name="h${i}" value="x">`).join('')
            + Array.from({ length: 200 }, (_, i) => `<input name="d${i}" placeholder="Example" value="Example" disabled>`).join('')
            + '<input id="email" name="email" aria-label="Email" placeholder="you@example.com"><button id="go">Save</button></form>');
          await page.evaluate(() => { document.querySelector('#email').value = 'you@example.com'; });
          const result = await probe('click', { selector: '#go' });
          assert.equal(result?.isSubmit, true);
          assert.deepEqual(result.placeholderFields.map(field => [field.name, field.changed]), [['email', true]]);
        });

        await t.test('a field outside the form that names it with form= is checked too', async () => {
          await page.setContent('<form id="signup" method="post" action="/signup"><button id="go">Sign up</button></form>'
            + '<input id="email" form="signup" name="email" aria-label="Email" placeholder="you@example.com">');
          await page.evaluate(() => { document.querySelector('#email').value = 'you@example.com'; });
          const result = await probe('click', { selector: '#go' });
          assert.equal(result?.isSubmit, true);
          assert.equal(result.placeholderFields?.[0]?.name, 'email');
          assert.equal(result.placeholderFields?.[0]?.changed, true);
        });

        await t.test('a long prefilled placeholder value the page shipped is not counted as edited', async () => {
          const long = `Describe your request in detail ${'and include every relevant date '.repeat(6)}`.trim();
          await page.setContent('<form method="post" action="/ticket">'
            + `<textarea id="note" name="note" aria-label="Note" placeholder="${long}">${long}</textarea>`
            + `<input id="title" name="title" aria-label="Title" placeholder="${long}" value="${long}"><button id="go">Send</button></form>`);
          const result = await probe('click', { selector: '#go' });
          assert.equal(result?.isSubmit, true);
          assert.ok(long.length > 120);
          assert.deepEqual(result.placeholderFields.map(field => [field.name, field.changed]), [['note', false], ['title', false]]);
          await page.evaluate(text => { document.querySelector('#title').value = `${text} more`; }, long);
          const edited = await probe('click', { selector: '#go' });
          assert.deepEqual(edited.placeholderFields.map(field => [field.name, field.changed]), [['note', false]],
            'a changed long value no longer equals its placeholder');
        });

        await t.test('a disabled field is not sent and not listed; the whole value is returned', async () => {
          const long = `Describe the change you need ${'with every detail that matters '.repeat(8)}`.trim();
          await page.setContent('<form method="post" action="/change">'
            + '<input id="off" name="off" aria-label="Off" placeholder="you@example.com" disabled>'
            + '<fieldset disabled><input id="inner" name="inner" aria-label="Inner" placeholder="you@example.com"></fieldset>'
            + `<textarea id="about" name="about" aria-label="About" placeholder="${long}"></textarea><button id="go">Send</button></form>`);
          await page.evaluate(text => {
            document.querySelector('#off').value = 'you@example.com';
            document.querySelector('#inner').value = 'you@example.com';
            document.querySelector('#about').value = text;
          }, long);
          const result = await probe('click', { selector: '#go' });
          assert.equal(result?.isSubmit, true);
          assert.deepEqual(result.placeholderFields.map(field => field.name), ['about'], 'disabled fields are not sent');
          assert.ok(long.length > 200);
          assert.equal(result.placeholderFields[0].fullValue, long, 'the whole value');
          assert.equal(result.placeholderFields[0].complete, true);
          assert.equal(result.placeholderFields[0].value.length, 200, 'the display value is shortened');
        });
        if (build === 'chrome') {
          await t.test('a form in a closed shadow root is scanned in the page, as the debugger runs it', async () => {
            const scan = Agent._placeholderFieldScan.toString();
            await page.setContent('<div id="host"></div>');
            const fields = await page.evaluate(source => {
              const root = document.querySelector('#host').attachShadow({ mode: 'closed' });
              root.innerHTML = '<form method="post" action="/join">'
                + '<input id="email" name="email" aria-label="Email" placeholder="you@example.com">'
                + '<input id="city" name="city" placeholder="Istanbul" value="Istanbul">'
                + '<input id="pass" name="pass" type="password" placeholder="Password">'
                + '<input id="off" name="off" placeholder="you@example.com" disabled>'
                + '<button id="go">Join</button></form>';
              root.querySelector('#email').value = 'you@example.com';
              root.querySelector('#pass').value = 'Password';
              root.querySelector('#off').value = 'you@example.com';
              return (0, eval)(`(${source})`).call(root.querySelector('#go'));
            }, scan);
            assert.deepEqual(fields.map(field => [field.name, field.changed, field.ref]), [['email', true, ''], ['city', false, '']],
              'the edited field first, the page default marked unchanged; never the password or a disabled field');
            // With no form, the shadow root's own fields are read.
            const formless = await page.evaluate(source => {
              const host = document.createElement('div');
              document.body.append(host);
              const root = host.attachShadow({ mode: 'closed' });
              root.innerHTML = '<input id="email" name="email" placeholder="you@example.com"><div role="button" id="go">Join</div>';
              root.querySelector('#email').value = 'you@example.com';
              return (0, eval)(`(${source})`).call(root.querySelector('#go'));
            }, scan);
            assert.deepEqual(formless.map(field => field.name), ['email']);
          });
        }
      } finally {
        await browser.close();
      }
    });
  }
}
