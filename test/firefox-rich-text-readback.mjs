import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { firefox } from 'playwright';
import { build } from 'esbuild';
import { BidiSession } from '../firefox-companion/session.mjs';

// Exercise production BiDi declarations against real Firefox DOM and trusted
// keyboard input. The transport shim changes only how native keys are delivered;
// target preparation, selection, readback, and submission gating are production.
async function nativeSession(page, { guard = null, validate = null } = {}) {
  const session = new BidiSession();
  const runId = crypto.randomUUID();
  session.runs.set(runId, { context: 'owned-firefox-editor' });
  session.locate = async () => ({ context: 'owned-firefox-editor', node: { sharedId: 'original-editor' } });
  const commands = [];
  const declarations = [];
  const editor = await page.evaluateHandle(() => qaEditor);
  session.call = async (_match, declaration, args = [], resultOwnership = null) => {
    declarations.push(declaration);
    const handle = resultOwnership === 'root' ? crypto.randomUUID() : null;
    const value = await page.evaluate(({ declaration, args, handle, editor }) => {
      const fn = (0, eval)(`(${declaration})`);
      const value = fn(editor, ...args.map(arg => arg.handle
        ? window.qaNativeHandles?.get(arg.handle) : arg.value ?? null));
      if (handle && value !== null) {
        (window.qaNativeHandles ||= new Map()).set(handle, value);
        return { ownedHandle: handle };
      }
      return value;
    }, { declaration, args, handle, editor });
    if (value?.ownedHandle) return { result: { type: 'object', handle: value.ownedHandle } };
    if (value && typeof value === 'object') {
      return { result: { type: 'object', value: Object.entries(value).map(([name, item]) => [name, { type: typeof item, value: item }]) } };
    }
    return { result: value === null ? { type: 'null' } : { value } };
  };
  const keys = new Map([['\uE009', 'Control'], ['\uE03D', 'Meta'], ['\uE003', 'Backspace'], ['\uE007', 'Enter']]);
  const held = new Set();
  session.send = async (method, params) => {
    commands.push({ method, params });
    if (method === 'script.disown') {
      await page.evaluate(handles => { for (const handle of handles) qaNativeHandles.delete(handle); }, params.handles);
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
  return {
    commands, declarations, session, runId,
    async perform(action, payload) {
      const token = crypto.randomUUID();
      await page.evaluate(token => qaEditor.setAttribute('data-webbrain-bidi', token), token);
      return session.perform(runId, action, { token, ...(guard ? { pageFeedbackGuard: guard } : {}), ...payload }, validate);
    },
  };
}

async function loadDraftJs(page, previous = '') {
  await page.evaluate(() => window.__wbPageMonitor?.dispose?.());
  await page.setContent('<style>.public-DraftEditor-content{min-height:60px;white-space:pre-wrap}body{font:16px sans-serif}</style><main id="app"></main>');
  for (const path of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js', 'immutable/dist/immutable.js', 'draft-js/dist/Draft.js']) {
    await page.addScriptTag({ content: await readFile(new URL(`../node_modules/${path}`, import.meta.url), 'utf8') });
  }
  await page.evaluate(previous => {
    const { Editor, EditorState, ContentState } = Draft;
    function OwnedEditor() {
      const [state, setState] = React.useState(() => EditorState.createWithContent(ContentState.createFromText(previous)));
      window.qaModel = state.getCurrentContent().getPlainText('\n');
      window.qaSetText = value => setState(EditorState.createWithContent(ContentState.createFromText(value)));
      return React.createElement(Editor, { editorState: state, onChange: setState });
    }
    ReactDOM.render(React.createElement(OwnedEditor), document.querySelector('#app'));
    window.qaEditor = document.querySelector('.public-DraftEditor-content');
    window.qaEvents = [];
    window.qaPastes = [];
    qaEditor.addEventListener('input', event => qaEvents.push({ trusted: event.isTrusted, inputType: event.inputType }));
    qaEditor.addEventListener('paste', event => qaPastes.push(event.clipboardData?.getData('text/plain')));
  }, previous);
}

const proseMirrorBundle = (await build({ entryPoints: [fileURLToPath(new URL('./fixtures/bluesky-composer-editor.mjs', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'qaEditorLibrary', platform: 'browser' })).outputFiles[0].text;

async function loadProseMirror(page, previous = '') {
  await page.evaluate(() => window.__wbPageMonitor?.dispose?.());
  await page.setContent('<style>.ProseMirror{height:180px;white-space:pre-wrap}.ProseMirror p{margin:0}body{font:16px sans-serif}</style>'
    + '<main id="app"><div id="editor-host"></div><button id="publish" aria-label="Publish post">Post</button></main>');
  await page.addScriptTag({ content: proseMirrorBundle });
  await page.evaluate(previous => {
    qaEditorLibrary.mountEditor(previous);
    window.qaEditor = qaEditorView.dom;
    window.qaPastes = []; window.qaEvents = [];
    qaEditor.addEventListener('paste', event => qaPastes.push(event.clipboardData?.getData('text/plain')));
    qaEditor.addEventListener('input', event => qaEvents.push({ trusted: event.isTrusted, inputType: event.inputType }));
  }, previous);
}

test('Firefox: production BiDi typing uses exact DraftJS model text for empty appends, replacements and existing multiline documents', async t => {
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const scenario of [
      { name: 'empty append', previous: '', action: 'type', text: 'body', expected: 'body' },
      { name: 'empty replacement', previous: '', action: 'field', text: 'body', expected: 'body' },
      { name: 'replace existing document', previous: 'Existing draft', action: 'field', text: 'Replacement', expected: 'Replacement' },
      { name: 'append inside last leaf', previous: 'First\n\nLast', action: 'type', text: ' suffix', expected: 'First\n\nLast suffix' },
      { name: 'literal Unicode and markup', previous: '', action: 'field', text: '  Türkçe ıİ 🧠 <b>literal</b> &  ', expected: '  Türkçe ıİ 🧠 <b>literal</b> &  ' },
    ]) await t.test(scenario.name, async () => {
      await loadDraftJs(page, scenario.previous);
      const native = await nativeSession(page);
      const result = await native.perform(scenario.action, { text: scenario.text });
      const facts = await page.evaluate(() => ({ model: qaModel, html: qaEditor.innerHTML }));
      assert.equal(result.success, true, JSON.stringify({ result, facts }));
      assert.equal(result.verified, true);
      assert.equal(await page.evaluate(() => qaModel), scenario.expected, 'The real controlled DraftJS model must hold exactly the requested document.');
      assert.ok(await page.evaluate(() => qaEvents.length > 0 && qaEvents.every(event => event.trusted)));
      assert.equal(await page.locator('b').count(), 0, 'Literal text cannot become markup.');
      assert.equal(native.commands.some(command => command.params?.actions?.[0]?.actions.some(action => action.value === '\uE007')), false, 'Literal line breaks must not send Enter.');
      assert.equal(await page.evaluate(() => qaEditor.childNodes.length), 1, 'Append stays inside the original marked document root.');
      if (scenario.name === 'append inside last leaf') {
        const declaration = native.declarations.find(source => source.includes('const settledReading = readRichTextFieldReading(el, semanticKind)'));
        const readback = expected => page.evaluate(({ declaration, expected }) => (0, eval)(`(${declaration})`)(qaEditor, expected), { declaration, expected });
        assert.deepEqual(await readback('First\r\n\r\nLast suffix'), { verified: true, compared: true, reader: 'semantic' },
          'CRLF normalization preserves authored document separators.');
        assert.deepEqual(await readback('First\n\n\nLast suffix'), { verified: false, compared: true, reader: 'semantic' },
          'Visual spacing cannot excuse an extra authored line break.');
      }
    });
  } finally { await browser.close(); }
});

async function installOwnedMonitor(page, selector = '.public-DraftEditor-content') {
  await page.evaluate(() => {
    const heading = document.createElement('h1'); heading.textContent = 'Owned draft';
    document.querySelector('main').prepend(heading);
    // The existing model fence binds field geometry. Fix it here so this test
    // isolates dispatch ownership rather than independent layout invalidation.
    qaEditor.style.height = '180px';
    qaEditor.setAttribute('aria-label', 'Owned draft'); qaEditor.focus();
    window.qaMonitorListeners = []; window.qaFeedback = []; window.qaEnterDocuments = [];
    qaEditor.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      qaEnterDocuments.push(typeof qaModel === 'undefined' ? qaModelText : qaModel); event.preventDefault(); event.stopImmediatePropagation();
    });
    window.chrome = window.browser = { runtime: {
      onMessage: { addListener: listener => qaMonitorListeners.push(listener), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: 'owned-rich-text', documentToken: message.documentToken };
        if (message.action === 'page_feedback') { qaFeedback.push(message.feedback); return { accepted: true }; }
        return {};
      },
    } };
    window.qaDeliver = (action, params = {}) => new Promise(resolve => {
      for (const listener of qaMonitorListeners) {
        const asynchronous = listener({ target: 'content', action, params: { runToken: 'owned-rich-text', ...params } }, {}, resolve);
        if (asynchronous === true) break;
      }
    });
  });
  for (const file of ['accessibility-tree.js', 'page-monitor.js']) {
    await page.addScriptTag({ content: await readFile(new URL(`../src/firefox/src/content/${file}`, import.meta.url), 'utf8') });
  }
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(100);
  const fence = await page.evaluate(async selector => {
    const snapshot = await qaDeliver('page_monitor_capture_model', { includeTree: true });
    const prepared = await qaDeliver('page_monitor_prepare', {
      operationId: 'owned-multiline-edit', tool: 'type_text', selector,
      expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true,
    });
    const fence = await qaDeliver('page_monitor_dispatch', { operationId: 'owned-multiline-edit', kind: 'input', fenceOnly: true });
    qaFeedback = [];
    return { prepared, fence };
  }, selector);
  assert.equal(fence.prepared.modelBindingValid, true, JSON.stringify(fence));
  assert.equal(fence.fence.ready, true, JSON.stringify(fence));
  return {
    guard: fence.fence.guard,
    validate: async (_id, guard, kind, rebindFocus) => {
      const result = await page.evaluate(({ guard, kind, rebindFocus }) => qaDeliver('page_monitor_validate', { ...guard, kind, rebindFocus }), { guard, kind, rebindFocus });
      return result.ready === true;
    },
  };
}

