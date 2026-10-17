import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { CDPClient, cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import { Agent } from '../src/chrome/src/agent/agent.js';
import { installPageFeedback } from '../src/chrome/src/agent/page-feedback.js';

// Trace 61282dbf (WebBrain 40.7.1, x.com/compose/post): type_ax reached the
// trusted editor fallback, WebBrain's own focus click made X draw its
// bold/italic bubble in a body-level layer while the timeline behind the
// composer kept updating, and the reselect before typing was refused as
// intervention_changed. The model then tried the selector
// [data-testid="tweetTextarea_0"], which X uses for the composer AND the
// hidden timeline composer behind it; every such decision was discarded and
// the run ended with "the page kept changing".
const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/src/${file}`, import.meta.url), 'utf8');
const POST = 'Owned QA support is coming soon https://example.com/qa/pull/3195';

const xHtml = `<!doctype html><meta charset="utf-8"><title>Compose post</title><style>
body{margin:0;font:15px system-ui;color:#0f1419}
#timeline{padding:12px;width:600px}
#timeline .inline{border:1px solid #ccc;padding:8px;margin:8px 0}
#timeline [contenteditable]{min-height:40px}
#feed article{height:40px;border-bottom:1px solid #eee}
#layers{position:fixed;inset:0;display:flex;justify-content:center;align-items:flex-start}
#backdrop{position:absolute;inset:0;background:rgba(0,0,0,.4)}
#compose{position:relative;margin-top:40px;width:600px;background:#fff;border-radius:16px;padding:12px}
#compose button{margin:4px}
#editor{min-height:96px;width:516px;outline:none;margin:8px 40px}
#format-bubble{position:fixed;z-index:30;box-sizing:border-box;width:72px;height:34px;display:flex;gap:4px;background:#111;border-radius:8px;padding:2px}
</style>
<main id="timeline" aria-hidden="true">
  <button id="new-posts" type="button">New posts are available</button>
  <div class="inline"><div contenteditable="true" role="textbox" aria-label="Post text" aria-multiline="true" data-testid="tweetTextarea_0"><div><br></div></div>
    <button type="button" data-testid="tweetButtonInline" disabled>Post</button></div>
  <div id="feed"></div>
</main>
<div id="layers">
  <div id="backdrop"></div>
  <div id="compose" role="dialog" aria-modal="true">
    <div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div>
    <button type="button" aria-label="Close">x</button>
    <button type="button">Drafts</button>
    <button type="button" aria-label="Choose audience">Everyone</button>
    <div id="editor" contenteditable="true" role="textbox" aria-label="Post text" aria-multiline="true" data-testid="tweetTextarea_0"><div><br></div></div>
    <button id="reply-scope" type="button">Everyone can reply</button>
    <nav aria-label="Composer tools"><div role="tablist">
      <button type="button" aria-label="Add photos or video">Media</button><button type="button" aria-label="Add emoji">Emoji</button>
    </div></nav>
    <button id="post" type="button" data-testid="tweetButton" disabled>Post</button>
  </div>
</div>
<script>
  window.timelineTicks = 0;
  window.startTimeline = () => { window.timeline = setInterval(() => {
    const tick = ++window.timelineTicks;
    document.getElementById('new-posts').textContent = 'New posts are available (' + tick + ')';
    const feed = document.getElementById('feed'), item = document.createElement('article');
    item.textContent = 'Live post ' + tick; feed.prepend(item);
    if (feed.children.length > 4) feed.lastElementChild.remove();
  }, 40); };
  const editor = document.getElementById('editor');
  window.bubbleShown = 0;
  // A real click in X's editor draws its bold/italic bubble in a body-level
  // layer on a later frame (React schedules it after the click's own task),
  // over the point that was clicked: in the trace's screenshot it sits in the
  // middle of the empty editor, where WebBrain had clicked.
  editor.addEventListener('pointerup', event => {
    if (!event.isTrusted) return;
    const x = event.clientX, y = event.clientY;
    requestAnimationFrame(() => setTimeout(() => {
      window.bubbleShown++;
      let bubble = document.getElementById('format-bubble');
      if (!bubble) {
        bubble = document.createElement('div'); bubble.id = 'format-bubble';
        bubble.innerHTML = '<button type="button" aria-label="Bold">B</button><button type="button" aria-label="Italic">I</button>';
        bubble.addEventListener('pointerdown', () => { window.bubblePressed = (window.bubblePressed || 0) + 1; });
        document.body.append(bubble);
      }
      bubble.style.left = (x - 36) + 'px'; bubble.style.top = (y - 17) + 'px';
    }, 0));
  });
  editor.addEventListener('input', () => { document.getElementById('post').disabled = !editor.innerText.trim(); });
</script>`;

async function fixture(engine, build, { runToken = 'test-run' } = {}) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1126, height: 745 } });
  await context.route('https://monitor.test/**', route => route.fulfill({ contentType: 'text/html', body: xHtml }));
  await context.addInitScript(token => { window.monitorRunToken = token; }, runToken);
  await context.addInitScript(() => {
    window.monitorEnabled = true;
    window.feedback = [];
    window.messageListeners = [];
    const runtime = { onMessage: {
      addListener: fn => messageListeners.push(fn),
      removeListener: fn => { messageListeners = messageListeners.filter(item => item !== fn); },
    }, async sendMessage(msg) {
      if (msg.action === 'get_page_monitor_state') return { active: monitorEnabled, runToken: monitorRunToken, documentToken: msg.documentToken };
      if (msg.action === 'page_feedback') { feedback.push(msg.feedback); return { accepted: true }; }
      return {};
    } };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.deliver = (action, params = {}) => messageListeners.forEach(fn => fn({ target: 'content', action,
      params: { runToken: monitorRunToken, ...params }, active: action === 'page_monitor_state' ? monitorEnabled : undefined,
      runToken: monitorRunToken }, {}, value => { window.lastMonitorResponse = value; }));
  });
  await context.addInitScript({ content: read(build, 'content/page-monitor-shadow.js') });
  await context.addInitScript({ content: read(build, 'content/page-monitor.js') });
  const page = await context.newPage();
  await page.goto('https://monitor.test/compose/post');
  await page.waitForTimeout(200);
  await page.evaluate(() => { feedback = []; });
  return { browser, context, page };
}

// One composer on a live page: the page monitor, the agent's page feedback,
// its trusted-typing fallback and the CDP input attribution are production
// code. Only the content-script message transport is a direct page call.
async function composeHost(page, tab, host) {
  const documentToken = await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0]);
  host.pageMonitorState({ tab: { id: tab }, frameId: 0 }, documentToken);
  await page.exposeFunction('feedbackToHost', feedback => host.observePageFeedback({ tab: { id: tab }, frameId: 0 }, feedback));
  await page.exposeFunction('monitorStateFromHost', token => host.pageMonitorState({ tab: { id: tab }, frameId: 0 }, token));
  await page.addScriptTag({ content: read('chrome', 'content/rich-text-toolbar-heuristic.js') });
  await page.addScriptTag({ content: read('chrome', 'content/accessibility-tree.js') });
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async message => {
      if (message.action === 'get_page_monitor_state') return await monitorStateFromHost(message.documentToken);
      const response = await original(message);
      return message.action === 'page_feedback' ? await feedbackToHost(message.feedback) : response;
    };
    window._fieldMeta = el => ({ tag: 'div', contentEditable: true, ariaLabel: el.getAttribute('aria-label') });
    window._editableTextValue = el => el.innerText.replace(/\n$/, '');
    window.readProseMirrorText = () => null;
    window.isDraftJsEditor = () => false;
    window.readDraftJsText = () => null;
    window.readCodeMirrorText = () => null;
    window.readEmptyCaretText = () => null;
    window._stableFieldSelector = el => '#' + el.id;
    window._setFieldValueMatches = (actual, prefix, text, clear) => actual === (clear ? '' : prefix) + text;
  });
  const source = read('chrome', 'content/content.js');
  const entries = ['ax_prepare_field_for_trusted_type', 'ax_verify_field_value', 'field_value_digest'].map(action => {
    const start = source.indexOf(`'${action}': ${action === 'field_value_digest' ? 'async ' : ''}() => {`), end = source.indexOf('\n      },', start);
    assert.ok(start > 0 && end > start); return source.slice(start, end + 8);
  });
  const typingPreparation = source.match(/^  function _withTypingPreparation\([\s\S]*?^  }/m)?.[0];
  assert.ok(typingPreparation);
  await page.addScriptTag({ content: `${typingPreparation}\nwindow.axHelpers = { ${entries.join(',\n')} };` });
}

function fieldHostClass() {
  class FieldHost {
    static STATE_CHANGE_TOOLS = new Set(['set_field', 'type_ax', 'type_text']);
    isRunning() { return true; }
    _checkAbort() { return false; }
    _throwIfAborted() {}
    _persist() {}
    async _textMutationValueDigest(...args) { return Agent.prototype._textMutationValueDigest.call(this, ...args); }
    _appOwnedUserMessage(content) { return { role: 'user', content }; }
    async executeTool(tabId, name, args, _update, executionContext) {
      // The content-script editor write proves trusted typing is required
      // without dispatching anything, as on X's composer.
      executionContext._contentActionDispatchState.started = true;
      const result = await Agent.prototype._maybeFallbackFieldWithCdpImpl.call(this, tabId, name, args,
        { success: false, verified: false, dispatched: false, noDispatch: true, _expectedValue: args.text,
          error: 'Contenteditable fields require trusted browser typing', trustedTypeRequired: true });
      return result.textUnchanged === true
        ? Agent.prototype._finalizeTextMutationResult.call(this, tabId, name, args, result)
        : result;
    }
  }
  installPageFeedback(FieldHost);
  return FieldHost;
}

async function withComposer(tab, run, { timeline = true, beforeDecision = null } = {}) {
  const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
  const savedCdpAttach = cdpClient.attach, savedCdpSend = cdpClient.sendCommand;
  const FieldHost = fieldHostClass();
  const host = new FieldHost();
  let browser, page, session;
  const state = { commands: [], preparations: [], afterRelease: null };
  const api = { runtime: {}, tabs: {
    get: async () => ({ url: 'https://monitor.test/compose/post' }),
    sendMessage: async (_tab, message) => {
      if (!page) return {};
      if (message.action.startsWith('ax_') || message.action === 'field_value_digest') return page.evaluate(async message => {
        window.msg = message;
        let finish = () => {};
        try {
          finish = __wbPageMonitor.beginContentAction(message.action, message.params || {});
          const result = await axHelpers[message.action]();
          if (message.action === 'field_value_digest') {
            result.documentToken = document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0];
            result.refScopeUrl = location.href;
          }
          return result;
        } catch (error) {
          return { success: false, dispatched: error.dispatched === true, noDispatch: error.dispatched !== true,
            ...(error.pagePreparationVeto ? { preparationVeto: error.pagePreparationVeto } : {}),
            ...(error.code === 'page_feedback_pending' ? { pageFeedbackPending: true } : {}),
            error: `${message.action} failed: ${error.message}` };
        } finally { finish(); }
      }, message).then(result => { if (message.action === 'ax_prepare_field_for_trusted_type') state.preparations.push(result); return result; });
      return page.evaluate(message => new Promise(resolve => messageListeners.forEach(fn => fn(message, {}, resolve))), message);
    },
  }, debugger: { sendCommand(_source, method, params, callback) {
    state.commands.push({ method, params });
    void (async () => {
      const result = await session.send(method, params);
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && state.afterRelease) {
        const hook = state.afterRelease; state.afterRelease = null; await hook();
      }
      return result;
    })().then(callback, error => {
      api.runtime.lastError = { message: error.message }; callback(); delete api.runtime.lastError;
    });
  } } };
  globalThis.chrome = api; delete globalThis.browser;
  try {
    await host._beginPageFeedbackRun(tab, 'interactive');
    ({ browser, page } = await fixture(chromium, 'chrome', { runToken: host._pageFeedbackRuns.get(tab).token }));
    await composeHost(page, tab, host);
    const client = new CDPClient(); client.sessions.set(tab, { attached: true });
    session = await page.context().newCDPSession(page);
    cdpClient.attach = async () => ({ attached: true });
    cdpClient.sendCommand = (...args) => client.sendCommand(...args);
    if (timeline) await page.evaluate(() => startTimeline());
    await page.waitForTimeout(250);
    const refs = await page.evaluate(() => ({ editor: __wb_ax_ref(document.getElementById('editor')) }));
    if (beforeDecision) await beforeDecision(page);
    // The decision is made from a fresh observation while the timeline runs.
    host._pageFeedbackRuns.get(tab).events.clear();
    await host._capturePageFeedbackModelState(tab, []);
    await run({ host, page, refs, state });
  } finally {
    cdpClient.attach = savedCdpAttach; cdpClient.sendCommand = savedCdpSend;
    if (session) await session.detach().catch(() => {});
    if (host._pageFeedbackRuns?.has(tab)) host._finishPageFeedbackRun(tab);
    if (savedChrome === undefined) delete globalThis.chrome; else globalThis.chrome = savedChrome;
    if (savedBrowser === undefined) delete globalThis.browser; else globalThis.browser = savedBrowser;
    if (browser) await browser.close();
  }
}

const insertions = state => state.commands.filter(item => item.method === 'Input.insertText');
const bubbleCoversEditor = page => page.evaluate(() => {
  const rect = document.getElementById('editor').getBoundingClientRect();
  return !!document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('#format-bubble');
});
const editorText = page => page.locator('#editor').innerText().then(text => text.replace(/\n$/, ''));

test('Chrome type_ax writes X\'s composer after the page draws its bubble for WebBrain\'s own focus click', async () => {
  await withComposer(91_001, async ({ host, page, refs, state }) => {
    // Let X's own reaction to the click land before the editor is reselected.
    state.afterRelease = () => page.waitForTimeout(30);
    const result = await host.executeTool(91_001, 'type_ax', { ref_id: refs.editor, text: POST, clear: true });
    assert.equal(result.success, true, JSON.stringify({ result, preparations: state.preparations }));
    assert.equal(result.verified, true);
    assert.equal(await editorText(page), POST);
    assert.equal(insertions(state).length, 1, 'One trusted text command');
    assert.equal(insertions(state)[0].params.text, POST);
    assert.equal(await page.evaluate(() => window.bubbleShown), 1, 'X drew its bubble for the trusted click');
    assert.equal(await bubbleCoversEditor(page), true, 'As in the trace\'s screenshot, the bubble covers the middle of the editor');
    assert.ok(await page.evaluate(() => window.timelineTicks) > 3, 'The timeline kept updating throughout');
    assert.deepEqual(state.preparations.map(item => item.success), [true, true]);
    assert.equal(await page.evaluate(() => document.getElementById('post').disabled), false);
  });
});

for (const timeline of [true, false]) {
  test(`Chrome type_ax still writes X's composer when its reaction is already reported before the reselect${timeline ? ' (live timeline)' : ''}`, async () => {
    const tab = timeline ? 91_002 : 91_003;
    await withComposer(tab, async ({ host, page, refs, state }) => {
      // The bubble (and timeline) updates are delivered to the agent first.
      state.afterRelease = () => page.waitForTimeout(400);
      const result = await host.executeTool(tab, 'type_ax', { ref_id: refs.editor, text: POST, clear: true });
      assert.equal(result.success, true, JSON.stringify({ result, preparations: state.preparations }));
      assert.equal(await editorText(page), POST);
      assert.equal(insertions(state).length, 1);
      assert.equal(await page.evaluate(() => window.bubbleShown), 1);
      assert.equal(await bubbleCoversEditor(page), true);
    }, { timeline });
  });
}

