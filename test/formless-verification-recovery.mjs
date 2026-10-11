import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(process.env.WEBBRAIN_VERIFY_FORM_SOURCE_ROOT || new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const url = 'https://settings.owned.example/profile';
const field = { name: 'display_name', id: 'name', type: 'text', value: 'Owned profile', labels: [{ textContent: 'Display name' }], getAttribute: () => null };
const makeContext = ({ form = false, invalidSelector = false, isTop = true, pageUrl = url } = {}) => {
  const formNode = { action: pageUrl + '/save', method: 'post', querySelectorAll: () => [field] };
  const window = {}; window.top = isTop ? window : {};
  return { window, location: { href: pageUrl }, CSS: { escape: x => x }, document: {
    activeElement: null,
    querySelector: selector => { if (invalidSelector && selector === '[') throw new SyntaxError('Invalid selector'); return form ? formNode : null; },
  } };
};
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area, onChanged: { addListener() {} } }, runtime: { getURL: x => x } };

for (const build of ['chrome', 'firefox']) {
  const source = path.join(root, 'src', build, 'src', 'agent');
  const { Agent } = await import(pathToFileURL(path.join(source, 'agent.js')).href);
  const invariant = await import(pathToFileURL(path.join(source, 'completion-invariant.js')).href);
  const tools = await import(pathToFileURL(path.join(source, 'tools.js')).href);
  const cdp = build === 'chrome' ? (await import(pathToFileURL(path.join(root, 'src/chrome/src/cdp/cdp-client.js')).href)).cdpClient : null;
  const setup = (main, child = null) => {
    const calls = { reads: 0, capture: 0, writes: 0 };
    const frames = [{ frameId: 0, parentFrameId: -1, context: makeContext(main) }];
    if (child) frames.push({ frameId: 7, parentFrameId: 0, context: makeContext({ ...child, isTop: false }) });
    const run = (code, context) => vm.runInNewContext(code, context);
    const api = { storage: { local: area, session: area, onChanged: { addListener() {} } }, runtime: { getURL: x => x },
      webNavigation: { getAllFrames: async () => frames.map(f => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.context.location.href })) },
      tabs: { get: async () => ({ id: 42, url }), sendMessage: async () => ({ success: false }), captureTab: async () => { calls.capture++; throw Error('Offline fixture has no viewport image'); },
        executeScript: async (_tab, { code, frameId = 0 }) => { calls.reads++; return [run(code, frames.find(f => f.frameId === frameId).context)]; } },
      scripting: { executeScript: async ({ func, args }) => frames.map(f => { calls.reads++; return { frameId: f.frameId, result: run(`(${func.toString()})(...args)`, { ...f.context, args }) }; }) },
    };
    globalThis.chrome = globalThis.browser = api;
    if (cdp) { cdp.attach = async () => {}; cdp.evaluate = async (_tab, code) => { calls.reads++; return { result: { value: run(code, frames[0].context) } }; }; cdp.sendCommand = async () => ({}); }
    const agent = new Agent({ getActive: () => ({ model: 'owned', config: {} }) });
    agent._preparePageForCapture = async () => {};
    agent._captureViewportProbe = async () => { calls.capture++; throw Error('Offline fixture has no viewport image'); };
    agent._persist = () => {}; agent._persistNow = async () => true;
    return { agent, calls };
  };

  test(`${build}: form-less main settings expose observation recovery without successful verification`, async () => {
    const f = setup({ form: false });
    const result = await f.agent.executeTool(42, 'verify_form', {});
    assert.equal(result.success, false); assert.equal(result.found, false); assert.equal(result.scope, 'top');
    assert.equal(result.code, 'html_form_verification_unavailable');
    assert.equal(result.recoverable, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.inspectedScope)), { kind: 'top', matchingFrameCount: 1, formCount: 0 });
    assert.equal(result.recovery.kind, 'observe_page_state');
    assert.ok(result.recovery.tools.includes('get_accessibility_tree'));
    assert.match(result.recovery.instruction, /does not prove.*blocked/i);
    assert.match(result.recovery.instruction, /Save.*Publish/);
    assert.equal(result.verified, undefined); assert.equal(result.deliveryVerified, undefined);
    assert.equal(f.calls.writes, 0); assert.ok(f.calls.reads > 0);
  });

  test(`${build}: explicit iframe scope never silently verifies the main document`, async () => {
    const f = setup({ form: true }, { form: false });
    const result = await f.agent.executeTool(42, 'verify_form', { urlFilter: 'settings.owned.example' });
    assert.equal(result.success, false); assert.equal(result.found, false); assert.equal(result.scope, 'iframe');
    assert.equal(result.matchingFrameCount, 1); assert.equal(result.fieldCount, 0);
    assert.equal(result.code, 'html_form_verification_unavailable');
    assert.deepEqual(JSON.parse(JSON.stringify(result.inspectedScope)), { kind: 'iframe', matchingFrameCount: 1, formCount: 0 });
    assert.match(result.recovery.instruction, /child frames/);
    assert.match(result.recovery.instruction, /omit urlFilter/);
  });

  test(`${build}: missing iframe is an explicit read-scope recovery, never a submit denial`, async () => {
    const f = setup({ form: false });
    const result = await f.agent.executeTool(42, 'verify_form', { urlFilter: 'other.owned.example' });
    assert.equal(result.success, false); assert.equal(result.matchingFrameCount, 0);
    assert.equal(result.code, 'html_form_verification_unavailable');
    assert.equal(result.inspectedScope.matchingFrameCount, 0);
    assert.equal(result.noDispatch, undefined); assert.equal(result.submitConfirmationRequired, undefined);
  });

  test(`${build}: actual main HTML form retains field verification`, async () => {
    const f = setup({ form: true });
    const result = await f.agent.executeTool(42, 'verify_form', {});
    assert.equal(result.success, true); assert.equal(result.found, true); assert.equal(result.fieldCount, 1);
    assert.equal(result.fields[0].value, 'Owned profile'); assert.equal(result.code, undefined);
    assert.equal(result.recovery, undefined); assert.equal(result.recoverable, undefined);
  });

  test(`${build}: actual iframe HTML form retains exact iframe field evidence`, async () => {
    const f = setup({ form: false }, { form: true });
    const result = await f.agent.executeTool(42, 'verify_form', { urlFilter: 'settings.owned.example' });
    assert.equal(result.success, true); assert.equal(result.scope, 'iframe'); assert.equal(result.fieldCount, 1);
    assert.equal(result.fields[0].frameId, 7); assert.equal(result.fields[0].value, 'Owned profile');
    assert.equal(result.recovery, undefined);
  });

  test(`${build}: invalid selectors remain actual errors rather than absent-form diagnosis`, async () => {
    const f = setup({ form: false, invalidSelector: true });
    const result = await f.agent.executeTool(42, 'verify_form', { selector: '[' });
    assert.equal(result.success, false); assert.match(result.error, /Invalid selector/);
    assert.equal(result.code, undefined); assert.equal(result.recoverable, undefined);
  });

  test(`${build}: unavailable verification cannot clear genuine iframe edit or submission debt`, async () => {
    const f = setup({ form: true }, { form: false });
    let state = invariant.recordCompletionToolResult(invariant.createCompletionInvariantState('owned'), 'iframe_type',
      { urlFilter: 'settings.owned.example', selector: '#name', text: 'Owned profile' },
      { success: true, dispatched: true, verified: true, frameId: 7, value: 'Owned profile' });
    f.agent.completionInvariants.set(42, state);
    const result = await f.agent.executeTool(42, 'verify_form', { urlFilter: 'settings.owned.example' });
    state = invariant.recordCompletionToolResult(state, 'verify_form', { urlFilter: 'settings.owned.example' }, result);
    assert.equal(state.iframeFormVerificationDebt, true);
    assert.ok(invariant.completionDoneBlock(state, 'done', { outcome: 'success' }));
    assert.equal(invariant.completionDoneBlock(state, 'done', { outcome: 'partial' }), null);
    assert.equal(result.success, false); assert.equal(f.calls.writes, 0);
  });

  test(`${build}: Full and Mid guidance distinguishes HTML forms from form-less single-file settings`, () => {
    for (const prompt of [tools.SYSTEM_PROMPT_ACT, tools.SYSTEM_PROMPT_ACT_MID]) {
      assert.match(prompt, /multi-field HTML form/i);
      assert.match(prompt, /urlFilter.*child frames/);
      assert.match(prompt, /no HTML form/i);
      assert.match(prompt, /single-file|image-only/i);
      assert.match(prompt, /missing HTML form.*not.*blocked/i);
      assert.match(prompt, /verify.*persist/i);
    }
    const description = tools.AGENT_TOOLS.find(x => x.function?.name === 'verify_form')?.function.description;
    assert.match(description, /HTML form/);
    assert.match(description, /no HTML form/i);
  });
}
