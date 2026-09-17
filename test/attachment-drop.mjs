import { strict as assert } from 'node:assert';

const implementations = [
  ['chrome', '../src/chrome/src/ui/attachment-drop.js'],
  ['firefox', '../src/firefox/src/ui/attachment-drop.js'],
];

function createTarget() {
  const listeners = new Map();
  const classes = new Set();
  return {
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
    removeEventListener(type, listener) {
      const handlers = listeners.get(type) || [];
      listeners.set(type, handlers.filter(candidate => candidate !== listener));
    },
    contains(node) {
      return node === this || node?.parentNode === this;
    },
    dispatch(type, dataTransfer, extra = {}) {
      const event = {
        type,
        dataTransfer,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...extra,
      };
      for (const listener of listeners.get(type) || []) listener(event);
      return event;
    },
  };
}

function transfer(types, files = []) {
  return { types, files, dropEffect: 'none' };
}

for (const [label, relativeModule] of implementations) {
  const module = await import(new URL(relativeModule, import.meta.url).href);

  assert.equal(
    module.hasFileDragPayload({ dataTransfer: transfer(['Files']) }),
    true,
    `${label}: Files drag payload should be recognized before drop`
  );
  assert.equal(
    module.hasFileDragPayload({ dataTransfer: transfer(['text/uri-list']) }),
    false,
    `${label}: URL drags should not be treated as attachments`
  );
  assert.equal(
    module.hasFileDragPayload({ dataTransfer: transfer([], [{ name: 'notes.txt' }]) }),
    true,
    `${label}: file-list fallback should recognize a drop with no exposed type`
  );

  const target = createTarget();
  const files = [{ name: 'notes.txt', type: 'text/plain' }];
  const received = [];
  const cleanup = module.installFileDropHandlers(target, droppedFiles => received.push(droppedFiles));

  const firstEnter = target.dispatch('dragenter', transfer(['Files']));
  assert.equal(firstEnter.defaultPrevented, true, `${label}: file dragenter should be consumed`);
  assert.equal(target.classList.contains('drag-over'), true, `${label}: dragenter should show drop feedback`);

  const child = { parentNode: target };
  target.dispatch('dragenter', transfer(['Files']), { relatedTarget: target });
  target.dispatch('dragleave', transfer(['Files']), { relatedTarget: child });
  assert.equal(target.classList.contains('drag-over'), true, `${label}: moving across composer children should keep feedback`);
  target.dispatch('dragleave', transfer(['Files']));
  assert.equal(target.classList.contains('drag-over'), false, `${label}: leaving the composer should clear nested feedback`);

  target.dispatch('dragenter', transfer(['Files']));

  const over = target.dispatch('dragover', transfer(['Files']));
  assert.equal(over.defaultPrevented, true, `${label}: file dragover should be consumed`);
  assert.equal(over.dataTransfer.dropEffect, 'copy', `${label}: file dragover should advertise copy behavior`);

  const drop = target.dispatch('drop', transfer(['Files'], files));
  assert.equal(drop.defaultPrevented, true, `${label}: file drop should be consumed`);
  assert.deepEqual(received, [files], `${label}: drop should forward the original file list`);
  assert.equal(target.classList.contains('drag-over'), false, `${label}: drop should clear feedback`);

  const nonFileOver = target.dispatch('dragover', transfer(['text/plain']));
  assert.equal(nonFileOver.defaultPrevented, false, `${label}: non-file dragover should remain untouched`);
  const nonFileDrop = target.dispatch('drop', transfer(['text/uri-list'], []));
  assert.equal(nonFileDrop.defaultPrevented, false, `${label}: non-file drop should remain untouched`);
  assert.deepEqual(received, [files], `${label}: non-file drops should not reach the attachment reader`);

  cleanup();
  target.dispatch('drop', transfer(['Files'], files));
  assert.deepEqual(received, [files], `${label}: cleanup should remove drop listeners`);
}

console.log('attachment drag-and-drop tests passed for Chrome and Firefox');
