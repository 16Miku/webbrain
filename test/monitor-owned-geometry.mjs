// Agent-owned preparation geometry and decision-level geometry for model-bound
// targets: the agent's own selector scroll or hover may move the exact node,
// and a pure layout/scroll move before preparation keeps the model decision.
// Semantics, hit, user intervention and later moves stay exactly checked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const RUN = 'geometry-run';
const MOVE = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'];
const PRESS = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'click', 'input', 'change'];
const page = ({ spacer = 0, css = '' } = {}) => `<!doctype html><style>
body { margin: 20px; font: 16px sans-serif; } #commit { width: 200px; height: 45px; } .more { display: none; } ${css}
</style><div id="banner-slot"></div>${spacer ? `<div style="height:${spacer}px"></div>` : ''}
<main><h1>Current record settings</h1><button id="commit" type="button">Apply settings</button>
<button class="more" type="button">More actions</button>
<label>Record title <input id="title" value="Owned neutral draft"></label></main>
<aside><span id="counter">0</span></aside><div style="height:3000px"></div>
<script>window.clicks = 0; document.getElementById('commit').addEventListener('click', () => clicks++);</script>`;

async function fixture(browser, build, body) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await context.route('https://geometry.test/**', route => route.fulfill({ contentType: 'text/html', body }));
  await context.addInitScript(RUN => {
    window.feedback = []; window.messageListeners = [];
    const runtime = {
      onMessage: { addListener: fn => messageListeners.push(fn), removeListener() {} },
      async sendMessage(msg) {
        if (msg.action === 'get_page_monitor_state') return { active: true, runToken: RUN, documentToken: msg.documentToken };
        if (msg.action === 'page_feedback') { feedback.push(msg.feedback); return { accepted: true }; }
        return {};
      },
    };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.__wb_ax_lookup = ref => document.getElementById(ref.replace(/^ref_/, ''));
    window.deliver = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of messageListeners) {
        const asynchronous = listener({ target: 'content', action, params: { runToken: RUN, ...params } }, {}, respond);
        if (answered || asynchronous === true) return;
      }
      resolve(undefined);
    });
  }, RUN);
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8') });
  const tab = await context.newPage();
  await tab.goto('https://geometry.test/start');
  await tab.waitForFunction(() => window.__wbPageMonitor?.active);
  await tab.mouse.move(5, 690);
  await tab.waitForTimeout(250);
  await tab.evaluate(() => { feedback = []; });
  return { context, page: tab };
}

const message = (tab, action, params = {}) => tab.evaluate(({ action, params }) => Promise.race([deliver(action, params),
  new Promise(resolve => setTimeout(() => resolve({ ready: false, code: 'monitor_response_missing' }), 3000))]), { action, params });

async function certify(tab, extra = {}) {
  const snapshot = await message(tab, 'page_monitor_capture_model');
  assert.equal(snapshot.ready, true);
  const base = { runToken: RUN, operationId: 'owned', tool: 'click', selector: '#commit',
    expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true, ...extra };
  assert.equal((await message(tab, 'page_monitor_prepare', base)).modelBindingValid, true);
  return { snapshot, base };
}

