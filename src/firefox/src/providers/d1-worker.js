import { D1_MODEL_ID, D1_CONSENT_VERSION, D1_RELEASE, assertD1Adapter } from './d1-config.js';
import { openD1Cache, readD1Manifest, validateD1Manifest, d1CachedFile, setD1Ready, removeStaleD1Caches } from './d1-cache.js';
import { createD1Runtime } from './d1-runtime.js';

let runtime = null, device = null, state = { status: 'idle', progress: 0, loaded: false }, transfer = null;
let queue = Promise.resolve();
// One load at a time, shared by Settings' Load, a download's last step and a
// reload. A reload starts once per Worker until a load succeeds again, so a
// broken cache or GPU is not verified again on every decision.
let loading = null, reloadController = null, reloadBlocked = false;
// An evaluation whose caller stopped waiting (a judge timeout, Stop) is
// cancelled by request id instead of discarding the loaded model: a queued
// one is skipped, a running one stops between graph runs (d1-runtime.js).
const requests = new Map(), cancelledEarly = new Set();
const publish = update => { state = { ...state, ...update }; self.postMessage({ state }); };
const errors = [];
const codedError = (code, message) => Object.assign(new Error(message), { code });
const cancelled = () => codedError('D1_REQUEST_CANCELLED', 'D1 request cancelled.');

