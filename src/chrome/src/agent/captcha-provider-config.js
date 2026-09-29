import { normalizeCaptchaType } from './captcha-frame-runtime.js';
import { isCapsolverEnabled, normalizeCapsolverApiKey } from './capsolver-config.js';

export const CAPTCHA_SETTINGS_KEYS = [
  'capsolverApiKey', 'captchaSolverEnabled', 'twoCaptchaApiKey', 'twoCaptchaEnabled',
  'webbrainCloudManaged', 'webbrainCloudCapsolverBrokerEnabled',
];

export function normalizeTwoCaptchaApiKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isValidTwoCaptchaApiKey(value) {
  return /^[a-f0-9]{32}$/i.test(normalizeTwoCaptchaApiKey(value));
}

// This order is also the fallback order. Managed browsers must never use
// personal keys from storage, even if an old/imported configuration has them.
export function getCaptchaProviders(stored = {}) {
  if (stored.webbrainCloudManaged === true) {
    return stored.captchaSolverEnabled === true && stored.webbrainCloudCapsolverBrokerEnabled === true
      ? [{ id: 'capsolver', apiKey: '', useCloudBroker: true }] : [];
  }
  const providers = [];
  if (isCapsolverEnabled(stored.capsolverApiKey, stored.captchaSolverEnabled)) {
    providers.push({ id: 'capsolver', apiKey: normalizeCapsolverApiKey(stored.capsolverApiKey) });
  }
  if (stored.twoCaptchaEnabled === true && isValidTwoCaptchaApiKey(stored.twoCaptchaApiKey)) {
    providers.push({ id: '2captcha', apiKey: normalizeTwoCaptchaApiKey(stored.twoCaptchaApiKey) });
  }
  return providers;
}

// Capabilities describe this integration, rather than every product a service sells.
export function captchaProviderSupportsType(providerId, type) {
  const normalized = normalizeCaptchaType(type);
  if (normalized === 'hcaptcha') return providerId === 'capsolver';
  return ['capsolver', '2captcha'].includes(providerId)
    && ['recaptcha_v2', 'recaptcha_v2_enterprise', 'recaptcha_v3', 'recaptcha_v3_enterprise', 'turnstile', 'image_to_text'].includes(normalized);
}
