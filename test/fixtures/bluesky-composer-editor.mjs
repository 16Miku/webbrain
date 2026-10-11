import { Fragment, Node, Schema, Slice } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';

// Source-backed subset of social-app commit
// 46d98dd457a197cee8502863b420222508f29fa6:
// TextInput.web.tsx uses Tiptap's Document/Paragraph/Text/HardBreak extensions,
// an unlabelled role=textbox host, and this exact plain-text clipboard parser.
// The actual PM document/view owns every editor mutation; no input listener
// rebuilds HTML or changes textContent to imitate a rich editor.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    hard_break: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
  },
});
const documentFromText = value => schema.node('doc', null, String(value).replace(/\r\n?/g, '\n').split('\n')
  .map(line => schema.node('paragraph', null, line ? schema.text(line) : undefined)));

export function mountEditor(value = '') {
  window.qaEditorView?.destroy();
  const host = document.getElementById('editor-host');
  const placeholder = new Plugin({ props: { decorations(state) {
    return state.doc.childCount === 1 && state.doc.firstChild.content.size === 0
      ? DecorationSet.create(state.doc, [Decoration.node(0, state.doc.firstChild.nodeSize, {
        class: 'is-empty is-editor-empty', 'data-placeholder': "What's up?",
      })]) : null;
  } } });
  const doc = documentFromText(value);
  const view = new EditorView(host, {
    state: EditorState.create({ schema, doc, selection: TextSelection.atEnd(doc), plugins: [keymap(baseKeymap), placeholder] }),
    attributes: { role: 'textbox', class: 'tiptap ProseMirror-light' },
    clipboardTextParser(text, context) {
      const nodes = text.split(/(?:\r\n?|\n)/).map(line => Node.fromJSON(context.doc.type.schema,
        line.length ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph', content: [] }));
      return Slice.maxOpen(Fragment.fromArray(nodes));
    },
    dispatchTransaction(transaction) {
      const next = view.state.apply(transaction);
      view.updateState(next);
      window.qaModelText = next.doc.textBetween(0, next.doc.content.size, '\n', '\n');
      document.getElementById('publish').setAttribute('aria-disabled', String(!window.qaModelText.trim()));
    },
  });
  window.qaEditorView = view;
  // Active Composer passes autoFocus, which TextInput.web.tsx maps to 'end'.
  // Establish this native app state before any model observation or test action.
  view.focus();
  window.qaModelText = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n');
  document.getElementById('publish').setAttribute('aria-disabled', String(!window.qaModelText.trim()));
  window.qaSnapshotEditor = () => ({
    model: view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n'),
    doc: view.state.doc.toJSON(), html: view.dom.innerHTML,
    blocks: [...view.dom.children].map(node => node.textContent),
    editorName: view.dom.getAttribute('aria-label'),
    placeholder: view.dom.querySelector('p')?.getAttribute('data-placeholder'),
  });
}
