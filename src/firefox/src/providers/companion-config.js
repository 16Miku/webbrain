/**
 * WebBrain Companion configuration and model selection rules.
 *
 * Companion connects WebBrain to a local subscription proxy running on
 * loopback port 8327.
 */

export const WEBBRAIN_COMPANION_DEFAULT_BASE_URL = 'http://127.0.0.1:8327/v1';

// Preferred models in priority order:
// 1. haiku-5.5 (Claude Haiku 5.5)
// 2. luna-6.1 (GPT-6.1 Luna)
// 3. gemini-3.8-flash (Gemini 3.8 Flash)
export const COMPANION_PREFERRED_MODEL_PATTERNS = [
  /haiku[-_.]?5[.\-_]?5/i,
  /luna[-_.]?6[.\-_]?1|gpt[-_.]?6[.\-_]?1.*luna/i,
  /gemini[-_.]?3[.\-_]?8[-_.]?flash/i,
];

/**
 * Automatically select the most preferred model from a list of Companion models.
 * If none of the preferred patterns match, falls back to the first available model.
 */
export function selectPreferredCompanionModel(models = []) {
  if (!Array.isArray(models) || models.length === 0) return '';
  for (const pattern of COMPANION_PREFERRED_MODEL_PATTERNS) {
    const matched = models.find((m) => typeof m === 'string' && pattern.test(m));
    if (matched) return matched;
  }
  return typeof models[0] === 'string' ? models[0] : '';
}
