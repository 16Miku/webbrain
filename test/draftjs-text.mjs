// Replays the real X DraftJS markup without opening a browser or an account.
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = { storage: { local: area, session: area },
  runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://x.com/compose/post' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] } };
globalThis.chrome = api; globalThis.browser = api;
const { Agent } = await import('../src/chrome/src/agent/agent.js');
const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
const doc = { defaultView: { getComputedStyle: node => ({ display: 'inline', visibility: 'visible',
  opacity: '1', contentVisibility: 'visible', ...node.style }) } };
const textNode = value => ({ nodeType: 3, nodeValue: value });
function element(tagName, attrs = {}, childNodes = []) {
  return { nodeType: 1, tagName, childNodes, ownerDocument: doc, isConnected: true,
    isContentEditable: true, style: {}, hidden: false, shadowRoot: null,
    getAttribute: name => Object.hasOwn(attrs, name) ? attrs[name] : null,
    classList: { contains: name => String(attrs.class || '').split(/\s+/).includes(name) },
    get children() { return this.childNodes.filter(node => node.nodeType === 1); },
    get firstElementChild() { return this.children[0] || null; },
    get textContent() { return this.childNodes.map(node => node.nodeType === 3 ? node.nodeValue : node.textContent).join(''); },
    focus() { doc.activeElement = this; }, dispatchEvent: () => true,
    contains(node) { return node === this || this.children.some(child => child.contains(node)); },
    querySelector: () => null, getBoundingClientRect: () => ({ x: 10, y: 20, width: 300, height: 90 }),
  };
}
const leaf = value => element('SPAN', { 'data-text': 'true' }, [textNode(value)]);
function draft(lines = [''], { styledUrl = false, raw = lines.join('\n') } = {}) {
  const blocks = lines.map((value, index) => {
    const key = `block${index}-0-0`;
    let leaves = value ? [element('SPAN', { 'data-offset-key': key }, [leaf(value)])]
      : [element('SPAN', { 'data-offset-key': key }, [element('BR', { 'data-text': 'true' })])];
    if (styledUrl && value) {
      const split = value.indexOf('https://');
      assert(split >= 0);
      leaves = [element('SPAN', { 'data-offset-key': key }, [leaf(value.slice(0, split))]),
        element('SPAN', { style: 'color: rgb(29, 155, 240)' }, [
          element('SPAN', { 'data-offset-key': `block${index}-1-0` }, [leaf(value.slice(split))]),
        ])];
    }
    return element('DIV', { 'data-block': 'true', 'data-editor': '5enet', 'data-offset-key': key }, [
      element('DIV', { 'data-offset-key': key, class: 'public-DraftStyleDefault-block public-DraftStyleDefault-ltr' }, leaves),
    ]);
  });
  const editor = element('DIV', { contenteditable: 'true', role: 'textbox' }, [element('DIV', { 'data-contents': 'true' }, blocks)]);
  editor.innerText = raw; return editor;
}
function caret(wrappers = []) {
  let node = element('BR');
  for (const tag of [...wrappers].reverse()) node = element(tag, {}, [node]);
  const editor = element('DIV', { contenteditable: 'true' }, [node]);
  editor.innerText = '\n'; return editor;
}
function typeIntoCaret(editor, value) {
  let parent = editor;
  while (parent.firstElementChild?.tagName !== 'BR') parent = parent.firstElementChild;
  parent.childNodes = [textNode(value)]; editor.innerText = value;
}
function functionSource(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const indent = source.slice(source.lastIndexOf('\n', start) + 1, start);
  const end = source.indexOf(`\n${indent}}`, start) + indent.length + 2;
  assert(end > start, name); return source.slice(start, end);
}
function handlerSource(source, action) {
  const start = source.indexOf(`'${action}':`);
  const end = source.indexOf('\n      },', start);
  assert(start >= 0 && end > start, action);
  return source.slice(source.indexOf(':', start) + 1, end + 8).trim();
}
function contentHarness(build, current) {
  const source = fs.readFileSync(`src/${build}/src/content/content.js`, 'utf8');
  const ownInputScope = source.match(/^  let _messageRecipientOwnedInputScope = null;$/m)?.[0];
  assert.ok(ownInputScope, 'Use the real private production owned-input scope');
  const names = ['_setFieldValueMatches', 'readProseMirrorText', 'readEmptyCaretText', 'isDraftJsEditor', 'readDraftJsText',
    '_nativeChatCaretContext', '_sameNativeChatCaretContext', '_singleEditableCaretBreak',
    '_rememberNativeChatEmptyCaret', '_nativeChatCaretValueIsEmpty', '_editableTextValue', '_insertContentEditableText'];
  if (build === 'chrome') names.unshift('_contentEditableValueMatches');
  let selectedRange = null;
  doc.defaultView.getSelection = () => ({ get rangeCount() { return selectedRange ? 1 : 0; },
    removeAllRanges() { selectedRange = null; }, addRange(range) { selectedRange = range; }, getRangeAt() { return selectedRange; } });
  doc.createRange = () => ({ startContainer: null, endContainer: null, startOffset: 0, endOffset: 0,
    selectNodeContents(node) { this.startContainer = this.endContainer = node; this.endOffset = node.childNodes.length; },
    collapse() { this.startOffset = this.endOffset; }, cloneRange() { return { ...this }; } });
  doc.execCommand = (command, _ui, value) => {
    if (command === 'insertHTML') value = value.replace(/^<span style="white-space: pre-wrap">|<\/span>$/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    if (command === 'insertText' || command === 'insertHTML') current.onInsert?.(current.editor, value);
    return true;
  };
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, Uint8Array,
    _nativeChatEmptyCaretReceipts: new WeakMap(), InputEvent: class { constructor(type, data) { Object.assign(this, { type }, data); } },
    window: { __wb_ax_lookup: () => current.editor }, msg: { params: {} },
    actionDeadlineExpired: () => false, _scrollElementIntoClearView() {}, showAgentWorkingTarget() {},
    _fieldMeta: () => ({ tag: 'div', contentEditable: true, role: 'textbox', ariaLabel: 'Post text' }),
    _stableFieldSelector: () => '#editor',
    SET_FIELD_VERIFY_DELAY_MS: 0, setTimeout: resolve => resolve(),
    document: doc,
  });
  vm.runInContext(`${ownInputScope}\n${names.map(name => functionSource(source, name)).join('\n')}`, context);
  const handlers = Object.fromEntries(['type_ax', 'set_field', 'ax_verify_field_value', 'field_value_digest']
    .map(action => [action, vm.runInContext(`(${handlerSource(source, action)})`, context)]));
  return { read: editor => { context.el = editor; return vm.runInContext('_editableTextValue(el)', context); },
    semantic: editor => { context.el = editor; return vm.runInContext('readDraftJsText(el)', context); },
    matches: (actual, expected) => { context.actual = actual; context.expected = expected;
      return vm.runInContext('_setFieldValueMatches(actual, "", expected, true, true, true)', context); },
    async call(action, params = {}) { context.msg = { params }; return handlers[action](); },
  };
}
const tweet = "Hidden gem on HF: AveLabs grafted Qwen3.8-27B's language head back onto Perplexity's pplx-decider-v1-27b. One set of weights handles both typed decisions and full chat on one server. https://huggingface.co/AveLabs/Qwen3.8-27B-Perplexing-Pegasus-NVFP4";

