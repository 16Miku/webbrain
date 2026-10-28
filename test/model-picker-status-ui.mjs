// The provider's online/offline dot is a badge on the composer's provider logo,
// inside the model picker button: it reads as the model's status, and clicking
// it opens the menu like the rest of the button. Runs the real panel markup and
// styles in each build's engine, with the real icon helper and bundled assets.
// The dot's class is set the way testConnection() sets it.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = async (build, file) => (await fs.readFile(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const extract = (source, name) => {
  const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  describe(`${build}: model picker status dot`, () => {
    let browser, html, css, iconHelper;
    before(async () => {
      browser = await engine.launch({ headless: true });
      html = (await read(build, 'src/ui/sidepanel.html'))
        .split('\n')
        .filter((line) => !line.trim().startsWith('<script'))
        .join('\n');
      css = await read(build, 'styles/sidepanel.css');
      const panelSource = await read(build, 'src/ui/sidepanel.js');
      iconHelper = ['syncProviderPickerIcon', 'syncProviderPickerButton'].map(name => extract(panelSource, name)).join('\n');
    });
    after(async () => { await browser?.close(); });

    async function panel(run, { dir = 'ltr', theme = 'dark', state = 'online', failedLogo = '' } = {}) {
      const context = await browser.newContext({ viewport: { width: 420, height: 640 } });
      try {
        await context.route('**/*', async (route) => {
          const { pathname } = new URL(route.request().url());
          if (pathname === '/panel') return route.fulfill({ contentType: 'text/html', body: html });
          if (['/src/ui/provider-icons.js', '/src/providers/provider-catalog.js'].includes(pathname)) {
            return route.fulfill({ contentType: 'text/javascript', body: await read(build, pathname.slice(1)) });
          }
          if (/^\/icons\/providers\/[a-z0-9_-]+\.(svg|png)$/.test(pathname) && !pathname.endsWith(`/${failedLogo}`)) {
            const body = await fs.readFile(new URL(`../src/${build}${pathname}`, import.meta.url));
            return route.fulfill({ contentType: pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png', body });
          }
          return route.fulfill({ status: 404, body: '' });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(2500);
        await page.goto('https://owned-panel.invalid/panel');
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ type: 'module', content: `
          import { providerIconUrl } from '/src/ui/provider-icons.js';
          const providerPickerBtn = document.getElementById('provider-picker-btn');
          const providerPickerLabel = document.getElementById('provider-picker-label');
          const providerPickerMenu = document.getElementById('provider-picker-menu');
          const providerSelect = { value: '' };
          const providerPickerLabelById = new Map();
          const providerPickerModelById = new Map();
          const providerPickerSourceById = new Map();
          const statusDot = null; // The fixture sets connection states directly.
          const t = (key, params) => params?.name ? 'Model: ' + params.name : 'Choose a model';
          ${iconHelper}
          window.selectModel = (model, id = 'openrouter', source = id) => {
            providerSelect.value = id;
            providerPickerModelById.set(id, model);
            providerPickerSourceById.set(id, source);
            syncProviderPickerButton();
          };
        ` });
        await page.waitForFunction(() => typeof window.selectModel === 'function');
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

    test('the dot sits on the icon inside the picker button, not after its arrow', async () => {
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

    const selectModel = (page, model, id = 'openrouter', source = id) => page.evaluate(
      ({ model, id, source }) => window.selectModel(model, id, source), { model, id, source },
    );
    const loadedLogo = async (page, file) => {
      const logo = page.locator('.provider-picker-icon .provider-picker-logo');
      await logo.waitFor({ state: 'visible' });
      await page.waitForFunction((file) => {
        const img = document.querySelector('.provider-picker-icon .provider-picker-logo');
        return img?.complete && img.naturalWidth > 0 && img.src.endsWith(`/icons/providers/${file}`);
      }, file);
      assert.equal(await page.locator('.provider-picker-fallback').isVisible(), false);
      assert.equal(await page.locator('.provider-picker-icon').getAttribute('aria-hidden'), 'true');
      return logo;
    };

    test('the logo is the provider\'s, whatever model it runs, and keeps the green/red status badge', async () => {
      await panel(async (page) => {
        await selectModel(page, 'openai/gpt-6-luna');
        await loadedLogo(page, 'openrouter.svg');
        assert.equal(await page.locator('#provider-picker-btn').getAttribute('aria-label'), 'Model: openrouter · openai/gpt-6-luna');
        const before = await geometry(page);
        assert.ok(before.dot.width >= 6 && before.dot.height >= 6);
        assert.equal(before.hitsButton, true);
        const green = await resolved(page, '--success');
        await page.waitForFunction(green => getComputedStyle(document.getElementById('status-dot')).backgroundColor === green, green);

        await selectModel(page, 'anthropic/claude-sonnet-4');
        await loadedLogo(page, 'openrouter.svg');
        assert.equal(await page.locator('#provider-picker-btn').getAttribute('aria-label'), 'Model: openrouter · anthropic/claude-sonnet-4',
          'the model is still named in the tooltip');
        await selectModel(page, 'claude-sonnet-4', 'anthropic');
        await loadedLogo(page, 'anthropic.svg');
        await page.locator('#status-dot').evaluate(el => { el.className = 'status-dot offline'; });
        const red = await resolved(page, '--error');
        await page.waitForFunction(red => getComputedStyle(document.getElementById('status-dot')).backgroundColor === red, red);
        const after = await geometry(page);
        assert.deepEqual(after.icon, before.icon, 'changing provider logos does not shift the badge');
        assert.deepEqual(after.dot, before.dot);
        assert.equal(after.hitsButton, true);

        await fs.mkdir(new URL('../.build/model-picker-logo/', import.meta.url), { recursive: true });
        await page.locator('.composer-toolbar').screenshot({ path: fileURLToPath(new URL(`../.build/model-picker-logo/${build}.png`, import.meta.url)) });
      });
    });

    test('while a logo loads, the engine stays visible without widening the icon', async () => {
      await panel(async (page) => {
        let resumeLogo;
        let requestStarted;
        const started = new Promise(resolve => { requestStarted = resolve; });
        await page.route('**/icons/providers/openrouter.svg', async route => {
          await new Promise(resolve => { resumeLogo = resolve; requestStarted(); });
          await route.fallback();
        });
        const before = await geometry(page);
        await selectModel(page, 'openai/gpt-6-luna');
        await started;
        try {
          assert.equal(await page.locator('.provider-picker-fallback').isVisible(), true);
          assert.equal(await page.locator('.provider-picker-logo').isVisible(), false);
          const loading = await geometry(page);
          assert.deepEqual(loading.icon, before.icon);
          assert.deepEqual(loading.dot, before.dot);
        } finally {
          resumeLogo();
        }
        await loadedLogo(page, 'openrouter.svg');
        const after = await geometry(page);
        assert.deepEqual(after.icon, before.icon);
        assert.deepEqual(after.dot, before.dot);
      });
    });

    test('a duplicated provider keeps its source\'s logo; an unknown provider shows the engine fallback', async () => {
      await panel(async (page) => {
        await selectModel(page, 'qwen3.5-9b', 'local-instance', 'ollama');
        await loadedLogo(page, 'ollama.svg');
        await selectModel(page, 'unknown-family', 'unknown-provider');
        assert.equal(await page.locator('.provider-picker-fallback').isVisible(), true);
        assert.equal(await page.locator('.provider-picker-logo').count(), 0);
        assert.equal(await page.locator('#status-dot').isVisible(), true);
      });
    });

    test('a missing logo asset restores the engine fallback with the status badge visible', async () => {
      await panel(async (page) => {
        await selectModel(page, 'openai/gpt-6-luna');
        await loadedLogo(page, 'openrouter.svg');
        await selectModel(page, 'claude-sonnet-4', 'anthropic');
        await page.waitForFunction(() => !document.querySelector('.provider-picker-logo'));
        assert.equal(await page.locator('.provider-picker-fallback').isVisible(), true);
        const g = await geometry(page);
        assert.ok(g.dot.width >= 6 && g.dot.height >= 6);
        assert.equal(g.hitsButton, true);
      }, { state: 'offline', failedLogo: 'anthropic.svg' });
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