async function center(tab) {
  const box = await tab.locator('#commit').boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: the agent's own selector scroll refreshes only its target geometry`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const selectorClick = async (tab, between = async () => {}) => {
        const { base } = await certify(tab);
        const fence = await message(tab, 'page_monitor_dispatch', { ...base, kind: 'scroll', scrollIntoView: true, fenceOnly: true });
        assert.equal(fence.ready, true);
        const before = await tab.evaluate(() => scrollY);
        await tab.evaluate(guard => {
          const commit = document.getElementById('commit');
          commit.dispatchEvent(new CustomEvent('webbrain-agent-scroll-dispatch', { bubbles: true, composed: true, cancelable: true, detail: JSON.stringify(guard) }));
          commit.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        }, fence.guard);
        assert.ok(await tab.evaluate(() => scrollY) > before, 'The owned preparation scroll moved the target');
        await between(tab);
        const point = await center(tab);
        const movement = await message(tab, 'page_monitor_dispatch', { ...base, kind: 'click', ...point, navigationCandidate: false,
          pointerPreparationOnly: true, eventTypes: MOVE });
        if (!movement.ready) return { stage: 'movement', predicate: movement.preparationVeto?.predicate };
        const press = await message(tab, 'page_monitor_dispatch', { ...base, kind: 'click', ...point, navigationCandidate: true, eventTypes: PRESS });
        return press.ready ? { stage: 'ready' } : { stage: 'press', predicate: press.preparationVeto?.predicate };
      };

      await t.test('a certified selector target that was not centred is pressed after the owned scroll', async () => {
        const { context, page: tab } = await fixture(browser, build, page({ spacer: 440 }));
        try { assert.deepEqual(await selectorClick(tab), { stage: 'ready' }); }
        finally { await context.close(); }
      });

      await t.test('unrelated churn between the owned scroll and the pointer stays observable without a veto', async () => {
        const { context, page: tab } = await fixture(browser, build, page({ spacer: 440 }));
        try {
          assert.deepEqual(await selectorClick(tab, tab => tab.evaluate(() => { document.getElementById('counter').textContent = '1'; })),
            { stage: 'ready' });
          await tab.waitForTimeout(260);
          assert.ok((await tab.evaluate(() => feedback)).some(event => event.kind === 'dom'));
        } finally { await context.close(); }
      });

      for (const [name, between] of [
        ['a changed target label', tab => tab.evaluate(() => { document.getElementById('commit').textContent = 'Delete records'; })],
        ['a covering overlay', tab => tab.evaluate(() => {
          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:white;z-index:10';
          document.body.append(overlay);
        })],
        ['a later page move of the target', tab => tab.evaluate(() => { document.getElementById('commit').style.marginLeft = '40px'; })],
        ['a genuine user wheel scroll', tab => tab.mouse.wheel(0, 120).then(() => tab.waitForTimeout(100))],
      ]) await t.test(`${name} after the owned scroll still refuses the press`, async () => {
        const { context, page: tab } = await fixture(browser, build, page({ spacer: 440 }));
        try {
          const result = await selectorClick(tab, between);
          assert.notEqual(result.stage, 'ready', name);
          assert.equal(await tab.evaluate(() => clicks), 0);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });

  test(`${build}: the agent's own hover may move but not change its certified target`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const hoverThenPress = async (tab, after = async () => {}) => {
        const { base } = await certify(tab);
        const point = await center(tab);
        const movement = await message(tab, 'page_monitor_dispatch', { ...base, kind: 'click', ...point, navigationCandidate: false,
          pointerPreparationOnly: true, eventTypes: MOVE });
        assert.equal(movement.ready, true);
        await tab.mouse.move(point.x, point.y);
        await tab.waitForTimeout(60);
        await after(tab);
        const press = await message(tab, 'page_monitor_dispatch', { ...base, kind: 'click', ...point, navigationCandidate: true, eventTypes: PRESS });
        return press.ready ? 'ready' : press.preparationVeto?.predicate || 'vetoed';
      };

      for (const [name, css] of [
        ['an instant hover lift', '#commit:hover { transform: translateY(-3px); }'],
        ['a hover border width', '#commit { width: auto; height: auto; border: 1px solid #333; } #commit:hover { border-width: 4px; }'],
      ]) await t.test(`${name} does not refuse the press`, async () => {
        const { context, page: tab } = await fixture(browser, build, page({ css }));
        try { assert.equal(await hoverThenPress(tab), 'ready'); }
        finally { await context.close(); }
      });

      await t.test('a hover-revealed control in the owner is not accepted silently', async () => {
        const { context, page: tab } = await fixture(browser, build, page({ css: 'main:hover .more { display: inline-block; }' }));
        try { assert.notEqual(await hoverThenPress(tab), 'ready'); }
        finally { await context.close(); }
      });

      await t.test('a page move after the hover phase still refuses the press', async () => {
        const { context, page: tab } = await fixture(browser, build, page({ css: '#commit:hover { transform: translateY(-3px); }' }));
        try {
          assert.notEqual(await hoverThenPress(tab, tab => tab.evaluate(() => { document.getElementById('commit').style.marginLeft = '40px'; })), 'ready');
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });

  test(`${build}: a pure layout move before preparation keeps the model decision`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const decide = async (tab, mutate) => {
        const snapshot = await message(tab, 'page_monitor_capture_model');
        await mutate(tab);
        await tab.waitForTimeout(260);
        const validated = await message(tab, 'page_monitor_validate_model', { snapshotToken: snapshot.snapshotToken, tool: 'click_ax', ref_id: 'ref_commit' });
        const prepared = await message(tab, 'page_monitor_prepare', { operationId: 'decision', tool: 'click_ax', ref_id: 'ref_commit',
          allowPassiveRebase: true, expectedModelSnapshot: snapshot.snapshotToken });
        return { validated, prepared };
      };
      const banner = tab => tab.evaluate(() => { document.getElementById('banner-slot').innerHTML = '<p style="height:90px">Cookie notice</p>'; });

      await t.test('a banner inserted above the target keeps and dispatches the same node', async () => {
        const { context, page: tab } = await fixture(browser, build, page());
        try {
          const before = await center(tab);
          const { validated, prepared } = await decide(tab, banner);
          assert.ok((await center(tab)).y > before.y + 50, 'The target moved down');
          assert.equal(validated.ready, true, JSON.stringify(validated));
          assert.equal(prepared.modelBindingValid, true);
          assert.equal((await message(tab, 'page_monitor_dispatch', { operationId: 'decision', kind: 'click' })).ready, true);
          await tab.evaluate(() => __wbPageMonitor.withPreparedDispatch('decision', () => document.getElementById('commit').click()));
          assert.equal(await tab.evaluate(() => clicks), 1);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of [
        ['a same-text clone replacing the target', tab => tab.evaluate(() => {
          const commit = document.getElementById('commit'); commit.replaceWith(commit.cloneNode(true));
        })],
        ['an overlay covering the target', tab => tab.evaluate(() => {
          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:white;z-index:10';
          document.body.append(overlay);
        })],
        ['a genuine user scroll', tab => tab.mouse.wheel(0, 40)],
      ]) await t.test(`${name} is refused`, async () => {
        const { context, page: tab } = await fixture(browser, build, page());
        try {
          const { validated, prepared } = await decide(tab, mutate);
          assert.equal(validated.ready, false);
          assert.equal(prepared.modelBindingValid, false);
        } finally { await context.close(); }
      });

      await t.test('a move between preparation and dispatch is still checked exactly', async () => {
        const { context, page: tab } = await fixture(browser, build, page());
        try {
          const { prepared } = await decide(tab, async () => {});
          assert.equal(prepared.modelBindingValid, true);
          await banner(tab);
          const dispatched = await message(tab, 'page_monitor_dispatch', { operationId: 'decision', kind: 'click' });
          assert.equal(dispatched.ready, false);
          assert.equal(dispatched.preparationVeto?.predicate, 'geometry_changed');
          assert.equal(await tab.evaluate(() => clicks), 0);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}
