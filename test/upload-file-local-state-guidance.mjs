import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = new URL(process.env.WEBBRAIN_TEST_ROOT || '../', import.meta.url);
const CANDIDATE = process.env.WEBBRAIN_UPLOAD_GUIDANCE_CANDIDATE;
const moduleUrl = (build, type) => CANDIDATE
  ? pathToFileURL(path.join(CANDIDATE, `load-${build}-${type}.mjs`))
  : new URL(`src/${build}/src/agent/${type}.js`, ROOT);
const { cdpClient } = await import(new URL('src/chrome/src/cdp/cdp-client.js', ROOT));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3kAAAAASUVORK5CYII=', 'base64');
const html = Buffer.from('<!doctype html><html>error page</html>');
let nextTab = 9870;

// Only browser transports and DOM primitives are simulated. Actual Agent,
// CDP byte/type validation and Firefox injection/settle code execute unchanged.
async function attach(Agent, build, { consumed = false, incompatible = false, uncertain = false } = {}) {
  const tab = nextTab++, nativeEvents = [], apiBefore = globalThis.chrome, browserBefore = globalThis.browser;
  const cdpBefore = Object.fromEntries(['attach', 'querySelectorPierce', 'releaseObjectGroup', 'probeLocalFile', 'getFileInputFiles'].map(k => [k, cdpClient[k]]));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-local-upload-'));
  const filename = path.join(dir, 'image.png');
  await fs.writeFile(filename, incompatible ? html : png);
  let physicalCalls = 0;
  class Input {
    constructor() { this.tagName = 'INPUT'; this.type = 'file'; this.files = []; this.isConnected = true; this.disabled = false; this.labels = []; }
    get files() { return this._files; }
    set files(value) { this._files = value; if (value?.length) physicalCalls++; }
    getAttribute(name) { return name === 'accept' ? 'image/*' : name === 'type' ? 'file' : null; }
    dispatchEvent(event) { nativeEvents.push(event.type); if (event.type === 'change' && consumed) this.files = []; return true; }
    closest() { return null; }
  }
  const input = new Input();
  class Transfer { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } }
  const page = { document: { querySelectorAll: selector => ['#file', '*'].includes(selector) ? [input] : [], querySelector: selector => selector === '#file' ? input : null },
    HTMLInputElement: Input, File, DataTransfer: Transfer, Event: class { constructor(type) { this.type = type; } },
    Uint8Array, TextDecoder, TextEncoder, atob, btoa, Date, window: {}, setTimeout, clearTimeout };
  const api = {
    runtime: { getURL: value => `extension://offline/${value}` },
    tabs: {
      get: async () => ({ id: tab, url: 'https://owned.example.test/settings' }),
      sendMessage: async () => ({ ready: true, active: false }),
      executeScript: async (_tab, details) => {
        if (details.code.includes('transfer.items.add') || details.code.includes('dt.items.add')) {
          if (uncertain) throw new Error('Attachment reply lost');
        }
        return [vm.runInNewContext(details.code, page)];
      },
    },
    debugger: { sendCommand(_target, method, params, callback) {
      if (method === 'DOM.setFileInputFiles') {
        physicalCalls++; nativeEvents.push('input', 'change');
        if (uncertain) { api.runtime.lastError = { message: 'Attachment reply lost' }; callback(); delete api.runtime.lastError; return; }
      }
      if (method === 'Runtime.callFunctionOn') {
        const declaration = params.functionDeclaration || '';
        const value = declaration.includes('data-webbrain-native-target')
          ? { nativeTarget: params.arguments[0].value, documentToken: 'owned-document', documentRevision: 0 }
          : { connected: true, fileInput: true, disabled: false, accept: 'image/*' };
        callback({ result: { value } }); return;
      }
      callback({});
    } },
    storage: { local: { get: async () => ({}) }, session: { get: async () => ({}) } },
  };
  globalThis.chrome = api; globalThis.browser = api;
  cdpClient.attach = async () => { cdpClient.sessions.set(tab, {}); };
  cdpClient.querySelectorPierce = async () => ({ objectIds: ['native-input'], objectGroup: 'owned-upload' });
  cdpClient.releaseObjectGroup = async () => {};
  cdpClient.getFileInputFiles = async () => consumed ? [] : [{ name: 'image.png', size: png.length, readable: true }];
  cdpClient.probeLocalFile = async (_tab, p, options = {}) => {
    const bytes = await fs.readFile(p), stat = await fs.stat(p);
    return { exists: true, readable: true, filename: path.basename(p), size: bytes.length, lastModified: stat.mtimeMs, mimeType: 'image/png',
      ...(options.includeData ? { base64: bytes.subarray(0, options.readPrefixBytes || bytes.length).toString('base64') } : {}) };
  };
  const agent = new Agent({ getActive: () => ({ promptTier: 'full', supportsVision: false }) });
  agent._resolvePromptTier = () => 'full'; agent._currentUrl = async () => 'https://owned.example.test/settings';
  try {
    let args = { selector: '#file', filePath: filename };
    if (build === 'firefox') {
      const [attachment] = agent._registerUserAttachments(tab, [{ name: 'image.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${(incompatible ? html : png).toString('base64')}` }]);
      args = { selector: '#file', attachmentId: attachment.attachmentId };
    }
    const result = await agent.executeTool(tab, 'upload_file', args);
    return { result, physicalCalls, nativeEvents };
  } finally {
    cdpClient.sessions.delete(tab);
    for (const [key, value] of Object.entries(cdpBefore)) cdpClient[key] = value;
    globalThis.chrome = apiBefore; globalThis.browser = browserBefore;
    const resolved = await fs.realpath(dir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-local-upload-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(moduleUrl(build, 'agent'));
  const tools = await import(moduleUrl(build, 'tools'));
  test(`${build}: consumed image keeps local truth and directs preview/crop then current commit`, async () => {
    const { result, physicalCalls, nativeEvents } = await attach(Agent, build, { consumed: true });
    assert.equal(result.success, true); assert.equal(result.attachmentState, 'page_consumed');
    assert.equal(result.verified, false); assert.equal(result.remoteStateVerified, false);
    assert.equal(physicalCalls, 1); assert.deepEqual(nativeEvents, ['input', 'change']);
    assert.match(result.note, /preview|crop/i); assert.match(result.note, /current.*(?:save|submit|commit)/i);
    assert.match(result.note, /(?:absent|missing|not rendered).*filename|filename.*(?:absent|missing|not rendered)/i);
    assert.doesNotMatch(result.note, /Confirm "image\.png" appears attached/);
    assert.match(result.note, /(?:only|explicit).*new file|genuinely missing/i);
  });
  test(`${build}: retained input stays distinct from a consumed input and remote save`, async () => {
    const { result, physicalCalls } = await attach(Agent, build);
    assert.equal(result.success, true); assert.equal(result.attachmentState, 'input_attached');
    assert.equal(result.verified, false); assert.equal(result.remoteStateVerified, false); assert.equal(physicalCalls, 1);
    assert.match(result.note, /file input retains/i); assert.doesNotMatch(result.note, /page consumed/i);
    assert.match(result.note, /does not prove a remote/i);
  });
  test(`${build}: incompatible HTML remains known no-dispatch without successful attachment guidance`, async () => {
    const { result, physicalCalls, nativeEvents } = await attach(Agent, build, { incompatible: true });
    assert.equal(result.success, false); assert.equal(result.noDispatch, true); assert.equal(result.dispatched, false);
    assert.equal(result.reasonCode, 'file_type_mismatch'); assert.equal(physicalCalls, 0); assert.deepEqual(nativeEvents, []);
    assert.equal(result.note, undefined); assert.notEqual(result.remoteStateVerified, true);
  });
  test(`${build}: a lost attachment reply retains uncertainty instead of local success guidance`, async () => {
    const { result } = await attach(Agent, build, { uncertain: true });
    assert.equal(result.success, false); assert.equal(result.dispatched, true);
    assert.notEqual(result.noDispatch, true); assert.notEqual(result.verified, true);
    if (build === 'firefox') assert.equal(result.outcomeUnknown, true);
    else assert.notEqual(result.outcomeUnknown, false);
    assert.equal(result.note, undefined); assert.notEqual(result.remoteStateVerified, true);
  });
  test(`${build}: tool and all prompt tiers support preview-only image editors without inventing success`, () => {
    const descriptor = tools.AGENT_TOOLS.find(t => t.function.name === 'upload_file').function.description;
    for (const text of [descriptor, tools.SYSTEM_PROMPT_ACT, tools.SYSTEM_PROMPT_ACT_MID, tools.SYSTEM_PROMPT_ACT_COMPACT]) {
      assert.match(text, /preview|crop/i); assert.match(text, /filename.*(?:absent|missing|not rendered)|(?:absent|missing|not rendered).*filename/i);
      assert.match(text, /remote upload|remote submission/i);
      assert.match(text, /genuinely missing|explicit.*new file/i);
    }
  });
}