// The page moves the composer a little after WebBrain's click (a layout
// settling, for example). Its editor and dialog are the same, so the decision
// stands, as it would for any certified target that only moved.
for (const timeline of [true, false]) {
  test(`Chrome type_ax writes X's composer when the page moves it after WebBrain's focus click${timeline ? ' (live timeline)' : ''}`, async () => {
    const tab = timeline ? 91_006 : 91_007;
    await withComposer(tab, async ({ host, page, refs, state }) => {
      const before = await page.evaluate(() => document.getElementById('editor').getBoundingClientRect().top);
      state.afterRelease = async () => {
        await page.waitForTimeout(30);
        await page.evaluate(() => document.head.append(Object.assign(document.createElement('style'), { textContent: '#compose{margin-top:52px}' })));
        await page.waitForTimeout(50);
      };
      const result = await host.executeTool(tab, 'type_ax', { ref_id: refs.editor, text: POST, clear: true });
      assert.equal(result.success, true, JSON.stringify({ result, preparations: state.preparations }));
      assert.equal(await editorText(page), POST);
      assert.equal(insertions(state).length, 1);
      assert.equal(await page.evaluate(() => document.getElementById('editor').getBoundingClientRect().top) - before, 12);
      assert.equal(await bubbleCoversEditor(page), true);
    }, { timeline });
  });
}

