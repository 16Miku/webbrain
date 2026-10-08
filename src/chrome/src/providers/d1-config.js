export const D1_MODEL_ID = 'webbrain-one/d1-browser-decision-fp32';
export const D1_CONSENT_VERSION = 1;
export const D1_CONSENT_KEY = 'd1WebgpuConsentVersion';
export const D1_CACHE_NAME = 'webbrain-d1-fp32-v1';
// Immutable release package; downloaded data is verified before local loading.
export const D1_RELEASE = Object.freeze({ revision: '71866f0ccab0b9fa92c6df64d1c34eacf2a7b2b8', manifestSha256: '47b3a9efa02ce2cacf6da8c19607cc1179a8a2b7a339aebf3db05f2237151dbb' });
export const D1_REQUIRED_FILES = Object.freeze(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'tiling-ratios.json', 'onnx/decision.onnx', 'onnx/decision.data', 'onnx/vision.onnx', 'onnx/vision.data', 'onnx/projector.onnx', 'onnx/projector.data']);

export function d1BaseURL() {
  if (!/^[a-f0-9]{40}$/.test(D1_RELEASE.revision) || !/^[a-f0-9]{64}$/.test(D1_RELEASE.manifestSha256)) throw new Error('The experimental D1 package is not pinned in this build.');
  return `https://huggingface.co/${D1_MODEL_ID}/resolve/${D1_RELEASE.revision}/`;
}

export function d1AdapterInfo(adapter) {
  const info = adapter?.info || {};
  return { vendor: info.vendor || '', architecture: info.architecture || '', device: info.device || '', description: info.description || '', isFallbackAdapter: adapter?.isFallbackAdapter ?? info.isFallbackAdapter ?? null };
}

export function assertD1Adapter(adapter) {
  if (!adapter) throw new Error('Hardware WebGPU is unavailable.');
  const info = d1AdapterInfo(adapter);
  if (info.isFallbackAdapter === true || /swiftshader|llvmpipe|software|lavapipe/i.test(Object.values(info).join(' '))) throw new Error('D1 requires hardware WebGPU, not a software adapter.');
  // The FP32 [65536,1024] embedding is one 256 MiB Gather storage input.
  if (adapter.limits.maxBufferSize < 268435456 || adapter.limits.maxStorageBufferBindingSize < 268435456) throw new Error('D1 requires at least 256 MiB buffer and storage-binding limits for its FP32 embedding.');
  return info;
}
