# Workflow editor

Open `index.html` directly in a browser. Keep `workflow-editor.js` beside it.
The page works from `file://` without a server or internet connection. On the
website it is available at `/workflow-editor/`.

Drop a JSON file onto the editor, use **Open JSON**, or start a new workflow.
For a new workflow, fill in `start.origin` (for example, `https://example.com`)
and `start.pathFamily` (for example, `/` or `/join`) before adding steps. New
steps inherit this starting scope; adjust their scope when they run on another page.
Select a step or parameter to edit its fields. Field names, values, and JSON
types are editable, including nested objects and arrays. Drag steps or parameters
to reorder them, or use the move buttons. **JSON source** supports bulk edits;
apply or discard those edits before switching views or downloading.

Renaming a unique parameter's `id` in the field editor updates matching
`$workflowParam` references throughout the document. Parameter ids must match
the importer's lowercase `[a-z0-9_-]` format and 80-character limit; checks flag
noncanonical or normalized duplicate ids already present in a file. Raw JSON edits and field-key
renames are literal changes. Removing a referenced parameter surfaces a warning.
Unknown fields are retained; timestamps and recorded statistics are not silently
rewritten. Basic checks are advisory, not a guarantee that a workflow will run.

**Download JSON** exports a new file. Nothing is uploaded or automatically saved
in browser storage. Download your work before closing the page. Undo/redo keeps
up to 100 document changes in memory. File opening starts a new history.

## Embed in another page

Copy only `workflow-editor.js`. It includes the interface and all styles, isolated
inside a shadow root so host-page styles do not affect the editor.

```html
<div id="workflow"></div>
<script src="./workflow-editor.js"></script>
<script>
  const editor = WorkflowEditor.mount('#workflow', {
    value: {
      schema: 'webbrain-workflow/1',
      name: 'My workflow',
      parameters: [],
      steps: []
    },
    filename: 'my-workflow.webbrain-workflow.json',
    onChange(value, editor) {
      // Receives an independent copy after visual edits, undo/redo, or Apply JSON.
      console.log(value);
    }
  });
</script>
```

Omit `value` for the file-drop welcome screen. Mount into an empty element without
an existing shadow root. Multiple editors are independent. No build step, global
CSS, framework, external fonts, network calls, or dependencies are required.
Hosts with a strict Content Security Policy must allow the script and its embedded
style element. The editor never executes imported workflows or renders their HTML.

### Instance API

| Method | Behavior |
| --- | --- |
| `load(objectOrJsonString, filename?)` | Replace the document, reset history, and mark it clean. Throws on invalid JSON or a non-object root. Programmatic loads do not prompt or emit change events. |
| `getValue()` | Return an independent copy of the document, or `null` when empty. |
| `toJSON(space = 2)` | Serialize committed data. Throws while raw JSON edits are pending. |
| `validate()` | Return an array of basic workflow warning messages. |
| `isDirty()` | Whether the document differs from the loaded/downloaded version or has pending raw edits. |
| `markSaved(snapshot)` | Mark the exact document snapshot persisted by the host as saved. Pass the value captured when starting an asynchronous save; later edits remain dirty when that save completes. Pending field or raw JSON edits remain intact, and focus is preserved. |
| `download()` | Download the current JSON using the editable filename. |
| `undo()` / `redo()` | Navigate document history. |
| `destroy()` | Remove the interface; discard the host element before mounting again. |

The mount element also dispatches a bubbling `workflowchange` event with
`event.detail.value`. Returned values and change payloads are copies, so host
code cannot accidentally mutate editor state. Embedding hosts own their save and
navigation lifecycle; the standalone page adds a warning when leaving with edits.

Run browser regression tests with `node --test test/workflow-editor.mjs`.
