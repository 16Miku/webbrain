/** In-browser WebGPU providers hosted by Chrome's shared offscreen worker. */

import { BaseLLMProvider } from './base.js';
import { ensureOffscreen } from '../offscreen/ensure.js';

export const WEBGPU_VISION_MODEL_ID = 'LiquidAI/LFM2.5-VL-450M-ONNX';
export const WEBGPU_MODEL_ID = 'LiquidAI/LFM2.5-2.6B-ONNX';
export const WEBGPU_LFM25_MODEL_ID = WEBGPU_MODEL_ID;
export const WEBGPU_BONSAI27_MODEL_ID = 'prism-ml/Bonsai-27B-gguf';
export const WEBGPU_DTYPE = 'q4f16';
export const WEBGPU_BONSAI27_DTYPE = 'q1';
export const WEBGPU_RUNTIME_ONNX = 'onnx';
export const WEBGPU_RUNTIME_BITGPU = 'bitgpu';
export const WEBGPU_MODEL_PRESETS = Object.freeze([
  Object.freeze({
    id: WEBGPU_LFM25_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX,
    label: 'Minimal',
    size: '1.55 GB',
    dtype: WEBGPU_DTYPE,
    dtypeLabel: WEBGPU_DTYPE,
    contextWindow: 16384,
  }),
  Object.freeze({
    id: WEBGPU_BONSAI27_MODEL_ID,
    runtime: WEBGPU_RUNTIME_BITGPU,
    label: 'Basic',
    size: '3.8 GB',
    dtype: WEBGPU_BONSAI27_DTYPE,
    dtypeLabel: WEBGPU_BONSAI27_DTYPE,
    contextWindow: 4096,
  }),
]);
export const WEBGPU_MODEL_NOT_READY_ERROR = `${WEBGPU_MODEL_ID} is not downloaded. Open Apocalypse Mode > WebGPU to download it before chatting.`;
// Chrome-only selection state. Keep this separate from the synced
// `visionModel` endpoint so enabling the fallback never overwrites a user's
// remote vision credentials or sends a Chromium-only provider type to Firefox.
export const WEBGPU_VISION_ENABLED_KEY = 'webgpuVisionEnabled';
// Present only while an Apocalypse-triggered selection is awaiting a model
// preload result. The service worker may roll back that automatic choice on
// failure, while a later explicit Settings choice clears this provenance.
export const WEBGPU_VISION_AUTO_SELECTED_KEY = 'webgpuVisionAutoSelected';
export const WEBGPU_VISION_DOWNLOAD_STATE_KEY = 'webgpuVisionDownloadState';
export const WEBGPU_VISION_DOWNLOAD_STATE_MESSAGE = 'webgpu-vision-download-state';
export const WEBGPU_VISION_DTYPE = Object.freeze({
  embed_tokens: 'fp16',
  vision_encoder: 'fp16',
  decoder_model_merged: 'q4',
});

export function normalizeWebgpuModelId(value) {
  let model = String(value || '').trim();
  if (!model) return WEBGPU_MODEL_ID;
  if (/^https?:\/\//i.test(model)) {
    let url;
    try {
      url = new URL(model);
    } catch {
      throw new Error('Enter a Hugging Face repository as owner/repository or a huggingface.co URL.');
    }
    if (!['huggingface.co', 'www.huggingface.co'].includes(url.hostname.toLowerCase())) {
      throw new Error('Custom WebGPU models must use a huggingface.co repository.');
    }
    const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
    if (parts.length !== 2) {
      throw new Error('Use the repository URL, not a file, branch, or collection URL.');
    }
    model = parts.join('/');
  }
  model = model.replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
    throw new Error('Enter a Hugging Face repository as owner/repository.');
  }
  return model;
}

export function webgpuModelPreset(modelId) {
  try {
    const normalized = normalizeWebgpuModelId(modelId);
    return WEBGPU_MODEL_PRESETS.find(preset => preset.id === normalized) || null;
  } catch {
    return null;
  }
}

export function isShippedWebgpuPreset(modelId) {
  return webgpuModelPreset(modelId) != null;
}

export function webgpuModelRuntime(modelId) {
  return webgpuModelPreset(modelId)?.runtime || WEBGPU_RUNTIME_ONNX;
}

export function webgpuModelDisplayName(modelId) {
  const normalized = normalizeWebgpuModelId(modelId);
  return webgpuModelPreset(normalized)?.label || normalized;
}

export function webgpuModelDtype(modelId, fallback = WEBGPU_DTYPE) {
  const normalized = normalizeWebgpuModelId(modelId);
  return webgpuModelPreset(normalized)?.dtype || fallback;
}

