# Rich-text input

DraftJS is a React rich-text editor. Its application document owns the rendered
text nodes, so inserting an HTML wrapper or replacing `textContent` can corrupt
the editor or show the same text twice while the saved document differs.

The October 11 regression came from `50c8d73ad`, which moved `type_ax` and
`set_field` from trusted input to generic HTML insertion for editors that were
not recognized as ProseMirror. DraftJS reached that path. Its old test fixture
rebuilt the DOM on input, masking the conflict with React-owned document nodes.

WebBrain identifies managed editors by their editor markup, independently of the
site: DraftJS, ProseMirror, Slate, Lexical, Quill, CKEditor, TinyMCE and CodeMirror.
These editors bypass generic HTML insertion and DOM replacement. Chrome uses
ref-bound browser input; iframe preparation and verification stay in the original
frame. Legacy iframe setters refuse managed editors instead of changing their DOM.

DraftJS multiline edits use its public plain-text paste handling. A single paste
lets the editor create its own document blocks, preserving blank lines and literal
markup without sending Enter or changing the system clipboard. Both replacement
and append require exact full-document readback in the original element and scope.
Cancelled, ignored, changed or unavailable results never trigger a second write.
Focus preparation and the paste use the existing task-bound monitor fences;
the internal AX paste route shares `type_ax` input ownership.

Firefox trusted automation uses the same strict DraftJS and ProseMirror document
readers before and after input, including empty caret placeholders and paragraph
boundaries. Without a supported transport, WebBrain leaves the draft intact and
explains how to enable trusted automation.

Regression tests use the actual React/DraftJS libraries and compare application
EditorState, rendered document blocks and saved POST data. They cover replacement,
append, clear, multiline text, Unicode, literal markup, iframe ownership and lost
responses. Additional fixtures check that managed editors cannot reach legacy DOM
setters and that ordinary editors preserve their exact text and formatting.

Run the focused suite with:

```sh
node --test test/rich-text-frameworks.mjs test/firefox-rich-text-readback.mjs test/draftjs-text.mjs test/iframe-preparation-focus.mjs test/contenteditable-literal.mjs test/contenteditable-beforeinput.mjs
```
