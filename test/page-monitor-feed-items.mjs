// An item of an ARIA feed (an article with its position in the feed, as
// Mastodon and other social timelines mark each post) is the owner of the
// controls inside it. A model decision to click one of them stays certified
// while other items of the feed change, and a relative timestamp ticking over
// is not a change of context; a change of the item's own controls still is.
// A post shown on its own page, and each reply around it, is a focusable item
// the page names for assistive technology; it owns its controls the same way.
// So is an article the page names and lets take focus as one item, as X marks
// each timeline post without a feed position.
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

// Mastodon 4.4 renders a post's own page as an unnamed region holding the
// post's focusable, screen-reader-named wrapper (the post and its action bar)
// between the posts it replies to and the replies below it.
const reply = (id, name, time, { label = true, tabindex = true, link = true } = {}) => `<div class="status__wrapper focusable"
  ${tabindex ? 'tabindex="0"' : ''} ${label ? `aria-label="${name}, yanıt ${id}, 14 Eki 12:3${id}, ${name.toLowerCase()}"` : ''}>
  <div class="status" data-id="${id}">${link ? `<a id="author${id}" href="/@${name.toLowerCase()}">${name}</a>` : `<span id="author${id}">${name}</span>`}
    <span class="status__relative-time"><time id="time${id}" datetime="2026-10-14T09:3${id}:00.000Z">${time}</time></span>
    <div class="status__content"><p>yanıt ${id}</p></div>
    <div class="status__action-bar"><button type="button" aria-label="Yanıtla">R</button>
      <button type="button" aria-label="Favori" id="fav${id}">0</button><button type="button" aria-label="Daha fazla" id="more${id}">…</button></div>
  </div></div>`;
const detail = (wrapper = 'tabindex="0" aria-label="Emre, gönderi 1, 14 Eki 12:31, emre"') => `<div class="column">
  <div class="column-header__wrapper"><h1 class="column-header"><button type="button">Geri</button></h1></div>
  <div role="region"><div class="scrollable">${reply(0, 'Ali', '1 sa')}
    <div class="focusable detailed-status__wrapper" id="detail" ${wrapper}>
      <div><div class="detailed-status"><a class="detailed-status__display-name" id="author1" href="/@emre"><span>Emre</span></a>
        <div class="status__content"><p>gönderi 1</p></div>
        <div class="detailed-status__meta"><a class="detailed-status__datetime" href="/@emre/1"><time datetime="2026-10-14T09:31:00.000Z">14 Eki 2026 12:31</time></a>
          <a href="/@emre/1/favourites" id="favs1">2 beğeni</a></div></div></div>
      <div class="detailed-status__action-bar"><button type="button" aria-label="Yanıtla">R</button>
        <button type="button" aria-label="Daha fazla" id="more1">…</button></div>
    </div>${reply(2, 'Mert', '9 dk')}${reply(3, 'Can', '8 dk')}</div></div></div>`;

// An X home timeline post as X renders it: a focusable article named by
// aria-labelledby (author line, text, engagement group) inside a virtualized
// cell, with no feed role and no position in a feed.
const xPost = (n, { name = 'Illia', handle = 'illia', article = 'aria-labelledby="name{n} text{n} group{n}" tabindex="0"',
  statusHref = `/${handle}/status/211190481654505${n}`, likes = '780' } = {}) => `<div data-testid="cellInnerDiv">
  <article ${article.replaceAll('{n}', n)} role="article" data-testid="tweet"><div><div>
    <div data-testid="Tweet-User-Avatar"><a href="/${handle}" role="link" tabindex="-1"><img alt="" width="40" height="40"
      src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a></div>
    <div id="name${n}" data-testid="User-Name"><a href="/${handle}" role="link"><span id="author${n}">${name}</span></a>
      <a href="/${handle}" role="link" tabindex="-1"><span>@${handle}</span></a><span>·</span>
      <a id="time${n}" href="${statusHref}" role="link"><time datetime="2026-10-18T02:0${n}:00.000Z">17h</time></a></div>
    <button id="more${n}" aria-label="More" role="button" type="button">…</button>
    <div id="text${n}" data-testid="tweetText" lang="en"><span>Post ${n}</span></div>
    <div id="group${n}" role="group" aria-label="8 replies, ${likes} likes">
      <button aria-label="8 Replies. Reply" role="button" type="button">8</button>
      <button id="like${n}" aria-label="${likes} Likes. Like" role="button" type="button">${likes}</button>
      <button id="bookmark${n}" aria-label="Bookmark" role="button" type="button">B</button></div>
  </div></div></article></div>`;