for (const build of ['chrome', 'firefox']) {
  if (build === 'firefox') test('Firefox: settled DraftJS write proof rejects unsupported reconciliation', async t => {
    for (const action of ['type_ax', 'set_field']) await t.test(action, async () => {
      let attempts = 0;
      const current = { editor: draft([''], { raw: '\n' }), onInsert(editor, value) {
        attempts++;
        const typed = draft([value]); editor.childNodes = typed.childNodes; editor.innerText = value;
        const suffix = leaf(' hidden suffix'); suffix.style.display = 'none';
        editor.firstElementChild.firstElementChild.firstElementChild.childNodes.push(suffix);
      } }, h = contentHarness(build, current);
      const result = await h.call(action, { ref_id: 'ref_42', text: 'body', clear: false });
      assert.equal(attempts, 1); assert.equal(result.success, false); assert.equal(result.verified, false);
      assert.equal(result.dispatched, true); assert.equal(result.recoveryRequired, 'verify_or_restore_field');
      assert.equal(h.read(current.editor), 'body', 'The visible matching prefix remains observation-only');
    });
  });

  test(`${build}: unmarked single breaks retain literal text without empty-placeholder provenance`, async () => {
    const current = { editor: caret() }, h = contentHarness(build, current);
    for (const wrappers of [[], ['DIV'], ['P'], ['SPAN'], ['DIV', 'SPAN']]) {
      current.editor = caret(wrappers);
      assert.equal(h.read(current.editor), '\n');
      const verification = await h.call('ax_verify_field_value', { ref_id: 'ref_42', expected: '' });
      assert.equal(verification.verified, false);
      const digest = await h.call('field_value_digest', { ref_id: 'ref_42', expected: '' });
      assert.equal(digest.verified, false); assert.equal(digest.valueLength, 1);
      assert.equal(digest.valueSha256, createHash('sha256').update('\n').digest('hex'));
    }
    for (const kind of ['two-breaks', 'two-blocks', 'space', 'text-newline', 'hidden', 'embed', 'extra-empty-sibling']) {
      const editor = caret();
      if (kind === 'two-breaks') { editor.childNodes.push(element('BR')); editor.innerText = '\n\n'; }
      if (kind === 'two-blocks') { editor.childNodes = [element('DIV', {}, [element('BR')]), element('DIV', {}, [element('BR')])]; editor.innerText = '\n\n\n'; }
      if (kind === 'space') { editor.childNodes.unshift(textNode(' ')); editor.innerText = ' \n'; }
      if (kind === 'text-newline') editor.childNodes = [textNode('\n')];
      if (kind === 'hidden') editor.firstElementChild.style.visibility = 'hidden';
      if (kind === 'embed') editor.childNodes = [element('IMG')];
      if (kind === 'extra-empty-sibling') editor.childNodes.push(element('SPAN'));
      assert.equal(h.read(editor), editor.innerText, kind);
    }
  });

  test(`${build}: DraftJS exact field verification and digest use document blocks`, async t => {
    const current = { editor: draft([''], { raw: '\n' }) }, h = contentHarness(build, current);
    for (const lines of [[''], ['a'], ['', 'a'], ['a', ''], ['a', '', 'b'], ['a', '', '', 'b'], [' Leading ', 'line ', ''], ['a\nb'], ['①\u00a0b'], [tweet]]) {
      await t.test(JSON.stringify(lines), async () => {
        const expected = lines.join('\n'); current.editor = draft(lines, { raw: 'visual spacing differs', styledUrl: expected === tweet });
        assert.equal(h.read(current.editor), expected);
        const verified = await h.call('ax_verify_field_value', { ref_id: 'ref_42', expected });
        assert.equal(verified.verified, true);
        assert.equal((await h.call('ax_verify_field_value', { ref_id: 'ref_42', expected: expected + ' ' })).verified, false);
        assert.equal((await h.call('ax_verify_field_value', { ref_id: 'ref_42', expected: expected.replace(/\n/g, '\r\n') })).verified, true);
        const digest = await h.call('field_value_digest', { ref_id: 'ref_42', expected });
        assert.equal(digest.verified, true); assert.equal(digest.valueLength, expected.length);
        assert.equal(digest.valueSha256, createHash('sha256').update(expected).digest('hex'));
      });
    }
    current.editor = draft([''], { raw: '\n' });
    assert.equal(h.read(current.editor), '');
    current.editor = draft(['a', '', 'b'], { raw: 'a\n\n\nb' });
    assert.equal((await h.call('ax_verify_field_value', { ref_id: 'ref_42', expected: 'a\n\n\nb' })).verified, false,
      'Semantic blocks must not borrow Chromium visual newline-expansion tolerance');
    current.editor = draft([' Existing ', '']);
    const suffix = 'suffix';
    const expectedAppend = h.read(current.editor) + suffix;
    current.editor = draft([' Existing ', suffix]);
    assert.equal((await h.call('ax_verify_field_value', { ref_id: 'ref_42', expected: expectedAppend, appendText: suffix })).verified, true);
    current.editor = draft(['Existing', suffix]);
    assert.equal((await h.call('ax_verify_field_value', { ref_id: 'ref_42', expected: expectedAppend, appendText: suffix })).verified, false,
      'A preserved prefix cannot lose literal spaces');
    current.editor = draft(['①\u00a0b']);
    assert.equal((await h.call('ax_verify_field_value', { ref_id: 'ref_42', expected: '1 b' })).verified, false,
      'AX Unicode and whitespace normalization cannot supply exact write evidence');
  });

  test(`${build}: unknown DraftJS structures retain the rendered fallback`, async t => {
    const current = { editor: draft(['body']) }, h = contentHarness(build, current);
    for (const kind of ['embed', 'hidden-leaf', 'hidden-suffix', 'hidden-attribute', 'aria-hidden', 'noneditable', 'shadow', 'mixed-br', 'generic-text', 'unknown-block', 'depth-budget', 'node-budget', 'leading-sibling', 'wrapped-contents', 'mixed-prosemirror']) {
      await t.test(kind, async () => {
        const editor = draft(['body'], { raw: 'rendered fallback' });
        const body = editor.firstElementChild.firstElementChild.firstElementChild;
        if (kind === 'embed') body.childNodes.push(element('IMG', { alt: 'attachment' }));
        if (kind === 'hidden-leaf') body.firstElementChild.style.visibility = 'hidden';
        if (kind === 'hidden-suffix') { const suffix = leaf(' hidden suffix'); suffix.style.display = 'none'; body.childNodes.push(suffix); }
        if (kind === 'hidden-attribute') body.firstElementChild.hidden = true;
        if (kind === 'aria-hidden') body.childNodes.push(element('SPAN', { 'aria-hidden': 'TRUE' }, [leaf('hidden')]));
        if (kind === 'noneditable') body.childNodes.push(element('SPAN', { contenteditable: 'FALSE' }, [leaf('entity')]));
        if (kind === 'shadow') body.firstElementChild.shadowRoot = {};
        if (kind === 'mixed-br') body.childNodes.push(element('BR', { 'data-text': 'true' }));
        if (kind === 'generic-text') body.childNodes.push(textNode('unstructured'));
        if (kind === 'unknown-block') editor.firstElementChild.childNodes.push(element('P', {}, [leaf('unexpected')]));
        if (kind === 'depth-budget') for (let i = 0; i < 34; i++) body.childNodes = [element('SPAN', {}, body.childNodes)];
        if (kind === 'node-budget') body.childNodes = Array.from({ length: 4096 }, () => leaf('x'));
        if (kind === 'leading-sibling') editor.childNodes.unshift(element('SPAN', {}, [textNode('before contents')]));
        if (kind === 'wrapped-contents') {
          editor.classList = { contains: name => name === 'public-DraftEditor-content' };
          editor.childNodes = [element('DIV', {}, editor.childNodes)];
        }
        if (kind === 'mixed-prosemirror') {
          editor.classList = { contains: name => ['public-DraftEditor-content', 'ProseMirror'].includes(name) };
          editor.childNodes = [element('P', {}, [textNode('rendered fallback')])];
        }
        assert.equal(h.semantic(editor), null); assert.equal(h.read(editor), 'rendered fallback');
        current.editor = editor;
        const verified = await h.call('ax_verify_field_value', { ref_id: 'ref_42', expected: editor.innerText });
        assert.equal(verified.verified, false, 'Rendered fallback cannot establish exact text evidence');
        const digest = await h.call('field_value_digest', { ref_id: 'ref_42', expected: editor.innerText });
        assert.equal(digest.success, false); assert.equal(digest.valueSha256, undefined);
        for (const action of ['type_ax', 'set_field']) for (const bidi of [false, true]) {
          const typed = await h.call(action, { ref_id: 'ref_42', text: editor.innerText, clear: true, ...(bidi ? { _bidiPrepare: {} } : {}) });
          assert.equal(typed.noDispatch, true, `${action}/${bidi}`); assert.equal(typed._expectedValue, undefined);
        }
      });
    }
  });

  test(`${build}: publication uses the same exact DraftJS body`, () => {
    const source = fs.readFileSync(`src/${build}/src/agent/agent.js`, 'utf8');
    const start = source.indexOf('const publicationEditorText = editor => {');
    const end = source.indexOf('\n    const publicationComposerSnapshot', start);
    const snapshotEnd = source.indexOf('\n    const transactionOrderSite', end);
    const { read, snapshot: capture } = vm.runInNewContext(`(() => {
      const host = 'x.com', url = 'https://x.com/compose/post', isVisible = () => true;
      ${functionSource(source, 'readProseMirrorText')}; ${functionSource(source, 'readEmptyCaretText')}; ${functionSource(source, 'isDraftJsEditor')}; ${functionSource(source, 'readDraftJsText')};
      ${source.slice(start, snapshotEnd)}; return { read: publicationEditorText, snapshot: publicationComposerSnapshot }; })()`);
    const snapshot = editor => {
      const root = { querySelectorAll: selector => selector.startsWith('textarea,') ? [editor] : [], querySelector: () => null };
      editor.parentElement = root; editor.contains = () => false;
      return capture(root, { complete: true, identity: 'twitter:alice' });
    };
    assert.equal(read(draft([''], { raw: '\n' })), '');
    for (const wrappers of [[], ['DIV', 'SPAN']]) assert.equal(read(caret(wrappers)), '\n');
    assert.equal(read(draft([' Leading ', '', 'line ', ''], { raw: 'visual spacing' })), ' Leading \n\nline \n');
    assert.equal(read(draft([tweet], { styledUrl: true })), tweet);
    const publishedBody = snapshot(draft([tweet], { styledUrl: true }));
    assert.equal(publishedBody.complete, true); assert.equal(publishedBody.posts[0].bodyText, tweet);
    const unknown = draft(['body'], { raw: 'rendered embed' });
    unknown.firstElementChild.firstElementChild.firstElementChild.childNodes.push(element('IMG'));
    assert.equal(read(unknown), null, 'Unknown embeds cannot become publication-body evidence');
    assert.equal(snapshot(unknown).complete, false);
    const hidden = draft(['body'], { raw: 'body' });
    const suffix = leaf(' hidden suffix'); suffix.style.display = 'none';
    hidden.firstElementChild.firstElementChild.firstElementChild.childNodes.push(suffix);
    assert.equal(read(hidden), null, 'A matching visible prefix cannot hide unverified document text');
    assert.equal(snapshot(hidden).complete, false);
    const overBudget = draft(['body'], { raw: 'body' });
    overBudget.firstElementChild.firstElementChild.firstElementChild.childNodes = Array.from({ length: 4096 }, () => leaf('x'));
    assert.equal(read(overBudget), null);
    assert.equal(snapshot(overBudget).complete, false);
    const mixed = draft(['body'], { raw: 'body' });
    mixed.classList = { contains: name => ['public-DraftEditor-content', 'ProseMirror'].includes(name) };
    mixed.childNodes = [element('P', {}, [textNode('body')])];
    assert.equal(read(mixed), null); assert.equal(snapshot(mixed).complete, false);
  });
}

