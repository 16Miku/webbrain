import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceFor = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function createRealm(hostname = 'www.youtube.com', withMse = true) {
  const calls = { logs: 0, network: 0, downloads: 0, appends: 0 };
  class NativeSourceBuffer { appendBuffer() { calls.appends++; } }
  class NativeMediaSource { addSourceBuffer() { return new NativeSourceBuffer(); } }
  class NativeURL extends URL {}
  NativeURL.createObjectURL = () => 'blob:reinjection-test';
  NativeURL.revokeObjectURL = () => {};
  const context = vm.createContext({
    ArrayBuffer, Uint8Array, Blob, Map, Set, WeakMap, URL: NativeURL,
    crypto: { randomUUID: () => crypto.randomUUID() },
    location: { hostname, href: `https://${hostname}/watch`, pathname: '/watch', search: '' },
    document: {
      body: { appendChild() {} }, documentElement: {},
      querySelectorAll: () => [], querySelector: () => null,
      createElement: () => ({ click() { calls.downloads++; }, remove() {} }),
    },
    console: { log() { calls.logs++; }, warn() {}, error() {} },
    fetch() { calls.network++; throw new Error('This regression must not fetch media'); },
    setTimeout: () => 0, clearTimeout() {},
    ...(withMse ? { MediaSource: NativeMediaSource, SourceBuffer: NativeSourceBuffer } : {}),
  });
  context.window = context;
  return { context, calls, MediaSource: NativeMediaSource, SourceBuffer: NativeSourceBuffer, URL: NativeURL };
}

function load(source, realm) {
  return vm.runInContext(source, realm.context, { filename: 'social-media-downloader.js' });
}

function installActualCapture(realm, browser) {
  const feedback = sourceFor(`src/${browser}/src/agent/page-feedback.js`);
  const start = feedback.indexOf('async function captureMediaState(');
  const end = feedback.indexOf('\nfunction mediaCaptureMetadata(', start);
  assert(start >= 0 && end > start, 'Use the production media-capture function');
  const binding = sourceFor(`src/${browser}/src/agent/media-download-binding.js`);
  const stateStart = binding.indexOf('export function captureMediaDownloadStateInPage()');
  assert(stateStart >= 0, 'Use the production read-only media observer');
  vm.runInContext(binding.slice(stateStart).replace(/^export /, '') + '\n' + feedback.slice(start, end), realm.context);
}

for (const browser of ['chrome', 'firefox']) {
  const source = sourceFor(`src/${browser}/src/agent/social-media-downloader.js`);

  test(`${browser}: repeated classic loads keep the API usable and log once`, () => {
    const realm = createRealm();
    let previous;
    for (let i = 0; i < 3; i++) {
      load(source, realm);
      assert.notEqual(realm.context.SocialMediaDownloader, previous);
      assert.equal(typeof realm.context.SocialMediaDownloader.getMediaBinding, 'function');
      previous = realm.context.SocialMediaDownloader;
    }
    assert.equal(realm.calls.logs, 2);
    assert.equal(realm.calls.network, 0);
    assert.equal(realm.calls.downloads, 0);
  });

  test(`${browser}: reinjection preserves captured MSE bytes and original hooks`, () => {
    const realm = createRealm();
    load(source, realm);
    const state = realm.context.__smd_mse;
    const hooks = [realm.MediaSource.prototype.addSourceBuffer, realm.SourceBuffer.prototype.appendBuffer, realm.URL.createObjectURL];
    const media = new realm.MediaSource(), buffer = media.addSourceBuffer('video/mp4');
    const bytes = new Uint8Array([1, 2, 3]);
    buffer.appendBuffer(bytes); bytes.fill(9);
    load(source, realm); buffer.appendBuffer(new Uint8Array([4, 5]));
    assert.equal(realm.context.__smd_mse, state);
    assert.deepEqual([realm.MediaSource.prototype.addSourceBuffer, realm.SourceBuffer.prototype.appendBuffer, realm.URL.createObjectURL], hooks);
    assert.deepEqual(Array.from(state.buffers.get(buffer).chunks[0]), [1, 2, 3]);
    const recording = realm.context.SocialMediaDownloader.getMseRecording();
    assert.equal(recording.mediaSources[0].buffers[0].bytes, 5);
    assert.equal(recording.mediaSources[0].buffers[0].chunks, 2);
    assert.equal(realm.calls.appends, 2);
  });

  test(`${browser}: unrelated hosts remain opt-in after repeated loads`, () => {
    const realm = createRealm('youtube.com.example.invalid');
    const original = realm.SourceBuffer.prototype.appendBuffer;
    load(source, realm); load(source, realm);
    assert.equal(realm.context.__smd_mse, undefined);
    assert.equal(realm.SourceBuffer.prototype.appendBuffer, original);
    assert.equal(realm.context.SocialMediaDownloader.armMseRecorder().armed, true);
    const hook = realm.SourceBuffer.prototype.appendBuffer;
    load(source, realm);
    assert.equal(realm.SourceBuffer.prototype.appendBuffer, hook);
    assert.equal(realm.context.SocialMediaDownloader.armMseRecorder().alreadyArmed, true);
  });

  test(`${browser}: repeated loads tolerate browsers without MSE`, () => {
    const realm = createRealm('www.youtube.com', false);
    load(source, realm); load(source, realm);
    assert.equal(realm.context.SocialMediaDownloader.armMseRecorder().armed, false);
    assert.equal(realm.context.__smd_mse, undefined);
  });

  test(`${browser}: actual media capture survives preloaded library reinjection`, async () => {
    const realm = createRealm();
    load(source, realm); installActualCapture(realm, browser);
    let captures = 0;
    const api = browser === 'chrome'
      ? { tabs: {}, scripting: { async executeScript(options) {
        assert.equal(options.world, 'MAIN');
        if (options.files) { assert.deepEqual(Array.from(options.files), ['src/agent/social-media-downloader.js']); load(source, realm); return []; }
        captures++; return [{ result: options.func() }];
      } } }
      : { tabs: { async executeScript(tabId, options) {
        assert.equal(tabId, 7);
        if (options.file) { assert.equal(options.file, 'src/agent/social-media-downloader.js'); load(source, realm); return []; }
        captures++; return [vm.runInContext(options.code, realm.context)];
      } } };
    const observation = await realm.context.captureMediaState(api, 7);
    assert.equal(captures, 1, 'Reach the real read-only observer after injection');
    assert.equal(observation.status, 'unavailable', 'An empty page has no bound media');
    assert.deepEqual(Object.keys(observation.diagnostics), ['auto', 'image', 'video']);
    assert.equal(realm.calls.network, 0);
    assert.equal(realm.calls.downloads, 0);
  });

  test(`${browser}: unrelated page lexical bindings do not block loading`, () => {
    const realm = createRealm();
    vm.runInContext("const _SMD_MSE_AUTOARM_HOSTS = 'page-owned';", realm.context);
    load(source, realm); load(source, realm);
    assert.equal(vm.runInContext('_SMD_MSE_AUTOARM_HOSTS', realm.context), 'page-owned');
    assert.equal(typeof realm.context.SocialMediaDownloader.run, 'function');
  });
}

test('both browser downloaders and the standalone fixture stay byte-identical', () => {
  const chrome = sourceFor('src/chrome/src/agent/social-media-downloader.js');
  assert.equal(sourceFor('src/firefox/src/agent/social-media-downloader.js'), chrome);
  assert.equal(sourceFor('test/smd-tests/social-media-downloader.js'), chrome);
});