const xTimeline = posts => `<main role="main"><section role="region" aria-labelledby="timeline-heading">
  <h1 id="timeline-heading">Your Home Timeline</h1><div aria-label="Timeline: Your Home Timeline">${posts}</div></section></main>`;

async function open(engine, build, body, targetId = 'more1') {
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
  const ref = await page.evaluate(id => window.__wb_ax_ref?.(document.getElementById(id)), targetId);
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

    test(`${build} on ${engineName}: a post on its own page owns its controls`, async () => {
      const f = await open(engine, build, detail());
      try {
        assert.equal((await f.validate()).ready, true, 'The post\'s own More control is certified');
        // A reply below it changes: its time, author and counter.
        await f.page.evaluate(() => {
          document.getElementById('time2').textContent = '10 dk'; document.getElementById('author2').textContent = 'Mehmet';
          document.getElementById('fav2').textContent = '1';
        });
        assert.equal((await f.validate()).ready, true, 'A change in a reply keeps the decision');
        // The post's own controls change.
        await f.page.evaluate(() => { document.getElementById('favs1').textContent = '3 beğeni'; });
        const counted = await f.validate();
        assert.equal(counted.ready, false);
        assert.equal(counted.reason, 'semantic_binding_changed');
      } finally { await f.browser.close(); }
    });

    test(`${build} on ${engineName}: a reply beside the post owns its own controls`, async () => {
      const f = await open(engine, build, detail(), 'more2');
      try {
        assert.equal((await f.validate()).ready, true);
        await f.page.evaluate(() => { document.getElementById('favs1').textContent = '3 beğeni'; document.getElementById('fav3').textContent = '4'; });
        assert.equal((await f.validate()).ready, true, 'The post and another reply changing keep the decision');
        // Another post takes this reply's place under the same node.
        await f.page.evaluate(() => {
          const wrapper = document.getElementById('more2').closest('.status__wrapper');
          wrapper.setAttribute('aria-label', 'Deniz, yanıt 4, 14 Eki 12:34, deniz');
        });
        const replaced = await f.validate();
        assert.equal(replaced.ready, false);
        assert.equal(replaced.reason, 'semantic_binding_changed');
      } finally { await f.browser.close(); }
    });

    test(`${build} on ${engineName}: an unnamed, unfocusable, unlinked or widget wrapper owns nothing`, async () => {
      const cases = [
        ['unnamed', detail('tabindex="0"')],
        ['unfocusable', detail('aria-label="Emre, gönderi 1, 14 Eki 12:31, emre"')],
        ['removed from the tab order', detail('tabindex="-1" aria-label="Emre, gönderi 1, 14 Eki 12:31, emre"')],
        ['a toolbar', detail('tabindex="0" role="toolbar" aria-label="Emre, gönderi 1, 14 Eki 12:31, emre"')],
        ['named by a missing element', detail('tabindex="0" aria-labelledby="missing-name"')],
      ];
      for (const [name, body] of cases) {
        const f = await open(engine, build, body);
        try {
          const result = await f.validate();
          assert.equal(result.ready, false, name);
          assert.equal(result.certificationFailure, 'owner_unresolved', name);
        } finally { await f.browser.close(); }
      }
      const unlinked = await open(engine, build, `<main><div role="region">${reply(5, 'Ece', '3 dk', { link: false })}${reply(6, 'Su', '4 dk', { link: false })}</div></main>`, 'more5');
      try {
        const result = await unlinked.validate();
        assert.equal(result.ready, false, 'An item that links nowhere');
        assert.equal(result.certificationFailure, 'owner_unresolved');
      } finally { await unlinked.browser.close(); }
    });

    test(`${build} on ${engineName}: an X post owns its controls`, async () => {
      // QA P1: "Open the third post on this timeline and bookmark it." Every
      // click on an X post was uncertified (owner_unresolved), so the
      // timeline's constant updates blocked each one.
      const timeline = xTimeline(xPost(1) + xPost(2, { name: 'Ada', handle: 'ada' }) + xPost(3, { name: 'Can', handle: 'can' }));
      for (const target of ['time1', 'bookmark1']) {
        const f = await open(engine, build, timeline, target);
        try {
          assert.equal((await f.validate()).ready, true, `${target}: the post's own control is certified`);
          // Another post of the timeline changes: not this post's context.
          await f.page.evaluate(() => {
            document.getElementById('author2').textContent = 'Mert';
            const like = document.getElementById('like2');
            like.textContent = '781'; like.setAttribute('aria-label', '781 Likes. Like');
          });
          assert.equal((await f.validate()).ready, true, `${target}: a change in another post keeps the decision`);
          // This post's own controls change.
          await f.page.evaluate(() => {
            const like = document.getElementById('like1');
            like.textContent = '781'; like.setAttribute('aria-label', '781 Likes. Like');
          });
          const counted = await f.validate();
          assert.equal(counted.ready, false, target);
          assert.equal(counted.reason, 'semantic_binding_changed', target);
        } finally { await f.browser.close(); }
      }
      // The post a status page shows is focusable outside the tab order.
      const status = await open(engine, build, xTimeline(xPost(1, { article: 'aria-labelledby="name{n} text{n} group{n}" tabindex="-1"' })
        + xPost(2, { name: 'Ada', handle: 'ada' })), 'bookmark1');
      try {
        assert.equal((await status.validate()).ready, true, 'The shown post\'s Bookmark is certified');
      } finally { await status.browser.close(); }
      // The virtualized cell is reused for another post.
      const f = await open(engine, build, timeline, 'bookmark1');
      try {
        assert.equal((await f.validate()).ready, true);
        await f.page.evaluate(() => {
          document.getElementById('author1').textContent = 'Deniz';
          document.getElementById('time1').setAttribute('href', '/deniz/status/2111904816545051999');
        });
        const reused = await f.validate();
        assert.equal(reused.ready, false);
        assert.equal(reused.reason, 'semantic_binding_changed');
      } finally { await f.browser.close(); }
    });

    test(`${build} on ${engineName}: an article that is not offered as one named, focusable, linked item owns nothing new`, async () => {
      const cases = [
        ['unfocusable', xPost(1, { article: 'aria-labelledby="name{n} text{n} group{n}"' })],
        ['with an invalid tabindex', xPost(1, { article: 'aria-labelledby="name{n} text{n} group{n}" tabindex="first"' })],
        ['unnamed', xPost(1, { article: 'tabindex="0"' })],
        ['named by a missing element', xPost(1, { article: 'aria-labelledby="name{n} missing-name" tabindex="0"' })],
        ['linking nowhere', xPost(1, { handle: 'illia', statusHref: '#' }).replaceAll('href="/illia"', 'href="#"')],
        ['holding an editor', xPost(1).replace('<div id="text1"', '<textarea aria-label="Reply"></textarea><div id="text1"')],
      ];
      for (const [name, post] of cases) {
        const f = await open(engine, build, xTimeline(post + xPost(2, { name: 'Ada', handle: 'ada' })), 'bookmark1');
        try {
          const result = await f.validate();
          assert.equal(result.ready, false, name);
          assert.equal(result.certificationFailure, 'owner_unresolved', name);
        } finally { await f.browser.close(); }
      }
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