export function webgpuModelRequiresToolTemplate(modelId) {
  const normalized = normalizeWebgpuModelId(modelId);
  return !isShippedWebgpuPreset(normalized);
}

class WebGPUOffscreenProvider extends BaseLLMProvider {
  async _dispatch(message) {
    await ensureOffscreen();
    return await new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) reject(new Error(lastError.message));
          else resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async _testWebGPU() {
    try {
      const response = await this._dispatch({ type: 'webgpu-probe' });
      if (!response || response.error) {
        return { ok: false, error: response?.error || 'offscreen probe failed' };
      }
      if (!response.hasWebGPU) {
        return {
          ok: false,
          error: 'Hardware WebGPU is unavailable. Check chrome://gpu and enable WebGPU before using this provider.',
        };
      }
      if (response.isFallbackAdapter) {
        return {
          ok: false,
          error: 'Chrome is using a software WebGPU adapter. This provider requires a hardware WebGPU adapter.',
        };
      }
      return {
        ok: true,
        model: this.model,
        device: 'webgpu',
        libraryVersion: response.libraryVersion || null,
      };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }
}

/**
 * General, endpoint-free local provider. LFM2.5 2.6B uses Transformers.js ONNX;
 * Bonsai 27B uses the vendored bitgpu worker.
 */
export class WebGPUProvider extends WebGPUOffscreenProvider {
  constructor(config = {}) {
    const model = normalizeWebgpuModelId(config.model);
    const dtype = webgpuModelDtype(model, config.dtype || WEBGPU_DTYPE);
    super({
      ...config,
      type: 'webgpu',
      category: 'local',
      providerName: 'webgpu',
      label: 'WebGPU (In-browser)',
      baseUrl: '',
      model,
      device: 'webgpu',
      dtype,
      promptTier: config.promptTier || 'compact',
      supportsVision: false,
      supportsAskStreaming: false,
    });
    this.model = model;
    this.baseUrl = '';
    this.device = 'webgpu';
    this.dtype = dtype;
    this.requiresToolTemplate = webgpuModelRequiresToolTemplate(model);
  }

  get name() {
    return 'webgpu';
  }

  get supportsTools() {
    return true;
  }

  async chat(messages, options = {}) {
    if (this._messagesContainImage(messages)) {
      throw new Error('The WebGPU chat model is text-only. Configure a separate model under Settings -> Multimodal for screenshots.');
    }
    const download = await this.downloadStatus();
    if (!download.ready) {
      throw new Error(`${webgpuModelDisplayName(this.model)} is not downloaded. Open Apocalypse Mode > WebGPU to download it before chatting.`);
    }
    const response = await this._dispatch({
      type: 'webgpu-chat',
      model: this.model,
      runtime: webgpuModelRuntime(this.model),
      device: this.device,
      dtype: this.dtype,
      requireTools: this.requiresToolTemplate,
      messages: this._chatMessages(messages, options),
      options: {
        maxTokens: options.maxTokens,
        tools: Array.isArray(options.tools) ? options.tools : [],
      },
    });
    if (!response || response.error) {
      const error = new Error(`In-browser WebGPU: ${response?.error || 'no response from the inference worker'}`);
      // A failed OrtRun leaves the WebGPU session/device in an unknown state,
      // while an exhausted generation budget is deterministic for the same
      // prompt. The generic two-second network retry only repeats either costly
      // GPU failure, so surface these terminally instead.
      if (/OrtRun|BufferManager::Download|mapAsync|GPUBuffer|device lost|used its generation budget before finishing reasoning|cannot hold Bonsai 27B/i.test(error.message)) {
        error.isAskStreamTerminalError = true;
      }
      throw error;
    }
    return {
      content: String(response.content || ''),
      reasoningContent: response.reasoningContent || null,
      toolCalls: Array.isArray(response.toolCalls) && response.toolCalls.length ? response.toolCalls : null,
      usage: null,
      raw: response.raw || null,
    };
  }

  /** Probe the packaged runtime and adapter without downloading model weights. */
  async testConnection() {
    return this._testWebGPU();
  }

  async downloadStatus() {
    const response = await this._dispatch({
      type: 'webgpu-download-status',
      model: this.model,
      runtime: webgpuModelRuntime(this.model),
      dtype: this.dtype,
    });
    if (!response || response.error) {
      throw new Error(response?.error || 'Unable to read the WebGPU model download status.');
    }
    return response;
  }

