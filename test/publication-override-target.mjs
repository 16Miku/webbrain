import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const html = `<!doctype html><style>
body{font:16px sans-serif}#composer{width:650px;padding:16px}article{padding:12px}
[contenteditable]{min-height:80px;width:600px}button{min-height:30px}
</style><nav><a data-testid="AppTabBar_Profile_Link" href="/owner">Profile</a></nav>
<div id="composer" role="dialog" aria-modal="true">
<article id="parent"><span>Mujeeb Ahmed @hey_mujeebahmed</span><p>The next AI workspace is the browser.</p>
<div id="quote" role="button" data-testid="quoteTweet"><span>Charles Maddock @charles_maddock</span>
<a role="link" href="/charles_maddock/status/222">Strawberry 1.0 is here.</a></div>
<a href="https://help.x.com/rules-and-policies/paid-partnerships-policy">Paid partnership</a></article>
<span data-testid="replyingTo">Replying to @hey_mujeebahmed</span>
<div id="body" contenteditable="true" role="textbox">Disclosure: I make WebBrain.</div>
<button id="publish" data-testid="tweetButton">Reply</button></div>`;

for (const build of ['chrome', 'firefox']) {
  test(`${build}: a visible reply parent without a permalink can be explicitly approved`, async () => {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    const page = await context.newPage();
    try {
      await page.goto('https://x.com/compose/post');
      const probe = () => page.evaluate(source => Function(`return (${source})`)()('click', { selector: '#publish' }),
        Agent._submitActionProbe.toString());
      const agent = new Agent({});
      const tab = 42;
      agent._persist = () => {};
      agent.conversations.set(tab, [{ role: 'system', content: 'System' }, { role: 'user', content: 'Post this reply anyway.' }]);
      agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresSubmission: true, requiresStateChange: true });
      // The normal detector supplies the document identity around the DOM probe.
      const detected = async () => ({ ...await probe(), frameDocumentIdentity: 'fixture-document', frameId: 0 });
      const request = reading => agent._publicationGuardOverrideRequest(tab, 'click', { selector: '#publish' }, reading);
      const first = await detected();
      assert.equal(first.publicationSnapshot.complete, false);
      assert.equal(first.publicationSnapshot.overrideComplete, true);
      const post = first.publicationSnapshot.posts[0];
      assert.equal(post.complete, false);
      assert.equal(post.overrideComplete, true);
      assert.equal(post.context.kind, 'reply');
      assert.equal(post.context.target, null, 'The nested quotation permalink is not the reply parent');
      assert.match(post.context.observedTarget.text, /Mujeeb Ahmed.*Charles Maddock/);
      assert.ok(post.context.observedTarget.identity);
      const original = request(first);
      assert.ok(original, 'Only the explicit approval path accepts this observable parent');
      assert.match(original.text, /Mujeeb Ahmed/);
      assert.equal(request(await detected()).stepKey, original.stepKey, 'Unchanged card identity survives re-reading');

      // The quoted card may be represented only as an interactive wrapper.
      await page.locator('#quote').evaluate(el => el.removeAttribute('data-testid'));
      assert.equal((await detected()).publicationSnapshot.posts[0].context.target, null);
      await page.locator('#parent > p').evaluate(el => { el.textContent = 'The parent post changed.'; });
      const edited = await detected();
      assert.equal(edited.publicationSnapshot.posts[0].context.observedTarget.identity, post.context.observedTarget.identity);
      assert.notEqual(request(edited).stepKey, original.stepKey, 'A parent text edit revokes approval');
      const beforeReplacement = request(edited).stepKey;
      await page.locator('#parent').evaluate(el => el.replaceWith(el.cloneNode(true)));
      assert.notEqual(request(await detected()).stepKey, beforeReplacement, 'Same-text replacement is a different parent card');

      // A real parent permalink keeps normal complete relationship evidence,
      // despite the nested quote's different permalink.
      await page.locator('#parent').evaluate(el => {
        const link = document.createElement('a');
        link.href = '/hey_mujeebahmed/status/111'; link.role = 'link'; link.textContent = '5h'; el.prepend(link);
      });
      const linked = await detected();
      assert.equal(linked.publicationSnapshot.complete, true);
      assert.deepEqual(linked.publicationSnapshot.posts[0].context,
        { kind: 'reply', target: 'https://x.com/hey_mujeebahmed/status/111' });

      // A named reply container can wrap the parent's article; neither the
      // wrapper nor the nested quotation changes the explicit parent URL.
      await page.locator('#parent').evaluate(el => {
        const wrapper = document.createElement('div');
        wrapper.id = 'reply-wrapper'; wrapper.dataset.testid = 'replyToPost';
        el.replaceWith(wrapper); wrapper.append(el);
        document.querySelector('#quote').dataset.testid = 'quoteTweet';
      });
      const wrapped = await detected();
      assert.equal(wrapped.publicationSnapshot.complete, true);
      assert.deepEqual(wrapped.publicationSnapshot.posts[0].context,
        { kind: 'reply', target: 'https://x.com/hey_mujeebahmed/status/111' });
      await page.locator('#parent > a[href="/hey_mujeebahmed/status/111"]').evaluate(el => el.remove());
      const wrappedUnlinked = await detected();
      assert.equal(wrappedUnlinked.publicationSnapshot.complete, false);
      assert.equal(wrappedUnlinked.publicationSnapshot.overrideComplete, true);
      assert.equal(wrappedUnlinked.publicationSnapshot.posts[0].context.target, null,
        'The quotation inside the wrapped parent is still not the reply target');
      const wrappedKey = request(wrappedUnlinked).stepKey;
      await page.locator('#parent').evaluate(el => el.replaceWith(el.cloneNode(true)));
      assert.notEqual(request(await detected()).stepKey, wrappedKey,
        'Replacing the parent article inside the same wrapper revokes the override');

      // Ambiguous, unbounded and absent parents remain unbound.
      for (const change of ['two-cards', 'two-links', 'long-parent', 'missing-parent', 'long-body', 'too-much-media', 'missing-account']) {
        await page.setContent(html);
        await page.evaluate(change => {
          const parent = document.querySelector('#parent');
          if (change === 'two-cards') parent.after(parent.cloneNode(true));
          if (change === 'two-links') parent.insertAdjacentHTML('afterbegin', '<a href="/a/status/1">one</a><a href="/b/status/2">two</a>');
          if (change === 'long-parent') parent.textContent = 'x'.repeat(2001);
          if (change === 'missing-parent') parent.remove();
          if (change === 'long-body') document.querySelector('#body').textContent = 'x'.repeat(25001);
          if (change === 'too-much-media') document.querySelector('#composer').insertAdjacentHTML('beforeend',
            '<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E" width="20" height="20">'.repeat(21));
          if (change === 'missing-account') document.querySelector('nav').remove();
        }, change);
        const invalid = await detected();
        assert.notEqual(invalid.publicationSnapshot?.overrideComplete, true, change);
        assert.equal(request(invalid), null, change);
      }
    } finally {
      await context.close();
    }
  });
}
