import { strict as assert } from 'node:assert';

export function registerInteractionReviewRegressions({
  test, firefoxTest, setupContentHtml, call, Agent, FirefoxAgent,
}) {
  for (const [kind, register, AgentClass] of [
    ['chrome', test, Agent],
    ['firefox', firefoxTest, FirefoxAgent],
  ]) {
    register(`${kind}: text clicks prefer eligible controls before visible text`, async page => {
      for (const variant of ['disabled', 'aria-disabled', 'fieldset', 'covered', 'enabled']) {
        await setupContentHtml(page, `<!doctype html>
          <style>
            body { margin: 0 }
            button { position: fixed; top: 40px; width: 100px; height: 40px }
            #primary { left: 40px } #glyph { left: 200px }
            #cover { position: fixed; top: 40px; left: 40px; width: 100px; height: 40px; z-index: 10 }
          </style>
          <fieldset ${variant === 'fieldset' ? 'disabled' : ''}>
            <button id="primary" ${variant === 'disabled' ? 'disabled' : ''}
              ${variant === 'aria-disabled' ? 'aria-disabled="true"' : ''}><span aria-label="Search">Search</span></button>
          </fieldset>
          <button id="glyph" aria-label="Search">⌕</button>
          ${variant === 'covered' ? '<div id="cover"></div>' : ''}`, kind);
        await page.evaluate(() => {
          window.fixtureClicks = [];
          document.querySelectorAll('button').forEach(button => {
            button.addEventListener('click', () => window.fixtureClicks.push(button.id));
          });
        });
        const args = { text: 'Search', textMatch: 'exact' };
        const probe = await call(page, 'probe_message_recipient_guard', {
          tool: 'click', args, adapterName: 'gmail',
        });
        assert.equal(probe.messageSend, false, JSON.stringify({ variant, probe }));
        assert.equal(probe.conclusive, true, JSON.stringify({ variant, probe }));
        const clicked = await call(page, 'click', args);
        assert.equal(clicked.success, true, JSON.stringify({ variant, clicked }));
        assert.deepEqual(await page.evaluate(() => window.fixtureClicks),
          [variant === 'enabled' ? 'primary' : 'glyph'], variant);
      }
    });

    register(`${kind}: Gmail advanced search dialog is not a message composer`, async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      await page.goto('https://mail.google.com/mail/u/0/');
      await setupContentHtml(page, `<!doctype html>
        <style>
          body { margin: 0 }
          [role=dialog] { position: fixed; top: 20px; left: 40px; width: 400px; padding: 20px; background: white }
          input, textarea { display: block; width: 300px; height: 40px }
        </style>
        <div role="dialog" aria-modal="true" aria-label="Advanced search">
          <label>Has the words <input id="words" value="budget"></label>
          <button id="search">Search</button>
        </div>`, kind);
      await page.locator('#words').focus();
      await page.evaluate(() => {
        window.fixtureClicks = 0;
        document.querySelector('#search').addEventListener('click', () => window.fixtureClicks++);
      });
      const agent = new AgentClass({ getActive: () => ({ supportsVision: false }) });
      agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
      for (const args of [{ selector: '#search' }, { text: 'Search', textMatch: 'exact' }]) {
        const probe = await call(page, 'probe_message_recipient_guard', {
          tool: 'click', args, adapterName: 'gmail',
        });
        assert.equal(probe.messageSend, false, JSON.stringify(probe));
        assert.equal(probe.conclusive, true, JSON.stringify(probe));
        assert.equal(await agent._messageRecipientGuardBlock(1, 'click', args, page.url()), null);
        assert.equal((await call(page, 'click', args)).success, true);
      }
      assert.equal(await page.evaluate(() => window.fixtureClicks), 2);
      // A multiline filter is still not compose evidence.
      await page.locator('#words').evaluate(input => {
        const textarea = document.createElement('textarea');
        textarea.id = input.id;
        textarea.value = input.value;
        input.replaceWith(textarea);
        textarea.focus();
      });
      const searchProbe = await call(page, 'probe_message_recipient_guard', {
        tool: 'click', args: { selector: '#search' }, adapterName: 'gmail',
      });
      assert.equal(searchProbe.messageSend, false, JSON.stringify(searchProbe));
      // A real upper-page composer must still require a recipient.
      await page.evaluate(() => {
        document.querySelector('[role=dialog]').setAttribute('aria-label', 'New Message');
        const button = document.querySelector('#search');
        button.id = 'send';
        button.textContent = 'Send';
      });
      const sendProbe = await call(page, 'probe_message_recipient_guard', {
        tool: 'click', args: { selector: '#send' }, adapterName: 'gmail',
      });
      assert.equal(sendProbe.messageSend, true, JSON.stringify(sendProbe));
      assert.equal(sendProbe.composerAvailable, true, JSON.stringify(sendProbe));
      assert.equal((await agent._messageRecipientGuardBlock(1, 'click', { selector: '#send' }, page.url()))?.noDispatch, true);
    });
  }
}
