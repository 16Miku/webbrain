import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { build as bundle } from 'esbuild';
import { BidiSession } from '../firefox-companion/session.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'build/test-logs/bluesky-composer-context');
await mkdir(output, { recursive: true });
const editorBundle = (await bundle({ entryPoints: [path.join(root, 'test/fixtures/bluesky-composer-editor.mjs')],
  bundle: true, write: false, format: 'iife', globalName: 'qaEditorLibrary', platform: 'browser' })).outputFiles[0].text;
const sourceFiles = ['rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'chat-observation.js', 'page-monitor.js', 'content.js'];
const sources = new Map(await Promise.all(['chrome', 'firefox'].map(async build => [build,
  await Promise.all(sourceFiles.map(name => readFile(path.join(root, 'src', build, 'src/content', name), 'utf8')))])));
const transparentAvatar = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="42" height="42"%3E%3Crect width="42" height="42" fill="%238ac"/%3E%3C/svg%3E';

// Source-backed native topology from official Bluesky social-app commit
// 46d98dd457a197cee8502863b420222508f29fa6. Composer.web.tsx supplies the
// heading-free modal boundary. Composer.tsx supplies a current account avatar,
// composerPublishBtn; ThreadgateBtn.tsx supplies openReplyGateButton. The web
// TextInput ignores the accessibilityLabel passed by Composer; Tiptap adds
// role=textbox itself, with placeholder on a paragraph rather than an aria name.
// All saves are local fixture requests; this never loads or posts to Bluesky.
function html(shape = 'bluesky-dialog') {
  const boundary = shape === 'bluesky-dialog' ? 'div role="dialog" aria-modal="true"'
    : shape === 'named-form' ? 'form aria-label="Create owned post"'
    : shape === 'named-region' ? 'div role="region" aria-label="Create owned post"'
    : shape === 'named-section' ? 'section aria-label="Create owned post"'
    : shape === 'headed-main' ? 'main' : 'div';
  const tag = boundary.split(' ')[0];
  return `<!doctype html><style>
    body{margin:0;font:16px sans-serif;width:1200px;height:800px;background:#eee}
    #composer{position:absolute;left:230px;top:30px;width:620px;height:550px;background:white;padding:12px}
    #topbar{display:flex;justify-content:space-between;height:45px}#editor-row{display:flex;gap:12px}
    #editor-host{width:540px}.ProseMirror{height:220px;min-height:220px;white-space:pre-wrap;outline:1px solid #aaa}
    .ProseMirror p{margin:0}.ProseMirror p.is-empty:before{content:attr(data-placeholder);color:#888;pointer-events:none;float:left;height:0}
    [role="button"],button{padding:8px;min-height:28px;cursor:pointer}#feed{position:absolute;left:920px;top:0;width:260px}
    #account-navigation{position:absolute;left:10px;top:10px;width:190px}#avatar-wrapper{width:42px;height:42px;position:relative;overflow:hidden}#avatar{width:42px;height:42px;object-fit:cover}
  </style><nav id="account-navigation"><a id="profile" href="/profile/owned.bsky.social">Profile</a></nav>
  <aside id="feed"><h2>Following</h2><span id="feed-counter">12 likes</span><div id="feed-items">An unrelated feed post.</div></aside>
  <${boundary} id="composer"><div data-testid="composePostView">
  ${shape === 'headed-main' ? '<h1>Create owned post</h1>' : ''}
  <div id="topbar"><div role="button" tabindex="0" aria-label="Cancel">Cancel</div>
  <div id="publish" role="button" tabindex="0" aria-label="Publish post" aria-disabled="true" data-testid="composerPublishBtn">Post</div></div>
  <div id="editor-row"><div id="avatar-wrapper" data-testid="userAvatarImage" data-expoimage="true"><img id="avatar" src='${transparentAvatar}'></div><div id="editor-host"></div></div>
  <div id="footer"><div id="audience" role="button" tabindex="0" aria-label="Anyone can interact" data-testid="openReplyGateButton">Anyone can interact</div>
  <div role="button" tabindex="0" aria-label="Add image">Add image</div></div>
  </div></${tag}>`;
}

async function fixture(browser, build, { shape = 'bluesky-dialog', value = '', background } = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const saves = [], errors = [];
  await context.route('https://bsky.app/**', async route => {
    if (route.request().method() === 'POST') {
      assert.equal(new URL(route.request().url()).pathname, '/owned-fixture-save');
      saves.push(route.request().postDataJSON());
      await route.fulfill({ contentType: 'application/json', body: '{"saved":true}' });
    } else await route.fulfill({ contentType: 'text/html', body: html(shape) });
  });
  await context.exposeFunction('qaBackground', background || (async message => (
    message.action === 'get_page_monitor_state'
      ? { active: true, runToken: 'bluesky-owned-run', documentToken: message.documentToken }
      : message.action === 'page_feedback' ? { accepted: true } : {}
  )));
  await context.addInitScript(() => {
    window.qaListeners = []; window.qaFeedback = []; window.qaInputEvents = []; window.qaExecCommands = [];
    window.chrome = window.browser = { runtime: {
      getURL: value => value, onMessage: { addListener: listener => qaListeners.push(listener), removeListener() {} },
      sendMessage: message => { if (message.action === 'page_feedback') qaFeedback.push(message.feedback); return window.qaBackground(message); },
    } };
    window.qaMessage = (action, params = {}, original = {}) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Missing production response: ${action}`)), 5000);
      let answered = false;
      const respond = result => { answered = true; clearTimeout(timeout); resolve(result); };
      for (const listener of qaListeners) {
        const result = listener({ ...original, target: 'content', action, params: { runToken: 'bluesky-owned-run', ...params } }, {}, respond);
        if (answered || result === true) return;
      }
      clearTimeout(timeout); resolve(undefined);
    });
  });
  for (const content of sources.get(build)) await context.addInitScript({ content });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://bsky.app/');
  await page.addScriptTag({ content: editorBundle });
  await page.evaluate(value => {
    qaEditorLibrary.mountEditor(value);
    for (const type of ['beforeinput', 'input', 'paste']) document.getElementById('editor-host').addEventListener(type,
      event => qaInputEvents.push({ type, trusted: event.isTrusted, inputType: event.inputType, data: event.data }), true);
    const original = document.execCommand.bind(document);
    document.execCommand = (command, ui, value) => { qaExecCommands.push({ command, value }); return original(command, ui, value); };
    document.getElementById('publish').addEventListener('click', async event => {
      event.preventDefault();
      if (document.getElementById('publish').getAttribute('aria-disabled') === 'true') return;
      await fetch('/owned-fixture-save', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: qaSnapshotEditor().model }) });
      window.qaSaved = qaSnapshotEditor().model;
    });
  }, value);
  if (!background) await page.waitForFunction(() => __wbPageMonitor.active);
  await page.waitForTimeout(180);
  return { context, page, saves, errors };
}

async function capture(page) {
  return page.evaluate(async () => {
    const snapshot = await qaMessage('page_monitor_capture_model', { includeTree: true });
    const ref = __wb_ax_ref(document.querySelector('.ProseMirror'));
    return { snapshot, ref, originalTree: snapshot.page?.pageContent, editor: qaSnapshotEditor() };
  });
}
async function validate(page, observed) {
  return page.evaluate(({ snapshot, ref }) => qaMessage('page_monitor_validate_model', {
    tool: 'type_ax', ref_id: ref, snapshotToken: snapshot.snapshotToken, runToken: snapshot.runToken,
  }), observed);
}
async function churn(page) {
  await page.evaluate(() => {
    document.getElementById('feed-counter').textContent = '13 likes';
    document.getElementById('feed-items').append(Object.assign(document.createElement('article'), { textContent: 'A newly arrived unrelated feed post.' }));
  });
  await page.waitForTimeout(180);
}

// Exercise the production companion declarations against actual Firefox and
// EditorView. As in firefox-rich-text-readback.mjs, only the native transport is
// adapted to Playwright's trusted keyboard; preparation, per-key monitor fences,
// focus, exact semantic readback and outcome classification are production code.
async function firefoxNative(page, guard) {
  const session = new BidiSession();
  const runId = crypto.randomUUID(), commands = [];
  session.runs.set(runId, { context: 'owned-bluesky-firefox' });
  session.locate = async () => ({ context: 'owned-bluesky-firefox', node: { sharedId: 'original-prosemirror' } });
  const editor = await page.evaluateHandle(() => qaEditorView.dom);
  session.call = async (_match, declaration, args = [], resultOwnership = null) => {
    const handle = resultOwnership === 'root' ? crypto.randomUUID() : null;
    const value = await page.evaluate(({ declaration, args, handle, editor }) => {
      window.qaRemoteObjects ||= new Map();
      const value = (0, eval)(`(${declaration})`)(editor,
        ...args.map(arg => arg.handle ? qaRemoteObjects.get(arg.handle) : arg.value ?? null));
      if (handle && value !== null) { qaRemoteObjects.set(handle, value); return { qaHandle: handle }; }
      return value;
    }, { declaration, args, handle, editor });
    if (value?.qaHandle) return { result: { type: 'object', handle: value.qaHandle } };
    return { result: value && typeof value === 'object'
      ? { type: 'object', value: Object.entries(value).map(([name, item]) => [name, { type: typeof item, value: item }]) }
      : value === null ? { type: 'null' } : { value } };
  };
  const keys = new Map([['\uE009', 'Control'], ['\uE03D', 'Meta'], ['\uE003', 'Backspace'], ['\uE007', 'Enter']]);
  const held = new Set();
  session.send = async (method, params) => {
    commands.push({ method, params });
    if (method === 'script.disown') {
      await page.evaluate(handles => { for (const handle of handles) qaRemoteObjects?.delete(handle); }, params.handles);
    } else if (method === 'input.releaseActions') {
      for (const key of held) await page.keyboard.up(key);
      held.clear();
    } else if (method === 'input.performActions') {
      for (const action of params.actions[0].actions) {
        const key = keys.get(action.value);
        if (key) {
          if (action.type === 'keyDown') { await page.keyboard.down(key); held.add(key); }
          else { await page.keyboard.up(key); held.delete(key); }
        } else if (action.type === 'keyDown') {
          if (held.has('Control') || held.has('Meta')) await page.keyboard.press(action.value);
          else await page.keyboard.type(action.value);
        }
      }
    }
    return {};
  };
  return { commands, async perform(text, clear) {
    const token = crypto.randomUUID();
    await page.evaluate(token => qaEditorView.dom.setAttribute('data-webbrain-bidi', token), token);
    return session.perform(runId, 'field', { token, text, clear, pageFeedbackGuard: guard },
      async (_id, currentGuard, kind, rebindFocus) => (await page.evaluate(({ guard, kind, rebindFocus }) =>
        qaMessage('page_monitor_validate', { ...guard, kind, rebindFocus }),
      { guard: currentGuard, kind, rebindFocus })).ready === true);
  } };
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: source-backed Bluesky and generic composer owners survive passive outside churn`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const shape of ['bluesky-dialog', 'named-form', 'named-region', 'named-section', 'headed-main']) {
        await t.test(shape, async () => {
          const f = await fixture(browser, build, { shape });
          try {
            const observed = await capture(f.page);
            assert.equal(observed.snapshot.ready, true);
            assert.ok(observed.originalTree?.includes(`[${observed.ref}]`), observed.originalTree);
            assert.equal(observed.editor.editorName, null, 'Do not invent the web editor aria-label that the native app drops');
            assert.equal(observed.editor.placeholder, "What's up?");
            assert.equal((await validate(f.page, observed)).ready, true, JSON.stringify({ shape, observed }));
            await churn(f.page);
            assert.equal((await validate(f.page, observed)).ready, true, 'The original observation remains valid after unrelated feed changes');
            const preparation = await f.page.evaluate(({ snapshot, ref }) => qaMessage('page_monitor_prepare', {
              tool: 'type_ax', ref_id: ref, operationId: 'bluesky-prepared', expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true,
            }), observed);
            assert.equal(preparation.ready, true, JSON.stringify(preparation));
            assert.equal(preparation.modelBindingValid, true);
            const expected = 'One source-bound draft.\n\nTürkçe 中文 🧠';
            const result = await f.page.evaluate(({ ref, expected }) => qaMessage('type_ax', {
              ref_id: ref, text: expected, clear: true,
            }), { ref: observed.ref, expected });
            const state = await f.page.evaluate(() => qaSnapshotEditor());
            assert.equal(result.success, false, JSON.stringify({ result, state }));
            assert.equal(result.trustedTypeRequired, true, 'The managed ProseMirror document requires the trusted browser transport');
            assert.equal(result.dispatched, false);
            assert.equal(state.model, '', 'Content preflight does not mutate the managed editor ahead of trusted input');
            assert.deepEqual(await f.page.evaluate(() => qaExecCommands), []);
            const events = await f.page.evaluate(() => qaInputEvents);
            assert.deepEqual(events, []);
            assert.deepEqual(f.errors, []);
            assert.equal(f.saves.length, 0);
            await writeFile(path.join(output, `${build}-${shape}.json`), JSON.stringify({
              original: observed.snapshot, preparation, result, state,
            }, null, 2));
          } finally { await f.context.close(); }
        });
      }
      const changes = [
        ['audience', () => { const node = document.getElementById('audience'); node.setAttribute('aria-label', 'Interaction limited'); node.textContent = 'Interaction limited'; }],
        ['account avatar source', () => document.getElementById('avatar').setAttribute('src', 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E')],
        ['account avatar node', () => { const avatar = document.getElementById('avatar'); avatar.replaceWith(avatar.cloneNode(true)); }],
        ['owner node', () => { const owner = document.getElementById('composer'); owner.replaceWith(owner.cloneNode(true)); }],
        ['hidden associated account', () => { const node = document.createElement('span'); node.id = 'current-account-name'; node.style.display = 'none'; node.textContent = 'Posting as other account'; document.getElementById('composer').append(node); document.getElementById('composer').setAttribute('aria-labelledby', node.id); }],
        ['nested audience identity', () => { document.getElementById('audience').innerHTML = '<span aria-label="Only mentioned accounts">Anyone can interact</span>'; }],
        ['editor document', () => { const view = qaEditorView; view.dispatch(view.state.tr.insertText('Human changed draft')); }],
      ];
      for (const [name, change] of changes) await t.test(`original Bluesky observation vetoes ${name} drift before input`, async () => {
        const f = await fixture(browser, build);
        try {
          const observed = await capture(f.page);
          assert.equal((await validate(f.page, observed)).ready, true);
          await f.page.evaluate(change);
          await f.page.waitForTimeout(180);
          const checked = await validate(f.page, observed);
          assert.equal(checked.ready, false, JSON.stringify({ name, checked }));
          const prepared = await f.page.evaluate(({ snapshot, ref }) => qaMessage('page_monitor_prepare', {
            tool: 'type_ax', ref_id: ref, operationId: 'bluesky-veto', expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true,
          }), observed);
          assert.equal(prepared.ready && prepared.modelBindingValid, false, JSON.stringify(prepared));
          const result = await f.page.evaluate(({ snapshot, ref }) => qaMessage('type_ax', {
            ref_id: ref, text: 'Do not insert stale draft\nDo not publish', clear: true,
            expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true,
          }), observed);
          assert.equal(result.success, false, JSON.stringify(result));
          assert.ok(result.dispatched === false || result.noDispatch === true, JSON.stringify(result));
          assert.equal(await f.page.evaluate(() => qaInputEvents.length), 0);
          assert.equal(f.saves.length, 0);
          await writeFile(path.join(output, `${build}-${name.replaceAll(' ', '-')}.json`), JSON.stringify({ checked, prepared, result }, null, 2));
        } finally { await f.context.close(); }
      });
      for (const shape of ['named-form', 'named-region', 'named-section', 'headed-main']) {
        for (const [name, change] of changes.slice(0, 2)) await t.test(`${shape} vetoes ${name} drift before input`, async () => {
          const f = await fixture(browser, build, { shape });
          try {
            const observed = await capture(f.page);
            assert.equal((await validate(f.page, observed)).ready, true);
            await f.page.evaluate(change);
            await f.page.waitForTimeout(180);
            const checked = await validate(f.page, observed);
            await writeFile(path.join(output, `${build}-${shape}-${name.replaceAll(' ', '-')}.json`), JSON.stringify({ checked }, null, 2));
            assert.equal(checked.ready, false, JSON.stringify({ shape, name, checked }));
            assert.equal(await f.page.evaluate(() => qaInputEvents.length), 0);
            assert.equal(f.saves.length, 0);
          } finally { await f.context.close(); }
        });
      }
      await t.test('an arbitrary unlabelled DIV remains uncertified despite real ProseMirror markup', async () => {
        const f = await fixture(browser, build, { shape: 'unlabelled-div' });
        try { assert.equal((await validate(f.page, await capture(f.page))).ready, false); }
        finally { await f.context.close(); }
      });
    } finally { await browser.close(); }
  });
}

test('Chrome: actual Bluesky ProseMirror model receives one certified native edit and saves exact text', { timeout: 120000 }, async t => {
  const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
  const { installPageFeedback } = await import('../src/chrome/src/agent/page-feedback.js');
  const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
  const { Agent } = await import('../src/chrome/src/agent/agent.js');
  const originalAttach = cdpClient.attach, originalCommand = cdpClient.sendCommand;
  const browser = await chromium.launch({ headless: true });
  const tabId = 83, documentId = 'bluesky-owned-document';
  const previousSession = cdpClient.sessions.get(tabId);
  let f, session, host;
  const messages = [], commands = [], captures = [];
  const compatibility = new Agent({});
  class Host {
    static STATE_CHANGE_TOOLS = new Set(['type_ax', 'set_field']);
    isRunning() { return true; }
    _checkAbort() { return false; }
    _throwIfAborted() {}
    _persist() {}
    _effectiveRunMode() { return 'act'; }
    _appOwnedUserMessage(content, webbrainAppOwnedKind) { return { role: 'user', content, webbrainAppOwnedKind }; }
    _wrapUntrusted(_kind, value) { return value; }
    _finalizeToolResultOnce(_tab, _name, _args, result) { return result; }
    async executeTool(_tab, name, args, _onUpdate, context) {
      const result = await f.page.evaluate(({ name, args }) => qaMessage(name, args), { name, args });
      return compatibility._maybeFallbackFieldWithCdpImpl(tabId, name, args, result, context);
    }
  }
  installPageFeedback(Host);
  const api = { runtime: {}, tabs: {
    get: async () => ({ id: tabId, url: f.page.url() }),
    sendMessage: async (_tab, message) => {
      messages.push(message);
      const result = await f.page.evaluate(message => qaMessage(message.action, message.params || {}, message), message);
      if (message.action === 'page_monitor_capture_model') captures.push(result);
      return result;
    },
  }, webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId, url: f.page.url() }] },
  debugger: { sendCommand: (_target, method, params, callback) => {
    commands.push({ method, params });
    session.send(method, params).then(callback, error => {
      api.runtime.lastError = { message: error.message }; callback(); delete api.runtime.lastError;
    });
  } } };
  globalThis.chrome = globalThis.browser = api;
  const cases = [
    { name: 'empty replacement', previous: '', text: 'One owned Bluesky draft.', clear: true },
    { name: 'nonempty replacement', previous: 'Old draft', text: 'New draft', clear: true },
    { name: 'append', previous: 'Owned draft', text: ' appended once', clear: false },
    { name: 'multiline', previous: '', text: 'First\n\nSecond\nThird', clear: true },
    { name: 'multiline append', previous: 'Existing\nlast', text: '\n\nAnother\n', clear: false },
    { name: 'leading and trailing line breaks', previous: '', text: '\nFirst\n\n', clear: true },
    { name: 'CRLF document separators', previous: 'Old', text: 'First\r\n\r\nLast\r\n', clear: true },
    { name: 'empty clear', previous: 'Old\n\ndraft', text: '', clear: true },
    { name: 'already empty clear', previous: '', text: '', clear: true },
    { name: 'literal markup and Unicode', previous: '', text: '<b>literal</b> & Türkçe 中文 العربية 🧠 e\u0301', clear: true },
    { name: 'exact whitespace', previous: 'Old', text: '  spaces   and\ttab\u00a0nonbreaking  ', clear: true },
    ...['named-form', 'named-region', 'named-section', 'headed-main'].map(shape => ({
      name: `${shape} exact native edit`, shape, previous: 'Original\nlast', text: '\n\nGeneric owner 🧠', clear: false,
    })),
  ];
  try {
    for (const item of cases) await t.test(item.name, async () => {
      host = new Host(); captures.length = 0; commands.length = 0; messages.length = 0;
      f = await fixture(browser, 'chrome', { value: item.previous, shape: item.shape, background: async message => {
        const sender = { tab: { id: tabId }, frameId: 0, documentId, url: f?.page.url() || 'https://bsky.app/' };
        if (message.action === 'get_page_monitor_state') return host.pageMonitorState(sender, message.documentToken);
        if (message.action === 'page_feedback') return host.observePageFeedback(sender, message.feedback);
        return {};
      } });
      try {
        session = await f.page.context().newCDPSession(f.page);
        cdpClient.attach = async () => cdpClient.sessions.set(tabId, {});
        cdpClient.sendCommand = originalCommand;
        await host._beginPageFeedbackRun(tabId, 'bluesky-context');
        await f.page.waitForFunction(() => __wbPageMonitor.active);
        await f.page.waitForTimeout(180);
        await host._capturePageFeedbackModelState(tabId, []);
        assert.equal(captures.length, 1);
        const snapshot = captures[0];
        const ref = await f.page.evaluate(() => __wb_ax_ref(document.querySelector('.ProseMirror')));
        assert.ok(snapshot.page.pageContent.includes(`[${ref}]`), snapshot.page.pageContent);
        await churn(f.page);
        assert.equal((await validate(f.page, { snapshot, ref })).ready, true);
        const result = await host.executeTool(tabId, 'type_ax', { ref_id: ref, text: item.text, clear: item.clear });
        const expected = (item.clear ? '' : item.previous) + item.text.replace(/\r\n?/g, '\n');
        const state = await f.page.evaluate(() => qaSnapshotEditor());
        assert.equal(result.success, true, JSON.stringify({ result, state }));
        assert.equal(result.verified, true);
        assert.equal(state.model, expected, 'Read the real application EditorState independently of extension readback');
        assert.equal(captures.length, 1, 'Native dispatch uses the original pre-churn observation, not a fresh baseline');
        assert.deepEqual(await f.page.evaluate(() => qaExecCommands), [], 'Managed editor never reaches generic execCommand or HTML insertion');
        assert.deepEqual(f.errors, []);
        assert.ok(commands.filter(command => command.method === 'Input.insertText').length <= 1, 'Never duplicate the requested native insertion');
        if (expected.trim()) {
          await f.page.locator('#publish').click();
          await f.page.waitForFunction(expected => window.qaSaved === expected, expected);
          assert.equal(f.saves.length, 1);
          assert.equal(f.saves[0].value, expected, 'Saved application request agrees with the original requested exact text');
        } else {
          assert.equal(await f.page.locator('#publish').getAttribute('aria-disabled'), 'true');
          assert.equal(f.saves.length, 0, 'The app prevents publishing an empty draft');
        }
        await writeFile(path.join(output, `chrome-native-${item.name.replaceAll(' ', '-')}.json`), JSON.stringify({ result, state, save: f.saves[0] }, null, 2));
      } finally { await f.context.close(); }
    });
  } finally {
    await browser.close();
    cdpClient.attach = originalAttach; cdpClient.sendCommand = originalCommand;
    if (previousSession) cdpClient.sessions.set(tabId, previousSession); else cdpClient.sessions.delete(tabId);
    if (previousChrome === undefined) delete globalThis.chrome; else globalThis.chrome = previousChrome;
    if (previousBrowser === undefined) delete globalThis.browser; else globalThis.browser = previousBrowser;
  }
});

