import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const ROOT = process.env.WEBBRAIN_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url));
const url = 'https://owned-scoped-budget.invalid/detail';
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;height:600px;overflow:hidden}button{height:32px}#global-menu{position:absolute;left:650px;top:0;width:250px;height:500px}
#global-menu button{display:block}#owned{position:absolute;left:20px;top:20px;width:400px}#local-menu{position:absolute;left:400px;top:500px;width:180px}
#local-menu button{display:block;width:170px;height:44px}.hidden{display:none}
</style><div id="global-menu" role="menu">${Array.from({ length: 40 }, (_, i) => `<button role="menuitem">Unrelated global action ${i}</button>`).join('')}</div>
<main id="owned"><h1>Owned profile settings</h1><button id="commit">Commit current asset</button><p>Owned staged asset preview</p></main>
<div id="local-menu" class="dropdown-menu"><button>Owned first action</button><button>Owned second action</button><button>Owned third action</button><button id="delete">Owned final action</button></div>
<div role="menu" class="hidden"><button>Hidden private action</button></div>
<script>window.qaActions=0;document.addEventListener('click',()=>qaActions++);</script>`;

async function withPage(engine, build, callback, pageHtml = html) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
    await context.addInitScript({ content: await fs.readFile(path.join(ROOT, 'src', build, 'src/content/accessibility-tree.js'), 'utf8') });
    await context.route(`${url}*`, route => route.fulfill({ contentType: 'text/html', body: pageHtml }));
    const page = await context.newPage(); await page.goto(url);
    const read = (id, maxChars = 1000, continuation = {}) => page.evaluate(({ id, maxChars, continuation }) => {
      const root = __wb_ax_ref(document.getElementById(id));
      return { root, tree: __generateAccessibilityTree('visible', 15, maxChars, root, continuation.page, continuation.tree_revision) };
    }, { id, maxChars, continuation });
    await callback(page, read);
    assert.equal(await page.evaluate(() => qaActions), 0, 'AX observations must not perform actions');
  } finally { await browser.close(); }
}

function firstRef(tree) { return tree.pageContent.match(/\[(ref_[A-Za-z0-9_-]+)\]/)?.[1]; }

const uploadStatusHtml = `<!doctype html><meta charset="utf-8"><style>
.inactive{display:none}.masked{position:absolute;opacity:0;width:1px;height:1px}
#offscreen-status{position:absolute;top:1200px}
</style><main id="upload">
<p id="idle" role="status">Ready for release assets</p>
<p id="hidden-override" role="status" hidden style="display:block">Asset ready</p>
<span id="uploading" class="inactive">Uploading your file now…</span>
<div class="inactive"><span id="duplicate">An attachment with that filename already exists.</span></div>
<p id="bad-type" role="alert" hidden>We do not support that file type.</p>
<div aria-hidden="true"><p id="empty-file" role="status">This file is empty.</p></div>
<div style="opacity:0"><p id="failed" role="alert">Unable to process the file.</p></div>
<div style="content-visibility:hidden"><span id="too-big">The file exceeds the size limit.</span></div>
<span id="inline-status">Inline status text</span>
<span id="contents-status" style="display:contents">Contents status text</span>
<span id="contents-opacity" style="display:contents;opacity:0">Visible contents text</span>
<div style="display:contents;content-visibility:hidden"><p id="contents-visibility" role="status">Visible contents status</p></div>
<div style="opacity:0"><div style="display:contents"><p id="contents-hidden" role="status">Hidden ancestor status</p></div></div>
<div style="visibility:hidden"><p id="visible-override" role="status" style="visibility:visible">Current upload details</p></div>
<p id="offscreen-status" role="status">Offscreen upload details</p>
<label><input id="custom-checkbox" type="checkbox" class="masked">Confirm asset</label>
<label><input id="custom-file" type="file" class="masked">Choose release assets</label>
<div id="shadow-status-host" style="opacity:0"></div>
</main><script>window.qaActions=0;document.addEventListener('click',()=>qaActions++);</script>`;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: all AX reads distinguish inactive upload status templates from rendered text`, () => withPage(engine, build, async page => {
    const readAll = () => page.evaluate(() => __generateAccessibilityTree('all', 15, 12000, __wb_ax_ref(document.getElementById('upload'))));
    const line = (tree, id) => {
      const result = tree.pageContent.split('\n').find(row => row.includes(`dom_id="${id}"`));
      assert.ok(result, `all must retain ${id}`);
      return result;
    };
    const tree = await readAll();
    assert.equal(tree.hasMore, undefined);
    for (const id of ['uploading', 'duplicate', 'bad-type', 'empty-file', 'failed', 'too-big', 'contents-hidden']) {
      assert.match(line(tree, id), /\bhidden=true/, `${id} must not look like a live upload status`);
    }
    for (const id of ['idle', 'hidden-override', 'inline-status', 'contents-status', 'contents-opacity', 'contents-visibility', 'visible-override', 'offscreen-status', 'custom-checkbox', 'custom-file']) {
      assert.doesNotMatch(line(tree, id), /\bhidden=true/, `${id} remains rendered or label-driven`);
    }
    await page.evaluate(() => {
      document.getElementById('uploading').classList.remove('inactive');
      document.getElementById('idle').hidden = true;
    });
    const changed = await readAll();
    assert.doesNotMatch(line(changed, 'uploading'), /\bhidden=true/);
    assert.match(line(changed, 'idle'), /\bhidden=true/);

    // Anchored reads can start inside an open shadow root. Visibility still
    // belongs to its composed ancestors, including the host.
    const shadow = await page.evaluate(() => {
      const host = document.getElementById('shadow-status-host');
      host.attachShadow({ mode: 'open' }).innerHTML = '<p role="alert">Shadow upload failed.</p>';
      const ref = __wb_ax_ref(host.shadowRoot.firstElementChild);
      const hidden = __generateAccessibilityTree('all', 5, 1000, ref).pageContent;
      host.style.opacity = '1';
      return { hidden, shown: __generateAccessibilityTree('all', 5, 1000, ref).pageContent };
    });
    assert.match(shadow.hidden, /alert "Shadow upload failed\.".*hidden=true/);
    assert.doesNotMatch(shadow.shown, /\bhidden=true/);
  }, uploadStatusHtml));

  test(`${build}: top-layer statuses escape ancestor opacity while preserving real suppression`, () => withPage(engine, build, async page => {
    const result = await page.evaluate(() => {
      const parent = document.getElementById('transparent-parent');
      const dialog = document.getElementById('modal');
      const read = () => __generateAccessibilityTree('all', 15, 12000).pageContent;
      dialog.showModal();
      const shown = read();
      const hitIds = ['modal-status', 'modal-button'].map(id => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.id;
      });
      dialog.style.opacity = '0';
      const ownOpacity = read();
      dialog.style.opacity = '';
      parent.setAttribute('aria-hidden', 'true');
      dialog.setAttribute('aria-hidden', 'false');
      const ariaHidden = read();
      parent.removeAttribute('aria-hidden');
      parent.style.display = 'none';
      const displayNone = read();
      parent.style.display = '';
      parent.style.contentVisibility = 'hidden';
      const skippedContent = read();
      parent.style.contentVisibility = '';
      dialog.close();
      dialog.show();
      const nonModal = read();
      dialog.close();
      document.getElementById('popover').showPopover();
      const popover = read();
      return { shown, hitIds, ownOpacity, ariaHidden, displayNone, skippedContent, nonModal, popover };
    });
    const line = (tree, id) => {
      const row = tree.split('\n').find(row => row.includes(`dom_id="${id}"`));
      assert.ok(row, `all must retain ${id}`);
      return row;
    };
    assert.deepEqual(result.hitIds, ['modal-status', 'modal-button'], 'the modal controls are rendered above their transparent ancestor');
    for (const id of ['modal-status', 'modal-button']) assert.doesNotMatch(line(result.shown, id), /\bhidden=true/);
    for (const id of ['ordinary-status', 'modal-hidden']) assert.match(line(result.shown, id), /\bhidden=true/);
    for (const state of ['ownOpacity', 'ariaHidden', 'displayNone', 'skippedContent', 'nonModal']) {
      assert.match(line(result[state], 'modal-status'), /\bhidden=true/, `${state} must still suppress the status`);
    }
    assert.doesNotMatch(line(result.popover, 'popover-status'), /\bhidden=true/);
    assert.match(line(result.popover, 'ordinary-status'), /\bhidden=true/);
  }, `<!doctype html><div id="transparent-parent" style="opacity:0">
<p id="ordinary-status" role="status">Ordinary hidden status</p>
<dialog id="modal"><p id="modal-status" role="status">Confirm upload</p><button id="modal-button">Continue</button><p id="modal-hidden" role="status" style="opacity:0">Inactive modal status</p></dialog>
<div id="popover" popover="manual"><p id="popover-status" role="status">Upload ready</p></div>
</div><script>window.qaActions=0;document.addEventListener('click',()=>qaActions++);</script>`));

  test(`${build}: hidden status checks share ancestor work only within the current AX read`, () => withPage(engine, build, async page => {
    const result = await page.evaluate(() => {
      const owner = document.getElementById('owner');
      let parent = owner;
      for (let depth = 0; depth < 80; depth++) parent = parent.appendChild(document.createElement('div'));
      for (let index = 0; index < 400; index++) {
        const status = parent.appendChild(document.createElement('p'));
        status.setAttribute('role', 'status');
        status.textContent = `Bulk status ${index}`;
      }
      const ownerRef = __wb_ax_ref(owner);
      const nestedRef = __wb_ax_ref(document.getElementById('nested'));
      const getStyle = window.getComputedStyle;
      let styleReads = 0, nested = false;
      window.getComputedStyle = function(element, ...args) {
        styleReads++;
        if (!nested && element === parent.firstElementChild) {
          nested = true;
          __generateAccessibilityTree('all', 5, 1000, nestedRef);
        }
        return getStyle.call(this, element, ...args);
      };
      try {
        const shown = __generateAccessibilityTree('all', 120, 150000, ownerRef);
        const shownReads = styleReads;
        owner.style.opacity = '0';
        styleReads = 0;
        const hidden = __generateAccessibilityTree('all', 120, 150000, ownerRef);
        return { shown, hidden, shownReads, hiddenReads: styleReads, elements: document.querySelectorAll('*').length, nested };
      } finally { window.getComputedStyle = getStyle; }
    });
    for (const [state, reads] of [['shown', result.shownReads], ['hidden', result.hiddenReads]]) {
      assert.equal(result[state].error, undefined);
      const statuses = result[state].pageContent.split('\n').filter(line => /status "Bulk status \d+"/.test(line));
      assert.equal(statuses.length, 400);
      assert.equal(statuses.filter(line => /\bhidden=true/.test(line)).length, state === 'hidden' ? 400 : 0);
      assert.ok(reads < result.elements * 6, `${state}: ${reads} style lookups repeated shared ancestry`);
    }
    assert.equal(result.nested, true, 'a nested scoped read must restore the outer read cache');
  }, '<!doctype html><main id="owner"></main><p id="nested" role="status">Nested status</p><script>window.qaActions=0</script>'));
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: exact target receives bounded AX budget before unrelated global overlays`, () => withPage(engine, build, async (page, read) => {
    const { root, tree } = await read('commit');
    assert.equal(firstRef(tree), root);
    assert.match(tree.pageContent.split('\n')[0], /button "Commit current asset"/);
    assert.ok(tree.chunkEnd - tree.chunkStart <= 1000, 'The node chunk stays within its budget; continuation metadata is separate');
    assert.equal(tree.hasMore, true);
    assert.equal(tree.continuationArgs.ref_id, root);
    assert.equal(tree.continuationArgs.tree_revision, tree.treeRevision);
    assert.equal(await page.evaluate(ref => __wb_ax_lookup(ref) === document.getElementById('commit'), root), true);
    assert.doesNotMatch(tree.pageContent, /Hidden private action/);
  }));

  test(`${build}: scoped owner keeps purpose and commit together before overlay context`, () => withPage(engine, build, async (_page, read) => {
    const { root, tree } = await read('owned');
    assert.equal(firstRef(tree), root);
    assert.match(tree.pageContent, /Owned profile settings/);
    assert.match(tree.pageContent, /Commit current asset/);
    assert.ok(tree.pageContent.indexOf('Owned profile settings') < tree.pageContent.indexOf('[open overlays'));
  }));

  test(`${build}: anchored dropdown retains offscreen inventory without duplicate refs`, () => withPage(engine, build, async (_page, read) => {
    const { root, tree } = await read('local-menu');
    assert.equal(firstRef(tree), root);
    assert.match(tree.pageContent, /button "Owned final action".*offscreen=true/);
    const refs = [...tree.pageContent.matchAll(/\[(ref_[A-Za-z0-9_-]+)\]/g)].map(match => match[1]);
    assert.equal(new Set(refs).size, refs.length);
  }));

  test(`${build}: anchored offscreen menu item appears once before other popup actions`, () => withPage(engine, build, async (_page, read) => {
    const { root, tree } = await read('delete');
    assert.equal(firstRef(tree), root);
    assert.match(tree.pageContent.split('\n')[0], /button "Owned final action".*offscreen=true/);
    assert.equal([...tree.pageContent.matchAll(new RegExp('\\[' + root + '\\]', 'g'))].length, 1);
  }));

  test(`${build}: scoped continuation retains every fresh popup action and rejects detached roots`, () => withPage(engine, build, async (page, read) => {
    let { root, tree } = await read('owned');
    const chunks = [tree.pageContent];
    for (let count = 0; tree.hasMore && count < 30; count++) {
      assert.equal(tree.continuationArgs.ref_id, root);
      ({ tree } = await read('owned', 1000, tree.continuationArgs));
      assert.equal(tree.error, undefined);
      assert.ok(tree.chunkEnd - tree.chunkStart <= 1000);
      chunks.push(tree.pageContent);
    }
    assert.equal(tree.hasMore, false);
    const combined = chunks.join('\n');
    assert.match(combined, /Unrelated global action 39/);
    assert.match(combined, /Owned final action.*offscreen=true/);
    assert.doesNotMatch(combined, /Hidden private action/);
    await page.locator('#owned').evaluate(node => node.replaceWith(node.cloneNode(true)));
    const stale = await page.evaluate(ref => __generateAccessibilityTree('visible', 15, 1000, ref), root);
    assert.match(stale.error, /no longer connected/);
    assert.equal(stale.pageContent, '');
  }));

  test(`${build}: ordinary page observation still prioritizes current overlays`, () => withPage(engine, build, async page => {
    const tree = await page.evaluate(() => __generateAccessibilityTree('visible', 15, 1000));
    assert.match(tree.pageContent, /^\[open overlays/);
    assert.match(tree.pageContent, /Unrelated global action 0/);
    assert.doesNotMatch(tree.pageContent, /Hidden private action/);
    assert.equal(tree.hasMore, true);
  }));
}

// A trimmed tree keeps the controls beside a text entry first, found by
// structure: a native submit, or a button sharing a form or composer with a
// visible text entry, whatever language its caption is in.
const composerHtml = `<!doctype html><meta charset="utf-8"><style>body{margin:0}section{margin:8px}</style>
<section id="chat"><div class="composer"><div contenteditable="true" role="textbox" aria-label="Mesaj"></div>
<div class="tools"><button aria-label="Gönder"><svg width="10" height="10"></svg></button></div></div></section>
<section><form><input name="q"><button type="button">搜索</button></form></section>
<section id="unrelated">${Array.from({ length: 30 }, (_, i) => `<button>Bağımsız işlem ${i}</button>`).join('')}</section>
<script>window.qaActions=0;document.addEventListener('click',()=>qaActions++);</script>`;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: composer and form buttons are priority surfaces in any language, unrelated buttons are not`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
      await context.addInitScript({ content: await fs.readFile(path.join(ROOT, 'src', build, 'src/content/accessibility-tree.js'), 'utf8') });
      await context.route(`${url}*`, route => route.fulfill({ contentType: 'text/html', body: composerHtml }));
      const page = await context.newPage(); await page.goto(url);
      const tree = await page.evaluate(() => __generateAccessibilityTree('visible', 15, 4000));
      const block = tree.pageContent.match(/\[priority action surfaces[^\n]*\]\n([\s\S]*?)\[\/priority action surfaces\]/)?.[1] || '';
      assert.match(block, /Gönder/, 'the composer send button was not kept first');
      assert.match(block, /搜索/, 'the form button was not kept first');
      assert.doesNotMatch(block, /Bağımsız işlem/, 'a button with no text entry beside it was kept first');
      assert.equal(await page.evaluate(() => qaActions), 0, 'AX observations must not perform actions');
    } finally { await browser.close(); }
  });
}
