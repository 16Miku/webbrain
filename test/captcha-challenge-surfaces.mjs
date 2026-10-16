import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';

// Exercise the functions as serialized into the page. Fixtures contain no
// external scripts, frames, requests, posts, or solver calls.
const draft = 'Notes for our anti-CAPTCHA article: verify you are human.';
const siteKey = 'challenge-surfaces-fixture-key';
const widget = `<div class="g-recaptcha" data-sitekey="${siteKey}"></div>`;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const gate = await import(`../src/${build}/src/agent/captcha-gate.js`);
  const runtime = await import(`../src/${build}/src/agent/captcha-frame-runtime.js`);

  test(`${build}: static CAPTCHA surfaces survive answer fields and CSS layout`, async t => {
    const browser = await engine.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const options = readings => ({
      ...gate.captchaChallengeMatcherOptions(readings), includeFrameContext: true,
    });
    const scan = readings => page.evaluate(({ source, options }) => window.eval(`(${source})`)(options), {
      source: gate.detectChallengeDialogInPage.toString(), options: options(readings),
    });
    const candidates = readings => page.evaluate(({ source, options }) => window.eval(`(${source})`)(null, options), {
      source: runtime.detectCaptchaCandidatesInPage.toString(), options: options(readings),
    });
    const assertAssociation = async (associated, readings = null) => {
      const observed = (await candidates(readings)).candidates.find(candidate => candidate.websiteKey === siteKey);
      assert.ok(observed, 'The fixture widget must be discovered');
      assert.equal(observed.dialogAssociated, associated, 'Widget association must agree with the static challenge');
    };
    const setDialog = async contents => page.setContent(`<!doctype html><style>
      [role=dialog]{width:600px;padding:20px}input,textarea,[role=textbox]{min-height:30px}
    </style><div role="dialog">${contents}${widget}</div>`);

    const fields = [
      ['hidden reCAPTCHA response', '<textarea id="answer" name="g-recaptcha-response" hidden></textarea>'],
      ['hidden input response', '<input id="answer" name="g-recaptcha-response" type="hidden">'],
      ['ordinary input', '<input id="answer">'],
      ['ordinary textarea', '<textarea id="answer"></textarea>'],
      ['textbox', '<div id="answer" role="textbox"></div>'],
      ['editable textbox', '<div id="answer" role="textbox" contenteditable="true"></div>'],
    ];
    for (const [name, field] of fields) {
      await t.test(`unnamed first-line title with ${name}`, async () => {
        await setDialog(`<div>Security verification</div>${field}`);
        await page.evaluate(draft => {
          const answer = document.getElementById('answer');
          if ('value' in answer) answer.value = draft;
          else answer.textContent = draft;
        }, draft);

        const unread = await scan();
        assert.equal(unread.challenge, null, 'A non-product title needs a reading');
        assert.deepEqual(unread.unreadTitles, ['Security verification'], 'Answer fields must not suppress the static title');
        await assertAssociation(false);
        const readings = { 'Security verification': 'human_check' };
        assert.equal((await scan(readings)).challenge?.label, 'Security verification');
        await assertAssociation(true, readings);
      });
    }

    const hiddenResponses = [
      ['hidden input', '<input type="hidden" name="g-recaptcha-response" aria-labelledby="static-title">'],
      ['hidden textarea', '<textarea hidden name="g-recaptcha-response" aria-labelledby="static-title"></textarea>'],
    ];
    for (const [name, field] of hiddenResponses) {
      await t.test(`a ${name} reference cannot consume the first static title`, async () => {
        await setDialog(`<div id="static-title">Security verification</div>${field}`);
        await page.evaluate(draft => { document.querySelector('[name="g-recaptcha-response"]').value = draft; }, draft);
        assert.deepEqual((await scan()).unreadTitles, ['Security verification']);
        const readings = { 'Security verification': 'human_check' };
        assert.equal((await scan(readings)).challenge?.label, 'Security verification');
        await assertAssociation(true, readings);
      });

      await t.test(`an inactive challenge keeps static product proof beside a ${name} reference`, async () => {
        await page.setContent(`<!doctype html><div role="dialog" hidden><div id="static-title">CAPTCHA challenge</div>${field}${widget}</div>`);
        await page.evaluate(draft => { document.querySelector('[name="g-recaptcha-response"]').value = draft; }, draft);
        const observed = await scan();
        assert.equal(observed.challenge, null);
        assert.equal(observed.hiddenChallenge?.label, 'CAPTCHA challenge');
        await assertAssociation(false);
      });
    }

    const layouts = [
      ['block-styled spans', '<span style="display:block">Complete</span><span style="display:block">CAPTCHA</span>', 'CAPTCHA'],
      ['inline-styled div', '<span>CAP<div style="display:inline">TCHA</div> challenge</span>', 'CAPTCHA challenge'],
      ['display:contents wrapper', '<span>CAP<div style="display:contents">TCHA</div> challenge</span>', 'CAPTCHA challenge'],
      ['nested display:contents wrappers', '<span>CAP<div style="display:contents"><div style="display:contents">TCHA</div></div> challenge</span>', 'CAPTCHA challenge'],
    ];
    for (const [name, text, label] of layouts) {
      await t.test(`rendered boundaries for ${name}`, async () => {
        await setDialog(`${text}<input id="answer" value="CAPTCHA draft">`);
        assert.equal((await scan()).challenge?.label, label);
        await assertAssociation(true);
      });
    }

    await t.test('CSS boundaries keep the first static title reading key', async () => {
      await setDialog('<span style="display:block">Security <div style="display:inline">verification</div></span><textarea>CAPTCHA draft</textarea>');
      assert.deepEqual((await scan()).unreadTitles, ['Security verification']);
      const readings = { 'Security verification': 'human_check' };
      assert.equal((await scan(readings)).challenge?.label, 'Security verification');
      await assertAssociation(true, readings);
    });

    await t.test('a hidden ARIA label retains CSS block word boundaries', async () => {
      await page.setContent(`<!doctype html><span id="challenge-label" hidden><span style="display:block">Complete</span><span style="display:block">CAPTCHA</span></span>
        <div role="dialog" aria-labelledby="challenge-label"><input value="CAPTCHA draft">${widget}</div>`);
      assert.equal((await scan()).challenge?.label, 'CAPTCHA');
      await assertAssociation(true);
    });

    await t.test('a hidden ARIA label retains CSS inline spelling and reading keys', async () => {
      await page.setContent(`<!doctype html><span id="challenge-label" hidden>Security <div style="display:inline">verification</div></span>
        <div role="dialog" aria-labelledby="challenge-label"><textarea>CAPTCHA draft</textarea>${widget}</div>`);
      assert.deepEqual((await scan()).unreadTitles, ['Security verification']);
      const readings = { 'Security verification': 'human_check' };
      assert.equal((await scan(readings)).challenge?.label, 'Security verification');
      await assertAssociation(true, readings);
    });

    const namedFields = [
      ['ARIA label', label => `<input id="answer" aria-label="${label}">`],
      ['hidden ARIA reference', label => `<span id="answer-label" hidden>${label}</span><input id="answer" aria-labelledby="answer-label">`],
      ['native label', label => `<label for="answer">${label}</label><input id="answer">`],
    ];
    for (const [name, field] of namedFields) {
      await t.test(`a static answer name needs a human-check reading: ${name}`, async () => {
        await setDialog(`<img alt="Verification image" width="120" height="40">${field('Enter CAPTCHA')}`);
        await page.evaluate(draft => { document.getElementById('answer').value = draft; }, draft);
        const unread = await scan();
        assert.equal(unread.challenge, null, 'A field name alone cannot prove a challenge');
        assert.ok(unread.unreadTitles?.includes('Enter CAPTCHA'), 'The static field name must be available for reading');
        await assertAssociation(false);
        const readings = { 'Enter CAPTCHA': 'human_check' };
        assert.equal((await scan(readings)).challenge?.label, 'Enter CAPTCHA');
        await assertAssociation(true, readings);
      });

      await t.test(`an authored editor name read as other is ignored: ${name}`, async () => {
        await setDialog(field('CAPTCHA article body'));
        await page.evaluate(draft => { document.getElementById('answer').value = draft; }, draft);
        const readings = { 'CAPTCHA article body': 'other' };
        assert.equal((await scan(readings)).challenge, null);
        await assertAssociation(false, readings);
      });
    }

    await t.test('field labels inside editable descendants remain authored content', async () => {
      await setDialog(`<div contenteditable="true"><label for="answer">Enter CAPTCHA</label><input id="answer" aria-label="Enter CAPTCHA"></div>`);
      const readings = { 'Enter CAPTCHA': 'human_check' };
      const observed = await scan(readings);
      assert.equal(observed.challenge, null);
      assert.ok(!observed.unreadTitles?.includes('Enter CAPTCHA'));
      await assertAssociation(false, readings);
    });

    await t.test('an answer label remains readable after many unrelated profile fields', async () => {
      const profileFields = Array.from({ length: 16 }, (_, index) => `<input aria-label="Profile field ${index + 1}">`).join('');
      await page.setContent(`<!doctype html><div role="dialog" aria-label="Register">${profileFields}<input aria-label="Enter CAPTCHA">${widget}</div>`);
      const unread = await scan();
      assert.equal(unread.challenge, null);
      assert.ok(unread.unreadTitles?.includes('Enter CAPTCHA'), 'The reading cap must not discard the challenge answer label');
      assert.ok(unread.unreadTitles.length <= 12, 'Title reading work remains bounded');
      const readings = { 'Enter CAPTCHA': 'human_check' };
      assert.equal((await scan(readings)).challenge?.label, 'Enter CAPTCHA');
      await assertAssociation(true, readings);
    });

    const authoredOnly = [
      ['input value', `<input value="${draft}">`],
      ['textarea value', `<textarea>${draft}</textarea>`],
      ['textbox descendants', '<div role="textbox"><h2>Security verification</h2><span style="display:block">Complete</span><span style="display:block">CAPTCHA</span></div>'],
      ['editable descendants', '<div contenteditable="true"><div>Security verification</div><h2 contenteditable="false">CAPTCHA article</h2></div>'],
    ];
    for (const [name, contents] of authoredOnly) {
      await t.test(`authored-only negative: ${name}`, async () => {
        await setDialog(contents);
        const observed = await scan({ 'Security verification': 'human_check' });
        assert.equal(observed.challenge, null);
        assert.equal(observed.hiddenChallenge, undefined);
        assert.ok(!observed.unreadTitles?.some(title => /captcha|verification/i.test(title)));
        await assertAssociation(false, { 'Security verification': 'human_check' });
      });
    }
  });
}