const pressEditorCentre = async page => {
  const rect = await page.evaluate(() => { const r = document.getElementById('editor').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(rect.x, rect.y);
  await page.waitForFunction(() => window.bubbleShown > 0);
  await page.waitForTimeout(300);
};
const presses = state => state.commands.filter(item => item.method === 'Input.dispatchMouseEvent' && item.params.type === 'mousePressed');

// The page moving focus is page activity, not the user: the reselection
// focuses the editor again, and the text still goes only into it.
for (const delay of [30, 400]) for (const timeline of [true, false]) {
  test(`Chrome type_ax focuses X's composer again when the page moved focus after WebBrain's click (${delay} ms${timeline ? ', live timeline' : ''})`, async () => {
    const tab = 91_200 + delay + (timeline ? 1000 : 0);
    await withComposer(tab, async ({ host, page, refs, state }) => {
      state.afterRelease = async () => {
        await page.waitForTimeout(30);
        await page.evaluate(() => document.getElementById('reply-scope').focus());
        await page.waitForTimeout(delay);
      };
      const result = await host.executeTool(tab, 'type_ax', { ref_id: refs.editor, text: POST, clear: true });
      assert.equal(result.success, true, JSON.stringify({ result, preparations: state.preparations }));
      assert.equal(await editorText(page), POST);
      assert.equal(insertions(state).length, 1);
      assert.equal(await page.evaluate(() => document.getElementById('reply-scope').textContent), 'Everyone can reply');
    }, { timeline });
  });
}

// The state in the trace's screenshot: the bubble from an earlier click still
// covers the middle of the focused editor when the model decides again.
test('Chrome type_ax writes X\'s composer while the bubble of an earlier click still covers it', async () => {
  await withComposer(91_004, async ({ host, page, refs, state }) => {
    assert.equal(await bubbleCoversEditor(page), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'editor');
    const result = await host.executeTool(91_004, 'type_ax', { ref_id: refs.editor, text: POST, clear: true });
    assert.equal(result.success, true, JSON.stringify({ result, preparations: state.preparations }));
    assert.equal(await editorText(page), POST);
    assert.equal(insertions(state).length, 1);
    assert.equal(presses(state).length, 0, 'The covered centre is not pressed');
    assert.equal(await page.evaluate(() => window.bubblePressed || 0), 0, 'Bold and Italic are never pressed');
  }, { beforeDecision: pressEditorCentre });
});

test('Chrome an editor covered by the bubble after focus left it is not typed into', async () => {
  await withComposer(91_005, async ({ host, page, refs, state }) => {
    const result = await host.executeTool(91_005, 'type_ax', { ref_id: refs.editor, text: POST, clear: true });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.dispatched, false, JSON.stringify(result));
    assert.equal(insertions(state).length, 0);
    assert.equal(presses(state).length, 0);
    assert.equal(await page.evaluate(() => window.bubblePressed || 0), 0);
    assert.equal(await editorText(page), '');
  }, { beforeDecision: async page => {
    await pressEditorCentre(page);
    // Focus leaves the editor; the bubble stays over it.
    await page.evaluate(() => document.getElementById('reply-scope').focus());
  } });
});

for (const [name, change] of [
  ['its reply audience changes', page => page.evaluate(() => { document.getElementById('reply-scope').textContent = 'Only accounts you follow can reply'; })],
  ['its editor is replaced', page => page.evaluate(() => {
    const old = document.getElementById('editor'), next = old.cloneNode(true);
    old.replaceWith(next);
  })],
  ['the user clicks elsewhere', page => page.mouse.click(40, 700)],
  ['another dialog makes the composer inert', page => page.evaluate(() => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog'); dialog.textContent = 'Discard post?';
    dialog.style.cssText = 'position:fixed;left:200px;top:200px;width:300px;height:120px;background:#fff;z-index:40';
    document.body.append(dialog); document.getElementById('compose').inert = true;
  })],
]) for (const delay of [30, 400]) for (const timeline of [true, false]) {
  test(`Chrome type_ax stops without typing when, after WebBrain's focus click, ${name} (${delay} ms${timeline ? ', live timeline' : ''})`, async () => {
    const tab = 91_100 + delay + name.length + (timeline ? 1000 : 0);
    await withComposer(tab, async ({ host, page, refs, state }) => {
      state.afterRelease = async () => { await change(page); await page.waitForTimeout(delay); };
      const result = await host.executeTool(tab, 'type_ax', { ref_id: refs.editor, text: POST, clear: true });
      assert.equal(result.success, false, JSON.stringify(result));
      if (process.env.WEBBRAIN_TEST_DIAGNOSTICS) console.log(name, delay, result.preparationVeto, result.error);
      assert.equal(insertions(state).length, 0, 'No text may be sent after the composer or the user changed it');
      assert.notEqual(result.mutationMayHaveOccurred, true, JSON.stringify(result));
      const editor = await page.$('#editor');
      assert.equal(editor ? (await editor.innerText()).replace(/\n$/, '') : '', '');
    }, { timeline });
  });
}

