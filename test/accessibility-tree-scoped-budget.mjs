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

async function withPage(engine, build, callback) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
    await context.addInitScript({ content: await fs.readFile(path.join(ROOT, 'src', build, 'src/content/accessibility-tree.js'), 'utf8') });
    await context.route(`${url}*`, route => route.fulfill({ contentType: 'text/html', body: html }));
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
