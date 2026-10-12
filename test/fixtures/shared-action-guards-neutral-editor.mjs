import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { mountEditor as mountSourceBackedEditor } from './bluesky-composer-editor.mjs';

// A real PM-owned widget is a genuine native control inside the editor. Its
// independent visible click handler is never an editable receiving target.
export function mountEditor(value = '') {
  mountSourceBackedEditor(value);
  if (!window.qaInlineControl) return;
  const view = window.qaEditorView;
  const control = document.createElement('button');
  control.type = 'button'; control.id = 'inline-native-control';
  control.textContent = 'Owned inline native action';
  control.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:190px;height:44px;z-index:2';
  window.qaInlineButtonClicks = 0; window.qaInlineButtonInputs = 0;
  control.addEventListener('click', () => { window.qaInlineButtonClicks++; fetch('/forbidden-inline-action', { method: 'POST' }); });
  control.addEventListener('input', () => { window.qaInlineButtonInputs++; });
  const plugin = new Plugin({ props: { decorations(state) {
    return DecorationSet.create(state.doc, [Decoration.widget(1, control, { key: 'owned-native-control', stopEvent: () => true })]);
  } } });
  view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, plugin] }));
}
