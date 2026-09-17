import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';

const implementations = [
  ['chrome', '../src/chrome/src/ui/attachment-drop.js'],
  ['firefox', '../src/firefox/src/ui/attachment-drop.js'],
];

const fileImplementations = [
  ['chrome', '../src/chrome/src/ui/attachment-file.js'],
  ['firefox', '../src/firefox/src/ui/attachment-file.js'],
];

for (const [label] of implementations) {
  const sidepanelHtml = await readFile(
    new URL(`../src/${label}/src/ui/sidepanel.html`, import.meta.url),
    'utf8'
  );
  assert.match(
    sidepanelHtml,
    /id="file-attach-input"[^>]*text\/markdown[^>]*\.md/,
    `${label}: file picker should advertise Markdown MIME and extension support`
  );

  const agentSource = await readFile(
    new URL(`../src/${label}/src/agent/agent.js`, import.meta.url),
    'utf8'
  );
  assert.match(
    agentSource,
    /JSON\/TXT\/CSV\/Markdown attachments/,
    `${label}: attachment safety guidance should include Markdown`
  );
  assert.match(
    agentSource,
    /JSON\/TXT\/CSV\/Markdown facts/,
    `${label}: text attachment memory guidance should include Markdown`
  );

  const localeDirectory = new URL(`../src/${label}/src/ui/locales/`, import.meta.url);
  for (const localeFile of (await readdir(localeDirectory)).filter(name => name.endsWith('.js'))) {
    const localeSource = await readFile(new URL(localeFile, localeDirectory), 'utf8');
    assert.match(
      localeSource,
      /sp\.attach\.unsupported_type[^\n]*Markdown/,
      `${label}/${localeFile}: unsupported attachment copy should mention Markdown`
    );
  }
}

for (const [label, relativeModule] of fileImplementations) {
  const { isTextAttachment } = await import(new URL(relativeModule, import.meta.url).href);

  assert.equal(
    isTextAttachment({ name: 'README.md', type: 'text/markdown' }),
    true,
    `${label}: text/markdown should be accepted as a text attachment`
  );
  assert.equal(
    isTextAttachment({ name: 'payload', type: 'application/json' }),
    true,
    `${label}: application/json without file extension should be accepted`
  );
  assert.equal(
    isTextAttachment({ name: 'notes', type: 'text/plain' }),
    true,
    `${label}: text/plain without file extension should be accepted`
  );
  assert.equal(
    isTextAttachment({ name: 'data', type: 'text/csv' }),
    true,
    `${label}: text/csv without file extension should be accepted`
  );
  assert.equal(
    isTextAttachment({ name: 'doc', type: 'text/markdown' }),
    true,
    `${label}: text/markdown without file extension should be accepted`
  );
  assert.equal(
    isTextAttachment({ name: 'README.MD', type: '' }),
    true,
    `${label}: Markdown extension should be accepted when MIME type is empty`
  );
  assert.equal(
    isTextAttachment({ name: 'README.md', type: 'image/png' }),
    false,
    `${label}: image MIME types should not be reclassified by a Markdown extension`
  );
  assert.equal(
    isTextAttachment({ name: 'archive.zip', type: 'application/zip' }),
    false,
    `${label}: unsupported binary files should remain rejected`
  );
}

function createTarget() {
  const listeners = new Map();
  const classes = new Set();
  const target = {
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
  return target;
}

const windowListeners = new Map();
globalThis.window = {
  addEventListener(type, listener) {
    const handlers = windowListeners.get(type) || [];
    handlers.push(listener);
    windowListeners.set(type, handlers);
  },
  removeEventListener(type, listener) {
    const handlers = windowListeners.get(type) || [];
    windowListeners.set(type, handlers.filter(candidate => candidate !== listener));
  },
  dispatchEvent(type, event = {}) {
    for (const listener of windowListeners.get(type) || []) listener(event);
  },
};

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

  // Window dragend / drop fallback clears stuck drag-over
  const target2 = createTarget();
  const cleanup2 = module.installFileDropHandlers(target2, () => {});
  target2.dispatch('dragenter', transfer(['Files']));
  assert.equal(target2.classList.contains('drag-over'), true, `${label}: dragenter should activate drag-over`);
  globalThis.window.dispatchEvent('dragend');
  assert.equal(target2.classList.contains('drag-over'), false, `${label}: window dragend should reset stuck drag-over`);
  cleanup2();
}

console.log('attachment drag-and-drop tests passed for Chrome and Firefox');