test('Firefox: production monitor owns multiline paste and preserves the native submit fence', async t => {
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const replacement of [false, true]) await t.test(replacement ? 'clear, paste and verified submit' : 'append, paste and verified submit', async () => {
      await loadDraftJs(page, 'Existing\nlast');
      const native = await nativeSession(page, await installOwnedMonitor(page));
      const result = await native.perform('field', { text: 'First\n\nLast\n', clear: replacement, submit: true });
      const expected = `${replacement ? '' : 'Existing\nlast'}First\n\nLast\n`;
      const facts = await page.evaluate(() => ({ model: qaModel, feedback: qaFeedback, enters: qaEnterDocuments }));
      assert.equal(result.verified, true, JSON.stringify({ result, facts }));
      assert.equal(result.submitted, true);
      assert.equal(facts.model, expected);
      assert.deepEqual(facts.enters, [expected], 'A single Enter follows exact verification, without losing the native sequence to a synthetic marker.');
      assert.equal(facts.feedback.some(item => item.source !== 'agent'), false, JSON.stringify(facts.feedback));
      assert.equal(native.declarations.filter(source => source.includes("new view.ClipboardEvent('paste'")).length, 1);
    });
    await t.test('a delayed page change after paste prevents the bundled submit', async () => {
      await loadDraftJs(page);
      const native = await nativeSession(page, await installOwnedMonitor(page));
      await page.evaluate(() => qaEditor.addEventListener('paste', () => setTimeout(() => {
        qaEditor.setAttribute('aria-label', 'Different document');
      }, 15), { once: true }));
      await assert.rejects(native.perform('field', { text: 'First\n\nLast', clear: false, submit: true }), error => {
        assert.equal(error.dispatchState.dispatched, true);
        assert.equal(error.dispatchState.outcomeUnknown, true);
        assert.equal(error.dispatchState.retryable, false);
        assert.equal(error.code, 'page_feedback_pending');
        return true;
      });
      assert.equal(await page.evaluate(() => qaModel), 'First\n\nLast');
      assert.deepEqual(await page.evaluate(() => qaEnterDocuments), []);
      assert.equal(native.declarations.filter(source => source.includes("new view.ClipboardEvent('paste'")).length, 1);
    });
  } finally { await browser.close(); }
});

