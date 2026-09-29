import { normalizeCaptchaType } from './captcha-frame-runtime.js';
import { isValidCapsolverApiKey } from './capsolver-config.js';

export const CAPTCHA_PROVIDERS = [
  { id: 'capsolver', name: 'CapSolver', key: 'capsolverApiKey', enabled: 'captchaSolverEnabled', weight: 'capsolverWeight', defaultWeight: 100, domId: 'captcha' },
  { id: '2captcha', name: '2Captcha', key: 'twoCaptchaApiKey', enabled: 'twoCaptchaEnabled', weight: 'twoCaptchaWeight', defaultWeight: 99, domId: 'two-captcha' },
  { id: 'capmonster', name: 'CapMonster Cloud', key: 'capmonsterApiKey', enabled: 'capmonsterEnabled', weight: 'capmonsterWeight', defaultWeight: 98, domId: 'capmonster' },
  { id: 'solvecaptcha', name: 'SolveCaptcha', key: 'solveCaptchaApiKey', enabled: 'solveCaptchaEnabled', weight: 'solveCaptchaWeight', defaultWeight: 97, domId: 'solve-captcha' },
  { id: 'anti-captcha', name: 'Anti-Captcha', key: 'antiCaptchaApiKey', enabled: 'antiCaptchaEnabled', weight: 'antiCaptchaWeight', defaultWeight: 96, domId: 'anti-captcha' },
];
export const CAPTCHA_SETTINGS_KEYS = [
  ...CAPTCHA_PROVIDERS.flatMap(provider => [provider.key, provider.enabled, provider.weight]),
  'webbrainCloudManaged', 'webbrainCloudCapsolverBrokerEnabled',
];
export function normalizeTwoCaptchaApiKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}
export function isValidTwoCaptchaApiKey(value) {
  return /^[a-f0-9]{32}$/i.test(normalizeTwoCaptchaApiKey(value));
}
export function isValidCaptchaApiKey(id, value) {
  return id === 'capsolver' ? isValidCapsolverApiKey(value)
    : CAPTCHA_PROVIDERS.some(provider => provider.id === id) && isValidTwoCaptchaApiKey(value);
}
export function normalizeCaptchaWeight(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Managed browsers never use personal keys or fallback settings from storage.
export function getCaptchaProviders(stored = {}) {
  if (stored.webbrainCloudManaged === true) {
    return stored.captchaSolverEnabled === true && stored.webbrainCloudCapsolverBrokerEnabled === true
      ? [{ id: 'capsolver', apiKey: '', useCloudBroker: true }] : [];
  }
  // Stable sorting preserves the default provider order when weights tie.
  return CAPTCHA_PROVIDERS.filter(provider => stored[provider.enabled] === true && isValidCaptchaApiKey(provider.id, stored[provider.key]))
    .map(provider => ({ id: provider.id, apiKey: normalizeTwoCaptchaApiKey(stored[provider.key]),
      weight: normalizeCaptchaWeight(stored[provider.weight], provider.defaultWeight) }))
    .sort((a, b) => b.weight - a.weight);
}

// Capabilities describe this integration, rather than every product a service sells.
export function captchaProviderSupportsType(providerId, type) {
  const normalized = normalizeCaptchaType(type);
  if (normalized === 'hcaptcha') return providerId === 'capsolver';
  return CAPTCHA_PROVIDERS.some(provider => provider.id === providerId)
    && ['recaptcha_v2', 'recaptcha_v2_enterprise', 'recaptcha_v3', 'recaptcha_v3_enterprise', 'turnstile', 'image_to_text'].includes(normalized);
}
