import { strict as assert } from 'node:assert';

export function registerMessageRecipientNavigationFixtures({
  test, firefoxTest, setupContentHtml, call, Agent, FirefoxAgent,
}) {
  for (const [kind, register, AgentClass] of [
    ['chrome', test, Agent],
    ['firefox', firefoxTest, FirefoxAgent],
  ]) {
    const setup = async (page) => {
      // Keep the real origin and URL parsing without contacting LinkedIn.
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      await page.goto('https://www.linkedin.com/feed/');
      await setupContentHtml(page, `<!doctype html>
        <style>
          body { margin: 0; font: 16px sans-serif; }
          nav { display: flex; gap: 30px; padding: 20px; }
          a, button { display: inline-block; padding: 8px; }
          #chat { position: fixed; right: 20px; bottom: 20px; width: 360px; }
          #body { width: 260px; height: 60px; }
          #chat h2 { position: fixed; right: 200px; top: 80px; margin: 0; }
        </style>
        <nav aria-label="Primary">
          <a id="home" class="destination" href="/feed/">Home</a>
          <a id="jobs" class="destination" href="/jobs/"><span id="jobs-label">Jobs</span></a>
          <a id="messaging" href="/messaging/">Messaging</a>
        </nav>
        <main>
          <a id="portfolio" href="https://portfolio.example/"><span id="portfolio-label">View my portfolio</span></a>
          <a id="contact-info" href="/in/alice/overlay/contact-info/">Contact info</a>
        </main>
        <div id="contact-info-dialog" role="dialog" aria-modal="true" hidden>
          <button id="close-contact-info" type="button">Close</button>
          <a id="safety-portfolio" href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F">portfolio.example</a>
          <a id="legacy-portfolio" href="/redir/redirect?url=https%3A%2F%2Flegacy-portfolio.example%2F">legacy-portfolio.example</a>
        </div>
        <form id="chat" hidden>
          <h2>Alice</h2><textarea id="body">Hello Alice</textarea><button id="send" type="button">Send</button>
        </form>`, kind);
      await page.evaluate(() => {
        window.fixtureClicks = [];
        document.addEventListener('click', event => {
          const target = event.target.closest('a,button');
          if (target) { event.preventDefault(); window.fixtureClicks.push(target.id); }
        });
      });
      const agent = new AgentClass({ getActive: () => ({ supportsVision: false }) });
      agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
      const guard = (tool, args) => agent._messageRecipientGuardBlock(1, tool, args, page.url());
      const probe = (tool, args) => call(page, 'probe_message_recipient_guard', { tool, args, adapterName: 'linkedin' });
      return { agent, guard, probe };
    };

    register(`${kind}: LinkedIn Home and Jobs navigate with closed and open message composers (#2999)`, async (page) => {
      const { guard, probe } = await setup(page);
      for (const open of [false, true]) {
        await page.evaluate(open => { document.querySelector('#chat').hidden = !open; }, open);
        const ref = await page.evaluate(() => window.__wb_ax_ref(document.querySelector('#jobs-label')));
        for (const [tool, args, expected] of [
          ['click', { text: 'Jobs', textMatch: 'exact' }, 'jobs'],
          ['click', { text: 'Home' }, 'home'],
          ['click_ax', { ref_id: ref }, 'jobs'],
          ['click', { selector: '.destination', matchIndex: 1 }, 'jobs'],
          ['click', { text: 'Messag', textMatch: 'prefix' }, 'messaging'],
        ]) {
          const result = await probe(tool, args);
          assert.equal(result.conclusive, true, JSON.stringify(result));
          assert.equal(result.messageSend, false);
          assert.equal(await guard(tool, args), null);
          const clicked = await call(page, tool, args);
          assert.equal(clicked.success, true, JSON.stringify(clicked));
          assert.equal(await page.evaluate(() => window.fixtureClicks.at(-1)), expected);
        }
      }
    });

    register(`${kind}: LinkedIn ordinary document links bypass the message recipient guard (#3010)`, async (page) => {
      const { guard, probe } = await setup(page);
      for (const open of [false, true]) {
        await page.evaluate(open => { document.querySelector('#chat').hidden = !open; }, open);
        const portfolioRef = await page.evaluate(
          () => window.__wb_ax_ref(document.querySelector('#portfolio-label')),
        );
        for (const [tool, args, expected] of [
          ['click', { text: 'View my portfolio', textMatch: 'exact' }, 'portfolio'],
          ['click_ax', { ref_id: portfolioRef }, 'portfolio'],
          ['click', { text: 'Contact info', textMatch: 'exact' }, 'contact-info'],
        ]) {
          const result = await probe(tool, args);
          assert.equal(result.conclusive, true, JSON.stringify(result));
          assert.equal(result.messageSend, false);
          assert.equal(result.navigation, true);
          assert.equal(await guard(tool, args), null);
          const clicked = await call(page, tool, args);
          assert.equal(clicked.success, true, JSON.stringify(clicked));
          assert.equal(await page.evaluate(() => window.fixtureClicks.at(-1)), expected);
        }
      }
    });

    register(`${kind}: LinkedIn contact-info safety redirects navigate inside the modal (#3010)`, async (page) => {
      const { guard, probe } = await setup(page);
      await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#contact-info-dialog').hidden = false;
      });
      for (const open of [false, true]) {
        await page.evaluate(open => { document.querySelector('#chat').hidden = !open; }, open);
        const safetyRef = await page.evaluate(
          () => window.__wb_ax_ref(document.querySelector('#safety-portfolio')),
        );
        for (const [tool, args, expected] of [
          ['click', { text: 'portfolio.example', textMatch: 'exact' }, 'safety-portfolio'],
          ['click_ax', { ref_id: safetyRef }, 'safety-portfolio'],
          ['click', { text: 'legacy-portfolio.example', textMatch: 'exact' }, 'legacy-portfolio'],
        ]) {
          const result = await probe(tool, args);
          assert.equal(result.conclusive, true, JSON.stringify(result));
          assert.equal(result.messageSend, false);
          assert.equal(result.navigation, true);
          assert.equal(await guard(tool, args), null);
          const clicked = await call(page, tool, args);
          assert.equal(clicked.success, true, JSON.stringify(clicked));
          assert.equal(await page.evaluate(() => window.fixtureClicks.at(-1)), expected);
        }
      }
      for (const href of [
        'https://portfolio.example/',
        '/safety/go/',
        '/safety/go/?url=javascript%3Aalert(1)',
        '/safety/go/?url=https%3A%2F%2Flinkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Fm.linkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Fm.linkedin.com.%2Fmessaging%2Fsend',
      ]) {
        await page.locator('#safety-portfolio').evaluate((el, value) => el.setAttribute('href', value), href);
        const args = { text: 'portfolio.example', textMatch: 'exact' };
        const result = await probe('click', args);
        assert.notEqual(result.navigation, true, `${href}: ${JSON.stringify(result)}`);
        assert.equal((await guard('click', args))?.noDispatch, true, `${href}: recipient guard must fail closed`);
      }
    });

    register(`${kind}: LinkedIn recipient guard rejects ambiguous navigation and action lookalikes`, async (page) => {
      const { guard } = await setup(page);
      for (const href of [
        '#',
        'javascript:void(0)',
        'mailto:alice@example.com',
        '/in/alice/',
        '/messaging/compose/',
        '/messaging/send/',
        'https://linkedin.com/messaging/send/',
        'https://m.linkedin.com/messaging/send/',
        'https://m.linkedin.com./messaging/send/',
        '/safety/go/',
        '/safety/go/?url=javascript%3Aalert(1)',
        '/safety/go/?url=https%3A%2F%2Fwww.linkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Flinkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Fm.linkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Fm.linkedin.com.%2Fmessaging%2Fsend',
      ]) {
        await page.locator('#jobs').evaluate((el, href) => el.setAttribute('href', href), href);
        assert.equal((await guard('click', { text: 'Jobs' }))?.noDispatch, true, href);
      }
      await page.locator('#jobs').evaluate(el => el.setAttribute('href', '/jobs/'));
      for (const [attribute, value] of [['role', 'button'], ['data-action', 'send'], ['onclick', 'void(0)'], ['download', 'jobs']]) {
        await page.locator('#jobs').evaluate((el, [name, value]) => el.setAttribute(name, value), [attribute, value]);
        assert.equal((await guard('click', { text: 'Jobs' }))?.noDispatch, true, attribute);
        await page.locator('#jobs').evaluate((el, name) => el.removeAttribute(name), attribute);
      }
      await page.evaluate(() => {
        document.querySelector('#chat').hidden = false;
        document.querySelector('#send').textContent = 'Jobs';
      });
      assert.equal((await guard('click', { text: 'Jobs' }))?.noDispatch, true, 'duplicate action label');
      // Text wins over selector at dispatch; matchIndex must also agree with
      // dispatch rather than accidentally approving the first selector match.
      await page.locator('#send').evaluate(el => { el.textContent = 'Send'; el.classList.add('destination'); });
      assert.equal((await guard('click', { text: 'Send', selector: '#jobs' }))?.noDispatch, true);
      assert.equal((await guard('click', { selector: '.destination', matchIndex: 2 }))?.noDispatch, true);
      assert.equal((await guard('click_ax', { ref_id: 'ref_missing' }))?.noDispatch, true);
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), []);
    });

    register(`${kind}: LinkedIn recipient guard disambiguates passive labels like click dispatch`, async (page) => {
      const { agent, guard } = await setup(page);
      await page.evaluate(() => {
        document.querySelector('#chat').hidden = false;
        document.querySelector('#send').insertAdjacentHTML('beforebegin', '<label for="send">Send</label>');
      });
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: ['Alice'] } });
      for (const args of [
        { text: 'Send', textMatch: 'exact' },
        { text: 'Sen', textMatch: 'prefix' },
        { text: 'end', textMatch: 'contains' },
        { text: 'Send' },
      ]) {
        const execution = {};
        assert.equal(await agent._messageRecipientGuardBlock(1, 'click', args, page.url(), execution), null);
        assert.equal(execution.messageRecipientGuardRequired, true);
        assert.ok(execution.messageRecipientDispatchBinding?.token);
        const clicked = await call(page, 'click', { ...args, ...execution });
        assert.equal(clicked.success, true, JSON.stringify(clicked));
        assert.equal(await page.evaluate(() => window.fixtureClicks.at(-1)), 'send');
      }
      await page.locator('#send').evaluate(el => el.insertAdjacentHTML('afterend', '<button type="button">Send</button>'));
      assert.equal((await guard('click', { text: 'Send' }))?.noDispatch, true, 'two interactive matches must remain ambiguous');
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), ['send', 'send', 'send', 'send']);
    });

    register(`${kind}: LinkedIn recipient guard accepts shadow controls inside the active modal`, async (page) => {
      const { agent, guard } = await setup(page);
      const ref = await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        chat.hidden = false;
        const modal = document.createElement('div');
        modal.id = 'modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.style.cssText = 'position:fixed;inset:0;background:white';
        document.body.append(modal);
        modal.append(chat);
        const host = document.createElement('span');
        host.id = 'send-host';
        document.querySelector('#send').replaceWith(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<button id="shadow-send" type="button" style="padding:8px">Send</button>';
        const send = shadow.querySelector('button');
        send.addEventListener('click', event => {
          event.preventDefault();
          window.fixtureClicks.push(send.id);
        });
        // This is exactly the distinction that ordinary contains() misses.
        if (modal.contains(send)) throw new Error('fixture target must cross a shadow boundary');
        return window.__wb_ax_ref(send);
      });
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: ['Alice'] } });
      const args = { ref_id: ref };
      const execution = {};
      assert.equal(await agent._messageRecipientGuardBlock(1, 'click_ax', args, page.url(), execution), null);
      assert.equal(execution.messageRecipientGuardRequired, true);
      assert.ok(execution.messageRecipientDispatchBinding?.token);
      const clicked = await call(page, 'click_ax', { ...args, ...execution });
      assert.equal(clicked.success, true, JSON.stringify(clicked));
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), ['shadow-send']);
      // Moving the same host outside the modal must not grant background access.
      await page.locator('#send-host').evaluate(host => document.body.append(host));
      assert.equal((await guard('click_ax', args))?.noDispatch, true);
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), ['shadow-send']);
    });

    register(`${kind}: LinkedIn navigation respects modal scope and preserves send authorization`, async (page) => {
      const { agent, guard, probe } = await setup(page);
      await page.evaluate(() => {
        document.querySelector('#chat').hidden = false;
        document.body.insertAdjacentHTML('beforeend', '<div id="modal" role="dialog" aria-modal="true" style="position:fixed;inset:80px;background:white"><button>Jobs</button></div>');
      });
      assert.equal((await guard('click', { text: 'Jobs' }))?.noDispatch, true, 'modal text must not resolve background link');
      assert.equal((await guard('click', { selector: '#jobs' }))?.noDispatch, true, 'background selector must not bypass modal');
      await page.locator('#modal').evaluate(el => el.remove());
      const send = await probe('click', { text: 'Send' });
      assert.equal(send.messageSend, true, JSON.stringify(send));
      assert.deepEqual(send.strongIdentityCandidates, ['Alice']);
      assert.equal((await guard('click', { text: 'Send' }))?.noDispatch, true, 'missing recipient');
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: ['Bob'] } });
      assert.equal((await guard('click', { text: 'Send' }))?.noDispatch, true, 'wrong recipient');
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: ['Alice'] } });
      const execution = {};
      assert.equal(await agent._messageRecipientGuardBlock(1, 'click', { text: 'Send' }, page.url(), execution), null);
      assert.equal(execution.messageRecipientGuardRequired, true);
      assert.ok(execution.messageRecipientDispatchBinding?.token);
      // A verified navigation classification must never permit replaying a
      // send binding after the action or conversation changed.
      await page.locator('#chat h2').evaluate(el => { el.textContent = 'Bob'; });
      const stale = await call(page, 'consume_message_recipient_dispatch_binding', execution);
      assert.equal(stale.noDispatch, true);
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), []);
    });
  }
}