test('Firefox: semantic readback preserves ProseMirror paragraphs and generic rendered field values', async t => {
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const scenario of [
      { name: 'ProseMirror empty caret', previous: '', text: 'body', expected: 'body' },
      { name: 'ProseMirror document separators', previous: 'First\nLast', text: ' suffix', expected: 'First\nLast suffix' },
      { name: 'ordinary visual paragraph spacing', html: '<div id="editor" contenteditable><p>First</p><p>Last</p></div>', text: ' suffix', expected: 'First\n\nLast suffix' },
      { name: 'ordinary authored spaces', html: '<div id="editor" contenteditable style="white-space:pre-wrap">  Existing  </div>', text: '  suffix  ', expected: '  Existing    suffix  ' },
      { name: 'plain input value', html: '<input id="editor" value="Existing">', text: ' suffix', expected: 'Existing suffix' },
    ]) await t.test(scenario.name, async () => {
      if (Object.hasOwn(scenario, 'previous')) await loadProseMirror(page, scenario.previous);
      else {
        await page.setContent(scenario.html);
        await page.evaluate(() => { window.qaEditor = document.querySelector('#editor'); });
      }
      const native = await nativeSession(page);
      const result = await native.perform('type', { text: scenario.text });
      assert.equal(result.verified, true, JSON.stringify(result));
      const state = await page.evaluate(() => ({ text: qaEditor.isContentEditable ? qaEditor.innerText : qaEditor.value, children: qaEditor.childNodes.length }));
      if (scenario.name === 'ProseMirror document separators') {
        assert.equal(state.text, 'First\n\nLast suffix');
        assert.equal(await page.evaluate(() => qaModelText), scenario.expected, 'Semantic readback must use authored paragraph separators, not rendered spacing.');
      } else assert.equal(state.text, scenario.expected);
      if (scenario.name === 'ProseMirror empty caret') assert.equal(state.children, 1, 'The caret stays within the ProseMirror paragraph.');
    });
  } finally { await browser.close(); }
});

