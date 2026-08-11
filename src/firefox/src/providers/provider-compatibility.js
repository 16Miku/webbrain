const COMPATIBILITY_PRESETS = new Set(['auto', 'openai', 'qwen', 'deepseek', 'openrouter', 'custom']);
const REASONING_EFFORTS = new Set(['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const SYSTEM_PROMPT_ROLES = new Set(['auto', 'system', 'developer']);
const MAX_TOKEN_FIELDS = new Set(['auto', 'max_tokens', 'max_completion_tokens']);
const STRUCTURED_OUTPUT_PROVIDER_NAMES = new Set([
  'azure-openai',
  'llamacpp',
  'lmstudio',
  'localai',
  'ollama',
  'openai',
  'openrouter',
  'sglang',
  'vllm',
]);
const LOCAL_OPENAI_COMPAT_PROVIDER_NAMES = new Set([
  'llamacpp',
  'lmstudio',
  'localai',
  'ollama',
  'sglang',
  'vllm',
]);

export const RESERVED_EXTRA_BODY_KEYS = new Set([
  'model',
  'messages',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'stream',
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
]);

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function clean(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Normalize an OpenAI-compatible API base without rewriting provider-specific
 * paths. Bare origins such as LM Studio's http://127.0.0.1:1234 need /v1;
 * explicit paths such as /api/v1 or /compatible-mode/v1 are already complete.
 */
export function normalizeOpenAICompatibleBaseUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if ((url.protocol === 'http:' || url.protocol === 'https:')
        && url.pathname === '/'
        && !url.search
        && !url.hash) {
      return `${trimmed}/v1`;
    }
  } catch { /* preserve validation behavior at the eventual request site */ }
  return trimmed;
}

export function openAiCompatiblePayloadError(payload, maxLength = 500) {
  const error = payload?.error;
  if (!error) return '';
  const detail = typeof error === 'string'
    ? error
    : String(error.message || error.detail || JSON.stringify(error));
  return detail.slice(0, maxLength);
}

export function visionGenerationOptions(maxTokens = 800, { reasoningControl = true } = {}) {
  const extraBody = {};
  if (reasoningControl) {
    // LM Studio 0.4.8+ honors these fields for Chat Completions. They prevent
    // Qwen vision models from spending the entire output budget in a hidden
    // reasoning channel and leaving no caption for the browser agent.
    extraBody.reasoning_effort = 'none';
    extraBody.reasoning_tokens = 0;
    extraBody.chat_template_kwargs = { enable_thinking: false };
  }
  return { maxTokens, temperature: 0, extraBody };
}

export function unsupportedVisionGenerationControl(error) {
  const message = String(error?.message || error || '');
  return /reasoning_effort|reasoning_tokens|chat_template_kwargs|enable_thinking/i.test(message);
}

function isDirectDeepSeekConfig(config = {}) {
  const providerName = clean(config.providerName);
  if (providerName === 'deepseek') return true;
  try {
    if (new URL(config.baseUrl || '').hostname.toLowerCase() === 'api.deepseek.com') return true;
  } catch {}
  return normalizeProviderCompatibility(config).preset === 'deepseek'
    && clean(config.category) !== 'local'
    && !LOCAL_OPENAI_COMPAT_PROVIDER_NAMES.has(providerName);
}

export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function allowedValue(value, allowed, fallback = 'auto') {
  const normalized = clean(value);
  return allowed.has(normalized) ? normalized : fallback;
}

export function normalizeProviderCompatibility(config = {}) {
  const compat = isPlainObject(config.compat) ? config.compat : {};
  return {
    preset: allowedValue(compat.preset ?? config.compatibilityPreset, COMPATIBILITY_PRESETS),
    reasoningEffort: allowedValue(compat.reasoningEffort ?? config.reasoningEffort, REASONING_EFFORTS),
    systemPromptRole: allowedValue(compat.systemPromptRole ?? config.systemPromptRole, SYSTEM_PROMPT_ROLES),
    maxTokensField: allowedValue(compat.maxTokensField ?? config.maxTokensField, MAX_TOKEN_FIELDS),
  };
}

export function isOfficialOpenAIConfig(config = {}) {
  const providerName = clean(config.providerName);
  if (providerName && providerName !== 'openai') return false;
  try {
    const url = new URL(config.baseUrl || 'https://api.openai.com/v1');
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'api.openai.com'
      && url.pathname.replace(/\/+$/, '') === '/v1';
  } catch {
    return false;
  }
}

export function shouldUseOpenAIResponsesApi(config = {}) {
  if (config.apiFormat === 'responses') return true;
  if (!isOfficialOpenAIConfig(config)) return false;
  const model = String(config.model || '').trim().toLowerCase();
  // GPT-5.6 needs Responses for reliable reasoning/tool replay. GPT-5 Pro,
  // GPT-5.2 Pro, GPT-5.4 Pro, and GPT-5.5 Pro are Responses-only. Proxies and
  // compatible providers keep their existing Chat Completions wire format even
  // when they reuse an OpenAI model id.
  return /^gpt-5\.6(?:$|-(?:sol|terra|luna)(?:$|-))/.test(model)
    || /^gpt-5(?:\.(?:2|4|5))?-pro(?:$|-\d{4}-\d{2}-\d{2}$)/.test(model);
}

export function supportsOpenAIAskStreaming(config = {}) {
  if (!isOfficialOpenAIConfig(config)) return false;

  const model = clean(config.model);
  // Keep this as an explicit capability allowlist. In particular,
  // GPT-5.5 Pro does not support streaming even though it is Responses-only.
  if (/^gpt-5\.5-pro(?:$|-\d{4}-\d{2}-\d{2}$)/.test(model)) return false;
  if (shouldUseOpenAIResponsesApi(config)) return true;

  return [
    /^gpt-5\.5(?:$|-\d{4}-\d{2}-\d{2}$)/,
    /^gpt-5\.4(?:$|-\d{4}-\d{2}-\d{2}$|-(?:mini|nano)(?:$|-\d{4}-\d{2}-\d{2}$))/,
    /^gpt-5\.(?:1|2)(?:$|-\d{4}-\d{2}-\d{2}$)/,
    /^gpt-5(?:$|-\d{4}-\d{2}-\d{2}$|-(?:mini|nano)(?:$|-\d{4}-\d{2}-\d{2}$))/,
    /^gpt-5(?:\.(?:1|2|3))?-chat-latest$/,
    /^gpt-4\.1(?:$|-\d{4}-\d{2}-\d{2}$|-(?:mini|nano)(?:$|-\d{4}-\d{2}-\d{2}$))/,
    /^gpt-4o(?:$|-\d{4}-\d{2}-\d{2}$|-mini(?:$|-\d{4}-\d{2}-\d{2}$))/,
    /^gpt-4-turbo(?:$|-\d{4}-\d{2}-\d{2}$|-preview$)/,
    /^o1(?:$|-\d{4}-\d{2}-\d{2}$|-preview(?:$|-\d{4}-\d{2}-\d{2}$))/,
    /^o3(?:$|-\d{4}-\d{2}-\d{2}$|-mini(?:$|-\d{4}-\d{2}-\d{2}$))/,
    /^o4-mini(?:$|-\d{4}-\d{2}-\d{2}$)/,
    /^chatgpt-4o-latest$/,
    /^chat-latest$/,
  ].some(pattern => pattern.test(model));
}

export function detectedCompatibilityPreset(config = {}) {
  const providerName = clean(config.providerName);
  const model = clean(config.model);
  if (providerName === 'openrouter') return 'openrouter';
  if (providerName === 'deepseek' || model.includes('deepseek')) return 'deepseek';
  if (model.includes('qwen')) return 'qwen';
  if (isOfficialOpenAIConfig(config)) return 'openai';
  return 'standard';
}

export function effectiveCompatibilityPreset(config = {}) {
  const compat = normalizeProviderCompatibility(config);
  return compat.preset === 'auto' ? detectedCompatibilityPreset(config) : compat.preset;
}

export function mapProviderMessages(messages, config = {}) {
  if (!Array.isArray(messages)) return [];
  const { systemPromptRole } = normalizeProviderCompatibility(config);
  if (systemPromptRole !== 'developer') return messages;
  return messages.map((message) => {
    if (!message || message.role !== 'system') return message;
    return { ...message, role: 'developer' };
  });
}

export function configuredMaxTokensField(config = {}, fallback = 'max_tokens') {
  const { maxTokensField } = normalizeProviderCompatibility(config);
  return maxTokensField === 'auto' ? fallback : maxTokensField;
}

export function addConfiguredMaxTokens(body, value, config = {}, fallback = 'max_tokens') {
  body[configuredMaxTokensField(config, fallback)] = value;
  return body;
}

function safeClone(value) {
  if (Array.isArray(value)) return value.map((item) => safeClone(item));
  if (!isPlainObject(value)) return value;
  const clone = {};
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    clone[key] = safeClone(child);
  }
  return clone;
}