async function probe() {
  if (!navigator.gpu) throw new Error('Hardware WebGPU is unavailable in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  return { adapter, info: assertD1Adapter(adapter) };
}

function prepare(signal) {
  if (runtime) return Promise.resolve({ ready: true, ...state });
  loading ??= load(signal).finally(() => { loading = null; });
  return loading;
}

async function load(signal) {
  const { adapter, info } = await probe();
  const directory = await openD1Cache(), manifest = await readD1Manifest(directory), specs = validateD1Manifest(manifest);
  const { PreTrainedTokenizer } = await import('../../vendor/d1/transformers.web.js');
  const ort = await import('../../vendor/d1/ort.webgpu.bundle.min.mjs');
  ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.logLevel = 'warning';
  ort.env.wasm.wasmPaths = { mjs: new URL('../../vendor/d1/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href, wasm: new URL('../../vendor/d1/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href };
  const loadingDevice = await adapter.requestDevice({ requiredFeatures: ['shader-f16'].filter(feature => adapter.features.has(feature)), requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension } });
  device = loadingDevice; ort.env.webgpu.device = loadingDevice;
  loadingDevice.addEventListener('uncapturederror', event => { errors.push(String(event.error.message)); publish({ error: String(event.error.message) }); });
  loadingDevice.lost.then(info => { if (info.reason !== 'destroyed' && device === loadingDevice) { runtime = null; publish({ status: 'error', loaded: false, error: 'WebGPU device lost: ' + info.message }); } });
  const json = async path => JSON.parse(await (await d1CachedFile(directory, specs[path], { signal })).text());
  const sessions = {};
  try {
    const config = await json('config.json'), ratios = await json('tiling-ratios.json');
    const tokenizer = new PreTrainedTokenizer(await json('tokenizer.json'), await json('tokenizer_config.json'));
    for (const role of ['decision', 'vision', 'projector']) {
      publish({ status: 'loading', component: role, adapter: info });
      const graph = new Uint8Array(await (await d1CachedFile(directory, specs[`onnx/${role}.onnx`], { signal })).arrayBuffer());
      const data = new Uint8Array(await (await d1CachedFile(directory, specs[`onnx/${role}.data`], { signal })).arrayBuffer());
      // Vision and projector outputs feed the next graph on the GPU (d1-runtime.js).
      const preferredOutputLocation = { vision: { hidden: 'gpu-buffer' }, projector: { prefix: 'gpu-buffer' } }[role];
      sessions[role] = await ort.InferenceSession.create(graph, { executionProviders: [{ name: 'webgpu', device: loadingDevice }], graphOptimizationLevel: 'basic', logSeverityLevel: 2, ...(preferredOutputLocation ? { preferredOutputLocation } : {}), extra: { session: { disable_cpu_ep_fallback: '0' } }, externalData: [{ path: `${role}.data`, data }] });
      if (signal?.aborted) throw signal.reason;
    }
    runtime = createD1Runtime({ ort, tokenizer, config, ratios, sessions, device: loadingDevice, model: D1_MODEL_ID, dtype: manifest.dtype });
    reloadBlocked = false;
    publish({ status: 'ready', loaded: true, progress: 100, adapter: info, runtime: ort.env.versions, error: '', cpu_fallback_policy: 'CPU/WASM control/shape fallback allowed; not a pure GPU claim.' });
    return { ready: true, ...state };
  } catch (error) { for (const session of Object.values(sessions)) await session.release().catch(() => {}); loadingDevice.destroy(); if (device === loadingDevice) device = null; publish({ status: signal?.aborted ? 'stopped' : 'error', loaded: false, error: String(error.message || error) }); throw error; }
}

// The finished download's marker in the cache, or null.
async function readyMarker() {
  try {
    const directory = await openD1Cache();
    return JSON.parse(await (await (await directory.getFileHandle('ready.json')).getFile()).text());
  } catch { return null; }
}
const currentPackage = marker => marker?.revision === D1_RELEASE.revision && marker?.manifestSha256 === D1_RELEASE.manifestSha256;

async function status() {
  if (transfer || runtime || loading || ['error', 'stopped'].includes(state.status)) {
    // An error or a stop leaves the verified cache in place (a lost GPU device
    // after a good download, say); report it so Settings can retry with Load
    // instead of falling back to a full download pass.
    const cached = !transfer && !runtime && !loading && currentPackage(await readyMarker());
    return { ...state, ready: !!runtime, cached };
  }
  const marker = await readyMarker();
  return marker ? { ...state, status: currentPackage(marker) ? 'cached' : 'idle', ready: false, loaded: false } : { ...state, ready: false };
}

// A decision found the model unloaded while the user's Load choice stands.
// Only the verified cache is read; the decision itself uses the fallback.
function reload() {
  reloadBlocked = true;
  const controller = new AbortController(); reloadController = controller;
  loading = (async () => {
    try {
      if (!currentPackage(await readyMarker())) throw new Error('D1 is not downloaded. Download it in Decision models settings.');
      return await load(controller.signal);
    } catch (error) {
      // Settings shows why D1 still answers nothing; no caller awaits a reload.
      if (!controller.signal.aborted) publish({ status: 'error', loaded: false, error: String(error?.message || error) });
      throw error;
    }
  })().finally(() => { loading = null; if (reloadController === controller) reloadController = null; });
  loading.catch(() => {});
}

function unloaded(payload) {
  if (!loading && !transfer && !reloadBlocked && payload?.keepLoaded === true && payload.consentVersion === D1_CONSENT_VERSION) reload();
  return loading
    ? codedError('D1_MODEL_LOADING', 'D1 is loading its cached model; this decision uses the existing fallback.')
    : codedError('D1_MODEL_NOT_LOADED', 'D1 is not loaded. Download or load it explicitly in Decision models settings.');
}

function startDownload(payload) {
  if (payload?.consentVersion !== D1_CONSENT_VERSION) throw new Error('Explicit experimental D1 download consent is required.');
  if (transfer) return { started: true, ...state };
  if (runtime) return { started: false, ready: true, ...state };
  const controller = new AbortController(); transfer = controller;
  let stall;
  const resetStall = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(new Error('D1 download made no byte progress for two minutes.')), 120_000); };
  const deadline = setTimeout(() => controller.abort(new Error('D1 download/load exceeded thirty minutes.')), 30 * 60_000);
  resetStall();
  publish({ status: 'checking', error: '', progress: 0 });
  (async () => {
    await probe();
    // Packages for other revisions are never loaded again; free their storage.
    await removeStaleD1Caches().catch(() => {});
    const directory = await openD1Cache(), manifest = await readD1Manifest(directory, { download: true, signal: controller.signal }), specs = validateD1Manifest(manifest);
    await setD1Ready(directory, false);
    const total = Object.values(specs).reduce((n, spec) => n + spec.bytes, 0); let completed = 0;
    for (const spec of Object.values(specs)) {
      await d1CachedFile(directory, spec, { download: true, signal: controller.signal, onProgress: loaded => { resetStall(); publish({ status: 'downloading', file: spec.path, progress: (completed + loaded) / total * 100, bytes: completed + loaded, total }); } });
      completed += spec.bytes; publish({ status: 'downloading', progress: completed / total * 100, bytes: completed, total });
      resetStall();
    }
    await setD1Ready(directory, true); await prepare(controller.signal);
  })().catch(error => publish({ status: controller.signal.aborted ? 'stopped' : 'error', loaded: false, error: String(error.message || error) })).finally(() => { clearTimeout(stall); clearTimeout(deadline); if (transfer === controller) transfer = null; });
  return { started: true, ...state };
}

