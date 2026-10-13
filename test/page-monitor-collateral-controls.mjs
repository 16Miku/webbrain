import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe, before, after } from 'node:test';
import { chromium, firefox } from 'playwright';

// This test has the same relative layout in the repository and an isolated
// candidate. Every script below is the production file from that source root.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evidenceDirectory = path.join(root, 'ci/artifacts/page-monitor-main-owner');
await mkdir(evidenceDirectory, { recursive: true });

// Generic topology grounded in the observed native Publish carrier: a custom
// outer host, display:contents wrapper, custom shape and an actual BUTTON.
// The AX-selected target is the inner native BUTTON, not the outer host.
const html = (landmark = 'main') => `<!doctype html><style>
body{margin:0;font:16px sans-serif;width:1000px;height:700px}
#editor-page{position:absolute;left:20px;top:20px;width:600px}
#page-heading{margin:0;height:35px}#actions{display:flex;gap:10px;height:45px}
button{height:36px;min-width:90px}#fields{margin-top:20px}
qa-action,qa-shape{display:contents}#clock{position:absolute;left:750px;top:500px}
</style><${landmark} id="editor-page" data-record-id="current-record">
<h1 id="page-heading">Current record settings</h1>
<div id="actions"><button id="view" type="button">View record</button>
<button id="cancel" type="button">Cancel</button>
<qa-action id="commit-carrier" tabindex="-1"><div style="display:contents"><qa-shape>
<button id="commit" type="button" aria-label="Apply settings"><div>Apply settings</div></button>
</qa-shape></div></qa-action></div>
<div id="fields"><label for="title">Record title</label><input id="title" value="Owned draft">
<label for="description">Description</label><textarea id="description">Current description</textarea></div>
<div id="decoration">${'<span aria-hidden="true"></span>'.repeat(300)}</div>
</${landmark}><aside id="clock">0</aside><button id="human" style="position:absolute;left:750px;top:550px">Human control</button>`;

async function fixture(browser, build, body = html()) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  await context.route('https://semantic-controls.test/**', route => route.fulfill({ contentType: 'text/html', body }));
  await context.addInitScript(() => {
    window.qaListeners = []; window.qaFeedback = []; window.qaCommits = 0; window.qaRunState = {active:true,runToken:'semantic-owned-run'};
    window.chrome = window.browser = { runtime: {
      onMessage: { addListener: fn => qaListeners.push(fn), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { ...qaRunState, documentToken: message.documentToken };
        if (message.action === 'page_feedback') { qaFeedback.push(message.feedback); return { accepted: true }; }
        return {};
      },
    } };
    window.qaMessage = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of qaListeners) {
        const message = action === 'page_monitor_state'
          ? { target: 'content', action, runToken: 'semantic-owned-run', ...params }
          : { target: 'content', action, params: { runToken: 'semantic-owned-run', ...params } };
        const result = listener(message, {}, respond);
        if (answered || result === true) break;
      }
    });
  });
  for (const name of ['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
    const source = path.join(root, 'src', build, 'src/content', name);
    await context.addInitScript({ content: await readFile(source, 'utf8') });
  }
  const page = await context.newPage();
  await page.goto('https://semantic-controls.test/records/current/settings');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    qaFeedback = [];
    document.getElementById('commit').addEventListener('click', () => qaCommits++);
  });
  return { context, page };
}

async function capture(page) {
  return page.evaluate(async () => {
    const snapshot = await qaMessage('page_monitor_capture_model', { includeTree: true });
    const line = snapshot.page?.pageContent?.split('\n').find(line => /button "Apply settings"/.test(line));
    const ref = line?.match(/\[(ref_[A-Za-z0-9_-]+)\]/)?.[1];
    const selectedNative = !!ref && __wb_ax_lookup(ref) === document.getElementById('commit');
    const validation = ref && await qaMessage('page_monitor_validate_model', {
      tool: 'click_ax', ref_id: ref, snapshotToken: snapshot.snapshotToken,
    });
    return { snapshot, ref, selectedNative, validation };
  });
}

