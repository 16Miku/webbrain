import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = async (build, file) => (await fs.readFile(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

// Runs the production composer switch (its whole block in sidepanel.js) against
// the real panel markup, styles and English strings. Only storage, tabs and the
// chat helpers it calls are fixtures, so the test sees every write and notice.
for (const [build, engine, api] of [['chrome', chromium, 'chrome'], ['firefox', firefox, 'browser']]) {
  describe(`${build}: side panel permission switch`, () => {
    let browser, block, html;
    before(async () => {
      browser = await engine.launch({ headless: true });
      const source = await read(build, 'src/ui/sidepanel.js');
      const start = source.indexOf("const permissionGateMenu = document.getElementById('permission-gate-menu');");
      const end = source.indexOf('\nrenderPermissionGateControl();\n', start);
      assert.ok(start >= 0 && end > start, 'Use the entire production switch block.');
      block = source.slice(start, end + '\nrenderPermissionGateControl();\n'.length);
      html = (await read(build, 'src/ui/sidepanel.html'))
        .split('\n')
        .filter((line) => !line.trim().startsWith('<script'))
        .join('\n');
    });
    after(async () => { await browser?.close(); });

    async function fixture(run, { askBefore = true, width = 420 } = {}) {
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
        await context.addInitScript(() => localStorage.setItem('wbLocale', 'en'));
        const page = await context.newPage();
        page.setDefaultTimeout(2500);
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto('https://owned-panel.invalid/panel');
        await page.addStyleTag({ content: await read(build, 'styles/sidepanel.css') });
        await page.addScriptTag({ type: 'module', content: `
          import { t, applyDOMTranslations } from '/src/${build}/src/ui/i18n.js';
          const log = window.__log = { writes: [], notices: [], toasts: [], opened: [], actWarning: 0, placeholder: 0, scaleClosed: 0 };
          let failNextWrite = false;
          window.__failNextWrite = () => { failNextWrite = true; };
          const ${api} = {
            storage: { local: { async set(values) {
              if (failNextWrite) { failNextWrite = false; throw new Error('storage unavailable'); }
              log.writes.push(values);
              if (PERMISSION_GATE_KEY in values) {
                // Chromium dispatches storage.onChanged before the set() callback resumes
                askBeforeConsequential = values[PERMISSION_GATE_KEY] !== false;
              }
            } } },
            runtime: { getURL: (path) => 'ext://webbrain/' + path, openOptionsPage() { log.opened.push('options'); } },
            tabs: { async create({ url }) { log.opened.push(url); } },
          };
          const PERMISSION_GATE_KEY = 'askBeforeConsequentialActions';
          let askBeforeConsequential = ${askBefore};
          const updateActWarning = () => { log.actWarning += 1; };
          const updateInputPlaceholder = () => { log.placeholder += 1; };
          const showComposerToast = (message) => { log.toasts.push(message); };
          const addPersistentSlashMessage = (content) => { log.notices.push(content.__systemHtml); };
          const systemHtml = (value) => ({ __systemHtml: value });
          const closeUiScalePopover = () => { log.scaleClosed += 1; return false; };
          applyDOMTranslations(document);
          ${block}
          window.__ready = true;
        ` });
        await page.waitForFunction(() => window.__ready === true);
        const state = () => page.evaluate(() => {
          const btn = document.getElementById('btn-permission-gate');
          const popover = document.getElementById('permission-gate-popover');
          return {
            title: btn.title,
            label: btn.getAttribute('aria-label'),
            expanded: btn.getAttribute('aria-expanded'),
            off: btn.classList.contains('is-gate-off'),
            dot: getComputedStyle(btn, '::after').content,
            open: !popover.classList.contains('hidden'),
            checked: document.getElementById('toggle-permission-gate-panel').checked,
            noteShown: !document.getElementById('permission-gate-off-note').classList.contains('hidden'),
            focus: document.activeElement?.id || '',
            log: structuredClone(window.__log),
          };
        });
        await run({ page, state });
        assert.deepEqual(errors, [], 'The production switch must not throw.');
      } finally { await context.close(); }
    }

    test('opens like the scale menu and turns prompts off with the same notice as the command', async () => {
      await fixture(async ({ page, state }) => {
        let s = await state();
        assert.equal(s.title, 'Permission prompts: on');
        assert.equal(s.label, 'Permission prompts: on');
        assert.equal(s.off, false);
        assert.equal(s.dot, 'none', 'no warning dot while prompts are on');
        assert.equal(s.open, false);
        assert.equal(s.checked, true);
        assert.equal(s.noteShown, false);

        await page.click('#btn-permission-gate');
        s = await state();
        assert.equal(s.open, true);
        assert.equal(s.expanded, 'true');
        assert.equal(s.focus, 'toggle-permission-gate-panel', 'focus moves to the switch');
        assert.equal(s.log.scaleClosed, 1, 'opening it closes the scale menu');
        assert.match(await page.textContent('#permission-gate-popover'), /Ask before consequential actions[\s\S]*WebBrain asks the first time/);

        await page.click('.permission-gate-row');
        await page.waitForFunction(() => window.__log.writes.length === 1);
        s = await state();
        assert.deepEqual(s.log.writes, [{ askBeforeConsequentialActions: false }]);
        assert.equal(s.log.notices.length, 1);
        assert.match(s.log.notices[0], /Permission prompts are OFF/);
        assert.equal(s.off, true);
        assert.notEqual(s.dot, 'none', 'off state shows a warning dot on the trigger');
        assert.equal(s.title, 'Permission prompts: off');
        assert.equal(s.noteShown, true);
        assert.equal(s.checked, false);
        assert.ok(s.log.actWarning >= 1 && s.log.placeholder >= 1, 'Act warning and placeholder follow the gate');
        // The icon color transitions, so wait for it to settle on the warning color.
        await page.waitForFunction(() => getComputedStyle(document.getElementById('btn-permission-gate')).color
          === getComputedStyle(document.getElementById('permission-gate-off-note')).color);

        await page.keyboard.press('Escape');
        s = await state();
        assert.equal(s.open, false);
        assert.equal(s.expanded, 'false');
        assert.equal(s.focus, 'btn-permission-gate', 'Escape returns focus to the trigger');
      });
    });

    test('turns prompts back on from the switch and closes on an outside click', async () => {
      await fixture(async ({ page, state }) => {
        let s = await state();
        assert.equal(s.off, true);
        assert.equal(s.checked, false);
        await page.click('#btn-permission-gate');
        await page.keyboard.press('Space');
        await page.waitForFunction(() => window.__log.writes.length === 1);
        s = await state();
        assert.deepEqual(s.log.writes, [{ askBeforeConsequentialActions: true }]);
        assert.deepEqual(s.log.toasts, ['Permission prompts are on again.']);
        assert.equal(s.log.notices.length, 0);
        assert.equal(s.off, false);
        assert.equal(s.noteShown, false);
        await page.mouse.click(200, 400);
        assert.equal((await state()).open, false);
      }, { askBefore: false });
    });

    test('a failed write keeps showing the stored state', async () => {
      await fixture(async ({ page, state }) => {
        await page.click('#btn-permission-gate');
        await page.evaluate(() => window.__failNextWrite());
        await page.click('.permission-gate-row');
        await page.waitForFunction(() => document.getElementById('toggle-permission-gate-panel').checked === true);
        const s = await state();
        assert.deepEqual(s.log.writes, []);
        assert.deepEqual(s.log.notices, []);
        assert.equal(s.off, false);
      });
    });

    test('links to the site permission list and fits a narrow panel', async () => {
      await fixture(async ({ page, state }) => {
        await page.click('#btn-permission-gate');
        const box = await page.locator('#permission-gate-popover').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 360, `popover stays inside a 360px panel (${box.x}+${box.width})`);
        const toolbar = await page.locator('.composer-toolbar').boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= toolbar.y, `popover opens upward above the composer toolbar (${box.y}+${box.height} vs ${toolbar.y})`);
        assert.ok(toolbar.height <= 36, 'the composer toolbar stays on one row');
        const header = await page.locator('#header').boundingBox();
        assert.ok(header.height <= 56, 'the header does not wrap');
        await page.click('#btn-permission-gate-settings');
        await page.waitForFunction(() => window.__log.opened.length === 1);
        const s = await state();
        assert.deepEqual(s.log.opened, ['ext://webbrain/src/ui/settings.html#permissions']);
        assert.equal(s.open, false);
      }, { width: 360 });
    });

    test('keeps the model picker usable at 175% scale in a narrow panel', async () => {
      await fixture(async ({ page }) => {
        await page.evaluate(() => {
          document.documentElement.dataset.uiScale = '175';
          document.documentElement.style.setProperty('--ui-scale-zoom', '1.75');
          document.getElementById('provider-picker-label').textContent = 'OpenRouter · a long model name';
        });
        const rects = await page.evaluate(() => {
          const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
          return {
            picker: rect('#provider-picker-btn'),
            wrapper: rect('#input-wrapper'),
            permission: rect('#btn-permission-gate'),
            mic: rect('#btn-mic'),
          };
        });
        // The picker keeps (nearly) the whole composer width instead of being squeezed to a few pixels.
        assert.ok(rects.picker.width >= rects.wrapper.width * 0.6, `picker stays wide (${rects.picker.width} of ${rects.wrapper.width})`);
        assert.ok(rects.permission.top >= rects.picker.bottom - 1, 'permission and mic controls sit below the picker, not on top of it');
        assert.ok(rects.mic.top >= rects.picker.bottom - 1);
        assert.ok(rects.permission.right <= rects.wrapper.right && rects.mic.right <= rects.wrapper.right, 'controls stay inside the composer');
        // No visual reordering: tabbing through the toolbar reads top-to-bottom, left-to-right.
        const order = await page.evaluate(() => [...document.querySelectorAll('.composer-toolbar button:not([hidden]), .composer-toolbar [tabindex]:not([tabindex="-1"])')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => { const r = el.getBoundingClientRect(); return { id: el.id, top: Math.round((r.top + r.bottom) / 2), left: Math.round(r.left) }; }));
        for (let i = 1; i < order.length; i++) {
          const before = order[i - 1], after = order[i];
          assert.ok(after.top > before.top + 8 || (Math.abs(after.top - before.top) <= 8 && after.left >= before.left),
            `DOM order matches visual order (${before.id} then ${after.id})`);
        }
      }, { width: 360 });
    });
  });
}
