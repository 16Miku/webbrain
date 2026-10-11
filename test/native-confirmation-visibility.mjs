import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

// Actual serialized submit probe and app-owned AX references; no tool dispatch,
// account, post, or external request is needed to verify native commit identity.
const html = '<!doctype html><meta charset="utf-8">'
  + '<form id="compose" class="compose-form"><textarea class="autosuggest-textarea__textarea"></textarea></form>'
  + '<div class="navigation-bar"><a class="account__display-name" href="/@qa">@qa</a></div>'
  + '<button id="menu">Sil</button><div id="outer"><div class="modal-root__modal safety-action-modal">'
  + '<div class="safety-action-modal__actions"><button class="link-button" type="button">İptal</button>'
  + '<button class="button" type="button"><span>Sil</span></button></div></div></div>';

for (const [build, launcher] of [['chrome', chromium], ['firefox', firefox]]) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  async function withFixture(run) {
    const browser = await launcher.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addInitScript({ content: await fs.readFile(
        new URL(`../src/${build}/src/content/accessibility-tree.js`, import.meta.url), 'utf8') });
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
      const page = await context.newPage();
      await page.goto('https://owned-native-confirmation.invalid/@qa');
      const reset = async () => page.setContent(html);
      const probe = async (selector = '.button span') => page.evaluate(({ source, selector }) => {
        const fn = (0, eval)(`(${source})`), element = document.querySelector(selector);
        const ref = window.__wb_ax_ref(element);
        return {
          selector: fn('click', { selector }),
          ax: fn('click_ax', { ref_id: ref }),
        };
      }, { source: Agent._submitActionProbe.toString(), selector });
      await run({ page, reset, probe });
    } finally { await browser.close(); }
  }

  test(`${build}: rendered native confirmation retains selector and real AX proof with form associations`, async () => {
    await withFixture(async ({ page, reset, probe }) => {
      for (const variant of ['plain', 'wrapped', 'associated', 'associated-compose', 'default-submit', 'translucent']) {
        await reset();
        await page.evaluate(variant => {
          const modal = document.querySelector('.safety-action-modal'), primary = modal.querySelector('.button');
          if (variant === 'wrapped' || variant === 'default-submit') {
            const form = document.createElement('form'); modal.before(form); form.append(modal);
            if (variant === 'default-submit') primary.removeAttribute('type');
          } else if (variant === 'associated') {
            const form = document.createElement('form'); form.id = 'confirmation-form'; document.body.append(form);
            primary.setAttribute('form', form.id);
          } else if (variant === 'associated-compose') primary.setAttribute('form', 'compose');
          else if (variant === 'translucent') document.querySelector('#outer').style.opacity = '0.1';
        }, variant);
        for (const [path, result] of Object.entries(await probe())) {
          assert.equal(result?.semanticCommit, true, `${variant}/${path}`);
          assert.equal(result?.isSubmit, true, `${variant}/${path}`);
        }
      }
    });
  });

  test(`${build}: invisible native modal, primary and ancestors cannot certify a commit`, async () => {
    await withFixture(async ({ page, reset, probe }) => {
      const incorrectlyCertified = [];
      for (const target of ['.safety-action-modal', '.button', '#outer', '.safety-action-modal__actions']) {
        for (const state of ['opacity:0', 'content-visibility:hidden', 'visibility:collapse', 'visibility:hidden', 'display:none', 'hidden', 'inert', 'aria-hidden']) {
          await reset();
          await page.evaluate(({ target, state }) => {
            const element = document.querySelector(target);
            if (state === 'hidden') { element.hidden = true; element.style.display = 'block'; }
            else if (state === 'inert') element.setAttribute('inert', '');
            else if (state === 'aria-hidden') element.setAttribute('aria-hidden', 'true');
            else element.style.cssText = state;
            // Inherited CSS visibility can be overridden on a child. The
            // native proof must also inspect the ancestor that stays hidden.
            if (target !== '.button' && /visibility:(?:hidden|collapse)/.test(state)) {
              document.querySelector('.button').style.visibility = 'visible';
            }
          }, { target, state });
          for (const [path, result] of Object.entries(await probe())) {
            if (result?.semanticCommit === true) incorrectlyCertified.push(`${target}/${state}/${path}`);
          }
        }
      }
      assert.deepEqual(incorrectlyCertified, []);
    });
  });

  test(`${build}: only rendered native primary controls participate in ambiguity checks`, async () => {
    await withFixture(async ({ page, reset, probe }) => {
      for (const state of ['opacity:0', 'content-visibility:hidden', 'visibility:collapse', 'display:none', 'hidden', 'inert', 'aria-hidden']) {
        await reset();
        await page.evaluate(state => {
          const primary = document.querySelector('.button'), copy = primary.cloneNode(true);
          copy.id = 'inactive-primary'; primary.after(copy);
          if (['hidden', 'inert'].includes(state)) { copy.setAttribute(state, ''); if (state === 'hidden') copy.style.display = 'block'; }
          else if (state === 'aria-hidden') copy.setAttribute(state, 'true');
          else copy.style.cssText = state;
        }, state);
        for (const [path, result] of Object.entries(await probe())) assert.equal(result?.semanticCommit, true, `${state}/${path}`);
        for (const [path, result] of Object.entries(await probe('#inactive-primary'))) assert.notEqual(result?.semanticCommit, true, `inactive/${state}/${path}`);
      }
      await reset();
      await page.evaluate(() => document.querySelector('.button').after(document.querySelector('.button').cloneNode(true)));
      for (const result of Object.values(await probe())) assert.notEqual(result?.semanticCommit, true, 'Two rendered primary controls stay ambiguous.');
    });
  });

  test(`${build}: only rendered native modals participate in ambiguity checks`, async () => {
    await withFixture(async ({ page, reset, probe }) => {
      for (const state of ['opacity:0', 'content-visibility:hidden', 'visibility:collapse', 'display:none', 'hidden', 'inert', 'aria-hidden']) {
        await reset();
        await page.evaluate(state => {
          const modal = document.querySelector('.safety-action-modal'), copy = modal.cloneNode(true);
          const wrapper = document.createElement('div'); wrapper.id = 'inactive-modal'; document.body.append(wrapper); wrapper.append(copy);
          if (['hidden', 'inert'].includes(state)) { wrapper.setAttribute(state, ''); if (state === 'hidden') wrapper.style.display = 'block'; }
          else if (state === 'aria-hidden') wrapper.setAttribute(state, 'true');
          else wrapper.style.cssText = state;
        }, state);
        for (const [path, result] of Object.entries(await probe())) assert.equal(result?.semanticCommit, true, `${state}/${path}`);
        for (const [path, result] of Object.entries(await probe('#inactive-modal .button'))) assert.notEqual(result?.semanticCommit, true, `inactive/${state}/${path}`);
      }
      await reset();
      await page.evaluate(() => document.querySelector('.safety-action-modal').after(document.querySelector('.safety-action-modal').cloneNode(true)));
      for (const result of Object.values(await probe())) assert.notEqual(result?.semanticCommit, true, 'Two rendered native modals stay ambiguous.');
      await reset();
      for (const selector of ['.link-button', '#menu']) for (const result of Object.values(await probe(selector))) {
        assert.notEqual(result?.semanticCommit, true, `${selector} is not a commit.`);
      }
    });
  });
}