test('Firefox: production BiDi input preserves the real Bluesky ProseMirror document and original owner', { timeout: 120000 }, async t => {
  const browser = await firefox.launch({ headless: true });
  const cases = [
    { name: 'empty replacement', previous: '', text: 'One owned draft 🧠', clear: true },
    { name: 'nonempty replacement', previous: 'Old draft', text: 'New draft', clear: true },
    { name: 'append', previous: 'Original\nlast', text: ' appended once', clear: false },
    { name: 'multiline replacement', previous: 'Old\n\ndraft', text: '\nFirst\n\nLast\n', clear: true },
    { name: 'multiline append', previous: 'Original\nlast', text: '\n\nAnother\n', clear: false },
    { name: 'CRLF document separators', previous: 'Old', text: 'First\r\n\r\nLast\r\n', clear: true },
    { name: 'empty clear', previous: 'Old\n\ndraft', text: '', clear: true },
    { name: 'already empty clear', previous: '', text: '', clear: true },
    { name: 'literal markup and Unicode', previous: '', text: '<b>literal</b> & Türkçe 中文 🧠 e\u0301', clear: true },
    { name: 'exact whitespace', previous: 'Old', text: '  spaces   and\ttab\u00a0nonbreaking  ', clear: true },
    ...['named-form', 'named-region', 'named-section', 'headed-main'].map(shape => ({
      name: `${shape} exact native edit`, shape, previous: 'Original\nlast', text: '\nGeneric owner', clear: false,
    })),
  ];
  try {
    for (const item of cases) await t.test(item.name, async () => {
      const f = await fixture(browser, 'firefox', { value: item.previous, shape: item.shape });
      try {
        const observed = await capture(f.page);
        assert.equal((await validate(f.page, observed)).ready, true);
        await churn(f.page);
        assert.equal((await validate(f.page, observed)).ready, true);
        const fence = await f.page.evaluate(async ({ snapshot, ref, text, clear }) => {
          const preparation = await qaMessage('page_monitor_prepare', { tool: 'type_ax', ref_id: ref, operationId: 'bluesky-bidi-input',
            expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true });
          const target = await qaMessage('type_ax', { ref_id: ref, text, clear, _bidiPrepare: crypto.randomUUID(),
            expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true });
          const dispatch = await qaMessage('page_monitor_dispatch', { operationId: 'bluesky-bidi-input', kind: 'input', fenceOnly: true });
          return { preparation, target, dispatch };
        }, { ...observed, text: item.text, clear: item.clear });
        assert.equal(fence.preparation.modelBindingValid, true, JSON.stringify(fence));
        assert.equal(fence.target.bidiPrepared, true, JSON.stringify(fence));
        assert.equal(fence.dispatch.ready, true, JSON.stringify(fence));
        const native = await firefoxNative(f.page, fence.dispatch.guard);
        let result;
        try { result = await native.perform(item.text, item.clear); }
        catch (error) {
          const evidence = await f.page.evaluate(guard => ({ model: qaSnapshotEditor(), feedback: qaFeedback,
            publishDisabled: document.getElementById('publish').getAttribute('aria-disabled'),
          }), fence.dispatch.guard);
          evidence.validation = await f.page.evaluate(guard => qaMessage('page_monitor_validate', { ...guard, kind: 'input' }), fence.dispatch.guard);
          evidence.veto = await f.page.evaluate(guard => qaMessage('page_monitor_dispatch', { ...guard, kind: 'input', fenceOnly: true }), fence.dispatch.guard);
          await writeFile(path.join(output, `firefox-native-${item.name.replaceAll(' ', '-')}-failure.json`),
            JSON.stringify({ error: error.message, dispatchState: error.dispatchState, evidence }, null, 2));
          throw error;
        }
        const state = await f.page.evaluate(() => qaSnapshotEditor());
        const expected = (item.clear ? '' : item.previous) + item.text.replace(/\r\n?/g, '\n');
        assert.equal(result.success, true, JSON.stringify({ result, state }));
        assert.equal(result.verified, true);
        assert.equal(state.model, expected, 'Read the real PM document independently of companion readback');
        assert.deepEqual(f.errors, []);
        const commands = await f.page.evaluate(() => qaExecCommands);
        assert.ok(commands.every(command => command.command === 'insertText' && command.value === '\n'),
          'The companion uses editing commands only for literal line breaks, never generic HTML or document replacement');
        assert.equal(native.commands.some(command => command.params?.actions?.[0]?.actions.some(action => action.value === '\uE007')), false,
          'An authored line break never sends the publish Enter shortcut');
        if (expected.trim()) {
          await f.page.locator('#publish').click();
          await f.page.waitForFunction(expected => window.qaSaved === expected, expected);
          assert.equal(f.saves.length, 1);
          assert.equal(f.saves[0].value, expected);
        } else {
          assert.equal(await f.page.locator('#publish').getAttribute('aria-disabled'), 'true');
          assert.equal(f.saves.length, 0, 'The app prevents publishing an empty draft');
        }
        await writeFile(path.join(output, `firefox-native-${item.name.replaceAll(' ', '-')}.json`),
          JSON.stringify({ original: observed.snapshot, result, state, save: f.saves[0] }, null, 2));
      } finally { await f.context.close(); }
    });
  } finally { await browser.close(); }
});