// The page monitor is shared code; the same build file runs in both engines.
for (const [engine, build] of [[chromium, 'chrome'], [firefox, 'firefox']]) {
  test(`${build}: a selector that matches X's composer and its hidden timeline copy is reported as ambiguous`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.addScriptTag({ content: read(build, 'content/accessibility-tree.js') });
      const result = await page.evaluate(() => {
        deliver('page_monitor_capture_model', { includeTree: true });
        const snapshotToken = lastMonitorResponse.snapshotToken;
        const validate = params => { deliver('page_monitor_validate_model', { snapshotToken, ...params }); return lastMonitorResponse; };
        return {
          ambiguous: validate({ tool: 'type_text', selector: '[data-testid="tweetTextarea_0"]', text: 'x' }),
          unique: validate({ tool: 'type_text', selector: '#editor', text: 'x' }),
          missing: validate({ tool: 'type_text', selector: '#no-such-editor', text: 'x' }),
          byRef: validate({ tool: 'type_ax', ref_id: __wb_ax_ref(document.getElementById('editor')), text: 'x' }),
        };
      });
      assert.equal(result.ambiguous.ready, false);
      assert.equal(result.ambiguous.reason, 'target_ambiguous', JSON.stringify(result.ambiguous));
      assert.equal(result.unique.ready, true, JSON.stringify(result.unique));
      assert.equal(result.missing.ready, false);
      assert.equal(result.missing.reason, 'target_unresolved');
      assert.equal(result.byRef.ready, true, JSON.stringify(result.byRef));
    } finally { await browser.close(); }
  });
}

