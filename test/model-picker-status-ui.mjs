// The provider's online/offline dot is a badge on the composer's engine icon,
// inside the model picker button: it reads as the model's status, and clicking
// it opens the menu like the rest of the button. Runs the real panel markup and
// styles in each build's engine (scripts are left out; the dot's class is set
// the way testConnection() sets it).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = async (build, file) => (await fs.readFile(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  describe(`${build}: model picker status dot`, () => {
    let browser, html, css;
    before(async () => {
      browser = await engine.launch({ headless: true });
      html = (await read(build, 'src/ui/sidepanel.html'))
        .split('\n')
        .filter((line) => !line.trim().startsWith('<script'))
        .join('\n');
      css = await read(build, 'styles/sidepanel.css');
    });
    after(async () => { await browser?.close(); });

    async function panel(run, { dir = 'ltr', theme = 'dark', state = 'online' } = {}) {
      const context = await browser.newContext({ viewport: { width: 420, height: 640 } });
      try {
        await context.route('**/*', (route) => {
          const { pathname } = new URL(route.request().url());
          if (pathname === '/panel') return route.fulfill({ contentType: 'text/html', body: html });
          return route.fulfill({ status: 404, body: '' });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(2500);
        await page.goto('https://owned-panel.invalid/panel');
        await page.addStyleTag({ content: css });
        await page.evaluate(({ dir, theme, state }) => {
          document.documentElement.dir = dir;
          if (theme === 'light') document.documentElement.dataset.theme = 'light';
          document.getElementById('status-dot').className = state ? `status-dot ${state}` : 'status-dot';
        }, { dir, theme, state });
        return await run(page);
      } finally {
        await context.close();
      }
    }

    const geometry = (page) => page.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const button = document.getElementById('provider-picker-btn');
      const dot = document.getElementById('status-dot');
      const d = rect(dot);
      const cx = (d.left + d.right) / 2;
      const cy = (d.top + d.bottom) / 2;
      return {
        button: rect(button),
        icon: rect(button.querySelector('.provider-picker-icon')),
        caret: rect(button.querySelector('.provider-picker-caret')),
        dot: d,
        center: { x: cx, y: cy },
        hitsButton: document.elementFromPoint(cx, cy)?.closest('#provider-picker-btn') === button,
      };
    });

    // The color a CSS custom property resolves to, as getComputedStyle reports it.
    const resolved = (page, variable) => page.evaluate((variable) => {
      const probe = document.createElement('i');
      probe.style.color = `var(${variable})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, variable);

    test('the dot sits on the engine icon inside the picker button, not after its arrow', async () => {
      await panel(async (page) => {
        const placement = await page.evaluate(() => {
          const dot = document.getElementById('status-dot');
          const button = document.getElementById('provider-picker-btn');
          return {
            inButton: button.contains(dot),
            withIcon: dot.parentElement.classList.contains('provider-picker-engine')
              && dot.parentElement.querySelector('.provider-picker-icon') !== null,
            toolbarChild: dot.parentElement.classList.contains('composer-toolbar'),
            describedBy: button.getAttribute('aria-describedby'),
          };
        });
        assert.deepEqual(placement, { inButton: true, withIcon: true, toolbarChild: false, describedBy: 'status-dot' });

        const g = await geometry(page);
        assert.ok(g.dot.width >= 6 && g.dot.height >= 6, `the dot stays visible: ${JSON.stringify(g.dot)}`);
        assert.ok(g.center.x > g.icon.left + g.icon.width / 2 && g.center.x <= g.icon.right + 2, `the dot is on the icon's right edge: ${JSON.stringify(g)}`);
        assert.ok(g.center.y > g.icon.top + g.icon.height / 2 && g.center.y <= g.icon.bottom + 2, `the dot is on the icon's lower edge: ${JSON.stringify(g)}`);
        assert.ok(g.dot.right <= g.caret.left, `the dot stays clear of the arrow: ${JSON.stringify(g)}`);
        assert.ok(g.dot.left >= g.button.left && g.dot.right <= g.button.right && g.dot.top >= g.button.top && g.dot.bottom <= g.button.bottom, `the dot is inside the button: ${JSON.stringify(g)}`);
        assert.equal(g.hitsButton, true, 'a click on the dot lands on the button');
      });
    });

    if (build === 'chrome') {
      test('screen readers get the connection status as the button description', async () => {
        await panel(async (page) => {
          await page.evaluate(() => {
            const button = document.getElementById('provider-picker-btn');
            button.setAttribute('aria-label', 'Model: OpenRouter · gpt-6-luna');
            document.getElementById('status-dot').title = 'Connected (gpt-6-luna)';
          });
          const client = await page.context().newCDPSession(page);
          const { root } = await client.send('DOM.getDocument', { depth: -1 });
          const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#provider-picker-btn' });
          const [node] = (await client.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })).nodes;
          assert.deepEqual(
            { role: node.role?.value, name: node.name?.value, description: node.description?.value },
            { role: 'button', name: 'Model: OpenRouter · gpt-6-luna', description: 'Connected (gpt-6-luna)' },
          );
        });
      });
    }

    test('clicking the dot is a click on the model picker', async () => {
      await panel(async (page) => {
        await page.evaluate(() => {
          window.__clicks = 0;
          document.getElementById('provider-picker-btn').addEventListener('click', () => { window.__clicks += 1; });
        });
        const { center } = await geometry(page);
        await page.mouse.click(center.x, center.y);
        assert.equal(await page.evaluate(() => window.__clicks), 1);
      });
    });

    test('right to left, the dot moves to the icon corner on the arrow side', async () => {
      await panel(async (page) => {
        const g = await geometry(page);
        assert.ok(g.center.x < g.icon.left + g.icon.width / 2 && g.center.x >= g.icon.left - 2, `the dot is on the icon's left edge: ${JSON.stringify(g)}`);
        assert.ok(g.center.y > g.icon.top + g.icon.height / 2, `the dot is on the icon's lower edge: ${JSON.stringify(g)}`);
        assert.ok(g.dot.left >= g.caret.right, `the dot stays clear of the arrow: ${JSON.stringify(g)}`);
        assert.equal(g.hitsButton, true);
      }, { dir: 'rtl' });
    });

    test('a ring in the background color separates the dot from the icon, also on hover', async () => {
      for (const theme of ['dark', 'light']) {
        await panel(async (page) => {
          const shadow = () => page.evaluate(() => getComputedStyle(document.getElementById('status-dot')).boxShadow);
          const input = await resolved(page, '--bg-input');
          assert.ok((await shadow()).includes(input), `${theme}: ring in the composer background: ${await shadow()} vs ${input}`);
          await page.hover('#provider-picker-btn');
          const hover = await resolved(page, '--bg-secondary');
          assert.ok((await shadow()).includes(hover), `${theme}: ring follows the hovered button: ${await shadow()} vs ${hover}`);
        }, { theme });
      }
    });

    test('each state keeps its color, and an untested provider shows no dot or ring', async () => {
      for (const [state, variable] of [['online', '--success'], ['offline', '--error'], ['connecting', '--warning']]) {
        await panel(async (page) => {
          const expected = await resolved(page, variable);
          await page.waitForFunction((expected) => getComputedStyle(document.getElementById('status-dot')).backgroundColor === expected, expected);
        }, { state });
      }
      await panel(async (page) => {
        // The markup starts offline; the background fades out over 0.3 s.
        await page.waitForFunction(() => getComputedStyle(document.getElementById('status-dot')).backgroundColor === 'rgba(0, 0, 0, 0)');
        assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('status-dot')).boxShadow), 'none');
      }, { state: '' });
    });
  });
}
