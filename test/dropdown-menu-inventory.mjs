import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const labels = ['Gönderi bağlantısını kopyala', 'Gömme kodunu al', 'Yer imlerine ekle', 'Profile sabitle', 'Sohbeti sessize al', 'Düzenle', 'Sil', 'Sil,Düzenle ve yeniden-paylaş'];
const menu = `<div id="menu" class="dropdown-animation dropdown-menu bottom"><ul class="dropdown-menu__content">${labels.map(label => `<li class="dropdown-menu__item"><button>${label}</button></li>`).join('')}</ul></div>`;
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;height:570px;overflow:hidden}.dropdown-menu{position:fixed;top:326px;left:769px;width:210px;background:white}ul{list-style:none;padding:5px;margin:0}li{margin:0;padding:0}button{display:block;width:200px;height:44px;border:0;padding:0}.hidden{display:none}</style>
<article id="owned-status">Owned QA post<button id="owned-more">Daha fazla</button></article><aside><button id="other">Other navigation</button></aside>${menu}<div id="hidden" class="dropdown-menu hidden"><button>Hidden private menu</button></div>`;

for (const [build, launcher] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: native dropdown overlay exposes its rendered offscreen actions in bounded AX inventory`, async () => {
    const browser = await launcher.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1258, height: 570 } });
      await context.addInitScript({ content: await fs.readFile(new URL(`../src/${build}/src/content/accessibility-tree.js`, import.meta.url), 'utf8') });
      await context.route('https://owned-dropdown.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      const page = await context.newPage(); await page.goto('https://owned-dropdown.invalid/menu');
      const visible = await page.evaluate(() => __generateAccessibilityTree('visible', 15, 6000));
      const deleteLine = visible.pageContent.split('\n').find(line => /button "Sil"/.test(line));
      assert.ok(deleteLine, 'The rendered native Delete option must survive a viewport-only page observation.');
      assert.match(deleteLine, /offscreen=true/);
      assert.match(visible.pageContent, /\[open overlays/);
      assert.doesNotMatch(visible.pageContent, /Hidden private menu/);
      assert.equal(visible.hasMore, undefined);
      const root = await page.evaluate(() => __wb_ax_ref(document.querySelector('#menu')));
      assert.ok(visible.pageContent.includes(`[${root}]`), 'The visible overlay root supplies an exact follow-up scope.');
      assert.ok(JSON.stringify(visible).length < 16000);
      // No actions are executed while supplying this inventory.
      assert.equal(await page.locator('#other').getAttribute('data-clicked'), null);
      for (const state of ['display:none', 'visibility:hidden', 'opacity:0', 'content-visibility:hidden']) {
        await page.locator('#menu').evaluate((element, value) => { element.style.cssText = value; }, state);
        const hidden = await page.evaluate(() => __generateAccessibilityTree('visible', 15, 6000));
        assert.doesNotMatch(hidden.pageContent, /button "Sil"|Hidden private menu/, state);
      }
    } finally { await browser.close(); }
  });

  test(`${build}: a large dropdown retains exact AX continuation rather than an apparently complete clipped menu`, async () => {
    const browser = await launcher.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1258, height: 570 } });
      await context.addInitScript({ content: await fs.readFile(new URL(`../src/${build}/src/content/accessibility-tree.js`, import.meta.url), 'utf8') });
      await context.route('https://owned-dropdown.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      const page = await context.newPage(); await page.goto('https://owned-dropdown.invalid/menu');
      await page.locator('#menu ul').evaluate(list => {
        for (let index = 0; index < 100; index++) { const li = document.createElement('li'); const button = document.createElement('button'); button.textContent = `Owned option ${index}`; li.append(button); list.append(li); }
      });
      const observed = await page.evaluate(() => __generateAccessibilityTree('visible', 15, 1000));
      assert.equal(observed.hasMore, true); assert.ok(observed.continuationArgs);
      const lines = [observed.pageContent]; let cursor = observed;
      for (let pageIndex = 0; cursor.hasMore && pageIndex < 50; pageIndex++) {
        const args = cursor.continuationArgs;
        cursor = await page.evaluate(args => __generateAccessibilityTree(args.filter, args.maxDepth, args.maxChars, args.ref_id, args.page, args.tree_revision), args);
        assert.ok(!cursor.error, cursor.error); lines.push(cursor.pageContent);
      }
      assert.equal(cursor.hasMore, false); assert.match(lines.join('\n'), /Owned option 99/);
      assert.match(lines.join('\n'), /button "Sil".*offscreen=true/);
    } finally { await browser.close(); }
  });

  test(`${build}: rooted article AX reads retain fresh rendered popup context outside their subtree`, async () => {
    const browser = await launcher.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1258, height: 570 } });
      await context.addInitScript({ content: await fs.readFile(new URL(`../src/${build}/src/content/accessibility-tree.js`, import.meta.url), 'utf8') });
      await context.route('https://owned-dropdown.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      const page = await context.newPage(); await page.goto('https://owned-dropdown.invalid/menu');
      const root = await page.evaluate(() => __wb_ax_ref(document.querySelector('#owned-status')));
      const read = args => page.evaluate(({ root, args }) => __generateAccessibilityTree('visible', 15, args?.maxChars || 6000,
        root, args?.page, args?.tree_revision), { root, args });
      let observed = await read();
      assert.match(observed.pageContent, /button "Sil".*offscreen=true/);
      assert.match(observed.pageContent, /\[open overlays/);
      assert.match(observed.pageContent, /Owned QA post/);
      assert.doesNotMatch(observed.pageContent, /Other navigation|Hidden private menu/);
      assert.ok(JSON.stringify(observed).length < 16000);
      await page.locator('#menu').evaluate(menu => menu.style.display = 'none');
      observed = await read(); assert.doesNotMatch(observed.pageContent, /button "Sil"/);
      await page.locator('#menu').evaluate(menu => { menu.style.display = ''; menu.querySelectorAll('button')[6].textContent = 'Changed menu action'; });
      observed = await read(); assert.match(observed.pageContent, /Changed menu action/); assert.doesNotMatch(observed.pageContent, /button "Sil" /);
      await page.locator('#menu ul').evaluate(list => {
        for (let index = 0; index < 100; index++) { const li = document.createElement('li'); const button = document.createElement('button'); button.textContent = `Rooted option ${index}`; li.append(button); list.append(li); }
      });
      observed = await read({ maxChars: 1000 }); assert.equal(observed.hasMore, true);
      let cursor = observed; const chunks = [observed.pageContent];
      for (let pageIndex = 0; cursor.hasMore && pageIndex < 50; pageIndex++) {
        cursor = await read(cursor.continuationArgs); assert.ok(!cursor.error, cursor.error); chunks.push(cursor.pageContent);
      }
      assert.equal(cursor.hasMore, false); assert.match(chunks.join('\n'), /Rooted option 99/);
      await page.locator('#owned-status').evaluate(article => article.replaceWith(article.cloneNode(true)));
      observed = await read(); assert.match(observed.error, /no longer connected/); assert.equal(observed.pageContent, '');
    } finally { await browser.close(); }
  });

  test(`${build}: a portaled menu names the expanded control and the record it was opened from`, async () => {
    const browser = await launcher.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1258, height: 570 } });
      await context.addInitScript({ content: await fs.readFile(new URL(`../src/${build}/src/content/accessibility-tree.js`, import.meta.url), 'utf8') });
      // Mastodon mounts a post's menu at the end of the body, in a wrapper its
      // "More" button controls (aria-controls + aria-expanded).
      const twoPosts = html.replace('<article id="owned-status">Owned QA post<button id="owned-more">Daha fazla</button></article>',
        '<article id="first-status">First QA post<button id="first-more" aria-expanded="false">Daha fazla</button></article>'
        + '<article id="owned-status">Owned QA post<button id="owned-more" aria-expanded="true" aria-controls="menu-wrapper">Daha fazla</button></article>')
        .replace(menu, `<div id="menu-wrapper">${menu}</div>`);
      await context.route('https://owned-dropdown.invalid/**', route => route.fulfill({ contentType: 'text/html', body: twoPosts }));
      const page = await context.newPage(); await page.goto('https://owned-dropdown.invalid/menu');
      const refs = await page.evaluate(() => ({ more: __wb_ax_ref(document.querySelector('#owned-more')), post: __wb_ax_ref(document.querySelector('#owned-status')) }));
      const tree = () => page.evaluate(() => __generateAccessibilityTree('visible', 15, 6000).pageContent);
      const opener = `(opened by button "Daha fazla" [${refs.more}] in article [${refs.post}])`;
      let content = await tree();
      assert.ok(content.includes(opener), content.slice(0, 400));
      assert.ok(content.indexOf(opener) < content.indexOf('button "Sil"'), 'the opener precedes the menu it opened');
      // A collapsed control, or two expanded ones for the same menu, name no opener.
      await page.locator('#owned-more').evaluate(button => button.setAttribute('aria-expanded', 'false'));
      content = await tree(); assert.doesNotMatch(content, /\(opened by/);
      await page.locator('#owned-more').evaluate(button => button.setAttribute('aria-expanded', 'true'));
      await page.locator('#first-more').evaluate(button => { button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-controls', 'menu'); });
      content = await tree(); assert.doesNotMatch(content, /\(opened by/);
    } finally { await browser.close(); }
  });
}