for (const [engine, build] of [[chromium, 'chrome'], [firefox, 'firefox']]) {
  test(`${build}: a focused editor under the page's bubble is certified for typing only, while it keeps focus`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.addScriptTag({ content: read(build, 'content/accessibility-tree.js') });
      const centre = await page.evaluate(() => { const r = document.getElementById('editor').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.mouse.click(centre.x, centre.y);
      await page.waitForFunction(() => window.bubbleShown > 0);
      await page.waitForTimeout(300);
      const covered = await page.evaluate(() => {
        const r = document.getElementById('editor').getBoundingClientRect();
        return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#format-bubble');
      });
      assert.equal(covered, true);
      const result = await page.evaluate(() => {
        deliver('page_monitor_capture_model', { includeTree: true });
        const snapshotToken = lastMonitorResponse.snapshotToken, focused = lastMonitorResponse.focusedTargetAvailable;
        const ref = __wb_ax_ref(document.getElementById('editor'));
        const validate = params => { deliver('page_monitor_validate_model', { snapshotToken, ...params }); return lastMonitorResponse; };
        const typing = validate({ tool: 'type_ax', ref_id: ref, text: 'x' });
        // Keys also go to the focused field, so press_keys may use it too.
        const keys = validate({ tool: 'press_keys', key: 'Enter' });
        const keysByRef = validate({ tool: 'press_keys', ref_id: ref, key: 'Enter' });
        const click = validate({ tool: 'click_ax', ref_id: ref });
        document.getElementById('reply-scope').focus();
        const unfocused = validate({ tool: 'type_ax', ref_id: ref, text: 'x' });
        return { focused, typing, keys, keysByRef, click, unfocused };
      });
      assert.equal(result.focused, true, 'The focused editor stays certified under the bubble');
      assert.equal(result.typing.ready, true, JSON.stringify(result.typing));
      assert.equal(result.keys.ready, true, JSON.stringify(result.keys));
      assert.equal(result.keysByRef.ready, true, JSON.stringify(result.keysByRef));
      assert.equal(result.click.ready, false);
      assert.equal(result.click.reason, 'target_uncovered', JSON.stringify(result.click));
      assert.equal(result.unfocused.ready, false);
      assert.equal(result.unfocused.reason, 'focus_changed', JSON.stringify(result.unfocused));
    } finally { await browser.close(); }
  });
}

