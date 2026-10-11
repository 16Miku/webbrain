import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const diagnosticDirectory = new URL('../ci/artifacts/page-monitor-navigation/', import.meta.url);
await mkdir(diagnosticDirectory, { recursive: true });

// Owned markup represents the trace's exposed navigation and tab controls.
// Actual production AX minting/lookup and model certificates run in the page.
const html = `<!doctype html><style>
body{margin:0;font:16px sans-serif}nav{padding:20px;width:260px}button,a{display:block;margin:8px;height:32px}main{position:absolute;left:340px;top:0}aside{position:absolute;left:760px;top:0}
</style><button id="unscoped" type="button">Unscoped control</button>
<nav><button id="menu" type="button">Open account menu</button><span id="account">Owned account</span><a id="library" href="/library">Library</a>
<a id="notifications" href="/notifications" aria-label="Notifications"><span>Notifications</span><span id="badge" aria-hidden="true">1</span></a></nav>
<main><div role="tablist"><button id="posts" role="tab" aria-selected="true">Posts</button><button role="tab" aria-selected="false">Replies</button></div></main><aside id="clock">100</aside>`;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: real AX navigation targets retain exact observed meaning during unrelated passive changes`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
      await context.route('https://monitor-navigation.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      await context.addInitScript(() => {
        window.qaListeners = []; window.qaFeedback = [];
        window.chrome = window.browser = { runtime: {
          onMessage: { addListener: fn => qaListeners.push(fn), removeListener() {} },
          async sendMessage(message) {
            if (message.action === 'get_page_monitor_state') return { active: true, runToken: 'navigation-owned-run', documentToken: message.documentToken };
            if (message.action === 'page_feedback') { qaFeedback.push(message.feedback); return { accepted: true }; }
            return {};
          },
        } };
        window.qaMessage = (action, params = {}) => new Promise(resolve => {
          let answered = false;
          const respond = value => { answered = true; resolve(value); };
          for (const listener of qaListeners) {
            const message = action === 'page_monitor_state'
              ? { target: 'content', action, runToken: 'navigation-owned-run', ...params }
              : { target: 'content', action, params: { runToken: 'navigation-owned-run', ...params } };
            const result = listener(message, {}, respond);
            if (answered || result === true) break;
          }
        });
      });
      for (const file of ['accessibility-tree.js', 'page-monitor.js']) {
        await context.addInitScript({ content: await readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
      }
      const page = await context.newPage();
      await page.goto('https://monitor-navigation.test/');
      await page.waitForFunction(() => window.__wbPageMonitor?.active);
      await page.waitForTimeout(300);
      const evidence = await page.evaluate(async () => {
        const captured = await qaMessage('page_monitor_capture_model', { includeTree: true });
        const refs = [...captured.page.pageContent.matchAll(/\[(ref_[A-Za-z0-9_-]+)\]/g)].map(match => match[1]);
        const checks = {};
        for (const id of ['menu', 'library', 'posts', 'unscoped']) {
          checks[id] = await qaMessage('page_monitor_validate_model', { snapshotToken: captured.snapshotToken,
            tool: 'click_ax', ref_id: __wb_ax_ref(document.getElementById(id)) });
        }
        document.getElementById('clock').textContent = '101';
        const unchanged = await qaMessage('page_monitor_validate_model', { snapshotToken: captured.snapshotToken,
          tool: 'click_ax', ref_id: __wb_ax_ref(document.getElementById('menu')) });
        return { captured: { ready: captured.ready, targetCount: captured.targetCount },
          publicRefs: refs.length, resolvedRefs: refs.filter(ref => !!__wb_ax_lookup(ref)).length, checks, unchanged };
      });
      await writeFile(new URL(`${build}-diagnostic.json`, diagnosticDirectory), JSON.stringify(evidence, null, 2) + '\n');
      assert.equal(evidence.publicRefs > 0, true);
      assert.equal(evidence.resolvedRefs, evidence.publicRefs, 'This tests owned semantic coverage, not an absent/stale AX registry.');
      assert.equal(evidence.checks.menu.ready, true, JSON.stringify(evidence));
      assert.equal(evidence.checks.library.ready, true);
      assert.equal(evidence.checks.posts.ready, true);
      assert.equal(evidence.checks.unscoped.ready, false, 'An arbitrary outside button still has no meaningful owner certificate.');
      assert.equal(evidence.unchanged.ready, true);
      const reset = async () => { await page.reload(); await page.waitForFunction(() => window.__wbPageMonitor?.active); await page.waitForTimeout(180); };
      const capture = () => page.evaluate(() => qaMessage('page_monitor_capture_model', { includeTree: true }));
      const check = snapshotToken => page.evaluate(snapshotToken => qaMessage('page_monitor_validate_model', {
        snapshotToken, tool: 'click_ax', ref_id: __wb_ax_ref(document.getElementById('menu')),
      }), snapshotToken);
      await t.test('unrelated navigation badge can change and remount beneath its fixed authored name', async () => {
        await reset(); const snapshot = await capture();
        await page.evaluate(() => { const badge = document.getElementById('badge'); badge.textContent = '2'; badge.replaceWith(badge.cloneNode(true)); });
        assert.equal((await check(snapshot.snapshotToken)).ready, true);
      });
      await t.test('a fixed generic navigation label cannot conceal a changed rendered account name', async () => {
        await reset();
        await page.evaluate(() => { const link = document.getElementById('notifications'); link.setAttribute('aria-label', 'Account menu'); link.firstElementChild.textContent = 'Owned account'; });
        const snapshot = await capture();
        assert.equal((await check(snapshot.snapshotToken)).ready, true);
        await page.evaluate(() => { document.getElementById('notifications').firstElementChild.textContent = 'Different account'; });
        assert.equal((await check(snapshot.snapshotToken)).ready, false);
      });
      for (const mutation of ['account-text','account-node','target-name','other-authored-name','href','selected-context','owner-node','owner-account-id','hidden','overlay','target-node','new-field','ambiguous-label','stop','trusted-user','route']) {
        await t.test(`${mutation} invalidates the original navigation decision`, async () => {
          await reset();
          if (mutation === 'ambiguous-label') await page.evaluate(() => { const name = document.getElementById('account'); name.id = 'account-label'; document.getElementById('menu').setAttribute('aria-labelledby', 'account-label'); });
          const snapshot = await capture();
          assert.equal((await check(snapshot.snapshotToken)).ready, true);
          if (mutation === 'trusted-user') await page.locator('#unscoped').click();
          else if (mutation === 'stop') await page.evaluate(() => qaMessage('page_monitor_state', { active: false }));
          else await page.evaluate(mutation => {
            const nav = document.querySelector('nav'), target = document.getElementById('menu');
            if (mutation === 'account-text') document.getElementById('account').textContent = 'Different account';
            if (mutation === 'account-node') document.getElementById('account').replaceWith(document.getElementById('account').cloneNode(true));
            if (mutation === 'target-name') target.textContent = 'Delete account';
            if (mutation === 'other-authored-name') document.getElementById('notifications').setAttribute('aria-label', 'Different account');
            if (mutation === 'href') document.getElementById('library').href = '/different-account/library';
            if (mutation === 'selected-context') document.getElementById('library').setAttribute('aria-current', 'page');
            if (mutation === 'owner-node') { const replacement = nav.cloneNode(false); nav.before(replacement); replacement.append(...nav.childNodes); nav.remove(); }
            if (mutation === 'owner-account-id') nav.dataset.accountId = 'another-account';
            if (mutation === 'hidden') nav.style.visibility = 'hidden';
            if (mutation === 'target-node') target.replaceWith(target.cloneNode(true));
            if (mutation === 'new-field') { const field = document.createElement('input'); field.value = 'New draft'; nav.append(field); }
            if (mutation === 'ambiguous-label') { const label = document.getElementById('account-label'); label.after(label.cloneNode(true)); }
            if (mutation === 'overlay') { const rect = target.getBoundingClientRect(), overlay = document.createElement('div'); Object.assign(overlay.style, { position: 'fixed', left: rect.left+'px', top: rect.top+'px', width: rect.width+'px', height: rect.height+'px', background: 'white', zIndex: '999' }); document.body.append(overlay); }
            if (mutation === 'route') history.pushState({}, '', '/different-route');
          }, mutation);
          assert.equal((await check(snapshot.snapshotToken)).ready, false);
        });
      }
      await t.test('header landmark can own complete rendered navigation controls', async () => {
        await reset();
        await page.evaluate(() => { const nav = document.querySelector('nav'), header = document.createElement('header'); header.style.cssText = 'padding:20px;width:260px'; nav.before(header); header.append(...nav.childNodes); nav.remove(); });
        const snapshot = await capture(); assert.equal((await check(snapshot.snapshotToken)).ready, true);
      });
      await t.test('a button cannot certify itself by declaring a navigation role', async () => {
        await reset(); await page.evaluate(() => document.getElementById('unscoped').setAttribute('role', 'navigation'));
        const snapshot = await capture();
        const result = await page.evaluate(snapshotToken => qaMessage('page_monitor_validate_model', { snapshotToken, tool: 'click_ax', ref_id: __wb_ax_ref(document.getElementById('unscoped')) }), snapshot.snapshotToken);
        assert.equal(result.ready, false);
      });
      await context.close();
    } finally { await browser.close(); }
  });
}
