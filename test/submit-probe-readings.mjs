// The submit probe decides what a clicked control does from a model's reading
// of its captions, in any language (the control_effect question), never from
// a word list: whether it deletes one item or several, publishes, commits,
// only edits the draft, or only changes the view. The agent runs the probe
// twice when a caption is new: a collect pass reports the activated
// control's unread captions before the page changes in any way, a model
// reads them, and the final pass decides. A caption no model could read
// decides nothing, as every caption in a language a word list lacked did.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { fixtureControlEffectReading, probeWithReadings, stubPageTextReadings } from './semantic-decision-stub.mjs';

// What a model reads these fixtures' captions as, beyond the shared oracle.
const READINGS = {
  Törlés: 'delete_one', 'Fiók törlése': 'delete_one', 'Összes törlése': 'delete_many', 'Szűrő eltávolítása': 'view',
  'Melléklet eltávolítása': 'form_edit', Közzététel: 'publish', Küldés: 'commit', Mentés: 'commit', Bezárás: 'view',
  'Tümünü sil': 'delete_many', 'Mavi Tişört': 'unclear', 'Bejegyzés műveletei': 'view',
};
const read = caption => READINGS[caption] ?? fixtureControlEffectReading(caption);
const pageUrl = 'https://shop.example/cart';

