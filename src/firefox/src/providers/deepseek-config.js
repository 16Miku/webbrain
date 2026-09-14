/**
 * DeepSeek API contract.
 *
 * Single owner of everything DeepSeek-specific, so the generic OpenAI-compatible
 * provider (`openai.js`) and the shared compatibility presets
 * (`provider-compatibility.js`) stay vendor-agnostic and only delegate here.
 *
 * Source of truth: https://api-docs.deepseek.com/zh-cn/ (模型 & 价格 / 思考模式 /
 * 图像理解 / 上下文硬盘缓存 / 使用 Responses API / 限速与隔离).
 *
 * Deliberately dependency-free: `provider-compatibility.js` imports this module
 * and `deepseek.js` (the provider class) imports both, so importing back would
 * create a cycle.
 */

// Endpoints. The OpenAI-compatible API is rooted at the origin (no /v1) and the
// Anthropic-compatible API lives under /anthropic.
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_LEGACY_DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';

// `deepseek-flash` (DeepSeek-V4.1-Flash) is the current model id. The retired
// `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` ids still call the same
// model and are billed as Flash, so they keep first-class handling.
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';
export const DEEPSEEK_LEGACY_DEFAULT_MODEL = 'deepseek-v4-flash';

// 1M context, up to 384K output. The server defaults (8K non-thinking, 64K
// thinking, 128K at `max`) only apply when no budget is sent, and WebBrain
// always sends one, so the ceiling is the number that matters.
export const DEEPSEEK_FLASH_CONTEXT_WINDOW = 1000000;
export const DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS = 384000;

// Retired ids (`deepseek-chat`, `deepseek-reasoner`), the unsupported V4 Pro id,
// and unknown third-party DeepSeek slugs stay on the conservative generation:
// never over-claim capacity or vision for a model we cannot verify.
export const DEEPSEEK_LEGACY_CONTEXT_WINDOW = 65536;
export const DEEPSEEK_LEGACY_MAX_OUTPUT_TOKENS = 8192;

function clean(value) {
  return String(value || '').trim().toLowerCase();
}

/** Any DeepSeek model id, including router slugs such as `deepseek/deepseek-v4`. */
export function isDeepSeekModel(model) {
  return clean(model).includes('deepseek');
}

/**
 * V4.1-Flash family: the current id plus every retired alias that resolves to
 * it. Only this family is multimodal — `deepseek-v4-pro` (DeepSeek-V4-Pro-0813)
 * and the V3-era chat/reasoner ids are text-only.
 */
export function isDeepSeekV41FlashModel(model) {
  const m = clean(model);
  return m.includes('deepseek-flash') || m.includes('deepseek-v4-flash');
}

/**
 * Context window, output ceiling, and image input support for a DeepSeek model
 * id. Returns null for non-DeepSeek ids so callers keep their generic fallback.
 */
export function deepSeekModelCapabilities(model = '') {
  if (!isDeepSeekModel(model)) return null;
  if (isDeepSeekV41FlashModel(model)) {
    return {
      contextWindow: DEEPSEEK_FLASH_CONTEXT_WINDOW,
      maxOutputTokens: DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
      vision: true,
    };
  }
  return {
    contextWindow: DEEPSEEK_LEGACY_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_LEGACY_MAX_OUTPUT_TOKENS,
    vision: false,
  };
}

/**
 * Whether a config targets DeepSeek's own API: the `deepseek` provider card, or
 * any card pointed at api.deepseek.com (a proxy or a hand-made entry that opts
 * into the native contract). Local OpenAI-compatible servers that merely serve a
 * DeepSeek model are intentionally excluded by the caller.
 */