test('Firefox: unsupported DraftJS preflight sends no text, and unsupported settled documents cannot submit or retry', async t => {
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await t.test('unsupported before typing', async () => {
      await loadDraftJs(page);
      await page.evaluate(() => {
        const hidden = document.createElement('span'); hidden.dataset.text = 'true'; hidden.textContent = 'unverified'; hidden.hidden = true;
        qaEditor.querySelector('.public-DraftStyleDefault-block').append(hidden);
      });
      const native = await nativeSession(page);
      await assert.rejects(native.perform('field', { text: 'body', submit: true }), error => {
        assert.equal(error.dispatchState.noDispatch, true);
        assert.equal(error.dispatchState.dispatched, false);
        assert.match(error.message, /exact document text/);
        return true;
      });
      assert.equal(native.commands.length, 0);
      assert.equal(await page.evaluate(() => qaModel), '');
    });
    await t.test('a prevented clear cannot append the replacement to the existing document', async () => {
      await loadDraftJs(page, 'Existing draft');
      await page.evaluate(() => qaEditor.addEventListener('keydown', event => {
        if (event.key === 'Backspace') { event.preventDefault(); event.stopImmediatePropagation(); }
      }, { capture: true }));
      const native = await nativeSession(page);
      await assert.rejects(native.perform('field', { text: 'First\nLast', submit: true }), error => {
        assert.equal(error.dispatchState.dispatched, true);
        assert.equal(error.dispatchState.outcomeUnknown, true);
        assert.equal(error.dispatchState.retryable, false);
        assert.match(error.message, /clearing did not establish an empty document/);
        return true;
      });
      assert.equal(await page.evaluate(() => qaModel), 'Existing draft');
      assert.deepEqual(await page.evaluate(() => qaPastes), []);
      assert.equal(native.declarations.some(source => source.includes("new view.ClipboardEvent('paste'")), false);
    });
    for (const mode of ['hidden suffix', 'lost model markers']) await t.test(`unsupported after dispatched input: ${mode}`, async () => {
      await loadDraftJs(page);
      await page.evaluate(mode => qaEditor.addEventListener('input', () => setTimeout(() => {
        if (mode === 'lost model markers') {
          qaEditor.classList.remove('public-DraftEditor-content');
          qaEditor.textContent = qaModel;
        } else {
          const hidden = document.createElement('span'); hidden.dataset.text = 'true'; hidden.textContent = 'unverified'; hidden.hidden = true;
          qaEditor.querySelector('.public-DraftStyleDefault-block').append(hidden);
        }
      }, 15), { once: true }), mode);
      const native = await nativeSession(page);
      const result = await native.perform('field', { text: 'aB', clear: false, submit: true });
      assert.equal(result.success, false);
      assert.equal(result.verified, false);
      assert.equal(result.dispatched, true);
      assert.equal(result.outcomeUnknown, true);
      assert.equal(result.retryable, false);
      assert.equal(result.submitted, false);
      assert.deepEqual(result.readback, { compared: false, reason: 'readback_unavailable' }, 'An unreadable document is not a known mismatch.');
      assert.equal(await page.evaluate(() => qaModel), 'aB');
      assert.equal(native.commands.filter(command => command.method === 'input.performActions').length, 2, 'Each character is sent once; verification must not dispatch a second edit.');
    });
  } finally { await browser.close(); }
});

