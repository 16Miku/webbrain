import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';

// The body that triggered the false manual-verification stop in the trace.
// All browser work uses local document fixtures; no posts or solver requests.
const draft = 'Tough week at WebBrain.\n\nFirst, I made a mistake: an overly aggressive anti-CAPTCHA measure broke some Cloudflare-protected sites. I’m sorry for the disruption.';
const draftHeading = 'Verify you are human — notes for our CAPTCHA article';

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const gate = await import(`../src/${build}/src/agent/captcha-gate.js`);
  const runtime = await import(`../src/${build}/src/agent/captcha-frame-runtime.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  test(`${build}: CAPTCHA tree detection separates field names from editor values and descendants`, () => {
    const trees = [
      `dialog [ref_1]\n button "Publish post" [ref_2]\n textbox [ref_3] value=${JSON.stringify(draft)}`,
      'dialog "Compose post" [ref_1]\n textbox "CAPTCHA article body" [ref_2]\n  heading "reCAPTCHA challenge" [ref_3]\n  generic "hCaptcha notes" [ref_4]\n button "Post" [ref_5]',
      'dialog [ref_1]\n generic [ref_2] contenteditable="plaintext-only"\n  heading "Security verification" [ref_3]\n button "Publish" [ref_4]',
      'dialog [ref_1] title="CAPTCHA draft"\n textbox [ref_2] placeholder="CAPTCHA notes"',
    ];
    const read = title => title === 'Security verification' ? 'human_check' : 'other';
    for (const tree of trees) {
      assert.equal(gate.detectChallengeDialog(tree, read), null, tree);
      assert.ok(!gate.challengeDialogTitles(tree).some(title => /^(?:reCAPTCHA challenge|hCaptcha notes|Security verification|CAPTCHA notes|CAPTCHA draft)$/.test(title)), tree);
    }
    // Excluding an answer field must preserve the independent challenge.
    const challenge = 'dialog [ref_1]\n textbox "Answer" [ref_2] value="notes"\n generic "Complete the CAPTCHA" [ref_3]';
    assert.equal(gate.detectChallengeDialog(challenge)?.label, 'Complete the CAPTCHA');
    assert.equal(gate.detectChallengeDialog('dialog "Security verification" [ref_1]\n textbox "Answer" [ref_2]', read)?.label,
      'Security verification');
  });

  test(`${build}: static CAPTCHA answer labels receive semantic readings without exposing typed values`, () => {
    for (const role of ['textbox', 'searchbox', 'combobox']) {
      const tree = `dialog [ref_1]\n ${role} "Enter CAPTCHA" [ref_2] type="text" value="anti-CAPTCHA draft"\n button "Continue" [ref_3]`;
      assert.ok(gate.challengeDialogTitles(tree).includes('Enter CAPTCHA'));
      assert.equal(gate.detectChallengeDialog(tree), null, 'An unread field label alone is not proof of a challenge');
      assert.equal(gate.detectChallengeDialog(tree, label => label === 'Enter CAPTCHA' ? 'human_check' : 'other')?.label,
        'Enter CAPTCHA');
      assert.equal(gate.detectChallengeDialog(tree, () => 'other'), null);
      assert.ok(!gate.challengeDialogTitles(tree).includes('anti-CAPTCHA draft'));
    }
    const titleWithAnswer = 'dialog [ref_1]\n generic "Security verification" [ref_2]\n textbox "Answer" [ref_3]';
    assert.ok(gate.challengeDialogTitles(titleWithAnswer).includes('Security verification'));
    assert.equal(gate.detectChallengeDialog(titleWithAnswer, () => 'human_check')?.label, 'Security verification');
    const authored = 'dialog "Compose post" [ref_1]\n textbox "CAPTCHA article body" [ref_2]\n  heading "Verify you are human" [ref_3]';
    assert.ok(gate.challengeDialogTitles(authored).includes('CAPTCHA article body'));
    assert.ok(!gate.challengeDialogTitles(authored).includes('Verify you are human'));
    assert.equal(gate.detectChallengeDialog(authored, () => 'other'), null);
    const crowdedForm = 'dialog "Register" [ref_1]\n'
      + Array.from({ length: 16 }, (_, n) => ` textbox "Profile field ${n}" [ref_${n + 2}]`).join('\n')
      + '\n textbox "Enter CAPTCHA" [ref_answer] type="text"';
    const boundedNames = gate.challengeDialogTitles(crowdedForm);
    assert.equal(boundedNames.length, 12);
    assert.equal(boundedNames[0], 'Enter CAPTCHA', 'Ordinary fields must not crowd out the CAPTCHA answer name');
    assert.equal(gate.detectChallengeDialog(crowdedForm, label => label === 'Enter CAPTCHA' ? 'human_check' : 'other')?.label,
      'Enter CAPTCHA');
  });

  test(`${build}: drafted CAPTCHA prose permits publish preflight while real challenges remain detected`, async t => {
    const browser = await engine.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.route('https://**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>Local challenge-frame fixture' }));
    const fixture = async ({ editor = 'contenteditable="true" role="textbox"', named = '', hidden = false } = {}) => {
      await page.setContent(`<!doctype html><style>
        [role=dialog]{width:600px;padding:20px}[role=textbox],textarea,input{min-height:80px;width:400px}
      </style><div role="dialog" ${named} ${hidden ? 'hidden' : ''}>
        <button id="publish">Publish post</button><div id="editor" ${editor}></div>
      </div>`);
      await page.evaluate(({ draft, draftHeading }) => {
        document.getElementById('editor').innerHTML = '';
        const paragraph = document.createElement('p'); paragraph.textContent = draft;
        const heading = document.createElement('h2'); heading.textContent = draftHeading;
        // Even a read-only fragment in an editable root is authored content.
        heading.setAttribute('contenteditable', 'false');
        document.getElementById('editor').append(paragraph, heading);
        document.getElementById('publish').onclick = () => { window.fixturePublished = true; };
      }, { draft, draftHeading });
    };
    const options = { ...gate.captchaChallengeMatcherOptions({
      [draftHeading]: 'human_check', 'Security verification': 'human_check',
    }), includeFrameContext: true };
    const scan = () => page.evaluate(({ source, options }) => window.eval(`(${source})`)(options),
      { source: gate.detectChallengeDialogInPage.toString(), options });

    for (const editor of ['contenteditable="true" role="textbox"', 'contenteditable="plaintext-only"', 'role="textbox"']) {
      for (const named of ['', 'aria-label="Compose post"', 'aria-labelledby="editor"']) {
        await fixture({ editor, named });
        const observed = await scan();
        assert.equal(observed.challenge, null, `${editor}, ${named}`);
        assert.ok(!observed.unreadTitles?.includes(draftHeading));
      }
    }
    await fixture({ hidden: true });
    assert.equal((await scan()).hiddenChallenge, undefined, 'Hidden authored text cannot be evidence of a hidden challenge');

    for (const tag of ['input', 'textarea']) {
      await page.setContent(`<div role="dialog"><${tag} id="editor"></${tag}><button>Publish post</button></div>`);
      await page.locator('#editor').fill('CAPTCHA');
      assert.equal((await scan()).challenge, null, `${tag}: field values must not name a challenge`);
    }

    // Exercise the runtime path that previously denied the publish click.
    await fixture();
    const apiName = build === 'chrome' ? 'chrome' : 'browser';
    const previous = globalThis[apiName];
    const evaluate = (source, args = []) => page.evaluate(({ source, args }) => window.eval(`(${source})`)(...args), { source, args });
    globalThis[apiName] = {
      tabs: { get: async () => ({ url: page.url() }), executeScript: async (_tab, spec) => [await page.evaluate(spec.code)] },
      scripting: { executeScript: async spec => [{ frameId: 0, result: await evaluate(spec.func.toString(), spec.args) }] },
      webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: page.url() }] },
    };
    t.after(() => { globalThis[apiName] = previous; });
    const agent = new Agent({ getActive: () => ({ promptTier: 'full' }) });
    agent._observeAwsWafGate = async () => null;
    agent._readChallengeTitles = async (_tab, titles) => {
      assert.ok(!titles.some(title => /captcha|human/i.test(title)), 'The draft became a page-blocker title');
      return false;
    };
    assert.equal(await agent._captchaMutationPreflight(1, 'click_ax', { ref_id: 'ref_publish' }), null);
    assert.equal(agent._captchaGateStates.has(1), false);
    await page.locator('#publish').click();
    assert.equal(await page.evaluate(() => fixturePublished), true);

    // Static challenge instructions beside an editable answer remain valid.
    await page.evaluate(() => {
      const challenge = document.createElement('p'); challenge.textContent = 'Complete the CAPTCHA';
      document.querySelector('[role=dialog]').append(challenge);
    });
    assert.equal((await scan()).challenge?.label, 'Complete the CAPTCHA');
    assert.equal((await agent._detectChallengeDialogBeforeMutation(1))?.label, 'Complete the CAPTCHA');
    await page.evaluate(() => { document.querySelector('[role=dialog]').hidden = true; });
    assert.equal((await scan()).hiddenChallenge?.label, 'Complete the CAPTCHA');

    // Inline formatting preserves product spelling and title-reading keys.
    await page.setContent('<div role="dialog"><h2>CAP<span>TCHA</span> challenge</h2><input></div>');
    assert.equal((await scan()).challenge?.label, 'CAPTCHA challenge');
    await page.setContent('<div role="dialog"><h2 style="display:contents">CAPTCHA challenge</h2><input></div>');
    assert.equal((await scan()).challenge?.label, 'CAPTCHA challenge');
    await page.setContent('<div role="dialog"><h2>Security <span>verification</span></h2><input></div>');
    assert.equal((await scan()).challenge?.label, 'Security verification');
    await page.setContent('<div role="dialog"><h2 style="display:contents">Security verification</h2><input></div>');
    assert.equal((await scan()).challenge?.label, 'Security verification');
    await page.setContent('<div role="dialog"><h2 hidden>CAPTCHA challenge</h2><input></div>');
    assert.equal((await scan()).challenge, null, 'Hidden instructions do not name the visible dialog');
    await page.setContent('<span id="challenge-title">Security verification</span><div role="dialog" hidden aria-labelledby="challenge-title"><input></div>');
    assert.equal((await scan()).hiddenChallenge?.label, 'Security verification');
    await page.setContent('<span id="challenge-title" hidden>CAPTCHA challenge</span><div role="dialog" aria-labelledby="challenge-title"><input></div>');
    assert.equal((await scan()).challenge?.label, 'CAPTCHA challenge');
    await page.setContent('<div id="editor" contenteditable="true">CAPTCHA draft</div><div role="dialog" hidden aria-labelledby="editor"></div>');
    assert.equal((await scan()).hiddenChallenge, undefined);

    // Language-neutral vendor challenge frames are still independently gated.
    await page.setContent('<div role="dialog"><div contenteditable="true">CAPTCHA draft</div><iframe src="https://www.google.com/recaptcha/api2/bframe"></iframe></div>');
    assert.equal((await scan()).challenge?.languageNeutralFrame, true);

    // Candidate association uses the same static-text rule as preflight.
    await fixture();
    await page.evaluate(() => {
      const widget = document.createElement('div'); widget.className = 'g-recaptcha';
      widget.setAttribute('data-sitekey', 'fixture-site-key');
      document.querySelector('[role=dialog]').append(widget);
    });
    const candidates = () => page.evaluate(({ source, options }) => window.eval(`(${source})`)(null, options),
      { source: runtime.detectCaptchaCandidatesInPage.toString(), options });
    assert.equal((await candidates()).candidates.find(candidate => candidate.websiteKey === 'fixture-site-key')?.dialogAssociated, false);
    await page.evaluate(() => {
      const title = document.createElement('h2'); title.textContent = 'Security verification';
      title.style.display = 'contents';
      document.querySelector('[role=dialog]').prepend(title);
    });
    assert.equal((await scan()).challenge?.label, 'Security verification');
    assert.equal((await candidates()).candidates.find(candidate => candidate.websiteKey === 'fixture-site-key')?.dialogAssociated, true);
  });
}