// The monitor recognizes the typing action's own press by its actual native
// receivers (of the press and of its release) and button, never by caller
// metadata, in both builds. Only one such press is preparation.
const pressNames = { focus: 'a single left press', right: 'a right-button press', double: 'a double press',
  second: 'a second single left press', elsewhere: 'a single left press released over another node',
  unmarked: 'a single left press followed by native text without a marked receiver' };
for (const [engine, build] of [[chromium, 'chrome'], [firefox, 'firefox']]) for (const press of Object.keys(pressNames)) {
  const kept = ['focus', 'unmarked'].includes(press);
  test(`${build}: ${pressNames[press]} on the certified editor ${press === 'unmarked' ? 'does not type' : kept ? 'keeps' : 'does not keep'}${press === 'unmarked' ? '' : ' its typing certificate'}`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.addScriptTag({ content: read(build, 'content/accessibility-tree.js') });
      const setup = await page.evaluate(() => {
        deliver('page_monitor_capture_model', { includeTree: true });
        const snapshotToken = lastMonitorResponse.snapshotToken;
        const editor = document.getElementById('editor'), ref = __wb_ax_ref(editor);
        deliver('page_monitor_prepare', { tool: 'type_ax', ref_id: ref, operationId: 'owned-typing', expectedModelSnapshot: snapshotToken, allowPassiveRebase: true });
        const prepared = lastMonitorResponse;
        const rect = editor.getBoundingClientRect();
        editor.setAttribute('data-webbrain-native-target', 'owned-press');
        return { ref, prepared, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      assert.equal(setup.prepared.modelBindingValid, true, JSON.stringify(setup.prepared));
      const pressTypes = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'click', 'input', 'change'];
      const dispatched = await page.evaluate(({ x, y, press, pressTypes }) => {
        deliver('page_monitor_dispatch', { operationId: 'owned-typing', kind: 'click', x, y, navigationCandidate: true,
          pointerButton: press === 'right' ? 'right' : 'left', clickCount: press === 'double' ? 2 : 1,
          nativeTarget: 'owned-press', eventTypes: pressTypes });
        return lastMonitorResponse;
      }, { ...setup, press, pressTypes });
      assert.equal(dispatched.ready, true, JSON.stringify(dispatched));
      // The monitor's own classification of each half of the press.
      assert.equal(dispatched.typingPreparation === true, !['right', 'double'].includes(press), JSON.stringify(dispatched));
      await page.mouse.move(setup.x, setup.y);
      await page.mouse.down({ button: press === 'right' ? 'right' : 'left' });
      // As CDP marks the node under the release point before sending it.
      const released = await page.evaluate(({ x, y, press }) => {
        const receiver = press === 'elsewhere' ? document.getElementById('reply-scope') : document.getElementById('editor');
        receiver.setAttribute('data-webbrain-native-target', 'owned-release');
        deliver('page_monitor_dispatch', { operationId: 'owned-typing', kind: 'click', x, y, release: true, nativeTarget: 'owned-release' });
        return lastMonitorResponse;
      }, { ...setup, press });
      assert.equal(released.typingPreparation === true, !['right', 'double', 'elsewhere'].includes(press), JSON.stringify(released));
      await page.mouse.up({ button: press === 'right' ? 'right' : 'left' });
      await page.waitForFunction(() => window.bubbleShown > 0);
      if (press === 'second') {
        const again = await page.evaluate(({ x, y, pressTypes }) => {
          document.getElementById('editor').setAttribute('data-webbrain-native-target', 'owned-press-2');
          deliver('page_monitor_dispatch', { operationId: 'owned-typing', kind: 'click', x, y, navigationCandidate: true,
            pointerButton: 'left', clickCount: 1, nativeTarget: 'owned-press-2', eventTypes: pressTypes });
          return lastMonitorResponse;
        }, { ...setup, pressTypes });
        assert.equal(again.ready, true, JSON.stringify(again));
        // A second press is the action's input to the page, not preparation.
        assert.equal(again.typingPreparation, undefined, JSON.stringify(again));
        return;
      }
      const after = await page.evaluate(({ ref, press }) => {
        const editor = document.getElementById('editor');
        editor.focus();
        // The page keeps reacting in its body-level layer (the bubble moves):
        // passive activity that only a kept certificate is judged against.
        const bubble = document.getElementById('format-bubble');
        bubble.style.left = (parseFloat(bubble.style.left) + 1) + 'px';
        const step = action => {
          try { const finish = __wbPageMonitor.beginContentAction(action, { ref_id: ref }); finish(); return 'kept'; }
          catch (error) { return error.pagePreparationVeto?.predicate || error.message; }
        };
        const reselect = step('ax_prepare_field_for_trusted_type'), paste = step('ax_paste_draft');
        editor.setAttribute('data-webbrain-native-target', 'owned-text');
        window.lastMonitorResponse = undefined;
        // Native input always tries to mark its receiver; unmarked input to a
        // keyboard-bound field cannot be shown to be the field's.
        deliver('page_monitor_dispatch', { operationId: 'owned-typing', kind: 'input', nativeInput: true,
          ...(press === 'unmarked' ? {} : { nativeTarget: 'owned-text' }), eventTypes: ['beforeinput', 'input', 'change'] });
        return { reselect, paste, text: lastMonitorResponse };
      }, { ref: setup.ref, press });
      if (process.env.WEBBRAIN_TEST_DIAGNOSTICS) console.log(build, press, JSON.stringify(after));
      if (kept) {
        assert.deepEqual([after.reselect, after.paste], ['kept', 'kept'], JSON.stringify(after));
      } else {
        assert.notEqual(after.reselect, 'kept', JSON.stringify(after));
        assert.notEqual(after.paste, 'kept', JSON.stringify(after));
      }
      // The text command waits for the monitor's own delivery when it refuses.
      const text = after.text === undefined || after.text === null
        ? await page.waitForFunction(() => window.lastMonitorResponse, null, { timeout: 2000 }).then(handle => handle.jsonValue())
        : after.text;
      assert.equal(text.ready, press === 'focus', JSON.stringify(text));
      if (press === 'unmarked') assert.equal(text.preparationVeto?.predicate, 'target_unresolved', JSON.stringify(text));
    } finally { await browser.close(); }
  });
}