test('Chrome: native appends preserve strong empty-editor proof and do not retry ambiguous literal prefix loss', async t => {
  for (const mode of ['draftjs', 'direct-caret', 'wrapped-caret']) await t.test(mode, async () => {
    const current = { editor: mode === 'draftjs' ? draft([''], { raw: '\n' }) : caret(mode === 'direct-caret' ? [] : ['DIV', 'SPAN']) }, h = contentHarness('chrome', current);
    let nativeInsertions = 0;
    current.onInsert = (editor, text) => {
      nativeInsertions++;
      if (mode === 'draftjs') {
        const next = draft([text], { styledUrl: true }); editor.childNodes = next.childNodes; editor.innerText = next.innerText;
      } else typeIntoCaret(editor, text);
    };
    const args = { ref_id: 'ref_42', text: tweet, clear: false };
    const oldMessage = api.tabs.sendMessage, oldAttach = cdpClient.attach, oldSend = cdpClient.sendCommand;
    const agent = new Agent({}); const commands = [];
    agent._lastAxScopes.set(41, { documentToken: 'doc', pageUrl: 'https://x.com/compose/post' });
    api.tabs.sendMessage = async (_tab, message) => {
      if (message.action === 'ax_prepare_field_for_trusted_type') return { success: true, contentEditable: true, rect: { x: 10, y: 20, w: 300, h: 90 } };
      const result = await h.call(message.action, message.params);
      return { ...result, documentToken: 'doc', refScopeUrl: 'https://x.com/compose/post' };
    };
    cdpClient.attach = async () => ({});
    cdpClient.sendCommand = async (_tab, method, params) => {
      commands.push(method);
      if (method === 'Input.insertText') {
        if (mode === 'draftjs') current.editor = draft([params.text], { styledUrl: true });
        else typeIntoCaret(current.editor, params.text);
      }
      return {};
    };
    try {
      const initial = await h.call('type_ax', args);
      assert.equal(initial.dispatched, true); assert.equal(initial.success, mode === 'draftjs');
      assert.equal(nativeInsertions, 1, 'The native insertion runs once.');
      const typed = await agent._maybeFallbackFieldWithCdp(41, 'type_ax', args, initial);
      assert.equal(typed.success, mode === 'draftjs'); assert.equal(typed.verified, mode === 'draftjs');
      const finalized = await agent._finalizeTextMutationResult(41, 'type_ax', args, typed);
      assert.equal(finalized.success, mode === 'draftjs'); assert.equal(agent._uncertainTextMutations.has(41), mode !== 'draftjs');
      assert.equal(commands.filter(method => method === 'Input.insertText').length, 0,
        'An already dispatched native write must not be replayed through CDP.');
      assert.equal(h.read(current.editor), tweet);
    } finally { api.tabs.sendMessage = oldMessage; cdpClient.attach = oldAttach; cdpClient.sendCommand = oldSend; }
  });
});