test('Firefox: DraftJS plain-text paste writes a complete multiline document exactly once', async t => {
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const scenario of [
      { name: 'empty append', previous: '', action: 'type', text: 'First\n\nLast' },
      { name: 'empty replacement', previous: '', action: 'field', text: 'First\n\nLast' },
      { name: 'replace old multiline draft', previous: 'Old\n\ndraft', action: 'field', text: 'First\n\nLast' },
      { name: 'append after last marked leaf', previous: 'Existing\n\nlast', action: 'type', text: ' suffix\nNext' },
      { name: 'append to empty last block', previous: 'Existing\n', action: 'type', text: '\nNext\n' },
      { name: 'leading and trailing LF', previous: '', action: 'field', text: '\nFirst\n\nLast\n' },
      { name: 'CRLF document separators', previous: '', action: 'field', text: 'First\r\n\r\nLast\r\n' },
      { name: 'literal multiline Unicode and markup', previous: '', action: 'field', text: '  Türkçe 🧠 <b>literal</b> &\n  Next  \n' },
    ]) await t.test(scenario.name, async () => {
      await loadDraftJs(page, scenario.previous);
      const native = await nativeSession(page);
      const result = await native.perform(scenario.action, { text: scenario.text });
      const expected = (scenario.action === 'type' ? scenario.previous : '') + scenario.text.replace(/\r\n?/g, '\n');
      const facts = await page.evaluate(() => ({ model: qaModel, html: qaEditor.innerHTML, pastes: qaPastes }));
      assert.equal(result.success, true, JSON.stringify({ result, facts, expected }));
      assert.equal(result.verified, true);
      assert.equal(facts.model, expected, 'The controlled DraftJS model and production semantic reader agree on the whole document.');
      assert.deepEqual(facts.pastes, [scenario.text.replace(/\r\n?/g, '\n')], 'Exactly one public plain-text paste reaches the editor.');
      assert.equal(await page.locator('b').count(), 0, 'A clipboard payload cannot interpret literal markup.');
      assert.equal(native.declarations.filter(source => source.includes("execCommand('insertText'")).length, 0, 'DraftJS multiline edits must not fall back to LF editing commands.');
      const keyDowns = native.commands.filter(command => command.method === 'input.performActions')
        .flatMap(command => command.params.actions[0].actions.filter(action => action.type === 'keyDown').map(action => action.value));
      assert.equal(keyDowns.includes('\uE007'), false, 'A document line break cannot send a submit shortcut.');
      assert.equal(keyDowns.filter(value => !['\uE009', '\uE03D', '\uE003'].includes(value)).join(''), scenario.action === 'field' ? 'a' : '', 'Only trusted clear keys precede the single paste.');
    });
    await t.test('a cancelled and unchanged paste stays uncertain without submit or replay', async () => {
      await loadDraftJs(page);
      await page.evaluate(() => qaEditor.addEventListener('paste', event => {
        event.preventDefault(); event.stopImmediatePropagation();
      }, { capture: true }));
      const native = await nativeSession(page);
      const result = await native.perform('field', { text: 'First\n\nLast', submit: true });
      assert.equal(result.success, false);
      assert.equal(result.verified, false);
      assert.equal(result.dispatched, true);
      assert.equal(result.outcomeUnknown, true);
      assert.equal(result.retryable, false);
      assert.equal(result.submitted, false);
      assert.equal(await page.evaluate(() => qaModel), '');
      assert.deepEqual(result.readback, { compared: true, reader: 'semantic' }, 'The editor model holds another document: a known mismatch.');
      const keyDowns = native.commands.filter(command => command.method === 'input.performActions')
        .flatMap(command => command.params.actions[0].actions.filter(action => action.type === 'keyDown').map(action => action.value));
      assert.equal(keyDowns.includes('\uE007'), false, 'Literal LF insertion cannot send a submit shortcut.');
      assert.equal(keyDowns.filter(value => !['\uE009', '\uE03D', '\uE003'].includes(value)).join(''), 'a', 'No characters or submission follow the ambiguous paste.');
      assert.equal(native.declarations.filter(source => source.includes("new view.ClipboardEvent('paste'")).length, 1, 'Verification must not repeat an ambiguous paste.');
    });
  } finally { await browser.close(); }
});

