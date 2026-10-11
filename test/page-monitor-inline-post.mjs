import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, describe, before, after } from 'node:test';
import { chromium, firefox } from 'playwright';

// The observed X /home composer is a heading-free, form-less sibling of a
// virtualized timeline. Native post controls live below a deep editable host;
// the avatar/account link is outside the editor's immediate shared wrapper.
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;width:1100px;height:760px;font:16px sans-serif}
#primary{position:absolute;left:15px;top:20px;width:180px}
main{position:absolute;left:220px;top:20px;width:650px}
#composer{display:flex;width:620px;gap:12px;padding:10px}
#avatar{width:40px;height:40px;display:block}#avatar img{width:40px;height:40px}
#composer-body{width:560px}#editor{height:80px;width:540px;border:1px solid #888}
button{height:32px}#feed{height:350px}#human{position:absolute;left:900px;top:30px}
</style><nav id="primary" aria-label="Primary"><a href="/home">Home</a>
<a id="profile" data-testid="AppTabBar_Profile_Link" href="/ownedqa">Profile</a>
<a href="/compose/post">Post</a></nav><main><div aria-label="Home timeline">
<nav><div role="tablist"><button role="tab" aria-selected="true">For you</button><button role="tab">Following</button></div></nav>
<div id="composer"><a id="avatar" href="/ownedqa"><img alt="Owned QA account"></a>
<div id="composer-body"><div id="audience">Everyone</div>
<div id="editor" contenteditable="true" role="textbox" aria-label="Post text" data-testid="tweetTextarea_0"></div>
<button id="reply-audience" type="button">Everyone can reply</button>
<nav><div role="tablist"><button type="button" aria-label="Add photos or video">Photo</button><button type="button" aria-label="Add a GIF">GIF</button>
<button type="button" aria-label="Schedule post">Schedule</button></div></nav>
<button id="post" type="button" data-testid="tweetButtonInline" disabled>Post</button></div></div>
<section id="feed" role="region" aria-label="Timeline"><article data-post-id="unrelated"><h2>Unrelated author</h2>
<button id="feed-reply">393 Replies. Reply</button><span id="counter">1m</span></article>
${'<span aria-hidden="true"></span>'.repeat(300)}</section></div></main><button id="human">Human control</button>
<script>window.qaPosts=[];window.qaInputs=[];
document.querySelector('#editor').addEventListener('input',event=>{qaInputs.push({trusted:event.isTrusted,type:event.inputType});document.querySelector('#post').disabled=!event.target.textContent.trim();});
document.querySelector('#post').addEventListener('click',()=>qaPosts.push(document.querySelector('#editor').innerText));
</script>`;

async function fixture(browser, build, body = html, url = 'https://x.com/home') {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body }));
  await context.addInitScript(() => {
    window.qaListeners = []; window.qaFeedback = []; window.qaRun = 'inline-post-run'; window.qaActive = true;
    window.chrome = window.browser = { runtime: {
      onMessage: { addListener: listener => qaListeners.push(listener), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: qaActive, runToken: qaRun, documentToken: message.documentToken };
        if (message.action === 'page_feedback') { qaFeedback.push(message.feedback); return { accepted: true }; }
        return {};
      },
    } };
    window.qaMessage = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      for (const listener of qaListeners) {
        const result = listener({ target: 'content', action, params: { runToken: qaRun, ...params } }, {}, value => { answered = true; resolve(value); });
        if (answered || result === true) break;
      }
    });
  });
  for (const name of ['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
    await context.addInitScript({ content: await readFile(new URL(`../src/${build}/src/content/${name}`, import.meta.url), 'utf8') });
  }
  const page = await context.newPage(); await page.goto(url);
  await page.waitForFunction(() => window.__wbPageMonitor?.active && window.__wb_ax_installed);
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    let child = document.querySelector('#editor');
    for (let depth = 0; depth < 18; depth++) { const wrapper = document.createElement('div'); child.before(wrapper); wrapper.append(child); child = wrapper; }
    qaFeedback = [];
  });
  return { context, page };
}

async function capture(page) {
  return page.evaluate(async () => {
    const snapshot = await qaMessage('page_monitor_capture_model', { includeTree: true });
    return { ...snapshot, editorRef: __wb_ax_ref(document.querySelector('#editor')), postRef: __wb_ax_ref(document.querySelector('#post')) };
  });
}
async function validate(page, snapshot, target = { tool: 'set_field', ref_id: snapshot.editorRef }) {
  return page.evaluate(({ snapshot, target }) => qaMessage('page_monitor_validate_model', { snapshotToken: snapshot.snapshotToken, ...target }), { snapshot, target });
}
async function dispatch(page, snapshot, action, args) {
  return page.evaluate(async ({ snapshot, action, args }) => {
    const prepare = await qaMessage('page_monitor_prepare', { tool: action, operationId: 'owned-inline-dispatch',
      expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true, ...args });
    const result = prepare.modelBindingValid === true ? await qaMessage(action, {
      expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true, ...args,
    }) : null;
    return { prepare, result, posts: qaPosts, text: document.querySelector('#editor').innerText, enabled: !document.querySelector('#post').disabled };
  }, { snapshot, action, args });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) describe(`${build}: native inline post ownership`, () => {
  let browser;
  before(async () => { browser = await engine.launch({ headless: true }); });
  after(async () => { await browser.close(); });
  const withFixture = async (work, body = html, url) => {
    const { context, page } = await fixture(browser, build, body, url);
    try { await work(page); } finally { await context.close(); }
  };
  test('observes account identity and certifies an empty heading-free home editor under live feed churn', () => withFixture(async page => {
    await page.locator('#editor').focus();
    const snapshot = await capture(page);
    assert.equal(snapshot.ready, true); assert.equal(snapshot.focusedTargetAvailable, true, JSON.stringify(snapshot));
    assert.match(snapshot.page.pageContent, /visible identity "https:\/\/x\.com\/ownedqa"/);
    await page.evaluate(() => { document.querySelector('#counter').textContent = '2m'; document.querySelector('#feed-reply').textContent = '394 Replies. Reply'; });
    await page.waitForTimeout(180);
    for (const tool of ['set_field', 'type_ax']) assert.equal((await validate(page, snapshot, { tool, ref_id: snapshot.editorRef })).ready, true, tool);
    assert.equal((await validate(page, snapshot, { tool: 'type_text', selector: '[data-testid="tweetTextarea_0"]' })).ready, true);
    assert.equal((await validate(page, snapshot, { tool: 'type_text' })).ready, true);
    const text = 'Owned QA announcement: WebBrain is live.';
    const typed = await dispatch(page, snapshot, 'set_field', { ref_id: snapshot.editorRef, text, clear: true });
    assert.equal(typed.prepare.modelBindingValid, true); assert.equal(typed.result.success, true, JSON.stringify(typed));
    assert.equal(typed.text, text); assert.equal(typed.enabled, true); assert.deepEqual(typed.posts, [], 'Typing must never submit the post.');
    const fresh = await capture(page);
    assert.equal((await validate(page, fresh, { tool: 'click_ax', ref_id: fresh.postRef })).ready, true);
    const posted = await dispatch(page, fresh, 'click_ax', { ref_id: fresh.postRef });
    assert.equal(posted.result.success, true, JSON.stringify(posted)); assert.deepEqual(posted.posts, [text]);
  }));
  for (const [name, mutate] of [
    ['local account', () => document.querySelector('#avatar').href = '/otherqa'],
    ['navigation account', () => document.querySelector('#profile').href = '/otherqa'],
    ['avatar label', () => document.querySelector('#avatar img').alt = 'Another account'],
    ['audience', () => document.querySelector('#audience').textContent = 'Private circle'],
    ['reply audience', () => document.querySelector('#reply-audience').textContent = 'Only mentioned accounts can reply'],
    ['publisher state', () => document.querySelector('#post').disabled = false],
    ['editor replacement', () => { const node = document.querySelector('#editor'); node.replaceWith(node.cloneNode(true)); }],
    ['composer replacement', () => { const node = document.querySelector('#composer'); node.replaceWith(node.cloneNode(true)); }],
    ['new destination', () => { const p = document.createElement('p'); p.textContent = 'Replying to another user'; document.querySelector('#composer').append(p); }],
    ['new local control', () => { const p = document.createElement('button'); p.textContent = 'Send elsewhere'; document.querySelector('#composer').append(p); }],
    ['hidden account navigation', () => document.querySelector('#primary').setAttribute('aria-hidden', 'true')],
    ['inactive account navigation', () => document.querySelector('#primary').inert = true],
    ['account node replacement', () => { const node = document.querySelector('#profile'); node.replaceWith(node.cloneNode(true)); }],
    ['target overlay', () => { const r = document.querySelector('#editor').getBoundingClientRect(); const node = document.createElement('div'); node.style.cssText = `position:fixed;z-index:999;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`; document.body.append(node); }],
    ['new run', () => { qaRun = 'other-run'; }],
    ['Stop', () => { qaActive = false; }],
  ]) test(`${name} rejects the prior native certificate before input`, () => withFixture(async page => {
    const snapshot = await capture(page); assert.equal((await validate(page, snapshot)).ready, true);
    await page.evaluate(mutate); await page.waitForTimeout(180);
    if (name === 'Stop') await page.evaluate(() => { for (const listener of qaListeners) listener({ target: 'content', action: 'page_monitor_state', active: false }, {}, () => {}); });
    if (name === 'new run') await page.evaluate(async () => { for (const listener of qaListeners) listener({ target: 'content', action: 'page_monitor_state', active: true }, {}, () => {}); });
    assert.equal((await validate(page, snapshot)).ready, false);
    assert.equal((await validate(page, snapshot, { tool: 'type_text', selector: '[data-testid="tweetTextarea_0"]' })).ready, false);
    const rejected = await dispatch(page, snapshot, 'set_field', { ref_id: snapshot.editorRef, text: 'Must not be inserted' });
    assert.equal(rejected.prepare.modelBindingValid, false); assert.equal(rejected.result, null); assert.deepEqual(rejected.posts, []);
  }));
  test('trusted user input returned to the same empty draft invalidates the original decision', () => withFixture(async page => {
    const snapshot = await capture(page); assert.equal((await validate(page, snapshot)).ready, true);
    await page.locator('#editor').fill('Human draft'); await page.locator('#editor').fill('');
    assert.equal((await validate(page, snapshot)).ready, false);
    assert.deepEqual(await page.evaluate(() => qaPosts), []);
  }));
  test('focus-revealed audience requires a fresh decision before any text is inserted', () => withFixture(async page => {
    await page.evaluate(() => {
      document.querySelector('#audience').remove(); document.querySelector('#reply-audience').remove();
      document.querySelector('#editor').addEventListener('focus', () => {
        const audience = document.createElement('button'); audience.id = 'new-audience'; audience.textContent = 'Everyone can reply';
        document.querySelector('#composer-body').prepend(audience);
      }, { once: true });
    });
    const original = await capture(page); assert.equal((await validate(page, original)).ready, true);
    const first = await dispatch(page, original, 'set_field', { ref_id: original.editorRef, text: 'Owned focus-reveal draft' });
    assert.equal(first.result.success, false); assert.equal(first.text, '', JSON.stringify(first)); assert.deepEqual(first.posts, []);
    const fresh = await capture(page); assert.match(fresh.page.pageContent, /Everyone can reply/);
    assert.equal((await validate(page, fresh)).ready, true);
    const second = await dispatch(page, fresh, 'set_field', { ref_id: fresh.editorRef, text: 'Owned focus-reveal draft' });
    assert.equal(second.result.success, true, JSON.stringify(second)); assert.equal(second.text, 'Owned focus-reveal draft'); assert.deepEqual(second.posts, []);
  }));
  for (const owner of ['form', 'div role="form"', 'section', 'div role="region"']) {
    const close = owner.split(' ')[0];
    const named = html.replace('<div id="composer">', `<${owner} id="composer" aria-label="Public announcement for Owned QA account">`)
      .replace('</button></div></div>\n<section id="feed"', `</button></div></${close}>\n<section id="feed"`);
    test(`named semantic ${owner} observes its full scope and types without a page heading on any host`, () => withFixture(async page => {
      const snapshot = await capture(page);
      assert.match(snapshot.page.pageContent, /Public announcement for Owned QA account/);
      assert.equal((await validate(page, snapshot)).ready, true, JSON.stringify(snapshot));
      const typed = await dispatch(page, snapshot, 'set_field', { ref_id: snapshot.editorRef, text: 'Owned generic app draft' });
      assert.equal(typed.result.success, true, JSON.stringify(typed)); assert.equal(typed.text, 'Owned generic app draft');
      assert.deepEqual(typed.posts, []);
    }, named, 'https://generic-editor.test/write'));
    for (const [name, mutation] of [
      ['scope name', () => document.querySelector('#composer').setAttribute('aria-label', 'Other account announcement')],
      ['scope replacement', () => { const node = document.querySelector('#composer'); node.replaceWith(node.cloneNode(true)); }],
      ['new destination', () => { const node = document.createElement('p'); node.textContent = 'Destination: Another channel'; document.querySelector('#composer-body').append(node); }],
      ['toolbar control', () => document.querySelector('[aria-label="Schedule post"]').setAttribute('aria-label', 'Schedule for other account')],
    ]) test(`${owner}: ${name} invalidates the original semantic scope`, () => withFixture(async page => {
      const snapshot = await capture(page); assert.equal((await validate(page, snapshot)).ready, true);
      await page.evaluate(mutation); assert.equal((await validate(page, snapshot)).ready, false);
    }, named, 'https://generic-editor.test/write'));
    test(`${owner}: dangling associated name cannot borrow contained editor/control text`, () => withFixture(async page => {
      await page.evaluate(() => { document.querySelector('#composer').removeAttribute('aria-label'); document.querySelector('#composer').setAttribute('aria-labelledby', 'missing-scope-name'); });
      const snapshot = await capture(page); assert.equal((await validate(page, snapshot)).ready, false);
    }, named, 'https://generic-editor.test/write'));
    test(`${owner}: complete associated scope label stays bound outside a short AX name`, () => withFixture(async page => {
      await page.evaluate(() => {
        const label = document.createElement('div'); label.id = 'scope-name'; label.textContent = 'Owned QA account announcement ' + 'A'.repeat(150);
        document.body.append(label); document.querySelector('#composer').removeAttribute('aria-label'); document.querySelector('#composer').setAttribute('aria-labelledby', label.id);
      });
      const snapshot = await capture(page); assert.equal((await validate(page, snapshot)).ready, true);
      assert.match(snapshot.page.pageContent, /A{150}/, 'The complete referenced scope identity must be observed.');
      await page.evaluate(() => document.querySelector('#scope-name').textContent += ' another account');
      assert.equal((await validate(page, snapshot)).ready, false);
    }, named, 'https://generic-editor.test/write'));
  }
  for (const owner of ['div', 'div role="toolbar"']) test(`named ${owner} cannot establish its own action scope`, () => withFixture(async page => {
    await page.evaluate(() => document.querySelector('#composer').setAttribute('aria-label', 'Owned account announcement'));
    const snapshot = await capture(page); assert.equal((await validate(page, snapshot)).ready, false);
  }, html.replace('<div id="composer">', `<${owner} id="composer">`), 'https://generic-editor.test/write'));
  const headedMain = html.replace('<main><div', '<main><h1>Publish owned draft</h1><div');
  for (const [name, mutation] of [
    ['source', () => document.querySelector('#avatar img').src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['node identity', () => { const image = document.querySelector('#avatar img'); image.replaceWith(image.cloneNode()); }],
  ]) test(`heading-backed main keeps its current account image ${name} bound`, () => withFixture(async page => {
    await page.evaluate(() => document.querySelector('#avatar img').removeAttribute('alt'));
    const original = await capture(page); assert.equal((await validate(page, original)).ready, true);
    assert.match(original.page.pageContent, /visible image name-unavailable=true direct-action=false/);
    await page.evaluate(mutation); assert.equal((await validate(page, original)).ready, false);
  }, headedMain, 'https://generic-editor.test/write'));
  test('heading-backed main leaves another feed entity image outside its account proof', () => withFixture(async page => {
    await page.evaluate(() => {
      const image = document.createElement('img'); image.id = 'feed-avatar'; image.style.cssText = 'width:30px;height:30px';
      document.querySelector('#feed article').append(image);
    });
    const original = await capture(page); assert.equal((await validate(page, original)).ready, true);
    await page.evaluate(() => document.querySelector('#feed-avatar').src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.equal((await validate(page, original)).ready, true, 'Unrelated feed entity visuals cannot identify the owned composer account.');
  }, headedMain, 'https://generic-editor.test/write'));
  for (const [name, body, url] of [
    ['missing native editor marker', html.replace('data-testid="tweetTextarea_0"', '')],
    ['missing native publisher marker', html.replace('data-testid="tweetButtonInline"', '')],
    ['missing account navigation evidence', html.replace('data-testid="AppTabBar_Profile_Link"', '')],
    ['mismatched local account', html.replace('id="avatar" href="/ownedqa"', 'id="avatar" href="/otherqa"')],
    ['foreign host with copied markers', html, 'https://unrelated.test/home'],
    ['wrong route with copied markers', html, 'https://x.com/settings'],
    ['extra editable', html.replace('<div id="audience">', '<input aria-label="Other recipient"><div id="audience">')],
    ['ambiguous account', html.replace('<div id="composer-body">', '<a href="/otherqa">Other account</a><div id="composer-body">')],
    ['ambiguous account navigation', html.replace('</nav><main>', '<a data-testid="AppTabBar_Profile_Link" href="/otherqa">Other Profile</a></nav><main>')],
    ['unbounded inline context', html.replace('<div id="composer-body">', '<div>' + '<span aria-hidden="true"></span>'.repeat(260) + '</div><div id="composer-body">')],
    ['account hidden in navigation', html.replace('id="primary"', 'id="primary" aria-hidden="true"')],
  ]) test(`${name} keeps the heading-free composer uncertified`, () => withFixture(async page => {
    const snapshot = await capture(page); assert.equal(snapshot.ready, true);
    const result = await validate(page, snapshot); assert.equal(result.ready, false, JSON.stringify(result));
    assert.deepEqual(await page.evaluate(() => qaPosts), []);
  }, body, url));
});

test('Chrome and Firefox inline post ownership stays byte-identical', async () => {
  assert.equal(await readFile(new URL('../src/chrome/src/content/page-monitor.js', import.meta.url), 'utf8'),
    await readFile(new URL('../src/firefox/src/content/page-monitor.js', import.meta.url), 'utf8'));
});
