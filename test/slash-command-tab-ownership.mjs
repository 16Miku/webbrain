import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

function fixture(build, invocation) {
  const source = fs.readFileSync(new URL(`../src/${build}/src/ui/sidepanel.js`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('async function parseSlashCommands(');
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start);
  let release, reject;
  const pending = new Promise((resolve, fail) => { release = resolve; reject = fail; });
  const notices = [], requests = [], downloads = [], resolvedTabs = [];
  const context = vm.createContext({
    currentTabId: 7,
    PERMISSION_GATE_KEY: 'askBeforeConsequential',
    askBeforeConsequential: true,
    parseSlashInvocation: () => ({ payload: '', optionValues: new Set(), ...invocation }),
    sendToBackground: (action, payload) => { requests.push({ action, payload }); return pending; },
    addPersistentSlashMessage: content => notices.push(content),
    t: key => key,
    systemHtml: text => text,
    getLocale: () => 'en',
    updateActWarning() {},
    updateInputPlaceholder() {},
    resolvePendingPermissionPromptsForTab: tabId => resolvedTabs.push(tabId),
    Blob,
    URL: { createObjectURL: () => 'blob:export', revokeObjectURL() {} },
    setTimeout() {},
    document: {
      createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }),
      body: { appendChild() {} },
    },
  });
  context[build === 'chrome' ? 'chrome' : 'browser'] = {
    storage: { local: { set: data => { requests.push({ action: 'storage.set', payload: data }); return pending; } } },
  };
  vm.runInContext(source.slice(start, end + 2), context);
  return { context, release, reject, notices, requests, downloads, resolvedTabs };
}

for (const build of ['chrome', 'firefox']) {
  for (const switched of [false, true]) {
    const suffix = switched ? 'after switching tabs' : 'on the initiating tab';
    for (const [name, response, expectedNotice, downloaded] of [
      ['configuration', { ok: true, json: '{"settings":{}}' }, 'sp.export_config.done', true],
      ['invalid configuration', { ok: false, error: 'unavailable' }, 'sp.export_config.error', false],
      ['configuration transport error', new Error('disconnected'), 'sp.export_config.error', false],
    ]) {
      test(`${build}: ${name} export ${suffix}`, async () => {
        const harness = fixture(build, { command: { value: '/export' }, action: 'config' });
        const result = harness.context.parseSlashCommands('/export --config', 7);
        assert.equal(harness.requests[0].action, 'export_config');
        if (switched) harness.context.currentTabId = 9;
        if (response instanceof Error) harness.reject(response);
        else harness.release(response);
        assert.equal(await result, '');
        assert.equal(harness.downloads.length, Number(downloaded), 'A tab switch must not cancel an already requested download');
        assert.deepEqual(harness.notices, switched ? [] : [expectedNotice]);
      });
    }

    for (const [name, response, expectedNotice, downloaded] of [
      ['trace Markdown', { ok: true, markdown: '# Original tab', turnCount: 1 }, 'sp.export_traces.done', true],
      ['partial trace', { ok: true, json: '{}', turnCount: 1, partial: true }, 'sp.export_traces.partial', true],
      ['truncated trace', { ok: true, markdown: 'trace', turnCount: 1, truncated: true }, 'sp.export_traces.truncated', true],
      ['truncated recording', { ok: true, json: '{}', turnCount: 1, recordingTruncated: true }, 'sp.export_traces.recording_truncated', true],
      ['empty trace', { ok: true, turnCount: 0 }, 'sp.export_traces.none', false],
      ['missing conversation', { ok: true, reason: 'no-conversation' }, 'sp.export_traces.no_conversation', false],
      ['failed trace', { ok: false, error: 'unavailable' }, 'sp.export_traces.error (unavailable)', false],
      ['trace transport error', new Error('disconnected'), 'sp.export_traces.error (disconnected)', false],
    ]) {
      test(`${build}: ${name} export ${suffix}`, async () => {
        const harness = fixture(build, { command: { value: '/export' }, action: 'traces' });
        const result = harness.context.parseSlashCommands('/export --traces', 7);
        assert.equal(harness.requests[0].action, 'export_traces');
        assert.equal(harness.requests[0].payload.tabId, 7);
        if (switched) harness.context.currentTabId = 9;
        if (response instanceof Error) harness.reject(response);
        else harness.release(response);
        assert.equal(await result, '');
        assert.equal(harness.downloads.length, Number(downloaded), 'Export must finish for the initiating tab');
        assert.deepEqual(harness.notices, switched ? [] : [expectedNotice]);
      });
    }

    test(`${build}: permission-skip confirmation ${suffix}`, async () => {
      const harness = fixture(build, { command: { value: '/dangerously-skip-permissions' }, payload: 'continue task' });
      const result = harness.context.parseSlashCommands('/dangerously-skip-permissions continue task', 7);
      assert.equal(harness.requests[0].action, 'storage.set');
      if (switched) harness.context.currentTabId = 9;
      harness.release();
      assert.equal(await result, 'continue task');
      assert.equal(harness.context.askBeforeConsequential, false, 'The requested global setting must still update');
      assert.deepEqual(harness.resolvedTabs, [7], 'Resolve permissions only for the originating tab');
      assert.deepEqual(harness.notices, switched ? [] : ['sp.permissions.disabled_html']);
    });
  }
}