test('Firefox: actual ProseMirror writes one complete plain-text edit without intermediate composer changes', async t => {
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const scenario of [
      { name: 'empty replacement', previous: '', action: 'field', text: 'Original draft' },
      { name: 'nonempty replacement', previous: 'Old draft', action: 'field', text: 'Replacement' },
      { name: 'empty append', previous: '', action: 'type', text: 'Original draft' },
      { name: 'single-line append', previous: 'Original', action: 'type', text: ' suffix' },
      { name: 'multiline replacement', previous: 'Old\n\ndraft', action: 'field', text: 'First\n\nLast\n' },
      { name: 'multiline append', previous: 'Original\nlast', action: 'type', text: '\n\nAnother\n' },
      { name: 'empty final paragraph', previous: 'Original\n', action: 'type', text: '\nAnother\n' },
      { name: 'CRLF paragraphs', previous: '', action: 'field', text: '\r\nFirst\r\n\r\nLast\r\n' },
      { name: 'literal Unicode and markup', previous: 'Old', action: 'field', text: '  Türkçe ıİ 🧠 <b>literal</b> &\n  Next  \n' },
      { name: 'field append without clear', previous: 'Original\nlast', action: 'field', clear: false, text: '\nNext' },
      { name: 'empty replacement value', previous: 'Original\nlast', action: 'field', text: '' },
    ]) await t.test(scenario.name, async () => {
      await loadProseMirror(page, scenario.previous);
      const native = await nativeSession(page, await installOwnedMonitor(page, '.ProseMirror'));
      const result = await native.perform(scenario.action, { text: scenario.text, ...(scenario.clear === false ? { clear: false } : {}) });
      const expected = (scenario.action === 'type' || scenario.clear === false ? scenario.previous : '') + scenario.text.replace(/\r\n?/g, '\n');
      const facts = await page.evaluate(() => ({ model: qaModelText, pastes: qaPastes, html: qaEditor.innerHTML,
        disabled: document.querySelector('#publish').getAttribute('aria-disabled'), feedback: qaFeedback,
        handles: qaNativeHandles.size }));
      assert.equal(result.success, true, JSON.stringify({ result, facts, expected }));
      assert.equal(result.verified, true);
      assert.equal(result.submitted, false);
      assert.equal(facts.model, expected);
      assert.equal(facts.disabled, String(!expected.trim()), 'The actual peer submit state changes inside the one verified edit.');
      assert.deepEqual(facts.pastes, scenario.text ? [scenario.text.replace(/\r\n?/g, '\n')] : []);
      assert.equal(facts.handles, 0, 'The private owned selection must be released after dispatch.');
      assert.equal(facts.feedback.some(item => item.source !== 'agent'), false, JSON.stringify(facts.feedback));
      assert.equal(await page.locator('b').count(), 0, 'Only plain text enters the real editor model.');
      const keys = native.commands.filter(command => command.method === 'input.performActions')
        .flatMap(command => command.params.actions[0].actions.filter(action => action.type === 'keyDown').map(action => action.value));
      assert.deepEqual(keys, scenario.text ? [] : ['\uE003'], 'Replacement must not dispatch an intermediate clear or individual characters.');
      assert.equal(native.declarations.some(source => source.includes("execCommand('insertText'")), false);
    });
    await t.test('peer submit activation retains the following submit fence', async () => {
      await loadProseMirror(page);
      const native = await nativeSession(page, await installOwnedMonitor(page, '.ProseMirror'));
      await assert.rejects(native.perform('field', { text: 'Verified document', submit: true }), error => {
        assert.equal(error.code, 'page_feedback_pending');
        assert.equal(error.dispatchState.dispatched, true);
        assert.equal(error.dispatchState.retryable, false);
        return true;
      });
      assert.equal(await page.evaluate(() => qaModelText), 'Verified document');
      assert.deepEqual(await page.evaluate(() => qaPastes), ['Verified document']);
      assert.deepEqual(await page.evaluate(() => qaEnterDocuments), []);
    });
    await t.test('a cancelled unchanged paste cannot submit or replay', async () => {
      await loadProseMirror(page, 'Original');
      await page.evaluate(() => qaEditor.addEventListener('paste', event => {
        event.preventDefault(); event.stopImmediatePropagation();
      }, { capture: true }));
      const native = await nativeSession(page);
      const result = await native.perform('field', { text: 'First\n\nLast', submit: true });
      assert.equal(result.success, false);
      assert.equal(result.verified, false);
      assert.equal(result.outcomeUnknown, true);
      assert.equal(result.retryable, false);
      assert.equal(result.submitted, false);
      assert.equal(await page.evaluate(() => qaModelText), 'Original');
      assert.deepEqual(result.readback, { compared: true, reader: 'semantic' }, 'The editor model holds another document: a known mismatch.');
      assert.equal(native.commands.some(command => command.method === 'input.performActions'), false);
      assert.equal(native.declarations.filter(source => source.includes("new view.ClipboardEvent('paste'")).length, 1);
    });
  } finally { await browser.close(); }
});