function deepMerge(target, source) {
  const merged = isPlainObject(target) ? safeClone(target) : {};
  if (!isPlainObject(source)) return merged;
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    if (isPlainObject(value)) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = safeClone(value);
    }
  }
  return merged;
}

function safeExtraBody(source) {
  if (!isPlainObject(source)) return {};
  const filtered = {};
  for (const [key, value] of Object.entries(source)) {
    if (RESERVED_EXTRA_BODY_KEYS.has(key) || UNSAFE_OBJECT_KEYS.has(key)) continue;
    filtered[key] = safeClone(value);
  }
  return filtered;
}

function mappedReasoningEffort(effort, preset) {
  if (effort === 'off') return 'none';
  if (preset === 'openrouter') {
    // OpenRouter's public effort ladder tops out at high.
    if (effort === 'minimal') return 'low';
    if (effort === 'xhigh' || effort === 'max') return 'high';
  }
  // OpenAI documents `max` as a distinct effort above `xhigh` (GPT-5.6).
  // Pass it through unchanged for the OpenAI preset and any other preset that
  // does not define its own clamp above.
  return effort;
}

export function compatibilityRequestBody(config = {}) {
  const compat = normalizeProviderCompatibility(config);
  if (compat.reasoningEffort === 'auto') return {};

  const preset = effectiveCompatibilityPreset(config);
  const enabled = compat.reasoningEffort !== 'off';
  if (preset === 'qwen') {
    return {
      chat_template_kwargs: enabled
        ? { enable_thinking: true, preserve_thinking: true }
        : { enable_thinking: false },
    };
  }
  if (preset === 'deepseek') {
    return { chat_template_kwargs: { thinking: enabled } };
  }
  if (preset === 'openrouter') {
    return enabled
      ? { reasoning: { effort: mappedReasoningEffort(compat.reasoningEffort, preset) } }
      : { reasoning: { enabled: false } };
  }
  if (preset === 'openai') {
    const effort = mappedReasoningEffort(compat.reasoningEffort, preset);
    return shouldUseOpenAIResponsesApi(config)
      ? { reasoning: { effort } }
      : { reasoning_effort: effort };
  }
  return {};
}

