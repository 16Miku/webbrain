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
const nested = html().replace('<div id="decoration">', `<section role="region" aria-label="Current attachment" data-record-id="owned-attachment">
<h2 id="nested-heading">Current attachment</h2><label for="caption">Caption</label><input id="caption" value="Owned caption">
</section><div id="decoration">`);
const materialChanges = [
  ['heading', page => page.evaluate(() => document.getElementById('page-heading').textContent = 'Other record settings')],
  ['record identity', page => page.evaluate(() => document.getElementById('editor-page').dataset.recordId = 'other-record')],
  ['current field', page => page.evaluate(() => document.getElementById('title').value = 'Other draft')],
  ['description', page => page.evaluate(() => document.getElementById('description').value = 'Other description')],
  ['disabled action', page => page.evaluate(() => document.getElementById('commit').disabled = true)],
  ['action name', page => page.evaluate(() => document.getElementById('commit').setAttribute('aria-label', 'Delete record'))],
  ['action text', page => page.evaluate(() => document.querySelector('#commit div').textContent = 'Other action')],
  ['action href', page => page.evaluate(() => document.getElementById('commit').setAttribute('href', '/other'))],
  ['action handler', page => page.evaluate(() => document.getElementById('commit').setAttribute('onclick', 'window.qaWrongAction=true'))],
  ['wrapper state', page => page.evaluate(() => document.getElementById('commit-carrier').setAttribute('aria-disabled', 'true'))],
  ['native target replacement', page => page.evaluate(() => { const node = document.getElementById('commit'); node.replaceWith(node.cloneNode(true)); })],
  ['landmark replacement', page => page.evaluate(() => { const node = document.getElementById('editor-page'); node.replaceWith(node.cloneNode(true)); })],
  ['nested identity', page => page.evaluate(() => document.querySelector('section').dataset.recordId = 'other-attachment')],
  ['nested heading', page => page.evaluate(() => document.getElementById('nested-heading').textContent = 'Other attachment')],
  ['nested field', page => page.evaluate(() => document.getElementById('caption').value = 'Foreign caption')],
  ['new recipient form', page => page.evaluate(() => { const form = document.createElement('form'); form.innerHTML = '<input aria-label="Recipient" value="Foreign recipient"><button>Send</button>'; document.getElementById('editor-page').append(form); })],
  ['new control', page => page.evaluate(() => { const node = document.createElement('button'); node.textContent = 'Send to other record'; document.getElementById('actions').append(node); })],
  ['intercepting overlay', page => page.evaluate(() => { const r = document.getElementById('commit').getBoundingClientRect(); const node = document.createElement('div'); node.style.cssText = `position:fixed;z-index:999;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`; document.body.append(node); })],
  ['URL identity', page => page.evaluate(() => history.replaceState(null, '', '/records/other/settings'))],
  ['viewport', page => page.setViewportSize({ width: 1050, height: 750 })],
  ['viewport changed and returned', async page => { await page.setViewportSize({ width: 1050, height: 750 }); await page.waitForTimeout(30); await page.setViewportSize({ width: 1100, height: 750 }); await page.waitForTimeout(30); }],
  ['trusted user click', page => page.locator('#human').click()],
  ['trusted input changed and returned', async page => { await page.locator('#title').fill('Human changed'); await page.locator('#title').fill('Owned draft'); }],
  ['Stop', page => page.evaluate(() => { qaRunState.active = false; return qaMessage('page_monitor_state', { active: false }); })],
  ['new run', page => page.evaluate(() => { qaRunState.runToken = 'other-owned-run'; return qaMessage('page_monitor_state', { active: true, runToken: 'other-owned-run' }); })],
];
const unsupported = [
  ['arbitrary DIV', html('div')],
  ['hidden purpose', html().replace('id="page-heading"', 'id="page-heading" style="display:none"')],
  ['missing purpose', html().replace('Current record settings', '')],
  ['ambiguous purposes', html().replace('<div id="actions">', '<h1>Other record settings</h1><div id="actions">')],
  ['ambiguous primary landmarks', html() + '<main style="position:absolute;left:750px;top:300px"><h1>Other account</h1><button>Apply</button></main>'],
  ['too many current controls', html().replace('<div id="decoration">', '<div>' + '<button>Other action</button>'.repeat(65) + '</div><div id="decoration">')],
  ['unbounded page descendants', html().replace('<div id="decoration">', '<div>' + '<span aria-hidden="true"></span>'.repeat(2100) + '</div><div id="decoration">')],
];
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  describe(`${build}: production native page action ownership`, () => {
    let browser;
    before(async () => { browser = await engine.launch({ headless: true }); });
    after(async () => { await browser.close(); });
    const withFixture = async (body, work) => {
      const { context, page } = await fixture(browser, build, body);
      try { await work(page); } finally { await context.close(); }
    };
    test('actual native target during passive outside churn', () => withFixture(html(), async page => {
      const observed = await capture(page);
      await writeFile(path.join(evidenceDirectory, `${build}-page-landmark.json`), JSON.stringify(observed, null, 2) + '\n');
      assert.equal(observed.snapshot.ready, true);
      assert.equal(observed.selectedNative, true, 'The real AX-selected ref must already resolve to the native BUTTON');
      assert.equal(observed.validation.ready, true, JSON.stringify(observed.validation));
      await page.evaluate(() => { document.getElementById('clock').textContent = '1'; });
      const result = await dispatch(page, observed);
      await writeFile(path.join(evidenceDirectory, `${build}-page-dispatch.json`), JSON.stringify(result, null, 2) + '\n');
      assert.equal(result.prepare.modelBindingValid, true);
      assert.equal(result.action.success, true, JSON.stringify(result));
      assert.equal(result.commits, 1);
    }));
    test('observed landmark scale retains 41 controls and visible primary context', () => withFixture(html().replace('<div id="decoration">',
      '<div style="display:flex;flex-wrap:wrap">' + '<button type="button">Current action</button>'.repeat(36) + '</div>'
      + '<div>' + '<h2>Current field section</h2>'.repeat(6) + '</div>'
      + '<div id="inactive-scale" style="display:none">' + '<h2>Inactive milestone</h2>'.repeat(11) + '</div>'
      + '<div>' + '<span aria-hidden="true"></span>'.repeat(1050) + '</div><div id="decoration">'), async page => {
      const metadata = await page.evaluate(() => ({ descendants: document.querySelector('main').querySelectorAll('*').length,
        controls: document.querySelector('main').querySelectorAll('button,input,textarea').length }));
      assert.ok(metadata.descendants > 1380 && metadata.descendants < 2048, JSON.stringify(metadata)); assert.equal(metadata.controls, 41);
      const observed = await capture(page); assert.equal(observed.validation.ready, true, JSON.stringify(observed.validation));
      await page.evaluate(() => document.querySelector('#inactive-scale h2').textContent = 'Inactive milestone advanced');
      const result = await dispatch(page, observed, 'recorded-scale');
      assert.equal(result.action.success, true, JSON.stringify(result)); assert.equal(result.commits, 1);
      await writeFile(path.join(evidenceDirectory, `${build}-landmark-scale.json`), JSON.stringify({ metadata, validation: observed.validation,
        prepare: result.prepare, action: result.action, commits: result.commits }, null, 2) + '\n');
    }));
    test('role MAIN with a genuine visible purpose', () => withFixture(html('div role="main"').replace('</div role="main">', '</div>'), async page => {
      const observed = await capture(page);
      assert.equal(observed.validation.ready, true);
      const result = await dispatch(page, observed, 'role-main');
      assert.equal(result.action.success, true, JSON.stringify(result)); assert.equal(result.commits, 1);
    }));
    test('current nested region fields remain part of the same page action', () => withFixture(nested, async page => {
      const observed = await capture(page); assert.equal(observed.validation.ready, true);
      const result = await dispatch(page, observed, 'nested');
      assert.equal(result.action.success, true, JSON.stringify(result)); assert.equal(result.commits, 1);
    }));
    test('focus decoration keeps exact native hit and current action', () => withFixture(html(), async page => {
      await page.evaluate(() => document.getElementById('commit').addEventListener('focus', () => {
        const node = document.createElement('qa-touch-feedback'); node.setAttribute('aria-hidden', 'true');
        node.style.cssText = 'display:block;position:absolute;pointer-events:none';
        document.getElementById('commit').append(node);
      }));
      const observed = await capture(page); assert.equal(observed.validation.ready, true);
      const result = await dispatch(page, observed, 'focus-decoration');
      assert.equal(result.action.success, true, JSON.stringify(result)); assert.equal(result.commits, 1);
      assert.equal(await page.locator('qa-touch-feedback').count(), 1);
    }));
    test('inactive pane headings can redraw while active controls stay current', () => withFixture(html().replace('<div id="decoration">', '<div id="inactive" style="display:none"><h2>Inactive milestone</h2><input value="Inactive value"></div><div id="decoration">'), async page => {
      const observed = await capture(page); assert.equal(observed.validation.ready, true);
      await page.evaluate(() => document.querySelector('#inactive h2').textContent = 'Inactive milestone advanced');
      const result = await dispatch(page, observed, 'inactive-redraw');
      assert.equal(result.action.success, true, JSON.stringify(result)); assert.equal(result.commits, 1);
    }));
    test('bounded text-free decoration redraw keeps exact native action', () => withFixture(html(), async page => {
      const observed = await capture(page); assert.equal(observed.validation.ready, true);
      await page.evaluate(() => { document.getElementById('decoration').innerHTML = '<span aria-hidden="true"></span>'.repeat(500); });
      const result = await dispatch(page, observed, 'decoration-redraw');
      assert.equal(result.action.success, true, JSON.stringify(result)); assert.equal(result.commits, 1);
    }));
    test('MAIN purpose cannot certify unobserved hidden upload slots directly', () => withFixture(html().replace('<div id="decoration">',
      '<div><input id="unknown-file-one" type="file" style="display:none"><input id="unknown-file-two" type="file" style="display:none"></div><div id="decoration">'), async page => {
      const observed = await capture(page); assert.equal(observed.validation.ready, true, 'Visible page action still binds the hidden file state');
      const fileChecks = await page.evaluate(async ({ snapshot }) => {
        const checks = [];
        for (const id of ['unknown-file-one', 'unknown-file-two']) checks.push(await qaMessage('page_monitor_validate_model', {
          tool: 'upload_file', selector: '#' + id, snapshotToken: snapshot.snapshotToken,
        }));
        return checks;
      }, observed);
      for (const check of fileChecks) assert.equal(check.ready, false, JSON.stringify(check));
      assert.equal(await page.evaluate(() => qaCommits), 0);
      await writeFile(path.join(evidenceDirectory, `${build}-unobserved-slots.json`), JSON.stringify(fileChecks, null, 2) + '\n');
    }));
    test('stale snapshot cannot acquire a current binding', () => withFixture(nested, async page => {
      const observed = await capture(page); assert.equal(observed.validation.ready, true);
      const prepare = await page.evaluate(({ snapshot, ref }) => qaMessage('page_monitor_prepare', {
        tool: 'click_ax', ref_id: ref, operationId: 'wrong-snapshot', allowPassiveRebase: true,
        expectedModelSnapshot: snapshot.snapshotToken + '-not-current',
      }), observed);
      assert.equal(prepare.modelBindingValid, false); assert.equal(await page.evaluate(() => qaCommits), 0);
    }));
    for (const [name, mutation] of [
      ['heading', () => document.getElementById('page-heading').textContent = 'Other record'],
      ['record identity', () => document.getElementById('editor-page').dataset.recordId = 'other-record'],
      ['nested field', () => document.getElementById('caption').value = 'Other caption'],
      ['nested owner', () => document.querySelector('section').setAttribute('aria-label', 'Foreign attachment')],
      ['disabled', () => document.getElementById('commit').disabled = true],
      ['action name', () => document.getElementById('commit').setAttribute('aria-label', 'Delete record')],
      ['new form', () => { const form = document.createElement('form'); form.innerHTML = '<input aria-label="Recipient" value="Foreign"><button>Send</button>'; document.getElementById('editor-page').append(form); }],
    ]) test(`final content boundary rejects focus-time ${name}`, () => withFixture(nested, async page => {
      const observed = await capture(page); assert.equal(observed.validation.ready, true);
      await page.evaluate(source => {
        const mutation = (0, eval)(`(${source})`);
        document.getElementById('commit').addEventListener('focus', mutation, { once: true });
      }, mutation.toString());
      const result = await dispatch(page, observed, 'focus-material-' + name.replaceAll(' ', '-'));
      assert.equal(result.prepare.modelBindingValid, true);
      assert.equal(result.action.success, false, JSON.stringify(result));
      assert.equal(result.action.noDispatch, true, JSON.stringify(result));
      assert.equal(result.commits, 0);
    }));
    for (const [name, body] of unsupported) test(`unsupported: ${name}`, () => withFixture(body, async page => {
      const observed = await capture(page); assert.equal(observed.selectedNative, true);
      assert.equal(observed.validation.ready, false, JSON.stringify(observed.validation));
      assert.equal(observed.validation.uncertified, true);
      assert.equal(await page.evaluate(() => qaCommits), 0);
    }));
    for (const [name, mutate] of materialChanges) test(`no physical dispatch after ${name}`, () => withFixture(nested, async page => {
      const observed = await capture(page); assert.equal(observed.validation.ready, true);
      await mutate(page);
      const result = await dispatch(page, observed, name.replaceAll(' ', '-'));
      assert.ok(result.action === null || result.action.success === false, JSON.stringify(result));
      assert.equal(result.commits, 0, JSON.stringify(result));
    }));
  });
}