// Keyboard input of a certified operation may reach a child document only
// when the certified target is the frame that has focus (or contains it) and
// was not an editable host when certified; the top document's monitor
// answers for its operation, in both builds.
for (const [engine, build] of [[chromium, 'chrome'], [firefox, 'firefox']]) {
  test(`${build}: certified keyboard input reaches a child document only through the certified frame that has focus`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.addScriptTag({ content: read(build, 'content/accessibility-tree.js') });
      await page.evaluate(() => new Promise(resolve => {
        // An editor of its own in an iframe, wrapped in a labelled textbox,
        // and a GIF search iframe inside the composer's dialog.
        const host = document.createElement('div');
        host.id = 'frame-editor'; host.setAttribute('role', 'textbox'); host.setAttribute('aria-label', 'Embedded editor');
        const frame = document.createElement('iframe'); frame.id = 'embedded'; frame.srcdoc = '<!doctype html><body contenteditable="true"></body>';
        const gif = document.createElement('iframe'); gif.id = 'gif'; gif.srcdoc = '<!doctype html><input id="inner">';
        host.append(frame); document.getElementById('compose').append(host, gif);
        let loaded = 0; for (const item of [frame, gif]) item.addEventListener('load', () => { if (++loaded === 2) resolve(); }, { once: true });
      }));
      const answers = await page.evaluate(() => {
        deliver('page_monitor_capture_model', { includeTree: true });
        const snapshotToken = lastMonitorResponse.snapshotToken;
        const prepare = (operationId, tool, el) => deliver('page_monitor_prepare', { tool, ref_id: __wb_ax_ref(el), text: 'x',
          operationId, expectedModelSnapshot: snapshotToken, allowPassiveRebase: true });
        const ask = operationId => { deliver('page_monitor_receiver_frame', { operationId }); return lastMonitorResponse.foreignReceiverAllowed; };
        const editor = document.getElementById('editor'), host = document.getElementById('frame-editor');
        prepare('field-typing', 'type_ax', editor);
        prepare('frame-typing', 'type_ax', host);
        prepare('button-click', 'click_ax', document.getElementById('reply-scope'));
        const result = {};
        // Focus in the GIF search iframe inside the composer's dialog.
        document.getElementById('gif').contentDocument.getElementById('inner').focus();
        result.fieldWithGifFocused = ask('field-typing');
        result.frameEditorWithGifFocused = ask('frame-typing');
        result.buttonWithGifFocused = ask('button-click');
        result.unknown = ask('no-such-operation');
        // Focus in the embedded editor's own frame.
        document.getElementById('embedded').contentDocument.body.focus();
        result.frameEditorFocused = ask('frame-typing');
        result.fieldWithEmbeddedFocused = ask('field-typing');
        // The page makes the composer's editor read-only, or replaces it.
        editor.setAttribute('aria-readonly', 'true'); editor.setAttribute('contenteditable', 'false');
        result.readonlyField = ask('field-typing');
        editor.replaceWith(editor.cloneNode(true));
        result.replacedField = ask('field-typing');
        // The embedded editor's frame is replaced.
        const frame = document.getElementById('embedded'), next = frame.cloneNode(true); frame.replaceWith(next);
        result.replacedFrame = ask('frame-typing');
        return result;
      });
      assert.deepEqual(answers, {
        fieldWithGifFocused: false, frameEditorWithGifFocused: false, buttonWithGifFocused: false, unknown: false,
        frameEditorFocused: true, fieldWithEmbeddedFocused: false, readonlyField: false, replacedField: false, replacedFrame: false,
      });
    } finally { await browser.close(); }
  });
}