test('Chrome: CDP selector and node readback preserve DraftJS blocks and exact append signatures', async () => {
  let editor = draft([''], { raw: '\n' });
  const originalEvaluate = cdpClient.evaluate, originalSend = cdpClient.sendCommand;
  const evaluate = code => vm.runInNewContext(code, { document: { querySelector: () => editor }, NodeFilter: { SHOW_ELEMENT: 1 } });
  cdpClient.evaluate = async (_tab, code) => ({ result: { value: evaluate(code) } });
  cdpClient.sendCommand = async (_tab, method, params) => {
    if (method === 'DOM.enable' || method === 'Runtime.releaseObject') return {};
    if (method === 'DOM.resolveNode') return { object: { objectId: 'editor' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: vm.runInNewContext(`(${params.functionDeclaration})`)
      .call(editor, ...(params.arguments || []).map(argument => argument.value)) } };
    throw new Error(method);
  };
  try {
    for (const target of [{ selector: '#editor' }, { nodeId: 1 }]) {
      for (const wrappers of [[], ['DIV', 'SPAN']]) {
        editor = caret(wrappers);
        const emptySignature = await cdpClient.textEntrySignature(41, target);
        assert.notEqual(emptySignature, '0:811c9dc5');
        assert.equal(await cdpClient.verifyTextEntry(41, { ...target, text: '', clear: true }), null);
        typeIntoCaret(editor, 'abc');
        assert.equal(await cdpClient.verifyTextEntry(41, { ...target, text: 'abc', beforeSignature: emptySignature }), null,
          'A vanished literal prefix must not verify as a successful append.');
      }
      editor = draft([''], { raw: '\n' }); const beforeSignature = await cdpClient.textEntrySignature(41, target);
      assert.equal(beforeSignature, '0:811c9dc5');
      editor = draft([tweet], { styledUrl: true });
      assert.equal(await cdpClient.verifyTextEntry(41, { ...target, text: tweet, beforeSignature }), true);
      editor = draft([' Leading ', '', 'line ', ''], { raw: 'visual spacing' });
      const expected = ' Leading \n\nline \n';
      assert.equal(await cdpClient.verifyTextEntry(41, { ...target, text: expected, clear: true }), true);
      assert.equal(await cdpClient.verifyTextEntry(41, { ...target, text: expected + ' ', clear: true }), null);
      const signature = await cdpClient.textEntrySignature(41, target);
      editor = draft([' Leading ', '', 'line ', ' suffix']);
      assert.equal(await cdpClient.verifyTextEntry(41, { ...target, text: ' suffix', beforeSignature: signature }), true);
      for (const kind of ['embed', 'hidden-suffix', 'over-budget', 'leading-sibling', 'wrapped-contents', 'mixed-prosemirror']) {
        editor = draft(['body'], { raw: 'body' });
        const body = editor.firstElementChild.firstElementChild.firstElementChild;
        if (kind === 'embed') body.childNodes.push(element('IMG'));
        if (kind === 'hidden-suffix') { const suffix = leaf(' hidden suffix'); suffix.style.display = 'none'; body.childNodes.push(suffix); }
        if (kind === 'over-budget') body.childNodes = Array.from({ length: 4096 }, () => leaf('x'));
        if (kind === 'leading-sibling') editor.childNodes.unshift(element('SPAN', {}, [textNode('before contents')]));
        if (kind === 'wrapped-contents') {
          editor.classList = { contains: name => name === 'public-DraftEditor-content' };
          editor.childNodes = [element('DIV', {}, editor.childNodes)];
        }
        if (kind === 'mixed-prosemirror') {
          editor.classList = { contains: name => ['public-DraftEditor-content', 'ProseMirror'].includes(name) };
          editor.childNodes = [element('P', {}, [textNode('body')])];
        }
        assert.equal(await cdpClient.textEntrySignature(41, target), null, kind);
        assert.equal(await cdpClient.verifyTextEntry(41, { ...target, text: 'body', clear: true }), null, kind);
      }
    }
  } finally { cdpClient.evaluate = originalEvaluate; cdpClient.sendCommand = originalSend; }
});