test('Firefox: ProseMirror paste retains complete document and original selection ownership', async t => {
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const shape of ['hidden text', 'opaque inline node', 'noneditable node', 'unsupported block']) await t.test(`unsupported preflight: ${shape}`, async () => {
      await loadProseMirror(page, 'Original');
      await page.evaluate(shape => {
        // Preserve the unsupported rendered document until the production
        // preflight reads it; PM would otherwise normalize this external edit.
        qaEditorView.domObserver.stop();
        const node = document.createElement(shape === 'opaque inline node' ? 'img' : shape === 'unsupported block' ? 'h2' : 'span');
        if (shape === 'hidden text') node.hidden = true;
        if (shape === 'noneditable node') node.contentEditable = 'false';
        if (node.tagName !== 'IMG') node.textContent = 'Unverified';
        (shape === 'unsupported block' ? qaEditor : qaEditor.firstChild).append(node);
      }, shape);
      const native = await nativeSession(page);
      await assert.rejects(native.perform('field', { text: 'Replacement', submit: true }), error => {
        assert.equal(error.dispatchState.noDispatch, true);
        assert.match(error.message, /exact document text/);
        return true;
      });
      assert.equal(native.commands.length, 0);
      assert.deepEqual(await page.evaluate(() => qaPastes), []);
    });
    for (const drift of ['selection', 'paragraph identity', 'editor identity', 'document root', 'focus', 'Stop']) await t.test(`changed before paste: ${drift}`, async () => {
      await loadProseMirror(page, 'Original');
      const native = await nativeSession(page);
      const originalCall = native.session.call;
      native.session.call = async (...args) => {
        const result = await originalCall(...args);
        if (args[3] === 'root') {
          if (drift === 'Stop') native.session.runs.delete(native.runId);
          else await page.evaluate(drift => {
            if (drift === 'selection') getSelection().collapse(qaEditor.firstChild.firstChild, 1);
            else if (drift === 'paragraph identity') qaEditor.firstChild.replaceWith(qaEditor.firstChild.cloneNode(true));
            else if (drift === 'editor identity') qaEditor.replaceWith(qaEditor.cloneNode(true));
            else if (drift === 'document root') {
              const host = document.createElement('div'); document.body.append(host);
              host.attachShadow({ mode: 'open' }).append(qaEditor); qaEditor.focus();
            } else { const input = document.createElement('input'); document.body.append(input); input.focus(); }
          }, drift);
        }
        return result;
      };
      await assert.rejects(native.perform('field', { text: 'Replacement', submit: true }), error => {
        assert.equal(error.dispatchState.noDispatch, true);
        return true;
      });
      assert.deepEqual(await page.evaluate(() => qaPastes), []);
      assert.equal(native.commands.some(command => command.method === 'input.performActions'), false);
      assert.equal(await page.evaluate(() => qaNativeHandles.size), 0);
    });
    await t.test('loss of the exact document after one paste remains uncertain', async () => {
      await loadProseMirror(page);
      await page.evaluate(() => qaEditor.addEventListener('paste', () => setTimeout(() => qaEditor.classList.remove('ProseMirror'), 15)));
      const native = await nativeSession(page);
      const result = await native.perform('field', { text: 'First\nLast', submit: true });
      assert.equal(result.verified, false);
      assert.equal(result.submitted, false);
      assert.equal(result.outcomeUnknown, true);
      assert.equal(result.retryable, false);
      assert.deepEqual(result.readback, { compared: false, reason: 'readback_unavailable' }, 'An unreadable document is not a known mismatch.');
      assert.equal(await page.evaluate(() => qaModelText), 'First\nLast');
      assert.deepEqual(await page.evaluate(() => qaPastes), ['First\nLast']);
      assert.equal(native.commands.some(command => command.method === 'input.performActions'), false);
    });
  } finally { await browser.close(); }
});

