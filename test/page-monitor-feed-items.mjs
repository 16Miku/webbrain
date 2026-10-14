// An item of an ARIA feed (an article with its position in the feed, as
// Mastodon and other social timelines mark each post) is the owner of the
// controls inside it. A model decision to click one of them stays certified
// while other items of the feed change, and a relative timestamp ticking over
// is not a change of context; a change of the item's own controls still is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const post = (id, time, { feedItem = true } = {}) => `<article data-id="${id}" ${feedItem ? `aria-posinset="${id}" aria-setsize="2"` : ''} tabindex="-1">
  <div class="status__wrapper" tabindex="0" aria-label="Emre, gönderi ${id}">
    <div class="status" data-id="${id}">
      <a class="status__relative-time" href="/@emre/${id}"><time id="time${id}" datetime="2026-10-14T09:3${id}:00.000Z" title="14 Eki 2026">${time}</time></a>
      <a id="author${id}" class="status__display-name" href="/@emre"><span>Emre</span></a>
      <div class="status__content"><p>gönderi ${id}</p></div>
      <div class="status__action-bar"><button type="button" aria-label="Yanıtla">R</button>
        <button type="button" aria-label="Daha fazla" id="more${id}">…</button></div>
    </div></div></article>`;

async function open(engine, build, body) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await context.route('https://feed.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Feed</title>${body}` }));
  await context.addInitScript(() => {
    window.messageListeners = [];
    const runtime = { onMessage: { addListener: fn => messageListeners.push(fn), removeListener: () => {} },
      async sendMessage(msg) {
        if (msg.action === 'get_page_monitor_state') return { active: true, runToken: 'feed-test', documentToken: msg.documentToken };
        if (msg.action === 'page_feedback') return { accepted: true };
        return {};
      } };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.deliver = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of messageListeners) {
        const asynchronous = listener({ target: 'content', action, params: { runToken: 'feed-test', ...params } }, {}, respond);
        if (answered || asynchronous === true) break;
      }
    });
  });
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/accessibility-tree.js`, import.meta.url), 'utf8') });
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8') });
  const page = await context.newPage();
  await page.goto('https://feed.test/home');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(200);
  const message = (action, params = {}) => page.evaluate(({ action, params }) => Promise.race([deliver(action, params),
    new Promise(resolve => setTimeout(() => resolve({ ready: false, code: 'monitor_response_missing' }), 2000))]), { action, params });
  const snapshot = await message('page_monitor_capture_model', { includeTree: true });
  assert.equal(snapshot.ready, true, JSON.stringify(snapshot));
  const ref = await page.evaluate(() => window.__wb_ax_ref?.(document.getElementById('more1')));
  assert.match(String(ref), /^ref_/);
  const validate = () => message('page_monitor_validate_model', { snapshotToken: snapshot.snapshotToken, tool: 'click_ax', ref_id: ref });
  return { browser, page, validate };
}

for (const build of ['chrome', 'firefox']) {
  for (const [engineName, engine] of [['chromium', chromium], ['firefox', firefox]]) {
    test(`${build} on ${engineName}: a feed item owns its controls`, async () => {
      const f = await open(engine, build, `<main><div role="feed">${post(1, '2 dk')}${post(2, '9 dk')}</div></main>`);
      try {
        assert.equal((await f.validate()).ready, true, 'The post\'s own More control is certified');
        // Another post of the feed changes: not this post's context.
        await f.page.evaluate(() => { document.getElementById('time2').textContent = '10 dk'; document.getElementById('author2').textContent = 'Mert'; });
        assert.equal((await f.validate()).ready, true, 'A change in another post keeps the decision');
        // This post's relative time ticks over: the same moment, rendered anew.
        await f.page.evaluate(() => { document.getElementById('time1').textContent = '3 dk'; });
        assert.equal((await f.validate()).ready, true, 'A relative timestamp ticking over keeps the decision');
        // This post's own controls change: another post or another moment.
        await f.page.evaluate(() => { document.getElementById('time1').setAttribute('datetime', '2026-10-14T08:00:00.000Z'); });
        const moved = await f.validate();
        assert.equal(moved.ready, false);
        assert.equal(moved.reason, 'semantic_binding_changed');
      } finally { await f.browser.close(); }
    });

    test(`${build} on ${engineName}: the author of a feed item stays bound with it`, async () => {
      const f = await open(engine, build, `<main><div role="feed">${post(1, '2 dk')}${post(2, '9 dk')}</div></main>`);
      try {
        await f.page.evaluate(() => { document.getElementById('author1').textContent = 'Mert'; });
        const changed = await f.validate();
        assert.equal(changed.ready, false);
        assert.equal(changed.reason, 'semantic_binding_changed');
      } finally { await f.browser.close(); }
    });

    test(`${build} on ${engineName}: an article outside a feed, or without its place in one, owns nothing new`, async () => {
      for (const body of [`<main>${post(1, '2 dk')}${post(2, '9 dk')}</main>`,
        `<main><div role="feed">${post(1, '2 dk', { feedItem: false })}${post(2, '9 dk', { feedItem: false })}</div></main>`]) {
        const f = await open(engine, build, body);
        try {
          const result = await f.validate();
          assert.equal(result.ready, false);
          assert.equal(result.certificationFailure, 'owner_unresolved');
        } finally { await f.browser.close(); }
      }
    });
  }
}