async function execute(type, payload = {}, signal) {
  if (type === 'probe') { const { adapter, info } = await probe(); return { success: true, adapter: info, features: [...adapter.features] }; }
  if (type === 'status') return status();
  if (type === 'download') return startDownload(payload);
  if (type === 'stop') { transfer?.abort(new Error('D1 download stopped by user.')); return { stopped: true }; }
  if (type === 'dispose') {
    const reason = new Error('D1 disabled.'); transfer?.abort(reason); reloadController?.abort(reason);
    await loading?.catch(() => {});
    await runtime?.dispose(); runtime = null; device = null; publish({ status: 'idle', loaded: false }); return { disposed: true };
  }
  if (type === 'load') { if (payload.consentVersion !== D1_CONSENT_VERSION) throw new Error('D1 consent is required.'); if (transfer) throw new Error('D1 download/load is already in progress.'); return prepare(); }
  if (type === 'clear') { if (runtime || transfer || loading) throw new Error('Disable D1 before removing its cache.'); const directory = await openD1Cache(); for await (const [name] of directory.entries()) await directory.removeEntry(name); publish({ status: 'idle', loaded: false }); return { removed: true }; }
  if (type === 'evaluate') {
    if (signal?.aborted) throw signal.reason;
    if (!runtime) throw unloaded(payload);
    const result = await runtime.evaluate({ state: payload.state, images: payload.images, questions: payload.questions, signal });
    return { ...result, diagnostics: { ...result.diagnostics, adapter: state.adapter, runtime: state.runtime, model_revision: D1_RELEASE.revision, package_manifest_sha256: D1_RELEASE.manifestSha256, gpu_errors: [...errors] } };
  }
  throw new Error('Unknown D1 worker command.');
}

function cancel(requestId) {
  const controller = requests.get(requestId);
  if (controller) { controller.abort(cancelled()); return; }
  // The cancel overtook its request; keep a bounded record so it is skipped.
  cancelledEarly.add(requestId);
  if (cancelledEarly.size > 64) cancelledEarly.delete(cancelledEarly.values().next().value);
}

self.onmessage = event => {
  const { id, type, payload } = event.data || {};
  if (type === 'cancel') {
    if (typeof payload?.requestId === 'string') cancel(payload.requestId);
    self.postMessage({ id, ok: true, result: { cancelled: true } }); return;
  }
  const requestId = type === 'evaluate' && typeof payload?.requestId === 'string' ? payload.requestId : null;
  const controller = requestId ? new AbortController() : null;
  if (requestId) { if (cancelledEarly.delete(requestId)) controller.abort(cancelled()); requests.set(requestId, controller); }
  const run = () => execute(type, payload, controller?.signal);
  const immediate = ['status', 'stop', 'download', 'probe'].includes(type);
  const promise = immediate ? Promise.resolve().then(run) : (queue = queue.then(run, run));
  promise.finally(() => { if (requestId && requests.get(requestId) === controller) requests.delete(requestId); })
    .then(result => self.postMessage({ id, ok: true, result }), error => self.postMessage({ id, ok: false, error: String(error?.message || error), ...(typeof error?.code === 'string' ? { code: error.code } : {}) }));
};
