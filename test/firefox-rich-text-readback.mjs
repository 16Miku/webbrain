import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { firefox } from 'playwright';
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
  session.call = async (_match, declaration, args = []) => {
    declarations.push(declaration);
    const value = await page.evaluate(({ declaration, args }) => {
      const fn = (0, eval)(`(${declaration})`);
      return fn(window.qaEditor, ...args.map(arg => arg.value ?? null));
    }, { declaration, args });
    if (value && typeof value === 'object') {
      return { result: { type: 'object', value: Object.entries(value).map(([name, item]) => [name, { type: typeof item, value: item }]) } };
    }
    return { result: value === null ? { type: 'null' } : { value } };
  };
  const keys = new Map([['\uE009', 'Control'], ['\uE03D', 'Meta'], ['\uE003', 'Backspace'], ['\uE007', 'Enter']]);
  const held = new Set();
  session.send = async (method, params) => {
    commands.push({ method, params });
    if (method === 'input.releaseActions') {
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
    commands, declarations,
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
        const declaration = native.declarations.find(source => source.includes('const actual = readRichTextFieldValue'));
        const readback = expected => page.evaluate(({ declaration, expected }) => (0, eval)(`(${declaration})`)(qaEditor, expected), { declaration, expected });
        assert.equal(await readback('First\r\n\r\nLast suffix'), true, 'CRLF normalization preserves authored document separators.');
        assert.equal(await readback('First\n\n\nLast suffix'), false, 'Visual spacing cannot excuse an extra authored line break.');
      }
    });
  } finally { await browser.close(); }
});

async function installOwnedMonitor(page) {
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
      qaEnterDocuments.push(qaModel); event.preventDefault(); event.stopImmediatePropagation();
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
  const fence = await page.evaluate(async () => {
    const snapshot = await qaDeliver('page_monitor_capture_model', { includeTree: true });
    const prepared = await qaDeliver('page_monitor_prepare', {
      operationId: 'owned-multiline-edit', tool: 'type_text', selector: '.public-DraftEditor-content',
      expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true,
    });
    const fence = await qaDeliver('page_monitor_dispatch', { operationId: 'owned-multiline-edit', kind: 'input', fenceOnly: true });
    qaFeedback = [];
    return { prepared, fence };
  });
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
      { name: 'ProseMirror empty caret', html: '<div id="editor" contenteditable class="ProseMirror"><p><br class="ProseMirror-trailingBreak"></p></div>', text: 'body', expected: 'body' },
      { name: 'ProseMirror document separators', html: '<div id="editor" contenteditable class="ProseMirror"><p>First</p><p>Last</p></div>', text: ' suffix', expected: 'First\nLast suffix' },
      { name: 'ordinary visual paragraph spacing', html: '<div id="editor" contenteditable><p>First</p><p>Last</p></div>', text: ' suffix', expected: 'First\n\nLast suffix' },
      { name: 'ordinary authored spaces', html: '<div id="editor" contenteditable style="white-space:pre-wrap">  Existing  </div>', text: '  suffix  ', expected: '  Existing    suffix  ' },
      { name: 'plain input value', html: '<input id="editor" value="Existing">', text: ' suffix', expected: 'Existing suffix' },
    ]) await t.test(scenario.name, async () => {
      await page.setContent(scenario.html);
      await page.evaluate(() => { window.qaEditor = document.querySelector('#editor'); });
      const native = await nativeSession(page);
      const result = await native.perform('type', { text: scenario.text });
      assert.equal(result.verified, true, JSON.stringify(result));
      const state = await page.evaluate(() => ({ text: qaEditor.isContentEditable ? qaEditor.innerText : qaEditor.value, children: qaEditor.childNodes.length }));
      if (scenario.name === 'ProseMirror document separators') assert.equal(state.text, 'First\n\nLast suffix');
      else assert.equal(state.text, scenario.expected);
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
      const keyDowns = native.commands.filter(command => command.method === 'input.performActions')
        .flatMap(command => command.params.actions[0].actions.filter(action => action.type === 'keyDown').map(action => action.value));
      assert.equal(keyDowns.includes('\uE007'), false, 'Literal LF insertion cannot send a submit shortcut.');
      assert.equal(keyDowns.filter(value => !['\uE009', '\uE03D', '\uE003'].includes(value)).join(''), 'a', 'No characters or submission follow the ambiguous paste.');
      assert.equal(native.declarations.filter(source => source.includes("new view.ClipboardEvent('paste'")).length, 1, 'Verification must not repeat an ambiguous paste.');
    });
  } finally { await browser.close(); }
});
