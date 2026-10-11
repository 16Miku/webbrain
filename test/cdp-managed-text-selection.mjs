import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

// Real ProseMirror transactions and trusted Chromium input exercise the whole
// replacement path, including application model readback after native input.
const bundle = (await build({ stdin: { resolveDir: process.cwd(), contents: `
  import { Schema } from 'prosemirror-model';
  import { EditorState, TextSelection } from 'prosemirror-state';
  import { EditorView } from 'prosemirror-view';
  import { keymap } from 'prosemirror-keymap';
  import { baseKeymap } from 'prosemirror-commands';
  const schema = new Schema({ nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: { group: 'block', content: 'inline*', toDOM: () => ['h2', 0] },
    blockquote: { group: 'block', content: 'block+', toDOM: () => ['blockquote', 0] },
    bullet_list: { group: 'block', content: 'list_item+', toDOM: () => ['ul', 0] },
    list_item: { content: 'paragraph block*', toDOM: () => ['li', 0] },
    image: { inline: true, group: 'inline', atom: true, toDOM: () => ['img', { alt: 'Owned image', width: 20, height: 20 }] },
    hard_break: { inline: true, group: 'inline', selectable: false, toDOM: () => ['br'] },
    text: { group: 'inline' },
  } });
  window.qaMount = (json, partial = null) => {
    window.qaView?.destroy();
    document.querySelector('#host').replaceChildren();
    window.qaView = new EditorView(document.querySelector('#host'), {
      state: EditorState.create({ schema, doc: schema.nodeFromJSON(json), plugins: [keymap(baseKeymap)] }),
      dispatchTransaction(transaction) { this.updateState(this.state.apply(transaction)); },
      handleKeyDown(view, event) {
        if (!partial || event.code !== 'KeyA' || !(event.ctrlKey || event.metaKey)) return false;
        event.preventDefault();
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, partial.from, partial.to)));
        return true;
      },
    });
    window.qaEvents = [];
    qaView.dom.addEventListener('input', event => qaEvents.push({ trusted: event.isTrusted, inputType: event.inputType }));
  };
  window.qaSnapshot = () => ({ doc: qaView.state.doc.toJSON(), text: qaView.state.doc.textBetween(0, qaView.state.doc.content.size, '\\n'),
    html: qaView.dom.innerHTML, events: qaEvents });
` }, bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
const paragraph = text => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });
const text = 'Old owned draft';
const documentOf = (...content) => ({ type: 'doc', content });
const replacement = 'One complete replacement 🧠.';

test('Chrome: managed replacement selects complete structured ProseMirror documents', async t => {
  const browser = await chromium.launch({ headless: true });
  const original = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand };
  try {
    const page = await browser.newPage();
    const session = await page.context().newCDPSession(page);
    const commands = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<style>.ProseMirror{min-height:100px;width:600px}p,h2{min-height:24px;margin:0}</style><div id="host"></div>');
    await page.addScriptTag({ content: bundle });
    cdpClient.attach = async () => {};
    cdpClient.sendCommand = async (_tab, method, params) => {
      commands.push({ method, params });
      return session.send(method, params);
    };
    for (const [name, doc] of [
      ['heading', documentOf({ type: 'heading', content: [{ type: 'text', text }] })],
      ['list', documentOf({ type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph(text)] }] })],
      ['blockquote', documentOf({ type: 'blockquote', content: [paragraph(text)] })],
      ['mixed blocks', documentOf({ type: 'heading', content: [{ type: 'text', text }] }, { type: 'blockquote', content: [paragraph('Other paragraph')] })],
      ['empty trailing paragraph', documentOf(paragraph(text), paragraph(''))],
      ['empty leading paragraph', documentOf(paragraph(''), paragraph(text))],
      ['empty surrounding paragraphs', documentOf(paragraph(''), paragraph(text), paragraph(''))],
      ['only empty paragraphs', documentOf(paragraph(''), paragraph(''))],
      ['inline image', documentOf({ type: 'paragraph', content: [{ type: 'text', text }, { type: 'image' }] })],
      ['authored trailing break', documentOf({ type: 'paragraph', content: [{ type: 'text', text }, { type: 'hard_break' }] })],
    ]) await t.test(name, async () => {
      await page.evaluate(doc => qaMount(doc), doc); commands.length = 0;
      const result = await cdpClient.typeText(81, '.ProseMirror', replacement, true);
      const snapshot = await page.evaluate(() => qaSnapshot());
      assert.equal(result.success, true, JSON.stringify({ result, snapshot }));
      assert.equal(result.verified, true);
      assert.equal(snapshot.text, replacement, 'Compare the actual application document, including empty blocks.');
      assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 1);
      assert.equal(commands.some(command => command.params?.code === 'Delete'), false);
      assert.ok(snapshot.events.every(event => event.trusted));
      assert.deepEqual(errors, []);
    });
    for (const [name, doc, partial] of [
      ['omitted trailing empty paragraph', documentOf(paragraph(text), paragraph('')), { from: 1, to: text.length + 1 }],
      ['omitted leading empty paragraph', documentOf(paragraph(''), paragraph(text)), { from: 3, to: text.length + 3 }],
      ['omitted inline image', documentOf({ type: 'paragraph', content: [{ type: 'text', text }, { type: 'image' }] }), { from: 1, to: text.length + 1 }],
      ['omitted authored hard break', documentOf({ type: 'paragraph', content: [{ type: 'text', text }, { type: 'hard_break' }] }), { from: 1, to: text.length + 1 }],
      ['omitted empty paragraph with collapsed selection', documentOf(paragraph(''), paragraph('')), { from: 1, to: 1 }],
    ]) await t.test(name, async () => {
      await page.evaluate(({ doc, partial }) => qaMount(doc, partial), { doc, partial }); commands.length = 0;
      const before = await page.evaluate(() => qaSnapshot());
      const result = await cdpClient.typeText(81, '.ProseMirror', replacement, true);
      const after = await page.evaluate(() => qaSnapshot());
      assert.equal(result.success, false, JSON.stringify({ result, after }));
      assert.equal(result.mutationMayHaveOccurred, false);
      assert.equal(result.outcomeUnknown, false); assert.equal(result.retryable, true);
      assert.deepEqual(after.doc, before.doc, 'A partial selection leaves the original application document intact.');
      assert.equal(after.html, before.html);
      assert.deepEqual(after.events, []);
      assert.equal(commands.some(command => command.method === 'Input.insertText' || command.params?.code === 'Delete'), false);
      assert.deepEqual(errors, []);
    });
    await session.detach();
  } finally {
    Object.assign(cdpClient, original);
    await browser.close();
  }
});
