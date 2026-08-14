/**
 * Dedicated in-browser vision provider.
 *
 * This provider is intentionally not registered in ProviderManager's general
 * provider catalog. It is selected only through Settings -> Multimodal ->
 * Vision and receives screenshots for the existing split-provider vision
 * path; planning and tool calls always stay with the user's active provider.
 */

import { BaseLLMProvider } from './base.js';
import { ensureOffscreen } from '../offscreen/ensure.js';

export const WEBGPU_VISION_MODEL_ID = 'LiquidAI/LFM2.5-VL-450M-ONNX';
// Chrome-only selection state. Keep this separate from the synced
// `visionModel` endpoint so enabling the fallback never overwrites a user's
// remote vision credentials or sends a Chromium-only provider type to Firefox.
export const WEBGPU_VISION_ENABLED_KEY = 'webgpuVisionEnabled';
export const WEBGPU_VISION_DTYPE = Object.freeze({
  embed_tokens: 'fp16',
  vision_encoder: 'fp16',
  decoder_model_merged: 'q4',
});

export class WebGPUVisionProvider extends BaseLLMProvider {
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
    try {
      const response = await this._dispatch({ type: 'webgpu-vision-probe' });
      if (!response || response.error) {
        return { ok: false, error: response?.error || 'offscreen probe failed' };
      }
      if (!response.hasWebGPU) {
        return {
          ok: false,
          error: 'Hardware WebGPU is unavailable. Check chrome://gpu and enable WebGPU before using in-browser vision.',
        };
      }
      if (response.isFallbackAdapter) {
        return {
          ok: false,
          error: 'Chrome is using a software WebGPU adapter. In-browser vision requires a hardware WebGPU adapter.',
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

  async clearCache() {
    try {
      const response = await this._dispatch({ type: 'webgpu-vision-clear-cache' });
      return response?.error
        ? { ok: false, error: response.error }
        : { ok: true, deletedCaches: response?.deletedCaches || [] };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
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
}