/**
 * Per-request controls for classifier/planner calls that need short,
 * machine-readable JSON instead of hidden reasoning or free-form prose.
 *
 * This maps protocol families, not individual model ids. Unknown endpoints
 * receive no non-standard fields and continue to rely on the planner prompt
 * plus local parsing. Callers can set includeResponseFormat:false for the
 * repair attempt so a server that rejects structured-output parameters still
 * gets one portable prompt-only retry.
 */
export function plannerRequestBody(config = {}, {
  schema = null,
  schemaName = 'webbrain_planner',
  includeResponseFormat = true,
  disableThinking = true,
} = {}) {
  const providerName = clean(config.providerName);
  const preset = effectiveCompatibilityPreset(config);
  const isLocalOpenAICompat = clean(config.category) === 'local'
    || LOCAL_OPENAI_COMPAT_PROVIDER_NAMES.has(providerName);
  const isDirectDeepSeek = isDirectDeepSeekConfig(config) && !isLocalOpenAICompat;
  const body = {};

  if (disableThinking) {
    if (preset === 'openrouter') {
      body.reasoning = { enabled: false };
    } else if (isDirectDeepSeek) {
      body.thinking = { type: 'disabled' };
    } else if ((preset === 'qwen' && isLocalOpenAICompat) || providerName === 'vllm' || providerName === 'sglang') {
      body.chat_template_kwargs = { enable_thinking: false };
    } else if (preset === 'openai' && shouldUseOpenAIResponsesApi(config)) {
      // Responses reasoning models may not accept a fully disabled mode. Keep
      // the classifier budget small without recreating a provider error.
      body.reasoning = { effort: 'minimal' };
    }
  }

  if (!includeResponseFormat) return body;
  if (isDirectDeepSeek) {
    // The direct DeepSeek API supports JSON Object mode, not JSON Schema.
    body.response_format = { type: 'json_object' };
    return body;
  }
  if (schema && STRUCTURED_OUTPUT_PROVIDER_NAMES.has(providerName)) {
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

export function mergeProviderRequestBody(body, config = {}, perRequestExtraBody = undefined) {
  let extras = compatibilityRequestBody(config);
  extras = deepMerge(extras, safeExtraBody(config.extraBody));
  extras = deepMerge(extras, safeExtraBody(perRequestExtraBody));
  if (extras.chat_template_kwargs?.enable_thinking === false) {
    delete extras.chat_template_kwargs.preserve_thinking;
  }
  // Shallow-copy the body so untouched fields keep identity (Responses input
  // items must replay the exact same object references). Deep-merge only when
  // both sides have a plain object for the same key, so partial extras like
  // `{ reasoning: { summary } }` do not drop required nested fields.
  const result = isPlainObject(body) ? { ...body } : {};
  for (const [key, value] of Object.entries(extras)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = isPlainObject(value) || Array.isArray(value) ? safeClone(value) : value;
    }
  }
  return result;
}

export function validateProviderExtraBody(value) {
  if (!isPlainObject(value)) {
    return { ok: false, error: 'Custom request body must be a JSON object.' };
  }
  const reserved = Object.keys(value).filter((key) => RESERVED_EXTRA_BODY_KEYS.has(key));
  const unsafe = Object.keys(value).filter((key) => UNSAFE_OBJECT_KEYS.has(key));
  if (reserved.length) {
    return {
      ok: false,
      error: `Use the dedicated settings for reserved fields: ${reserved.join(', ')}.`,
      reserved,
    };
  }
  if (unsafe.length) {
    return { ok: false, error: `Unsafe object keys are not allowed: ${unsafe.join(', ')}.` };
  }
  return { ok: true, value };
}

export function parseProviderExtraBodyJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Custom request body is not valid JSON: ${error.message}`);
  }
  const validation = validateProviderExtraBody(parsed);
  if (!validation.ok) throw new Error(validation.error);
  return parsed;
}