test('Firefox: actual WebDriver BiDi retains private ProseMirror selection handles through complete edits', { timeout: 30000 }, async () => {
  const temporaryRoot = await realpath(tmpdir());
  const profile = await mkdtemp(join(temporaryRoot, 'webbrain-pm-bidi-test-'));
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/editor.js' ? 'application/javascript' : 'text/html');
    response.end(request.url === '/editor.js' ? proseMirrorBundle
      : '<style>.ProseMirror{height:180px;white-space:pre-wrap}.ProseMirror p{margin:0}</style>'
        + '<main><div id="editor-host"></div><button id="publish">Post</button></main>'
        + '<script src="/editor.js"></script><script>qaEditorLibrary.mountEditor();window.qaPastes=[];'
        + 'qaEditorView.dom.addEventListener("paste",event=>qaPastes.push(event.clipboardData.getData("text/plain")))</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const child = spawn(firefox.executablePath(), ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0', url],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  const session = new BidiSession();
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Firefox did not start its native BiDi endpoint')), 10000);
      let output = '';
      child.stderr.on('data', data => {
        output += data;
        const match = output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    await session.connect(port);
    let context;
    const startupDeadline = Date.now() + 10000;
    while (!context && Date.now() < startupDeadline) {
      const tree = await session.send('browsingContext.getTree', {});
      context = tree.contexts.find(item => item.url === url)?.context;
      if (!context) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(context, 'The isolated native Firefox profile must open its local test page.');
    await session.send('browsingContext.navigate', { context, url, wait: 'complete' });
    const evaluate = async expression => {
      const response = await session.send('script.evaluate', { target: { context }, expression, awaitPromise: true });
      assert.notEqual(response.type, 'exception', response.exceptionDetails?.text);
      return response.result;
    };
    const mark = async selector => {
      const token = crypto.randomUUID();
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).setAttribute('data-webbrain-bidi', ${JSON.stringify(token)})`);
      return { token, url };
    };
    const runId = crypto.randomUUID(), binding = await mark('#editor-host');
    await session.openRun(runId, binding.token, binding.url);
    for (const [action, text, expected] of [
      ['field', 'Original\nlast', 'Original\nlast'],
      ['type', '\n\nAnother\n', 'Original\nlast\n\nAnother\n'],
      ['field', '  Türkçe 🧠 <b>literal</b>\r\nNext\r\n', '  Türkçe 🧠 <b>literal</b>\nNext\n'],
      ['field', '', ''],
    ]) {
      const result = await session.perform(runId, action, { ...await mark('.ProseMirror'), text });
      assert.equal(result.verified, true, JSON.stringify(result));
      assert.equal((await evaluate('qaModelText')).value, expected);
    }
    assert.deepEqual(JSON.parse((await evaluate('JSON.stringify(qaPastes)')).value),
      ['Original\nlast', '\n\nAnother\n', '  Türkçe 🧠 <b>literal</b>\nNext\n']);
  } finally {
    await session.close().catch(() => {});
    child.kill(); await exited;
    await new Promise(resolve => server.close(resolve));
    const resolved = await realpath(profile);
    assert.equal(dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
    assert.ok(basename(resolved).startsWith('webbrain-pm-bidi-test-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
