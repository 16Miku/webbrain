import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = async (build, file) => (await fs.readFile(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
// Screenshots are written only when PERMISSION_SKIP_UI_OUTPUT names a folder.
const screenshots = process.env.PERMISSION_SKIP_UI_OUTPUT ? resolve(process.env.PERMISSION_SKIP_UI_OUTPUT) : '';

// Runs the production "Dangerously skip permissions" dialog block (its gate
// helpers, dialog and startup load in sidepanel.js) against the real panel
// markup, styles and strings. Storage, the clarify answer and the chat
// notices are fixtures, so the test sees every write and answer.
for (const [build, engine, api] of [['chrome', chromium, 'chrome'], ['firefox', firefox, 'browser']]) {
  describe(`${build}: permission card skip dialog`, () => {
    let browser, block, html, source;
    before(async () => {
      browser = await engine.launch({ headless: true });
      source = await read(build, 'src/ui/sidepanel.js');
      const start = source.indexOf('function syncAskBeforeConsequential() {');
      const endMarker = '  syncAskBeforeConsequential();\n}).catch(() => {});\n';
      const end = source.indexOf(endMarker, start);
      assert.ok(start >= 0 && end > start, 'Use the entire production dialog block.');
      block = source.slice(start, end + endMarker.length);
      html = (await read(build, 'src/ui/sidepanel.html'))
        .split('\n')
        .filter((line) => !line.trim().startsWith('<script'))
        .join('\n');
    });
    after(async () => { await browser?.close(); });

    async function fixture(run, { locale = 'en', width = 420, sessionStored = false, failSessionWrite = false, currentTab = 7, storedOff = false } = {}) {
      const context = await browser.newContext({ viewport: { width, height: 640 } });
      const errors = [];
      try {
        await context.route('**/*', async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname === '/panel') return route.fulfill({ contentType: 'text/html', body: html });
          if (!pathname.startsWith(`/src/${build}/`) || pathname.includes('..')) return route.fulfill({ status: 404, body: '' });
          try {
            const body = await fs.readFile(new URL(`../src/${build}/${pathname.slice(`/src/${build}/`.length)}`, import.meta.url));
            return route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body });
          } catch { return route.fulfill({ status: 404, body: '' }); }
        });
        await context.addInitScript((code) => localStorage.setItem('wbLocale', code), locale);
        const page = await context.newPage();
        page.setDefaultTimeout(2500);
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto('https://owned-panel.invalid/panel');
        await page.addStyleTag({ content: await read(build, 'styles/sidepanel.css') });
        await page.addScriptTag({ type: 'module', content: `
          import { t, applyDOMTranslations } from '/src/${build}/src/ui/i18n.js';
          import { PERMISSION_GATE_SESSION_OFF_KEY } from '/src/${build}/src/agent/permission-gate.js';
          const log = window.__log = { local: [], session: [], removed: [], submits: [], resolved: [], notices: [], toasts: [] };
          const sessionStore = ${sessionStored ? "{ [PERMISSION_GATE_SESSION_OFF_KEY]: true }" : '{}'};
          const ${api} = { storage: {
            local: {
              async get() { return ${storedOff} ? { askBeforeConsequentialActions: false } : {}; },
              async set(values) { log.local.push(values); },
            },
            session: {
              async get(key) { return key in sessionStore ? { [key]: sessionStore[key] } : {}; },
              async set(values) {
                if (${failSessionWrite}) throw new Error('session storage unavailable');
                log.session.push(values);
              },
              async remove(key) { log.removed.push(key); },
            },
          } };
          const PERMISSION_GATE_KEY = 'askBeforeConsequentialActions';
          const ACT_WARNING_DISMISSED_KEY = 'actWarningDismissed';
          let askBeforeConsequential = true;
          let permissionGateStoredOff = ${storedOff};
          let permissionGateSessionOff = false;
          let actWarningDismissed = false;
          let actWarningPreferenceLoaded = false;
          let newConversationConfirmationState = null;
          const currentTabId = ${currentTab};
          const appEl = document.getElementById('app');
          const inputEl = document.getElementById('user-input');
          const sameTabId = (a, b) => a != null && b != null && String(a) === String(b);
          const updateActWarning = () => {};
          const updateInputPlaceholder = () => {};
          const renderPermissionGateControl = () => {};
          const showComposerToast = (message) => { log.toasts.push(message); };
          const addPersistentSlashMessage = (content) => { log.notices.push(content.__systemHtml); };
          const systemHtml = (value) => ({ __systemHtml: value });
          // What submitClarify does to a permission card: answer it once, then remove it.
          const submitClarify = (card, tabId, clarifyId, answer, source) => {
            if (card.classList.contains('clarify-answered')) return;
            log.submits.push([tabId, clarifyId, answer, source]);
            card.classList.add('clarify-answered');
            card.remove();
          };
          const resolvePendingPermissionPromptsForTab = (tabId) => { log.resolved.push(tabId); };
          applyDOMTranslations(document);
          ${block}
          // A permission card as the panel renders it: three answers and the skip button.
          const card = document.createElement('div');
          card.className = 'clarify-card';
          card.dataset.permission = '1';
          card.dataset.tabId = '7';
          card.dataset.clarifyId = 'c1';
          card.innerHTML = '<div class="clarify-question"></div><div class="clarify-options"></div>';
          card.querySelector('.clarify-question').textContent = t('sp.perm.question', { verb: 'click / submit on', host: 'example.com' });
          for (const [value, key] of [['once', 'sp.perm.allow_once'], ['always', 'sp.perm.always_allow'], ['deny', 'sp.perm.dont_allow']]) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'clarify-option'; b.dataset.value = value;
            b.textContent = t(key, { host: 'example.com' });
            card.querySelector('.clarify-options').appendChild(b);
          }
          const skip = document.createElement('button');
          skip.type = 'button'; skip.className = 'clarify-skip-permissions';
          skip.textContent = t('sp.perm.skip_all');
          bindPermissionSkipButton(skip, card, 7, 'c1');
          card.querySelector('.clarify-options').appendChild(skip);
          document.getElementById('messages').appendChild(card);
          Object.assign(window, {
            gate: () => ({ askBeforeConsequential, permissionGateStoredOff, permissionGateSessionOff }),
          });
          setTimeout(() => { window.__ready = true; }, 0);
        ` });
        await page.waitForFunction(() => window.__ready === true);
        const state = () => page.evaluate(() => ({
          open: !document.getElementById('permission-skip-dialog').classList.contains('hidden'),
          inert: document.getElementById('app').inert === true,
          focus: document.activeElement?.id || document.activeElement?.className || '',
          cardConnected: !!document.querySelector('.clarify-card[data-clarify-id="c1"]'),
          gate: window.gate(),
          log: structuredClone(window.__log),
        }));
        await run({ page, state });
        assert.deepEqual(errors, [], 'The production dialog must not throw.');
      } finally { await context.close(); }
    }

    test('the card button is not an answer and a restored card binds it again', () => {
      const cardStart = source.indexOf("    // Not a .clarify-option: it opens the skip dialog instead of answering,");
      assert.ok(cardStart > 0, 'the permission card adds the skip button');
      const cardBlock = source.slice(cardStart, source.indexOf('card.appendChild(optionsEl);', cardStart));
      assert.match(cardBlock, /if \(!upload\) \{/, 'an upload card has no skip button: its file is approved one at a time');
      assert.match(cardBlock, /skip\.className = 'clarify-skip-permissions';/);
      assert.doesNotMatch(cardBlock, /className = '[^']*clarify-option/);
      assert.match(source, /card\.querySelectorAll\('\.clarify-skip-permissions'\)\.forEach\(btn => bindPermissionSkipButton\(btn, card, tabId, clarifyId\)\);/);
      // Like its siblings, the button is labelled once, not re-translated on its own.
      assert.doesNotMatch(cardBlock, /skip\.dataset\.i18n/);
    });

    test('a tab switch closes the dialog, and the Permissions page follows the session skip', async () => {
      const tabSwitch = source.indexOf('settleNewConversationConfirmation(false, { restoreFocus: false });');
      assert.ok(tabSwitch > 0);
      assert.match(source.slice(tabSwitch, tabSwitch + 300), /closePermissionSkipDialog\(\{ restoreFocus: false \}\);/,
        'switching tabs must not leave the dialog over another chat');
      const settings = await read(build, 'src/ui/settings.js');
      assert.match(settings, /area === 'session' && changes\[PERMISSION_GATE_SESSION_OFF_KEY\]/,
        'an open Permissions page must follow the session skip');
    });

    test('opens over an inert panel and closing returns to the waiting card', async () => {
      await fixture(async ({ page, state }) => {
        await page.click('.clarify-skip-permissions');
        let s = await state();
        assert.equal(s.open, true);
        assert.equal(s.inert, true, 'the panel behind the dialog is inert');
        assert.equal(s.focus, 'permission-skip-dialog-close', 'focus starts on the safe choice');
        assert.equal(await page.textContent('#permission-skip-dialog-title'), 'Skip all permission prompts?');
        assert.match(await page.textContent('#permission-skip-dialog-description'), /without asking[\s\S]*safety checks still stop or ask/);
        assert.match(await page.textContent('#permission-skip-dialog-session'), /This session only[\s\S]*Until you quit the browser/);
        assert.match(await page.textContent('#permission-skip-dialog-forever'), /Forever[\s\S]*Until you turn prompts back on/);
        assert.equal(await page.getAttribute('#permission-skip-dialog-close', 'aria-label'), 'Close and go back');

        // Focus stays inside the dialog.
        await page.keyboard.press('Tab');
        assert.equal((await state()).focus, 'permission-skip-dialog-session');
        await page.keyboard.press('Tab');
        assert.equal((await state()).focus, 'permission-skip-dialog-forever');
        await page.keyboard.press('Tab');
        assert.equal((await state()).focus, 'permission-skip-dialog-close');
        await page.keyboard.press('Shift+Tab');
        assert.equal((await state()).focus, 'permission-skip-dialog-forever');

        await page.click('#permission-skip-dialog-close');
        s = await state();
        assert.equal(s.open, false);
        assert.equal(s.inert, false);
        assert.equal(s.focus, 'clarify-skip-permissions', 'focus returns to the card');
        assert.equal(s.cardConnected, true, 'the card still waits for an answer');

        await page.click('.clarify-skip-permissions');
        await page.keyboard.press('Escape');
        assert.equal((await state()).open, false, 'Escape closes it');

        await page.click('.clarify-skip-permissions');
        await page.mouse.click(4, 4);
        s = await state();
        assert.equal(s.open, false, 'a click outside the card closes it');
        // Shift+Tab from the dialog container itself stays inside.
        await page.click('.clarify-skip-permissions');
        await page.evaluate(() => document.getElementById('permission-skip-dialog').focus());
        await page.keyboard.press('Shift+Tab');
        assert.equal((await state()).focus, 'permission-skip-dialog-forever');
        // With the card gone (its run ended), closing returns focus to the composer.
        await page.evaluate(() => document.querySelector('.clarify-card').remove());
        await page.keyboard.press('Escape');
        assert.equal((await state()).focus, 'user-input');
        s = await state();
        assert.deepEqual(s.log, { local: [], session: [], removed: [], submits: [], resolved: [], notices: [], toasts: [] },
          'closing changes nothing and answers nothing');
        assert.equal(s.gate.askBeforeConsequential, true);
      });
    });

    test('"This session only" turns prompts off in storage.session and allows the card', async () => {
      await fixture(async ({ page, state }) => {
        await page.click('.clarify-skip-permissions');
        await page.click('#permission-skip-dialog-session');
        await page.waitForFunction(() => window.__log.submits.length === 1);
        const s = await state();
        assert.equal(s.open, false);
        assert.equal(s.inert, false);
        assert.deepEqual(s.log.session, [{ skipPermissionPromptsThisSession: true }]);
        assert.deepEqual(s.log.local, [], 'the stored setting is untouched');
        assert.deepEqual(s.log.submits, [[7, 'c1', 'once', 'option']], 'the card is answered as the user’s own choice');
        assert.deepEqual(s.log.resolved, [7], 'other waiting permission cards on the tab are allowed too');
        assert.equal(s.log.notices.length, 1);
        assert.match(s.log.notices[0], /Permission prompts are OFF until you quit the browser/);
        assert.deepEqual(s.gate, { askBeforeConsequential: false, permissionGateStoredOff: false, permissionGateSessionOff: true });
        assert.equal(s.cardConnected, false);
        assert.equal(s.focus, 'user-input', 'focus goes back to the composer');
      });
    });

    test('"Forever" turns the stored setting off like /dangerously-skip-permissions', async () => {
      await fixture(async ({ page, state }) => {
        await page.click('.clarify-skip-permissions');
        await page.click('#permission-skip-dialog-forever');
        await page.waitForFunction(() => window.__log.submits.length === 1);
        const s = await state();
        assert.deepEqual(s.log.local, [{ askBeforeConsequentialActions: false }]);
        assert.deepEqual(s.log.session, []);
        assert.deepEqual(s.log.submits, [[7, 'c1', 'once', 'option']]);
        assert.match(s.log.notices[0], /Permission prompts are OFF\.<\/strong>/);
        assert.deepEqual(s.gate, { askBeforeConsequential: false, permissionGateStoredOff: true, permissionGateSessionOff: false });
      });
    });

    test('a failed write leaves prompts on and the card waiting', async () => {
      await fixture(async ({ page, state }) => {
        await page.click('.clarify-skip-permissions');
        await page.click('#permission-skip-dialog-session');
        await page.waitForFunction(() => window.__log.toasts.length === 1);
        const s = await state();
        assert.match(s.log.toasts[0], /session storage unavailable/);
        assert.deepEqual(s.log.submits, []);
        assert.equal(s.cardConnected, true);
        assert.equal(s.gate.askBeforeConsequential, true);
        assert.equal(s.focus, 'clarify-skip-permissions');
      }, { failSessionWrite: true });
    });

    test('a scheduled task\'s card from another tab still gets the notice in this chat', async () => {
      await fixture(async ({ page, state }) => {
        await page.click('.clarify-skip-permissions');
        await page.click('#permission-skip-dialog-forever');
        await page.waitForFunction(() => window.__log.submits.length === 1);
        const s = await state();
        assert.equal(s.log.notices.length, 1);
        assert.match(s.log.notices[0], /Permission prompts are OFF\.<\/strong>/);
        assert.deepEqual(s.log.resolved, [7]);
      }, { currentTab: 9 });
    });

    test('"This session only" while prompts are already off for good says they stay off', async () => {
      await fixture(async ({ page, state }) => {
        await page.click('.clarify-skip-permissions');
        await page.click('#permission-skip-dialog-session');
        await page.waitForFunction(() => window.__log.submits.length === 1);
        const s = await state();
        assert.equal(s.log.notices.length, 1);
        assert.match(s.log.notices[0], /Permission prompts are OFF\.<\/strong>/, 'not "until you close the browser"');
      }, { storedOff: true });
    });

    test('a double activation saves once and answers the card once', async () => {
      await fixture(async ({ page, state }) => {
        await page.click('.clarify-skip-permissions');
        await page.evaluate(() => {
          const forever = document.getElementById('permission-skip-dialog-forever');
          forever.click();
          forever.click();
        });
        await page.waitForFunction(() => window.__log.submits.length === 1);
        const s = await state();
        assert.deepEqual(s.log.local, [{ askBeforeConsequentialActions: false }]);
        assert.deepEqual(s.log.submits, [[7, 'c1', 'once', 'option']]);
        assert.equal(s.open, false);
        assert.equal(await page.locator('#permission-skip-dialog-forever').isDisabled(), false, 'the choices are usable again next time');
      });
    });

    test('a skip for this browser session is read when the panel opens', async () => {
      await fixture(async ({ page, state }) => {
        await page.waitForFunction(() => window.gate().permissionGateSessionOff === true);
        const s = await state();
        assert.deepEqual(s.gate, { askBeforeConsequential: false, permissionGateStoredOff: false, permissionGateSessionOff: true });
      }, { sessionStored: true });
    });

    test('fits a narrow panel in long and right-to-left languages', async () => {
      if (screenshots) await fs.mkdir(screenshots, { recursive: true });
      for (const locale of ['en', 'de', 'ar', 'ja', 'tl']) {
        await fixture(async ({ page }) => {
          if (screenshots) await page.locator('.clarify-card').screenshot({ path: resolve(screenshots, `${build}-${locale}-card-280.png`) });
          await page.click('.clarify-skip-permissions');
          await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
          const fit = await page.evaluate(() => {
            const card = document.querySelector('.permission-skip-dialog-card').getBoundingClientRect();
            const buttons = [...document.querySelectorAll('.permission-skip-dialog-actions button')].map((b) => ({
              overflow: b.scrollWidth > b.clientWidth + 1,
            }));
            return {
              inside: card.left >= 0 && card.right <= innerWidth && card.top >= 0 && card.bottom <= innerHeight,
              pageScroll: document.documentElement.scrollWidth > innerWidth,
              buttons,
              translated: !/sp\.perm\./.test(document.getElementById('permission-skip-dialog').textContent),
            };
          });
          assert.equal(fit.inside, true, `${locale}: the dialog fits the panel`);
          assert.equal(fit.pageScroll, false, `${locale}: no sideways scroll`);
          assert.ok(fit.buttons.every((b) => !b.overflow), `${locale}: button text wraps instead of overflowing`);
          assert.equal(fit.translated, true, `${locale}: every string is translated or falls back to English`);
          if (screenshots) await page.screenshot({ path: resolve(screenshots, `${build}-${locale}-dialog-280.png`) });
        }, { locale, width: 280 });
      }
    });
  });
}