for (const build of ['chrome', 'firefox']) {
  for (const engine of ['chromium', 'firefox']) {
    test(`${build} build on ${engine}: a click is classified by what its captions mean, in any language`, async t => {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const browser = await (engine === 'chromium' ? chromium : firefox).launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>fixture</title>' }));
      const page = await context.newPage();
      await page.goto(pageUrl);
      const source = Agent._submitActionProbe.toString();
      const open = html => page.setContent(`<style>button,[role=button]{display:inline-block;min-width:40px;min-height:24px}</style>${html}`);
      const runProbe = (tool, args) => page.evaluate(({ source, tool, args }) => (0, eval)(`(${source})`)(tool, args), { source, tool, args });
      const probe = (selector, reader = read, overrides = {}) => probeWithReadings(runProbe, 'click',
        { selector, __wbResourceRunToken: 'owned-run', __wbResourceTaskKey: 'owned-task', ...overrides }, reader);
      try {
        await t.test('a deletion caption in a language no word list had binds its row', async () => {
          await open('<ul class="cart"><li>Gyapjú zokni — 12 € <button id="t" type="button">Törlés</button></li>'
            + '<li>Sapka — 20 € <button type="button">Törlés</button></li></ul>');
          const result = await probe('#t');
          assert.equal(result.mutationKind, 'delete');
          assert.equal(result.actionRecord.text, 'Gyapjú zokni — 12 €');
          assert.deepEqual(result.actionRecord.siblings, ['Sapka — 20 € Törlés']);
          // An aria-labelled icon in a grid, read as deleting its item.
          await open('<div role="grid"><div role="row"><div role="gridcell">Számla 4411</div><div role="gridcell">'
            + '<div id="t" role="button" tabindex="0" aria-label="Fiók törlése">🗑</div></div></div><div role="row">'
            + '<div role="gridcell">Számla 4412</div><div role="gridcell"><div role="button" tabindex="0" aria-label="Fiók törlése">🗑</div></div></div></div>');
          assert.equal((await probe('#t')).actionRecord.text, 'Számla 4411');
        });

        await t.test('deleting several items, removing a filter and a removed attachment are told apart by reading', async () => {
          await open('<div role="toolbar"><button id="t" type="button">Összes törlése</button></div><ul><li>A <button type="button">Törlés</button></li></ul>');
          let result = await probe('#t');
          assert.equal(result.mutationKind, 'delete');
          assert.equal(result.actionRecord, undefined, 'several items have no single record');
          await open('<ul><li>Elma <button id="t" type="button">Tümünü sil</button></li><li>Armut</li></ul>');
          assert.equal((await probe('#t')).actionRecord, undefined);
          await open('<div class="chips"><span>Méret: L</span><button id="t" type="button" aria-label="Szűrő eltávolítása">L ×</button></div>');
          result = await probe('#t');
          assert.equal(result.isSubmit, false);
          assert.equal(result.mutationKind, undefined);
          assert.equal(result.resolvedNonSubmitTarget === true || result.resolvedOrdinaryActivationTarget === true, true);
          await open('<section><textarea aria-label="Üzenet">Szia</textarea><div class="attachment"><span>jelentes.pdf</span>'
            + '<button id="t" type="button" aria-label="Melléklet eltávolítása">×</button></div><button type="button">Küldés</button></section>');
          assert.equal((await probe('#t')).resolvedDraftControl, true, 'a removed file shown beside the draft is a draft edit');
        });

        await t.test('a launcher read as publishing, a deletion beside a draft file and a view button outside a dialog keep their checks', async () => {
          // A menu launcher whose caption reads as publishing is a commit; one
          // that names the post its menu acts on only opens the menu.
          await open('<article><p>Bejegyzés</p><button id="t" type="button" aria-haspopup="menu" aria-label="Közzététel">…</button></article>');
          assert.notEqual((await probe('#t'))?.resolvedOrdinaryActivationTarget, true, 'a publishing launcher');
          await open('<article><p>Bejegyzés</p><button id="t" type="button" aria-haspopup="menu" aria-label="Bejegyzés műveletei">…</button></article>');
          assert.equal((await probe('#t')).resolvedOrdinaryActivationTarget, true, 'a post menu launcher');
          // A caption read as a deletion is no draft edit, even beside a file.
          await open('<section><textarea aria-label="Üzenet">Szia</textarea><div class="attachment"><span>jelentes.pdf</span>'
            + '<button id="t" type="button">Törlés</button></div><button type="button">Küldés</button></section>');
          assert.notEqual((await probe('#t')).resolvedDraftControl, true, 'a deletion beside a draft file');
          // A named button read as only changing the view is a non-submit in a
          // dialog, and an ordinary control elsewhere.
          await open('<div role="dialog"><p>Szűrők</p><button id="t" type="button" aria-label="Bezárás">×</button></div>');
          assert.equal((await probe('#t')).resolvedNonSubmitTarget, true, 'a dialog view button');
          await open('<div class="chips"><button id="t" type="button" aria-label="Szűrő eltávolítása">L ×</button></div>');
          assert.equal((await probe('#t')).resolvedOrdinaryActivationTarget, true, 'a filter chip');
        });

        await t.test('commit and publication captions keep their checks; a composer tool read as a commit is not a draft tool', async () => {
          await open('<section><textarea aria-label="Üzenet">Szia</textarea><button id="t" type="button">Küldés</button></section>');
          let result = await probe('#t');
          assert.notEqual(result?.resolvedDraftControl, true);
          assert.notEqual(result?.resolvedOrdinaryActivationTarget, true);
          await open('<form><input name="name" value="Ada"><button id="t" type="button">Mentés</button></form>');
          result = await probe('#t');
          assert.equal(result.isSubmit, true);
          assert.equal(result.validationSubmitEvidence, 'strong', 'a button-typed control read as a commit');
          assert.notEqual(result.nonCommittingControl, true);
          await open('<button id="t" type="button">Bezárás</button>');
          assert.equal((await probe('#t')).resolvedOrdinaryActivationTarget, true);
          await open('<button id="t" type="button" aria-label="Bezárás">×</button>');
          assert.equal((await probe('#t')).resolvedOrdinaryActivationTarget, true, 'a named button read as closing');
        });

        await t.test('the collect pass reports unread captions before changing the page, and an unread caption decides nothing', async () => {
          await open('<ul class="cart"><li>Mavi Tişört — 129 TL <button id="t" type="button">Törlés</button></li><li>Kot <button type="button">Törlés</button></li></ul>');
          await page.evaluate(() => { delete globalThis.__wbResourceMutationScopes; });
          const collected = await runProbe('click', { selector: '#t', __wbCaptionPass: 'collect', __wbResourceRunToken: 'owned-run' });
          assert.deepEqual(collected, { captionsNeeded: ['Törlés'] });
          assert.deepEqual(await page.evaluate(() => {
            const registry = globalThis.__wbResourceMutationScopes;
            return [registry.records.size, registry.launchers.size, registry.unboundLaunch];
          }), [0, 0, null], 'no record, launcher or launch was remembered');
          const unread = await probe('#t', () => null);
          assert.equal(unread.mutationKind, undefined, 'an unread caption is no deletion');
          assert.equal(unread.resolvedOrdinaryActivationTarget, true);
          // Readings already held need no collect pass.
          const held = await runProbe('click', { selector: '#t', __wbCaptionPass: 'collect', __wbCaptionReadings: { Törlés: 'delete_one' },
            __wbResourceRunToken: 'owned-run', __wbResourceTaskKey: 'owned-task' });
          assert.equal(held.mutationKind, 'delete');
        });

        await t.test('a search form reports its landmark, its keyboard and a submit read as searching, in any language', async () => {
          await open('<div role="search"><form id="f" method="get" action="/suche"><input name="begriff" aria-label="Suchbegriff" '
            + 'enterkeyhint="search" value="Fahrrad"><button id="t" type="submit">Suchen</button></form></div>');
          const searched = await probe('#t', caption => (caption === 'Suchen' ? 'view' : read(caption)));
          assert.equal(searched.isSubmit, true);
          assert.equal(searched.searchLandmark, true);
          assert.equal(searched.searchSubmitCaption, true);
          assert.equal(searched.fields?.[0]?.enterKeyHint, 'search');
          // Outside a landmark, with an unread caption, nothing says search.
          await open('<form id="f" method="get" action="/urun"><input name="kw" value="bisiklet"><button id="t" type="submit">Ara</button></form>');
          const plain = await probe('#t', () => null);
          assert.equal(plain.isSubmit, true);
          assert.equal(plain.searchLandmark, false);
          assert.equal(plain.searchSubmitCaption, false);
        });

        await t.test('a GitHub commit-dialog launcher is known by its ellipsis or dialog trigger, in any language', async () => {
          await page.goto('https://github.com/owned/repo/edit/main/README.md');
          // A caption ending in an ellipsis opens the commit dialog, whatever
          // its language; so does a control that names the dialog it opens.
          await open('<form><button id="t">Zatwierdź zmiany…</button></form>');
          assert.equal((await probe('#t')).githubCommitDialogLauncher, true, 'a Polish launcher with an ellipsis');
          await open('<form><button id="t">Commit changes...</button></form>');
          assert.equal((await probe('#t')).githubCommitDialogLauncher, true, 'an English launcher with three dots');
          await open('<form><button id="t" data-show-dialog-id="commit-dialog">Zatwierdź</button></form>');
          assert.equal((await probe('#t')).githubCommitDialogLauncher, true, 'a launcher naming its dialog');
          // A caption with no ellipsis and no dialog commits, as does the
          // dialog's own button and any button off the edit page.
          await open('<form><button id="t">Zatwierdź zmiany</button></form>');
          assert.equal((await probe('#t')).githubCommitDialogLauncher, false, 'a commit button with no ellipsis');
          await open('<div role="dialog" aria-modal="true"><form><button id="t">Zatwierdź zmiany…</button></form></div>');
          assert.equal((await probe('#t')).githubCommitDialogLauncher, false, 'a button inside the commit dialog');
          await page.goto(pageUrl);
          await open('<form><button id="t">Zatwierdź zmiany…</button></form>');
          assert.equal((await probe('#t')).githubCommitDialogLauncher, false, 'a button off the GitHub edit page');
        });
      } finally {
        await browser.close();
      }
    });
  }

  test(`${build}: the agent reads a click's unread captions once, between the two probe passes`, async () => {
    const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
    const original = { chrome: globalThis.chrome, browser: globalThis.browser };
    const passes = [];
    const fakeProbe = (name, args) => {
      passes.push({ pass: args.__wbCaptionPass, readings: { ...args.__wbCaptionReadings } });
      const reading = args.__wbCaptionReadings?.Törlés;
      if (!reading && args.__wbCaptionPass === 'collect') return { captionsNeeded: ['Törlés'] };
      return reading === 'delete_one' ? { isSubmit: true, mutationKind: 'delete', host: 'shop.example', url: pageUrl }
        : { isSubmit: false, resolvedOrdinaryActivationTarget: true, frameDocumentIdentity: 'doc' };
    };
    const api = { storage: { local: area, session: area }, runtime: { getURL: value => value, getManifest: () => ({ version: 'test' }) },
      scripting: { executeScript: async ({ args }) => [{ frameId: 0, result: fakeProbe(...args) }] },
      tabs: { executeScript: async (_tab, { code }) => {
        const call = code.slice(code.lastIndexOf('__wbSubmitProbe(') + '__wbSubmitProbe('.length, code.lastIndexOf('); })()'));
        const name = JSON.parse(call.slice(0, call.indexOf(',')));
        return [fakeProbe(name, JSON.parse(call.slice(call.indexOf(',') + 1)))];
      } } };
    globalThis.chrome = build === 'chrome' ? api : undefined;
    globalThis.browser = api;
    try {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const agent = new Agent({});
      agent._currentUrl = async () => pageUrl;
      const asked = stubPageTextReadings(agent, (kind, item) => (kind === 'control_effect' ? read(item.text) : null));
      const first = await agent._detectLikelySubmitAction(1, 'click', { selector: '#t' });
      assert.equal(first.mutationKind, 'delete');
      assert.deepEqual(passes.map(item => item.pass), ['collect', 'final']);
      assert.deepEqual(passes[1].readings, { Törlés: 'delete_one' });
      assert.deepEqual(asked.map(item => [item.kind, item.text]), [['control_effect', 'Törlés']]);
      // The reading is remembered: the next click needs one pass and no model.
      passes.length = 0;
      assert.equal((await agent._detectLikelySubmitAction(1, 'click', { selector: '#t' })).mutationKind, 'delete');
      assert.deepEqual(passes.map(item => item.pass), ['collect']);
      assert.equal(asked.length, 1);
      // Without any reading the final pass decides as for an unread caption.
      const blind = new Agent({});
      blind._currentUrl = async () => pageUrl;
      stubPageTextReadings(blind, () => null);
      passes.length = 0;
      const unread = await blind._detectLikelySubmitAction(1, 'click', { selector: '#t' });
      assert.equal(unread.resolvedOrdinaryActivationTarget, true);
      assert.deepEqual(passes.map(item => item.pass), ['collect', 'final']);
    } finally {
      globalThis.chrome = original.chrome;
      globalThis.browser = original.browser;
    }
  });
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: the decision model alone pre-reads the captions of a page the model is deciding on`, async () => {
    const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
    globalThis.chrome ??= { storage: { local: area, session: area }, runtime: { getURL: value => value } };
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const agent = new Agent({});
    const calls = [];
    agent._semanticDecisions = async (_tab, kind, { items }, options) => {
      calls.push({ kind, texts: items.map(item => item.text), mainModel: options.mainModel });
      return items.map(item => ({ choice: read(item.text), evidence: item.text, source: 'decision_model' }));
    };
    const tree = [
      'region [ref_1]',
      '  button "Daha fazla" [ref_2] type="button"',
      '  menuitem "Sil" [ref_3]',
      '  link "Ana sayfa" [ref_4] href="/home"',
      '  textbox "Ara" [ref_5]',
      '  tab "Bildirimler" [ref_6]',
      '  button "Say \\"hi\\"" [ref_7]',
    ].join('\n');
    agent._preReadControlCaptions(1, tree);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, [{ kind: 'control_effect', texts: ['Daha fazla', 'Sil', 'Bildirimler', 'Say "hi"'], mainModel: false }]);
    assert.equal(agent._controlEffectReading('Sil'), 'delete_one');
    // Captions already read are not asked again; nothing waits for the read.
    agent._preReadControlCaptions(1, tree);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.length, 1);
    assert.equal(agent._preReadControlCaptions(1, null), undefined);
  });
}