async function dispatch(page, observed, suffix = 'commit') {
  return page.evaluate(async ({ snapshot, ref, suffix }) => {
    const prepare = await qaMessage('page_monitor_prepare', {
      tool: 'click_ax', ref_id: ref, operationId: `prepared-${suffix}`, allowPassiveRebase: true,
      expectedModelSnapshot: snapshot.snapshotToken,
    });
    // Mirrors the existing Agent's mandatory certified preparation gate;
    // no content call is issued when its genuine monitor acknowledgment fails.
    const action = prepare.ready === true && prepare.modelBindingValid === true
      ? await qaMessage('click_ax', { ref_id: ref, expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true }) : null;
    return { prepare, action, commits: qaCommits, feedback: qaFeedback };
  }, { ...observed, suffix });
}


// A named page action owns all current controls, including rendered collateral
// controls omitted by the bounded/in-viewport AX tree. Values stay private and
// a structural inventory never authorizes acting on an unnamed collateral ref.
const collateralFixture = (kind = 'both', extra = '') => html().replace('<div id="decoration">',
  '<div id="collateral-area" style="position:absolute;top:900px;left:20px">'
  + (kind !== 'input' ? '<button id="unnamed-button" type="button" style="min-width:36px;width:36px"></button>' : '')
  + (kind !== 'button' ? '<input id="unnamed-input" readonly value="PRIVATE-COLLATERAL-VALUE-9216">' : '')
  + extra + '</div><div id="decoration">');
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  describe(`${build}: value-free MAIN collateral inventory`, () => {
    let browser;
    before(async () => { browser = await engine.launch({ headless: true }); });
    after(async () => { await browser.close(); });
    const withCollateral = async (body, work) => {
      const { context, page } = await fixture(browser, build, body);
      try { await work(page); } finally { await context.close(); }
    };
    for (const kind of ['button', 'input', 'both']) test(`collateral: named commit with unnamed ${kind}`, () => withCollateral(collateralFixture(kind), async page => {
      const observed = await capture(page);
      assert.equal(observed.selectedNative, true);
      assert.equal(observed.validation.ready, true, JSON.stringify(observed.validation));
      const metadata = await page.evaluate(() => [...document.querySelectorAll('#collateral-area button,#collateral-area input')].map(node => ({
        tag: node.tagName, rects: node.getClientRects().length, offscreen: node.getBoundingClientRect().top > innerHeight,
        named: !!(node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('placeholder') || node.labels?.length),
      })));
      assert.ok(metadata.every(node => node.rects > 0 && node.offscreen && !node.named), JSON.stringify(metadata));
      assert.match(observed.snapshot.page.pageContent, /CURRENT VISIBLE COLLATERAL CONTROL/);
      assert.ok(!observed.snapshot.page.pageContent.includes('PRIVATE-COLLATERAL-VALUE-9216'));
      const result = await dispatch(page, observed, 'collateral-' + kind);
      assert.equal(result.action.success, true, JSON.stringify(result)); assert.equal(result.commits, 1);
      await writeFile(path.join(evidenceDirectory, `${build}-collateral-${kind}.json`), JSON.stringify({ metadata, page: observed.snapshot.page,
        validation: observed.validation, prepare: result.prepare, action: result.action, commits: result.commits }, null, 2) + '\n');
    }));
    test('collateral: already AX-observed unnamed control retains its existing certificate', () => withCollateral(collateralFixture('button').replace('top:900px', 'top:190px'), async page => {
      const observed = await capture(page); assert.equal(observed.validation.ready, true);
      const current = await page.evaluate(async ({ snapshot }) => {
        const node = document.getElementById('unnamed-button');
        const line = snapshot.page.pageContent.split('\n').find(line => [...line.matchAll(/\[(ref_[A-Za-z0-9_-]+)\]/g)].some(match => __wb_ax_lookup(match[1]) === node));
        const ref = line?.match(/\[(ref_[A-Za-z0-9_-]+)\]/)?.[1];
        return { line, validation: ref && await qaMessage('page_monitor_validate_model', { tool: 'click_ax', ref_id: ref, snapshotToken: snapshot.snapshotToken }) };
      }, observed);
      assert.ok(current.line && !current.line.includes('visible collateral'), JSON.stringify(current));
      assert.equal(current.validation.ready, true, JSON.stringify(current));
      const result = await dispatch(page, observed, 'already-observed'); assert.equal(result.action.success, true); assert.equal(result.commits, 1);
    }));
    test('collateral: inventory-only refs cannot authorize direct unnamed actions', () => withCollateral(collateralFixture(), async page => {
      const observed = await capture(page); assert.equal(observed.validation.ready, true);
      const checks = await page.evaluate(async ({ snapshot }) => {
        const rows = [];
        for (const id of ['unnamed-button', 'unnamed-input']) {
          const node = document.getElementById(id);
          const line = snapshot.page.pageContent.split('\n').find(line => [...line.matchAll(/\[(ref_[A-Za-z0-9_-]+)\]/g)].some(match => __wb_ax_lookup(match[1]) === node));
          const ref = line?.match(/\[(ref_[A-Za-z0-9_-]+)\]/)?.[1];
          const byRef = ref && await qaMessage('page_monitor_validate_model', { tool: 'click_ax', ref_id: ref, snapshotToken: snapshot.snapshotToken });
          const bySelector = await qaMessage('page_monitor_validate_model', { tool: 'click', selector: '#' + id, snapshotToken: snapshot.snapshotToken });
          const prepared = ref && await qaMessage('page_monitor_prepare', { tool: 'click_ax', ref_id: ref, operationId: 'unnamed-' + id,
            expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true });
          rows.push({ id, ref, byRef, bySelector, prepared });
        }
        return rows;
      }, observed);
      for (const row of checks) { assert.ok(row.ref, JSON.stringify(row)); assert.equal(row.byRef.ready, false, JSON.stringify(row));
        assert.equal(row.bySelector.ready, false, JSON.stringify(row)); assert.equal(row.prepared.modelBindingValid, false, JSON.stringify(row)); }
      assert.equal(await page.evaluate(() => qaCommits), 0);
    }));
    for (const [name, mutation] of [
      ['collateral value', () => document.getElementById('unnamed-input').value = 'Other private value'],
      ['collateral node replacement', () => { const node = document.getElementById('unnamed-button'); node.replaceWith(node.cloneNode(true)); }],
      ['collateral handler', () => document.getElementById('unnamed-button').setAttribute('onclick', 'window.qaWrongAction=true')],
      ['collateral type', () => document.getElementById('unnamed-input').type = 'password'],
      ['collateral disabled', () => document.getElementById('unnamed-button').disabled = true],
      ['collateral name', () => document.getElementById('unnamed-button').setAttribute('aria-label', 'Delete record')],
      ['new collateral control', () => document.getElementById('collateral-area').append(document.createElement('button'))],
    ]) test(`collateral: no physical commit after ${name}`, () => withCollateral(collateralFixture(), async page => {
      const observed = await capture(page); assert.equal(observed.validation.ready, true);
      await page.evaluate(mutation);
      const result = await dispatch(page, observed, 'changed-' + name.replaceAll(' ', '-'));
      assert.ok(result.action === null || result.action.success === false, JSON.stringify(result)); assert.equal(result.commits, 0);
    }));
    for (const [name, mutation] of [
      ['collateral value', () => document.getElementById('unnamed-input').value = 'Changed during focus'],
      ['collateral handler', () => document.getElementById('unnamed-button').setAttribute('onclick', 'window.qaWrongAction=true')],
    ]) test(`collateral: final content fence rejects focus-time ${name}`, () => withCollateral(collateralFixture(), async page => {
      const observed = await capture(page); assert.equal(observed.validation.ready, true);
      await page.evaluate(source => document.getElementById('commit').addEventListener('focus', (0, eval)(`(${source})`), { once: true }), mutation.toString());
      const result = await dispatch(page, observed, 'focus-' + name.replaceAll(' ', '-'));
      assert.equal(result.prepare.modelBindingValid, true); assert.equal(result.action.success, false, JSON.stringify(result));
      assert.equal(result.action.noDispatch, true, JSON.stringify(result)); assert.equal(result.commits, 0);
    }));
    for (const [name, extra] of [
      ['inventory budget', '<button type="button"></button>'.repeat(22)],
      ['named control observation', '<input aria-label="' + 'Named '.repeat(100) + '">'],
      ['unbounded role metadata', '<input role="' + 'x'.repeat(129) + '">'],
    ]) test(`collateral: refuse incomplete ${name}`, () => withCollateral(collateralFixture('both', extra), async page => {
      const observed = await capture(page); assert.equal(observed.selectedNative, true);
      assert.equal(observed.validation.ready, false, JSON.stringify(observed.validation));
      const result = await dispatch(page, observed, 'over-budget'); assert.equal(result.action, null); assert.equal(result.commits, 0);
    }));
  });
}