  _textDownloadTarget(options = {}) {
    const model = String(options.model || this.model).trim() || this.model;
    return {
      model,
      runtime: webgpuModelRuntime(model),
      dtype: webgpuModelDtype(model, options.dtype || this.dtype),
      requireTools: webgpuModelRequiresToolTemplate(model),
    };
  }

  async startDownload(options = {}) {
    const target = this._textDownloadTarget(options);
    const response = await this._dispatch({
      type: 'webgpu-download-start',
      model: target.model,
      runtime: target.runtime,
      device: this.device,
      dtype: target.dtype,
      requireTools: target.requireTools,
    });
    if (!response || response.error) {
      throw new Error(response?.error || `Unable to download ${webgpuModelDisplayName(target.model)}.`);
    }
    return response;
  }

  async pauseDownload() {
    const response = await this._dispatch({ type: 'webgpu-download-pause' });
    if (!response || response.error) {
      throw new Error(response?.error || 'Unable to pause the WebGPU model download.');
    }
    return response;
  }

  async stopDownload(options = {}) {
    const target = this._textDownloadTarget(options);
    const response = await this._dispatch({
      type: 'webgpu-download-stop',
      model: target.model,
      runtime: target.runtime,
      dtype: target.dtype,
    });
    if (!response || response.error) {
      throw new Error(response?.error || 'Unable to stop the WebGPU model download.');
    }
    return response;
  }

  /** Release text-model GPU allocations while preserving the browser cache. */
  async dispose() {
    try {
      const response = await this._dispatch({ type: 'webgpu-dispose' });
      return response?.error
        ? { ok: false, error: response.error }
        : { ok: true, disposed: response?.disposed !== false };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }
}

export class WebGPUVisionProvider extends WebGPUOffscreenProvider {
  constructor(config = {}) {
    const model = String(config.model || WEBGPU_VISION_MODEL_ID).trim();
    super({
      ...config,
      type: 'webgpu',
      category: 'local',
      providerName: 'webgpu-vision',
      label: 'In-browser vision',
      baseUrl: 'local://webgpu',
      model,
      supportsVision: true,
    });
    this.model = model;
    this.baseUrl = this.config.baseUrl;
    this.device = config.device || 'webgpu';
    this.dtype = config.dtype || WEBGPU_VISION_DTYPE;
  }

  get name() {
    return 'webgpu-vision';
  }

  get supportsVision() {
    return true;
  }

  get supportsTools() {
    return false;
  }

  async chat(messages, options = {}) {
    const stored = await chrome.storage.local.get(WEBGPU_VISION_ENABLED_KEY);
    if (stored[WEBGPU_VISION_ENABLED_KEY] !== true) {
      throw new Error('The local Vision Model is disabled. Enable or download it in Apocalypse Mode before using screenshots.');
    }
    const response = await this._dispatch({
      type: 'webgpu-vision-chat',
      model: this.model,
      device: this.device,
      dtype: this.dtype,
      messages,
      options: {
        maxTokens: options.maxTokens,
        ...(options.webbrainVisionProbe === true ? { visionProbe: true } : {}),
      },
    });
    if (!response || response.error) {
      throw new Error(`In-browser vision: ${response?.error || 'no response from the inference worker'}`);
    }
    return {
      content: String(response.content || ''),
      toolCalls: null,
      usage: null,
      raw: response.raw || null,
    };
  }

  /** Probe WebGPU and the packaged runtime without downloading model weights. */
  async testConnection() {
    return this._testWebGPU();
  }

  /** Start caching the model in the offscreen worker without waiting for the transfer. */
  async preload() {
    try {
      const response = await this._dispatch({
        type: 'webgpu-vision-preload',
        model: this.model,
        device: this.device,
        dtype: this.dtype,
      });
      return response?.error
        ? { ok: false, error: response.error }
        : { ok: true, started: response?.started !== false, ready: response?.ready === true };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async pauseDownload() {
    try {
      const response = await this._dispatch({
        type: 'webgpu-vision-pause',
        model: this.model,
      });
      return response?.error
        ? { ok: false, error: response.error }
        : { ok: true, ...response };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async stopDownload() {
    try {
      const response = await this._dispatch({
        type: 'webgpu-vision-stop',
        model: this.model,
        dtype: this.dtype,
      });
      return response?.error
        ? { ok: false, error: response.error }
        : { ok: true, ...response };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async clearCache() {
    return this.stopDownload();
  }

  /** Release GPU/model allocations while preserving downloaded model files. */
  async dispose() {
    try {
      const response = await this._dispatch({ type: 'webgpu-vision-dispose' });
      return response?.error
        ? { ok: false, error: response.error }
        : { ok: true, disposed: response?.disposed !== false };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

}
