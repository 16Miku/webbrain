import { OpenAICompatibleProvider } from './openai.js';
import { isDirectDeepSeekConfig } from './provider-compatibility.js';
import {
  deepSeekModelCapabilities,
  isDeepSeekEndpoint,
} from './deepseek-config.js';

/**
 * DeepSeek provider (`type: 'openai'`, dispatched by `providers/manager.js`).
 *
 * Owns the DeepSeek-specific protocol behaviour so the generic
 * OpenAI-compatible provider stays vendor-agnostic:
 * - vision capability for the V4.1-Flash family (and its retired aliases),
 * - `stream_options.include_usage` on every request,
 * - cross-turn `reasoning_content` replay, which DeepSeek requires whenever a
 *   request carries `tools` (omitting it returns 400).
 *
 * The request-body contract (native `thinking` / `reasoning_effort`, the
 * Responses-API shape, planner and vision overrides) lives in
 * `deepseek-config.js`, because it is also consumed by call sites that only have
 * a plain provider config (the planner and the connection tests).
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  /** True when this card speaks DeepSeek's own API, not a local lookalike. */
  _isDirectDeepSeek() {
    return isDirectDeepSeekConfig({
      ...this.config,
      providerName: this.config.providerName || this.name,
      baseUrl: this.baseUrl,
      model: this.model,
    });
  }

  _modelNameSniffedVision(model) {
    const capabilities = deepSeekModelCapabilities(model);
    return capabilities ? capabilities.vision : super._modelNameSniffedVision(model);
  }

  _shouldRequestStreamUsage() {
    if (isDeepSeekEndpoint(this.config)) return true;
    return super._shouldRequestStreamUsage();
  }

  _supportsReasoningContentReplay(_options = {}) {
    return this._isDirectDeepSeek();
  }
}