// Native keyboard input always tries to mark its receiver. Unmarked input is
// refused for any certified operation, pressed or not; an uncertified
// operation keeps its earlier rules.
for (const [engine, build] of [[chromium, 'chrome'], [firefox, 'firefox']]) {
  test(`${build}: unmarked native text is refused for a certified typing operation, not for an uncertified one`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.addScriptTag({ content: read(build, 'content/accessibility-tree.js') });
      const results = await page.evaluate(async () => {
        deliver('page_monitor_capture_model', { includeTree: true });
        const snapshotToken = lastMonitorResponse.snapshotToken;
        const editor = document.getElementById('editor'), ref = __wb_ax_ref(editor);
        editor.focus();
        const text = async (operationId, certified) => {
          deliver('page_monitor_prepare', { tool: 'type_ax', ref_id: ref, text: 'x', operationId,
            ...(certified ? { expectedModelSnapshot: snapshotToken, allowPassiveRebase: true } : {}) });
          window.lastMonitorResponse = undefined;
          deliver('page_monitor_dispatch', { operationId, kind: 'input', nativeInput: true, eventTypes: ['beforeinput', 'input', 'change'] });
          for (let wait = 0; wait < 100 && window.lastMonitorResponse === undefined; wait++) await new Promise(resolve => setTimeout(resolve, 20));
          return { ready: lastMonitorResponse?.ready, predicate: lastMonitorResponse?.preparationVeto?.predicate };
        };
        return { certified: await text('certified-text', true), uncertified: await text('uncertified-text', false) };
      });
      assert.deepEqual(results.certified, { ready: false, predicate: 'target_unresolved' }, JSON.stringify(results));
      assert.equal(results.uncertified.ready, true, JSON.stringify(results));
    } finally { await browser.close(); }
  });
}
