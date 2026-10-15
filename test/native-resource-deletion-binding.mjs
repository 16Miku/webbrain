import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { defaultDecide, installModelStub, probeWithReadings } from './semantic-decision-stub.mjs';

const url = 'https://mastoturk.org/@ownedqa';
const resource = `${url}/200`;
const menu = '<div class="dropdown-menu"><div class="dropdown-menu__container"><ul class="dropdown-menu__container__list"><li class="dropdown-menu__item dropdown-menu__item--dangerous"><button data-index="0" id="delete">Sil</button></li></ul></div></div>';
const confirmation = '<div role="dialog" aria-modal="true"><div class="modal-root__modal safety-action-modal"><div class="safety-action-modal__actions"><button type="button" class="link-button">İptal</button><button type="button" class="button" id="confirm">Sil</button></div></div></div>';
const record = (id = '200', account = 'ownedqa') => `<div class="status" id="record-${id}"><a class="status__relative-time" href="/@${account}/${id}">Now</a><a class="status__display-name" href="/@${account}">@${account}</a><div class="status__content__text--visible"><p>Exact owned post ${id}</p></div><div class="status__action-bar"><button type="button" id="more-${id}" aria-label="More"><svg class="icon icon-ellipsis-h" aria-hidden="true"></svg></button></div></div>`;
const html = `<!doctype html><style>button{padding:12px}.status{padding:10px}.dropdown-menu{padding:10px}.safety-action-modal{padding:20px}svg{width:12px;height:12px}</style>
<script id="initial-state" type="application/json">{"meta":{"delete_modal":true}}</script>
<div class="navigation-bar"><a class="account__display-name" href="/@ownedqa">@ownedqa</a></div><form class="compose-form"><textarea class="autosuggest-textarea__textarea"></textarea></form>
<main>${record()}${record('201')}</main><div id="portal"></div><script>
window.qaDeletes=0;window.qaMultiple=false;
window.qaOpenMenu=()=>{portal.innerHTML=${JSON.stringify(menu)}+(qaMultiple?${JSON.stringify(menu.replace('id="delete"', 'id="other-delete"'))}:'');document.querySelector('#delete').onclick=()=>{portal.innerHTML=${JSON.stringify(confirmation)};document.querySelector('#confirm').onclick=()=>qaDeletes++;};};
document.querySelector('#more-200').onclick=qaOpenMenu;document.querySelector('#more-201').onclick=qaOpenMenu;
</script>`;

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  test(`${build}: native resource launcher, menu and confirmation have exact ownership`, async t => {
    const browser = await (build === 'chrome' ? chromium : firefox).launch({ headless: true });
    try {
      async function fixture() {
        const page = await browser.newPage();
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
        await page.goto(url);
        let scope;
        // Captions are read the way the agent runs the probe: unread ones by
        // the fixtures' model oracle before the final pass.
        const runProbe = (tool, args) => page.evaluate(({ source, tool, args }) => (0, eval)(`(${source})`)(tool, args),
          { source: Agent._submitActionProbe.toString(), tool, args });
        const probe = (selector, overrides = {}) => probeWithReadings(runProbe, 'click', { selector,
          __wbNativeResourceAdapter: 'mastodon', __wbResourceRunToken: 'owned-run', __wbResourceTaskKey: 'owned-task',
          ...(scope ? { __wbOwnedResourceScope: scope } : {}), ...overrides });
        const adopt = result => { scope = { ...result.actionResource, document: result.frameDocumentIdentity,
          taskKey: 'owned-task', popupLauncherToken: result.popupLauncherToken, launcherDispatched: true }; };
        const click = async selector => { await page.click(selector); await page.waitForTimeout(20); };
        const open = async () => { const launcher = await probe('#more-200'); adopt(launcher); await click('#more-200'); return launcher; };
        const showConfirmation = async () => { await open(); const next = await probe('#delete'); adopt(next); await click('#delete'); return next; };
        return { page, probe, adopt, click, open, showConfirmation, get scope() { return scope; } };
      }

      await t.test('delivered native chain keeps the exact resource and defers deletion until confirmation', async () => {
        const f = await fixture();
        try {
          const more = await f.open();
          assert.equal(more.isSubmit, false); assert.equal(more.actionResource.url, resource);
          const next = await f.probe('#delete');
          assert.equal(next.isSubmit, false); assert.equal(next.resolvedPreparatoryTarget, true);
          assert.equal(next.mutationKind, 'delete', 'Opening confirmation still requires exact task deletion authority.');
          assert.equal(next.actionResource.url, resource); assert.ok(next.popupLauncherToken);
          f.adopt(next); await f.click('#delete');
          assert.equal(await f.page.evaluate(() => qaDeletes), 0);
          const final = await f.probe('#confirm');
          assert.equal(final.mutationKind, 'delete'); assert.equal(final.semanticCommit, true);
          assert.equal(final.actionResource.url, resource); assert.equal(final.actionResource.account, url);
          await f.click('#confirm'); assert.equal(await f.page.evaluate(() => qaDeletes), 1);
        } finally { await f.page.close(); }
      });

      // Mastodon mounts its menu a moment after the click and fades it in from
      // transparent (.dropdown-animation, 250 ms); its confirmation modal can
      // load a moment later still. The menu the agent's own click opened is
      // still that post's menu.
      await t.test('a menu and confirmation that open late and fade in keep the exact resource', async () => {
        const f = await fixture();
        try {
          await f.page.evaluate(() => {
            const style = document.createElement('style');
            style.textContent = '.dropdown-animation{animation:qa-dropdown 250ms cubic-bezier(.1,.7,.1,1)}'
              + '@keyframes qa-dropdown{from{opacity:0}to{opacity:1}}';
            document.head.append(style);
            const open = window.qaOpenMenu;
            window.qaOpenMenu = () => setTimeout(() => {
              open();
              for (const menu of document.querySelectorAll('#portal .dropdown-menu')) menu.classList.add('dropdown-animation');
              const remove = document.querySelector('#delete');
              const confirm = remove.onclick;
              remove.onclick = () => setTimeout(confirm, 120);
            }, 40);
            document.querySelector('#more-200').onclick = qaOpenMenu; document.querySelector('#more-201').onclick = qaOpenMenu;
          });
          const more = await f.open();
          assert.equal(more.actionResource.url, resource);
          await f.page.waitForTimeout(400);
          const next = await f.probe('#delete');
          assert.equal(next.actionResource?.url, resource, 'The late, fading menu is the one the agent opened');
          assert.equal(next.mutationKind, 'delete'); assert.ok(next.popupLauncherToken);
          f.adopt(next); await f.click('#delete'); await f.page.waitForTimeout(400);
          const final = await f.probe('#confirm');
          assert.equal(final.mutationKind, 'delete'); assert.equal(final.semanticCommit, true);
          assert.equal(final.actionResource?.url, resource, 'The late confirmation is the one the agent opened');
        } finally { await f.page.close(); }
      });

      // On a post's own page Mastodon renders the action bar beside the
      // detailed status, inside their shared wrapper, not inside the status.
      await t.test('the detailed status page menu keeps the exact resource', async () => {
        const f = await fixture();
        try {
          await f.page.evaluate(() => {
            document.querySelector('main').innerHTML = '<div class="focusable detailed-status__wrapper" tabindex="0">'
              + '<div class="detailed-status" id="detailed"><a class="detailed-status__display-name" href="/@ownedqa">@ownedqa</a>'
              + '<div class="status__content__text--visible"><p>Exact owned post 200</p></div><div class="detailed-status__meta">'
              + '<a class="detailed-status__datetime" href="/@ownedqa/200">Now</a></div></div><div class="detailed-status__action-bar">'
              + '<div class="detailed-status__action-bar-dropdown"><button type="button" id="detailed-more" title="More">'
              + '<svg class="icon icon-ellipsis-h" aria-hidden="true"></svg></button></div></div></div>';
            document.querySelector('#detailed-more').onclick = qaOpenMenu;
          });
          const more = await f.probe('#detailed-more');
          assert.equal(more.actionResource?.url, resource, 'The action bar beside the detailed status belongs to it');
          assert.ok(more.popupLauncherToken);
          f.adopt(more); await f.click('#detailed-more');
          const next = await f.probe('#delete');
          assert.equal(next.actionResource?.url, resource); assert.equal(next.mutationKind, 'delete');
          // Two detailed statuses in one wrapper leave the bar's owner unknown.
          await f.page.evaluate(() => document.querySelector('.detailed-status__wrapper')
            .prepend(document.querySelector('#detailed').cloneNode(true)));
          assert.equal((await f.probe('#detailed-more'))?.actionResource, null);
        } finally { await f.page.close(); }
      });

      for (const preference of ['disabled', 'missing']) await t.test(`${preference} confirmation preference retains direct deletion`, async () => {
        const f = await fixture();
        try {
          await f.page.evaluate(preference => {
            if (preference === 'missing') document.querySelector('#initial-state').remove();
            else document.querySelector('#initial-state').textContent = '{"meta":{"delete_modal":false}}';
          }, preference);
          await f.open();
          const detected = await f.probe('#delete');
          assert.equal(detected.isSubmit, true); assert.equal(detected.mutationKind, 'delete');
          assert.equal(detected.actionResource.url, resource); assert.equal(detected.resolvedPreparatoryTarget, undefined);
          await f.page.evaluate(() => { document.querySelector('#delete').onclick = () => qaDeletes++; });
          await f.click('#delete'); assert.equal(await f.page.evaluate(() => qaDeletes), 1);
          const agent = new Agent({ getActive: () => ({}) });
          agent._progressTaskKeyHash = () => 'owned-task'; agent._beginCompletionInvariant(1);
          agent._recordCompletionToolResult(1, 'click', { selector: '#delete' }, { success: true, dispatched: true }, { detectedSubmit: detected });
          assert.ok(agent._recordCompletionSubmitAttempt(1, detected, 'click', { selector: '#delete' }, url, url,
            { success: true, dispatched: true }, 'owned-document', 'owned-document'));
          assert.equal(agent._completionSubmitStates.get(1)?.mutationKind, 'delete');
        } finally { await f.page.close(); }
      });

      for (const variant of ['unsent', 'other-launcher', 'multiple-popups', 'already-open', 'changed-owner']) {
        await t.test(`${variant} cannot bind a native menu`, async () => {
          const f = await fixture();
          try {
            if (variant === 'already-open') await f.page.evaluate(() => qaOpenMenu());
            const more = await f.probe('#more-200'); f.adopt(more);
            if (variant === 'multiple-popups') await f.page.evaluate(() => { qaMultiple = true; });
            if (variant === 'changed-owner') await f.page.evaluate(() =>
              document.querySelector('#record-201 .status__action-bar').append(document.querySelector('#more-200')));
            if (['unsent', 'already-open'].includes(variant)) await f.page.evaluate(() => qaOpenMenu());
            else await f.click(variant === 'other-launcher' ? '#more-201' : '#more-200');
            assert.equal((await f.probe('#delete'))?.actionResource, null);
            assert.equal(await f.page.evaluate(() => qaDeletes), 0);
          } finally { await f.page.close(); }
        });
      }

      for (const variant of ['task', 'run', 'document', 'not-acknowledged', 'wrong-record', 'wrong-account', 'unrelated-modal', 'multiple-modals', 'unrelated-generic-dialog']) {
        await t.test(`${variant} cannot borrow the native confirmation resource`, async () => {
          const f = await fixture();
          try {
            await f.showConfirmation();
            let overrides = {};
            if (variant === 'task') overrides.__wbResourceTaskKey = 'different-task';
            if (variant === 'run') overrides.__wbResourceRunToken = 'different-run';
            if (variant === 'document') f.scope.document = 'different-document';
            if (variant === 'not-acknowledged') f.scope.launcherDispatched = false;
            if (variant === 'wrong-record') await f.page.evaluate(() =>
              document.querySelector('#record-200 .status__relative-time').href = '/@ownedqa/202');
            if (variant === 'wrong-account') await f.page.evaluate(() =>
              document.querySelector('.navigation-bar .account__display-name').href = '/@otherqa');
            if (variant === 'unrelated-modal') await f.page.evaluate(confirmation => {
              document.querySelector('#portal').innerHTML = confirmation;
            }, confirmation);
            if (variant === 'multiple-modals') await f.page.evaluate(confirmation => {
              document.querySelector('#portal').insertAdjacentHTML('beforeend', confirmation.replace('id="confirm"', 'id="other-confirm"'));
            }, confirmation);
            if (variant === 'unrelated-generic-dialog') await f.page.evaluate(() => {
              document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><p>Unrelated confirmation</p><button>Delete</button></div>');
            });
            assert.equal((await f.probe('#confirm', overrides))?.actionResource, null);
            assert.equal(await f.page.evaluate(() => qaDeletes), 0);
          } finally { await f.page.close(); }
        });
      }

      await t.test('native classes without extension adapter evidence do not provide resource authority', async () => {
        const f = await fixture();
        try { assert.equal((await f.probe('#more-200', { __wbNativeResourceAdapter: '' }))?.actionResource, null); }
        finally { await f.page.close(); }
      });

      await t.test('an unrelated saved record retains its own unknown identity', async () => {
        const f = await fixture();
        try {
          await f.open();
          await f.page.evaluate(() => {
            const article = document.createElement('article'); article.innerHTML = '<p>Unrelated saved record</p><button type="button" id="other">Delete</button>';
            document.querySelector('#portal').append(article);
          });
          assert.equal((await f.probe('#other'))?.actionResource, null);
        } finally { await f.page.close(); }
      });

      await t.test('neutral nested status classes retain generic article and cached-popup ownership', async () => {
        const f = await fixture();
        try {
          const neutral = 'https://neutral-resource.invalid/records/200';
          await f.page.goto('https://neutral-resource.invalid/records');
          await f.page.setContent(`<!doctype html><article><a rel="bookmark" href="${neutral}">Exact generic resource</a>
            <div class="status"><p>Exact neutral record</p><button type="button" id="generic-delete">Delete</button>
            <button type="button" id="generic-more" aria-haspopup="menu" aria-controls="options">More</button></div></article>
            <div id="options" role="menu"><div class="status"><button type="button" id="popup-delete">Delete</button></div></div>`);
          const generic = { __wbNativeResourceAdapter: '' };
          assert.equal((await f.probe('#generic-delete', generic)).actionResource?.url, neutral,
            'A common neutral CSS class cannot override the containing saved article.');
          const more = await f.probe('#generic-more', generic); f.adopt(more);
          await f.click('#generic-more');
          assert.equal((await f.probe('#popup-delete', generic)).actionResource?.url, neutral,
            'The same class cannot override the explicitly linked generic menu ownership.');
          await f.page.evaluate(() => document.querySelector('#options').id = 'unlinked');
          assert.equal((await f.probe('#popup-delete', generic)).actionResource, null,
            'An unrelated generic popup still cannot borrow a cached resource.');
        } finally { await f.page.close(); }
      });

      // A menu mounted elsewhere without aria-controls belongs to the saved
      // record whose launcher's own click opened it, and to nothing else.
      await t.test('an unlinked generic menu borrows the resource of the launcher whose click opened it', async () => {
        const f = await fixture();
        try {
          const neutral = 'https://neutral-resource.invalid/records/300';
          await f.page.goto('https://neutral-resource.invalid/records');
          await f.page.setContent(`<!doctype html><article><a rel="bookmark" href="${neutral}">Exact generic resource</a>
            <p>Exact neutral record</p><button type="button" id="generic-more" aria-haspopup="menu">More</button></article>
            <article><a rel="bookmark" href="https://neutral-resource.invalid/records/301">Other resource</a>
            <p>Other neutral record</p><button type="button" id="other-more" aria-haspopup="menu">More</button></article><div id="portal"></div>`);
          await f.page.evaluate(() => {
            window.qaOpen = () => { document.querySelector('#portal').innerHTML = '<div role="menu"><button type="button" id="popup-delete">Delete</button></div>'; };
            for (const id of ['generic-more', 'other-more']) document.getElementById(id).onclick = () => setTimeout(window.qaOpen, 30);
          });
          const generic = { __wbNativeResourceAdapter: '' };
          const more = await f.probe('#generic-more', generic);
          assert.equal(more.actionResource?.url, neutral); assert.ok(more.popupLauncherToken);
          f.adopt(more); await f.click('#generic-more'); await f.page.waitForTimeout(300);
          assert.equal((await f.probe('#popup-delete', generic)).actionResource?.url, neutral,
            'The menu the launcher opened belongs to its record');
          // The same menu opened by a script, or by another record's launcher,
          // borrows nothing.
          await f.page.evaluate(() => { document.querySelector('#portal').innerHTML = ''; });
          const again = await f.probe('#generic-more', generic); f.adopt(again);
          await f.page.evaluate(() => window.qaOpen()); await f.page.waitForTimeout(300);
          assert.equal((await f.probe('#popup-delete', generic)).actionResource, null, 'scripted');
          await f.page.evaluate(() => { document.querySelector('#portal').innerHTML = ''; });
          const third = await f.probe('#generic-more', generic); f.adopt(third);
          await f.click('#other-more'); await f.page.waitForTimeout(300);
          assert.equal((await f.probe('#popup-delete', generic)).actionResource, null, 'other launcher');
          // A new wrapper dialog holding the menu counts as the one popup the
          // click opened, and the menu inside it belongs to the same record.
          await f.page.evaluate(() => {
            document.querySelector('#portal').innerHTML = '';
            window.qaOpen = () => { document.querySelector('#portal').innerHTML = '<div role="dialog" aria-label="Actions"><div role="menu"><button type="button" id="popup-delete">Delete</button></div></div>'; };
          });
          const fourth = await f.probe('#generic-more', generic); f.adopt(fourth);
          await f.click('#generic-more'); await f.page.waitForTimeout(300);
          assert.equal((await f.probe('#popup-delete', generic)).actionResource?.url, neutral, 'nested menu');
        } finally { await f.page.close(); }
      });

      await t.test('final deletion retains exact accepted-task authorization', async () => {
        const f = await fixture();
        try {
          await f.showConfirmation();
          const detected = await f.probe('#confirm');
          for (const [request, reason] of [
            [`Delete only ${resource}.`, null], ['Inspect the owned post.', 'resource_not_bound_to_request'],
            [`Delete only ${url}/201.`, 'resource_not_bound_to_request'],
          ]) {
            const provider = { chat() {} }, agent = new Agent({ getActive: () => provider });
            agent.conversations.set(1, [{ role: 'system', content: 'system' }, { role: 'user', content: request }]);
            agent._startPlanExecutionGuard(1, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
            agent._detectLikelySubmitAction = async () => structuredClone(detected);
            const calls = installModelStub(agent);
            const result = await agent._resourceMutationPreSubmitBlock(1, 'click', { selector: '#confirm' }, detected, provider);
            assert.equal(result?.actionGuard?.reason || null, reason);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].kind, 'deletion_request');
            assert.equal(calls[0].request, request, 'The request reaches the model as written');
            assert.equal(calls[0].page.link, resource, 'with the exact post the confirmation deletes');
            if (reason) assert.equal(result.mutationConfirmation?.url, resource, 'and an unclear deletion goes to the user');
            agent._planExecutionGuards.delete(1);
            assert.equal((await agent._resourceMutationPreSubmitBlock(1, 'click', { selector: '#confirm' }, detected, provider)).actionGuard.reason,
              'task_or_target_changed');
          }
        } finally { await f.page.close(); }
      });

      for (const variant of ['stable-confirmation', 'stable-direct', 'flip-before-authorization', 'flip-during-authorization']) {
        await t.test(`${variant} is revalidated by production mutation preflight`, async () => {
          const f = await fixture();
          try {
            const request = `Delete only ${resource}.`;
            const provider = { chat() {} }, agent = new Agent({ getActive: () => provider });
            agent.conversations.set(1, [{ role: 'system', content: 'system' }, { role: 'user', content: request }]);
            agent._startPlanExecutionGuard(1, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
            const disableConfirmation = () => f.page.evaluate(() => {
              document.querySelector('#initial-state').textContent = '{"meta":{"delete_modal":false}}';
            });
            if (variant === 'stable-direct') await disableConfirmation();
            await f.open();
            const detected = await f.probe('#delete');
            assert.equal(detected.isSubmit, variant === 'stable-direct');
            let probes = 0, authorizations = 0;
            agent._detectLikelySubmitAction = async () => {
              if (++probes === 1 && variant === 'flip-before-authorization') await disableConfirmation();
              return f.probe('#delete');
            };
            installModelStub(agent, { decide: async (kind, question) => {
              authorizations++;
              if (variant === 'flip-during-authorization') await disableConfirmation();
              return defaultDecide(kind, question);
            } });
            const result = await agent._resourceMutationPreSubmitBlock(1, 'click', { selector: '#delete' }, detected, provider);
            const reason = variant === 'flip-before-authorization' ? 'resource_changed'
              : variant === 'flip-during-authorization' ? 'resource_changed_after_authorization' : null;
            assert.equal(result?.actionGuard?.reason || null, reason);
            assert.equal(authorizations, variant === 'flip-before-authorization' ? 0 : 1);
            assert.equal(await f.page.evaluate(() => qaDeletes), 0, 'Preflight never dispatches deletion.');
            if (reason) {
              assert.equal(result.noDispatch, true);
              const fresh = await f.probe('#delete');
              assert.equal(fresh.isSubmit, true); assert.equal(fresh.resolvedPreparatoryTarget, undefined);
              assert.notEqual(agent._resourceMutationActionKey(1, 'click', { selector: '#delete' }, detected),
                agent._resourceMutationActionKey(1, 'click', { selector: '#delete' }, fresh),
                'A changed consequential meaning cannot reuse preparation authorization.');
            } else {
              agent._beginCompletionInvariant(1);
              const receipt = agent._recordCompletionSubmitAttempt(1, detected, 'click', { selector: '#delete' }, url, url,
                { success: true, dispatched: true }, 'owned-document', 'owned-document');
              assert.equal(!!receipt, variant === 'stable-direct', 'Only direct deletion owns a submission receipt.');
            }
          } finally { await f.page.close(); }
        });
      }
    } finally { await browser.close(); }
  });

  test(`${build}: rejected or uncertain launcher dispatch cannot arm popup ownership`, () => {
    for (const result of [{ success: true, dispatched: false }, { success: true, noDispatch: true },
      { success: false }, { success: true, outcomeUnknown: true }, { success: true, missingToolResponse: true }]) {
      const agent = new Agent({ getActive: () => ({}) });
      agent._progressTaskKeyHash = () => 'owned-task';
      const guard = { enabled: true, taskKey: 'owned-task' }; agent._planExecutionGuards.set(1, guard);
      agent._beginCompletionInvariant(1);
      agent._recordCompletionToolResult(1, 'click', { selector: '#more' }, result, { detectedSubmit: {
        isSubmit: false, resolvedPreparatoryTarget: true, actionResource: { complete: true, url: resource },
        frameDocumentIdentity: 'owned-document', popupLauncherToken: 'owned-launcher' } });
      assert.equal(guard.resolvedResourceScope, undefined, JSON.stringify(result));
      assert.equal(agent._completionSubmitStates.get(1), undefined);
    }
  });
}