export function isDeepSeekEndpoint(config = {}) {
  if (clean(config.providerName) === 'deepseek') return true;
  try {
    const url = new URL(config.baseUrl || '');
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}

/**
 * DeepSeek's OpenAI-compatible API is rooted at the origin, unlike most
 * OpenAI-compatible servers whose API lives below /v1.
 */
export function isDeepSeekRootUrl(url) {
  return !!url
    && (url.protocol === 'http:' || url.protocol === 'https:')
    && url.hostname.toLowerCase() === 'api.deepseek.com'
    && url.pathname === '/'
    && !url.search
    && !url.hash;
}

/**
 * DeepSeek's documented effort ladder is low/high/max, with compatibility
 * aliases mapped by the server. WebBrain keeps its shared, more expressive UI
 * ladder and translates the values DeepSeek only accepts for compatibility.
 * (`ultra` maps to `max` upstream; the UI ladder has no `ultra`.)
 */
export function mappedDeepSeekReasoningEffort(effort) {
  if (effort === 'minimal') return 'low';
  if (effort === 'medium' || effort === 'xhigh') return 'high';
  return effort;
}

/**
 * Thinking-mode controls for one request.
 *
 * Chat Completions switches thinking with a top-level `thinking` object and
 * controls its strength with top-level `reasoning_effort`; a disabled-thinking
 * request must omit `reasoning_effort` entirely. The Responses API instead uses
 * `reasoning.effort`, where `none` disables thinking.
 *
 * `direct` is false for local/hosted OpenAI-compatible servers that merely serve
 * a DeepSeek model — those keep the Qwen-style chat-template switch.
 */
export function deepSeekThinkingExtras({
  direct = false,
  enabled = true,
  effort = 'auto',
  responses = false,
} = {}) {
  if (!direct) return { chat_template_kwargs: { thinking: enabled } };
  if (responses) {
    // Responses API callers need an explicit value. Match DeepSeek's documented
    // default instead of inheriting the generic OpenAI Responses default.
    return { reasoning: { effort: enabled ? mappedDeepSeekReasoningEffort(effort === 'auto' ? 'high' : effort) : 'none' } };
  }
  if (!enabled) return { thinking: { type: 'disabled' } };
  return {
    thinking: { type: 'enabled' },
    reasoning_effort: mappedDeepSeekReasoningEffort(effort),
  };
}

/**
 * Per-request controls for classifier/planner calls, which need short
 * machine-readable JSON instead of hidden reasoning. The native Chat Completions
 * contract supports JSON Object mode only (no JSON Schema); the Responses API
 * supports full `text.format` schemas, which the shared Responses body builder
 * derives from `response_format.type === 'json_schema'`.
 */
export function deepSeekPlannerExtras({
  direct = false,
  responses = false,
  includeResponseFormat = true,
  disableThinking = true,
  schema = null,
  schemaName = 'webbrain_planner',
} = {}) {
  const body = {};
  if (direct && disableThinking) {
    if (responses) body.reasoning = { effort: 'none' };
    else body.thinking = { type: 'disabled' };
  }
  if (!includeResponseFormat) return body;
  if (direct && !responses) {
    body.response_format = { type: 'json_object' };
    return body;
  }
  if (direct && responses && schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: String(schemaName || 'webbrain_planner').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
        strict: true,
        schema,
      },
    };
  }
  return body;
}

/**
 * Vision probe controls. DeepSeek ignores `temperature` while thinking, and a
 * visible reasoning channel would spend the whole caption budget, so thinking is
 * switched off natively before the probe runs.
 */
export function deepSeekVisionExtras(maxTokens = 800, { responses = false } = {}) {
  return {
    maxTokens,
    temperature: 0,
    extraBody: responses ? { reasoning: { effort: 'none' } } : { thinking: { type: 'disabled' } },
  };
}

/**
 * DeepSeek's disabled-thinking contract omits `reasoning_effort` entirely, so a
 * per-call planner/vision override must clear an effort inherited from the
 * configured compatibility preset.
 */
export function stripDisabledDeepSeekReasoningEffort(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (body.thinking?.type === 'disabled') delete body.reasoning_effort;
  return body;
}
